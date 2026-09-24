import { createHash, generateKeyPairSync } from "node:crypto";
import { ValidationError } from "../errors.js";

export interface AgentIdentityKeyPair {
  /** Ed25519 private key (PKCS#8 PEM). Signs handshakes and secure frames. Keep secret. */
  signPrivatePem: string;
  /** Ed25519 public key (SPKI PEM). Shared with the mesh. */
  signPublicPem: string;
  /** X25519 private key (PKCS#8 PEM). Used for the key-agreement exchange. Keep secret. */
  dhPrivatePem: string;
  /** X25519 public key (SPKI DER, base64). Shared with the mesh. */
  dhPublicBase64: string;
  /** Stable identifier for this identity: first 16 bytes of SHA-256 over the signing key, hex. */
  fingerprint: string;
}

/** Generates a full agent identity: Ed25519 for signatures, X25519 for key agreement. */
export function generateIdentityKeyPair(): AgentIdentityKeyPair {
  const signing = generateKeyPairSync("ed25519");
  const agreement = generateKeyPairSync("x25519");
  const signPublicPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    signPrivatePem: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signPublicPem,
    dhPrivatePem: agreement.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    dhPublicBase64: agreement.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    fingerprint: fingerprintOf(signPublicPem),
  };
}

export function fingerprintOf(signPublicPem: string): string {
  return createHash("sha256").update(signPublicPem).digest("hex").slice(0, 32);
}

/** Round-trip self-test: a malformed identity must never enter the mesh. */
export function assertValidIdentity(identity: AgentIdentityKeyPair): void {
  if (fingerprintOf(identity.signPublicPem) !== identity.fingerprint) {
    throw new ValidationError("Identity fingerprint does not match its signing public key");
  }
  if (!identity.dhPublicBase64 || typeof identity.dhPrivatePem !== "string") {
    throw new ValidationError("Identity is missing its key-agreement material");
  }
}
