/**
 * Model pinning for the console: which Foundry deployments the gateway serves, under which alias,
 * on which route. The rules are the scripts' (scripts/Models.ps1): the route is the deployment's
 * own (canPin), an alias is unique across both routes, Claude Code's bare slot names are refused,
 * and at least one pin remains. Serialisation is src/models.mjs. ADR-0015.
 */

import { canPin, isReservedClaudeAlias, suggestAlias } from "../foundry.mjs";
import { parseModelMap, buildModelMap, EMPTY_MAP } from "../models.mjs";
import { InputError } from "./validate.mjs";

export const ROUTES = ["openai", "claude"];
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const fail = (m) => { throw new InputError(m); };

/** Named-value strings → `{ openai: [{alias, deployment}], claude: [...] }`. */
export function pinsFromMaps(maps) {
  const out = {};
  for (const r of ROUTES) {
    const map = parseModelMap(maps?.[r]);
    out[r] = Object.keys(map).map((alias) => ({ alias, deployment: map[alias] }));
  }
  return out;
}

/** Pins → named-value strings; a route with no pins is written as EMPTY_MAP. */
export function mapsFromPins(pins) {
  const out = {};
  for (const r of ROUTES) out[r] = pins[r]?.length ? buildModelMap(pins[r]) : EMPTY_MAP;
  return out;
}

export function applyPin(pins, catalogue, { alias, deployment, route } = {}) {
  const name = String(alias ?? "").trim().toLowerCase();
  if (!ALIAS_RE.test(name)) fail("Alias: 1–64 lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.");
  const entry = catalogue.find((e) => e.deployment === deployment);
  if (!entry) fail(`'${deployment}' is not deployed in the Foundry account.`);
  const target = route ?? entry.route ?? "openai";
  const verdict = canPin(entry, target);
  if (!verdict.allowed) fail(verdict.reason);
  if (target === "claude" && isReservedClaudeAlias(name)) {
    fail(`'${name}' is a Claude Code model slot name; Claude Code rewrites it before the request leaves the machine. Use a versioned name such as '${suggestAlias(deployment)}'.`);
  }
  if (ROUTES.some((r) => pins[r].some((p) => p.alias === name))) fail(`Alias '${name}' is already pinned. Unpin it first.`);
  return { ...pins, [target]: [...pins[target], { alias: name, deployment: entry.deployment }] };
}

export function applyUnpin(pins, { alias, route } = {}) {
  if (!ROUTES.includes(route)) fail("Route must be openai or claude.");
  const name = String(alias ?? "").trim().toLowerCase();
  if (!pins[route].some((p) => p.alias === name)) fail(`'${name}' is not pinned on the ${route} route.`);
  const next = { ...pins, [route]: pins[route].filter((p) => p.alias !== name) };
  if (ROUTES.every((r) => next[r].length === 0)) fail("At least one model must stay pinned.");
  return next;
}

/** Catalogue entries with where each is pinned, whether it can be, and an alias to offer. */
export function describeDeployments(catalogue, pins) {
  return catalogue.map((e) => ({
    account: e.account, deployment: e.deployment, model: e.model, version: e.version, format: e.format,
    wire: e.wire, route: e.route, state: e.state, ready: e.ready,
    suggestedAlias: suggestAlias(e.deployment),
    pinnedAs: ROUTES.flatMap((r) => pins[r].filter((p) => p.deployment === e.deployment).map((p) => ({ alias: p.alias, route: r }))),
    canPin: canPin(e, e.route ?? "openai"),
  }));
}
