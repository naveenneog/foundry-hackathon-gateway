// Key Dashboard — pure helpers: validation, CSV, formatting, chart maths and key-list logic.
// No DOM and no network here, so tests/console-ui.test.mjs imports this module under Node.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PERIODS = Object.freeze([1, 7, 30, 90]);
/** A custom range reaches back 90 days, as far as AppMetrics keeps usage at no charge (server: usage.mjs). */
export const RANGE_DAYS = 90;
export const BATCH_SIZE = 50;
export const ARCHIVE_DAYS = 30;
const MAX_BUCKETS = 400;

/** Server limits, mirrored for early feedback. The server stays authoritative. */
export const LIMITS = Object.freeze({
  budget: [1, 100_000_000],
  monthlyTokens: [1, 100_000_000],
  hours: [0, 2160],
  startInHours: [0, 2160],
  rotateDays: [1, 90],
  expiresDays: [1, 3650],
  label: 80,
  recipient: 120,
  passphrase: 16,
});

export const KINDS = Object.freeze({
  jwt: Object.freeze({ title: "Short-lived keys", label: "Short-lived", route: "short-lived", cls: "s-jwt", noun: "short-lived key" }),
  product: Object.freeze({ title: "Product keys", label: "Product", route: "product", cls: "s-product", noun: "product key" }),
});
export const ROUTE_LABEL = Object.freeze({ openai: "OpenAI-compatible", claude: "Claude" });
export const STATUSES = Object.freeze(["active", "scheduled", "suspended", "revoked", "expired", "archived"]);

// ── Usage periods: a preset number of days, or { from, to } whole UTC days (P59) ──

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** "YYYY-MM-DD" as 00:00 UTC that day, in ms; null for any other text or a date that does not exist. */
export function utcDay(value) {
  const m = typeof value === "string" ? DATE_RE.exec(value) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isoDay(ms) === value ? ms : null;
}
export const isRange = (p) => typeof p === "object" && p !== null && typeof p.from === "string" && typeof p.to === "string";
/** The usage API's parameters for a period: days, or from and to. */
export const periodQuery = (p) => (isRange(p) ? { from: p.from, to: p.to } : { days: p });
/** Equal periods have equal keys; a preset and a range of as many days do not. */
export const periodKey = (p) => (isRange(p) ? `${p.from}..${p.to}` : `d${p}`);
export const periodDays = (p) => (isRange(p) ? Math.round((utcDay(p.to) - utcDay(p.from)) / DAY) + 1 : Number(p));

/** The dates a range may use: from 89 days before today to today, UTC. */
export function rangeLimits(now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  return { min: isoDay(today - (RANGE_DAYS - 1) * DAY), max: isoDay(today) };
}

/** Field errors ({ from?, to? }) for a range, checked as the server checks it; empty when it is valid. */
export function checkRange(from, to, now = Date.now()) {
  const errors = {};
  const a = utcDay(from);
  const b = utcDay(to);
  if (a === null) errors.from = "Choose the first day, as YYYY-MM-DD.";
  if (b === null) errors.to = "Choose the last day, as YYYY-MM-DD.";
  if (a === null || b === null) return errors;
  const { min, max } = rangeLimits(now);
  if (a < utcDay(min)) errors.from = `Usage is kept for ${RANGE_DAYS} days: start on ${min} or later.`;
  if (b > utcDay(max)) errors.to = `The last day cannot be after today, ${max} (UTC).`;
  else if (a > b) errors.to = "The last day must be on or after the first day.";
  return errors;
}

