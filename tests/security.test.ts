import { describe, expect, test } from "bun:test";
import { createHandshakeOffer, SecureChannel, SecureChannelResponder } from "../src/security/channel.js";
import { assertValidIdentity, fingerprintOf, generateIdentityKeyPair } from "../src/security/identity.js";
import { CryptoVerificationError, HandshakeError } from "../src/errors.js";
import type { SecureFrame } from "../src/types.js";

function establishedPair(): { a: SecureChannel; b: SecureChannel } {
  const alice = generateIdentityKeyPair();
  const bob = generateIdentityKeyPair();
  const offer = createHandshakeOffer(alice, "alice");
  const { reply, channel: bobChannel } = SecureChannelResponder.respond(bob, "bob", offer);
  const aliceChannel = SecureChannel.establish(alice, "alice", "bob", offer, reply);
  return { a: aliceChannel, b: bobChannel };
}

describe("AgentIdentityKeyPair", () => {
  test("generates matching fingerprint and passes self-validation", () => {
    const identity = generateIdentityKeyPair();
    expect(identity.fingerprint).toBe(fingerprintOf(identity.signPublicPem));
    expect(() => assertValidIdentity(identity)).not.toThrow();
  });

  test("fingerprints are unique per identity", () => {
    expect(fingerprintOf(generateIdentityKeyPair().signPublicPem)).not.toBe(
      fingerprintOf(generateIdentityKeyPair().signPublicPem),
    );
  });

  test("assertValidIdentity rejects a tampered fingerprint", () => {
    const identity = generateIdentityKeyPair();
    const tampered = { ...identity, fingerprint: "0".repeat(32) };
    expect(() => assertValidIdentity(tampered)).toThrow();
  });
});

describe("SecureChannel", () => {
  test("each side sees the other as its peer", () => {
    const { a, b } = establishedPair();
    expect(a.peerId).toBe("bob");
    expect(b.peerId).toBe("alice");
    expect(a.peerFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(b.peerFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(a.peerFingerprint).not.toBe(b.peerFingerprint);
  });

  test("seal/open round-trips a payload across both directions", () => {
    const { a, b } = establishedPair();
    const frameAtoB = a.seal({ message: "hello bob", n: 7 }, 0);
    expect(b.open(frameAtoB, 0)).toEqual({ message: "hello bob", n: 7 });
    const frameBtoA = b.seal(["reverse", 42], 0);
    expect(a.open(frameBtoA, 0)).toEqual(["reverse", 42]);
  });

  test("sequence numbers are enforced: replaying or reordering fails", () => {
    const { a, b } = establishedPair();
    const frame0 = a.seal("first", 0);
    expect(b.open(frame0, 0)).toBe("first");
    expect(() => b.open(frame0, 0)).toThrow(CryptoVerificationError);
    const frame1 = a.seal("second", 1);
    expect(() => b.open(frame1, 2)).toThrow(CryptoVerificationError);
  });

  test("tampering with ciphertext breaks authentication", () => {
    const { a, b } = establishedPair();
    const frame: SecureFrame = { ...a.seal("secret", 0), ct: Buffer.from("evil").toString("base64") };
    expect(() => b.open(frame, 0)).toThrow(CryptoVerificationError);
  });

  test("frames from a different channel are rejected", () => {
    const first = establishedPair();
    const second = establishedPair();
    const frame = first.a.seal("stolen", 0);
    expect(() => second.b.open(frame, 0)).toThrow(CryptoVerificationError);
  });

  test("handshake rejects a peer fingerprint identical to self", () => {
    const identity = generateIdentityKeyPair();
    const selfOffer = createHandshakeOffer(identity, "me");
    expect(() => SecureChannel.establish(identity, "me", "me", selfOffer, null)).toThrow(HandshakeError);
  });

  test("handshake rejects offers whose signing key does not match the fingerprint", () => {
    const alice = generateIdentityKeyPair();
    const mallory = generateIdentityKeyPair();
    const offer = { ...createHandshakeOffer(alice, "alice"), spk: mallory.signPublicPem };
    const bob = generateIdentityKeyPair();
    expect(() => SecureChannelResponder.respond(bob, "bob", offer)).toThrow();
  });

  test("handshake rejects a replayed reply with a mismatched nonce", () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const offer = createHandshakeOffer(alice, "alice");
    const first = SecureChannelResponder.respond(bob, "bob", offer);
    const forged = { ...first.reply, nonce: "different" };
    expect(() => SecureChannel.establish(alice, "alice", "bob", offer, forged)).toThrow(HandshakeError);
  });
});
