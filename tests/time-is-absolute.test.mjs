import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mintKey, verifyKey, generateSecret } from "../src/keys.mjs";
import { decide, DENY } from "../src/entitlement.mjs";

/**
 * Time is absolute, everywhere in this system.
 *
 * A JWT `exp`/`nbf` is a NumericDate: seconds since the Unix epoch. There is no timezone
 * field in a JWT timestamp, so the same instant produces the same claim no matter where the
 * issuing machine is or how the caller wrote the date down.
 *
 * Enforcement is server-side: APIM's validate-jwt checks the claims against the gateway's
 * clock. Verified empirically against the live gateway - an expired key and a not-yet-active
 * key both come back with the GATEWAY's error text, which means opencode forwarded the
 * request rather than judging the key against the participant's own clock.
 *
 * The practical consequence, and the reason these tests exist: a participant with a wrong
 * laptop clock, or in any timezone, gets exactly the same answer. Only the DISPLAY of the
 * expiry needs to be timezone-aware, and that is a human problem, not a protocol one.
 */

const SECRET = generateSecret();

const base = (over = {}) => ({
  secret: SECRET,
  subject: "team-01",
  models: ["flash"],
  budget: 1000,
  notBefore: Date.parse("2026-09-01T09:00:00Z"),
  expiresAt: Date.parse("2026-09-02T18:00:00Z"),
  ...over,
});

const claimsOf = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

describe("token times are absolute, not local", () => {
  test("the same instant written three ways produces one exp value", () => {
    // Z, a +05:30 offset, and the raw epoch all name the same moment.
    const sameInstant = [
      Date.parse("2026-09-02T18:00:00Z"),
      Date.parse("2026-09-02T23:30:00+05:30"),
      1788372000000,
    ];
    // Guard the fixture itself: if these are not one instant, the test below proves nothing.
    assert.equal(new Set(sameInstant).size, 1, "fixture error - these are not the same instant");

    const exps = sameInstant.map((expiresAt) => claimsOf(mintKey(base({ expiresAt })).token).exp);
    assert.equal(new Set(exps).size, 1, `expected one exp, got ${JSON.stringify(exps)}`);
  });

  test("exp is epoch SECONDS, not milliseconds", () => {
    // A 13-digit value would be read by APIM as a date ~50,000 years out, so the key would
    // never expire. This is the single most dangerous unit error in the project.
    const { exp } = claimsOf(mintKey(base()).token);
    assert.equal(String(exp).length, 10, `exp=${exp} is not epoch seconds`);
    assert.equal(exp, Math.floor(Date.parse("2026-09-02T18:00:00Z") / 1000));
  });

  test("nbf is epoch SECONDS too", () => {
    const { nbf } = claimsOf(mintKey(base()).token);
    assert.equal(String(nbf).length, 10);
    assert.equal(nbf, Math.floor(Date.parse("2026-09-01T09:00:00Z") / 1000));
  });

  test("a verified grant names the same instant it was minted with", () => {
    const g = verifyKey(mintKey(base()).token, SECRET);
    assert.equal(g.expiresAt, Date.parse("2026-09-02T18:00:00Z"));
    assert.equal(g.notBefore, Date.parse("2026-09-01T09:00:00Z"));
  });

  test("the decision is the same whichever timezone the caller expresses 'now' in", () => {
    const g = verifyKey(mintKey(base()).token, SECRET);
    // 2026-09-03T00:00:00Z is past expiry. Same moment, three notations.
    for (const now of [
      Date.parse("2026-09-03T00:00:00Z"),
      Date.parse("2026-09-03T05:30:00+05:30"),
      Date.parse("2026-09-02T17:00:00-07:00"),
    ]) {
      const r = decide({ grant: g, model: "flash", now, consumed: 0, revoked: [] });
      assert.equal(r.reason, DENY.EXPIRED, `now=${new Date(now).toISOString()}`);
    }
  });

  test("a key issued at a half-hour offset still expires on the exact second", () => {
    // India is UTC+05:30. A naive local-time conversion would land 30 minutes out.
    const expiresAt = Date.parse("2026-09-02T23:30:00+05:30");
    const g = verifyKey(mintKey(base({ expiresAt })).token, SECRET);
    assert.equal(g.expiresAt, Date.parse("2026-09-02T18:00:00Z"));

    const oneSecondBefore = g.expiresAt - 1000;
    assert.equal(
      decide({ grant: g, model: "flash", now: oneSecondBefore, consumed: 0, revoked: [] }).allow,
      true
    );
    assert.equal(
      decide({ grant: g, model: "flash", now: g.expiresAt, consumed: 0, revoked: [] }).reason,
      DENY.EXPIRED
    );
  });
});
