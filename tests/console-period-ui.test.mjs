// Key Dashboard UI, P59: the usage period is a preset (24 h, 7, 30 or 90 days) or a custom range
// of whole UTC days. lib.js helpers run as they are, the period control (period.js) runs on the
// fake DOM, and the views are checked statically for how they request and label a period.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fakeDom, fakeEvent } from "./console-dom.harness.mjs";
import { resolvePeriod, MAX_RANGE_DAYS } from "../src/console/usage.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, PUBLIC), "utf8");
const JS = readdirSync(PUBLIC).filter((n) => n.endsWith(".js")).sort();
const source = Object.fromEntries(JS.map((n) => [n, read(n)]));

const lib = await import(new URL("lib.js", PUBLIC));
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));

const NOW = Date.parse("2026-10-16T09:00:00Z");
const space = (s) => String(s).replace(/[\s\u2009\u202f]+/g, " ");

test("a period is a number of days or { from, to }: query, cache key, length and labels", () => {
  const range = { from: "2026-10-01", to: "2026-10-05" };
  assert.equal(lib.isRange(range), true);
  assert.equal(lib.isRange(7), false);
  assert.deepEqual(lib.periodQuery(7), { days: 7 });
  assert.deepEqual(lib.periodQuery(range), { from: "2026-10-01", to: "2026-10-05" });
  assert.equal(api.apiPath("/api/usage", { kind: "jwt", ...lib.periodQuery(range) }), "/api/usage?kind=jwt&from=2026-10-01&to=2026-10-05");
  assert.equal(api.isCacheable("/api/usage?kind=jwt&from=2026-10-01&to=2026-10-05"), true);
  assert.notEqual(lib.periodKey(range), lib.periodKey({ from: "2026-10-02", to: "2026-10-06" }));
  assert.notEqual(lib.periodKey(5), lib.periodKey(range), "five days and a five-day range are different periods");
  assert.equal(lib.periodKey({ ...range }), lib.periodKey(range), "equal ranges are the same period");
  assert.equal(lib.periodDays(range), 5);
  assert.equal(lib.periodDays({ from: "2026-10-16", to: "2026-10-16" }), 1);
  assert.equal(lib.periodDays(30), 30);
  assert.equal(lib.periodLabel(1), "24 hours");
  assert.equal(lib.periodLabel(30), "30 days");
  assert.equal(space(lib.periodLabel(range, "en-US")), "Oct 1 – 5, 2026");
  assert.equal(space(lib.periodLabel({ from: "2026-09-28", to: "2026-10-02" }, "en-GB")), "28 Sept – 2 Oct 2026");
  assert.equal(space(lib.periodLabel({ from: "2026-10-16", to: "2026-10-16" }, "en-US")), "Oct 16, 2026");
  assert.equal(lib.periodPhrase(7), "last 7 days");
  assert.equal(space(lib.periodPhrase(range, "en-US")), "Oct 1 – 5, 2026 (UTC)");
});

test("checkRange gives early feedback that matches what the server accepts", () => {
  assert.deepEqual(lib.rangeLimits(NOW), { min: "2026-07-19", max: "2026-10-16" });
  assert.equal(lib.RANGE_DAYS, MAX_RANGE_DAYS, "the browser and the server allow the same 90 days");
  const cases = [
    ["2026-10-01", "2026-10-05"], ["2026-10-16", "2026-10-16"], ["2026-07-19", "2026-10-16"], ["2026-07-18", "2026-10-16"],
    ["2026-10-06", "2026-10-05"], ["2026-10-15", "2026-10-17"], ["2026-02-30", "2026-03-01"], ["2026-09-31", "2026-10-05"], ["", "2026-10-05"], ["2026-10-01", ""],
    [" 2026-10-01", "2026-10-05"], ["2026-10-1", "2026-10-05"], ["2026-10-01T00:00", "2026-10-05"], ["junk", "junk"],
  ];
  for (const [from, to] of cases) {
    let accepted = true;
    try { resolvePeriod({ from, to }, NOW); } catch { accepted = false; }
    const errors = lib.checkRange(from, to, NOW);
    assert.equal(Object.keys(errors).length === 0, accepted, `${JSON.stringify([from, to])}: browser ${JSON.stringify(errors)}, server ${accepted}`);
  }
  assert.match(lib.checkRange("2026-07-18", "2026-10-01", NOW).from, /2026-07-19/);
  assert.match(lib.checkRange("2026-10-01", "2026-10-17", NOW).to, /after today/);
  assert.match(lib.checkRange("2026-10-06", "2026-10-05", NOW).to, /on or after/);
});

