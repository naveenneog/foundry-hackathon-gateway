// P59: usage over a custom range of whole UTC days, beside the 1/7/30/90-day presets. The range is
// validated at the boundary; the KQL holds only datetime literals the code builds from it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildUsageQuery, aggregateUsage, bucketFor, resolvePeriod, usageGrid } from "../src/console/usage.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = Date.parse("2026-10-16T09:00:00Z");
const utc = (s) => Date.parse(`${s}T00:00:00Z`);

test("resolvePeriod: days alone behaves as before; a range is from and to, inclusive whole UTC days", () => {
  assert.deepEqual(resolvePeriod({}, T), { days: 7, range: null, start: T - 7 * DAY, end: T, bucket: bucketFor(7), key: "d7" });
  assert.equal(resolvePeriod({ days: "30" }, T).days, 30);
  assert.equal(resolvePeriod({ days: 1 }, T).bucket.kql, "1h");
  const r = resolvePeriod({ from: "2026-10-01", to: "2026-10-05" }, T);
  assert.deepEqual(r, { days: 5, range: { from: "2026-10-01", to: "2026-10-05" }, start: utc("2026-10-01"), end: utc("2026-10-06"),
    bucket: { ms: DAY, kql: "1d" }, key: "2026-10-01..2026-10-05" });
  assert.equal(resolvePeriod({ from: "2026-10-16", to: "2026-10-16" }, T).bucket.kql, "1h", "one day: hourly");
  assert.equal(resolvePeriod({ from: "2026-10-14", to: "2026-10-15" }, T).bucket.kql, "1h", "two days: hourly");
  assert.equal(resolvePeriod({ from: "2026-10-13", to: "2026-10-15" }, T).bucket.kql, "1d", "three days: daily");
  assert.equal(resolvePeriod({ from: "2026-07-19", to: "2026-10-16" }, T).days, 90, "today and the 89 days before it");
  assert.equal(new Date(utc("2026-10-16") - 89 * DAY).toISOString().slice(0, 10), "2026-07-19");
});

test("resolvePeriod refuses anything but strict YYYY-MM-DD, both or neither, in order, no later than today and no earlier than 89 days before it", () => {
  const refused = [
    [{ days: 7, from: "2026-10-01", to: "2026-10-05" }, /not both/],
    [{ from: "2026-10-01" }, /both from and to/],
    [{ to: "2026-10-05" }, /both from and to/],
    [{ from: "2026-10-1", to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: "2026-02-30", to: "2026-03-01" }, /YYYY-MM-DD/],
    [{ from: "2026-10-01T00:00", to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: " 2026-10-01", to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: "+2026-10-01", to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: "2026/10/01", to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: '2026-10-01") | union *', to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: 20261001, to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: ["2026-10-01"], to: "2026-10-05" }, /YYYY-MM-DD/],
    [{ from: "2026-10-06", to: "2026-10-05" }, /on or before/],
    [{ from: "2026-10-15", to: "2026-10-17" }, /after today/],
    [{ from: "2026-07-18", to: "2026-10-01" }, /2026-07-19/],
    [{ days: 5 }, /1, 7, 30, 90/],
  ];
  for (const [query, message] of refused) {
    assert.throws(() => resolvePeriod(query, T), (e) => e.name === "InputError" && message.test(e.message), JSON.stringify(query));
  }
});

