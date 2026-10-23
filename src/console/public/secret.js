// Key Dashboard — the only module that handles key values: reveal, single issue, bulk issue CSVs.
//
// A revealed or newly issued key is shown masked in a modal panel with Show and Copy. It is wiped
// from the DOM after 60 seconds (an explicit click extends that), when the panel closes, when the
// view changes and on pagehide. A bulk run keeps only the server's keys.csv and index.csv, for
// download, and drops them under the same rules; the rows it hands to views carry no key. Nothing
// is stored, put in a URL or logged. JavaScript cannot zero a string, so wiping drops every
// reference the page holds.

import { fetchSecret, post } from "./api.js";
import { addChildren, copyButton, downloadText, el, icon, openModal, reportError, segmented, setChildren, uid } from "./dom.js";
import { appendCsv, csvFilename, safeIssued } from "./lib.js";

const CLEAR_AFTER_MS = 60_000;
const MASK = "•".repeat(20);
let current = null;
const holders = new Set();

/** Wipes and closes the open secret panel, if there is one. */
function closePanel() {
  current?.destroy();
}

/** Wipes everything this module holds: the open panel and every bulk run's CSVs. */
export function closeSecrets() {
  closePanel();
  for (const holder of [...holders]) holder.drop();
}

/** Reveals a stored key: fetches it (uncached) and opens the panel. */
export async function revealKey({ name, label, kind, models = [], opener }) {
  const r = await fetchSecret(name);
  showSecret({
    title: `${r.kind === "jwt" ? "Short-lived" : "Product"} key · ${label || name}`,
    secrets: [{ label: "Key", value: r.value }],
    handout: r.handout, kind: r.kind ?? kind, models, opener,
    again: () => revealKey({ name, label, kind, models, opener }),
  });
}

/**
 * Issues one key. A short-lived key's token goes straight into the panel; the caller gets back
 * only the key's name and validity, so nothing built from the result can keep the token alive.
 */
export async function issueKey(kind, body, { label, models = [], opener } = {}) {
  const r = await post(kind === "jwt" ? "/api/jwt" : "/api/products", body);
  const out = { name: r.name, product: r.product, notBefore: r.notBefore ?? null, expiresAt: r.expiresAt ?? null };
  if (kind === "jwt" && r.token) {
    showSecret({
      title: `New short-lived key · ${label}`, kind, models, opener, handout: r.handout,
      intro: "Copy it now and send it to the person it is issued to. You can reveal it again from the list. Treat it like a password.",
      secrets: [{ label: "Key", value: r.token }],
      again: () => revealKey({ name: out.name, label, kind, models }),
    });
  }
  return out;
}

// ── Bulk issue: keys.csv and index.csv ───────────────────────────────────────

const guardUnload = (event) => { if (pendingSecrets()) event.preventDefault(); };
function syncUnloadGuard() {
  if (pendingSecrets()) globalThis.addEventListener?.("beforeunload", guardUnload);
  else globalThis.removeEventListener?.("beforeunload", guardUnload);
}
const hasRows = (csv) => typeof csv === "string" && /\r\n|\n|\r/.test(csv);

/**
 * A bulk run. Each batch response carries every key twice, in its rows and in keys.csv. The holder
 * sends the batches, keeps only the two CSV texts for download, and returns rows without keys. It
 * drops the texts when the result closes, the view changes or the page is hidden (closeSecrets);
 * a batch that lands after that is not kept.
 */
export function createBulkCsv(kind, startedAt = Date.now()) {
  let keys = null;
  let index = null;
  let dropped = false;
  let downloaded = false;
  let running = false;
  const holder = {
    async issue(body) {
      const r = await post(kind === "jwt" ? "/api/jwt/bulk" : "/api/products/bulk", body);
      if (!dropped) {
        keys = appendCsv(keys, r.keysCsv);
        index = appendCsv(index, r.indexCsv);
        syncUnloadGuard();
      }
      return {
        issued: (Array.isArray(r.issued) ? r.issued : []).map((row) => safeIssued(kind, row)),
        failed: (Array.isArray(r.failed) ? r.failed : []).map((f) => ({ index: Number(f?.index), error: String(f?.error ?? "Failed.") })),
      };
    },
    get running() { return running; },
    set running(on) { running = Boolean(on) && !dropped; syncUnloadGuard(); },
    get dropped() { return dropped; },
    get downloaded() { return downloaded; },
    get hasKeys() { return hasRows(keys); },
    get hasIndex() { return hasRows(index); },
    download(which) {
      const text = which === "keys" ? keys : index;
      if (dropped || !hasRows(text)) throw new Error("That CSV is no longer held: it is cleared when the result closes or the page changes. Export the keys as an encrypted bundle instead.");
      downloadText(csvFilename(kind, which, startedAt), text, "text/csv;charset=utf-8");
      if (which === "keys") downloaded = true;
      syncUnloadGuard();
    },
    drop() {
      keys = null;
      index = null;
      dropped = true;
      running = false;
      holders.delete(holder);
      syncUnloadGuard();
    },
  };
  holders.add(holder);
  return holder;
}

/** Why leaving now would lose something, or null: a running bulk issue or a keys.csv not yet saved. */
export function pendingSecrets() {
  for (const h of holders) {
    if (h.running) return "A bulk issue is still running. Leaving stops it after the current batch and discards its keys.csv.";
    if (h.hasKeys && !h.downloaded) return "The keys.csv of this bulk issue has not been downloaded. Leaving discards it; the keys can still be exported as an encrypted bundle.";
  }
  return null;
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
  closePanel();
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