/** "24 hours", "7 days", or a range's dates, such as "Oct 1 – 5, 2026" (UTC days). */
export function periodLabel(p, locale) {
  if (!isRange(p)) return p === 1 ? "24 hours" : `${p} days`;
  const f = intl(Intl.DateTimeFormat, locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return p.from === p.to ? f.format(utcDay(p.from)) : f.formatRange(utcDay(p.from), utcDay(p.to));
}
/** "last 7 days", or a range's dates marked UTC: completes "Tokens, …". */
export const periodPhrase = (p, locale) => (isRange(p) ? `${periodLabel(p, locale)} (UTC)` : `last ${periodLabel(p)}`);

/**
 * What a key is called in lists: the short-lived key's subject, else its name without the "poc-key-"
 * storage prefix. Labels are free text shared by many keys, so they never stand in for this.
 */
export const keyTitle = (k) => k?.subject || String(k?.name ?? "").replace(/^poc-key-(?=.)/, "");

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const SUBJECT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PRODUCT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Claude Code resolves these names itself, so an alias spelled like this never reaches the gateway.
const RESERVED_CLAUDE_ALIASES = new Set(["sonnet", "opus", "haiku"]);

const str = (v) => String(v ?? "").trim();
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

// ── Validation ──────────────────────────────────────────────────────────────

export const idField = (kind) => (kind === "jwt" ? "subject" : "name");
export const normalizeOwner = (v) => str(v).toLowerCase();

export function checkOwner(v) {
  const owner = normalizeOwner(v);
  if (!owner) return "Enter who the key is issued to: an email address.";
  return EMAIL_RE.test(owner) ? null : "Issued to: an email address such as alex@contoso.com.";
}

export function checkSubject(v) {
  const s = str(v);
  if (!s) return "Enter the subject: a team or participant id.";
  return SUBJECT_RE.test(s) ? null : "Subject: up to 64 letters, digits, dots, dashes or underscores.";
}

export function checkProductName(v) {
  const s = str(v);
  if (!s) return "Enter a key name.";
  return PRODUCT_NAME_RE.test(s) ? null : "Name: 2–40 lowercase letters, digits or dashes, starting and ending with a letter or digit.";
}

export function checkWhole(v, [min, max], what, { optional = false } = {}) {
  if (str(v) === "") return optional ? null : `Enter ${what}.`;
  const n = num(str(v));
  return Number.isInteger(n) && n >= min && n <= max ? null : `${what[0].toUpperCase()}${what.slice(1)}: a whole number from ${fmtInt(min)} to ${fmtInt(max)}.`;
}

export function checkHours(v) {
  if (str(v) === "") return "Enter how many hours the key is valid.";
  const n = num(str(v));
  const max = LIMITS.hours[1];
  return Number.isFinite(n) && n > 0 && n <= max ? null : `Validity: more than 0 and at most ${fmtInt(max)} hours (90 days).`;
}

/** Hours from now until the key starts: blank is 0 (immediately); decimals are fine. */
export function checkStart(v) {
  if (str(v) === "") return null;
  const n = num(str(v));
  const max = LIMITS.startInHours[1];
  return Number.isFinite(n) && n >= 0 && n <= max ? null : `Starts in: 0 to ${fmtInt(max)} hours from now.`;
}

export function checkModelChoice(mode, models) {
  const n = new Set(models ?? []).size;
  if (mode === "one") return n === 1 ? null : "Choose the model this key may call.";
  if (mode === "several") return n >= 2 ? null : "Tick at least two models, or switch to One model.";
  return "Choose One model or Several models.";
}

export function checkAlias(alias, route) {
  const a = str(alias).toLowerCase();
  if (!a) return "Enter an alias.";
  if (!ALIAS_RE.test(a)) return "Alias: lowercase letters, digits, dots, dashes or underscores, up to 64.";
  if (route === "claude" && RESERVED_CLAUDE_ALIASES.has(a)) return `Claude Code resolves "${a}" to its own model id; add a version, for example ${a}-5.`;
  return null;
}

export function checkRecipient(v) {
  const s = str(v);
  return s && s.length <= LIMITS.recipient ? null : `Name the recipient (up to ${LIMITS.recipient} characters).`;
}

export function checkPassphrase(v) {
  const s = String(v ?? "");
  return s === "" || s.length >= LIMITS.passphrase ? null : `Use at least ${LIMITS.passphrase} characters, or leave it blank to generate one.`;
}

/** Shared grant settings for single and bulk issue. Returns field errors and the request body. */
export function validateSettings(kind, v) {
  const errors = {};
  const put = (field, message) => { if (message) errors[field] = message; };
  const models = [...new Set((v.models ?? []).map(str).filter(Boolean))];
  put("models", checkModelChoice(v.mode, models));
  const body = { models };
  if (kind === "jwt") {
    put("budget", checkWhole(v.budget, LIMITS.budget, "a token budget"));
    put("hours", checkHours(v.hours));
    put("startInHours", checkStart(v.startInHours));
    const label = str(v.label);
    put("label", label.length > LIMITS.label ? `Label: up to ${LIMITS.label} characters.` : null);
    body.budget = num(str(v.budget));
    body.hours = num(str(v.hours));
    body.startInHours = str(v.startInHours) === "" ? 0 : num(str(v.startInHours));
    if (label) body.label = label;
  } else {
    put("monthlyTokens", checkWhole(v.monthlyTokens, LIMITS.monthlyTokens, "a monthly token budget"));
    put("rotateDays", checkWhole(v.rotateDays, LIMITS.rotateDays, "rotation days", { optional: true }));
    put("expiresDays", checkWhole(v.expiresDays, LIMITS.expiresDays, "expiry days", { optional: true }));
    body.monthlyTokens = num(str(v.monthlyTokens));
    if (str(v.rotateDays) !== "") body.rotateDays = num(str(v.rotateDays));
    if (str(v.expiresDays) !== "") body.expiresDays = num(str(v.expiresDays));
  }
  return { ok: Object.keys(errors).length === 0, errors, body };
}

/** A single-issue form: the shared settings plus owner and subject (short-lived) or name (product). */
export function validateIssue(kind, v) {
  const { errors, body } = validateSettings(kind, v);
  const owner = normalizeOwner(v.owner);
  const ownerError = checkOwner(owner);
  if (ownerError) errors.owner = ownerError;
  const field = idField(kind);
  const id = str(v[field]);
  const idError = kind === "jwt" ? checkSubject(id) : checkProductName(id);
  if (idError) errors[field] = idError;
  return { ok: Object.keys(errors).length === 0, errors, body: { owner, [field]: id, ...body } };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = "CsvError";
  }
}

