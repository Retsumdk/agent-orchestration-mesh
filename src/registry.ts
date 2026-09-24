import type {
  AgentDescriptor,
  AgentRegistrationInput,
  DispatchHandler,
  LookupOptions,
} from "./types.js";
import { randomUUID } from "node:crypto";
import {
  AgentNotFoundError,
  DuplicateAgentError,
  CapabilityNotFoundError,
  ValidationError,
} from "./errors.js";

export interface RegistryClock {
  now(): number;
}

/** Real-time clock; tests inject a fake clock for deterministic TTL behaviour. */
export const systemClock: RegistryClock = { now: () => Date.now() };

export interface RegistryOptions {
  clock?: RegistryClock;
  defaultTtlMs?: number;
  /** Alias for `defaultTtlMs`, matching the CLI option name. */
  ttlMs?: number;
  pruneIntervalMs?: number;
}

export interface CandidateOptions {
  service?: string;
  capability?: string;
  includeDraining?: boolean;
}

/** Valid capability token: lowercase words/numbers joined by single dots or dashes. */
const CAPABILITY_PATTERN = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const TTL_MIN_MS = 1_000;
export const TTL_MAX_MS = 24 * 60 * 60 * 1_000;

interface Record_ {
  descriptor: AgentDescriptor;
  ttlMs: number;
  registeredAt: number;
  lastHeartbeatAt: number;
  status: "active" | "draining";
}

function normalizeInput(input: AgentRegistrationInput, now: number): AgentDescriptor {
  const id = input.id?.trim() || `${input.service}-${randomUUID().slice(0, 8)}`;
  const descriptor: AgentDescriptor = {
    id,
    name: input.name?.trim() || id,
    service: input.service?.trim() || "default",
    endpoint: input.endpoint,
    capabilities: [...input.capabilities],
    version: input.version?.trim() || "0.0.0",
    weight: input.weight ?? 1,
    meta: input.meta ?? {},
    registeredAt: now,
    lastHeartbeatAt: now,
    status: "active",
  };
  validateDescriptor(descriptor);
  return descriptor;
}

export function validateDescriptor(descriptor: AgentDescriptor): void {
  if (typeof descriptor.id !== "string" || !ID_PATTERN.test(descriptor.id)) {
    throw new ValidationError(`Invalid agent id "${String(descriptor.id)}": 1-64 word characters, dashes or underscores`);
  }
  if (typeof descriptor.name !== "string" || descriptor.name.trim().length === 0) {
    throw new ValidationError("Agent name is required");
  }
  if (typeof descriptor.service !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(descriptor.service)) {
    throw new ValidationError(`Invalid service "${String(descriptor.service)}": lowercase words/digits joined by dashes`);
  }
  if (typeof descriptor.endpoint !== "string" || !/^https?:\/\/.+/.test(descriptor.endpoint)) {
    throw new ValidationError(`Invalid endpoint "${String(descriptor.endpoint)}": must be an http(s) URL`);
  }
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0) {
    throw new ValidationError("At least one capability is required");
  }
  if (descriptor.capabilities.length > 32) throw new ValidationError("An agent may declare at most 32 capabilities");
  for (const capability of descriptor.capabilities) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      throw new ValidationError(`Invalid capability "${String(capability)}": lowercase words joined by "." or "-"`);
    }
  }
  if (descriptor.weight !== undefined && (!Number.isFinite(descriptor.weight) || descriptor.weight < 1 || descriptor.weight > 100)) {
    throw new ValidationError(`Invalid weight ${String(descriptor.weight)}: must be between 1 and 100`);
  }
  if (descriptor.version !== undefined && (typeof descriptor.version !== "string" || descriptor.version.trim() === "")) {
    throw new ValidationError("Agent version must be a non-empty string when provided");
  }
}

export function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < TTL_MIN_MS || ttlMs > TTL_MAX_MS) {
    throw new ValidationError(`Invalid ttlMs ${String(ttlMs)}: must be between ${TTL_MIN_MS} and ${TTL_MAX_MS}`);
  }
}

