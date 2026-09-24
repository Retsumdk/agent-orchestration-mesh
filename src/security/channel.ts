import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { CryptoVerificationError, HandshakeError } from "../errors.js";
import { fingerprintOf, type AgentIdentityKeyPair } from "./identity.js";
import type { SecureFrame } from "../types.js";

const HANDSHAKE_VERSION = 1 as const;

function canonical(parts: (string | number)[]): Buffer {
  return Buffer.from(parts.join("\u0000"), "utf8");
}

export interface HandshakeOffer {
  v: 1;
  from: string;
  /** Sender's signing-key fingerprint (the session is addressed by it). */
  fp: string;
  /** Sender's Ed25519 public key (SPKI PEM) so the peer can verify `sig`. */
  spk: string;
  /** Sender's X25519 public key (SPKI DER, base64). */
  dh: string;
  nonce: string;
  sig: string;
}

export interface HandshakeReply {
  v: 1;
  from: string;
  fp: string;
  spk: string;
  dh: string;
  nonce: string;
  sig: string;
}

export interface SecureChannelKeys {
  sharedKey: Buffer;
  sendIvBase: Buffer;
  recvIvBase: Buffer;
  selfId: string;
  selfFingerprint: string;
  selfSignPrivatePem: string;
  peerId: string;
  peerFingerprint: string;
  peerSignPublicPem: string;
}

/**
 * Application-layer secure channel between two agents.
 *
 * Guarantees, per direction, once the handshake completes:
 * - mutual authentication: both sides sign the transcript with their Ed25519 identity;
 * - forward-secret session keys: HKDF-SHA256 over an X25519 Diffie-Hellman secret;
 * - confidentiality + integrity: AES-256-GCM with per-sequence IVs;
 * - non-repudiation of origin: each frame is also Ed25519-signed by its sender.
 */
export class SecureChannel {
  /** Highest successfully opened receive sequence; older frames are treated as replays. */
  private recvSequence = -1;

  private constructor(private readonly keys: SecureChannelKeys) {}

  get peerFingerprint(): string {
    return this.keys.peerFingerprint;
  }

  get peerId(): string {
    return this.keys.peerId;
  }

  /**
   * Derives session keys from a completed handshake exchange. Both sides call
   * this with the same offer/reply pair; role ordering (who sends on which IV
   * base) is derived deterministically from the two fingerprints.
   */
  static establish(
    self: AgentIdentityKeyPair,
    selfId: string,
    peerId: string,
    offer: HandshakeOffer,
    reply: HandshakeReply | null,
  ): SecureChannel {
    if (offer.v !== HANDSHAKE_VERSION) throw new HandshakeError("Unsupported handshake version");

    const selfFingerprint = fingerprintOf(self.signPublicPem);
    if (fingerprintOf(offer.spk) !== offer.fp) {
      throw new CryptoVerificationError("Offer signing key does not match its fingerprint");
    }

    // The offer signature is always over the offer transcript, verified with the key it carries.
    const offerTranscript = canonical([offer.from, offer.fp, offer.spk, offer.dh, offer.nonce]);
    if (!verify(null, offerTranscript, createPublicKey(offer.spk), Buffer.from(offer.sig, "base64"))) {
      throw new CryptoVerificationError("Handshake offer signature verification failed");
    }

    let peerSignPublicPem = offer.spk;
    let peerDhBase64 = offer.dh;
    let peerFingerprint = offer.fp;

    if (reply) {
      if (reply.v !== HANDSHAKE_VERSION) throw new HandshakeError("Unsupported handshake version");
      if (reply.nonce !== offer.nonce) throw new HandshakeError("Handshake reply did not echo the offered nonce");
      if (fingerprintOf(reply.spk) !== reply.fp) {
        throw new CryptoVerificationError("Reply signing key does not match its fingerprint");
      }
      const replyTranscript = canonical([reply.from, reply.fp, reply.spk, reply.dh, offer.nonce]);
      if (!verify(null, replyTranscript, createPublicKey(reply.spk), Buffer.from(reply.sig, "base64"))) {
        throw new CryptoVerificationError("Handshake reply signature verification failed");
      }
      peerSignPublicPem = reply.spk;
      peerDhBase64 = reply.dh;
      peerFingerprint = reply.fp;
    }

    if (peerFingerprint === selfFingerprint) {
      throw new HandshakeError("Handshake peer fingerprint equals the local fingerprint");
    }

    const sharedSecret = exchange(self, peerDhBase64);
    const salt = Buffer.from("agent-orchestration-mesh/handshake-v1");
    const sharedKey = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from("data-key"), 32));
    const ivA = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from("iv-base-a"), 12));
    const ivB = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from("iv-base-b"), 12));
    const selfIsA = Buffer.compare(Buffer.from(selfFingerprint, "hex"), Buffer.from(peerFingerprint, "hex")) < 0;

    return new SecureChannel({
      sharedKey,
      sendIvBase: selfIsA ? ivA : ivB,
      recvIvBase: selfIsA ? ivB : ivA,
      selfId,
      selfFingerprint,
      selfSignPrivatePem: self.signPrivatePem,
      peerId,
      peerFingerprint,
      peerSignPublicPem,
    });
  }

  /** Encrypts a plaintext payload into a transferable, signed SecureFrame. */
  seal(plaintext: unknown, sequence: number): SecureFrame {
    const iv = counterIv(this.keys.sendIvBase, sequence);
    const cipher = createCipheriv("aes-256-gcm", this.keys.sharedKey, iv);
    const payload = Buffer.from(JSON.stringify(plaintext ?? null), "utf8");
    const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    const sig = sign(
      null,
      canonical([this.keys.selfId, this.keys.selfFingerprint, iv.toString("base64"), ct.toString("base64"), tag.toString("base64"), sequence]),
      createPrivateKey(this.keys.selfSignPrivatePem),
    );
    return {
      v: 1,
      from: this.keys.selfId,
      fp: this.keys.selfFingerprint,
      epk: "",
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: tag.toString("base64"),
      sig: sig.toString("base64"),
      at: Date.now(),
    };
  }

  /** Verifies the sender's Ed25519 signature, then authenticated-decrypts. */
  open(frame: SecureFrame, sequence: number): unknown {
    if (sequence <= this.recvSequence) {
      throw new CryptoVerificationError("Frame sequence is stale (possible replay)");
    }
    if (frame.fp !== this.keys.peerFingerprint) {
      throw new CryptoVerificationError("Frame was not sealed for this channel");
    }
    if (frame.from !== this.keys.peerId) {
      throw new CryptoVerificationError("Frame origin does not match the handshake peer");
    }
    const iv = Buffer.from(frame.iv, "base64");
    if (!iv.equals(counterIv(this.keys.recvIvBase, sequence))) {
      throw new CryptoVerificationError("Frame sequence number is not the expected next counter value");
    }
    const ct = Buffer.from(frame.ct, "base64");
    const tag = Buffer.from(frame.tag, "base64");
    const sigOk = verify(
      null,
      canonical([frame.from, frame.fp, frame.iv, frame.ct, frame.tag, sequence]),
      createPublicKey(this.keys.peerSignPublicPem),
      Buffer.from(frame.sig, "base64"),
    );
    if (!sigOk) {
      throw new CryptoVerificationError("Frame signature verification failed");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.keys.sharedKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
      this.recvSequence = sequence;
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new CryptoVerificationError("Frame failed authenticated decryption");
    }
  }
}

