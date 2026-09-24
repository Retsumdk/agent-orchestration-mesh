import { describe, expect, test } from "bun:test";
import {
  SecureChannel,
  SecureChannelResponder,
  createHandshakeOffer,
  createHandshakeReply,
  sessionIdOf,
} from "../src/security/channel";
import { generateIdentityKeyPair } from "../src/security/identity";
import { CryptoVerificationError, HandshakeError } from "../src/errors";
import type { SecureFrame } from "../src/types";

function establishedPair(): { alice: SecureChannel; bob: SecureChannel } {
  const aliceKeys = generateIdentityKeyPair();
  const bobKeys = generateIdentityKeyPair();
  const offer = createHandshakeOffer(aliceKeys, "alice");
  const bobSide = SecureChannelResponder.respond(bobKeys, "bob", offer);
  const alice = SecureChannel.establish(aliceKeys, "alice", "bob", offer, bobSide.reply);
  return { alice, bob: bobSide.channel };
}

describe("SecureChannel", () => {
  test("both sides derive the same session id from the handshake", () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();
    const offer = createHandshakeOffer(aliceKeys, "alice");
    const reply = createHandshakeReply(bobKeys, "bob", offer);
    expect(sessionIdOf(offer, reply)).toMatch(/^[0-9a-f]{24}$/);
  });

  test("seal/open round-trips a payload between both directions", () => {
    const { alice, bob } = establishedPair();
    const frame = alice.seal({ msg: "hello", n: 7 }, 0);
    expect(bob.open(frame, 0)).toEqual({ msg: "hello", n: 7 });
    const replyFrame = bob.seal({ ok: true }, 0);
    expect(alice.open(replyFrame, 0)).toEqual({ ok: true });
    expect(alice.peerId).toBe("bob");
    expect(bob.peerId).toBe("alice");
  });

  test("per-sequence IVs make each frame unique and reject replays", () => {
    const { alice, bob } = establishedPair();
    const f0 = alice.seal("one", 0);
    const f1 = alice.seal("two", 1);
    expect(f0.iv).not.toBe(f1.iv);
    expect(bob.open(f0, 0)).toBe("one");
    expect(bob.open(f1, 1)).toBe("two");
    expect(() => bob.open(f0, 0)).toThrow(CryptoVerificationError);
  });

  test("tampered ciphertext or tag fails authenticated decryption", () => {
    const { alice, bob } = establishedPair();
    const frame: SecureFrame = { ...alice.seal("secret", 0) };
    frame.ct = Buffer.from("tampered").toString("base64");
    expect(() => bob.open(frame, 0)).toThrow(CryptoVerificationError);
    const frame2 = { ...alice.seal("secret", 0) };
    frame2.tag = Buffer.from(frame2.tag, "base64").toString("base64") === frame2.tag ? Buffer.from("00000000", "hex").toString("base64") : frame2.tag;
    expect(() => bob.open(frame2, 0)).toThrow(CryptoVerificationError);
  });

  test("forged sender signatures are rejected even with valid ciphertext", () => {
    const { alice, bob } = establishedPair();
    const frame = { ...alice.seal("secret", 0) };
    frame.from = "mallory";
    expect(() => bob.open(frame, 0)).toThrow(CryptoVerificationError);
  });

  test("a channel refuses frames sealed for a different session", () => {
    const { bob } = establishedPair();
    const carolKeys = generateIdentityKeyPair();
    const daveKeys = generateIdentityKeyPair();
    const carolOffer = createHandshakeOffer(carolKeys, "carol");
    const carolDave = SecureChannelResponder.respond(daveKeys, "dave", carolOffer);
    const carol = SecureChannel.establish(carolKeys, "carol", "dave", carolOffer, carolDave.reply);
    const crossFrame = carol.seal("hi", 0);
    expect(() => bob.open(crossFrame, 0)).toThrow(CryptoVerificationError);
  });

  test("handshake replies must echo the offered nonce", () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();
    const offer = createHandshakeOffer(aliceKeys, "alice");
    const reply = createHandshakeReply(bobKeys, "bob", offer);
    const forged = { ...reply, nonce: "different-nonce" };
    expect(() => SecureChannel.establish(aliceKeys, "alice", "bob", offer, forged)).toThrow(HandshakeError);
  });

  test("an offer signed by a key that does not match its fingerprint is rejected", () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();
    const offer = createHandshakeOffer(aliceKeys, "alice");
    offer.fp = fingerprintOf(bobKeys.signPublicPem);
    expect(() => SecureChannelResponder.respond(bobKeys, "bob", offer)).toThrow(CryptoVerificationError);
  });

  test("large structured payloads survive the round-trip", () => {
    const { alice, bob } = establishedPair();
    const payload = { rows: Array.from({ length: 1_000 }, (_, i) => ({ i, sq: i * i, s: `row-${i}` })) };
    expect(bob.open(alice.seal(payload, 0), 0)).toEqual(payload);
  });
});

function fingerprintOf(pem: string): string {
  return createHashSha256(pem);
}

import { createHash } from "node:crypto";
function createHashSha256(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}
