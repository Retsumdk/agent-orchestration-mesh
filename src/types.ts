/**
 * Shared type vocabulary for agent-orchestration-mesh.
 * This module is intentionally dependency-free.
 */

/** Load-balancing strategies the mesh can apply when several agents serve one service. */
export type StrategyName = "round-robin" | "weighted-round-robin" | "least-outstanding" | "random";

export type AgentStatus = "active" | "draining";

/** What a caller supplies to register an agent with the mesh. Missing fields get defaults. */
export interface AgentRegistrationInput {
  id?: string;
  name?: string;
  service: string;
  endpoint: string;
  capabilities: string[];
  version?: string;
  weight?: number;
  meta?: Record<string, string>;
}

/** Fully materialised registry record for a registered agent. */
export interface AgentDescriptor {
  id: string;
  service: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  version: string;
  weight: number;
  meta: Record<string, string>;
  registeredAt: number;
  lastHeartbeatAt: number;
  status: AgentStatus;
}

export interface LookupOptions {
  capabilities?: string[];
  service?: string;
  status?: AgentStatus;
}

/** One healthy instance picked for a service, as returned by `Mesh.resolve`. */
export interface ResolvedInstance {
  id: string;
  name: string;
  service: string;
  endpoint: string;
  version: string;
  weight: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxCalls: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failures: number;
  halfOpenCalls: number;
  lastFailureAt: number | null;
  lastStateChangeAt: number;
}

export interface CircuitSummary {
  agentId: string;
  state: CircuitState;
  failures: number;
}

/** Options for a mesh-routed request. */
export interface MeshRequestOptions {
  method?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Alias for `maxAttempts` (wire/CLI spelling). */
  retries?: number;
  maxAttempts?: number;
  strategy?: StrategyName;
  secure?: boolean;
}

/** Result of a mesh-routed request. */
export interface MeshResult<T = unknown> {
  agentId: string;
  agentName: string;
  endpoint: string;
  status: number;
  attempts: number;
  durationMs: number;
  body: T;
  encrypted: boolean;
}

/** Transferable, signed, encrypted application-layer frame. */
export interface SecureFrame {
  v: 1;
  from: string;
  fp: string;
  epk: string;
  iv: string;
  ct: string;
  tag: string;
  sig: string;
  at: number;
}

export type SecureChannelMap = Map<string, import("./security/channel.js").SecureChannel>;

/** What an in-process agent handler returns for a dispatched request. */
export interface HandlerResponse {
  body: unknown;
  status?: number;
}

export type DispatchHandler = (request: {
  agentId: string;
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string> | undefined;
  encrypted: boolean;
}) => HandlerResponse | Promise<HandlerResponse>;

export interface HandshakeOffer {
  v: 1;
  from: string;
  /** Sender's signing-key fingerprint (the session is addressed by it). */
  fp: string;
  /** Sender's Ed25519 public key (SPKI PEM) so the peer can verify `sig`. */
  spk: string;
  /** Sender's X25519 public key (SPKI DER, base64). */
  dh: string;
  nonce: string;
  sig: string;
}

export interface HandshakeReply {
  v: 1;
  from: string;
  fp: string;
  spk: string;
  dh: string;
  nonce: string;
  sig: string;
}

export interface MeshStatusSnapshot {
  registry: { total: number; active: number; draining: number; services: number };
  circuits: CircuitSummary[];
  inflight: number;
}

export interface SecurityReport {
  totalAgents: number;
  withIdentity: number;
  withoutIdentity: number;
  coverage: number;
}
