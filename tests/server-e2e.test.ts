import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Mesh } from "../src/mesh";
import { MeshServer } from "../src/server";
import type { AgentRegistrationInput } from "../src/types";

const CLEANUP: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of CLEANUP.splice(0)) await fn();
});

function input(overrides: Partial<AgentRegistrationInput> = {}): AgentRegistrationInput {
  return {
    id: "backend-1",
    name: "Backend One",
    service: "compute",
    endpoint: "http://replace-me:1",
    capabilities: ["compute"],
    version: "1.0.0",
    ...overrides,
  };
}

/** Standalone HTTP agent the mesh routes to over real network sockets. */
function startAgent(port: number, behavior: "ok" | "slow" | "down"): { server: Server; hits: () => number } {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const respond = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (behavior === "slow") {
        setTimeout(() => respond(200, { agent: "slow", hits }), 1_500);
      } else if (behavior === "down") {
        respond(503, { error: "try again" });
      } else {
        respond(200, { agent: "ok", received: JSON.parse(body || "{}"), hits });
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, hits: () => hits };
}

async function jsonFetch(url: string, body: unknown, method = "POST"): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("MeshServer end-to-end", () => {
  test("health, register, lookup, routed call and status over real HTTP", async () => {
    const agent = startAgent(9_201, "ok");
    const mesh = new Mesh({ defaults: { ttlMs: 30_000, pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh);
    const started = await server.listen({ host: "127.0.0.1", port: 9_200 }).start();
    CLEANUP.push(async () => {
      await server.stop();
      agent.server.close();
    });
    expect(started).toBe(9_200);

    const health = await jsonFetch(`${server.address}/health`, null, "GET");
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);

    const register = await jsonFetch(`${server.address}/register`, {
      id: "backend-1",
      name: "Backend One",
      service: "compute",
      endpoint: "http://127.0.0.1:9201",
      capabilities: ["compute"],
      version: "2.0.0",
      weight: 3,
    });
    expect(register.status).toBe(201);
    expect(register.json.ok).toBe(true);

    const lookup = await jsonFetch(`${server.address}/lookup?service=compute`, null, "GET");
    expect(lookup.status).toBe(200);
    expect((lookup.json.instance as Record<string, unknown>).endpoint).toBe("http://127.0.0.1:9201");

    const call = await jsonFetch(`${server.address}/call`, { service: "compute", payload: { task: "sum", x: 2, y: 3 } });
    expect(call.status).toBe(200);
    const result = call.json.result as Record<string, unknown>;
    expect(result.agentId).toBe("backend-1");
    expect((result.body as Record<string, unknown>).received).toEqual({ task: "sum", x: 2, y: 3 });

    const status = await jsonFetch(`${server.address}/status`, null, "GET");
    const agents = status.json.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("backend-1");
    expect(agents[0].version).toBe("2.0.0");
  });

  test("a dying remote agent is retried on healthy replicas until its circuit opens", async () => {
    const down = startAgent(9_211, "down");
    const ok = startAgent(9_212, "ok");
    const mesh = new Mesh({ defaults: { ttlMs: 30_000, pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh);
    await server.listen({ host: "127.0.0.1", port: 9_210 }).start();
    CLEANUP.push(async () => {
      await server.stop();
      down.server.close();
      ok.server.close();
    });

    await jsonFetch(`${server.address}/register`, { ...input({ id: "down", endpoint: "http://127.0.0.1:9211" }) });
    await jsonFetch(`${server.address}/register`, { ...input({ id: "solid", name: "Solid", endpoint: "http://127.0.0.1:9212" }) });

    for (let round = 0; round < 3; round += 1) {
      const call = await jsonFetch(`${server.address}/call`, { service: "compute", payload: { round } });
      expect(call.status).toBe(200);
      expect((call.json.result as Record<string, unknown>).agentId).toBe("solid");
    }
    expect(down.hits()).toBeGreaterThanOrEqual(1);
    expect(ok.hits()).toBe(3);
  });

  test("an unroutable service returns 502 with a clear error", async () => {
    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh);
    await server.listen({ host: "127.0.0.1", port: 9_220 }).start();
    CLEANUP.push(async () => server.stop());
    const call = await jsonFetch(`${server.address}/call`, { service: "ghost" });
    expect(call.status).toBe(502);
    expect(String(call.json.error)).toMatch(/no healthy instance/i);
  });

  test("invalid registrations are rejected with a 400", async () => {
    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh);
    await server.listen({ host: "127.0.0.1", port: 9_230 }).start();
    CLEANUP.push(async () => server.stop());
    const missingService = await jsonFetch(`${server.address}/register`, { name: "X", endpoint: "http://x:1" });
    expect(missingService.status).toBe(400);
    const badCapabilities = await jsonFetch(`${server.address}/register`, {
      ...input(),
      capabilities: "not-an-array",
    });
    expect(badCapabilities.status).toBe(400);
  });

  test("heartbeat renews and deregister removes a remote agent", async () => {
    const mesh = new Mesh({ defaults: { ttlMs: 30_000, pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh);
    await server.listen({ host: "127.0.0.1", port: 9_240 }).start();
    CLEANUP.push(async () => server.stop());
    await jsonFetch(`${server.address}/register`, { ...input({ endpoint: "http://127.0.0.1:1" }) });
    const beat = await jsonFetch(`${server.address}/heartbeat`, { agentId: "backend-1" });
    expect(beat.status).toBe(200);
    const gone = await jsonFetch(`${server.address}/deregister`, { agentId: "backend-1" });
    expect(gone.status).toBe(200);
    const beatAfter = await jsonFetch(`${server.address}/heartbeat`, { agentId: "backend-1" });
    expect(beatAfter.status).toBe(404);
  });
});
