/**
 * Explain why a key is being rejected.
 *
 * APIM's validate-jwt returns one message for every failure:
 *
 *   "Your access key is invalid, not yet active, or has expired."
 *
 * Three unrelated causes, one sentence. That is fine for a participant - they cannot fix
 * any of them - but it strands the organiser, who has to guess between a stale signing
 * secret, a clock window, a revocation and a typo.
 *
 * This runs entirely locally against the admin's own secret and the deployed model map.
 * It never calls the gateway, so it still works when the gateway is what is broken.
 */

import { verifyKey, decodeUnsafe, KeyError } from "./keys.mjs";
import { resolveAlias } from "./models.mjs";

export const FAULT = {
  MALFORMED: "malformed",
  WRONG_SECRET: "wrong_secret",
  NOT_YET_ACTIVE: "not_yet_active",
  EXPIRED: "expired",
  REVOKED: "revoked",
  MODEL_NOT_CONFIGURED: "model_not_configured",
};

const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

/**
 * @param {object}   args
 * @param {string}   args.token      The key as the participant has it.
 * @param {string}   args.secret     The admin's current signing secret.
 * @param {number}   args.now        Epoch ms.
 * @param {object}   args.modelMap   alias -> deployment, as deployed.
 * @param {string[]} args.revoked    Revoked jti values.
 */
export function diagnoseKey({ token, secret, now, modelMap = {}, revoked = [] }) {
  const report = {
    ok: false, fault: null, detail: "", fix: "",
    subject: null, keyId: null, models: [], budget: null,
    notBeforeUtc: null, expiresAtUtc: null, expiresAtEpochMs: null,
  };

  // ---- Is it even shaped like a key? ----
  let claims;
  try {
    claims = decodeUnsafe(token);
  } catch {
    report.fault = FAULT.MALFORMED;
    report.detail = "This does not look like a key at all.";
    report.fix = "Check the whole value was copied. A key is one long line with two dots in it.";
    return report;
  }

  // ---- Signature. Checked FIRST and reported first, even if the window is also wrong. ----
  // A stale secret and an expired key look identical from the gateway. If we reported the
  // window first, an organiser would chase a clock problem that does not exist.
  let grant;
  try {
    grant = verifyKey(token, secret);
  } catch (err) {
    report.fault = err instanceof KeyError && /signature/i.test(err.message)
      ? FAULT.WRONG_SECRET
      : FAULT.MALFORMED;
    report.subject = claims.sub ?? null;
    report.keyId = claims.jti ?? null;
    report.detail =
      report.fault === FAULT.WRONG_SECRET
        ? "This key was signed with a different secret than the one on this machine."
        : `The key is not readable: ${err.message}`;
    report.fix =
      report.fault === FAULT.WRONG_SECRET
        ? "The gateway was most likely deployed from another machine, which generated its own " +
          "secret. Copy that machine's .gateway/secret.txt here, or redeploy with this one - " +
          "redeploying invalidates every key minted elsewhere."
        : "Issue a new key.";
    return report;
  }

  Object.assign(report, {
    subject: grant.sub,
    keyId: grant.jti,
    models: grant.models,
    budget: grant.budget,
    notBeforeUtc: Number.isFinite(grant.notBefore) ? utc(grant.notBefore) : null,
    expiresAtUtc: utc(grant.expiresAt),
    expiresAtEpochMs: grant.expiresAt,
  });

  // ---- Revoked ----
  if (grant.jti && revoked.includes(grant.jti)) {
    report.fault = FAULT.REVOKED;
    report.detail = `Key ${grant.jti} is on the revocation list.`;
    report.fix = "Issue a new key, or remove this one from the denylist.";
    return report;
  }

  // ---- The window ----
  if (Number.isFinite(grant.notBefore) && now < grant.notBefore) {
    report.fault = FAULT.NOT_YET_ACTIVE;
    report.detail = `Not active until ${utc(grant.notBefore)}. It is ${utc(now)} now.`;
    report.fix = "Wait, or issue a key that starts immediately.";
    return report;
  }
  if (now >= grant.expiresAt) {
    report.fault = FAULT.EXPIRED;
    report.detail = `Expired at ${utc(grant.expiresAt)}. It is ${utc(now)} now.`;
    report.fix = "Issue a new key. Keys cannot be extended.";
    return report;
  }

  // ---- Every granted alias must exist in the deployed map ----
  const orphans = grant.models.filter((m) => resolveAlias(modelMap, m) === null);
  if (orphans.length > 0) {
    report.fault = FAULT.MODEL_NOT_CONFIGURED;
    report.detail =
      `The key grants ${orphans.join(", ")}, which the gateway does not have pinned. ` +
      `Pinned: ${Object.keys(modelMap).sort().join(", ") || "(none)"}.`;
    report.fix = "Pin the missing alias, or issue a key without it.";
    return report;
  }

  report.ok = true;
  report.detail = "This key is valid right now.";
  return report;
}
