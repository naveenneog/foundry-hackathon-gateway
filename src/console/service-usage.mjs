/** Console service: usage per key from the gateway's workspace (P52). Composed into createService. */

import { buildUsageQuery, aggregateUsage, resolvePeriod, usageGrid } from "./usage.mjs";
import { chargebackReport, CHARGEBACK_KINDS } from "./chargeback.mjs";
import { InputError } from "./validate.mjs";

const CACHE_MS = 60_000;
const CACHE_MAX = 64;
const HOUR_MS = 3_600_000;
const NO_SOURCE = "Usage is not configured: liteAPIM has no Log Analytics workspace.";
const iso = (ms) => new Date(ms).toISOString();

export function usageApi({ vault, clock, owns, kindOf, visibleKey, ServiceError, requireAdmin, audit, defaultFoundry }) {
  let source = null;
  const cache = new Map();
  const setUsageSource = (la) => { source = la; cache.clear(); };

  const keyIdOf = (s) => (kindOf(s) === "jwt" ? s.tags?.jti : s.tags?.subscription);

  /** `days`, or `from` and `to` (P59); 400 for anything else. */
  function period(query) {
    try {
      return resolvePeriod(query, clock());
    } catch (e) {
      if (e instanceof InputError) throw new ServiceError(400, e.message);
      throw e;
    }
  }

  /** What an answer covers: the period, its window (a range ending today ends now) and its bucket size. */
  const covers = (p, now) => ({
    days: p.days, ...(p.range ? { range: p.range } : {}),
    from: iso(p.start), to: iso(p.range ? Math.min(p.end - 1, now) : now), bucket: p.bucket.ms === HOUR_MS ? "hour" : "day",
  });

  /** Rows are the same for every viewer; only the filtering differs, so they are cached once per kind, period and key. */
  async function rowsFor(kind, p, keyId) {
    const key = `${kind}|${p.key}|${keyId ?? ""}`;
    const hit = cache.get(key);
    if (hit && clock() - hit.at < CACHE_MS) return hit.rows;
    const timespan = p.range ? `${iso(p.start)}/${iso(p.end)}` : `P${p.days}D`;
    const rows = await source.query(buildUsageQuery({ kind, period: p, keyId }), { timespan });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: clock(), rows });
    return rows;
  }

  const empty = (p, note) => {
    const now = clock();
    return { ...covers(p, now), ...aggregateUsage([], { keys: new Map(), includeUnknown: false, grid: usageGrid(p, now) }), note };
  };

  async function usage(actor, { kind, days, from, to } = {}) {
    requireAdmin(actor);
    if (!["jwt", "product"].includes(kind)) throw new ServiceError(400, "kind must be jwt or product.");
    const p = period({ days, from, to });
    if (!source) return { kind, ...empty(p, NO_SOURCE) };
    const keys = new Map();
    for (const s of await vault.listSecrets()) {
      if (kindOf(s) === kind && owns(actor, s) && keyIdOf(s)) keys.set(keyIdOf(s), { name: s.name, owner: s.tags.owner ?? null, label: s.tags.label });
    }
    const rows = await rowsFor(kind, p, undefined);
    const now = clock();
    return { kind, ...covers(p, now), ...aggregateUsage(rows, { keys, includeUnknown: actor?.role === "admin", grid: usageGrid(p, now) }) };
  }

  async function keyUsage(actor, name, { days, from, to } = {}) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    const p = period({ days, from, to });
    const kind = kindOf(s);
    if (!source) return { name, kind, ...empty(p, NO_SOURCE) };
    const id = keyIdOf(s);
    if (!id) return { name, kind, ...empty(p, "This key has no id the gateway reports usage under.") };
    const rows = await rowsFor(kind, p, id);
    const keys = new Map([[id, { name, owner: s.tags.owner ?? null, label: s.tags.label }]]);
    const now = clock();
    const u = aggregateUsage(rows, { keys, includeUnknown: false, grid: usageGrid(p, now) });
    return { name, kind, ...covers(p, now), total: u.total, series: u.series, byModel: u.byModel };
  }

  /**
   * The chargeback CSV for a period (ADR-0020): one row per key and model with usage, for both
   * kinds or one, from the same cached rows the usage views read. Admin only; audit-logged.
   */
  async function chargeback(actor, { kind = "all", days, from, to } = {}) {
    requireAdmin(actor);
    const kinds = typeof kind === "string" ? CHARGEBACK_KINDS.get(kind) : undefined;
    if (!kinds) throw new ServiceError(400, "kind must be all, jwt or product.");
    const p = period({ days, from, to });
    if (!source) throw new ServiceError(409, NO_SOURCE);
    const secrets = await vault.listSecrets();
    const sources = [];
    for (const k of kinds) sources.push({ kind: k, rows: await rowsFor(k, p, undefined) });
    const report = chargebackReport(sources, { secrets, kindOf, keyIdOf, period: p, now: clock(), defaultFoundry });
    audit(actor, "export-chargeback", { from: report.from, to: report.to, kind, rows: report.rows });
    return { filename: `chargeback-${report.from}-${report.to}.csv`, csv: report.csv, rows: report.rows, totals: report.totals,
      from: report.from, to: report.to, kind };
  }

  return { setUsageSource, usage, keyUsage, chargeback };
}
