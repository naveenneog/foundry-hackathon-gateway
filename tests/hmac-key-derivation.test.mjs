import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

import { mintKey, verifyKey, generateSecret, KeyError } from "../src/keys.mjs";

/**
 * Regression tests for the single most dangerous class of bug in this design: the minter and
 * APIM's validate-jwt deriving DIFFERENT HMAC keys from the same stored secret.
 *
 * APIM documents that a symmetric <key> is supplied "in the Base64-encoded form" — it
 * base64-DECODES the named value before using it as HMAC key material. If the minter instead
 * signs with the ASCII bytes of that same string, every signature mismatches and the gateway
 * rejects every key.
 *
 * It fails closed, so it is not exploitable — but it disables the sole authentication control,
 * and it is deployment-dependent, so it looks intermittent. These tests pin the contract.
 *
 * See ADR-0005.
 */

const SECRET = generateSecret();

describe("HMAC key derivation matches APIM's validate-jwt", () => {
  test("generateSecret produces standard, padded Base64 (not base64url)", () => {
    for (let i = 0; i < 200; i++) {
      const s = generateSecret();
      assert.match(s, /^[A-Za-z0-9+/]+={0,2}$/,
        `secret must be standard Base64 so APIM can decode it, got: ${s}`);
      assert.equal(Buffer.from(s, "base64").length, 32,
        "secret must decode to exactly 32 bytes of key material");
    }
  });

  test("generateSecret never emits base64url characters APIM cannot decode", () => {
    // The original implementation replaced + and / with - and _, which only produced a
    // decodable value about a quarter of the time. Prove that is gone.
    for (let i = 0; i < 500; i++) {
      const s = generateSecret();
      assert.ok(!s.includes("-"), `base64url '-' found in ${s}`);
      assert.ok(!s.includes("_"), `base64url '_' found in ${s}`);
    }
  });

  test("signing uses the DECODED key bytes, not the ASCII of the secret string", () => {
    const { token } = mintKey({
      secret: SECRET, subject: "t", models: ["flash"], budget: 100,
      notBefore: Date.now(), expiresAt: Date.now() + 3600_000,
    });
    const [h, p, sig] = token.split(".");
    const signingInput = `${h}.${p}`;

    const decodedKeySig = createHmac("sha256", Buffer.from(SECRET, "base64"))
      .update(signingInput).digest();
    const asciiKeySig = createHmac("sha256", SECRET).update(signingInput).digest();

    assert.equal(sig, decodedKeySig.toString("base64url"),
      "signature must be produced with the base64-DECODED key, matching APIM");
    assert.notEqual(sig, asciiKeySig.toString("base64url"),
      "signature must NOT be produced with the raw ASCII of the secret string");
  });

  test("the two derivations really are different, so this test is not vacuous", () => {
    const input = "header.payload";
    const a = createHmac("sha256", Buffer.from(SECRET, "base64")).update(input).digest("hex");
    const b = createHmac("sha256", SECRET).update(input).digest("hex");
    assert.notEqual(a, b);
  });

  test("a token verifies against a key derived exactly as APIM would derive it", () => {
    const { token } = mintKey({
      secret: SECRET, subject: "t", models: ["flash"], budget: 100,
      notBefore: Date.now(), expiresAt: Date.now() + 3600_000,
    });
    const [h, p, sig] = token.split(".");

    // Simulate APIM: base64-decode the named value, HMAC the signing input, compare.
    const apimSig = createHmac("sha256", Buffer.from(SECRET, "base64"))
      .update(`${h}.${p}`).digest().toString("base64url");

    assert.equal(sig, apimSig);
  });

  test("round trip still works with a Base64 secret", () => {
    const { token } = mintKey({
      secret: SECRET, subject: "team-9", models: ["flash", "pro"], budget: 777,
      notBefore: Date.now(), expiresAt: Date.now() + 3600_000,
    });
    const g = verifyKey(token, SECRET);
    assert.equal(g.sub, "team-9");
    assert.equal(g.budget, 777);
  });

  test("rejects a secret that is not decodable Base64 key material", () => {
    // Guards against someone 'fixing' a deployment by typing a passphrase, which would
    // silently shrink the key to a handful of bytes.
    assert.throws(() => mintKey({
      secret: "this-is-a-passphrase-not-base64-key-material!!",
      subject: "t", models: ["flash"], budget: 1,
      notBefore: Date.now(), expiresAt: Date.now() + 1000,
    }), KeyError);
  });

  test("rejects Base64 that decodes to too few bytes", () => {
    const short = randomBytes(8).toString("base64"); // 8 bytes, well under the 32-byte floor
    assert.throws(() => mintKey({
      secret: short, subject: "t", models: ["flash"], budget: 1,
      notBefore: Date.now(), expiresAt: Date.now() + 1000,
    }), KeyError);
  });
});
