# agent-orchestration-mesh

A service mesh for AI agents, written in TypeScript with zero runtime dependencies.
Agents register with a mesh node, publish the capabilities they serve, and callers
route requests by service or capability while the mesh handles discovery, load
balancing, retries, and failure isolation.

## The problem it solves

Multi-agent systems outgrow a hardcoded list of URLs fast. Agent instances come and
go (crash, redeploy, scale out), several agents serve the same capability, and one
sick agent can stall a whole pipeline. Wiring retries, health tracking, and failover
into every caller duplicates the same fragile code everywhere.

This library moves those concerns into the mesh layer:

- **Discovery** — a TTL-based registry. Agents renew their lease with heartbeats;
  silence expires them automatically, so callers never route to a dead instance.
- **Load balancing** — round-robin, weighted round-robin, least-outstanding, or
  random, applied per request across healthy instances.
- **Resilience** — automatic retries on a *different* instance, per-agent timeouts,
  and a per-agent circuit breaker (closed → open → half-open) that stops traffic to
  failing agents and lets it recover.
- **Confidentiality** — optional end-to-end secure channels between two identities:
  mutual Ed25519 authentication, an X25519 key exchange expanded with HKDF-SHA256,
  and AES-256-GCM frames with per-sequence IVs and replay rejection.

## How it works

```
caller ──request──► Mesh ──resolve──► ServiceRegistry (TTL leases, capability index)
                        │
                        ├─pick─► LoadBalancer (round-robin | weighted | least-outstanding | random)
                        │
                        ├─guard─► CircuitBreaker (per agent)
                        │
                        └─dispatch─► in-process handler or remote HTTP agent
                                       └─ optional SecureChannel (Ed25519 + X25519 + AES-256-GCM)
```

- **`ServiceRegistry`** stores agents under `{ id, service, capabilities[] }` with a
  per-registration TTL. `heartbeat(id)` renews the lease; `prune()` (run on every
  lookup and by an optional background timer) drops expired agents.
- **`LoadBalancer`** picks one candidate from the healthy list using the configured
  strategy, honoring reported weights and in-flight request counts.
- **`MeshClient`** dispatches to an in-process handler when the agent registered one,
  otherwise to `endpoint` over HTTP. Transport errors, timeouts, and 5xx responses
  are retried on the next instance; 4xx responses surface immediately.
- **`CircuitBreaker`** counts consecutive failures per agent. Past the threshold the
  circuit opens and the agent is skipped; after a cooldown, bounded trial calls
  (half-open) decide whether it closes again.
- **`SecureChannel`** (optional, per agent pair) exchanges signed handshake offers and
  replies, derives direction-specific session keys, and seals every payload as a
  `SecureFrame` that authenticates the sender, rejects tampering, and refuses
  replays or re-ordered sequence numbers.

The security design note: this is an application-layer channel with the same
guarantees TLS gives at the transport layer (mutual authentication, forward-secret
key agreement, AEAD confidentiality). It encrypts payload end-to-end even across
intermediary hops that only forward frames.

## Getting started

