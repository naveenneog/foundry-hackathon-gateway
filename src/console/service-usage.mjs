/** Console service: usage per key from the gateway's workspace (P52). Composed into createService. */

import { buildUsageQuery, aggregateUsage, bucketFor, PERIODS } from "./usage.mjs";

const CACHE_MS = 60_000;
const CACHE_MAX = 64;

export function usageApi({ vault, clock, owns, kindOf, visibleKey, ServiceError }) {
  let source = null;
  const cache = new Map();
  const setUsageSource = (la) => { source = la; cache.clear(); };

  const keyIdOf = (s) => (kindOf(s) === "jwt" ? s.tags?.jti : s.tags?.subscription);

  function period(days) {
    const d = Number(days ?? 7);
    if (!PERIODS.includes(d)) throw new ServiceError(400, `Period must be ${PERIODS.join(", ")} days.`);
    return d;
  }

  /** Rows are the same for every viewer; only the filtering differs, so they are cached once. */
  async function rowsFor(kind, days, keyId) {
    const key = `${kind}|${days}|${keyId ?? ""}`;
    const hit = cache.get(key);
    if (hit && clock() - hit.at < CACHE_MS) return hit.rows;
    const rows = await source.query(buildUsageQuery({ kind, days, keyId }), { timespan: `P${days}D` });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: clock(), rows });
    return rows;
  }

  const empty = (kind, days, note) => ({ kind, days, ...aggregateUsage([], { keys: new Map(), includeUnknown: false, days, bucket: bucketFor(days), now: clock() }), note });

  async function usage(actor, { kind, days } = {}) {
    if (!["jwt", "product"].includes(kind)) throw new ServiceError(400, "kind must be jwt or product.");
    const d = period(days);
    if (!source) return empty(kind, d, "Usage is not configured: the dashboard has no Log Analytics workspace.");
    const keys = new Map();
    for (const s of await vault.listSecrets()) {
      if (kindOf(s) === kind && owns(actor, s) && keyIdOf(s)) keys.set(keyIdOf(s), { name: s.name, owner: s.tags.owner ?? null, label: s.tags.label });
    }
    const rows = await rowsFor(kind, d, undefined);
    const now = clock();
    return { kind, days: d, from: new Date(now - d * 86_400_000).toISOString(), to: new Date(now).toISOString(),
      ...aggregateUsage(rows, { keys, includeUnknown: actor?.role === "admin", days: d, bucket: bucketFor(d), now }) };
  }

  async function keyUsage(actor, name, { days } = {}) {
    const s = await visibleKey(actor, name);
    const d = period(days);
    const kind = kindOf(s);
    if (!source) return { name, ...empty(kind, d, "Usage is not configured: the dashboard has no Log Analytics workspace.") };
    const id = keyIdOf(s);
    if (!id) return { name, ...empty(kind, d, "This key has no id the gateway reports usage under.") };
    const rows = await rowsFor(kind, d, id);
    const keys = new Map([[id, { name, owner: s.tags.owner ?? null, label: s.tags.label }]]);
    const u = aggregateUsage(rows, { keys, includeUnknown: false, days: d, bucket: bucketFor(d), now: clock() });
    return { name, kind, days: d, total: u.total, series: u.series, byModel: u.byModel };
  }

  return { setUsageSource, usage, keyUsage };
}
