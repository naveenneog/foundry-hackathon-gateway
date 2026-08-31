/**
 * The entitlement decision engine.
 *
 * This is the security boundary of the gateway expressed as a pure function, so it can be
 * exhaustively tested without Azure, without a network, and without a clock.
 *
 * The APIM policy is a transcription of this logic into policy expressions. Keeping the
 * canonical version here — tested — is what stops the policy quietly drifting into something
 * that permits more than it should.
 *
 * Fails closed: anything it does not positively understand is denied.
 */

export const DENY = {
  INVALID_GRANT: "invalid_grant",
  REVOKED: "revoked",
  NOT_YET_ACTIVE: "not_yet_active",
  EXPIRED: "expired",
  MODEL_NOT_PERMITTED: "model_not_permitted",
  BUDGET_EXHAUSTED: "budget_exhausted",
};

/** Human-readable, actionable messages. A participant at an event must know what to do next. */
export const DENY_MESSAGE = {
  [DENY.INVALID_GRANT]:
    "Your access token is not valid. Ask an organiser to issue you a new key.",
  [DENY.REVOKED]:
    "This key has been revoked. Ask an organiser if you think this is a mistake.",
  [DENY.NOT_YET_ACTIVE]:
    "This key is not active yet. Check the start time on your key card.",
  [DENY.EXPIRED]:
    "Your access window has ended. Keys cannot be extended after expiry.",
  [DENY.MODEL_NOT_PERMITTED]:
    "That model is not included in your key. Run GET /v1/models to see what you can use.",
  [DENY.BUDGET_EXHAUSTED]:
    "You have used your entire token budget. This budget does not reset.",
};

/**
 * HTTP status for each denial.
 *
 * BUDGET_EXHAUSTED is 403, deliberately.
 *
 * 429 was tried and reverted. It is the intuitive choice — "you hit a limit" — but every
 * OpenAI-compatible client treats 429 as RETRYABLE. The OpenAI SDK retries it (default 2x) and
 * sleeps for the exact value of Retry-After; the Vercel AI SDK, which opencode uses via
 * @ai-sdk/openai-compatible, marks it isRetryable and backs off. A one-time budget never
 * refills, so every one of those retries is guaranteed to fail.
 *
 * The mitigation made it worse rather than better: a truthful Retry-After (seconds until the key
 * expires) is a very large number, and a client that honours it simply hangs for hours.
 *
 * 403 is not retried by either SDK. It stops immediately, which is the required behaviour.
 * The "invalid API key" confusion that motivated 429 is addressed in the response body instead.
 *
 * See ADR-0004.
 */
export const DENY_STATUS = {
  [DENY.INVALID_GRANT]: 401,
  [DENY.REVOKED]: 403,
  [DENY.NOT_YET_ACTIVE]: 403,
  [DENY.EXPIRED]: 403,
  [DENY.MODEL_NOT_PERMITTED]: 403,
  [DENY.BUDGET_EXHAUSTED]: 403,
};

const deny = (reason, extra = {}) => ({
  allow: false,
  reason,
  status: DENY_STATUS[reason],
  message: DENY_MESSAGE[reason],
  ...extra,
});

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Seconds from `now` until `target`, floored at zero.
 *
 * Used to make Retry-After tell the truth. A client that respects it will not retry-storm,
 * and a client that ignores it gets the same 429 again — which is correct either way.
 */
const secondsUntil = (target, now) => Math.max(0, Math.ceil((target - now) / 1000));

/**
 * @param {object}   args
 * @param {object}   args.grant     Claims asserted by the verified token.
 * @param {string}   args.model     The model the caller asked for.
 * @param {number}   args.now       Epoch ms.
 * @param {number}   args.consumed  Tokens consumed so far by this grant.
 * @param {string[]} args.revoked   Revoked jti values.
 */
export function decide({ grant, model, now, consumed, revoked = [] }) {
  // ---- Structural validity. A grant we cannot fully parse is not a grant. ----
  if (!grant || typeof grant !== "object") return deny(DENY.INVALID_GRANT);
  if (!isFiniteNumber(grant.expiresAt)) return deny(DENY.INVALID_GRANT);
  if (!isFiniteNumber(grant.budget)) return deny(DENY.INVALID_GRANT);
  if (!isFiniteNumber(now)) return deny(DENY.INVALID_GRANT);
  if (!Array.isArray(grant.models)) return deny(DENY.INVALID_GRANT);

  // A cache miss returns undefined. Treating that as zero would hand out a fresh
  // budget every time the cache evicted, which is the one failure that must not happen.
  if (!isFiniteNumber(consumed)) return deny(DENY.INVALID_GRANT);

  // ---- Revocation first, so an emergency stop always reports as such. ----
  if (grant.jti && revoked.includes(grant.jti)) return deny(DENY.REVOKED);

  // ---- The window. notBefore inclusive, expiresAt exclusive. ----
  if (isFiniteNumber(grant.notBefore) && now < grant.notBefore) {
    // Worth advertising: the key genuinely does start working later.
    return deny(DENY.NOT_YET_ACTIVE, {
      activeFrom: grant.notBefore,
      retryAfter: secondsUntil(grant.notBefore, now),
    });
  }
  if (now >= grant.expiresAt) return deny(DENY.EXPIRED, { expiredAt: grant.expiresAt });

  // ---- The model allowlist. Exact, case-insensitive, no prefix matching. ----
  if (typeof model !== "string" || model.length === 0) {
    return deny(DENY.MODEL_NOT_PERMITTED);
  }
  const wanted = model.trim().toLowerCase();
  const permitted = grant.models.map((m) => String(m).trim().toLowerCase());
  if (!permitted.includes(wanted)) {
    return deny(DENY.MODEL_NOT_PERMITTED, { permitted });
  }

  // ---- The one-time budget. Does not reset. ----
  const remaining = Math.max(0, grant.budget - consumed);
  if (consumed >= grant.budget) {
    // Deliberately NO retryAfter. A one-time budget never refills, so advertising a retry
    // window would either invite a pointless retry loop or, worse, make a client that honours
    // Retry-After sleep for hours. 403 with no retry hint stops the agent immediately.
    return deny(DENY.BUDGET_EXHAUSTED, {
      budget: grant.budget,
      consumed,
      remaining: 0,
    });
  }

  return { allow: true, reason: null, status: 200, sub: grant.sub, model: wanted, remaining };
}
