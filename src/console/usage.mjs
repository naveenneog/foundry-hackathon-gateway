/**
 * Usage per key (P52, ADR-0015). The gateway's token metrics land in the workspace as AppMetrics
 * rows; hackathon routes carry the JWT's jti as KeyId, product routes the subscription id with
 * Route "poc". One query per (kind, period) returns rows by time bucket, key, model and metric;
 * everything else is done here, in pure code.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const PERIODS = [1, 7, 30, 90];
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const METRICS = { total: "Total Tokens", prompt: "Prompt Tokens", completion: "Completion Tokens" };

export const bucketFor = (days) => (days === 1 ? { ms: HOUR_MS, kql: "1h" } : { ms: DAY_MS, kql: "1d" });

export function buildUsageQuery({ kind, days, keyId }) {
  if (!["jwt", "product"].includes(kind)) throw new Error("Usage kind must be jwt or product.");
  if (!PERIODS.includes(days)) throw new Error(`Usage days must be one of ${PERIODS.join(", ")}.`);
  if (keyId !== undefined && !KEY_ID_RE.test(String(keyId))) throw new Error("Not a key id.");
  return [
    "AppMetrics",
    `| where TimeGenerated > ago(${days}d)`,
    `| where Name in ("${METRICS.total}", "${METRICS.prompt}", "${METRICS.completion}")`,
    "| extend KeyId = tostring(Properties.KeyId), Model = tostring(Properties.Model), Route = tostring(Properties.Route)",
    kind === "product" ? '| where Route == "poc"' : '| where Route != "poc"',
    ...(keyId === undefined ? [] : [`| where KeyId == "${keyId}"`]),
    `| summarize Tokens = sum(Sum), Calls = sum(ItemCount) by Bucket = bin(TimeGenerated, ${bucketFor(days).kql}), KeyId, Model, Name`,
  ].join("\n");
}

/**
 * @param {object[]} rows  {Bucket, KeyId, Model, Name, Tokens, Calls}
 * @param {{keys: Map<string, {name, owner, label?}>, includeUnknown: boolean, days: number, bucket: {ms}, now: number}} o
 */
export function aggregateUsage(rows, { keys, includeUnknown, days, bucket, now }) {
  const end = Math.floor(now / bucket.ms) * bucket.ms;
  const count = days === 1 ? 24 : days;
  const series = Array.from({ length: count }, (_, i) => ({ t: new Date(end - (count - 1 - i) * bucket.ms).toISOString(), tokens: 0 }));
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
    const i = slot.get(Math.floor(at / bucket.ms) * bucket.ms);
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
