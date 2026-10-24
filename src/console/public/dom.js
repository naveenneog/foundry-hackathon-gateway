// Key Dashboard — DOM helpers. Markup is only ever built with createElement and textContent:
// there is no HTML-string path anywhere, so key metadata cannot inject markup. The helpers touch
// `document` only when called, so Node tests can import this module with a stub document.

import { fmtInt } from "./lib.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const BLOCKED = new Set(["style", "innerhtml", "outerhtml", "srcdoc"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);
const PROPS = new Set(["value", "checked", "disabled", "hidden", "indeterminate", "readOnly", "selected", "open"]);
const DEFAULTS = { value: "defaultValue", checked: "defaultChecked", selected: "defaultSelected" };

/** Same-origin paths, in-page anchors and blob: downloads only; script URLs and other origins are refused. */
export function safeUrl(value) {
  const s = String(value);
  if (/^(#|\/(?![/\\])|blob:)/.test(s)) return s;
  throw new Error("Refusing a URL that is not same-origin.");
}

function apply(node, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (BLOCKED.has(k.toLowerCase())) throw new Error(`Refusing the ${k} attribute.`);
    if (/^on/i.test(k)) {
      if (typeof v !== "function") throw new Error(`Event handler ${k} must be a function.`);
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === undefined || v === null || v === false) continue;
    else if (k === "class") node.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v));
    else if (k === "text") node.textContent = String(v);
    else if (DEFAULTS[k] && DEFAULTS[k] in node) {
      // Set the default too, so a form reset returns to it instead of blanking the control.
      node[DEFAULTS[k]] = v;
      node[k] = v;
    } else if (PROPS.has(k)) node[k] = v;
    else if (URL_ATTRS.has(k)) node.setAttribute(k, safeUrl(v));
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "object" && "nodeType" in c ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const el = (tag, attrs, ...children) => append(apply(document.createElement(tag), attrs), children);
export const svgEl = (tag, attrs, ...children) => append(apply(document.createElementNS(SVG_NS, tag), attrs), children);

/**
 * Replace or add children with el()'s rules: arrays flatten, null/undefined/false are skipped and
 * strings become text nodes. The native methods would print "null" or join an array into text.
 */
export function setChildren(node, ...children) {
  if (!node) return node;
  node.replaceChildren();
  return append(node, children);
}
export const addChildren = (node, ...children) => (node ? append(node, children) : node);

let seq = 0;
export const uid = (prefix = "kd") => `${prefix}-${++seq}`;

// ── Icons (16×16, stroked with currentColor) ───────────────────────────────

const ICONS = {
  sun: "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1",
  moon: "M13.6 9.8A5.6 5.6 0 0 1 6.2 2.4a5.6 5.6 0 1 0 7.4 7.4z",
  system: "M2 3h12v8H2zM5.5 14h5M8 11v3",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  eyeOff: "M2 2l12 12M6.6 3.7A6.4 6.4 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M10 10.6A2 2 0 0 1 6.6 7.2M4.1 4.9A11.2 11.2 0 0 0 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7",
  close: "M4 4l8 8M12 4l-8 8",
  refresh: "M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3",
  download: "M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3L14 14",
  check: "M3 8.5l3 3 7-7",
  alert: "M8 1.8L1.3 13.7h13.4L8 1.8zM8 6.3v3.4M8 11.6v.2",
  key: "M10.5 1.8a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4zM7.9 8.1L2 14M3.8 12.2l1.7 1.7M5.5 10.5l1.7 1.7",
  upload: "M8 10.5V2M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11",
  back: "M10 3L5 8l5 5",
  help: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM6.1 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.8.6-.8 1.1v.5M8 11.5v.2",
  plug: "M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0V4.5zM8 11.5v3",
};

export function icon(name, cls = "icon") {
  return svgEl("svg", { class: cls, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    svgEl("path", { d: ICONS[name] ?? ICONS.alert }));
}

// ── Toasts and the signed-out banner ───────────────────────────────────────

/** Toasts live in the top-most open modal dialog when there is one: the rest of the page is inert then. */
function toastRegion() {
  const host = [...document.querySelectorAll("dialog[open]")].at(-1);
  if (!host) return { region: document.getElementById("toasts"), fresh: false };
  let region = [...host.children].find((c) => c.classList.contains("toasts"));
  const fresh = !region;
  if (!region) host.append(region = el("div", { class: "toasts", "aria-live": "polite" }));
  return { region, fresh };
}

export function toast(message, tone = "ok") {
  const { region, fresh } = toastRegion();
  if (!region) return;
  const item = el("div", { class: `toast toast-${tone}` },
    icon(tone === "error" ? "alert" : "check", "icon toast-icon"),
    el("p", { class: "toast-msg" }, message),
    el("button", { type: "button", class: "btn-icon", "aria-label": "Dismiss", onclick: () => item.remove() }, icon("close")));
  // A live region announces changes, not its own arrival, so a new region gets its toast a beat later.
  setTimeout(() => {
    region.append(item);
    while (region.children.length > 4) region.firstElementChild.remove();
  }, fresh ? 60 : 0);
  setTimeout(() => item.remove(), tone === "error" ? 15000 : 6000);
}

export function showSignedOut() {
  const banner = document.getElementById("signed-out");
  if (banner) banner.hidden = false;
}

export function reportError(error) {
  if (error?.status === 401) showSignedOut();
  toast(error?.message || "Something went wrong.", "error");
}

/**
 * Wraps a click handler: marks the button busy while it runs and reports any error once.
 * aria-disabled, not disabled: disabling the focused button would drop keyboard focus to <body>.
 */
export function busy(button, fn) {
  return async (event) => {
    event?.preventDefault?.();
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    try {
      await fn(event);
    } catch (error) {
      reportError(error);
    } finally {
      button.removeAttribute("aria-busy");
      button.removeAttribute("aria-disabled");
    }
  };
}

export async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error("Copying is unavailable in this browser. Show the value and copy it by hand.");
  await navigator.clipboard.writeText(text);
}

export function copyButton(getText, { label = "Copy", what = "Text" } = {}) {
  const text = el("span", {}, label);
  const button = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("copy"), text);
  let timer = 0;
  button.addEventListener("click", busy(button, async () => {
    await copyText(getText());
    text.textContent = "Copied";
    clearTimeout(timer);
    timer = setTimeout(() => { text.textContent = label; }, 2000);
    toast(`${what} copied to the clipboard.`);
  }));
  return button;
}

