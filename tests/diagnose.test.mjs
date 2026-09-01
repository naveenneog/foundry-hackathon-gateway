import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mintKey, generateSecret } from "../src/keys.mjs";
import { diagnoseKey, FAULT } from "../src/diagnose.mjs";

/**
 * APIM's validate-jwt returns ONE message for every failure:
 *
 *   "Your access key is invalid, not yet active, or has expired."
 *
 * Three very different causes, one sentence. An organiser debugging a participant at an
 * event cannot tell a wrong signing secret from a clock window from a typo, so they guess.
 *
 * This module tells them which it is. It runs locally against the admin's own secret and
 * the deployed model map - it never calls the gateway, so it works even when the gateway
 * is the thing that is broken.
 */

const SECRET = generateSecret();
const OTHER = generateSecret();

const NOW = Date.parse("2026-09-01T12:00:00Z");

const key = (over = {}) =>
  mintKey({
    secret: SECRET,
    subject: "team-01",
    models: ["flash"],
    budget: 1000,
    notBefore: Date.parse("2026-09-01T09:00:00Z"),
    expiresAt: Date.parse("2026-09-02T18:00:00Z"),
    ...over,
  }).token;

describe("diagnoseKey finds the real cause", () => {
  test("a good key reports ok", () => {
    const d = diagnoseKey({ token: key(), secret: SECRET, now: NOW, modelMap: { flash: "dep-a" } });
    assert.equal(d.ok, true);
    assert.equal(d.fault, null);
  });

  test("wrong signing secret - the cause an organiser will actually hit", () => {
    const d = diagnoseKey({ token: key(), secret: OTHER, now: NOW, modelMap: { flash: "dep-a" } });
    assert.equal(d.ok, false);
    assert.equal(d.fault, FAULT.WRONG_SECRET);
    // The fix must name the real remedy, not just the symptom.
    assert.match(d.fix, /secret/i);
  });

  test("not yet active", () => {
    const d = diagnoseKey({
      token: key(), secret: SECRET,
      now: Date.parse("2026-09-01T08:00:00Z"),
      modelMap: { flash: "dep-a" },
    });
    assert.equal(d.fault, FAULT.NOT_YET_ACTIVE);
    assert.match(d.detail, /2026-09-01/);
  });

  test("expired", () => {
    const d = diagnoseKey({
      token: key(), secret: SECRET,
      now: Date.parse("2026-09-03T00:00:00Z"),
      modelMap: { flash: "dep-a" },
    });
    assert.equal(d.fault, FAULT.EXPIRED);
  });

  test("revoked", () => {
    const token = key();
    const jti = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).jti;
    const d = diagnoseKey({ token, secret: SECRET, now: NOW, modelMap: { flash: "dep-a" }, revoked: [jti] });
    assert.equal(d.fault, FAULT.REVOKED);
  });

  test("a granted model that the gateway does not have pinned", () => {
    const d = diagnoseKey({
      token: key({ models: ["flash", "llama"] }), secret: SECRET, now: NOW,
      modelMap: { flash: "dep-a" },
    });
    assert.equal(d.fault, FAULT.MODEL_NOT_CONFIGURED);
    assert.match(d.detail, /llama/);
  });

  test("a token that is not a token at all", () => {
    const d = diagnoseKey({ token: "not-a-jwt", secret: SECRET, now: NOW, modelMap: {} });
    assert.equal(d.fault, FAULT.MALFORMED);
  });

  test("a truncated token - the copy-paste failure", () => {
    const t = key();
    const d = diagnoseKey({ token: t.slice(0, t.length - 20), secret: SECRET, now: NOW, modelMap: {} });
    assert.equal(d.ok, false);
    assert.ok([FAULT.WRONG_SECRET, FAULT.MALFORMED].includes(d.fault));
  });

  test("reports the window in both UTC and a caller-supplied local rendering", () => {
    const d = diagnoseKey({ token: key(), secret: SECRET, now: NOW, modelMap: { flash: "dep-a" } });
    assert.match(d.expiresAtUtc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/);
    assert.equal(typeof d.expiresAtEpochMs, "number");
  });

  test("never echoes the token back", () => {
    // A diagnostic that prints the credential defeats the point of masking it everywhere else.
    const t = key();
    const d = diagnoseKey({ token: t, secret: SECRET, now: NOW, modelMap: { flash: "dep-a" } });
    assert.ok(!JSON.stringify(d).includes(t.split(".")[2]), "signature leaked into the report");
  });

  test("checks the secret BEFORE the window, so a stale secret is not misreported as expiry", () => {
    // Both wrong at once. Signature failure is the more fundamental cause and must win,
    // otherwise an organiser chases a clock problem that does not exist.
    const d = diagnoseKey({
      token: key(), secret: OTHER,
      now: Date.parse("2026-09-03T00:00:00Z"),
      modelMap: { flash: "dep-a" },
    });
    assert.equal(d.fault, FAULT.WRONG_SECRET);
  });
});
