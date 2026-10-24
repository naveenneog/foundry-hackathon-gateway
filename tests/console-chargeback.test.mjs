// P59, ADR-0020: the chargeback report. One CSV row per key and model with usage in a period, with
// the key's attribution from its Key Vault tags; formula-escaped and RFC 4180-quoted; no secrets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chargebackReport, CHARGEBACK_COLUMNS } from "../src/console/chargeback.mjs";
import { resolvePeriod } from "../src/console/usage.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const T = Date.parse("2026-10-16T09:00:00Z");
const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
const { parseCsv } = await import("../src/console/public/lib.js");
const kindOf = (s) => (["jwt", "product"].includes(s?.tags?.kind) ? s.tags.kind : null);
const keyIdOf = (s) => (kindOf(s) === "jwt" ? s.tags.jti : s.tags.subscription);
const DEFAULT_FOUNDRY = { id: "default", name: "aif-test" };

const SECRETS = [
  { name: "jwt-k-a", value: "SECRET-TOKEN-A", tags: { kind: "jwt", jti: "k_a", owner: "alex@contoso.com", subject: "team-1", models: "flash,haiku-4-5", budget: "50000",
    notBefore: "2026-10-01T08:00:00.000Z", expires: "2026-10-30T08:00:00.000Z", revoked: "false", issuedBy: "admin@contoso.com", label: "=SUM(A1), team \"one\"" } },
  { name: "jwt-k-old", value: "SECRET-TOKEN-OLD", tags: { kind: "jwt", jti: "k_old", owner: "old@contoso.com", subject: "old-team", models: "flash", budget: "100",
    expires: "2026-10-02T00:00:00.000Z", revoked: "true", archived: "true", archivedAt: "2026-10-02T00:00:00.000Z", foundry: "default", foundryName: "aif-test" } },
  { name: "poc-key-p1", value: "SECRET-PRODUCT-KEY", contentType: "API Management subscription key", tags: { kind: "product", subscription: "poc-p1", slot: "primary",
    owner: "kim@contoso.com", product: "pk-0123456789ab", models: "claude-haiku-4-5", monthlyTokens: "200000", rotateDays: "30", state: "suspended",
    foundry: "f0123456789ab", foundryName: "aif-secondary", label: "-cost centre 42" } },
];

const at = (s) => `2026-10-${s}`;
const metric = (KeyId, Model, Name, Tokens, Calls, bucket, first, last) => ({ Bucket: at(`${bucket}T00:00:00Z`), KeyId, Model, Name, Tokens, Calls,
  FirstSeen: at(first), LastSeen: at(last) });
const JWT_ROWS = [
  metric("k_a", "flash", "Total Tokens", 100, 2, "10", "10T08:15:00Z", "10T09:00:00Z"),
  metric("k_a", "flash", "Prompt Tokens", 70, 2, "10", "10T08:15:00Z", "10T09:00:00Z"),
  metric("k_a", "flash", "Completion Tokens", 30, 2, "10", "10T08:15:00Z", "10T09:00:00Z"),
  metric("k_a", "flash", "Total Tokens", 50, 1, "12", "12T11:00:00Z", "12T11:00:00Z"),
  metric("k_a", "flash", "Prompt Tokens", 20, 1, "12", "12T11:00:00Z", "12T11:00:00Z"),
  metric("k_a", "flash", "Completion Tokens", 30, 1, "12", "12T11:00:00Z", "12T11:00:00Z"),
  metric("k_a", "haiku-4-5", "Total Tokens", 9, 1, "11", "11T10:00:00Z", "11T10:00:00Z"),
  metric("k_old", "flash", "Total Tokens", 4, 1, "01", "01T23:00:00Z", "01T23:30:00Z"),
  metric("k_gone", "", "Total Tokens", 7, 3, "05", "05T01:02:03Z", "05T04:05:06Z"),
];
const PRODUCT_ROWS = [metric("poc-p1", "claude-haiku-4-5", "Total Tokens", 40, 1, "14", "14T12:00:00Z", "14T12:00:00Z")];

