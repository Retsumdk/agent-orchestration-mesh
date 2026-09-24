import { AgentUnavailableError, MeshError, TimeoutError, UnroutableRequestError } from "./errors.js";
import { CircuitBreaker } from "./circuitbreaker.js";
import { LoadBalancer, type InflightLookup } from "./loadbalancer.js";
import type { ServiceRegistry } from "./registry.js";
import type { AgentDescriptor, MeshRequestOptions, MeshResult, SecureChannelMap, StrategyName } from "./types.js";

export interface MeshClientOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  strategy?: StrategyName;
  breaker?: { failureThreshold?: number; cooldownMs?: number; halfOpenMaxCalls?: number };
  fetchImpl?: typeof fetch;
  channels?: SecureChannelMap;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryDelayMs: 100,
};

const RETRIABLE_STATUS = new Set([502, 503, 504]);

/**
 * Routes requests to concrete agent instances chosen by the load balancer.
 * Handles timeouts, retries across different instances, per-agent circuit
 * breaking, and optional end-to-end encrypted payloads (secure channels).
 */
export class MeshClient {
  private readonly balancer: LoadBalancer;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly strategy: StrategyName;
  private readonly breakerOptions: MeshClientOptions["breaker"];
  private readonly fetchImpl: typeof fetch;
  private readonly channels: SecureChannelMap;
  readonly circuits = new Map<string, CircuitBreaker>();
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly registry: ServiceRegistry,
    balancer?: LoadBalancer,
    options: MeshClientOptions = {},
  ) {
    this.balancer = balancer ?? new LoadBalancer();
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULTS.maxAttempts);
    this.retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
    this.strategy = options.strategy ?? "round-robin";
    this.breakerOptions = options.breaker;
    this.fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
    this.channels = options.channels ?? new Map();
  }

  /**
   * Resolve `service` to an instance and dispatch a request to it.
   *
   * A request is retried on a different instance when the current one fails
   * with a transport error (timeout, connection failure, 5xx). 4xx responses
   * are returned as-is because retrying them cannot succeed.
   */
  async request<T = unknown>(service: string, options: MeshRequestOptions = {}): Promise<MeshResult<T>> {
    if (!service) throw new MeshError("MESH_SERVICE_REQUIRED", "request() requires a service name");
    const maxAttempts = Math.max(1, options.maxAttempts ?? options.retries ?? this.maxAttempts);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const strategy = options.strategy ?? this.strategy;
    const failures: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const agent = this.select(service, strategy);
      if (!agent) {
        throw new UnroutableRequestError(
          `no healthy instance available for service "${service}"` +
            (failures.length > 0 ? ` (earlier attempts failed: ${failures.join("; ")})` : ""),
        );
      }
      try {
        const { body, status, durationMs } = await this.dispatch(agent, options, timeoutMs);
        return {
          agentId: agent.id,
          agentName: agent.name,
          endpoint: agent.endpoint,
          status,
          attempts: attempt,
          durationMs,
          body: body as T,
          encrypted: options.secure === true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${agent.name}: ${message}`);
        if (!(error instanceof TimeoutError || error instanceof AgentUnavailableError)) throw error;
      }
      if (attempt < maxAttempts && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw new AgentUnavailableError(`all ${maxAttempts} attempt(s) for service "${service}" failed: ${failures.join("; ")}`);
  }

  circuit(agentId: string): CircuitBreaker {
    let breaker = this.circuits.get(agentId);
    if (!breaker) {
      breaker = new CircuitBreaker(agentId, this.breakerOptions);
      this.circuits.set(agentId, breaker);
    }
    return breaker;
  }

  inflightTotal(): number {
    let total = 0;
    for (const count of this.inflight.values()) total += count;
    return total;
  }

  private select(service: string, strategy: StrategyName): AgentDescriptor | undefined {
    const candidates = this.registry.candidates({ service });
    if (candidates.length === 0) return undefined;
    const inflightLookup: InflightLookup = (agentId) => this.inflight.get(agentId) ?? 0;
    return this.balancer.pick(strategy, candidates, inflightLookup);
  }

  private async dispatch(
    agent: AgentDescriptor,
    options: MeshRequestOptions,
    timeoutMs: number,
  ): Promise<{ body: unknown; status: number; durationMs: number }> {
    const handler = this.registry.handlerOf(agent.id);
    const started = Date.now();
    const release = this.trackInflight(agent.id);

    try {
      if (handler) {
        const outcome = await this.circuit(agent.id).record(async () => {
          const response = await handler({
            agentId: agent.id,
            method: options.method ?? "POST",
            path: options.path ?? "/",
            body: options.body,
            headers: options.headers,
            encrypted: options.secure === true,
          });
          const status = response.status ?? 200;
          if (RETRIABLE_STATUS.has(status)) {
            throw new AgentUnavailableError(`in-process handler for ${agent.name} returned ${status}`);
          }
          return { body: response.body, status };
        });
        return { ...outcome, durationMs: Date.now() - started };
      }

      const url = buildUrl(agent.endpoint, options.path ?? `/_mesh/${encodeURIComponent(agent.service)}`);
      const outcome = await this.circuit(agent.id).record(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await this.fetchImpl(url, {
            method: options.method ?? "POST",
            headers: {
              "content-type": "application/json",
              "x-mesh-service": agent.service,
              "x-mesh-agent": agent.id,
              ...(options.headers ?? {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
          });
          const text = await response.text();
          let parsed: unknown = text;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              parsed = text;
            }
          }
          if (RETRIABLE_STATUS.has(response.status)) {
            throw new AgentUnavailableError(`upstream ${agent.name} returned ${response.status}`);
          }
          return { body: parsed, status: response.status };
        } catch (error) {
          if (error instanceof AgentUnavailableError) throw error;
          if (error instanceof Error && error.name === "AbortError") {
            throw new TimeoutError(`request to ${agent.name} exceeded ${timeoutMs}ms`);
          }
          throw new AgentUnavailableError(
            `transport failure reaching ${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(timer);
        }
      });
      return { ...outcome, durationMs: Date.now() - started };
    } finally {
      release();
    }
  }

  private trackInflight(agentId: string): () => void {
    this.inflight.set(agentId, (this.inflight.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inflight.get(agentId) ?? 1) - 1;
      if (next <= 0) this.inflight.delete(agentId);
      else this.inflight.set(agentId, next);
    };
  }
}

function buildUrl(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/$/, "");
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}
