// liteAPIM — Foundry accounts (ADR-0017): discovery, selection by ARM resource id, the request
// bodies that name an account, the Foundry each key is bound to, and what attaching and the
// connection test do and do not prove. Pure: no DOM and no network, so
// tests/console-foundry-ui.test.mjs imports it under Node.

import { modelOptions } from "./lib.js";

export const DEFAULT_CONNECTION = "default";
export const KIND_LABEL = Object.freeze({ AIServices: "Foundry (AI Services)", OpenAI: "Azure OpenAI" });
/** Every cached read that lists accounts, deployments, pins or models: what Refresh and Attach drop. */
export const FOUNDRY_CACHES = Object.freeze(["/api/foundries", "/api/models", "/api/config"]);

const MAX_DETAIL = 1000;
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const str = (v) => String(v ?? "").trim();
const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

/** ARM resource ids compare case-insensitively; an empty id matches nothing. */
export function sameAccount(a, b) {
  const x = str(a).toLowerCase();
  return x !== "" && x === str(b).toLowerCase();
}

function idOf(account) {
  if (!str(account?.id)) throw new Error("Choose a Foundry first.");
  return account.id;
}

// ── Discovery and selection ─────────────────────────────────────────────────

/**
 * Accounts from GET /api/foundries: the default first, then by name. Ids are kept exactly as the
 * server sent them; an account the dashboard could not read keeps its error and stays listed.
 */
export function accountsOf(data) {
  const defaultId = str(data?.defaultFoundryId);
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(data?.accounts) ? data.accounts : []) {
    const id = a && typeof a === "object" ? str(a.id) : "";
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const connectionId = str(a.connectionId) || null;
    out.push({
      id,
      name: str(a.name) || id.split("/").filter(Boolean).at(-1),
      resourceGroup: str(a.resourceGroup),
      location: str(a.location),
      kind: str(a.kind),
      connected: a.connected === true,
      connectionId,
      error: str(a.error) || null,
      deployments: Number.isInteger(a.deployments) && a.deployments >= 0 ? a.deployments : null,
      setupCommand: textOrNull(a.setupCommand),
      networkCommand: textOrNull(a.networkCommand),
      isDefault: connectionId === DEFAULT_CONNECTION || sameAccount(id, defaultId),
    });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** The account with `wanted`'s id; else `fallbackId`'s; else the default; else the first. Never by name. */
export function pickAccount(accounts, wanted, fallbackId) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list.find((a) => sameAccount(a.id, wanted)) ?? list.find((a) => sameAccount(a.id, fallbackId))
    ?? list.find((a) => a.isDefault) ?? list[0] ?? null;
}

/** Keys are issued only for attached accounts. */
export const connectedAccounts = (accounts) => (Array.isArray(accounts) ? accounts : []).filter((a) => a.connected);

/** Accounts this API Management does not route to yet, unreadable ones included: what Connect another Foundry lists. */
export const unconnectedAccounts = (accounts) => (Array.isArray(accounts) ? accounts : []).filter((a) => !a.connected);

/** Connected, not attached, or unreadable, with why. A connected account keeps its routes even when a read fails. */
export function accountStatus(a) {
  if (a?.connected) {
    return {
      state: "connected", label: "Connected", tone: a.error ? "warn" : "ok",
      detail: a.error ?? (a.isDefault ? "Uses the gateway's original routes." : `Has its own gateway routes (connection ${a.connectionId ?? "not reported"}).`),
    };
  }
  if (a?.error) return { state: "error", label: "Unreadable", tone: "bad", detail: a.error };
  return { state: "available", label: "Not attached", tone: "grey", detail: "Its deployments can be browsed. Attach it before pinning models or issuing keys." };
}

export function summarize(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const count = (state) => list.filter((a) => accountStatus(a).state === state).length;
  const known = list.filter((a) => a.deployments !== null);
  return {
    total: list.length, connected: count("connected"), available: count("available"), unreadable: count("error"),
    deployments: known.reduce((sum, a) => sum + a.deployments, 0), deploymentsKnown: known.length === list.length,
  };
}

/** The connected list's count: Foundries connected to this API Management and their deployments, nothing else. */
export function connectedLine(accounts) {
  const s = summarize(connectedAccounts(accounts));
  if (!s.total) return "";
  return `${s.total} ${s.total === 1 ? "Foundry" : "Foundries"} connected to this API Management · ${plural(s.deployments, "deployment")}${s.deploymentsKnown ? "" : " in those that could be read"}.`;
}

/** Connect another Foundry's count: accounts not connected, which can be attached or not read, and how many a search shows. */
export function candidatesLine(accounts, shown) {
  const s = summarize(unconnectedAccounts(accounts));
  if (!s.total) return "";
  const parts = [s.available && `${s.available} can be attached`, s.unreadable && `${s.unreadable} unreadable`].filter(Boolean);
  const filtered = Number.isInteger(shown) && shown < s.total ? ` · ${shown} shown` : "";
  return `${plural(s.total, "account")} not connected: ${parts.join(", ")}${filtered}.`;
}

