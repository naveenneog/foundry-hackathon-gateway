// liteAPIM — entry point: sign-in check (admins only, ADR-0016), theme, navigation, routing,
// and the setup guide (help.js), which hears about every route.
//
// CSP: script-src 'self' with no inline script, and every view builds its DOM with createElement
// and textContent (dom.js). Nothing polls: data loads when a view opens, when the period changes
// or on Refresh. The theme preference is the only thing kept in the browser.

import { ApiError, apiPath, cachedGet, get } from "./api.js";
import { addChildren, confirmDialog, el, errorState, icon, reportError, segmented, setChildren } from "./dom.js";
import { createGuide } from "./help.js";
import { keyTitle } from "./lib.js";
import { closeSecrets, pendingSecrets } from "./secret.js";
import { renderExport } from "./views-admin.js";
import { renderFoundry } from "./views-foundry.js";
import { renderKeysView } from "./views-keys.js";
import { renderOverview } from "./views-overview.js";
import { renderSettings } from "./views-settings.js";

const ROUTES = [
  { id: "overview", label: "Overview", render: (root, ctx) => renderOverview(root, ctx) },
  { id: "short-lived", label: "Short-lived keys", subs: ["issue", "bulk"], render: (root, ctx, sub) => renderKeysView(root, ctx, "jwt", sub) },
  { id: "product", label: "Product keys", subs: ["issue", "bulk"], render: (root, ctx, sub) => renderKeysView(root, ctx, "product", sub) },
  { id: "models", label: "Foundry & models", render: (root, ctx) => renderFoundry(root, ctx) },
  { id: "export", label: "Export", render: (root, ctx) => renderExport(root, ctx) },
  { id: "settings", label: "Settings", render: (root, ctx) => renderSettings(root, ctx) },
];
/** Earlier addresses that still arrive: the Signing page is part of Settings since P59. */
const ALIASES = Object.freeze({ signing: "settings" });
const SUB_TITLES = { issue: "Issue", bulk: "Bulk issue" };
const SIGN_IN = "/.auth/login/aad?post_login_redirect_uri=/";
const ADMINS_ONLY = "liteAPIM is for administrators. Ask an admin for your key.";

// ── Theme ──────────────────────────────────────────────────────────────────

const THEMES = ["system", "light", "dark"];

