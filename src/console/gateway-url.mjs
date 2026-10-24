/**
 * The gateway URL in everything the dashboard hands out (P59, ADR-0019). An admin may replace the
 * configured API Management URL (GATEWAY_URL) with a custom domain, but only a hostname that ARM
 * lists as a gateway (Proxy) hostname of this API Management, because keys are sent there. The
 * setting is a Key Vault secret; each replica caches its answer for 30 seconds and checks the
 * hostname with ARM again whenever it reads the setting again. The dashboard never sends a request
 * to the admin-provided URL: requests it makes itself use serverUrl(), the configured URL.
 */

import { InputError } from "./validate.mjs";

export const GATEWAY_URL_SECRET = "console-gateway-url";
export const GATEWAY_URL_TTL_MS = 30_000;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ORIGIN_RE = new RegExp(`^https://((?:${LABEL}\\.)+${LABEL})(?::443)?/?$`);
const RULES = "Enter https:// and a host name only, for example https://ai.contoso.com: no path, query, user name, port other than 443, IP address or wildcard.";

/** `https://<hostname>`, lowercased, from an admin's input; InputError for anything else. */
export function parseGatewayOrigin(value) {
  const host = ORIGIN_RE.exec(typeof value === "string" ? value.trim().toLowerCase() : "")?.[1];
  // The URL standard reads a host whose last label is a number (decimal, or 0x hexadecimal) as IPv4.
  if (!host || host.length > 253 || /^(?:0x[0-9a-f]*|[0-9]+)$/.test(host.split(".").at(-1))) throw new InputError(RULES);
  let parsed = null;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    // Refused below, like any other host the URL standard does not take as it is.
  }
  if (parsed?.hostname !== host) throw new InputError(RULES);
  return `https://${host}`;
}

/** The gateway (Proxy) hostnames in an API Management service, lowercased; a wildcard is not an address. */
export function gatewayHostnames(service) {
  return (Array.isArray(service?.hostnameConfigurations) ? service.hostnameConfigurations : [])
    .filter((h) => String(h?.type).toLowerCase() === "proxy" && typeof h.hostName === "string" && !h.hostName.includes("*"))
    .map((h) => h.hostName.toLowerCase());
}

export function gatewayUrlApi({ apimUrl, vault, arm, clock, audit, requireAdmin, ServiceError, ttlMs = GATEWAY_URL_TTL_MS }) {
  const apimHost = new URL(apimUrl).host;
  let cache = null;
  let pending = null;
  // Every answer put in the cache bumps the generation, after its own reads and writes, so a read
  // that started before it (and may have read the old setting) can no longer overwrite it.
  let generation = 0;
  const keep = (e) => { generation++; cache = e; return e; };

  /** The stored setting. `url` is null when it is unset, reset or not a valid origin (`invalid`). */
  async function stored() {
    const s = await vault.getSecret(GATEWAY_URL_SECRET);
    if (!s) return { url: null, invalid: false, updatedBy: null, updatedAt: null };
    const meta = { updatedBy: s.tags?.updatedBy ?? null, updatedAt: s.tags?.updatedAt ?? null };
    try {
      const url = JSON.parse(s.value)?.url;
      return { url: url === null ? null : parseGatewayOrigin(url), invalid: false, ...meta };
    } catch {
      return { url: null, invalid: true, ...meta };
    }
  }

  const entry = (s, hosts) => {
    const verified = s.url ? hosts.includes(new URL(s.url).host) : null;
    return { at: clock(), url: s.url && verified ? s.url : apimUrl, stored: s, verified, hosts };
  };

  async function refresh() {
    const g = generation;
    const s = await stored();
    const e = entry(s, s.url ? gatewayHostnames(await arm.getService()) : null);
    if (g === generation) cache = e;
    return e;
  }

  /** The gateway origin to hand out: the custom domain while ARM still lists it, else the configured URL. */
  async function effectiveGatewayUrl() {
    if (cache && clock() - cache.at < ttlMs) return cache.url;
    pending ??= refresh().finally(() => { pending = null; });
    return (await pending).url;
  }

  const view = (e) => ({
    apimUrl, customUrl: e.stored.url, effectiveUrl: e.url, verified: e.verified,
    ...(e.stored.url && e.verified === false ? { problem: `${new URL(e.stored.url).host} is no longer a gateway hostname of this API Management, so keys use the API Management URL. Add the custom domain to API Management again, or reset.` } : {}),
    ...(e.stored.invalid ? { problem: "The stored gateway URL is not a valid https origin, so keys use the API Management URL. Save a custom domain again, or reset." } : {}),
    updatedBy: e.stored.updatedBy, updatedAt: e.stored.updatedAt,
    candidates: e.hosts ? e.hosts.filter((h) => h !== apimHost).map((h) => `https://${h}`) : null,
    propagationSeconds: ttlMs / 1000,
  });

  async function write(actor, url) {
    const updatedAt = new Date(clock()).toISOString();
    await vault.setSecret(GATEWAY_URL_SECRET, JSON.stringify({ url }), { contentType: "application/json", tags: { kind: "gateway-url", updatedBy: actor.name, updatedAt } });
    return { url, invalid: false, updatedBy: actor.name, updatedAt };
  }

  async function status(actor) {
    requireAdmin(actor);
    const g = ++generation;
    const [s, service] = await Promise.all([stored(), arm.getService()]);
    const e = entry(s, gatewayHostnames(service));
    if (g === generation) cache = e;
    return view(e);
  }

  async function set(actor, body) {
    requireAdmin(actor);
    let url;
    try {
      url = parseGatewayOrigin(body?.url);
    } catch (e) {
      if (e instanceof InputError) throw new ServiceError(400, e.message);
      throw e;
    }
    const host = new URL(url).host;
    const hosts = gatewayHostnames(await arm.getService());
    if (!hosts.includes(host)) {
      throw new ServiceError(400, `${host} is not a gateway hostname of this API Management. Add it as a custom domain of the Gateway endpoint in API Management first (Azure portal: the API Management instance, Custom domains), then save it here.`);
    }
    const before = await stored();
    const changed = before.url !== url;
    const s = changed ? await write(actor, url) : before;
    if (changed) audit(actor, "set-gateway-url", { from: before.url ?? apimUrl, to: url });
    return { changed, ...view(keep(entry(s, hosts))) };
  }

  /** Back to the configured URL. Writes {"url":null}: a soft-deleted secret could not be written again (U54). */
  async function reset(actor) {
    requireAdmin(actor);
    const before = await stored();
    const changed = before.url !== null || before.invalid;
    const s = changed ? await write(actor, null) : before;
    if (changed) audit(actor, "reset-gateway-url", { from: before.url, to: apimUrl });
    return { changed, ...view(keep(entry(s, cache?.hosts ?? null))) };
  }

  return { effectiveGatewayUrl, serverUrl: () => apimUrl, status, set, reset };
}
