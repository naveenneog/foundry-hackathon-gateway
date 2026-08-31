import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mintKey, verifyKey, decodeUnsafe, KeyError } from "../src/keys.mjs";

// Signing secrets are Base64-encoded key material, not passphrases — APIM Base64-decodes the
// <key> named value, so mintKey/verifyKey must too. See ADR-0005. These decode to 40 bytes,
// comfortably over the 32-byte floor.
const SECRET = "dGVzdC1zaWduaW5nLWtleS1kby1ub3QtdXNlLWluLWFuZ2VyLTAwMDE=";
const OTHER_SECRET = "YS1jb21wbGV0ZWx5LWRpZmZlcmVudC10ZXN0LWtleS0wMDAwMDAwMDI=";

const ISSUER = "foundry-hackathon-gateway";
const AUDIENCE = "hackathon-gateway";

const baseOpts = () => ({
  secret: SECRET,
  subject: "team-01",
  models: ["flash"],
  budget: 1_000_000,
  notBefore: Date.parse("2026-09-01T09:00:00Z"),
  expiresAt: Date.parse("2026-09-02T18:00:00Z"),
});

describe("keys.mintKey", () => {
  test("produces a three-part compact JWS", () => {
    const { token } = mintKey(baseOpts());
    assert.equal(token.split(".").length, 3);
  });

  test("returns the jti so the key can later be revoked", () => {
    const { jti } = mintKey(baseOpts());
    assert.match(jti, /^k_[0-9a-f]{16}$/);
  });

  test("gives every key a unique jti", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(mintKey(baseOpts()).jti);
    assert.equal(seen.size, 200);
  });

  test("embeds the entitlement in the claims", () => {
    const { token } = mintKey(baseOpts());
    const claims = decodeUnsafe(token);
    assert.equal(claims.sub, "team-01");
    assert.equal(claims.models, "flash");
    assert.equal(claims.budget, 1_000_000);
    assert.equal(claims.iss, ISSUER);
    assert.equal(claims.aud, AUDIENCE);
  });

  test("writes nbf and exp as epoch SECONDS, per RFC 7519", () => {
    const { token } = mintKey(baseOpts());
    const c = decodeUnsafe(token);
    assert.equal(c.nbf, Math.floor(Date.parse("2026-09-01T09:00:00Z") / 1000));
    assert.equal(c.exp, Math.floor(Date.parse("2026-09-02T18:00:00Z") / 1000));
  });

  test("joins multiple models with a comma", () => {
    const { token } = mintKey({ ...baseOpts(), models: ["flash", "pro"] });
    assert.equal(decodeUnsafe(token).models, "flash,pro");
  });

  test("never embeds the signing secret in the token", () => {
    const { token } = mintKey(baseOpts());
    assert.ok(!token.includes(SECRET));
    assert.ok(!JSON.stringify(decodeUnsafe(token)).includes(SECRET));
  });

  describe("input validation", () => {
    test("rejects a missing or short secret", () => {
      assert.throws(() => mintKey({ ...baseOpts(), secret: "" }), KeyError);
      assert.throws(() => mintKey({ ...baseOpts(), secret: "dG9vc2hvcnQ=" }), KeyError);
    });

    test("rejects a passphrase masquerading as key material", () => {
      // Guards the ADR-0005 failure mode: 'fixing' a broken deployment by typing a phrase
      // would silently shrink the HMAC key and diverge from what APIM derives.
      assert.throws(() => mintKey({ ...baseOpts(), secret: "correct-horse-battery-staple-and-more!" }), KeyError);
    });

    test("rejects an empty subject", () => {
      assert.throws(() => mintKey({ ...baseOpts(), subject: "" }), KeyError);
    });

    test("rejects an empty model list", () => {
      assert.throws(() => mintKey({ ...baseOpts(), models: [] }), KeyError);
    });

    test("rejects a non-positive budget", () => {
      assert.throws(() => mintKey({ ...baseOpts(), budget: 0 }), KeyError);
      assert.throws(() => mintKey({ ...baseOpts(), budget: -5 }), KeyError);
    });

    test("rejects a window that ends before it starts", () => {
      assert.throws(() => mintKey({
        ...baseOpts(),
        notBefore: Date.parse("2026-09-02T00:00:00Z"),
        expiresAt: Date.parse("2026-09-01T00:00:00Z"),
      }), KeyError);
    });
  });
});

