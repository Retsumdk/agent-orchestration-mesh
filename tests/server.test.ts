import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Mesh } from "../src/mesh.js";
import { MeshServer } from "../src/server.js";

async function withUpstream(fn: (url: string, hits: () => number) => Promise<void>): Promise<void> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const echo = body.length > 0 ? JSON.parse(body) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ upstream: "echo", echo, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, () => hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const servers: Array<{ stop: () => Promise<void> }> = [];
afterAll(async () => {
  for (const entry of servers) await entry.stop();
});

describe("MeshServer HTTP plane", () => {
  test("health, register, heartbeat, lookup, deregister and status", async () => {
    const mesh = new Mesh({ defaults: { ttlMs: 5_000, pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh, { host: "127.0.0.1", port: 0 });
    const stop = server.listen();
    const port = await stop.start();
    servers.push({ stop: () => stop.stop() });
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const registered = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "echo",
        name: "Echo One",
        endpoint: "http://127.0.0.1:7001",
        capabilities: ["echo.v1"],
        id: "echo-1",
      }),
    });
    expect(registered.status).toBe(201);
    const registeredBody = (await registered.json()) as { ok: boolean; agent: { id: string; version: string } };
    expect(registeredBody.ok).toBe(true);
    expect(registeredBody.agent.id).toBe("echo-1");
    expect(registeredBody.agent.version).toBe("0.0.0");

    const duplicate = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "echo",
        name: "Echo One",
        endpoint: "http://127.0.0.1:7001",
        capabilities: ["echo.v1"],
        id: "echo-1",
      }),
    });
    expect(duplicate.status).toBe(409);

    const heartbeat = await fetch(`${base}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "echo-1" }),
    });
    expect(heartbeat.status).toBe(200);

    const missingHeartbeat = await fetch(`${base}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ghost" }),
    });
    expect(missingHeartbeat.status).toBe(404);

    const lookup = await fetch(`${base}/lookup?service=echo`);
    expect(lookup.status).toBe(200);
    const lookupBody = (await lookup.json()) as { instance: { id: string } };
    expect(lookupBody.instance.id).toBe("echo-1");

    const missingLookup = await fetch(`${base}/lookup?service=ghost`);
    expect(missingLookup.status).toBe(404);

    const status = await fetch(`${base}/status`);
    const statusBody = (await status.json()) as { registry: { total: number } };
    expect(statusBody.registry.total).toBe(1);

    const deregistered = await fetch(`${base}/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "echo-1" }),
    });
    expect(deregistered.status).toBe(200);
    expect(mesh.list()).toHaveLength(0);
  });

  test("POST /call routes to a registered remote agent over real HTTP", async () => {
    await withUpstream(async (upstreamUrl) => {
      const mesh = new Mesh({ defaults: { ttlMs: 5_000, pruneIntervalMs: 0 } });
      mesh.registerLocal({
        service: "echo",
        name: "remote-echo",
        endpoint: upstreamUrl,
        capabilities: ["echo.v1"],
        id: "remote-echo",
      });
      const server = new MeshServer(mesh, { host: "127.0.0.1", port: 0 });
      const stop = server.listen();
      const port = await stop.start();
      servers.push({ stop: () => stop.stop() });
      const base = `http://127.0.0.1:${port}`;

      const call = await fetch(`${base}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "echo", payload: { ping: true } }),
      });
      expect(call.status).toBe(200);
      const body = (await call.json()) as { ok: boolean; result: { agentId: string; body: { upstream: string } } };
      expect(body.ok).toBe(true);
      expect(body.result.agentId).toBe("remote-echo");
      expect(body.result.body.upstream).toBe("echo");
    });
  });

  test("unknown routes return 404 JSON", async () => {
    const mesh = new Mesh({ defaults: { pruneIntervalMs: 0 } });
    const server = new MeshServer(mesh, { host: "127.0.0.1", port: 0 });
    const stop = server.listen();
    const port = await stop.start();
    servers.push({ stop: () => stop.stop() });
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
  });
});

