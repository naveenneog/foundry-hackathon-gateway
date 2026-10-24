// Key Dashboard — Overview: key counts and usage across both kinds for the chosen period.
// Four reads (two key lists, two usage summaries), cached briefly and never polled.

import { apiPath, cachedGet, invalidate, post } from "./api.js";
import { barList, donut, timeChart } from "./charts.js";
import { addChildren, busy, confirmDialog, el, errorState, icon, kpi, loadingState, setChildren, toast, uid } from "./dom.js";
import { alignSeries, DAY, fmtCompact, fmtInt, keyStatus, keyTitle, KINDS, mergeByModel, periodDays, periodKey, periodPhrase, periodQuery } from "./lib.js";
import { periodControl } from "./period.js";
import { openKeyDrawer } from "./views-drawer.js";

const TOP_KEYS = 8;

function card(title, slot, cls = "") {
  const id = uid("card");
  return el("section", { class: ["card", cls], "aria-labelledby": id }, el("h2", { class: "card-title", id }, title), slot);
}

/** "1 suspended": keys in the active list that are not active. */
function othersLine(keys) {
  if (!keys.length) return "none issued yet";
  const counts = new Map();
  for (const k of keys) {
    const s = keyStatus(k);
    if (s !== "active") counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts].map(([s, n]) => `${fmtInt(n)} ${s}`).join(" · ") || "all active";
}

