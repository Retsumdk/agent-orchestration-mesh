import { MeshClient, type MeshClientOptions } from "./client.js";
import { type CircuitBreakerOptions } from "./circuitbreaker.js";
import { LoadBalancer } from "./loadbalancer.js";
import { createHandshakeOffer, SecureChannel, SecureChannelResponder } from "./security/channel.js";
import { generateIdentityKeyPair, type AgentIdentityKeyPair } from "./security/identity.js";
import { ServiceRegistry, type RegistryOptions } from "./registry.js";
import type {
  AgentDescriptor,
  AgentRegistrationInput,
  CircuitSummary,
  DispatchHandler,
  HandshakeOffer,
  HandshakeReply,
  MeshStatusSnapshot,
  ResolvedInstance,
  SecureChannelMap,
  StrategyName,
} from "./types.js";

export interface MeshOptions {
  node?: { name: string; endpoint: string };
  defaults?: RegistryOptions & { strategy?: StrategyName };
  breaker?: CircuitBreakerOptions;
  client?: MeshClientOptions;
}

/**
 * Facade wiring the mesh together: a TTL service registry, a pluggable load
 * balancer, per-agent circuit breakers, an outbound client, in-process agent
 * handlers, and optional end-to-end secure channels (X25519 + AES-256-GCM).
 */
export class Mesh {
  readonly registry: ServiceRegistry;
  readonly balancer = new LoadBalancer();
  readonly client: MeshClient;
  readonly channels: SecureChannelMap = new Map();
  private readonly strategy: StrategyName;
  private readonly localHandlers = new Map<string, DispatchHandler>();

  constructor(options: MeshOptions = {}) {
    const { strategy, ...registryOptions } = options.defaults ?? {};
    this.strategy = strategy ?? "round-robin";
    this.registry = new ServiceRegistry(registryOptions);
    this.client = new MeshClient(this.registry, this.balancer, {
      strategy: this.strategy,
      ...options.client,
      channels: this.channels,
    });
  }

  /**
   * Register an agent. With `handler` the agent is served in-process; without
   * one, `endpoint` is treated as a remote HTTP target.
   */
  registerLocal(input: AgentRegistrationInput, handler?: DispatchHandler): string {
    const agentId = this.registry.register(input);
    if (handler) {
      this.localHandlers.set(agentId, handler);
      this.registry.attachHandler(agentId, handler);
    }
    return agentId;
  }

  deregister(agentId: string): boolean {
    this.channels.delete(agentId);
    this.localHandlers.delete(agentId);
    return this.registry.deregister(agentId);
  }

  /** Resolve a service to one instance using the configured load-balancing strategy. */
  resolve(service: string, strategy?: StrategyName): ResolvedInstance | undefined {
    const candidates = this.registry.candidates({ service });
    if (candidates.length === 0) return undefined;
    const picked = this.balancer.pick(strategy ?? this.strategy, candidates);
    return {
      id: picked.id,
      name: picked.name,
      service: picked.service,
      endpoint: picked.endpoint,
      version: picked.version,
      weight: picked.weight,
    };
  }

  /** Start a secure-channel handshake as the initiator; returns the offer to send. */
  attachSecureChannel(
    agentId: string,
    identity: AgentIdentityKeyPair = generateIdentityKeyPair(),
  ): { identity: AgentIdentityKeyPair; offer: HandshakeOffer } {
    return { identity, offer: createHandshakeOffer(identity, agentId) };
  }

  /** Finish a secure channel from an initiator's offer and our reply. */
  acceptSecureChannel(
    agentId: string,
    offer: HandshakeOffer,
    identity: AgentIdentityKeyPair = generateIdentityKeyPair(),
  ): HandshakeReply {
    const { reply, channel } = SecureChannelResponder.respond(identity, agentId, offer);
    this.channels.set(agentId, channel);
    return reply;
  }

  /** Complete an initiated handshake once the peer's reply arrives. */
  completeSecureChannel(
    agentId: string,
    offer: HandshakeOffer,
    reply: HandshakeReply,
    identity: AgentIdentityKeyPair,
  ): void {
    const channel = SecureChannel.establish(identity, agentId, reply.from, offer, reply);
    this.channels.set(agentId, channel);
  }

  status(): MeshStatusSnapshot {
    const circuits: CircuitSummary[] = [...this.client.circuits.entries()].map(([agentId, breaker]) => {
      const snap = breaker.snapshot();
      return { agentId, state: snap.state, failures: snap.failures };
    });
    return { registry: this.registry.snapshot(), circuits, inflight: this.client.inflightTotal() };
  }

  list(): AgentDescriptor[] {
    return this.registry.list();
  }

  /** Stop the background prune timer. Safe to call multiple times. */
  shutdown(): void {
    this.registry.clearTimers();
  }
}