/** Saves text as a file through an object URL that is revoked as soon as the download starts. */
export function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const name = String(filename ?? "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "download";
  const a = el("a", { href: url, download: name, class: "sr-only" });
  try {
    document.body.append(a);
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export const downloadJson = (filename, data) => downloadText(filename, JSON.stringify(data, null, 2), "application/json");

// ── Modal dialogs: native <dialog>, Tab wraps inside, Esc closes, focus returns ──

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function trapTab(event) {
  if (event.key !== "Tab") return;
  const items = [...event.currentTarget.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Where focus goes when a dialog closes: the opener, or, when a re-render replaced it, the element
 * carrying the same data-focus-id, else the top-most dialog still open, else the view's heading.
 */
export function restoreFocus(opener, focusId) {
  const twin = focusId ? document.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`) : null;
  const target = (opener?.isConnected ? opener : twin)
    ?? [...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(FOCUSABLE)
    ?? document.querySelector("#main .view-title");
  target?.focus?.();
}

/** Opens a dialog modally; removes it from the DOM when it closes. */
export function openModal(dialog, { opener = document.activeElement, initialFocus, onClose, closeOnBackdrop = false } = {}) {
  const focusId = opener?.getAttribute?.("data-focus-id");
  dialog.addEventListener("keydown", trapTab);
  if (closeOnBackdrop) dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    onClose?.();
    dialog.remove();
    restoreFocus(opener, focusId);
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  (initialFocus ?? dialog.querySelector(FOCUSABLE))?.focus();
  return dialog;
}

/**
 * A confirmation dialog resolving true or false. With `typed`, the confirm button stays disabled
 * until that exact word is typed. Destructive confirms focus Cancel first.
 */
export function confirmDialog({ title, message, points = [], confirmLabel = "Confirm", tone = "danger", typed = null } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const titleId = uid("dlg-title");
    const ok = el("button", { type: "button", class: `btn btn-${tone}`, disabled: Boolean(typed) }, confirmLabel);
    const cancel = el("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
    const input = typed ? el("input", { type: "text", id: `${titleId}-typed`, class: "input mono", autocomplete: "off", spellcheck: "false" }) : null;
    const dialog = el("dialog", { class: "dialog", "aria-labelledby": titleId },
      el("div", { class: "dialog-body" },
        el("h2", { id: titleId, class: "dialog-title" }, title),
        message ? el("p", {}, message) : null,
        points.length ? el("ul", { class: "dialog-points" }, points.map((p) => el("li", {}, p))) : null,
        typed ? el("div", { class: "field" },
          el("label", { class: "field-label", for: `${titleId}-typed` }, "Type ", el("strong", { class: "mono" }, typed), " to confirm"),
          input) : null),
      el("div", { class: "dialog-actions" }, cancel, ok));
    input?.addEventListener("input", () => { ok.disabled = input.value !== typed; });
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value === typed) ok.click(); });
    ok.addEventListener("click", () => { confirmed = true; dialog.close(); });
    cancel.addEventListener("click", () => dialog.close());
    openModal(dialog, { initialFocus: input ?? (tone === "danger" || tone === "warn" ? cancel : ok), onClose: () => resolve(confirmed) });
  });
}

// ── Loading, empty and error states ────────────────────────────────────────

export function loadingState(label = "Loading…", lines = 3) {
  return el("div", { class: "state state-loading", role: "status", "aria-live": "polite" },
    el("span", { class: "sr-only" }, label),
    Array.from({ length: lines }, (_, i) => el("div", { class: `skeleton sk-${i % 3}`, "aria-hidden": "true" })));
}

export function emptyState(title, text, ...actions) {
  return el("div", { class: "state state-empty" },
    el("p", { class: "state-title" }, title),
    text ? el("p", { class: "state-text" }, text) : null,
    actions.length ? el("div", { class: "row" }, actions) : null);
}

export function errorState(error, retry) {
  const signedOut = error?.status === 401;
  if (signedOut) showSignedOut();
  return el("div", { class: "state state-error", role: "alert" },
    icon("alert", "icon state-icon"),
    el("div", {},
      el("p", { class: "state-title" }, signedOut ? "You are signed out." : error?.status === 403 ? "Not allowed." : "This could not be loaded."),
      el("p", { class: "state-text" }, error?.message || "Something went wrong."),
      el("div", { class: "row" },
        signedOut ? el("a", { class: "btn btn-primary btn-sm", href: "/.auth/login/aad?post_login_redirect_uri=/" }, "Sign in") : null,
        retry && !signedOut ? el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: retry }, "Try again") : null)));
}

// ── Controls ───────────────────────────────────────────────────────────────

/** A segmented control built from native radios (arrow keys move between options). */
export function segmented({ label, options, value, onChange, iconOnly = false, cls = "" }) {
  const name = uid("seg");
  const wrap = el("fieldset", { class: ["seg", cls] }, el("legend", { class: "sr-only" }, label));
  for (const o of options) {
    const input = el("input", { type: "radio", class: "seg-input", name, value: String(o.value), checked: o.value === value });
    input.addEventListener("change", () => { if (input.checked) onChange(o.value); });
    wrap.append(el("label", { class: "seg-item", title: iconOnly ? o.label : undefined }, input,
      el("span", { class: "seg-face" }, o.icon ? icon(o.icon) : null, el("span", { class: iconOnly ? "sr-only" : "" }, o.label))));
  }
  return wrap;
}

/** A labelled control with hint and an error slot wired through aria-describedby. */
export function field({ label, control, hint, optional = false, cls = "" }) {
  const id = control.id || uid("f");
  control.id = id;
  const hintNode = hint ? el("p", { class: "field-hint", id: `${id}-hint` }, hint) : null;
  const error = el("p", { class: "field-error", id: `${id}-error`, hidden: true });
  control.setAttribute("aria-describedby", [hintNode ? `${id}-hint` : "", `${id}-error`].filter(Boolean).join(" "));
  const wrap = el("div", { class: ["field", cls] },
    el("label", { class: "field-label", for: id }, label, optional ? el("span", { class: "field-optional" }, " (optional)") : null),
    control, hintNode, error);
  return {
    wrap, control,
    setError(message) {
      error.textContent = message ?? "";
      error.hidden = !message;
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    },
  };
}

/** Shows field errors ({ name: message }) on a map of fields and focuses the first invalid one. */
export function showErrors(fields, errors) {
  let first = null;
  for (const [name, f] of Object.entries(fields)) {
    f.setError(errors[name] ?? null);
    if (errors[name] && !first) first = f;
  }
  (first?.focusTarget ?? first?.control)?.focus();
  return !first;
}

export function badge(text, tone, title) {
  return el("span", { class: `badge badge-${tone}`, title }, text);
}

export const statusBadge = (status) => badge(status, { active: "ok", scheduled: "info", suspended: "warn", revoked: "bad", expired: "grey", archived: "archived" }[status] ?? "grey");
export const kindBadge = (kind) => badge(kind === "jwt" ? "Short-lived" : "Product", kind === "jwt" ? "jwt" : "product");
export const routeBadge = (route) => (route ? badge(route === "claude" ? "Claude" : "OpenAI", `route-${route}`, route === "claude" ? "Claude route (/claude)" : "OpenAI-compatible route (/v1)") : null);

export function kpi({ label, value, sub, cls, exact }) {
  return el("div", { class: ["kpi", cls] },
    el("p", { class: "kpi-label" }, label),
    el("p", { class: "kpi-value" }, el("data", { value: String(exact ?? ""), title: Number.isFinite(exact) ? fmtInt(exact) : undefined }, value)),
    sub ? el("p", { class: "kpi-sub" }, sub) : null);
}

export function modelChips(models, max = 3) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return el("span", { class: "muted" }, "—");
  return el("span", { class: "chips", title: list.join(", ") },
    list.slice(0, max).map((m) => el("span", { class: "chip mono" }, m)),
    list.length > max ? el("span", { class: "chip chip-more" }, `+${list.length - max}`) : null);
}

/** An email address that may wrap before the @ but never mid-word. */
export function emailText(value) {
  const s = String(value ?? "");
  const at = s.indexOf("@");
  return at > 0 ? [s.slice(0, at), el("wbr"), s.slice(at)] : s;
}
