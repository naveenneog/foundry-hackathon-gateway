// liteAPIM — Short-lived keys and Product keys: usage for the kind, then the key list with
// Active | Archived, search, status filter, sorting, export selection and a per-key drawer.

import { apiPath, cachedGet, invalidate, keyPath, post } from "./api.js";
import { usageBody } from "./charts.js";
import {
  addChildren, badge, busy, confirmDialog, el, emailText, emptyState, errorState, icon, loadingState, modelChips,
  segmented, setChildren, statusBadge, toast, uid,
} from "./dom.js";
import {
  deleteDate, fmtCompact, fmtDate, fmtDateTime, fmtInt, fmtRelative, fmtShortDateTime, keyStatus, keyTitle, KINDS, matchesQuery, periodKey, periodLabel,
  periodQuery, sortKeys, STATUSES, withUsage,
} from "./lib.js";
import { periodControl } from "./period.js";
import { revealKey } from "./secret.js";
import { keyFoundry } from "./foundry.js";
import { openKeyDrawer } from "./views-drawer.js";
import { renderBulk, renderIssue } from "./views-issue.js";

const PAGE = 100;

/** The key's models, and the Foundry they belong to (the default for keys issued before ADR-0017). */
const modelsCell = (k) => el("td", {}, modelChips(k.models), el("span", { class: "cell-sub" }, "Foundry: ", keyFoundry(k).name));

// Kept for the page's lifetime, so coming back to a view keeps its filters and sort.
const prefs = {
  jwt: { status: "active", query: "", only: "", sort: ["key", "asc"], limit: PAGE },
  product: { status: "active", query: "", only: "", sort: ["key", "asc"], limit: PAGE },
};

function subNav(kind, sub) {
  const base = `#/${KINDS[kind].route}`;
  const link = (href, label, current) => el("a", { href, class: "subnav-link", "aria-current": current ? "page" : undefined }, label);
  return el("nav", { class: "subnav", "aria-label": `${KINDS[kind].title} sections` },
    link(base, "Keys", !sub), link(`${base}/issue`, "Issue one", sub === "issue"), link(`${base}/bulk`, "Issue in bulk", sub === "bulk"));
}

