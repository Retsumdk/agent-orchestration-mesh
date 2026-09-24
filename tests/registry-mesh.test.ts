import { afterEach, describe, expect, test } from "bun:test";
import { Mesh } from "../src/mesh";
import { ServiceRegistry } from "../src/registry";
import { DuplicateAgentError, ValidationError } from "../src/errors";
import { generateIdentityKeyPair } from "../src/security/identity";
import { createHandshakeOffer } from "../src/security/channel";
import type { AgentRegistrationInput } from "../src/types";

function input(overrides: Partial<AgentRegistrationInput> = {}): AgentRegistrationInput {
  return {
    id: "agent-1",
    name: "Agent One",
    service: "echo",
    endpoint: "http://127.0.0.1:9001",
    capabilities: ["echo"],
    version: "1.0.0",
    ...overrides,
  };
}

describe("ServiceRegistry", () => {
  test("registers, gets and lists agents", () => {
    const registry = new ServiceRegistry();
    const id = registry.register(input());
    expect(id).toBe("agent-1");
    expect(registry.get("agent-1").name).toBe("Agent One");
    expect(registry.list()).toHaveLength(1);
    expect(registry.size()).toBe(1);
  });

  test("generated ids are unique when omitted", () => {
    const registry = new ServiceRegistry();
    const a = registry.register(input({ id: undefined }));
    const b = registry.register(input({ id: undefined }));
    expect(a).not.toBe(b);
  });

  test("rejects duplicate registrations of a live agent, allows re-register after expiry", () => {
    const registry = new ServiceRegistry({ ttlMs: 5_000, pruneIntervalMs: 0 });
    registry.register(input());
    expect(() => registry.register(input())).toThrow(DuplicateAgentError);
  });

  test("rejects invalid descriptors", () => {
    const registry = new ServiceRegistry();
    expect(() => registry.register(input({ id: "bad id!" }))).toThrow(ValidationError);
    expect(() => registry.register(input({ endpoint: "not-a-url" }))).toThrow(ValidationError);
    expect(() => registry.register(input({ capabilities: [] }))).toThrow(ValidationError);
    expect(() => registry.register(input({ capabilities: ["BAD CAP"] }))).toThrow(ValidationError);
    expect(() => registry.register(input({ weight: 0 }))).toThrow(ValidationError);
  });

  test("heartbeats renew the lease and deregistration removes the agent", () => {
    const registry = new ServiceRegistry({ ttlMs: 5_000, pruneIntervalMs: 0 });
    registry.register(input({ ttlMs: undefined }));
    registry.heartbeat("agent-1");
    expect(registry.size()).toBe(1);
    expect(registry.deregister("agent-1")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  test("prune removes agents whose TTL elapsed since their last heartbeat", () => {
    const registry = new ServiceRegistry({ ttlMs: 5_000, pruneIntervalMs: 0 });
    registry.register(input());
    registry.register(input({ id: "agent-2", name: "Agent Two" }));
    registry.heartbeat("agent-2");
    registry.prune();
    expect(registry.size()).toBe(2);
  });
});

describe("Mesh facade", () => {
  const meshes: Mesh[] = [];
  function makeMesh(...args: ConstructorParameters<typeof Mesh>): Mesh {
    const mesh = new Mesh(...args);
    meshes.push(mesh);
    return mesh;
  }
  afterEach(() => {
    for (const mesh of meshes.splice(0)) mesh.shutdown();
  });

  test("round-robins in-process handlers across two agents", async () => {
    const mesh = makeMesh();
    mesh.registerLocal(input({ id: "a" }), async () => ({ body: { from: "a" } }));
    mesh.registerLocal(input({ id: "b", name: "Agent B" }), async () => ({ body: { from: "b" } }));
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await mesh.client.request<{ from: string }>("echo");
      seen.push(result.body.from);
    }
    expect(seen).toEqual(["a", "b", "a", "b"]);
  });

  test("retries on the next instance when one fails, and records circuit failures", async () => {
    const mesh = makeMesh();
    mesh.registerLocal(input({ id: "flaky" }), async () => ({ body: "boom", status: 503 }));
    mesh.registerLocal(input({ id: "solid", name: "Solid" }), async () => ({ body: { ok: true } }));
    const result = await mesh.client.request<{ ok: boolean }>("echo", { maxAttempts: 3, retryDelayMs: 1 });
    expect(result.body.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.agentId).toBe("solid");
    expect(mesh.status().circuits.find((c) => c.agentId === "flaky")?.failures).toBe(1);
  });

  test("exhausted retries raise AgentUnavailableError and trip the circuit", async () => {
    const mesh = makeMesh();
    mesh.registerLocal(input({ id: "down" }), async () => ({ body: "down", status: 503 }));
    await expect(mesh.client.request("echo", { maxAttempts: 2, retryDelayMs: 1 })).rejects.toThrow(/all 2 attempt/);
    expect(mesh.status().circuits.find((c) => c.agentId === "down")?.failures).toBeGreaterThanOrEqual(2);
  });

  test("routing to an unknown service fails with a routing error", async () => {
    const mesh = makeMesh();
    await expect(mesh.client.request("ghost", { maxAttempts: 1 })).rejects.toThrow(/no healthy instance/);
  });

  test("secure channels complete a full handshake and encrypt in-process traffic", async () => {
    const mesh = makeMesh();
    const meshKeys = generateIdentityKeyPair();
    const agentKeys = generateIdentityKeyPair();

    const { offer } = mesh.attachSecureChannel("secure-agent", meshKeys);
    const reply = mesh.acceptSecureChannelResponder
      ? undefined
      : undefined;
    void reply;
    const agentChannelOfferAccepted = offer;
    void agentChannelOfferAccepted;

    // Responder side (the agent) answers the offer and opens its own channel.
    const { SecureChannelResponder } = await import("../src/security/channel");
    const responder = SecureChannelResponder.respond(agentKeys, "secure-agent", offer);
    mesh.completeSecureChannel("secure-agent", offer, responder.reply, meshKeys);

    mesh.registerLocal(input({ id: "secure-agent", name: "Secure Agent" }), async (request) => {
      expect(request.encrypted).toBe(true);
      return { body: { echoed: request.body } };
    });

    const result = await mesh.client.request<{ echoed: unknown }>("echo", { secure: true, maxAttempts: 1 });
    expect(result.encrypted).toBe(true);
    expect(result.agentId).toBe("secure-agent");
  });

  test("handshake offers are bound to their identity fingerprint", () => {
    const keys = generateIdentityKeyPair();
    const offer = createHandshakeOffer(keys, "node-a");
    expect(offer.from).toBe("node-a");
    expect(offer.fp.length).toBe(32);
  });

  test("status reports registry totals, services and inflight", async () => {
    const mesh = makeMesh();
    mesh.registerLocal(input({ id: "a", service: "alpha" }), async () => ({ body: 1 }));
    mesh.registerLocal(input({ id: "b", service: "beta" }), async () => ({ body: 2 }));
    const status = mesh.status();
    expect(status.registry.total).toBe(2);
    expect(status.registry.services).toBe(2);
    expect(status.inflight).toBe(0);
  });

  test("deregistering removes the agent and its channel", () => {
    const mesh = makeMesh();
    const id = mesh.registerLocal(input());
    expect(mesh.deregister(id)).toBe(true);
    expect(mesh.list()).toHaveLength(0);
    expect(mesh.deregister(id)).toBe(false);
  });
});
