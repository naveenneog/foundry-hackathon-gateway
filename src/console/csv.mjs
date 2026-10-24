/**
 * The bulk CSVs, matching scripts/Keys.ps1 New-BulkKeys: keys.csv (one row per key, with the key,
 * for a mail merge or a print run) and index.csv (who got which key id, without keys, safe to
 * share with co-organisers). Cells a spreadsheet would run as a formula get a leading apostrophe
 * (OWASP CSV injection), as ConvertTo-CsvSafe does; the key itself never starts with one.
 */

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");

export function csvSafe(value) {
  let v = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** A header row, then one row per record; every cell through csvSafe; CRLF between records (RFC 4180). */
export const csvTable = (header, rows) => [header.join(","), ...rows.map((r) => r.map(csvSafe).join(","))].join("\r\n");
const table = csvTable;

/** @param {object[]} issued rows from issueJwtBulk / issueProductBulk @param {"jwt"|"product"} kind */
export function keysCsv(issued, kind) {
  if (kind === "jwt") {
    return table(["participant", "owner", "key", "key_id", "models", "openai_base_url", "anthropic_base_url", "anthropic_model",
      "budget_tokens", "valid_from_utc", "valid_until_utc"], issued.map((k) => [k.subject, k.owner, k.token, k.jti, k.models.join(" "),
      k.openaiBaseUrl, k.anthropicBaseUrl, k.anthropicModel, k.budget, iso(k.notBefore), iso(k.expiresAt)]));
  }
  return table(["name", "owner", "key", "models", "anthropic_base_url", "openai_base_url", "key_header", "monthly_tokens", "expires_utc"],
    issued.map((k) => [k.label, k.owner, k.key, k.models.join(" "), k.anthropicBaseUrl, k.openaiBaseUrl,
      "x-api-key (Claude) / api-key (OpenAI)", k.monthlyTokens, iso(k.expiresAt)]));
}

export function indexCsv(issued, kind) {
  if (kind === "jwt") return table(["participant", "owner", "key_id", "name"], issued.map((k) => [k.subject, k.owner, k.jti, k.name]));
  return table(["name", "owner", "subscription", "secret"], issued.map((k) => [k.label, k.owner, k.subscriptionId, k.name]));
}
