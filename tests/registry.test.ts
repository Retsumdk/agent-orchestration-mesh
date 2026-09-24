import { describe, expect, test } from "bun:test";
import { ServiceRegistry, TTL_MAX_MS, TTL_MIN_MS } from "../src/registry";
import { AgentNotFoundError, DuplicateAgentError, ValidationError } from "../src/errors";
import type { AgentRegistrationInput } from "../src/types";

class FakeClock {
  nowMs = 1_000_000;
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

function input(overrides: Partial<AgentRegistrationInput> = {}): AgentRegistrationInput {
  return {
    id: "worker-1",
    name: "Worker One",
    service: "echo",
    endpoint: "http://127.0.0.1:9001",
    capabilities: ["echo", "math.add"],
    version: "1.0.0",
    ...overrides,
  };
}

describe("ServiceRegistry", () => {
  test("registers an agent and materialises defaults", () => {
    const registry = new ServiceRegistry();
    const id = registry.register(input());
    expect(id).toBe("worker-1");
    const agent = registry.get("worker-1");
    expect(agent.weight).toBe(1);
    expect(agent.status).toBe("active");
    expect(agent.capabilities).toEqual(["echo", "math.add"]);
    expect(registry.list()).toHaveLength(1);
  });

  test("generates an id and name when omitted", () => {
    const registry = new ServiceRegistry();
    const id = registry.register(input({ id: undefined, name: undefined }));
    expect(id).toMatch(/^echo-/);
    expect(registry.get(id).name).toBe(id);
  });

  test("rejects duplicate registration of a live agent", () => {
    const registry = new ServiceRegistry();
    registry.register(input());
    expect(() => registry.register(input())).toThrow(DuplicateAgentError);
  });

  test("upsert replaces an existing registration in place", () => {
    const registry = new ServiceRegistry();
    registry.register(input());
    registry.upsert(input({ capabilities: ["echo"] }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("worker-1").capabilities).toEqual(["echo"]);
  });

  test("expires agents when the TTL lapses without a heartbeat", () => {
    const clock = new FakeClock();
    const registry = new ServiceRegistry({ clock });
    registry.register(input(), 5_000);
    clock.advance(4_999);
    expect(registry.list()).toHaveLength(1);
    clock.advance(1);
    expect(registry.list()).toHaveLength(0);
    expect(registry.get("worker-1")).toBeUndefined();
  });

  test("heartbeat renews the lease and clears expiry", () => {
    const clock = new FakeClock();
    const registry = new ServiceRegistry({ clock });
    registry.register(input(), 5_000);
    for (let i = 0; i < 4; i += 1) {
      clock.advance(4_000);
      registry.heartbeat("worker-1");
    }
    expect(registry.list()).toHaveLength(1);
  });

  test("heartbeat accepts a new ttl", () => {
    const clock = new FakeClock();
    const registry = new ServiceRegistry({ clock });
    registry.register(input(), 5_000);
    registry.heartbeat("worker-1", 60_000);
    clock.advance(30_000);
    expect(registry.list()).toHaveLength(1);
  });

  test("deregister removes the agent and its capability index entries", () => {
    const registry = new ServiceRegistry();
    registry.register(input());
    expect(registry.deregister("worker-1")).toBe(true);
    expect(registry.deregister("worker-1")).toBe(false);
    expect(registry.candidates({ capability: "echo" })).toHaveLength(0);
  });

  test("candidates filters by service and capability", () => {
    const registry = new ServiceRegistry();
    registry.register(input());
    registry.register(input({ id: "worker-2", service: "math", capabilities: ["math.add"] }));
    expect(registry.candidates({ service: "echo" })).toHaveLength(1);
    expect(registry.candidates({ capability: "math.add" })).toHaveLength(2);
    expect(registry.candidates({ capability: "nope" }).length).toBe(0);
  });

  test("draining agents are hidden from candidates unless explicitly included", () => {
    const registry = new ServiceRegistry();
    registry.register(input());
    registry.setStatus("worker-1", "draining");
    expect(registry.candidates({ service: "echo" })).toHaveLength(0);
    expect(registry.candidates({ service: "echo", includeDraining: true })).toHaveLength(1);
  });

  test("validation rejects malformed registrations", () => {
    const registry = new ServiceRegistry();
    expect(() => registry.register(input({ id: "bad id!" }))).toThrow(ValidationError);
    expect(() => registry.register(input({ endpoint: "ftp://x" }))).toThrow(ValidationError);
    expect(() => registry.register(input({ capabilities: [] }))).toThrow(ValidationError);
    expect(() => registry.register(input({ capabilities: ["BAD CAP"] }))).toThrow(ValidationError);
    expect(() => registry.register(input({ weight: 0 }))).toThrow(ValidationError);
    expect(() => registry.register(input(), 500)).toThrow(ValidationError);
    expect(() => registry.register(input(), TTL_MAX_MS + 1)).toThrow(ValidationError);
  });

  test("ttl bounds are inclusive", () => {
    const registry = new ServiceRegistry();
    expect(() => registry.register(input(), TTL_MIN_MS)).not.toThrow();
    expect(() => registry.register(input({ id: "worker-2" }), TTL_MAX_MS)).not.toThrow();
  });

  test("prune returns expired ids and reports snapshot counts", () => {
    const clock = new FakeClock();
    const registry = new ServiceRegistry({ clock });
    registry.register(input(), 1_000);
    registry.register(input({ id: "worker-2" }), 10_000);
    clock.advance(1_500);
    expect(registry.prune()).toEqual(["worker-1"]);
    const snapshot = registry.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.active).toBe(1);
    expect(snapshot.services).toBe(1);
  });

  test("get returns undefined for unknown agents", () => {
    const registry = new ServiceRegistry();
    expect(registry.get("ghost")).toBeUndefined();
  });
});
