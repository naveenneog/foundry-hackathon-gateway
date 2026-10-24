/**
 * Usage per key (P52, ADR-0015). The gateway's token metrics land in the workspace as AppMetrics
 * rows; hackathon routes carry the JWT's jti as KeyId, product routes the subscription id with
 * Route "poc". One query per (kind, period) returns rows by time bucket, key, model and metric;
 * everything else is done here, in pure code. A period is a preset number of days or, since P59,
 * a range of whole UTC days that reaches back as far as AppMetrics keeps data at no charge.
 */

import { InputError } from "./validate.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const PERIODS = [1, 7, 30, 90];
/** AppMetrics keeps 90 days at no charge (P57, docs/CONSOLE.md), so a range starts at most 89 days before today. */
export const MAX_RANGE_DAYS = 90;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const METRICS = { total: "Total Tokens", prompt: "Prompt Tokens", completion: "Completion Tokens" };

/** Hourly buckets for two days or fewer, daily beyond: the presets get 1 h for 24 hours, 1 d for 7, 30 and 90 days. */
export const bucketFor = (days) => (days <= 2 ? { ms: HOUR_MS, kql: "1h" } : { ms: DAY_MS, kql: "1d" });

const fail = (message) => { throw new InputError(message); };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** "YYYY-MM-DD" as 00:00 UTC that day, in ms; null for any other text, or a date that does not exist. */
function utcDay(value) {
  const m = typeof value === "string" ? DATE_RE.exec(value) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isoDay(ms) === value ? ms : null;
}

/**
 * The period a usage request asks for: `days` (a preset; 7 when nothing is given), or `from` and
 * `to`, whole UTC days, inclusive, never both. Throws InputError for anything else.
 */
export function resolvePeriod({ days, from, to } = {}, now) {
  const given = (v) => v !== undefined && v !== null && v !== "";
  if (given(from) || given(to)) {
    if (given(days)) fail("Send days, or from and to, not both.");
    if (!given(from) || !given(to)) fail("A custom range needs both from and to, as YYYY-MM-DD.");
    const start = utcDay(from);
    const last = utcDay(to);
    if (start === null || last === null) fail("Dates must be whole UTC days written YYYY-MM-DD.");
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const earliest = today - (MAX_RANGE_DAYS - 1) * DAY_MS;
    if (start > last) fail("The start date must be on or before the end date.");
    if (last > today) fail(`The end date cannot be after today, ${isoDay(today)} (UTC).`);
    if (start < earliest) fail(`Usage is kept for ${MAX_RANGE_DAYS} days: the earliest start date is ${isoDay(earliest)} (UTC).`);
    const n = (last - start) / DAY_MS + 1;
    return { days: n, range: { from, to }, start, end: last + DAY_MS, bucket: bucketFor(n), key: `${from}..${to}` };
  }
  const d = given(days) ? Number(days) : 7;
  if (!PERIODS.includes(d)) fail(`Period must be ${PERIODS.join(", ")} days, or a custom range.`);
  return { days: d, range: null, start: now - d * DAY_MS, end: now, bucket: bucketFor(d), key: `d${d}` };
}

/**
 * The KQL time filter. A preset uses ago(); a range uses datetime literals that this function
 * formats from whole UTC days, so no request text ever reaches the query.
 */
function timeWindow(period) {
  if (period?.range) {
    const { start, end } = period;
    const whole = (v) => Number.isSafeInteger(v) && v % DAY_MS === 0;
    if (!whole(start) || !whole(end) || end <= start || end - start > MAX_RANGE_DAYS * DAY_MS) {
      throw new Error(`A usage range must be whole UTC days, at most ${MAX_RANGE_DAYS}.`);
    }
    return {
      filter: `| where TimeGenerated >= datetime(${new Date(start).toISOString()}) and TimeGenerated < datetime(${new Date(end).toISOString()})`,
      bucket: bucketFor((end - start) / DAY_MS),
    };
  }
  if (!PERIODS.includes(period?.days)) throw new Error(`Usage days must be one of ${PERIODS.join(", ")}.`);
  return { filter: `| where TimeGenerated > ago(${period.days}d)`, bucket: bucketFor(period.days) };
}

