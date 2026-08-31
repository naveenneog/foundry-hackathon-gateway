import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decide, DENY } from "../src/entitlement.mjs";

/**
 * Budget exhaustion must STOP the client, not invite a retry.
 *
 * 429 was tried and reverted. Both SDKs that matter here treat 429 as retryable:
 *   - OpenAI SDK: retries 408/409/429/5xx, and on 429 "will sleep for the exact time given in
 *     Retry-After before retrying". It does NOT retry 400/401/403/404/422.
 *   - Vercel AI SDK (opencode, via @ai-sdk/openai-compatible): 429 -> isRetryable: true,
 *     retried with exponential backoff.
 *
 * A one-time budget never refills, so every retry is guaranteed to fail. And a truthful
 * Retry-After is a large number, so a client that honours it hangs for hours — strictly worse
 * than failing fast.
 *
 * These tests pin 403-with-no-retry-hint so nobody "improves" it back to 429. See ADR-0004.
 */

const grant = (over = {}) => ({
  sub: "team-01",
  jti: "k_aaa",
  models: ["flash"],
  notBefore: Date.parse("2026-09-01T09:00:00Z"),
  expiresAt: Date.parse("2026-09-02T18:00:00Z"),
  budget: 1000,
  ...over,
});

const AT = (iso) => Date.parse(iso);
const DURING = AT("2026-09-01T12:00:00Z");

describe("budget exhaustion stops the client", () => {
  test("returns 403, which neither SDK retries", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 1000, revoked: [] });
    assert.equal(r.allow, false);
    assert.equal(r.reason, DENY.BUDGET_EXHAUSTED);
    assert.equal(r.status, 403);
  });

  test("does NOT return 429 — that would make opencode retry a permanently dead key", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 1000, revoked: [] });
    assert.notEqual(r.status, 429);
  });

  test("carries no Retry-After — honouring one would hang the client for hours", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 1000, revoked: [] });
    assert.equal(r.retryAfter, undefined);
  });

  test("the body says budget_exhausted, so 403 is never mistaken for an auth failure", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 1000, revoked: [] });
    assert.equal(r.reason, "budget_exhausted");
    assert.match(r.message, /does not reset/i);
  });

  test("reports zero remaining", () => {
    const r = decide({ grant: grant(), model: "flash", now: DURING, consumed: 5000, revoked: [] });
    assert.equal(r.remaining, 0);
  });
});

describe("every terminal denial stops rather than invites a retry", () => {
  const terminal = [
    ["expired", { now: AT("2026-09-03T00:00:00Z"), model: "flash", consumed: 0, revoked: [] }, DENY.EXPIRED],
    ["model not permitted", { now: DURING, model: "pro", consumed: 0, revoked: [] }, DENY.MODEL_NOT_PERMITTED],
    ["revoked", { now: DURING, model: "flash", consumed: 0, revoked: ["k_aaa"] }, DENY.REVOKED],
    ["budget exhausted", { now: DURING, model: "flash", consumed: 9999, revoked: [] }, DENY.BUDGET_EXHAUSTED],
  ];

  for (const [name, args, expectedReason] of terminal) {
    test(`${name} -> 403 with no retry hint`, () => {
      const r = decide({ grant: grant(), ...args });
      assert.equal(r.reason, expectedReason);
      assert.equal(r.status, 403, `${name} must be 403 so clients stop`);
      assert.equal(r.retryAfter, undefined, `${name} must not invite a retry`);
    });
  }

  test("invalid_grant is 401 — a genuine authentication failure, also not retried", () => {
    const r = decide({ grant: null, model: "flash", now: DURING, consumed: 0, revoked: [] });
    assert.equal(r.status, 401);
    assert.equal(r.retryAfter, undefined);
  });
});

describe("not_yet_active is the one case where a retry genuinely helps", () => {
  test("returns 403 but does advertise when the key starts working", () => {
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-01T08:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.reason, DENY.NOT_YET_ACTIVE);
    assert.equal(r.status, 403);
    assert.equal(r.retryAfter, 3600, "one hour until the window opens");
  });

  test("403 still means the SDK will not auto-retry — the hint is for the human", () => {
    // Deliberate: we surface the wait time in the message and header for the participant,
    // but keep 403 so the agent loop does not spin.
    const r = decide({
      grant: grant(), model: "flash",
      now: AT("2026-09-01T08:00:00Z"), consumed: 0, revoked: [],
    });
    assert.equal(r.status, 403);
  });
});