test("buildUsageQuery: a range filters on datetime literals built from validated days; it never formats raw input", () => {
  const p = resolvePeriod({ from: "2026-10-01", to: "2026-10-05" }, T);
  const q = buildUsageQuery({ kind: "jwt", period: p });
  assert.match(q, /\| where TimeGenerated >= datetime\(2026-10-01T00:00:00\.000Z\) and TimeGenerated < datetime\(2026-10-06T00:00:00\.000Z\)/);
  assert.match(q, /bin\(TimeGenerated, 1d\)/);
  assert.doesNotMatch(q, /ago\(/);
  assert.match(buildUsageQuery({ kind: "product", period: resolvePeriod({ from: "2026-10-14", to: "2026-10-15" }, T) }), /Route == "poc"[\s\S]*bin\(TimeGenerated, 1h\)/);
  assert.match(buildUsageQuery({ kind: "jwt", period: resolvePeriod({ days: "30" }, T) }), /ago\(30d\)/, "a preset still uses ago()");
  for (const bad of [
    { ...p, start: "2026-10-01" }, { ...p, start: p.start + HOUR }, { ...p, end: p.start }, { ...p, start: Number.NaN },
    { ...p, start: p.end - 91 * DAY }, { ...p, end: `${p.end}) | union *` },
  ]) assert.throws(() => buildUsageQuery({ kind: "jwt", period: bad }), /whole UTC days/, JSON.stringify(bad));
});

test("usageGrid: zero-filled buckets for a range, capped at the current bucket; presets keep their grid", () => {
  const daily = usageGrid(resolvePeriod({ from: "2026-10-01", to: "2026-10-05" }, T), T);
  assert.deepEqual(daily, { first: utc("2026-10-01"), count: 5, step: DAY });
  const today = usageGrid(resolvePeriod({ from: "2026-10-10", to: "2026-10-16" }, T), T);
  assert.deepEqual(today, { first: utc("2026-10-10"), count: 7, step: DAY });
  const hourly = usageGrid(resolvePeriod({ from: "2026-10-14", to: "2026-10-15" }, T), T);
  assert.deepEqual(hourly, { first: utc("2026-10-14"), count: 48, step: HOUR });
  const now = usageGrid(resolvePeriod({ from: "2026-10-16", to: "2026-10-16" }, T), T);
  assert.deepEqual(now, { first: utc("2026-10-16"), count: 10, step: HOUR }, "00:00 to 09:00, not the hours still to come");
  assert.deepEqual(usageGrid(resolvePeriod({ days: 7 }, T), T), { first: utc("2026-10-10"), count: 7, step: DAY });
  assert.deepEqual(usageGrid(resolvePeriod({ days: 1 }, T), T), { first: T - 23 * HOUR, count: 24, step: HOUR });

  const rows = [
    { Bucket: "2026-10-14T05:00:00.000Z", KeyId: "k", Model: "m", Name: "Total Tokens", Tokens: 7, Calls: 1 },
    { Bucket: "2026-10-15T23:00:00.000Z", KeyId: "k", Model: "m", Name: "Total Tokens", Tokens: 3, Calls: 1 },
  ];
  const u = aggregateUsage(rows, { keys: new Map([["k", { name: "jwt-k" }]]), includeUnknown: false, grid: hourly });
  assert.equal(u.series.length, 48);
  assert.equal(u.series[0].t, "2026-10-14T00:00:00.000Z");
  assert.equal(u.series[5].tokens, 7);
  assert.equal(u.series[47].tokens, 3);
  assert.equal(u.series.reduce((a, s) => a + s.tokens, 0), 10);
});

function laFake() {
  const calls = [];
  return { calls, async query(q, opts) { calls.push({ q, opts }); return []; } };
}

test("service usage over a range: the window goes to Log Analytics, the cache key holds it, and the answer says what it covers", async () => {
  const h = harness();
  const la = laFake();
  h.service.setUsageSource(la);
  const u = await h.service.usage(ADMIN, { kind: "jwt", from: "2026-10-10", to: "2026-10-14" });
  assert.equal(la.calls[0].opts.timespan, "2026-10-10T00:00:00.000Z/2026-10-15T00:00:00.000Z");
  assert.match(la.calls[0].q, /datetime\(2026-10-10T00:00:00\.000Z\)/);
  assert.deepEqual(u.range, { from: "2026-10-10", to: "2026-10-14" });
  assert.equal(u.days, 5);
  assert.equal(u.from, "2026-10-10T00:00:00.000Z");
  assert.equal(u.to, "2026-10-14T23:59:59.999Z");
  assert.equal(u.bucket, "day");
  assert.deepEqual(u.series.map((p) => p.t), ["10", "11", "12", "13", "14"].map((d) => `2026-10-${d}T00:00:00.000Z`));

  await h.service.usage(ADMIN, { kind: "jwt", from: "2026-10-10", to: "2026-10-14" });
  assert.equal(la.calls.length, 1, "the same range reuses the cached rows");
  await h.service.usage(ADMIN, { kind: "jwt", from: "2026-10-09", to: "2026-10-13" });
  await h.service.usage(ADMIN, { kind: "jwt", from: "2026-10-10", to: "2026-10-16" });
  await h.service.usage(ADMIN, { kind: "jwt", days: 7 });
  assert.equal(la.calls.length, 4, "another range of the same length, or a preset of as many days, is its own query");
  assert.equal(la.calls[3].opts.timespan, "P7D");

  const today = await h.service.usage(ADMIN, { kind: "product", from: "2026-10-16", to: "2026-10-16" });
  assert.equal(today.bucket, "hour");
  assert.equal(today.to, new Date(T).toISOString(), "a range ending today ends now");
  assert.equal(today.series.length, 10);

  await assert.rejects(h.service.usage(ALICE, { kind: "jwt", from: "2026-10-10", to: "2026-10-14" }), { status: 403 });
  for (const bad of [{ days: "7", from: "2026-10-10", to: "2026-10-14" }, { from: "2026-10-10" }, { from: "2026-13-01", to: "2026-10-14" },
    { from: "2026-10-15", to: "2026-10-14" }, { from: "2026-10-14", to: "2026-10-17" }, { from: "2026-07-01", to: "2026-07-31" }]) {
    await assert.rejects(h.service.usage(ADMIN, { kind: "jwt", ...bad }), { status: 400 }, JSON.stringify(bad));
  }
  assert.equal(la.calls.length, 5, "a refused range never reaches Log Analytics");
});

test("service keyUsage over a range: one key's series, with the window it covers", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const a = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t", models: ["flash"], budget: 9, hours: 48 });
  const la = { calls: [], async query(q, opts) { this.calls.push({ q, opts }); return [{ Bucket: "2026-10-15T00:00:00.000Z", KeyId: a.jti, Model: "flash", Name: "Total Tokens", Tokens: 5, Calls: 1 }]; } };
  h.service.setUsageSource(la);
  const u = await h.service.keyUsage(ADMIN, a.name, { from: "2026-10-12", to: "2026-10-15" });
  assert.equal(u.total.tokens, 5);
  assert.deepEqual(u.range, { from: "2026-10-12", to: "2026-10-15" });
  assert.equal(u.from, "2026-10-12T00:00:00.000Z");
  assert.equal(u.series.length, 4);
  assert.equal(u.series.at(-1).tokens, 5);
  assert.match(la.calls[0].q, new RegExp(`KeyId == "${a.jti}"`));
  assert.equal(la.calls[0].opts.timespan, "2026-10-12T00:00:00.000Z/2026-10-16T00:00:00.000Z");
  await assert.rejects(h.service.keyUsage(ADMIN, a.name, { days: 7, from: "2026-10-12", to: "2026-10-15" }), { status: 400 });
  const preset = await h.service.keyUsage(ADMIN, a.name, { days: 30 });
  assert.equal(preset.days, 30);
  assert.equal(preset.range, undefined, "a preset answer has no range");
});