const report = (period, sources = [{ kind: "jwt", rows: JWT_ROWS }, { kind: "product", rows: PRODUCT_ROWS }]) =>
  chargebackReport(sources, { secrets: SECRETS, kindOf, keyIdOf, period, now: T, defaultFoundry: DEFAULT_FOUNDRY });

test("the header names every column, in order: the period, the key and its tags, status, Foundry, the model and its usage", () => {
  assert.deepEqual(CHARGEBACK_COLUMNS, [
    "period_start_utc", "period_end_utc", "key_kind", "key_name", "key_id", "issued_to",
    "label", "subject", "budget_tokens", "monthly_tokens", "rotate_days", "product", "issued_by", "valid_from_utc", "expires_utc",
    "status", "foundry_account", "connection_id", "granted_models",
    "model", "prompt_tokens", "completion_tokens", "total_tokens", "requests", "first_seen_utc", "last_seen_utc",
  ]);
  const r = report(resolvePeriod({ from: "2026-10-01", to: "2026-10-15" }, T));
  assert.equal(r.csv.split("\r\n")[0], CHARGEBACK_COLUMNS.join(","));
});

test("one row per key and model; tokens and requests summed over the period; first and last use to the second", () => {
  const r = report(resolvePeriod({ from: "2026-10-01", to: "2026-10-15" }, T));
  const [head, ...rows] = parseCsv(r.csv).map((x) => x.fields);
  const table = rows.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
  assert.deepEqual(table.map((x) => [x.key_kind, x.key_id, x.model]), [
    ["short-lived", "k_a", "flash"], ["short-lived", "k_a", "haiku-4-5"], ["short-lived", "k_old", "flash"], ["short-lived", "k_gone", "(none)"],
    ["product", "poc-p1", "claude-haiku-4-5"],
  ], "known keys by name, then usage whose key is gone, then product keys");
  const flash = table[0];
  assert.deepEqual([flash.prompt_tokens, flash.completion_tokens, flash.total_tokens, flash.requests], ["90", "60", "150", "3"]);
  assert.equal(flash.first_seen_utc, "2026-10-10T08:15:00Z");
  assert.equal(flash.last_seen_utc, "2026-10-12T11:00:00Z");
  assert.equal(flash.period_start_utc, "2026-10-01T00:00:00Z");
  assert.equal(flash.period_end_utc, "2026-10-15T23:59:59Z", "the last day, to its last second");
  assert.deepEqual(r.totals, { prompt: 90, completion: 60, tokens: 210, requests: 9 });
  assert.equal(r.rows, 5);
  assert.deepEqual([r.from, r.to], ["2026-10-01", "2026-10-15"]);
});

test("each row carries the key's attribution and every descriptive tag the dashboard stores", () => {
  const r = report(resolvePeriod({ days: 30 }, T));
  const [head, ...rows] = parseCsv(r.csv).map((x) => x.fields);
  const row = (id, model) => Object.fromEntries(head.map((h, i) => [h, rows.find((c) => c[4] === id && c[19] === model)[i]]));
  assert.deepEqual(row("k_a", "flash"), {
    period_start_utc: "2026-09-16T09:00:00Z", period_end_utc: "2026-10-16T09:00:00Z", key_kind: "short-lived", key_name: "jwt-k-a", key_id: "k_a",
    issued_to: "alex@contoso.com", label: "'=SUM(A1), team \"one\"", subject: "team-1", budget_tokens: "50000", monthly_tokens: "", rotate_days: "",
    product: "", issued_by: "admin@contoso.com", valid_from_utc: "2026-10-01T08:00:00Z", expires_utc: "2026-10-30T08:00:00Z",
    status: "active", foundry_account: "aif-test", connection_id: "default", granted_models: "flash haiku-4-5",
    model: "flash", prompt_tokens: "90", completion_tokens: "60", total_tokens: "150", requests: "3",
    first_seen_utc: "2026-10-10T08:15:00Z", last_seen_utc: "2026-10-12T11:00:00Z",
  }, "a key issued before ADR-0017 belongs to the default Foundry");
  const product = row("poc-p1", "claude-haiku-4-5");
  assert.deepEqual([product.key_kind, product.key_name, product.issued_to, product.label, product.monthly_tokens, product.rotate_days, product.product,
    product.status, product.foundry_account, product.connection_id, product.granted_models],
  ["product", "poc-key-p1", "kim@contoso.com", "'-cost centre 42", "200000", "30", "pk-0123456789ab", "suspended", "aif-secondary", "f0123456789ab", "claude-haiku-4-5"]);
  assert.equal(row("k_old", "flash").status, "archived");
  const gone = row("k_gone", "(none)");
  assert.equal(gone.status, "unknown", "usage whose key is no longer in Key Vault");
  assert.deepEqual([gone.key_name, gone.issued_to, gone.foundry_account, gone.connection_id, gone.granted_models], ["", "", "", "", ""]);
  assert.deepEqual([gone.total_tokens, gone.requests], ["7", "3"]);
  assert.deepEqual([r.from, r.to], ["2026-09-16", "2026-10-16"]);
});

