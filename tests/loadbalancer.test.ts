import { describe, expect, test } from "bun:test";
import { LoadBalancer } from "../src/loadbalancer";
import { ValidationError } from "../src/errors";
import type { AgentDescriptor } from "../src/types";

function agent(id: string, weight = 1): AgentDescriptor {
  return {
    id,
    service: "echo",
    name: id,
    endpoint: `http://127.0.0.1/${id}`,
    capabilities: ["echo"],
    version: "1.0.0",
    weight,
    meta: {},
    registeredAt: 0,
    lastHeartbeatAt: 0,
    status: "active",
  };
}

describe("LoadBalancer", () => {
  test("round-robin serves candidates in fair rotation", () => {
    const balancer = new LoadBalancer();
    const candidates = [agent("a"), agent("b"), agent("c")];
    const order = [1, 2, 3, 4].map(() => balancer.pick("round-robin", candidates).id);
    expect(order).toEqual(["a", "b", "c", "a"]);
  });

  test("round-robin rotation is per candidate-set", () => {
    const balancer = new LoadBalancer();
    const setA = [agent("a"), agent("b")];
    const setB = [agent("x"), agent("y"), agent("z")];
    expect(balancer.pick("round-robin", setA).id).toBe("a");
    expect(balancer.pick("round-robin", setB).id).toBe("x");
    expect(balancer.pick("round-robin", setA).id).toBe("b");
  });

  test("weighted round-robin distributes proportionally to weight", () => {
    const balancer = new LoadBalancer();
    const candidates = [agent("heavy", 3), agent("light", 1)];
    const counts: Record<string, number> = { heavy: 0, light: 0 };
    for (let i = 0; i < 40; i += 1) {
      counts[balancer.pick("weighted-round-robin", candidates).id] += 1;
    }
    expect(counts.heavy).toBe(30);
    expect(counts.light).toBe(10);
  });

  test("least-outstanding prefers the least loaded candidate", () => {
    const balancer = new LoadBalancer();
    const candidates = [agent("a"), agent("b"), agent("c")];
    const inflight = (id: string): number => (id === "b" ? 0 : 5);
    expect(balancer.pick("least-outstanding", candidates, inflight).id).toBe("b");
  });

  test("least-outstanding falls back to round-robin without an inflight lookup", () => {
    const balancer = new LoadBalancer();
    const candidates = [agent("a"), agent("b")];
    expect(balancer.pick("least-outstanding", candidates).id).toBe("a");
    expect(balancer.pick("least-outstanding", candidates).id).toBe("b");
  });

  test("random always returns a candidate from the set", () => {
    const balancer = new LoadBalancer();
    const candidates = [agent("a"), agent("b"), agent("c")];
    for (let i = 0; i < 20; i += 1) {
      const picked = balancer.pick("random", candidates).id;
      expect(candidates.some((c) => c.id === picked)).toBe(true);
    }
  });

  test("rejects empty candidate lists and unknown strategies", () => {
    const balancer = new LoadBalancer();
    expect(() => balancer.pick("round-robin", [])).toThrow(ValidationError);
    expect(() => balancer.pick("nonexistent" as never, [agent("a")])).toThrow(ValidationError);
  });
});