/** Comma unless the first line clearly uses semicolons or tabs (spreadsheet exports in some locales). */
export function detectDelimiter(text) {
  const first = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/, 1)[0] ?? "";
  const count = (ch) => first.split(ch).length - 1;
  const [best] = [[",", count(",")], [";", count(";")], ["\t", count("\t")]].sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ",";
}

/**
 * RFC 4180 parsing: quoted fields, doubled quotes, delimiters and line breaks inside quotes,
 * CRLF, LF or CR line endings and a UTF-8 BOM. Returns [{ line, fields }], line being 1-based
 * where the record starts. Never evaluates anything.
 */
export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const records = [];
  let fields = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else {
        if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line++;
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      field = "";
      quoted = true;
      quoteLine = line;
    } else if (c === delimiter) {
      fields.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = "";
      line++;
      recordLine = line;
    } else field += c;
  }
  if (quoted) throw new CsvError(`Line ${quoteLine}: a quoted value is never closed.`);
  if (field !== "" || fields.length) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  return records;
}

/**
 * Maps CSV records to bulk entries. A header row naming "owner" (or "email" or "issued to") and
 * "subject" (short-lived) or "name" (product) picks the columns; without one, the columns are owner
 * then id.
 */
export function entriesFromCsv(records, kind) {
  const field = idField(kind);
  const rows = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  let cols = [0, 1];
  let header = false;
  if (rows.length) {
    const head = rows[0].fields.map((f) => f.trim().toLowerCase());
    const owner = head.findIndex((h) => ["owner", "email", "issued to", "issued_to", "issued-to"].includes(h));
    const id = head.indexOf(field);
    if (owner !== -1 && id !== -1) {
      cols = [owner, id];
      header = true;
    }
  }
  const entries = (header ? rows.slice(1) : rows).map((r) => ({
    line: r.line, owner: str(r.fields[cols[0]]), [field]: str(r.fields[cols[1]]),
  }));
  return { header, entries };
}

