#!/usr/bin/env node
/**
 * CLI for agent-orchestration-mesh.
 *
 * Subcommands:
 *   serve    Start a mesh control-plane node.
 *   register Register an agent endpoint with a running mesh.
 *   list     List registered agents.
 *   call     Send a routed request to a service.
 *   demo     Run a self-contained demo with two in-process agents.
 *   help     Show this help.
 */
import { Mesh } from "./mesh.js";
import { MeshServer } from "./server.js";
import type { AgentRegistrationInput } from "./types.js";

type Args = Map<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--") ? (argv[++i] as string) : "true";
      args.set(key, value);
    }
  }
  return args;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function parseAgent(jsonText: string): AgentRegistrationInput {
  const parsed = JSON.parse(jsonText) as Partial<AgentRegistrationInput> & { endpoint?: string; url?: string };
  const endpoint = parsed.endpoint ?? parsed.url;
  if (!parsed.name || !endpoint) {
    throw new Error('JSON must include at least "name", "service" and "endpoint"');
  }
  return {
    id: parsed.id ?? `agent-${Math.random().toString(36).slice(2, 10)}`,
    name: parsed.name,
    service: parsed.service ?? parsed.name,
    endpoint,
    version: parsed.version ?? "1.0.0",
    capabilities: parsed.capabilities ?? [],
    weight: parsed.weight ?? 1,
    meta: parsed.meta ?? {},
  };
}

async function cmdServe(args: Args): Promise<void> {
  const port = parsePort(args.get("port"), 4600);
  const host = args.get("host") ?? "127.0.0.1";
  const ttlMs = Number.parseInt(args.get("ttl") ?? "", 10);
  const mesh = new Mesh({
    node: { name: `mesh-${port}`, endpoint: `http://${host}:${port}` },
    defaults: {
      ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : undefined,
      strategy: (args.get("strategy") ?? "round-robin") as never,
    },
  });
  const server = new MeshServer(mesh, { host, port });
  await server.listen({ host, port }).start();
  console.log(`agent-orchestration-mesh node listening on http://${host}:${port}`);
  console.log("  GET  /health   - liveness probe");
  console.log("  GET  /status   - mesh snapshot (agents, circuits)");
  console.log("  POST /register - register an agent (JSON body)");
  console.log("  POST /heartbeat - renew an agent lease (JSON body)");
  console.log("  POST /deregister - remove an agent (JSON body)");
  console.log("  GET  /lookup?service=name - resolve a service to an instance");
  console.log("  POST /call     - route a request to a target service");
  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdRegister(args: Args): Promise<void> {
  const meshUrl = args.get("mesh") ?? "http://127.0.0.1:4600";
  const response = await fetch(`${meshUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parseAgent(args.get("json") ?? "{}")),
  });
  const body = (await response.json()) as { ok?: boolean; agentId?: string; error?: string };
  if (!response.ok || !body.ok) {
    console.error(`register failed: ${body.error ?? response.status}`);
    process.exitCode = 1;
    return;
  }
  console.log(`registered ${body.agentId}`);
}

async function cmdList(args: Args): Promise<void> {
  const meshUrl = args.get("mesh") ?? "http://127.0.0.1:4600";
  const response = await fetch(`${meshUrl}/status`);
  const body = (await response.json()) as { agents?: Array<Record<string, unknown>> };
  for (const agent of body.agents ?? []) {
    console.log(
      `${String(agent.id).padEnd(24)} ${String(agent.name).padEnd(20)} ${String(agent.service).padEnd(20)} ${String(agent.endpoint).padEnd(34)} ${String(agent.status)}`,
    );
  }
}

async function cmdCall(args: Args): Promise<void> {
  const meshUrl = args.get("mesh") ?? "http://127.0.0.1:4600";
  const service = args.get("service");
  if (!service) {
    console.error("--service is required");
    process.exitCode = 1;
    return;
  }
  const response = await fetch(`${meshUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service,
      payload: JSON.parse(args.get("payload") ?? "{}") as unknown,
      strategy: args.get("strategy"),
      maxAttempts: Number.parseInt(args.get("attempts") ?? "", 10) || undefined,
    }),
  });
  const body = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !body.ok) {
    console.error(`call failed: ${body.error ?? response.status}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(body.result, null, 2));
}

async function cmdDemo(): Promise<void> {
  const mesh = new Mesh({ node: { name: "demo-mesh", endpoint: "http://127.0.0.1:0/demo" } });
  mesh.registerLocal({
    id: "worker-a",
    name: "worker-a",
    service: "echo",
    endpoint: "http://127.0.0.1:0/worker-a",
    capabilities: ["echo"],
    version: "1.0.0",
  }, (request) => ({ body: { echo: request.body, reply: "from worker A" } }));
  mesh.registerLocal({
    id: "worker-b",
    name: "worker-b",
    service: "echo",
    endpoint: "http://127.0.0.1:0/worker-b",
    capabilities: ["echo"],
    version: "1.0.0",
  }, (request) => ({ body: { echo: request.body, reply: "from worker B" } }));

  for (const payload of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
    const result = await mesh.client.request("echo", { body: payload });
    console.log(`routed to ${result.agentId} (attempt ${result.attempts}): ${JSON.stringify(result.body)}`);
  }
  console.log(`registered agents: ${mesh.list().map((a) => a.name).join(", ")}`);
  mesh.shutdown();
}

const commands = new Map<string, (args: Args) => Promise<void>>([
  ["serve", cmdServe],
  ["register", cmdRegister],
  ["list", cmdList],
  ["call", cmdCall],
  ["demo", () => cmdDemo()],
]);

const argv = process.argv.slice(2);
const commandName = argv[0];
const command = commandName ? commands.get(commandName) : undefined;
if (!command) {
  console.log("Usage: mesh <serve|register|list|call|demo> [--options]\n");
  console.log("  serve --port 4600 --host 127.0.0.1 --ttl 30000 --strategy least-outstanding");
  console.log("  register --mesh http://127.0.0.1:4600 --json '{...}'");
  console.log("  list --mesh http://127.0.0.1:4600");
  console.log('  call --mesh http://127.0.0.1:4600 --service echo --payload \'{"hi":true}\'');
  console.log("  demo");
  if (commandName && commandName !== "help") process.exitCode = 1;
} else {
  await command(parseArgs(argv.slice(1)));
}