/** Nonce-structured IV: the first 8 bytes are the HKDF base, the last 4 encode the sequence. */
function counterIv(base: Buffer, sequence: number): Buffer {
  const iv = Buffer.from(base);
  iv.writeUInt32BE(sequence >>> 0, 8);
  return iv;
}

function exchange(self: AgentIdentityKeyPair, peerDhBase64: string): Buffer {
  try {
    const peerKey = createPublicKey({ key: Buffer.from(peerDhBase64, "base64"), format: "der", type: "spki" });
    const privateKey = createPrivateKey(self.dhPrivatePem);
    const shared = diffieHellman({ privateKey, publicKey: peerKey });
    if (shared.length === 0) throw new Error("empty shared secret");
    return shared;
  } catch (error) {
    throw new HandshakeError("Key exchange failed", { cause: error });
  }
}

export class SecureChannelResponder {
  /** Responder side: verify the offer, produce our reply, and open our channel. */
  static respond(
    self: AgentIdentityKeyPair,
    selfId: string,
    offer: HandshakeOffer,
  ): { reply: HandshakeReply; channel: SecureChannel } {
    const reply = createHandshakeReply(self, selfId, offer);
    // The responder's peer is the offer sender; the reply is our own material.
    const channel = SecureChannel.establish(self, selfId, offer.from, offer, null);
    return { reply, channel };
  }
}

export function createHandshakeOffer(self: AgentIdentityKeyPair, from: string): HandshakeOffer {
  const nonce = randomBytes(16).toString("base64");
  const fp = fingerprintOf(self.signPublicPem);
  const sig = sign(null, canonical([from, fp, self.signPublicPem, self.dhPublicBase64, nonce]), createPrivateKey(self.signPrivatePem)).toString("base64");
  return { v: HANDSHAKE_VERSION, from, fp, spk: self.signPublicPem, dh: self.dhPublicBase64, nonce, sig };
}

export function createHandshakeReply(self: AgentIdentityKeyPair, from: string, offer: HandshakeOffer): HandshakeReply {
  if (offer.v !== HANDSHAKE_VERSION) throw new HandshakeError("Unsupported handshake version");
  const fp = fingerprintOf(self.signPublicPem);
  const sig = sign(null, canonical([from, fp, self.signPublicPem, self.dhPublicBase64, offer.nonce]), createPrivateKey(self.signPrivatePem)).toString("base64");
  return { v: HANDSHAKE_VERSION, from, fp, spk: self.signPublicPem, dh: self.dhPublicBase64, nonce: offer.nonce, sig };
}

export function sessionIdOf(offer: HandshakeOffer, reply: HandshakeReply): string {
  return createHash("sha256").update(`${offer.nonce}:${reply.nonce}`).digest("hex").slice(0, 24);
}
