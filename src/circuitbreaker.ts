import type { CircuitBreakerOptions, CircuitBreakerSnapshot, CircuitState } from "./types.js";

export type { CircuitBreakerOptions, CircuitBreakerSnapshot, CircuitState };
import { CircuitOpenError } from "./errors.js";

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 10_000,
  halfOpenMaxCalls: 2,
};

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Per-endpoint circuit breaker. Failure threshold trips the circuit open; after a
 * cooldown it admits a bounded number of trial calls (half-open) before closing again.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private halfOpenCalls = 0;
  private lastFailureAt: number | null = null;
  private lastStateChangeAt: number;

  constructor(
    readonly agentId: string,
    private readonly options: Partial<CircuitBreakerOptions> = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.lastStateChangeAt = clock.now();
  }

  /** Runs `fn` under circuit control; throws CircuitOpenError when traffic is cut. */
  async record<T>(fn: () => Promise<T>): Promise<T> {
    this.beforeCall();
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    this.transitionIfCooleded();
    return {
      state: this.state,
      failures: this.failures,
      halfOpenCalls: this.halfOpenCalls,
      lastFailureAt: this.lastFailureAt,
      lastStateChangeAt: this.lastStateChangeAt,
    };
  }

  private beforeCall(): void {
    this.transitionIfCooleded();
    if (this.state === "open") {
      throw new CircuitOpenError(this.agentId);
    }
    if (this.state === "half-open") {
      if (this.halfOpenCalls >= this.halfOpenMaxCalls()) {
        throw new CircuitOpenError(this.agentId);
      }
      this.halfOpenCalls += 1;
    }
  }

  private onSuccess(): void {
    if (this.state !== "closed") {
      this.state = "closed";
      this.halfOpenCalls = 0;
      this.failures = 0;
      this.lastStateChangeAt = this.clock.now();
      return;
    }
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures += 1;
    this.lastFailureAt = this.clock.now();
    if (this.state === "half-open") {
      this.trip();
      return;
    }
    if (this.failures >= this.failureThreshold()) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.halfOpenCalls = 0;
    this.lastStateChangeAt = this.clock.now();
  }

  private transitionIfCooleded(): void {
    if (this.state !== "open") return;
    if (this.clock.now() - this.lastStateChangeAt >= this.cooldownMs()) {
      this.state = "half-open";
      this.halfOpenCalls = 0;
      this.lastStateChangeAt = this.clock.now();
    }
  }

  private failureThreshold(): number {
    const value = this.options.failureThreshold ?? DEFAULT_CIRCUIT_OPTIONS.failureThreshold;
    return value >= 1 ? Math.floor(value) : 1;
  }

  private cooldownMs(): number {
    const value = this.options.cooldownMs ?? DEFAULT_CIRCUIT_OPTIONS.cooldownMs;
    return value >= 0 ? value : 0;
  }

  private halfOpenMaxCalls(): number {
    const value = this.options.halfOpenMaxCalls ?? DEFAULT_CIRCUIT_OPTIONS.halfOpenMaxCalls;
    return value >= 1 ? Math.floor(value) : 1;
  }
}
