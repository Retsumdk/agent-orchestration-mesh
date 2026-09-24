#!/usr/bin/env bun
/**
 * Quickstart: register two in-process agents on a mesh, route requests to them,
 * watch retries land on the healthy replica, and open an encrypted channel.
 *
 * Run with: bun run examples/quickstart.ts
 */

import { Mesh } from "../src/mesh.js";
import { generateIdentityKeyPair } from "../src/security/identity.js";
import { SecureChannelResponder, createHandshakeOffer } from "../src/security/channel.js";

const mesh = new Mesh({ defaults: { ttlMs: 30_000, pruneIntervalMs: 0 } });

// Two agents exposing the same "echo" capability. The second one is down on
// purpose: the mesh must retry on the healthy replica without bothering you.
mesh.registerLocal(
  { id: "echo-a", service: "echo", name: "Echo A", endpoint: "http://127.0.0.1:0/echo-a", capabilities: ["echo"] },
  async (request) => ({ body: { from: "echo-a", youSent: request.body } }),
);
mesh.registerLocal(
  { id: "echo-b", service: "echo", name: "Echo B", endpoint: "http://127.0.0.1:0/echo-b", capabilities: ["echo"] },
  async () => ({ body: "deliberately unavailable", status: 503 }),
);

const routed = await mesh.client.request<{ from: string }>("echo", { body: { hello: "mesh" }, maxAttempts: 2 });
console.log(`routed to ${routed.agentId} after ${routed.attempts} attempt(s):`, routed.body);

// Secure channels: mutually authenticated (Ed25519) and encrypted
// (X25519 -> HKDF -> AES-256-GCM) end-to-end between two identities.
const meshKeys = generateIdentityKeyPair();
const agentKeys = generateIdentityKeyPair();
const { offer } = mesh.attachSecureChannel("echo-a", meshKeys);
const responder = SecureChannelResponder.respond(agentKeys, "echo-a", offer);
mesh.completeSecureChannel("echo-a", offer, responder.reply, meshKeys);

const secret = await mesh.client.request<{ from: string; youSent: unknown }>("echo", {
  body: { ssn: "we-should-not-send-this-in-the-clear" },
  secure: true,
  maxAttempts: 2,
});
console.log(`encrypted round-trip via ${secret.agentId} (encrypted=${secret.encrypted}):`, secret.body);

console.log("mesh status:", JSON.stringify(mesh.status(), null, 2));
mesh.shutdown();