/** Every search term must appear in the account's name, resource group, region, kind, connection or state. */
export function matchesAccount(a, query) {
  const terms = str(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [a?.name, a?.resourceGroup, a?.location, a?.kind, KIND_LABEL[a?.kind], a?.connectionId, accountStatus(a).label].filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// ── Requests that name an account ───────────────────────────────────────────

export const attachBody = (account) => ({ foundryId: idOf(account) });
export const pinBody = (account, d, alias) => ({ foundryId: idOf(account), alias, deployment: d.deployment, route: d.route ?? undefined });
export const unpinBody = (account, alias, route) => ({ foundryId: idOf(account), alias, route });
export const testBody = (account, choice) => ({ foundryId: idOf(account), alias: choice.alias, route: choice.route });

/** An issue request for the chosen Foundry; refuses to build one without an attached account. */
export function withFoundry(body, account) {
  if (!str(account?.id)) throw new Error("Choose the Foundry these keys are for.");
  if (!account.connected) throw new Error(`Attach ${account.name} before issuing keys for it.`);
  return { ...body, foundryId: account.id };
}

/**
 * Why a config or model list is not `account`'s, or null. One naming another account is refused;
 * one without a foundryId (an older server) is accepted for the default account only.
 */
export function foreignAnswer(response, account) {
  if (!str(account?.id)) return "Choose a Foundry first.";
  if (!response || typeof response !== "object") return `The server sent no answer for ${account.name}.`;
  const id = str(response.foundryId);
  if (id ? sameAccount(id, account.id) : account.isDefault) return null;
  return `The server answered for another Foundry, not ${account.name}. Reload the Foundry list and try again.`;
}

/**
 * The Foundry chosen on an issue form. Choosing drops the model options; an answer for an earlier
 * choice, or one describing another account, is refused, so a key never mixes accounts.
 */
export function issueChoice(kind) {
  let account = null;
  let options = null;
  let turn = 0;
  return {
    get account() { return account; },
    get options() { return options; },
    choose(next) {
      account = next ?? null;
      options = null;
      turn += 1;
      return turn;
    },
    isCurrent: (ticket) => ticket === turn,
    accept(ticket, config) {
      if (ticket !== turn || !account) return { stale: true };
      const error = foreignAnswer(config, account);
      if (error) return { error };
      options = modelOptions(kind, config);
      return { options };
    },
    body: (settings) => withFoundry(settings, account),
  };
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** The Foundry a key belongs to. Keys issued before ADR-0017 carry no metadata and use the default. */
export function keyFoundry(k) {
  const connectionId = str(k?.foundry) || DEFAULT_CONNECTION;
  const isDefault = connectionId === DEFAULT_CONNECTION;
  return { connectionId, isDefault, name: str(k?.foundryName) || (isDefault ? "Default Foundry" : connectionId) };
}

export function accountForKey(accounts, k) {
  const { connectionId, isDefault } = keyFoundry(k);
  const list = Array.isArray(accounts) ? accounts : [];
  return list.find((a) => a.connectionId === connectionId) ?? (isDefault ? list.find((a) => a.isDefault) : null) ?? null;
}

// ── Deployments ─────────────────────────────────────────────────────────────

/** Every search term must appear in the deployment, model, version, route, format, state or a pinned alias. */
export function matchesDeployment(d, query) {
  const terms = str(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const aliases = Array.isArray(d?.pinnedAs) ? d.pinnedAs.map((p) => p?.alias) : [];
  const hay = [d?.deployment, d?.model, d?.version, d?.route, d?.wire, d?.format, d?.state, ...aliases].filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Why a deployment's Pin is disabled, or null. The server's canPin decides; nothing is hidden. */
export function pinBlockReason(d, connected) {
  if (!connected) return "Attach this Foundry first.";
  if (d?.canPin?.allowed === true) return null;
  return str(d?.canPin?.reason) || "This deployment cannot be pinned.";
}

export function deploymentState(d) {
  if (d?.ready === true) return { label: "ready", tone: "ok", reason: null };
  const state = str(d?.state);
  return {
    label: (state || "not ready").toLowerCase(),
    tone: /fail|cancel/i.test(state) ? "bad" : "warn",
    reason: state ? `Azure reports ${state}; it serves no requests until it succeeds.` : "Azure reports no provisioning state, so it is treated as not ready.",
  };
}

/** Why a deployment has no gateway route (an unknown or unsupported format), or null. */
export function routeReason(d) {
  if (d?.route) return null;
  return str(d?.canPin?.reason) || `The gateway does not know ${str(d?.deployment) || "this deployment"}'s request format, so it has no route for it.`;
}

// ── Attaching and the connection test ───────────────────────────────────────

const NOT_PROOF = "Attaching does not grant the gateway permission to call this account or open private networking. "
  + "Run the setup command, pin an alias, then test the connection.";

/** What the UI says after Attach: the server's message, and always that access is not verified yet. */
export function attachSummary(result) {
  const message = str(result?.message);
  return {
    tone: "warn",
    title: "Routing configured. Access is not verified yet.",
    lines: [...(message ? [message] : []), NOT_PROOF],
    setupCommand: textOrNull(result?.setupCommand),
    networkCommand: textOrNull(result?.networkCommand),
    gatewayUrl: str(result?.gatewayUrl) || null,
  };
}

/**
 * An account's operator commands, each from the first answer that has one (attach, then the model
 * list, then discovery): `setup` grants the gateway's inference role; `network`, optional, creates
 * the account's private endpoint and DNS record in the gateway's network. Shown for copying only.
 */
export function commandsFor(...answers) {
  const pick = (key) => answers.map((a) => textOrNull(a?.[key])).find(Boolean) ?? null;
  return { setup: pick("setupCommand"), network: pick("networkCommand") };
}

/** The pinned aliases the test can call, or why it cannot run yet. */
export function testAvailability(account, pins) {
  if (!account?.connected) return { allowed: false, reason: "Attach this Foundry first.", choices: [] };
  const choices = ["openai", "claude"].flatMap((route) => (Array.isArray(pins?.[route]) ? pins[route] : [])
    .filter((p) => ALIAS_RE.test(str(p?.alias)))
    .map((p) => ({ value: `${route}:${str(p.alias)}`, route, alias: str(p.alias), deployment: str(p.deployment) })));
  return choices.length ? { allowed: true, reason: null, choices }
    : { allowed: false, reason: "Pin an alias on this Foundry first: the test calls it.", choices };
}

export function parseChoice(value) {
  const m = /^(openai|claude):(.+)$/.exec(str(value));
  return m && ALIAS_RE.test(m[2]) ? { route: m[1], alias: m[2] } : null;
}

const GUIDE = {
  role: "The gateway's managed identity may lack an inference role on this account. Copy the setup command, have someone who can assign roles on the account run it in PowerShell, wait a few minutes, then test again.",
  publicOff: "A 403 can also mean the request reached the account's public endpoint while its public network access is off: check the private DNS records API Management resolves.",
  network: "API Management could not reach the account. With a private endpoint, the account must be reachable from API Management's virtual network, with its private DNS zone linked to that network. With a firewall, allow that network.",
  dns: "API Management resolved the account through a private DNS zone linked to its virtual network that has no record for this account, so the zone shadows the public name. Create a private endpoint and DNS record for the account in the gateway's virtual network, then test again.",
  missing: "The alias or this Foundry's gateway route was not found. Refresh, check that the alias is still pinned on this Foundry, or attach it again to repair its routes.",
  attach: "Attach this Foundry and pin an alias before testing.",
  busy: "The deployment is rate limited or out of quota. Wait a minute, or raise its quota in Foundry.",
  other: "The gateway refused the request; the detail above says why.",
};

/** What to check after a failed test. */
export function testGuidance(result) {
  if (result?.ok === true) return [];
  if (result?.code === "backend_dns") return [GUIDE.dns];
  const status = Number(result?.status);
  if (status === 401 || status === 403) return [GUIDE.role, GUIDE.publicOff];
  if (status === 404) return [GUIDE.missing];
  if (status === 409) return [GUIDE.attach];
  if (status === 429) return [GUIDE.busy];
  if (!Number.isFinite(status) || status === 0 || status >= 500) return [GUIDE.network, GUIDE.role];
  return [GUIDE.other];
}

/** Whether a failed test points at the network path: DNS shadowing, no answer, or an unreachable backend. */
function suggestsNetwork(result) {
  if (result?.ok === true) return false;
  if (result?.code === "backend_dns") return true;
  const status = Number(result?.status);
  return !Number.isFinite(status) || status === 0 || (status >= 502 && status <= 504);
}

export function testSummary(result, alias) {
  const status = Number(result?.status);
  const code = Number.isFinite(status) && status > 0 ? ` (HTTP ${status})` : "";
  const detail = str(result?.detail).slice(0, MAX_DETAIL);
  const lines = detail ? [detail] : [];
  if (result?.ok === true) return { tone: "ok", title: `${alias} answered through the gateway${code}.`, lines, guidance: [], suggestNetwork: false };
  return { tone: "bad", title: `The test request failed${code}.`, lines, guidance: testGuidance(result), suggestNetwork: suggestsNetwork(result) };
}