describe("keys.verifyKey", () => {
  test("accepts a token it just minted", () => {
    const { token } = mintKey(baseOpts());
    const grant = verifyKey(token, SECRET);
    assert.equal(grant.sub, "team-01");
    assert.deepEqual(grant.models, ["flash"]);
    assert.equal(grant.budget, 1_000_000);
  });

  test("converts nbf/exp back into epoch MILLISECONDS for the decision engine", () => {
    const { token } = mintKey(baseOpts());
    const grant = verifyKey(token, SECRET);
    assert.equal(grant.notBefore, Date.parse("2026-09-01T09:00:00Z"));
    assert.equal(grant.expiresAt, Date.parse("2026-09-02T18:00:00Z"));
  });

  test("splits the models claim back into an array", () => {
    const { token } = mintKey({ ...baseOpts(), models: ["flash", "pro"] });
    assert.deepEqual(verifyKey(token, SECRET).models, ["flash", "pro"]);
  });

  test("rejects a token signed with a different secret", () => {
    const { token } = mintKey(baseOpts());
    assert.throws(() => verifyKey(token, OTHER_SECRET), KeyError);
  });

  test("rejects a tampered payload", () => {
    const { token } = mintKey({ ...baseOpts(), budget: 1000 });
    const [h, p, s] = token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.budget = 999_999_999; // help yourself to more budget
    const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
    assert.throws(() => verifyKey(`${h}.${forged}.${s}`, SECRET), KeyError);
  });

  test("rejects a tampered model allowlist", () => {
    const { token } = mintKey({ ...baseOpts(), models: ["flash"] });
    const [h, p, s] = token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.models = "flash,pro"; // grant yourself the expensive model
    const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
    assert.throws(() => verifyKey(`${h}.${forged}.${s}`, SECRET), KeyError);
  });

  test("rejects the alg:none downgrade attack", () => {
    const { token } = mintKey(baseOpts());
    const [, p] = token.split(".");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    assert.throws(() => verifyKey(`${noneHeader}.${p}.`, SECRET), KeyError);
  });

  test("rejects an unexpected algorithm in the header", () => {
    const { token } = mintKey(baseOpts());
    const [, p, s] = token.split(".");
    const rsHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    assert.throws(() => verifyKey(`${rsHeader}.${p}.${s}`, SECRET), KeyError);
  });

  test("rejects structurally malformed input", () => {
    for (const bad of ["", "a.b", "a.b.c.d", "not-a-token", null, undefined, 42]) {
      assert.throws(() => verifyKey(bad, SECRET), KeyError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test("rejects a token for the wrong audience", () => {
    const { token } = mintKey({ ...baseOpts(), audience: "some-other-gateway" });
    assert.throws(() => verifyKey(token, SECRET), KeyError);
  });

  test("does NOT enforce expiry itself — that is the decision engine's job", () => {
    // Separation of concerns: verifyKey proves authenticity, decide() applies policy.
    // A long-expired token must still verify, so the caller can report "expired"
    // rather than a confusing "invalid signature".
    const { token } = mintKey({
      ...baseOpts(),
      notBefore: Date.parse("2020-01-01T00:00:00Z"),
      expiresAt: Date.parse("2020-01-02T00:00:00Z"),
    });
    const grant = verifyKey(token, SECRET);
    assert.equal(grant.sub, "team-01");
  });
});

describe("keys — round trip into the decision engine", () => {
  test("a minted key produces a grant the engine accepts", async () => {
    const { decide } = await import("../src/entitlement.mjs");
    const { token } = mintKey(baseOpts());
    const grant = verifyKey(token, SECRET);
    const r = decide({
      grant, model: "flash",
      now: Date.parse("2026-09-01T12:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, true);
  });

  test("a minted key is refused for a model it does not carry", async () => {
    const { decide, DENY } = await import("../src/entitlement.mjs");
    const { token } = mintKey({ ...baseOpts(), models: ["flash"] });
    const grant = verifyKey(token, SECRET);
    const r = decide({
      grant, model: "pro",
      now: Date.parse("2026-09-01T12:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.MODEL_NOT_PERMITTED);
  });
});