/** `period` from resolvePeriod; `days` alone is a preset, as before P59. */
export function buildUsageQuery({ kind, days, period, keyId }) {
  if (!["jwt", "product"].includes(kind)) throw new Error("Usage kind must be jwt or product.");
  if (keyId !== undefined && !KEY_ID_RE.test(String(keyId))) throw new Error("Not a key id.");
  const { filter, bucket } = timeWindow(period ?? { days });
  return [
    "AppMetrics",
    filter,
    `| where Name in ("${METRICS.total}", "${METRICS.prompt}", "${METRICS.completion}")`,
    "| extend KeyId = tostring(Properties.KeyId), Model = tostring(Properties.Model), Route = tostring(Properties.Route)",
    kind === "product" ? '| where Route == "poc"' : '| where Route != "poc"',
    ...(keyId === undefined ? [] : [`| where KeyId == "${keyId}"`]),
    `| summarize Tokens = sum(Sum), Calls = sum(ItemCount), FirstSeen = min(TimeGenerated), LastSeen = max(TimeGenerated) by Bucket = bin(TimeGenerated, ${bucket.kql}), KeyId, Model, Name`,
  ].join("\n");
}

/**
 * The zero-filled bucket grid a period's chart shows: a preset ends at the current bucket; a range
 * starts at its first day and ends at its last bucket, or at the current one when it ends today.
 */
export function usageGrid(period, now) {
  const step = period.bucket.ms;
  if (period.range) {
    const last = Math.floor(Math.min(period.end - 1, now) / step) * step;
    return { first: period.start, count: Math.max(1, (last - period.start) / step + 1), step };
  }
  const end = Math.floor(now / step) * step;
  const count = period.days === 1 ? 24 : period.days;
  return { first: end - (count - 1) * step, count, step };
}

/**
 * @param {object[]} rows  {Bucket, KeyId, Model, Name, Tokens, Calls}
 * @param {{keys: Map<string, {name, owner, label?}>, includeUnknown: boolean, grid?: {first, count, step}, days?: number, bucket?: {ms}, now?: number}} o
 *   `grid` from usageGrid; without it, the preset grid for `days` ending at `now`.
 */
export function aggregateUsage(rows, { keys, includeUnknown, days, bucket, now, grid }) {
  const g = grid ?? usageGrid({ days, bucket, range: null }, now);
  const series = Array.from({ length: g.count }, (_, i) => ({ t: new Date(g.first + i * g.step).toISOString(), tokens: 0 }));
  const slot = new Map(series.map((p, i) => [Date.parse(p.t), i]));
  const total = { tokens: 0, prompt: 0, completion: 0, requests: 0 };
  const byModel = new Map();
  const byKey = new Map();

  for (const r of rows) {
    const id = String(r.KeyId ?? "");
    const known = keys.get(id);
    if (!known && !includeUnknown) continue;
    const tokens = Number(r.Tokens) || 0;
    const k = byKey.get(id) ?? { name: known?.name ?? null, keyId: id, owner: known?.owner ?? null, ...(known?.label ? { label: known.label } : {}),
      tokens: 0, prompt: 0, completion: 0, requests: 0, lastSeen: null };
    byKey.set(id, k);
    if (r.Name === METRICS.prompt) { total.prompt += tokens; k.prompt += tokens; continue; }
    if (r.Name === METRICS.completion) { total.completion += tokens; k.completion += tokens; continue; }
    if (r.Name !== METRICS.total) continue;
    const calls = Number(r.Calls) || 0;
    total.tokens += tokens;
    total.requests += calls;
    k.tokens += tokens;
    k.requests += calls;
    const at = Date.parse(r.Bucket);
    if (Number.isFinite(at) && (!k.lastSeen || at > Date.parse(k.lastSeen))) k.lastSeen = new Date(at).toISOString();
    const i = slot.get(Math.floor(at / g.step) * g.step);
    if (i !== undefined) series[i].tokens += tokens;
    const model = String(r.Model ?? "") || "(none)";
    byModel.set(model, (byModel.get(model) ?? 0) + tokens);
  }

  return {
    total,
    series,
    byModel: [...byModel].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
    byKey: [...byKey.values()].sort((a, b) => b.tokens - a.tokens || String(a.name ?? a.keyId).localeCompare(String(b.name ?? b.keyId))),
  };
}
