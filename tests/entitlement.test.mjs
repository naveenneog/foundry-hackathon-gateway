import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decide, DENY } from "../src/entitlement.mjs";

// A grant is what the signed token asserts about a participant.
const grant = (over = {}) => ({
  sub: "team-01",
  jti: "k_aaa",
  models: ["flash"],
  notBefore: Date.parse("2026-09-01T09:00:00Z"),
  expiresAt: Date.parse("2026-09-02T18:00:00Z"),
  budget: 1_000_000,
  ...over,
});

const AT = (iso) => Date.parse(iso);
const DURING = AT("2026-09-01T12:00:00Z");

describe("entitlement.decide — the time window", () => {
  test("allows a request inside the window", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, true);
  });

  test("denies before the window opens", () => {
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-01T08:59:59Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.NOT_YET_ACTIVE);
  });

  test("allows exactly at notBefore (boundary is inclusive)", () => {
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-01T09:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, true);
  });

  test("denies after the window closes", () => {
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-02T18:00:01Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.EXPIRED);
  });

  test("denies exactly at expiresAt (boundary is exclusive — fail closed)", () => {
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-02T18:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.EXPIRED);
  });
});

describe("entitlement.decide — the model allowlist", () => {
  test("denies a model not on the grant", () => {
    const r = decide({ grant: grant({ models: ["flash"] }), model: "pro", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.MODEL_NOT_PERMITTED);
  });

  test("allows any model that is on the grant", () => {
    const g = grant({ models: ["flash", "pro"] });
    assert.equal(decide({ grant: g, model: "pro", now: DURING, consumed: 0, revoked: [] }).allow, true);
    assert.equal(decide({ grant: g, model: "flash", now: DURING, consumed: 0, revoked: [] }).allow, true);
  });

  test("model matching is case-insensitive", () => {
    const r = decide({ grant: grant({ models: ["flash"] }), model: "FLASH", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, true);
  });

  test("denies an empty or missing model", () => {
    for (const model of ["", null, undefined]) {
      const r = decide({ grant: grant(), model, now: DURING, consumed: 0, revoked: [] });
      assert.equal(r.allow, false, `model=${JSON.stringify(model)} must be denied`);
      assert.equal(r.reason, DENY.MODEL_NOT_PERMITTED);
    }
  });

  test("a grant with no models denies everything", () => {
    const r = decide({ grant: grant({ models: [] }), model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.MODEL_NOT_PERMITTED);
  });

  test("does not allow a prefix to partially match a model name", () => {
    // "flash" must not satisfy a request for "flash-preview"
    const r = decide({ grant: grant({ models: ["flash"] }), model: "flash-preview", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
  });
});

describe("entitlement.decide — the one-time budget", () => {
  test("allows while under budget", () => {
    const r = decide({ grant: grant({ budget: 1000 }), model: "flash", now: DURING, consumed: 999, revoked: [] });
    assert.equal(r.allow, true);
  });

  test("denies when consumption exactly equals the budget", () => {
    const r = decide({ grant: grant({ budget: 1000 }), model: "flash", now: DURING, consumed: 1000, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.BUDGET_EXHAUSTED);
  });

  test("denies when consumption has overshot the budget", () => {
    const r = decide({ grant: grant({ budget: 1000 }), model: "flash", now: DURING, consumed: 4321, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.BUDGET_EXHAUSTED);
  });

  test("reports remaining budget when allowed", () => {
    const r = decide({ grant: grant({ budget: 1000 }), model: "flash", now: DURING, consumed: 250, revoked: [] });
    assert.equal(r.remaining, 750);
  });

  test("never reports negative remaining budget", () => {
    const r = decide({ grant: grant({ budget: 1000 }), model: "flash", now: DURING, consumed: 5000, revoked: [] });
    assert.equal(r.remaining, 0);
  });
});

describe("entitlement.decide — revocation", () => {
  test("denies a revoked jti", () => {
    const r = decide({ grant: grant({ jti: "k_bad" }), model: "flash", now: DURING, consumed: 0, revoked: ["k_bad"] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.REVOKED);
  });

  test("ignores a denylist that does not contain this jti", () => {
    const r = decide({ grant: grant({ jti: "k_aaa" }), model: "flash", now: DURING, consumed: 0, revoked: ["k_zzz"] });
    assert.equal(r.allow, true);
  });

  test("does not let one jti partially match another", () => {
    // "k_a" must not revoke "k_aaa"
    const r = decide({ grant: grant({ jti: "k_aaa" }), model: "flash", now: DURING, consumed: 0, revoked: ["k_a"] });
    assert.equal(r.allow, true);
  });
});

describe("entitlement.decide — fails closed", () => {
  test("denies a missing grant", () => {
    const r = decide({ grant: null, model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.INVALID_GRANT);
  });

  test("denies a grant with no expiry", () => {
    const r = decide({ grant: grant({ expiresAt: undefined }), model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.INVALID_GRANT);
  });

  test("denies a grant with a non-numeric budget", () => {
    const r = decide({ grant: grant({ budget: "lots" }), model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.INVALID_GRANT);
  });

  test("denies when consumed is unknown (cache miss must not grant a free budget)", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: undefined, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.INVALID_GRANT);
  });

  test("revocation is checked before expiry, so a revoked key never looks merely expired", () => {
    const r = decide({
      grant: grant({ jti: "k_bad" }), model: "flash",
      now: AT("2030-01-01T00:00:00Z"), consumed: 0, revoked: ["k_bad"],
    });
    assert.equal(r.reason, DENY.REVOKED);
  });
});