test("alignSeries puts a two-day range on hourly buckets and a longer one on daily buckets", () => {
  const hourly = lib.alignSeries([[{ t: "2026-10-14T05:00:00.000Z", tokens: 7 }]],
    { days: lib.periodDays({ from: "2026-10-14", to: "2026-10-15" }), from: "2026-10-14T00:00:00.000Z", to: "2026-10-15T23:59:59.999Z" });
  assert.equal(hourly.step, lib.HOUR);
  assert.equal(hourly.times.length, 48);
  assert.equal(hourly.values[0][5], 7);
  const daily = lib.alignSeries([[]], { days: 5, from: "2026-10-01T00:00:00.000Z", to: "2026-10-05T23:59:59.999Z" });
  assert.equal(daily.step, lib.DAY);
  assert.equal(daily.times.length, 5);
});

// ── period.js on the fake DOM ───────────────────────────────────────────────

const { periodControl } = await import(new URL("period.js", PUBLIC));

function mount(value) {
  const doc = fakeDom();
  globalThis.document = doc;
  const changes = [];
  const control = periodControl(value, (p) => changes.push(p), { now: () => NOW });
  dom.addChildren(doc.body, control);
  return { doc, control, changes };
}
const radio = (control, value) => control.querySelectorAll('input[type="radio"]').find((r) => r.value === String(value));
function choose(control, value) {
  const r = radio(control, value);
  for (const other of control.querySelectorAll('input[type="radio"]')) other.checked = other === r;
  r.dispatchEvent(fakeEvent("change"));
}
const labelOf = (control, input) => control.querySelectorAll("label").find((l) => l.getAttribute("for") === input.getAttribute("id"));
const submit = (form) => form.dispatchEvent(fakeEvent("submit"));

test("the period control: four presets and Custom as one radio group; Custom shows labelled UTC date inputs without moving focus", () => {
  const { doc, control, changes } = mount(7);
  try {
    const group = control.querySelector("fieldset");
    assert.equal(group.querySelector("legend").textContent, "Usage period");
    assert.deepEqual(control.querySelectorAll('input[type="radio"]').map((r) => r.value), ["1", "7", "30", "90", "custom"]);
    assert.equal(radio(control, 7).checked, true);
    assert.equal(control.getAttribute("data-help"), "usage-period", "the guide can highlight it");
    assert.ok(radio(control, 7).hasAttribute("data-help-focus"), "the guide focuses the chosen period");
    const form = control.querySelector("form");
    assert.equal(form.hidden, true, "no date inputs until Custom is chosen");

    const before = doc.activeElement;
    choose(control, "custom");
    assert.equal(form.hidden, false);
    assert.deepEqual(changes, [], "choosing Custom loads nothing until a range is applied");
    assert.equal(doc.activeElement, before, "arrowing through the options does not pull focus into the form");
    assert.ok(radio(control, "custom").hasAttribute("data-help-focus"));
    assert.equal(radio(control, 7).hasAttribute("data-help-focus"), false);

    const [from, to] = form.querySelectorAll('input[type="date"]');
    assert.equal(labelOf(control, from).textContent, "From (UTC)");
    assert.equal(labelOf(control, to).textContent, "To (UTC)");
    for (const input of [from, to]) {
      assert.equal(input.getAttribute("min"), "2026-07-19");
      assert.equal(input.getAttribute("max"), "2026-10-16");
      const described = input.getAttribute("aria-describedby").split(" ").map((id) => doc.getElementById(id)?.textContent ?? "").join(" ");
      assert.match(described, /UTC days/);
      assert.match(described, /90 days at no charge/);
    }
    assert.equal(from.value, "2026-10-10", "starts as the last seven days");
    assert.equal(to.value, "2026-10-16");
    assert.ok(form.querySelector('button[type="submit"]'), "Apply submits, so Enter in a date input applies too");
  } finally {
    delete globalThis.document;
  }
});

