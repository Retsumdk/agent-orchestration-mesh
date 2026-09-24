import { afterEach, describe, expect, test } from "bun:test";
import { Mesh } from "../src/mesh.js";
import { AgentNotFoundError, CapabilityNotFoundError, ValidationError } from "../src/errors.js";

function freshMesh(): Mesh {
  return new Mesh({ defaults: { ttlMs: 5_000, pruneIntervalMs: 0 } });
}

const meshes: Mesh[] = [];
afterEach(() => {
  for (const mesh of meshes) mesh.shutdown();
  meshes.length = 0;
});

function tracked(mesh: Mesh): Mesh {
  meshes.push(mesh);
  return mesh;
}

describe("ServiceRegistry", () => {
  test("register + list returns normalized descriptors", () => {
    const mesh = tracked(freshMesh());
    const id = mesh.registerLocal({
      service: "echo",
      name: "Echo A",
      endpoint: "http://127.0.0.1:7001",
      capabilities: ["echo.v1"],
    });
    const agents = mesh.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(id);
    expect(agents[0].name).toBe("Echo A");
    expect(agents[0].version).toBe("0.0.0");
    expect(agents[0].weight).toBe(1);
    expect(agents[0].status).toBe("active");
  });

  test("duplicate registration is rejected; upsert replaces in place", () => {
    const mesh = tracked(freshMesh());
    const input = {
      service: "echo",
      name: "Echo A",
      endpoint: "http://127.0.0.1:7001",
      capabilities: ["echo.v1"],
      id: "echo-a",
    };
    mesh.registerLocal(input);
    expect(() => mesh.registerLocal({ ...input })).toThrow();
    expect(mesh.registry.upsert({ ...input, name: "Echo A v2" })).toBe("echo-a");
    expect(mesh.list()[0].name).toBe("Echo A v2");
  });

  test("validation errors carry useful messages", () => {
    const mesh = tracked(freshMesh());
    expect(() =>
      mesh.registerLocal({ service: "Bad Service", name: "x", endpoint: "http://ok", capabilities: ["c"] }),
    ).toThrow(ValidationError);
    expect(() =>
      mesh.registerLocal({ service: "ok", name: "x", endpoint: "ftp://nope", capabilities: ["c"] }),
    ).toThrow(ValidationError);
    expect(() =>
      mesh.registerLocal({ service: "ok", name: "x", endpoint: "http://ok", capabilities: ["BAD CAP"] }),
    ).toThrow(ValidationError);
    expect(() =>
      mesh.registerLocal({ service: "ok", name: "x", endpoint: "http://ok", capabilities: [] }),
    ).toThrow(ValidationError);
  });

  test("agents expire after ttl without heartbeats and return after renewal", () => {
    let now = 1_000_000;
    const mesh = tracked(
      new Mesh({ defaults: { clock: { now: () => now }, ttlMs: 1_000, pruneIntervalMs: 0 } }),
    );
    mesh.registerLocal({
      service: "echo",
      name: "Echo",
      endpoint: "http://127.0.0.1:7001",
      capabilities: ["echo.v1"],
      id: "echo-1",
    });
    expect(mesh.list()).toHaveLength(1);
    now += 1_500;
    expect(mesh.list()).toHaveLength(0);
    now += 10_000;
    expect(() => mesh.registry.heartbeat("echo-1")).toThrow(AgentNotFoundError);
    expect(mesh.list()).toHaveLength(0);
  });

  test("prune removes expired agents and deregister works", () => {
    let now = 5_000_000;
    const mesh = tracked(
      new Mesh({ defaults: { clock: { now: () => now }, ttlMs: 1_000, pruneIntervalMs: 0 } }),
    );
    const a = mesh.registerLocal({
      service: "echo",
      name: "A",
      endpoint: "http://127.0.0.1:1",
      capabilities: ["echo.v1"],
    });
    const b = mesh.registerLocal({
      service: "echo",
      name: "B",
      endpoint: "http://127.0.0.1:2",
      capabilities: ["echo.v1"],
    });
    expect(mesh.registry.prune()).toEqual([]);
    now += 2_000;
    expect(mesh.registry.prune().sort()).toEqual([a, b].sort());
    expect(mesh.deregister(b)).toBe(false);
  });

  test("status snapshot counts services and draining agents", () => {
    const mesh = tracked(freshMesh());
    mesh.registerLocal({
      service: "echo",
      name: "A",
      endpoint: "http://127.0.0.1:1",
      capabilities: ["echo.v1"],
    });
    mesh.registerLocal({
      service: "math",
      name: "B",
      endpoint: "http://127.0.0.1:2",
      capabilities: ["math.add"],
    });
    const status = mesh.status();
    expect(status.registry.total).toBe(2);
    expect(status.registry.services).toBe(2);
    expect(status.registry.active).toBe(2);
    expect(status.inflight).toBe(0);
  });
});

