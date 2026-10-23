// Key Dashboard — the only module that displays key values and passphrases.
//
// A value is fetched only after an explicit click and shown masked in a modal panel with Show and
// Copy. It is wiped from the DOM after 60 seconds (an explicit click extends that), when the panel
// closes, when the view changes and on pagehide. It is never stored, never put in a URL and never
// logged. JavaScript cannot zero a string, so wiping drops every reference the page holds.

import { fetchSecret } from "./api.js";
import { addChildren, copyButton, el, icon, openModal, reportError, segmented, setChildren, uid } from "./dom.js";

const CLEAR_AFTER_MS = 60_000;
const MASK = "•".repeat(20);
let current = null;

/** Wipes and closes the open secret panel, if there is one. */
export function closeSecrets() {
  current?.destroy();
}

/** Reveals a stored key: fetches it (uncached) and opens the panel. */
export async function revealKey({ name, label, kind, models = [], opener }) {
  const r = await fetchSecret(name);
  showSecret({
    title: `${r.kind === "jwt" ? "Hackathon" : "Product"} key · ${label || name}`,
    secrets: [{ label: "Key", value: r.value }],
    handout: r.handout, kind: r.kind ?? kind, models, opener,
    again: () => revealKey({ name, label, kind, models, opener }),
  });
}

const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const psQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const envText = (env, shell) => Object.entries(env)
  .map(([k, v]) => (shell === "powershell" ? `$env:${k} = ${psQuote(v)}` : `export ${k}=${shQuote(v)}`)).join("\n");