test("cells that a spreadsheet would run get a leading apostrophe; quoting follows RFC 4180; no key value is ever read", () => {
  const evil = [
    ...SECRETS.map((s) => ({ ...s, tags: { ...s.tags } })),
    { name: "jwt-k-evil", value: "SECRET-TOKEN-EVIL", tags: { kind: "jwt", jti: "k_evil", owner: "+cmd@contoso.com", subject: "@SUM(1)", models: "flash",
      label: "\tTAB", issuedBy: "\rCR", expires: "2027-01-01T00:00:00.000Z" } },
  ];
  const rows = [...JWT_ROWS, metric("k_evil", "=HYPERLINK(\"x\")", "Total Tokens", 1, 1, "13", "13T00:00:00Z", "13T00:00:00Z")];
  const r = chargebackReport([{ kind: "jwt", rows }], { secrets: evil, kindOf, keyIdOf, period: resolvePeriod({ days: 7 }, T), now: T, defaultFoundry: DEFAULT_FOUNDRY });
  for (const s of evil) assert.equal(r.csv.includes(s.value), false, `${s.name}'s value is not in the report`);
  const parsed = parseCsv(r.csv).map((x) => x.fields);
  assert.ok(parsed.every((cells) => cells.length === CHARGEBACK_COLUMNS.length), "every record has every column");
  const cells = parsed.flat();
  for (const cell of cells) assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `unescaped cell: ${JSON.stringify(cell)}`);
  const evilRow = parsed.find((c) => c[4] === "k_evil");
  assert.deepEqual([evilRow[5], evilRow[7], evilRow[6], evilRow[12], evilRow[19]], ["'+cmd@contoso.com", "'@SUM(1)", "'\tTAB", "'\rCR", "'=HYPERLINK(\"x\")"]);
  assert.match(r.csv, /,"'=HYPERLINK\(""x""\)",/, "a quote inside a cell is doubled and the cell quoted");
  assert.match(r.csv, /"'\rCR"/, "a cell holding CR is quoted");
  assert.ok(r.csv.split("\r\n").length >= parsed.length, "records end with CRLF");
});

// ── The service and the HTTP route ──────────────────────────────────────────

function laFake(rowsFor) {
  const calls = [];
  return { calls, async query(q, opts) { calls.push({ q, opts }); return rowsFor(q); } };
}

async function issued() {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  await h.service.migrateSigningSecret(ADMIN);
  const a = await h.service.issueJwt(ADMIN, { owner: "alex@contoso.com", subject: "team-1", models: ["flash"], budget: 900, hours: 48, label: "Workshop" });
  await h.service.issueProductKey(ADMIN, { owner: "kim@contoso.com", name: "p1", models: ["claude-haiku-4-5"], monthlyTokens: 100, rotateDays: 7 });
  const la = laFake((q) => (q.includes('Route == "poc"')
    ? [metric("poc-p1", "claude-haiku-4-5", "Total Tokens", 40, 1, "14", "14T12:00:00Z", "14T12:00:00Z")]
    : [metric(a.jti, "flash", "Total Tokens", 10, 1, "15", "15T08:00:00Z", "15T08:00:00Z"), metric("k_gone", "flash", "Total Tokens", 5, 1, "15", "15T09:00:00Z", "15T09:00:00Z")]));
  h.service.setUsageSource(la);
  return { h, la, a };
}