test("the period control applies a valid range, refuses an invalid one on its field, and a preset hides the range again", () => {
  const { doc, control, changes } = mount(7);
  try {
    choose(control, "custom");
    const form = control.querySelector("form");
    const [from, to] = form.querySelectorAll('input[type="date"]');
    from.value = "2026-10-06";
    to.value = "2026-10-05";
    submit(form);
    assert.deepEqual(changes, [], "nothing is loaded for an invalid range");
    assert.equal(to.getAttribute("aria-invalid"), "true");
    assert.equal(doc.activeElement, to, "focus moves to the field to fix");
    const error = doc.getElementById(`${to.getAttribute("id")}-error`);
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /on or after/);

    from.value = "2026-10-01";
    submit(form);
    assert.deepEqual(changes, [{ from: "2026-10-01", to: "2026-10-05" }]);
    assert.equal(to.hasAttribute("aria-invalid"), false, "the error clears once the range is valid");

    from.value = "2026-07-01";
    submit(form);
    assert.equal(changes.length, 1);
    assert.equal(doc.activeElement, from);
    assert.match(doc.getElementById(`${from.getAttribute("id")}-error`).textContent, /2026-07-19/);

    choose(control, 30);
    assert.equal(form.hidden, true);
    assert.deepEqual(changes.at(-1), 30);
  } finally {
    delete globalThis.document;
  }
});

test("a control created for a range shows it: Custom chosen and the dates filled in", () => {
  const { control } = mount({ from: "2026-09-20", to: "2026-10-04" });
  try {
    assert.equal(radio(control, "custom").checked, true);
    const form = control.querySelector("form");
    assert.equal(form.hidden, false);
    assert.deepEqual(form.querySelectorAll('input[type="date"]').map((i) => i.value), ["2026-09-20", "2026-10-04"]);
  } finally {
    delete globalThis.document;
  }
});

test("the Overview, both key pages and the key drawer request and label usage by period, presets or a range", () => {
  for (const name of ["views-overview.js", "views-keys.js", "views-drawer.js"]) {
    assert.match(source[name], /import \{ periodControl \} from "\.\/period\.js";/, name);
    assert.match(source[name], /periodQuery\(/, `${name} sends days, or from and to`);
    assert.doesNotMatch(source[name], /\{ days(?:: want)? \}|kind(?:: "(?:jwt|product)")?, days \}/, `${name} no longer sends days alone`);
  }
  assert.doesNotMatch(source["dom.js"], /periodSwitch/, "the preset-only switch is gone");
  for (const name of ["views-overview.js", "views-keys.js"]) assert.match(source[name], /periodKey\(/, `${name} drops an answer for a period no longer chosen`);
  assert.match(source["views-overview.js"], /periodPhrase\(/);
  assert.match(source["charts.js"], /periodDays\(period\)/, "a chart's buckets follow the period's length");
  assert.match(source["charts.js"], /periodPhrase\(period\)/);
  const server = readFileSync(new URL("../src/console/server.mjs", import.meta.url), "utf8");
  assert.match(server, /"\/period\.js": \["period\.js", "text\/javascript; charset=utf-8"\]/);
});

test("a chart's data table is hidden inside a block: a table ignores width 1px, and at 390 px it widened the page", async () => {
  const { timeChart } = await import(new URL("charts.js", PUBLIC));
  const doc = fakeDom();
  globalThis.document = doc;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} };
  try {
    const times = Array.from({ length: 48 }, (_, i) => Date.UTC(2026, 9, 14) + i * lib.HOUR);
    const fig = timeChart({ title: "Tokens per hour", times, step: lib.HOUR, series: [{ name: "Short-lived", cls: "s-jwt", values: times.map((_, i) => i) }] });
    const table = fig.querySelector("table");
    assert.ok(table, "the data is there for assistive technology");
    assert.equal(table.classList.contains("sr-only"), false, "the table itself is not the hidden box");
    assert.ok(table.parentNode.classList.contains("sr-only"), "a visually hidden block holds it");
    assert.equal(table.parentNode.tagName, "div");
    assert.equal(table.querySelector("tbody").querySelectorAll("tr").length, 48);
  } finally {
    delete globalThis.document;
    delete globalThis.ResizeObserver;
  }
});