/** Client setup snippets from the server's handout; unknown entries are shown as JSON. */
function snippetsOf(handout) {
  if (!handout || typeof handout !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(handout)) {
    if (value === null || value === undefined) continue;
    if (key === "env" && typeof value === "object") {
      out.push({ title: "Environment variables", note: "Set these in the shell that starts the client.", env: value });
    } else if (key === "claudeSettings") {
      out.push({ title: "Claude Code", note: "Merge into ~/.claude/settings.json, or .claude/settings.json in a project.", text: JSON.stringify(value, null, 2) });
    } else if (key === "opencode") {
      out.push({ title: "opencode", note: "Save as opencode.json in the project.", text: JSON.stringify(value, null, 2) });
    } else if (key === "curl" && typeof value === "string") {
      out.push({ title: "Test with curl", note: "Sends one short request through the gateway.", text: value });
    } else {
      out.push({ title: key, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
    }
  }
  return out;
}

/**
 * Opens the secret panel. `secrets` is [{ label, value }]; `handout` adds client setup snippets.
 * `again` offers "Reveal again" after the timer clears a stored key; one-time values omit it.
 */
export function showSecret({ title, intro, secrets, handout = null, kind = null, models = [], opener, again = null }) {
  closeSecrets();
  let values = secrets.map((s) => String(s.value ?? ""));
  let snippets = snippetsOf(handout);
  const labels = secrets.map((s) => s.label);
  let shown = false;
  let warned = false;
  let deadline = Date.now() + CLEAR_AFTER_MS;
  const renders = [];
  const masked = (text) => (shown ? text : values.reduce((t, v) => (v ? t.split(v).join(MASK) : t), text));
  const titleId = uid("secret-title");
  const live = el("p", { class: "sr-only", "aria-live": "polite" });
  const body = el("div", { class: "dialog-body secret-body" });
  const timerText = el("span", { class: "secret-timer" });

  const toggleLabel = el("span", {}, "Show");
  const toggleIcon = el("span", { class: "btn-icon-slot" }, icon("eye"));
  const toggle = el("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-pressed": "false" }, toggleIcon, toggleLabel);
  toggle.addEventListener("click", () => {
    shown = !shown;
    toggle.setAttribute("aria-pressed", String(shown));
    toggleLabel.textContent = shown ? "Hide" : "Show";
    setChildren(toggleIcon, icon(shown ? "eyeOff" : "eye"));
    for (const r of renders) r();
  });
  const extend = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Keep 60 s longer");
  extend.addEventListener("click", () => {
    deadline = Date.now() + CLEAR_AFTER_MS;
    warned = false;
    tick();
  });

  const rows = labels.map((label, i) => {
    const code = el("code", { class: "secret-value" });
    renders.push(() => { code.textContent = shown ? values[i] : MASK; });
    return el("div", { class: "secret-row" },
      el("span", { class: "secret-label" }, label),
      code,
      copyButton(() => values[i] ?? "", { label: "Copy", what: label }));
  });

  const blocks = snippets.map((s, i) => {
    let shell = "bash";
    const code = el("code", {});
    const text = () => {
      const snip = snippets[i];
      if (!snip) return "";
      return snip.env ? envText(snip.env, shell) : snip.text;
    };
    renders.push(() => { code.textContent = masked(text()); });
    const shellSwitch = s.env ? segmented({
      label: "Shell", value: shell, cls: "seg-sm",
      options: [{ value: "bash", label: "bash / zsh" }, { value: "powershell", label: "PowerShell" }],
      onChange: (v) => { shell = v; code.textContent = masked(text()); },
    }) : null;
    return el("section", { class: "snippet" },
      el("div", { class: "snippet-head" }, el("h3", { class: "snippet-title" }, s.title), shellSwitch, copyButton(text, { label: "Copy", what: s.title })),
      s.note ? el("p", { class: "field-hint" }, s.note) : null,
      el("pre", { class: "snippet-code", tabindex: "0" }, code));
  });

  const grants = models?.length ? el("p", { class: "secret-models" },
    `This key may call ${models.join(", ")}. `,
    kind === "product" ? "Send the deployment name as the request's model field." : "Send the alias as the request's model field.") : null;

  addChildren(body,
    el("div", { class: "callout callout-warn" }, icon("alert", "icon callout-icon"),
      el("p", {}, intro ?? "Treat this like a password. Revealing it is recorded in the audit log.")),
    rows,
    el("div", { class: "secret-controls" }, toggle, timerText, extend),
    grants,
    blocks.length ? el("h3", { class: "section-title" }, "Client setup") : null,
    blocks,
    live);
  for (const r of renders) r();

  const closeX = el("button", { type: "button", class: "btn-icon", "aria-label": "Close" }, icon("close"));
  const closeBtn = el("button", { type: "button", class: "btn btn-primary" }, "Done");
  const dialog = el("dialog", { class: "dialog dialog-wide", "aria-labelledby": titleId },
    el("div", { class: "dialog-head" }, el("h2", { class: "dialog-title", id: titleId }, icon("key"), el("span", {}, title)), closeX),
    body,
    el("div", { class: "dialog-actions" }, closeBtn));

  let timer = 0;
  function wipe() {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
    values = [];
    snippets = [];
    renders.length = 0;
    setChildren(body);
  }
  function expire() {
    wipe();
    addChildren(body, el("div", { class: "state state-empty" },
      el("p", { class: "state-title" }, "Cleared after 60 seconds."),
      el("p", { class: "state-text" }, again ? "Reveal it again if you still need it." : "It was shown once and cannot be shown again."),
      again ? el("div", { class: "row" }, el("button", { type: "button", class: "btn btn-secondary", onclick: () => { destroy(); again().catch(reportError); } }, "Reveal again")) : null));
    (again ? body.querySelector("button") : closeBtn)?.focus();
  }
  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    timerText.textContent = `Clears in ${left} s`;
    if (left <= 10 && !warned) {
      warned = true;
      live.textContent = "The value clears in 10 seconds.";
    }
    if (left === 0) expire();
  }
  const handle = {
    destroy() {
      wipe();
      if (current === handle) current = null;
      if (dialog.open) dialog.close();
    },
  };
  function destroy() {
    handle.destroy();
  }
  closeX.addEventListener("click", destroy);
  closeBtn.addEventListener("click", destroy);
  current = handle;
  tick();
  timer = setInterval(tick, 1000);
  // Background tabs throttle timers; check the deadline the moment the page is visible again.
  document.addEventListener("visibilitychange", tick);
  openModal(dialog, { opener, initialFocus: rows[0]?.querySelector("button"), onClose: () => handle.destroy() });
}