Requires [Bun](https://bun.sh) 1.1+.

```bash
git clone https://github.com/Retsumdk/agent-orchestration-mesh.git
cd agent-orchestration-mesh
bun install
```

Verify everything works:

```bash
bun run typecheck   # strict TypeScript, zero errors
bun test            # 94 tests, all green
bun run build       # emits dist/
bun run src/cli.ts demo   # self-contained demo with two in-process agents
```

## Usage

### In-process agents

```ts
import { Mesh } from "./src/index";

const mesh = new Mesh({ defaults: { ttlMs: 30_000, pruneIntervalMs: 1_000 } });

// Agents with a handler are served in-process:
mesh.registerLocal(
  { id: "echo-a", service: "echo", name: "Echo A", endpoint: "http://127.0.0.1:0/echo-a", capabilities: ["echo.v1"] },
  async (request) => ({ body: { from: "echo-a", youSent: request.body } }),
);

// Agents without a handler are treated as remote HTTP targets:
mesh.registerLocal({ id: "echo-b", service: "echo", name: "Echo B", endpoint: "http://127.0.0.1:9002", capabilities: ["echo.v1"] });

const result = await mesh.client.request<{ from: string }>("echo", {
  body: { hello: "mesh" },
  timeoutMs: 2_000,
  retries: 2,
});
console.log(result.agentId, result.body, result.attempts);
```

### Secure channels

```ts
import { Mesh } from "./src/index";
import { generateIdentityKeyPair } from "./src/security/identity";
import { SecureChannelResponder } from "./src/security/channel";

const mesh = new Mesh();
mesh.registerLocal({ id: "vault", service: "vault", name: "Vault", endpoint: "http://127.0.0.1:0/vault", capabilities: ["vault.read"] },
  async (request) => ({ body: { secret: 42, encrypted: request.encrypted } }));

const meshKeys = generateIdentityKeyPair();
const agentKeys = generateIdentityKeyPair();

// Initiator creates a signed offer; the responder verifies it and answers.
const { offer } = mesh.attachSecureChannel("vault", meshKeys);
const { reply } = SecureChannelResponder.respond(agentKeys, "vault", offer);
mesh.completeSecureChannel("vault", offer, reply, meshKeys);

const result = await mesh.client.request("vault", { body: { need: "secret" }, secure: true });
// result.encrypted === true; frames are AES-256-GCM sealed and Ed25519-signed
```

### HTTP control plane

Run a standalone mesh node:

```bash
bun run src/cli.ts serve --port 4600
```

Register agents, renew leases, and route calls over HTTP:

```bash
curl -X POST http://127.0.0.1:4600/register \
  -H 'content-type: application/json' \
  -d '{"id":"worker-1","service":"compute","name":"Worker One","endpoint":"http://127.0.0.1:7001","capabilities":["compute.square"]}'

curl -X POST http://127.0.0.1:4600/heartbeat -d '{"agentId":"worker-1"}'
curl http://127.0.0.1:4600/lookup?service=compute
curl -X POST http://127.0.0.1:4600/call -d '{"service":"compute","payload":{"n":9}}'
curl http://127.0.0.1:4600/status
```

Expected response from `/call`:

```json
{ "ok": true, "result": { "agentId": "worker-1", "endpoint": "...", "status": 200,
  "attempts": 1, "durationMs": 12, "body": { "agent": "ok" }, "encrypted": false } }
```

### CLI

```bash
bun run src/cli.ts demo                          # two in-process agents + round-robin
bun run src/cli.ts serve --port 4600 --ttl 30000 --strategy least-outstanding
bun run src/cli.ts register --mesh http://127.0.0.1:4600 --json '{"service":"compute","name":"W","endpoint":"http://127.0.0.1:7001","capabilities":["compute.square"]}'
bun run src/cli.ts list --mesh http://127.0.0.1:4600
bun run src/cli.ts call --mesh http://127.0.0.1:4600 --service compute --payload '{"n":9}'
```

A runnable script combining all of the above lives in
[`examples/quickstart.ts`](examples/quickstart.ts) — run it with `bun run examples/quickstart.ts`.

## API surface

| Export | Purpose |
|---|---|
| `Mesh` | Facade wiring registry, balancer, client, breakers, and channels |
| `ServiceRegistry` | TTL leases, capability index, prune/heartbeat |
| `LoadBalancer` | `round-robin` · `weighted-round-robin` · `least-outstanding` · `random` |
| `CircuitBreaker` | closed/open/half-open failure isolation per agent |
| `MeshClient` | timeout + retry + circuit-guarded dispatch (in-process or HTTP) |
| `MeshServer` | HTTP control/data plane (`/register`, `/heartbeat`, `/lookup`, `/call`, `/status`, `/health`) |
| `generateIdentityKeyPair` | Ed25519 signing + X25519 agreement identity |
| `SecureChannel` / `SecureChannelResponder` | mutually authenticated encrypted sessions |

All errors are typed subclasses of `MeshError` with stable `code`s
(`MESH_VALIDATION_FAILED`, `MESH_AGENT_NOT_FOUND`, `MESH_CIRCUIT_OPEN`,
`MESH_TIMEOUT`, `MESH_HANDSHAKE_FAILED`, `MESH_CRYPTO_VERIFICATION_FAILED`, …).

## Project layout

```
src/
├── index.ts            # public API surface
├── types.ts            # shared type vocabulary (dependency-free)
├── errors.ts           # MeshError hierarchy with stable codes
├── registry.ts         # TTL service registry + capability index
├── loadbalancer.ts     # pluggable strategies
├── circuitbreaker.ts   # per-agent failure isolation
├── client.ts           # dispatch: timeouts, retries, secure frames
├── mesh.ts             # facade wiring everything together
├── server.ts           # HTTP control + data plane
├── cli.ts              # serve / register / list / call / demo
└── security/
    ├── identity.ts     # Ed25519 + X25519 key pairs, fingerprints
    └── channel.ts      # handshake + AES-256-GCM secure frames
tests/                  # 94 tests across 10 suites (bun test)
examples/quickstart.ts  # runnable end-to-end demo
```

## License

[MIT](LICENSE)
