/**
 * Product keys on chosen models (P50, ADR-0015). A key is a subscription on a product, and the
 * product's policy is what limits models and budget. So the console keeps one product per
 * (model set, monthly budget) — `pk-<hash>` — filled from the POC product policy template, and
 * shares it between keys with the same grant. The per-key budget is counted per subscription,
 * so sharing a product never shares a budget.
 */

import { createHash } from "node:crypto";
import { InputError } from "./validate.mjs";

const DEPLOYMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROUTE_API = { claude: "poc-claude", openai: "poc-openai" };
export const PROBE_API = "poc-probe";
/** The shared pool on a pk- product; each key's own monthly budget is the real limit. */
export const POOL_TOKENS = 2_000_000_000;
export const DEFAULT_TPM = 20_000;
const fail = (m) => { throw new InputError(m); };

export function packId(models, monthlyTokens, connectionId = "default") {
  const key = `${[...new Set(models)].sort().join(",")}|${monthlyTokens}${connectionId === "default" ? "" : `|${connectionId}`}`;
  return `pk-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Requested deployment names → grantable entries ({deployment, route}); one or more, all known. */
export function resolveGrant(models, grantable) {
  if (!Array.isArray(models) || models.length === 0) fail("Grant at least one model.");
  const out = [];
  for (const raw of new Set(models.map((m) => String(m).trim()))) {
    const g = grantable.find((x) => x.deployment === raw);
    if (!g) fail(`'${raw.slice(0, 64)}' is not a ready Foundry deployment.`);
    out.push(g);
  }
  return out.sort((a, b) => a.deployment.localeCompare(b.deployment));
}

export function renderPackPolicy(template, { models, keyTokens, poolTokens, tpm }) {
  for (const m of models) if (!DEPLOYMENT_RE.test(m)) fail(`Not a deployment name: ${String(m).slice(0, 64)}`);
  for (const [k, v] of Object.entries({ keyTokens, poolTokens, tpm })) if (!Number.isInteger(v) || v < 1) fail(`${k} must be a positive whole number.`);
  const xml = template.replaceAll("__MODELS__", models.join("|")).replaceAll("__KEY_TOKENS__", String(keyTokens))
    .replaceAll("__POOL_TOKENS__", String(poolTokens)).replaceAll("__TPM__", String(tpm));
  if (/__[A-Z_]+__/.test(xml.replace(/<!--[\s\S]*?-->/g, ""))) throw new Error("Product policy template has a placeholder this console does not fill.");
  return xml;
}

export function packRoutes(grant, connection) {
  const routes = connection ? { openai: connection.apiIds.productOpenai, claude: connection.apiIds.productClaude } : ROUTE_API;
  return [...new Set(grant.map((g) => routes[g.route]).filter(Boolean)), PROBE_API].sort();
}

/**
 * Create the pack if needed, then (re)apply its policy and links every time: the PUTs are
 * idempotent, and a pack left half-made by an earlier failure (no policy means no model or budget
 * limit) must not be reused as it is. APIs are linked last, so a pack without its policy is
 * unreachable.
 */
export async function ensurePack(arm, template, { grant, monthlyTokens, tpm = DEFAULT_TPM, connection }) {
  const models = grant.map((g) => g.deployment);
  const id = packId(models, monthlyTokens, connection?.id);
  const exists = Boolean(await arm.getProduct(id));
  if (!exists) {
    await arm.createProduct(id, {
      // APIM also requires distinct display names: equal models on another account/budget
      // must not collide. Keep the stable product id before the truncatable model description.
      displayName: `Key Dashboard [${id}] ${connection?.name ?? ""}: ${models.join(", ")}`.slice(0, 300),
      description: `Created by the Key Dashboard. Models: ${models.join(", ")}. ${monthlyTokens} tokens per key each calendar month (UTC).`.slice(0, 1000),
    });
  }
  await arm.setProductPolicy(id, renderPackPolicy(template, { models, keyTokens: monthlyTokens, poolTokens: POOL_TOKENS, tpm }));
  for (const api of packRoutes(grant, connection)) await arm.linkProductApi(id, api);
  return { id, created: !exists };
}