export function renderKeysView(root, ctx, kind, sub) {
  const meta = KINDS[kind];
  const refresh = el("button", { type: "button", class: "btn btn-secondary" }, icon("refresh"), "Refresh");
  addChildren(root, el("header", { class: "view-head" },
    el("div", {}, el("h1", { class: "view-title", tabindex: "-1" }, meta.title),
      el("p", { class: "lede" }, kind === "jwt"
        ? "Signed keys with a start, an expiry, models and a token budget. Send each one by copy, keys.csv or an encrypted bundle."
        : "API Management subscription keys, stored in Key Vault, with rotation.")),
    sub ? null : el("div", { class: "view-actions" }, refresh)));
  addChildren(root, subNav(kind, sub));
  if (sub === "issue") return renderIssue(root, ctx, kind);
  if (sub === "bulk") return renderBulk(root, ctx, kind);

  const p = prefs[kind];
  const usageId = uid("usage");
  const usageSlot = el("div", {});
  const usageCard = el("section", { class: "card", "aria-labelledby": usageId },
    el("div", { class: "card-head" }, el("h2", { class: "card-title", id: usageId }, "Usage"),
      periodControl(ctx.period, (p) => { ctx.setPeriod(p); loadUsage(false); })),
    usageSlot);
  const listId = uid("list");
  const listSlot = el("div", {});
  const countText = el("p", { class: "count", "aria-live": "polite" });
  const selectionBar = el("div", { class: "selection-bar", hidden: true });
  const search = el("input", { type: "search", class: "input", placeholder: "Search name, issued to, label, Foundry or model", value: p.query, "aria-label": `Search ${meta.title.toLowerCase()}` });
  const only = el("select", { class: "input", "aria-label": "Status" });
  const listCard = el("section", { class: "card", "aria-labelledby": listId },
    el("div", { class: "card-head" }, el("h2", { class: "card-title", id: listId }, "Keys"),
      segmented({ label: "Show", value: p.status, cls: "seg-sm", options: [{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }],
        onChange: (s) => { p.status = s; p.limit = PAGE; p.only = ""; loadKeys(false); } })),
    el("div", { class: "toolbar" },
      el("div", { class: "search" }, icon("search", "icon search-icon"), search), only, countText),
    selectionBar, listSlot);
  only.hidden = true;
  addChildren(root, usageCard, listCard);

  // The status filter offers only the statuses present in the list, so it never offers an empty choice.
  let statusSet = "";
  function syncStatusFilter(rows) {
    const present = STATUSES.filter((s) => rows.some((k) => k.status === s));
    if (!present.includes(p.only)) p.only = "";
    only.hidden = present.length < 2;
    if (present.join() === statusSet) return;
    statusSet = present.join();
    setChildren(only, el("option", { value: "" }, "Any status"), present.map((s) => el("option", { value: s }, s)));
    only.value = p.only;
  }

  let keys = null;
  let usage = null;
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { p.query = search.value; p.limit = PAGE; renderList(); }, 150);
  });
  only.addEventListener("change", () => { p.only = only.value; p.limit = PAGE; renderList(); });
  refresh.addEventListener("click", busy(refresh, async () => { await Promise.all([loadUsage(true), loadKeys(true)]); }));

  async function loadUsage(fresh) {
    const period = ctx.period;
    usage = null;
    setChildren(usageSlot, loadingState("Loading usage…", 2));
    renderList();
    try {
      const data = await cachedGet(apiPath("/api/usage", { kind, ...periodQuery(period) }), { fresh });
      if (periodKey(period) !== periodKey(ctx.period)) return;
      usage = data;
      setChildren(usageSlot, usageBody(kind, data, period));
    } catch (error) {
      usage = { error };
      setChildren(usageSlot, errorState(error, () => loadUsage(true)));
    }
    renderList();
  }

  async function loadKeys(fresh) {
    const status = p.status;
    keys = null;
    setChildren(listSlot, loadingState("Loading keys…", 4));
    countText.textContent = "";
    try {
      const data = await cachedGet(apiPath("/api/keys", { kind, status }), { fresh });
      if (status !== p.status) return [];
      keys = Array.isArray(data.keys) ? data.keys : [];
    } catch (error) {
      keys = { error };
    }
    renderList();
    return Array.isArray(keys) ? keys : [];
  }

  async function changed() {
    invalidate(`/api/keys?kind=${kind}`, "/api/usage");
    const [list] = await Promise.all([loadKeys(true), loadUsage(true)]);
    return list;
  }

  function renderSelectionBar() {
    const n = ctx.selection.size;
    selectionBar.hidden = n === 0;
    if (selectionBar.hidden) return;
    setChildren(selectionBar,
      el("p", {}, el("strong", {}, fmtInt(n)), n === 1 ? " key selected for export" : " keys selected for export"),
      el("a", { class: "btn btn-primary btn-sm", href: "#/export" }, "Export…"),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { ctx.clearSelection(); renderList(); } }, "Clear"));
  }

  function renderList() {
    renderSelectionBar();
    if (keys === null) return;
    if (keys.error) {
      setChildren(listSlot, errorState(keys.error, () => loadKeys(true)));
      return;
    }
    const rows = withUsage(keys, usage && !usage.error ? usage.byKey : null).map((k) => ({ ...k, status: keyStatus(k) }));
    syncStatusFilter(rows);
    const filtered = rows.filter((k) => matchesQuery(k, p.query) && (!p.only || k.status === p.only));
    countText.textContent = filtered.length === rows.length ? `${fmtInt(rows.length)} ${rows.length === 1 ? "key" : "keys"}` : `${fmtInt(filtered.length)} of ${fmtInt(rows.length)} keys`;
    if (!rows.length) {
      setChildren(listSlot, p.status === "archived"
        ? emptyState("Nothing is archived.", "Expired, revoked and archived keys are listed here, and deleted 30 days after archiving.")
        : emptyState(`No ${meta.noun}s yet.`, "Issue one, or many at once from a CSV file.",
          el("a", { class: "btn btn-primary btn-sm", href: `#/${meta.route}/issue` }, "Issue one"),
          el("a", { class: "btn btn-secondary btn-sm", href: `#/${meta.route}/bulk` }, "Issue in bulk")));
      return;
    }
    if (!filtered.length) {
      setChildren(listSlot, emptyState("No keys match.", "Try fewer words, or another status.",
        el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { p.query = ""; p.only = ""; search.value = ""; only.value = ""; renderList(); } }, "Clear filters")));
      return;
    }
    const sorted = sortKeys(filtered, ...p.sort);
    const shown = sorted.slice(0, p.limit);
    setChildren(listSlot, table(shown, filtered),
      sorted.length > shown.length ? el("div", { class: "pager" },
        el("p", { class: "muted" }, `Showing ${fmtInt(shown.length)} of ${fmtInt(sorted.length)}`),
        el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { p.limit += PAGE; renderList(); } }, `Show ${fmtInt(Math.min(PAGE, sorted.length - shown.length))} more`)) : null);
  }

  function sortHeader(label, by, firstDir = "asc") {
    const [cur, dir] = p.sort;
    const active = cur === by;
    const button = el("button", { type: "button", class: "th-sort", "data-sort": by }, label,
      el("span", { class: "sort-mark", "aria-hidden": "true" }, active ? (dir === "asc" ? "↑" : "↓") : "↕"));
    button.addEventListener("click", () => {
      p.sort = [by, active ? (dir === "asc" ? "desc" : "asc") : firstDir];
      renderList();
      listSlot.querySelector(`[data-sort="${by}"]`)?.focus();
    });
    return el("th", { scope: "col", "aria-sort": active ? (dir === "asc" ? "ascending" : "descending") : undefined }, button);
  }

  function table(shown, filtered) {
    const archived = p.status === "archived";
    const selectable = !archived;
    const usageHead = `Usage, ${periodLabel(ctx.period)}`;
    let all = null;
    if (selectable) {
      all = el("input", { type: "checkbox", "aria-label": `Select all ${fmtInt(filtered.length)} listed keys for export` });
      const picked = filtered.filter((k) => ctx.selection.has(k.name)).length;
      all.checked = picked > 0 && picked === filtered.length;
      all.indeterminate = picked > 0 && picked < filtered.length;
      all.addEventListener("change", () => {
        for (const k of filtered) ctx.select(k, all.checked);
        renderList();
        listSlot.querySelector(".col-check input")?.focus();
      });
    }
    const head = archived
      ? [sortHeader("Key", "key"), sortHeader("Issued to", "owner"), el("th", { scope: "col" }, "Models"), el("th", { scope: "col" }, "Why"), sortHeader("Archived", "archived", "desc"), el("th", { scope: "col" }, "Deleted on"), el("th", { scope: "col" }, el("span", { class: "sr-only" }, "Actions"))]
      : [selectable ? el("th", { scope: "col", class: "col-check" }, all) : null, sortHeader("Key", "key"), sortHeader("Issued to", "owner"),
        el("th", { scope: "col" }, "Models"), el("th", { scope: "col", class: "num" }, kind === "jwt" ? "Budget" : "Monthly"),
        sortHeader(usageHead, "usage", "desc"), kind === "jwt" ? sortHeader("Valid", "expires") : sortHeader("Rotation", "rotated", "desc"),
        el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, el("span", { class: "sr-only" }, "Actions"))];
    return el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("caption", { class: "sr-only" }, `${archived ? "Archived" : "Active"} ${meta.title.toLowerCase()}`),
      el("thead", {}, el("tr", {}, head)),
      el("tbody", {}, shown.map((k) => (archived ? archivedRow(k) : activeRow(k, selectable))))));
  }

  function keyCell(k) {
    const open = el("button", { type: "button", class: "link-btn key-name", "data-focus-id": `open:${k.name}` }, keyTitle(k));
    open.addEventListener("click", () => drawer(k, open));
    return el("th", { scope: "row", class: "key-cell" }, open,
      k.label ? el("span", { class: "key-sub" }, k.label) : null,
      kind === "jwt" && k.name !== keyTitle(k) ? el("span", { class: "key-sub mono" }, k.name) : null);
  }

  const ownerCell = (k) => el("td", { class: "owner" }, k.owner ? emailText(k.owner) : el("span", { class: "muted" }, "not recorded"));

  /** Valid: when a scheduled key starts, else how long it has left; the end date underneath. */
  function validCell(k) {
    const until = k.expires ? el("span", { class: "cell-sub", title: fmtDateTime(k.expires) }, `until ${fmtShortDateTime(k.expires)}`) : null;
    if (k.status === "scheduled" && k.notBefore) {
      return el("td", { class: "nowrap" }, el("span", { title: fmtDateTime(k.notBefore) }, `starts ${fmtShortDateTime(k.notBefore)}`), until);
    }
    return el("td", { class: "nowrap" }, k.expires ? el("span", { title: fmtDateTime(k.expires) }, fmtRelative(k.expires)) : "—", until);
  }

  function drawer(k, opener) {
    openKeyDrawer(ctx, k, { opener, onChanged: changed });
  }

  function usageCell(k) {
    if (!usage || usage.error) return el("td", { class: "num muted" }, "—");
    const u = k.usage;
    if (!u) return el("td", { class: "num muted" }, "0");
    return el("td", { class: "num" },
      el("span", { class: "strong", title: `${fmtInt(u.tokens)} tokens` }, fmtCompact(u.tokens)),
      el("span", { class: "cell-sub" }, `${fmtCompact(u.requests)} req`, u.lastSeen ? ` · ${fmtRelative(u.lastSeen)}` : ""));
  }

  function activeRow(k, selectable) {
    let check = null;
    if (selectable) {
      const box = el("input", { type: "checkbox", checked: ctx.selection.has(k.name), "aria-label": `Select ${keyTitle(k)} for export` });
      box.addEventListener("change", () => { ctx.select(k, box.checked); renderSelectionBar(); });
      check = el("td", { class: "col-check" }, box);
    }
    const reveal = ["active", "scheduled", "suspended"].includes(k.status) ? el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-focus-id": `reveal:${k.name}` }, icon("key"), "Reveal") : null;
    reveal?.addEventListener("click", busy(reveal, () => revealKey({ name: k.name, label: keyTitle(k), kind, models: k.models, opener: reveal })));
    const details = el("button", { type: "button", class: "btn btn-ghost btn-sm", "data-focus-id": `manage:${k.name}`, "aria-label": `Manage ${keyTitle(k)}` }, "Manage");
    details.addEventListener("click", () => drawer(k, details));
    const timing = kind === "jwt"
      ? validCell(k)
      : el("td", {},
        el("span", { class: "nowrap" }, k.slot ?? "—", k.rotateDays ? [" ", badge(`auto ${k.rotateDays}d`, "auto", `Rotates automatically every ${k.rotateDays} days`)] : null),
        k.rotatedAt ? el("span", { class: "cell-sub nowrap", title: fmtDateTime(k.rotatedAt) }, `rotated ${fmtRelative(k.rotatedAt)}`) : null,
        k.expires ? el("span", { class: "cell-sub nowrap" }, `expires ${fmtDate(k.expires)}`) : null);
    return el("tr", {}, check, keyCell(k), ownerCell(k),
      modelsCell(k),
      el("td", { class: "num", title: kind === "jwt" ? `${fmtInt(k.budget)} tokens over the key's life` : `${fmtInt(k.monthlyTokens)} tokens a month` },
        kind === "jwt" ? fmtCompact(k.budget) : k.monthlyTokens ? `${fmtCompact(k.monthlyTokens)}/mo` : "—"),
      usageCell(k), timing, el("td", {}, statusBadge(k.status)),
      el("td", { class: "actions" }, el("div", { class: "row row-tight" }, reveal, details)));
  }

  function archivedRow(k) {
    const when = deleteDate(k);
    const details = el("button", { type: "button", class: "btn btn-ghost btn-sm", "data-focus-id": `manage:${k.name}`, "aria-label": `Details for ${keyTitle(k)}` }, "Details");
    details.addEventListener("click", () => drawer(k, details));
    const del = el("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, "Delete");
    del.addEventListener("click", busy(del, async () => {
      const ok = await confirmDialog({
        title: `Delete ${keyTitle(k)}?`, confirmLabel: "Delete key",
        message: "The key's secret is deleted from Key Vault (soft delete, recoverable by an Azure admin within the vault's retention period).",
        points: kind === "product" ? ["Its API Management subscription is deleted first."] : [],
      });
      if (!ok) return;
      await post(keyPath(k.name, "delete"), {});
      toast(`Deleted ${keyTitle(k)}.`);
      await changed();
    }));
    return el("tr", {}, keyCell(k), ownerCell(k), modelsCell(k), el("td", {}, statusBadge(k.status)),
      el("td", {}, k.archivedAt ? el("span", { title: fmtDateTime(k.archivedAt) }, fmtDate(k.archivedAt)) : "—"),
      el("td", {}, when ? el("span", { title: fmtDateTime(when) }, fmtDate(when), el("span", { class: "cell-sub" }, fmtRelative(when))) : "—"),
      el("td", { class: "actions" }, el("div", { class: "row row-tight" }, details, del)));
  }

  loadUsage(false);
  loadKeys(false);
}