test("service chargeback: admin only, both kinds or one, the selected period, audit-logged, and never a secret", async () => {
  const { h, la, a } = await issued();
  await assert.rejects(h.service.chargeback(ALICE, { days: 7 }), { status: 403 });
  const r = await h.service.chargeback(ADMIN, { from: "2026-10-10", to: "2026-10-16" });
  assert.equal(r.filename, "chargeback-2026-10-10-2026-10-16.csv");
  assert.equal(r.kind, "all");
  assert.equal(r.rows, 3);
  assert.deepEqual(r.totals, { prompt: 0, completion: 0, tokens: 55, requests: 3 });
  assert.match(r.csv, new RegExp(`short-lived,jwt-${a.jti.replace("_", "-")},${a.jti},alex@contoso\\.com,Workshop,team-1,900,`));
  assert.match(r.csv, /\nproduct,|,product,poc-key-p1,poc-p1,kim@contoso\.com,/);
  assert.match(r.csv, /,unknown,/);
  for (const s of h.vault.secrets.values()) assert.equal(r.csv.includes(s.value), false, `${s.name}'s value stays out of the report`);
  assert.deepEqual(la.calls.map((c) => c.opts.timespan), ["2026-10-10T00:00:00.000Z/2026-10-17T00:00:00.000Z", "2026-10-10T00:00:00.000Z/2026-10-17T00:00:00.000Z"]);
  const event = h.audit.find((e) => e.action === "export-chargeback");
  assert.deepEqual({ actor: event.actor, from: event.from, to: event.to, kind: event.kind, rows: event.rows },
    { actor: ADMIN.name, from: "2026-10-10", to: "2026-10-16", kind: "all", rows: 3 });

  await h.service.usage(ADMIN, { kind: "jwt", from: "2026-10-10", to: "2026-10-16" });
  assert.equal(la.calls.length, 2, "the usage views and the report share the cached rows");
  const products = await h.service.chargeback(ADMIN, { kind: "product", days: 7 });
  assert.equal(products.rows, 1);
  assert.equal(products.filename, "chargeback-2026-10-09-2026-10-16.csv");
  assert.doesNotMatch(products.csv, /short-lived/);
  assert.equal((await h.service.chargeback(ADMIN, { kind: "jwt", days: "7" })).rows, 2);

  for (const bad of [{ kind: "both" }, { kind: "constructor" }, { kind: ["jwt"] }, { days: 5 }, { days: 7, from: "2026-10-10", to: "2026-10-16" },
    { from: "2026-10-10" }, { from: "2026-10-17", to: "2026-10-17" }]) {
    await assert.rejects(h.service.chargeback(ADMIN, bad), { status: 400 }, JSON.stringify(bad));
  }
  const bare = harness();
  await assert.rejects(bare.service.chargeback(ADMIN, { days: 7 }), { status: 409, message: /not configured/ }, "no workspace: no report rather than an empty one");
});

test("over HTTP: POST /api/chargeback, same-origin JSON only, for admins only", async () => {
  const { createServer } = await import("node:http");
  const { createHandler } = await import("../src/console/server.mjs");
  const { h } = await issued();
  const principal = (who, role) => Buffer.from(JSON.stringify({ auth_typ: "aad", role_typ: "roles",
    claims: [{ typ: "preferred_username", val: who.name }, { typ: "roles", val: role }] })).toString("base64");
  const server = createServer(createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (who, body, headers = {}) => fetch(`${base}/api/chargeback`, { method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-ms-client-principal": who, ...headers }, body: JSON.stringify(body) });
  try {
    const admin = principal(ADMIN, "Console.Admin");
    const ok = await post(admin, { from: "2026-10-10", to: "2026-10-16", kind: "all" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.equal(body.filename, "chargeback-2026-10-10-2026-10-16.csv");
    assert.match(body.csv, /^period_start_utc,/);
    assert.equal((await post(principal(ALICE, "Console.User"), { days: 7 })).status, 403);
    assert.equal((await post(admin, { days: 7 }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/chargeback`, { headers: { "x-ms-client-principal": admin } })).status, 404, "no GET");
    assert.equal((await post(admin, { days: 2 })).status, 400);
  } finally {
    server.close();
  }
});