/** Per-row checks, including duplicates inside the file. Owners are normalised as the server does. */
export function validateEntries(entries, kind) {
  const field = idField(kind);
  const seen = new Map();
  return entries.map((e) => {
    const owner = normalizeOwner(e.owner);
    const errors = [checkOwner(owner), kind === "jwt" ? checkSubject(e[field]) : checkProductName(e[field])].filter(Boolean);
    const dupKey = kind === "jwt" ? `${owner}\n${e[field]}` : e[field];
    if (!errors.length) {
      if (seen.has(dupKey)) errors.push(`Duplicate of line ${seen.get(dupKey)}.`);
      else seen.set(dupKey, e.line);
    }
    return { ...e, owner, errors };
  });
}

export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Joins the server's per-batch CSV texts (keys.csv, index.csv): the first batch keeps its header
 * line, later batches add only their data lines. The cells are the server's, already
 * formula-escaped; they are never re-parsed or rebuilt here.
 */
export function appendCsv(current, next) {
  if (typeof next !== "string" || next === "") return current ?? null;
  const trimmed = (t) => t.replace(/(?:\r\n|\n|\r)+$/, "");
  if (current === null || current === undefined || current === "") return trimmed(next);
  const end = /\r\n|\n|\r/.exec(next);
  const body = end ? trimmed(next.slice(end.index + end[0].length)) : "";
  return body ? `${trimmed(current)}\r\n${body}` : current;
}

