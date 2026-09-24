import { describe, expect, test } from "bun:test";
import { CircuitBreaker, DEFAULT_CIRCUIT_OPTIONS } from "../src/circuitbreaker";
import { CircuitOpenError } from "../src/errors";

class FakeClock {
  nowMs = 1_000_000;
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

describe("CircuitBreaker", () => {
  test("starts closed and reports a snapshot", () => {
    const breaker = new CircuitBreaker("a");
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().failures).toBe(0);
  });

  test("opens after the failure threshold and rejects calls while open", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 2, cooldownMs: 1_000 }, clock);
    for (let i = 0; i < 2; i += 1) {
      await expect(breaker.record(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    }
    expect(breaker.snapshot().state).toBe("open");
    await expect(breaker.record(async () => "ok")).rejects.toThrow(CircuitOpenError);
  });

  test("admits bounded trial calls after the cooldown (half-open) and closes on success", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 1, cooldownMs: 1_000, halfOpenMaxCalls: 1 }, clock);
    await expect(breaker.record(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    clock.advance(1_500);
    expect(breaker.snapshot().state).toBe("half-open");
    const result = await breaker.record(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().failures).toBe(0);
  });

  test("re-trips immediately when a half-open trial call fails", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 1, cooldownMs: 1_000, halfOpenMaxCalls: 2 }, clock);
    await expect(breaker.record(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    clock.advance(1_500);
    await expect(breaker.record(async () => { throw new Error("still bad"); })).rejects.toThrow("still bad");
    expect(breaker.snapshot().state).toBe("open");
  });

  test("successes reset the failure count while closed", async () => {
    const breaker = new CircuitBreaker("a", { failureThreshold: 2, cooldownMs: 1_000 });
    await expect(breaker.record(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await breaker.record(async () => "ok");
    expect(breaker.snapshot().failures).toBe(0);
    expect(breaker.snapshot().state).toBe("closed");
  });

  test("defaults match the documented constants", () => {
    expect(DEFAULT_CIRCUIT_OPTIONS.failureThreshold).toBe(5);
    expect(DEFAULT_CIRCUIT_OPTIONS.cooldownMs).toBe(10_000);
    expect(DEFAULT_CIRCUIT_OPTIONS.halfOpenMaxCalls).toBe(2);
  });
});