export function renderOverview(root, ctx) {
  const refresh = el("button", { type: "button", class: "btn btn-secondary" }, icon("refresh"), "Refresh");
  const sweep = el("button", { type: "button", class: "btn btn-secondary" }, "Run automation now");
  const kpis = el("div", { class: "kpis" });
  const chartSlot = el("div", {});
  const topSlot = el("div", {});
  const modelSlot = el("div", {});
  const notes = el("div", {});
  addChildren(root,
    el("header", { class: "view-head" },
      el("div", {}, el("h1", { class: "view-title", tabindex: "-1" }, "Overview"),
        el("p", { class: "lede" }, "Every key and its usage, short-lived and product.")),
      el("div", { class: "view-actions" }, periodControl(ctx.period, (p) => { ctx.setPeriod(p); load(false); }), refresh, sweep)),
    kpis,
    card("Tokens over time", chartSlot),
    el("div", { class: "grid-2" }, card("Top keys", topSlot), card("By model", modelSlot)),
    notes);

  async function load(fresh) {
    const period = ctx.period;
    setChildren(kpis, loadingState("Loading the overview…", 1));
    for (const slot of [chartSlot, topSlot, modelSlot]) setChildren(slot, loadingState("Loading…", 3));
    setChildren(notes);
    const [jk, pk, ju, pu] = await Promise.allSettled([
      cachedGet(apiPath("/api/keys", { kind: "jwt", status: "active" }), { fresh }),
      cachedGet(apiPath("/api/keys", { kind: "product", status: "active" }), { fresh }),
      cachedGet(apiPath("/api/usage", { kind: "jwt", ...periodQuery(period) }), { fresh }),
      cachedGet(apiPath("/api/usage", { kind: "product", ...periodQuery(period) }), { fresh }),
    ]);
    if (periodKey(period) !== periodKey(ctx.period) || !root.isConnected) return;
    const keys = { jwt: jk.status === "fulfilled" ? jk.value.keys ?? [] : null, product: pk.status === "fulfilled" ? pk.value.keys ?? [] : null };
    const usage = { jwt: ju.status === "fulfilled" ? ju.value : null, product: pu.status === "fulfilled" ? pu.value : null };
    const failures = [jk, pk, ju, pu].filter((r) => r.status === "rejected").map((r) => r.reason);
    const total = (field) => ["jwt", "product"].reduce((sum, kind) => sum + (Number(usage[kind]?.total?.[field]) || 0), 0);
    const split = (field) => ["jwt", "product"].map((kind) => `${KINDS[kind].label} ${usage[kind] ? fmtCompact(usage[kind].total?.[field] ?? 0) : "—"}`).join(" · ");
    const count = (kind) => (keys[kind] ? keys[kind].filter((k) => keyStatus(k) === "active").length : null);

    setChildren(kpis,
      kpi({ label: "Active short-lived keys", value: keys.jwt ? fmtInt(count("jwt")) : "—", exact: count("jwt") ?? undefined, cls: "kpi-jwt", sub: keys.jwt ? othersLine(keys.jwt) : "could not be loaded" }),
      kpi({ label: "Active product keys", value: keys.product ? fmtInt(count("product")) : "—", exact: count("product") ?? undefined, cls: "kpi-product", sub: keys.product ? othersLine(keys.product) : "could not be loaded" }),
      kpi({ label: `Tokens, ${periodPhrase(period)}`, value: fmtCompact(total("tokens")), exact: total("tokens"), sub: split("tokens") }),
      kpi({ label: `Requests, ${periodPhrase(period)}`, value: fmtCompact(total("requests")), exact: total("requests"), sub: split("requests") }));

    const kinds = ["jwt", "product"].filter((kind) => usage[kind]);
    if (!kinds.length) {
      const retry = () => load(true);
      for (const slot of [chartSlot, topSlot, modelSlot]) setChildren(slot, errorState(ju.reason ?? pu.reason, retry));
      return;
    }
    const { times, step, values } = alignSeries(kinds.map((kind) => usage[kind].series), {
      days: periodDays(period), from: usage[kinds[0]].from, to: usage[kinds[0]].to,
    });
    const unit = step >= DAY ? "day" : "hour";
    const noted = kinds.some((kind) => usage[kind].note);
    setChildren(chartSlot,
      timeChart({ title: `Tokens per ${unit}, short-lived and product keys, ${periodPhrase(period)}`, times, step, height: 260,
        series: kinds.map((kind, i) => ({ name: KINDS[kind].label, cls: KINDS[kind].cls, values: values[i] })) }),
      el("p", { class: "field-hint" }, `${unit === "day" ? "Days are UTC days." : "Hours are in your local time."}${noted ? "" : " Usage arrives a few minutes after each call."}`));

    const byName = new Map(["jwt", "product"].flatMap((kind) => (keys[kind] ?? []).map((k) => [k.name, { ...k, kind }])));
    const top = kinds.flatMap((kind) => (usage[kind].byKey ?? []).map((u) => ({ ...u, kind })))
      .filter((u) => Number(u.tokens) > 0)
      .sort((a, b) => b.tokens - a.tokens).slice(0, TOP_KEYS);
    setChildren(topSlot, barList({
      label: "Keys using the most tokens",
      emptyText: "No key used tokens in this period.",
      items: top.map((u) => {
        const key = byName.get(u.name);
        return {
          label: key ? keyTitle(key) : u.name, sub: [KINDS[u.kind].label, key?.label ?? u.label, u.owner].filter(Boolean).join(" · "),
          value: Number(u.tokens) || 0, cls: KINDS[u.kind].cls,
          onSelect: key ? (e) => openKeyDrawer(ctx, key, { opener: e.currentTarget, onChanged: () => changed(key.kind) }) : undefined,
        };
      }),
    }), top.length ? el("p", { class: "field-hint" }, "Select a key for its details and usage.") : null);

    setChildren(modelSlot, donut({ title: "Tokens by model", items: mergeByModel(kinds.map((kind) => usage[kind].byModel)).map((m) => ({ label: m.model, value: m.tokens })) }));

    const messages = [...new Set([...kinds.map((kind) => usage[kind].note).filter(Boolean), ...failures.map((e) => e?.message).filter(Boolean)])];
    setChildren(notes, ...messages.map((m) => el("p", { class: "note" }, m)));
  }

  async function changed(kind) {
    invalidate("/api/keys", "/api/usage");
    await load(true);
    return (await cachedGet(apiPath("/api/keys", { kind, status: "active" }))).keys ?? [];
  }

  refresh.addEventListener("click", busy(refresh, () => load(true)));
  sweep.addEventListener("click", busy(sweep, async () => {
    const ok = await confirmDialog({
      title: "Run the automation now?", tone: "warn", confirmLabel: "Run now",
      message: "This runs the same sweep as the scheduled job:",
      points: ["Rotates product keys that are due.", "Archives expired and revoked keys, and product keys past their expiry.", "Deletes keys archived more than 30 days ago."],
    });
    if (!ok) return;
    const r = await post("/api/sweep", {});
    const n = (list) => (Array.isArray(list) ? list.length : 0);
    const failed = (Array.isArray(r.failed) ? r.failed : []).map((f) => (typeof f === "string" ? f : f?.name)).filter(Boolean);
    toast(`Automation: ${n(r.rotated)} rotated, ${n(r.archived)} archived, ${n(r.deleted)} deleted${failed.length ? `, ${failed.length} failed (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : ""}.`, failed.length ? "error" : "ok");
    invalidate("/api/keys", "/api/usage");
    await load(true);
  }));
  load(false);
}