/**
 * In-memory service registry with TTL-based liveness: agents must renew via
 * `heartbeat()` or they expire and disappear from lookups and candidate lists.
 * Capability lookups are indexed, so resolution is O(matching agents).
 */
export class ServiceRegistry {
  private readonly records = new Map<string, Record_>();
  private readonly byCapability = new Map<string, Set<string>>();
  private readonly handlers = new Map<string, DispatchHandler>();
  private readonly clock: RegistryClock;
  private readonly defaultTtlMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.defaultTtlMs = options.defaultTtlMs ?? options.ttlMs ?? 30_000;
    if (options.pruneIntervalMs !== undefined && options.pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), options.pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  /** Registers a new agent. Registering a live duplicate id is an error. */
  register(input: AgentRegistrationInput, ttlMs: number = this.defaultTtlMs): string {
    validateTtl(ttlMs);
    const now = this.clock.now();
    const descriptor = normalizeInput(input, now);
    const existing = this.records.get(descriptor.id);
    if (existing && !this.isExpired(existing, now)) {
      throw new DuplicateAgentError(`Agent "${descriptor.id}" is already registered (heartbeat to renew)`);
    }
    this.removeFromIndex(descriptor.id);
    this.records.set(descriptor.id, { descriptor, ttlMs, registeredAt: now, lastHeartbeatAt: now, status: "active" });
    for (const capability of descriptor.capabilities) this.addToIndex(capability, descriptor.id);
    return descriptor.id;
  }

  /** Replaces an existing record or registers a new one; heartbeats as a side effect. */
  upsert(input: AgentRegistrationInput, ttlMs: number = this.defaultTtlMs): string {
    validateTtl(ttlMs);
    const now = this.clock.now();
    const descriptor = normalizeInput(input, now);
    const existing = this.records.get(descriptor.id);
    this.removeFromIndex(descriptor.id);
    this.records.set(descriptor.id, {
      descriptor: { ...descriptor, registeredAt: existing?.registeredAt ?? now },
      ttlMs,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: now,
      status: "active",
    });
    for (const capability of descriptor.capabilities) this.addToIndex(capability, descriptor.id);
    return descriptor.id;
  }

  deregister(id: string): boolean {
    const removed = this.records.delete(id);
    if (removed) {
      this.removeFromIndex(id);
      this.handlers.delete(id);
    }
    return removed;
  }

  heartbeat(id: string, ttlMs: number = this.defaultTtlMs): void {
    const record = this.requireRecord(id);
    validateTtl(ttlMs);
    record.lastHeartbeatAt = this.clock.now();
    record.ttlMs = ttlMs;
    record.status = "active";
    record.descriptor.lastHeartbeatAt = record.lastHeartbeatAt;
    record.descriptor.status = "active";
  }

  /** Draining agents stay registered (graceful shutdown) but leave candidate lists. */
  setStatus(id: string, status: "active" | "draining"): void {
    this.requireRecord(id).status = status;
  }

