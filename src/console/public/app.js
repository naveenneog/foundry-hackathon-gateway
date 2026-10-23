// Key Dashboard — entry point: sign-in check, theme, navigation and routing.
//
// CSP: script-src 'self' with no inline script, and every view builds its DOM with createElement
// and textContent (dom.js). Nothing polls: data loads when a view opens, when the period changes
// or on Refresh. The theme preference is the only thing kept in the browser.

import { ApiError, cachedGet, get } from "./api.js";
import { el, errorState, icon, reportError, segmented, setChildren } from "./dom.js";
import { keyTitle } from "./lib.js";
import { closeSecrets } from "./secret.js";
import { renderExport, renderModels, renderSigning } from "./views-admin.js";
import { renderKeysView } from "./views-keys.js";
import { renderOverview } from "./views-overview.js";

const ROUTES = [
  { id: "overview", label: "Overview", render: (root, ctx) => renderOverview(root, ctx) },
  { id: "hackathon", label: "Hackathon keys", subs: ["issue", "bulk"], render: (root, ctx, sub) => renderKeysView(root, ctx, "jwt", sub) },
  { id: "product", label: "Product keys", subs: ["issue", "bulk"], render: (root, ctx, sub) => renderKeysView(root, ctx, "product", sub) },
  { id: "models", label: "Models", admin: true, render: (root) => renderModels(root) },
  { id: "export", label: "Export", admin: true, render: (root, ctx) => renderExport(root, ctx) },
  { id: "signing", label: "Signing", admin: true, render: (root) => renderSigning(root) },
];
const SUB_TITLES = { issue: "Issue", bulk: "Bulk issue" };
const SIGN_IN = "/.auth/login/aad?post_login_redirect_uri=/";

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
    admin: me.role === "admin",
    period: 7,
    /** Keys picked for export: name → { kind, title }. In memory only. */
    selection: new Map(),
    setPeriod(days) {
      ctx.period = days;
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
    config: () => cachedGet("/api/config", { ttl: Infinity }),
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

function buildNav(ctx) {
  setChildren(document.getElementById("nav-list"), ...ROUTES.filter((r) => !r.admin || ctx.admin).map((r) => el("li", {},
    el("a", { class: "nav-link", href: `#/${r.id}`, "data-route": r.id }, r.label,
      r.id === "export" ? el("span", { class: "nav-count", id: "export-count", hidden: true }) : null))));
}

function parseHash() {
  const m = /^#\/([a-z]+)(?:\/([a-z]+))?$/.exec(location.hash);
  return m ? { id: m[1], sub: m[2] ?? null } : null;
}

function route(ctx, moveFocus) {
  closeSecrets();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  const parsed = parseHash();
  let r = ROUTES.find((x) => x.id === parsed?.id && (!x.admin || ctx.admin));
  let sub = r && ctx.admin && r.subs?.includes(parsed.sub) ? parsed.sub : null;
  if (!r) {
    r = ROUTES[0];
    sub = null;
  }
  const canonical = `#/${r.id}${sub ? `/${sub}` : ""}`;
  if (location.hash !== canonical) history.replaceState(null, "", canonical);
  for (const a of document.querySelectorAll(".nav-link")) {
    if (a.dataset.route === r.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `${sub ? `${SUB_TITLES[sub]} · ` : ""}${r.label} · Key Dashboard`;
  const view = el("div", { class: "view" });
  setChildren(document.getElementById("main"), view);
  r.render(view, ctx, sub);
  if (moveFocus) view.querySelector(".view-title")?.focus();
}

// ── Start ──────────────────────────────────────────────────────────────────

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
      gate("Sign in to the Key Dashboard", "Use your organisation account.", el("a", { class: "btn btn-primary", href: SIGN_IN }, "Sign in"));
    } else if (error.status === 403) {
      gate("No access yet", "Your account has no Key Dashboard role. Ask an admin to assign you Console.User or Console.Admin, then sign in again.",
        el("a", { class: "btn btn-secondary", href: "/.auth/logout" }, "Sign out"));
    } else {
      setChildren(document.getElementById("main"), el("div", { class: "view" }, errorState(error, () => location.reload())));
    }
    return;
  }

  const ctx = createContext(me);
  document.getElementById("who-name").textContent = me.name ?? "";
  const role = document.getElementById("who-role");
  role.textContent = ctx.admin ? "admin" : "user";
  role.className = `role role-${ctx.admin ? "admin" : "user"}`;
  role.hidden = false;
  buildNav(ctx);
  window.addEventListener("hashchange", () => {
    if (location.hash === "" || location.hash.startsWith("#/")) route(ctx, true);
  });
  route(ctx, false);
}

start().catch((error) => {
  setChildren(document.getElementById("main"), el("div", { class: "view" },
    el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"), el("p", {}, error?.message || "The dashboard failed to start."))));
});