/** short-lived-keys-20261023-0839.csv: kind, which file, and the run's start in UTC. */
export function csvFilename(kind, which, at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `${kind === "jwt" ? "short-lived" : "product"}-${which === "keys" ? "keys" : "index"}-${stamp}.csv`;
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

// ── Formatting ──────────────────────────────────────────────────────────────

const formatters = new Map();
function intl(Ctor, locale, options) {
  const key = `${Ctor.name}|${locale ?? ""}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Ctor(locale, options));
  return formatters.get(key);
}
const toDate = (v) => {
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : Date.parse(v));
  return Number.isFinite(d.getTime()) ? d : null;
};

export function fmtInt(n, locale) {
  const v = num(n);
  return Number.isFinite(v) ? intl(Intl.NumberFormat, locale, { maximumFractionDigits: 0 }).format(v) : "—";
}

export function fmtCompact(n, locale) {
  const v = num(n);
  return Number.isFinite(v) ? intl(Intl.NumberFormat, locale, { notation: "compact", maximumFractionDigits: 1 }).format(v) : "—";
}

export function fmtPercent(x, locale) {
  const v = num(x);
  if (!Number.isFinite(v)) return "—";
  return intl(Intl.NumberFormat, locale, { style: "percent", maximumFractionDigits: v > 0 && v < 0.1 ? 1 : 0 }).format(v);
}

export function fmtDate(v, locale, options = { dateStyle: "medium" }) {
  const d = toDate(v);
  return d ? intl(Intl.DateTimeFormat, locale, options).format(d) : "—";
}

export const fmtDateTime = (v, locale) => fmtDate(v, locale, { dateStyle: "medium", timeStyle: "short" });
export const fmtShortDateTime = (v, locale) => fmtDate(v, locale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * When a short-lived key would be valid: from now + start until from + hours, as the server mints
 * it (nbf = now + startInHours, exp = nbf + hours). Null while either value is not valid.
 */
export function activeWindow(startInHours, hours, now = Date.now()) {
  const start = str(startInHours) === "" ? 0 : num(str(startInHours));
  const span = num(str(hours));
  const [lo, hi] = LIMITS.startInHours;
  if (!Number.isFinite(start) || start < lo || start > hi || !Number.isFinite(span) || span <= 0 || span > LIMITS.hours[1]) return null;
  const from = now + Math.round(start * HOUR);
  return { from, until: from + Math.round(span * HOUR) };
}

export function fmtRelative(v, now = Date.now(), locale) {
  const d = toDate(v);
  if (!d) return "—";
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const [unit, size] = abs < 45_000 ? ["second", 1000] : abs < 45 * 60_000 ? ["minute", 60_000]
    : abs < 22 * HOUR ? ["hour", HOUR] : abs < 26 * DAY ? ["day", DAY] : abs < 320 * DAY ? ["month", 30 * DAY] : ["year", 365 * DAY];
  return intl(Intl.RelativeTimeFormat, locale, { numeric: "auto" }).format(Math.round(diff / size), unit);
}

/** Daily buckets are UTC days (the server bins in UTC); hourly buckets are shown in local time. */
export function fmtBucket(ms, step, { long = false, locale } = {}) {
  if (step >= DAY) {
    return fmtDate(ms, locale, long ? { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" });
  }
  return fmtDate(ms, locale, long ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

// ── Chart maths ─────────────────────────────────────────────────────────────

/** Round tick values covering [min, max]; whole-number steps when `integer` is set. */
export function niceTicks(min, max, count = 4, { integer = false } = {}) {
  let lo = Number(min) || 0;
  let hi = Number(max) || 0;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) hi = lo + 1;
  const rough = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const r = rough / mag;
  let step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

export const scaleLinear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) * (r1 - r0)) / (d1 - d0));

/** Hourly buckets for two days or fewer, daily beyond, as the server bins them (usage.mjs bucketFor). */
export const bucketMs = (days) => (days <= 2 ? HOUR : DAY);

/**
 * Aligns one or more `[{ t, tokens }]` series on a dense bucket grid (hours for one day, else
 * days), filling gaps with zero, so the chart never interpolates across missing buckets.
 */
export function alignSeries(lists, { days = 7, from, to, now = Date.now() } = {}) {
  const step = bucketMs(days);
  const floor = (ms) => Math.floor(ms / step) * step;
  const parsed = lists.map((pts) => (Array.isArray(pts) ? pts : [])
    .map((p) => [floor(Date.parse(p?.t)), Number(p?.tokens ?? 0)])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)));
  const toMs = Date.parse(to);
  let end = floor(Number.isFinite(toMs) ? toMs : now);
  const fromMs = Date.parse(from);
  let start = Number.isFinite(fromMs) ? floor(fromMs) : end - ((step === HOUR ? days * 24 : days) - 1) * step;
  for (const pts of parsed) for (const [t] of pts) { start = Math.min(start, t); end = Math.max(end, t); }
  const count = Math.max(1, Math.min(Math.round((end - start) / step) + 1, MAX_BUCKETS));
  start = end - (count - 1) * step;
  const times = Array.from({ length: count }, (_, i) => start + i * step);
  const values = parsed.map((pts) => {
    const row = new Array(count).fill(0);
    for (const [t, v] of pts) {
      const i = Math.round((t - start) / step);
      if (i >= 0 && i < count) row[i] += v;
    }
    return row;
  });
  return { step, times, values };
}

/** Which x positions get a label: at most `max`, always including the latest bucket. */
export function labelIndices(count, max) {
  if (count <= 0) return [];
  const every = Math.max(1, Math.ceil(count / Math.max(1, max)));
  const out = [];
  for (let i = count - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}

export function describeSeries({ names, times, values, step, locale }) {
  if (!times.length) return "No data.";
  const unit = step >= DAY ? "day (UTC)" : "hour";
  const parts = names.map((name, i) => {
    const row = values[i] ?? [];
    const total = row.reduce((a, b) => a + b, 0);
    if (!total) return `${name}: no tokens`;
    let peak = 0;
    for (let j = 1; j < row.length; j++) if (row[j] > row[peak]) peak = j;
    return `${name}: ${fmtInt(total, locale)} tokens, peak ${fmtInt(row[peak], locale)} on ${fmtBucket(times[peak], step, { long: true, locale })}`;
  });
  return `Tokens per ${unit} from ${fmtBucket(times[0], step, { long: true, locale })} to ${fmtBucket(times.at(-1), step, { long: true, locale })}. ${parts.join(". ")}.`;
}

/** Sums `[{ model, tokens }]` lists by model, largest first. */
export function mergeByModel(lists) {
  const sums = new Map();
  for (const list of lists) for (const m of list ?? []) {
    const name = str(m?.model) || "unknown";
    sums.set(name, (sums.get(name) ?? 0) + (Number(m?.tokens) || 0));
  }
  return [...sums].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

/** The largest `n - 1` items, plus one "Other" item summing the rest when there are more than `n`. */
export function topWithOther(items, n, label = "Other") {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n - 1).reduce((a, b) => a + b.value, 0);
  return [...sorted.slice(0, n - 1), { label, value: rest, other: true }];
}

// ── Keys ────────────────────────────────────────────────────────────────────

export function keyStatus(k, now = Date.now()) {
  if (STATUSES.includes(k?.status)) return k.status;
  if (k?.archived === true) return "archived";
  if (k?.revoked === true || k?.revoked === "true") return "revoked";
  if (k?.state === "suspended") return "suspended";
  if (k?.expires && Date.parse(k.expires) <= now) return "expired";
  if (k?.notBefore && Date.parse(k.notBefore) > now) return "scheduled";
  return "active";
}

/**
 * The only fields of a bulk-issue row that a view may hold: who and what, never the key. The
 * server's rows also carry the token (short-lived) or the subscription key (product).
 */
export function safeIssued(kind, row) {
  const r = row ?? {};
  return kind === "jwt"
    ? { name: r.name, owner: r.owner, subject: r.subject, notBefore: r.notBefore ?? null, expiresAt: r.expiresAt ?? null }
    : { name: r.name, owner: r.owner, label: r.label, expiresAt: r.expiresAt ?? null };
}

/** In the archive: the server's flag (set for archived, revoked and expired keys), else the status. */
export const isArchived = (k) => k?.archived === true || keyStatus(k) === "archived";

/** When an archived key is deleted: the server's deleteAfter, else archivedAt + 30 days. */
export function deleteDate(k) {
  if (k?.deleteAfter && Number.isFinite(Date.parse(k.deleteAfter))) return k.deleteAfter;
  const at = Date.parse(k?.archivedAt ?? "");
  return Number.isFinite(at) ? new Date(at + ARCHIVE_DAYS * DAY).toISOString() : null;
}

/** Case-insensitive search over name, owner, label, subject, product, Foundry and models; every term must match. */
export function matchesQuery(k, query) {
  const terms = str(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [k?.name, k?.owner, k?.label, k?.subject, k?.product, k?.foundryName, k?.foundry, ...(Array.isArray(k?.models) ? k.models : [])]
    .filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Joins usage rows (`byKey`) to keys by key name. A key without a row used nothing in the period. */
export function withUsage(keys, byKey) {
  const usage = new Map((byKey ?? []).map((u) => [u.name, u]));
  return keys.map((k) => ({ ...k, usage: usage.get(k.name) ?? null }));
}

const SORTERS = {
  key: (k) => str(k.subject || k.name).toLowerCase(),
  owner: (k) => str(k.owner).toLowerCase(),
  usage: (k) => Number(k.usage?.tokens) || 0,
  expires: (k) => Date.parse(k.expires ?? "") || Number.MAX_SAFE_INTEGER,
  rotated: (k) => Date.parse(k.rotatedAt ?? "") || 0,
  archived: (k) => Date.parse(k.archivedAt ?? "") || 0,
};

export function sortKeys(rows, by = "key", dir = "asc") {
  const get = SORTERS[by] ?? SORTERS.key;
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sign || str(a.name).localeCompare(str(b.name));
  });
}

/**
 * Model options for the issue forms. Short-lived keys grant pinned gateway aliases; product keys
 * grant Foundry deployment names, which clients send as `model` unchanged.
 */
export function modelOptions(kind, config) {
  if (kind === "jwt") {
    return ["openai", "claude"].flatMap((route) => (config?.models?.[route] ?? [])
      .map((alias) => ({ value: String(alias), route, label: String(alias), detail: "" })));
  }
  return (config?.deployments ?? [])
    .filter((d) => d && d.deployment && (d.route === "openai" || d.route === "claude"))
    .map((d) => ({ value: String(d.deployment), route: d.route, label: String(d.deployment), detail: [d.model, d.version].filter(Boolean).join(" ") }));
}

/** The route a granted model belongs to, for its badge; null when the config no longer lists it. */
export function routeOf(kind, config, model) {
  const hit = modelOptions(kind, config).find((o) => o.value === model);
  return hit ? hit.route : null;
}
