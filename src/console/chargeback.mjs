/**
 * The chargeback report (P59, ADR-0020): measured usage per key and model for a period, with each
 * key's attribution from its Key Vault tags. It is built from tags and usage rows only, never from
 * a secret's value; every cell goes through csvSafe (OWASP CSV injection, RFC 4180 quoting). There
 * is no price column: Foundry pricing varies by model and Claude is billed in CCU.
 */

import { csvTable } from "./csv.mjs";
import { statusOf } from "./lifecycle.mjs";

export const CHARGEBACK_COLUMNS = Object.freeze([
  "period_start_utc", "period_end_utc", "key_kind", "key_name", "key_id", "issued_to",
  "label", "subject", "budget_tokens", "monthly_tokens", "rotate_days", "product", "issued_by", "valid_from_utc", "expires_utc",
  "status", "foundry_account", "connection_id", "granted_models",
  "model", "prompt_tokens", "completion_tokens", "total_tokens", "requests", "first_seen_utc", "last_seen_utc",
]);

const METRIC = { "Total Tokens": "total", "Prompt Tokens": "prompt", "Completion Tokens": "completion" };
const KIND_LABEL = { jwt: "short-lived", product: "product" };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** An instant as YYYY-MM-DDTHH:MM:SSZ, or "" when there is none. */
const utc = (v) => {
  const t = typeof v === "number" ? v : Date.parse(v ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
};

/**
 * @param {{kind: "jwt"|"product", rows: object[]}[]} sources  AppMetrics rows per key kind (usage.mjs query)
 * @param {{secrets: object[], kindOf, keyIdOf, period, now: number, defaultFoundry: {id, name}}} o
 *   `secrets` as Key Vault lists them (name, tags); `period` from resolvePeriod.
 * @returns {{csv: string, rows: number, totals: object, from: string, to: string}}
 */
export function chargebackReport(sources, { secrets, kindOf, keyIdOf, period, now, defaultFoundry }) {
  const keys = new Map();
  for (const s of secrets) if (kindOf(s) && keyIdOf(s)) keys.set(`${kindOf(s)}|${keyIdOf(s)}`, s);

  const entries = new Map();
  for (const { kind, rows } of sources) {
    for (const r of rows) {
      const metric = METRIC[r.Name];
      if (!metric) continue;
      const keyId = String(r.KeyId ?? "");
      const model = String(r.Model ?? "") || "(none)";
      const id = `${kind}|${keyId}|${model}`;
      const e = entries.get(id) ?? { kind, keyId, model, key: keys.get(`${kind}|${keyId}`) ?? null,
        prompt: 0, completion: 0, total: 0, requests: 0, first: Infinity, last: -Infinity };
      entries.set(id, e);
      e[metric] += Number(r.Tokens) || 0;
      if (metric === "total") e.requests += Number(r.Calls) || 0;
      const first = Date.parse(r.FirstSeen ?? r.Bucket);
      const last = Date.parse(r.LastSeen ?? r.Bucket);
      if (Number.isFinite(first)) e.first = Math.min(e.first, first);
      if (Number.isFinite(last)) e.last = Math.max(e.last, last);
    }
  }

  const order = (e) => [e.kind === "jwt" ? 0 : 1, e.key ? 0 : 1, e.key ? e.key.name : e.keyId, e.model];
  const sorted = [...entries.values()].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });

  const start = utc(period.start);
  const end = utc(period.range ? period.end - 1000 : period.end);
  const records = sorted.map((e) => {
    const t = e.key?.tags ?? {};
    const known = Boolean(e.key);
    // A key issued before ADR-0017 has no Foundry tags: it belongs to the default connection.
    const connection = known ? t.foundry ?? defaultFoundry.id : "";
    const account = known ? t.foundryName ?? (connection === defaultFoundry.id ? defaultFoundry.name : "") : "";
    return [
      start, end, KIND_LABEL[e.kind], e.key?.name ?? "", e.keyId, t.owner ?? "",
      t.label ?? "", t.subject ?? "", t.budget ?? "", t.monthlyTokens ?? "", t.rotateDays ?? "", t.product ?? "", t.issuedBy ?? "",
      utc(t.notBefore), utc(t.expires),
      known ? statusOf(e.kind, t, now) : "unknown", account, connection,
      String(t.models ?? "").split(",").filter(Boolean).join(" "),
      e.model, e.prompt, e.completion, e.total, e.requests,
      utc(Number.isFinite(e.first) ? e.first : null), utc(Number.isFinite(e.last) ? e.last : null),
    ];
  });

  const totals = sorted.reduce((sum, e) => ({ prompt: sum.prompt + e.prompt, completion: sum.completion + e.completion,
    tokens: sum.tokens + e.total, requests: sum.requests + e.requests }), { prompt: 0, completion: 0, tokens: 0, requests: 0 });
  return {
    csv: csvTable(CHARGEBACK_COLUMNS, records), rows: records.length, totals,
    from: period.range ? period.range.from : isoDay(period.start),
    to: period.range ? period.range.to : isoDay(period.end),
  };
}

/** Which key kinds a report covers. A Map, so a name such as "constructor" is not a kind. */
export const CHARGEBACK_KINDS = new Map([["all", ["jwt", "product"]], ["jwt", ["jwt"]], ["product", ["product"]]]);
