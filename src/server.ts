import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Mesh } from "./mesh.js";
import { CapabilityNotFoundError, DuplicateAgentError, ValidationError } from "./errors.js";
import type { AgentRegistrationInput, StrategyName } from "./types.js";
import { isStrategyName } from "./loadbalancer.js";

export interface MeshServerOptions {
  host?: string;
  port?: number;
}

type JsonBody = Record<string, unknown>;

function readJson(req: IncomingMessage, limitBytes = 1_048_576): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) resolve(parsed as JsonBody);
        else reject(new Error("request body must be a JSON object"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function registrationFrom(body: JsonBody): AgentRegistrationInput {
  const name = body.name;
  const service = body.service;
  const endpoint = body.endpoint ?? body.url;
  if (typeof name !== "string" || name.length === 0) throw new ValidationError("agent requires a name");
  if (typeof service !== "string" || service.length === 0) throw new ValidationError("agent requires a service");
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new ValidationError("agent requires an endpoint");
  if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
    throw new ValidationError("capabilities must be an array of strings");
  }
  return {
    id: typeof body.id === "string" && body.id.length > 0 ? body.id : `agent-${Math.random().toString(36).slice(2, 10)}`,
    name,
    service,
    endpoint,
    ...(typeof body.version === "string" && body.version.length > 0 ? { version: body.version } : {}),
    capabilities: Array.isArray(body.capabilities)
      ? body.capabilities.filter((c): c is string => typeof c === "string")
      : [],
    weight: typeof body.weight === "number" && Number.isFinite(body.weight) ? body.weight : 1,
    meta:
      body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? (Object.fromEntries(
            Object.entries(body.meta as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              .map(([k, v]) => [k, String(v)]),
          ) as Record<string, string>)
        : {},
  };
}

/**
 * HTTP control + data plane for a mesh node.
 *
 *   GET  /health                     liveness probe
 *   GET  /status                     full mesh snapshot
 *   POST /register                   register a remote agent
 *   POST /heartbeat                  renew an agent lease
 *   POST /deregister                 remove an agent
 *   GET  /lookup?service=<service>   resolve a service to one instance
 *   POST /call                       route a request through the mesh
 */
export class MeshServer {
  private readonly mesh: Mesh;
  private host: string;
  private port: number;
  private httpServer: ReturnType<typeof createServer> | undefined;

  constructor(mesh: Mesh, options: MeshServerOptions = {}) {
    this.mesh = mesh;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4600;
  }

  get address(): string {
    const bound = this.httpServer?.address();
    if (bound && typeof bound === "object") {
      return `http://${bound.address === "::" ? "127.0.0.1" : bound.address}:${bound.port}`;
    }
    return `http://${this.host}:${this.port}`;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health": {
          sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
          return;
        }
        case "GET /status": {
          const registry = this.mesh.registry.snapshot();
          sendJson(res, 200, {
            ok: true,
            registry,
            agents: this.mesh.list(),
            circuits: this.mesh.status().circuits,
          });
          return;
        }
        case "POST /register": {
          const body = await readJson(req);
          try {
            const input = registrationFrom(body);
            const agentId = this.mesh.registerLocal(input);
            sendJson(res, 201, { ok: true, agentId, agent: this.mesh.registry.get(agentId) });
          } catch (error) {
            const status = error instanceof DuplicateAgentError ? 409 : 400;
            sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : "invalid registration" });
          }
          return;
        }
        case "POST /heartbeat": {
          const body = await readJson(req);
          const agentId = typeof body.agentId === "string" ? body.agentId : "";
          try {
            this.mesh.registry.heartbeat(agentId);
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : "unknown agent" });
          }
          return;
        }
        case "POST /deregister": {
          const body = await readJson(req);
          const agentId = typeof body.agentId === "string" ? body.agentId : "";
          const removed = this.mesh.deregister(agentId);
          sendJson(res, removed ? 200 : 404, { ok: removed });
          return;
        }
        case "GET /lookup": {
          const service = url.searchParams.get("service") ?? "";
          const strategyRaw = url.searchParams.get("strategy");
          if (strategyRaw !== null && !isStrategyName(strategyRaw)) {
            sendJson(res, 400, { ok: false, error: `unknown strategy "${strategyRaw}"` });
            return;
          }
          const instance = this.mesh.resolve(service, (strategyRaw as StrategyName) || undefined);
          if (!instance) {
            sendJson(res, 404, { ok: false, error: `no healthy instance for service "${service}"` });
            return;
          }
          sendJson(res, 200, { ok: true, instance });
          return;
        }
        case "POST /call": {
          const body = await readJson(req);
          const service = typeof body.service === "string" ? body.service : "";
          if (!service) {
            sendJson(res, 400, { ok: false, error: "service is required" });
            return;
          }
          const strategyRaw = body.strategy;
          if (strategyRaw !== undefined && !isStrategyName(strategyRaw)) {
            sendJson(res, 400, { ok: false, error: `unknown strategy "${String(strategyRaw)}"` });
            return;
          }
          try {
            const result = await this.mesh.client.request(service, {
              body: body.payload ?? {},
              headers:
                body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
                  ? (body.headers as Record<string, string>)
                  : undefined,
              method: typeof body.method === "string" ? body.method : "POST",
              maxAttempts: typeof body.maxAttempts === "number" && Number.isFinite(body.maxAttempts) ? body.maxAttempts : undefined,
              timeoutMs: typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined,
              strategy: strategyRaw as StrategyName | undefined,
            });
            sendJson(res, 200, { ok: true, result });
          } catch (error) {
            const status = error instanceof CapabilityNotFoundError ? 404 : 502;
            sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : "call failed" });
          }
          return;
        }
        default:
          sendJson(res, 404, { ok: false, error: `no route for ${route}` });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "internal error" });
    }
  }

  listen(options: MeshServerOptions = {}): { start: () => Promise<number>; stop: () => Promise<void> } {
    const host = options.host ?? this.host;
    const port = options.port ?? this.port;
    const http = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.httpServer = http;
    return {
      start: (): Promise<number> =>
        new Promise((resolve, reject) => {
          http.once("error", reject);
          http.listen(port, host, () => {
            const bound = http.address();
            resolve(bound && typeof bound === "object" ? bound.port : port);
          });
        }),
      stop: (): Promise<void> => this.stop(),
    };
  }

  /** Convenience wrapper: start listening and resolve with the bound port. */
  async start(options: MeshServerOptions = {}): Promise<number> {
    return this.listen(options).start();
  }

  /** Stop accepting connections and stop the mesh prune timer. */
  async stop(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    this.httpServer = undefined;
    this.mesh.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
