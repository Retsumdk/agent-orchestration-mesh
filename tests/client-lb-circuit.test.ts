import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Mesh } from "../src/mesh";
import { LoadBalancer } from "../src/loadbalancer";
import { CircuitBreaker } from "../src/circuitbreaker";
import type { AgentDescriptor, AgentRegistrationInput } from "../src/types";

const CLEANUP: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of CLEANUP.splice(0)) await fn();
});

function input(overrides: Partial<AgentRegistrationInput> = {}): AgentRegistrationInput {
  return {
    id: "agent-1",
    name: "Agent One",
    service: "workers",
    endpoint: "http://127.0.0.1:9301",
    capabilities: ["work"],
    version: "1.0.0",
    ...overrides,
  };
}

function slowAgent(port: number, delayMs: number): Server {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ slow: true }));
      }, delayMs);
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

describe("MeshClient transport behaviour", () => {
  test("times out a slow remote agent and surfaces TimeoutError", async () => {
    const slow = slowAgent(9_301, 2_000);
    CLEANUP.push(async () => slow.close());
    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    mesh.registerLocal(input({ endpoint: "http://127.0.0.1:9301" }));
    await expect(mesh.client.request("workers", { timeoutMs: 150, maxAttempts: 1 })).rejects.toThrow(/exceeded 150ms/i);
  });

  test("5xx upstream failures are retried across attempts", async () => {
    let calls = 0;
    const flaky = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        calls += 1;
        res.writeHead(calls < 3 ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ attempt: calls }));
      });
    });
    flaky.listen(9_311, "127.0.0.1");
    CLEANUP.push(async () => flaky.close());

    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    mesh.registerLocal(input({ endpoint: "http://127.0.0.1:9311" }));
    const result = await mesh.client.request("workers", { maxAttempts: 4, retryDelayMs: 5 });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    expect(result.body).toEqual({ attempt: 3 });
  });

  test("4xx responses are returned as-is without retry", async () => {
    let calls = 0;
    const stubborn = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        calls += 1;
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unprocessable" }));
      });
    });
    stubborn.listen(9_321, "127.0.0.1");
    CLEANUP.push(async () => stubborn.close());

    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    mesh.registerLocal(input({ endpoint: "http://127.0.0.1:9321" }));
    const result = await mesh.client.request("workers", { maxAttempts: 3, retryDelayMs: 5 });
    expect(result.status).toBe(422);
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("LoadBalancer strategies", () => {
  const candidates: AgentDescriptor[] = [
    { ...base("a", 1) },
    { ...base("b", 2) },
    { ...base("c", 3) },
  ];

  function base(id: string, weight: number): AgentDescriptor {
    return {
      ...input({ id, name: `Agent ${id.toUpperCase()}` }),
      weight,
      registeredAt: 0,
      lastHeartbeatAt: 0,
      status: "active",
    } as AgentDescriptor;
  }

  test("round-robin visits every candidate in turn", () => {
    const balancer = new LoadBalancer();
    const picks = candidates.map(() => balancer.pick("round-robin", candidates).id);
    expect(picks).toEqual(["a", "b", "c"]);
  });

  test("weighted round-robin honours 1:2:3 weights over six picks", () => {
    const balancer = new LoadBalancer();
    const tally: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6; i += 1) {
      const picked = balancer.pick("weighted-round-robin", candidates).id;
      tally[picked] = (tally[picked] ?? 0) + 1;
    }
    expect(tally).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("least-outstanding prefers the idle candidate", () => {
    const balancer = new LoadBalancer();
    const inflight = (id: string): number => (id === "a" ? 5 : id === "b" ? 0 : 2);
    expect(balancer.pick("least-outstanding", candidates, inflight).id).toBe("b");
  });

  test("random stays within the candidate set", () => {
    const balancer = new LoadBalancer();
    for (let i = 0; i < 20; i += 1) {
      expect(candidates.map((c) => c.id)).toContain(balancer.pick("random", candidates).id);
    }
  });
});

describe("CircuitBreaker", () => {
  class FakeClock {
    private t = 1_000_000;
    now(): number {
      return this.t;
    }
    tick(ms: number): void {
      this.t += ms;
    }
  }

  test("opens after the failure threshold and refuses calls while open", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 2, cooldownMs: 1_000 }, clock);
    const fail = (): Promise<never> => Promise.reject(new Error("boom"));
    await expect(breaker.record(fail)).rejects.toThrow("boom");
    expect(breaker.snapshot().state).toBe("closed");
    await expect(breaker.record(fail)).rejects.toThrow("boom");
    expect(breaker.snapshot().state).toBe("open");
    await expect(breaker.record(async () => "ok")).rejects.toThrow(/Circuit breaker is open/);
  });

  test("half-open trial calls close the circuit after a success", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 1, cooldownMs: 500 }, clock);
    await expect(breaker.record(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    clock.tick(600);
    expect(breaker.snapshot().state).toBe("half-open");
    expect(await breaker.record(async () => "recovered")).toBe("recovered");
    expect(breaker.snapshot()).toMatchObject({ state: "closed", failures: 0 });
  });

  test("a half-open failure re-trips the circuit", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("a", { failureThreshold: 1, cooldownMs: 500 }, clock);
    await expect(breaker.record(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    clock.tick(600);
    await expect(breaker.record(() => Promise.reject(new Error("still broken")))).rejects.toThrow("still broken");
    expect(breaker.snapshot().state).toBe("open");
  });
});