test("the browser and the server bucket a period the same way: hourly up to two days, daily beyond", async () => {
  const ui = await import("../src/console/public/lib.js");
  for (let days = 1; days <= 90; days++) assert.equal(ui.bucketMs(days), bucketFor(days).ms, `${days} days`);
});

test("over HTTP the usage APIs take days, or from and to, never both", async () => {
  const { createServer } = await import("node:http");
  const { createHandler } = await import("../src/console/server.mjs");
  const h = harness();
  h.service.setUsageSource({ async query() { return []; } });
  await h.service.migrateSigningSecret(ADMIN);
  const key = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t", models: ["flash"], budget: 9, hours: 48 });
  const header = Buffer.from(JSON.stringify({ auth_typ: "aad", role_typ: "roles", claims: [{ typ: "preferred_username", val: ADMIN.name }, { typ: "roles", val: "Console.Admin" }] })).toString("base64");
  const server = createServer(createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { "x-ms-client-principal": header } });
  try {
    const u = await (await get("/api/usage?kind=jwt&from=2026-10-01&to=2026-10-05")).json();
    assert.deepEqual(u.range, { from: "2026-10-01", to: "2026-10-05" });
    assert.equal((await (await get("/api/usage?kind=jwt&days=30")).json()).days, 30, "days alone, as before");
    assert.equal((await get("/api/usage?kind=jwt&days=7&from=2026-10-01&to=2026-10-05")).status, 400);
    assert.equal((await get("/api/usage?kind=jwt&from=2026-10-01")).status, 400);
    assert.equal((await get("/api/usage?kind=jwt&from=2026-10-01&to=2026-10-32")).status, 400);
    const one = await get(`/api/usage/${key.name}?from=2026-10-15&to=2026-10-16`);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).series.length, 34, "two days, hourly, up to 09:00 today");
    assert.equal((await get(`/api/usage/${key.name}?days=7&to=2026-10-16`)).status, 400);
  } finally {
    server.close();
  }
});