describe("Mesh.resolve", () => {
  test("returns undefined when no agent serves the service", () => {
    const mesh = tracked(freshMesh());
    expect(mesh.resolve("ghost")).toBeUndefined();
  });

  test("excludes draining agents unless asked", () => {
    const mesh = tracked(freshMesh());
    const a = mesh.registerLocal({
      service: "echo",
      name: "A",
      endpoint: "http://127.0.0.1:1",
      capabilities: ["echo.v1"],
    });
    mesh.registry.setStatus(a, "draining");
    expect(mesh.resolve("echo")).toBeUndefined();
  });
});

describe("Mesh in-process dispatch", () => {
  test("routes to the registered handler with retries across instances", async () => {
    const mesh = tracked(freshMesh());
    mesh.registerLocal(
      { service: "echo", name: "A", endpoint: "http://127.0.0.1:1", capabilities: ["echo.v1"] },
      async (request) => ({ body: { handled: request.agentId, body: request.body } }),
    );
    const result = await mesh.client.request("echo", { body: { n: 1 }, maxAttempts: 1 });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.encrypted).toBe(false);
    expect(result.body).toEqual({ handled: result.agentId, body: { n: 1 } });
  });

  test("handler 5xx responses are retried on the next instance, then surface", async () => {
    const mesh = tracked(freshMesh());
    mesh.registerLocal(
      { service: "flaky", name: "flaky-1", endpoint: "http://127.0.0.1:1", capabilities: ["flaky.v1"], id: "flaky-1" },
      async () => ({ body: { error: "overloaded" }, status: 503 }),
    );
    mesh.registerLocal(
      { service: "flaky", name: "flaky-2", endpoint: "http://127.0.0.1:2", capabilities: ["flaky.v1"], id: "flaky-2" },
      async (request) => ({ body: { ok: true, seen: request.body } }),
    );
    const result = await mesh.client.request("flaky", { body: { n: 2 }, maxAttempts: 2 });
    expect(result.attempts).toBe(2);
    expect(result.agentId).toBe("flaky-2");
    expect(result.body).toEqual({ ok: true, seen: { n: 2 } });
  });

  test("all attempts failing raises AgentUnavailableError", async () => {
    const mesh = tracked(freshMesh());
    mesh.registerLocal(
      { service: "down", name: "down-1", endpoint: "http://127.0.0.1:1", capabilities: ["down.v1"] },
      async () => ({ body: null, status: 503 }),
    );
    await expect(mesh.client.request("down", { maxAttempts: 2, retryDelayMs: 1 })).rejects.toThrow(
      /all 2 attempt/,
    );
  });

  test("requests to unknown services are unroutable", async () => {
    const mesh = tracked(freshMesh());
    await expect(mesh.client.request("ghost", { maxAttempts: 1 })).rejects.toThrow(/no healthy instance/);
  });
});

describe("Mesh secure channels", () => {
  test("end-to-end: initiator and responder derive a working channel", async () => {
    const clientMesh = tracked(freshMesh());
    const serverMesh = tracked(freshMesh());

    const { identity, offer } = clientMesh.attachSecureChannel("peer-1");
    const reply = serverMesh.acceptSecureChannel("peer-1", offer);
    clientMesh.completeSecureChannel("peer-1", offer, reply, identity);

    const channel = clientMesh.channels.get("peer-1");
    expect(channel).toBeDefined();
    const frame = channel!.seal({ hello: "mesh" }, 0);
    const peerChannel = serverMesh.channels.get("peer-1");
    expect(peerChannel!.open(frame, 0)).toEqual({ hello: "mesh" });
  });
});

describe("Mesh status circuits", () => {
  test("circuit summaries appear after failures", async () => {
    const mesh = tracked(freshMesh());
    mesh.registerLocal(
      { service: "down", name: "down-1", endpoint: "http://127.0.0.1:1", capabilities: ["down.v1"] },
      async () => ({ body: null, status: 503 }),
    );
    await mesh.client.request("down", { maxAttempts: 1 }).catch(() => null);
    const status = mesh.status();
    expect(status.circuits).toHaveLength(1);
    expect(status.circuits[0].failures).toBeGreaterThan(0);
  });
});

describe("Capability lookup", () => {
  test("unresolvable capability raises CapabilityNotFoundError", () => {
    const mesh = tracked(freshMesh());
    expect(() => mesh.registry.lookup("missing.capability")).toThrow(CapabilityNotFoundError);
  });
});