  /** Descriptor copy, or undefined when the id is unknown or the lease expired. */
  get(id: string): AgentDescriptor | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    return { ...record.descriptor, capabilities: [...record.descriptor.capabilities], meta: { ...record.descriptor.meta } };
  }

  /**
   * Convenience resolver used by the CLI and tests: ordered candidates for one
   * capability. Throws `CapabilityNotFoundError` when nothing healthy serves it.
   */
  lookup(capability: string, options: LookupOptions = {}): AgentDescriptor[] {
    const found = this.candidates({ capability, ...options });
    if (found.length === 0) throw new CapabilityNotFoundError(capability);
    return found;
  }

  /** All capabilities the agent is indexed under; expired agents return an empty list. */
  capabilitiesOf(id: string): string[] {
    const record = this.records.get(id);
    if (!record || this.isExpired(record, this.clock.now())) return [];
    return [...record.descriptor.capabilities];
  }

  /** Non-expired agents, optionally filtered by service, status and capabilities (all must match). */
  list(options: LookupOptions = {}): AgentDescriptor[] {
    this.prune();
    const now = this.clock.now();
    const result: AgentDescriptor[] = [];
    for (const record of this.records.values()) {
      if (this.isExpired(record, now)) continue;
      if (options.service && record.descriptor.service !== options.service) continue;
      if (options.status && record.descriptor.status !== options.status) continue;
      if (options.capabilities?.length && !options.capabilities.every((c) => record.descriptor.capabilities.includes(c))) continue;
      result.push(this.copyOf(record));
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Ordered candidate list for a lookup; throws when nothing healthy matches. */
  candidates(options: CandidateOptions = {}): AgentDescriptor[] {
    this.prune();
    const now = this.clock.now();
    let ids: Iterable<string>;
    if (options.capability !== undefined) {
      ids = this.byCapability.get(options.capability) ?? [];
    } else {
      ids = this.records.keys();
    }
    const result: AgentDescriptor[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || this.isExpired(record, now)) continue;
      if (options.service && record.descriptor.service !== options.service) continue;
      if (!options.includeDraining && record.status !== "active") continue;
      if (options.capability !== undefined && !record.descriptor.capabilities.includes(options.capability)) continue;
      result.push(this.copyOf(record));
    }
    return result;
  }

  /** Exactly one candidate chosen by the caller's balancer; typed error when none. */
  requireCandidate(options: CandidateOptions = {}): AgentDescriptor {
    const list = this.candidates(options);
    if (list.length === 0) {
      if (options.capability !== undefined) throw new CapabilityNotFoundError(options.capability);
      throw new AgentNotFoundError(
        options.service ? `No active agent serves service "${options.service}"` : "No active agents are registered",
      );
    }
    return list[0];
  }

  /** Removes agents whose TTL elapsed since their last heartbeat; returns their ids. */
  prune(): string[] {
    const now = this.clock.now();
    const expired: string[] = [];
    for (const [id, record] of this.records) {
      if (this.isExpired(record, now)) {
        expired.push(id);
        this.removeFromIndex(id);
        this.records.delete(id);
        this.handlers.delete(id);
      }
    }
    return expired;
  }

  size(): number {
    this.prune();
    return this.records.size;
  }

  attachHandler(id: string, handler: DispatchHandler): void {
    this.handlers.set(id, handler);
  }

  handlerOf(id: string): DispatchHandler | undefined {
    return this.handlers.get(id);
  }

  snapshot(): { total: number; active: number; draining: number; services: number } {
    this.prune();
    const now = this.clock.now();
    const services = new Set<string>();
    let active = 0;
    let draining = 0;
    for (const record of this.records.values()) {
      if (this.isExpired(record, now)) continue;
      services.add(record.descriptor.service);
      if (record.status === "active") active += 1;
      else draining += 1;
    }
    return { total: this.records.size, active, draining, services: services.size };
  }

  /** Cancels the background prune timer; the registry is inert afterwards. */
  clearTimers(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  private isExpired(record: Record_, now: number): boolean {
    return now - record.lastHeartbeatAt >= record.ttlMs;
  }

  private copyOf(record: Record_): AgentDescriptor {
    return { ...record.descriptor, capabilities: [...record.descriptor.capabilities], meta: { ...record.descriptor.meta } };
  }

  private requireRecord(id: string, options: { includeExpired?: boolean } = {}): Record_ {
    const record = this.records.get(id);
    if (!record) throw new AgentNotFoundError(`Agent "${id}" is not registered`);
    if (this.isExpired(record, this.clock.now()) && !options.includeExpired) {
      throw new AgentNotFoundError(`Agent "${id}" registration expired (TTL ${record.ttlMs}ms since last heartbeat)`);
    }
    return record;
  }

  private addToIndex(capability: string, id: string): void {
    let set = this.byCapability.get(capability);
    if (!set) {
      set = new Set();
      this.byCapability.set(capability, set);
    }
    set.add(id);
  }

  private removeFromIndex(id: string): void {
    for (const [capability, set] of this.byCapability) {
      set.delete(id);
      if (set.size === 0) this.byCapability.delete(capability);
    }
  }
}