function storedTheme() {
  try {
    const value = localStorage.getItem("kd-theme");
    return THEMES.includes(value) ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function saveTheme(theme) {
  try {
    if (theme === "system") localStorage.removeItem("kd-theme");
    else localStorage.setItem("kd-theme", theme);
  } catch {
    // Storage can be disabled; the choice then lasts for this page only.
  }
}

applyTheme(storedTheme());

// ── Shared state for the views ─────────────────────────────────────────────

function createContext(me) {
  const ctx = {
    me,
    period: 7,
    /** Keys picked for export: name → { kind, title }. In memory only. */
    selection: new Map(),
    /** A number of days, or { from, to } whole UTC days (period.js). */
    setPeriod(period) {
      ctx.period = period;
    },
    select(key, on) {
      if (on) ctx.selection.set(key.name, { kind: key.kind, title: keyTitle(key) });
      else ctx.selection.delete(key.name);
      showCount();
    },
    clearSelection() {
      ctx.selection.clear();
      showCount();
    },
    /** One Foundry's config (its models and base URL); without an id, the default Foundry's. */
    config: (foundryId) => cachedGet(apiPath("/api/config", { foundryId }), { ttl: Infinity }),
    /** Every Foundry account in the subscription; `fresh` re-reads Azure. */
    foundries: ({ fresh = false } = {}) => cachedGet("/api/foundries", { ttl: Infinity, fresh }),
    /** Set in start(): opens the setup guide at a step and highlights it on this page. */
    help: null,
    go(hash) {
      location.hash = hash;
    },
    rerender: () => route(ctx, false),
  };
  function showCount() {
    const badge = document.getElementById("export-count");
    if (!badge) return;
    badge.hidden = ctx.selection.size === 0;
    badge.textContent = String(ctx.selection.size);
    badge.setAttribute("aria-label", `${ctx.selection.size} selected`);
  }
  return ctx;
}

// ── Navigation ─────────────────────────────────────────────────────────────

function buildNav() {
  setChildren(document.getElementById("nav-list"), ...ROUTES.map((r) => el("li", {},
    el("a", { class: "nav-link", href: `#/${r.id}`, "data-route": r.id }, r.label,
      r.id === "export" ? el("span", { class: "nav-count", id: "export-count", hidden: true }) : null))));
}

function parseHash() {
  const m = /^#\/([a-z-]+)(?:\/([a-z]+))?$/.exec(location.hash);
  return m ? { id: m[1], sub: m[2] ?? null } : null;
}

/** The route on screen, so a refused navigation can put the address back. */
let shown = "";
let asking = false;
/** The setup guide, created once the admin is signed in. */
let guide = null;

function route(ctx, moveFocus) {
  closeSecrets();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  const parsed = parseHash();
  const id = parsed && Object.hasOwn(ALIASES, parsed.id) ? ALIASES[parsed.id] : parsed?.id;
  let r = ROUTES.find((x) => x.id === id);
  let sub = r?.subs?.includes(parsed.sub) ? parsed.sub : null;
  if (!r) {
    r = ROUTES[0];
    sub = null;
  }
  const canonical = `#/${r.id}${sub ? `/${sub}` : ""}`;
  if (location.hash !== canonical) history.replaceState(null, "", canonical);
  shown = canonical;
  for (const a of document.querySelectorAll(".nav-link")) {
    if (a.dataset.route === r.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `${sub ? `${SUB_TITLES[sub]} · ` : ""}${r.label} · liteAPIM`;
  const view = el("div", { class: "view" });
  setChildren(document.getElementById("main"), view);
  r.render(view, ctx, sub);
  if (moveFocus) view.querySelector(".view-title")?.focus();
  // Last, so a highlight the guide was waiting for can take focus from the title.
  guide?.routed(view, sub ? `${r.id}/${sub}` : r.id);
}

/**
 * Leaving a view drops what secret.js holds (route() calls closeSecrets). When that would lose an
 * undownloaded keys.csv or stop a running bulk issue, ask first and put the address back if not.
 */
async function onHashChange(ctx) {
  if (location.hash !== "" && !location.hash.startsWith("#/")) return;
  const target = location.hash || "#/overview";
  if (target === shown) return;
  const pending = pendingSecrets();
  if (pending || asking) {
    history.replaceState(null, "", shown);
    if (asking) return;
    asking = true;
    let leave = false;
    try {
      leave = await confirmDialog({ title: "Leave this page?", message: pending, confirmLabel: "Leave and discard" });
    } finally {
      asking = false;
    }
    if (!leave) return;
    history.pushState(null, "", target);
  }
  route(ctx, true);
}

// ── Start ──────────────────────────────────────────────────────────────────

const adminsOnly = () => gate("Administrators only", ADMINS_ONLY, el("a", { class: "btn btn-secondary", href: "/.auth/logout" }, "Sign out"));

function gate(title, text, ...actions) {
  setChildren(document.getElementById("main"), el("div", { class: "view" }, el("section", { class: "card gate" },
    el("h1", { class: "view-title" }, title), el("p", { class: "lede" }, text), el("div", { class: "row" }, actions))));
}

async function start() {
  setChildren(document.getElementById("theme-switch"), segmented({
    label: "Colour theme", value: storedTheme(), iconOnly: true, cls: "seg-theme",
    options: [{ value: "system", label: "Match the system", icon: "system" }, { value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }],
    onChange: (theme) => { applyTheme(theme); saveTheme(theme); },
  }));
  window.addEventListener("pagehide", closeSecrets);
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason instanceof ApiError) event.preventDefault();
    reportError(event.reason);
  });

  let me;
  try {
    me = await get("/api/me");
  } catch (error) {
    if (error.status === 401) {
      gate("Sign in to liteAPIM", "Use your organisation account.", el("a", { class: "btn btn-primary", href: SIGN_IN }, "Sign in"));
    } else if (error.status === 403) {
      adminsOnly();
    } else {
      setChildren(document.getElementById("main"), el("div", { class: "view" }, errorState(error, () => location.reload())));
    }
    return;
  }

  if (me?.role !== "admin") return adminsOnly();
  const ctx = createContext(me);
  guide = createGuide(ctx);
  ctx.help = (step, opener) => guide.open(step, opener, { highlight: true });
  setChildren(document.getElementById("help-slot"), guide.button);
  addChildren(document.body, guide.panel);
  document.getElementById("who-name").textContent = me.name ?? "";
  const role = document.getElementById("who-role");
  role.textContent = "admin";
  role.className = "role role-admin";
  role.hidden = false;
  buildNav();
  window.addEventListener("hashchange", () => { onHashChange(ctx).catch(reportError); });
  route(ctx, false);
}

start().catch((error) => {
  setChildren(document.getElementById("main"), el("div", { class: "view" },
    el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"), el("p", {}, error?.message || "liteAPIM failed to start."))));
});
