export class MeshError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = "MeshError";
    this.code = code;
  }
}

export class ValidationError extends MeshError {
  constructor(message: string) {
    super("MESH_VALIDATION_FAILED", message);
    this.name = "ValidationError";
  }
}

export class AgentNotFoundError extends MeshError {
  constructor(message: string) {
    super("MESH_AGENT_NOT_FOUND", message);
    this.name = "AgentNotFoundError";
  }
}

export class DuplicateAgentError extends MeshError {
  constructor(message: string) {
    super("MESH_AGENT_DUPLICATE", message);
    this.name = "DuplicateAgentError";
  }
}

export class CapabilityNotFoundError extends MeshError {
  constructor(capability: string) {
    super("MESH_CAPABILITY_NOT_FOUND", `No active agent currently serves capability "${capability}"`);
    this.name = "CapabilityNotFoundError";
  }
}

export class AgentUnavailableError extends MeshError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("MESH_AGENT_UNAVAILABLE", message, options);
    this.name = "AgentUnavailableError";
  }
}

export class UnroutableRequestError extends MeshError {
  constructor(message: string) {
    super("MESH_UNROUTABLE", message);
    this.name = "UnroutableRequestError";
  }
}

export class TimeoutError extends MeshError {
  constructor(message: string) {
    super("MESH_TIMEOUT", message);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends MeshError {
  constructor(agentId: string) {
    super("MESH_CIRCUIT_OPEN", `Circuit breaker is open for agent "${agentId}"`);
    this.name = "CircuitOpenError";
  }
}

export class HandshakeError extends MeshError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("MESH_HANDSHAKE_FAILED", message, options);
    this.name = "HandshakeError";
  }
}

export class CryptoVerificationError extends MeshError {
  constructor(message: string) {
    super("MESH_CRYPTO_VERIFICATION_FAILED", message);
    this.name = "CryptoVerificationError";
  }
}
