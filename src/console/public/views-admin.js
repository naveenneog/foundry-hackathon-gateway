// Key Dashboard — admin views: Export (encrypted, signed bundles) and Signing (the secret that signs
// short-lived keys). Foundry accounts, deployments and pins are views-foundry.js.

import { cachedGet, get, post } from "./api.js";
import {
  addChildren, busy, confirmDialog, copyButton, downloadJson, el, emptyState, errorState, field, icon, loadingState, setChildren, showErrors, toast, uid,
} from "./dom.js";
import { checkPassphrase, checkRecipient, chunk, fmtInt, KINDS, LIMITS } from "./lib.js";
import { showSecret } from "./secret.js";

const EXPORT_MAX = 50;

function head(title, lede, ...actions) {
  return el("header", { class: "view-head" },
    el("div", {}, el("h1", { class: "view-title", tabindex: "-1" }, title), el("p", { class: "lede" }, lede)),
    actions.length ? el("div", { class: "view-actions" }, actions) : null);
}

function card(title, ...children) {
  const id = uid("card");
  return el("section", { class: "card", "aria-labelledby": id }, el("h2", { class: "card-title", id }, title), children);
}

// ── Export ──────────────────────────────────────────────────────────────────

export function renderExport(root, ctx) {
  const selectedSlot = el("div", {});
  const resultSlot = el("div", { "aria-live": "polite" });
  const recipient = field({ label: "Recipient", control: el("input", { type: "text", class: "input", maxlength: String(LIMITS.recipient), autocomplete: "off" }), hint: "Recorded in the signed header, for example a name and team." });
  const passInput = el("input", { type: "password", class: "input mono", autocomplete: "new-password", spellcheck: "false" });
  const showPass = el("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-pressed": "false" }, "Show");
  showPass.addEventListener("click", () => {
    const show = passInput.type === "password";
    passInput.type = show ? "text" : "password";
    showPass.textContent = show ? "Hide" : "Show";
    showPass.setAttribute("aria-pressed", String(show));
  });
  const passphrase = field({ label: "Passphrase", optional: true, control: passInput, hint: `At least ${LIMITS.passphrase} characters. Leave it blank and the console generates one and shows it once.` });
  const passRow = el("div", { class: "input-row" });
  passInput.replaceWith(passRow);
  addChildren(passRow, passInput, showPass);
  const submitLabel = el("span", {}, "Create bundle");
  const submit = el("button", { type: "submit", class: "btn btn-primary" }, icon("download"), submitLabel);
  const multiHint = el("p", { class: "field-hint span-all", hidden: true });
  const form = el("form", { class: "form-grid", novalidate: true }, recipient.wrap, passphrase.wrap, multiHint, el("div", { class: "form-actions span-all" }, submit));
  const keyBody = el("div", {});
  const keyDetails = el("details", { class: "disclosure" }, el("summary", {}, "Bundle verification key (public)"), keyBody);
  addChildren(root,
    head("Export", "An encrypted bundle (AES-256-GCM, scrypt) signed by the console's Key Vault key. Send the passphrase by a different channel than the file."),
    card("Selected keys", selectedSlot),
    card("Create the bundle", form, resultSlot),
    card("Opening a bundle", el("p", {}, "The recipient checks the signature and decrypts with the public verification key, obtained from this console rather than from the sender:"),
      el("pre", { class: "snippet-code" }, el("code", {}, "BUNDLE_PASSPHRASE='…' node scripts/open-bundle.mjs bundle.json --key bundle-key.json --out keys.json")),
      keyDetails));

  function drawSelection() {
    const items = [...ctx.selection];
    const parts = Math.ceil(items.length / EXPORT_MAX);
    submitLabel.textContent = parts > 1 ? `Create ${parts} bundles` : "Create bundle";
    multiHint.hidden = parts < 2;
    multiHint.textContent = `More than ${EXPORT_MAX} keys go into ${parts} bundles. Type a passphrase to use the same one for every part; left blank, each part gets its own.`;
    if (!items.length) {
      setChildren(selectedSlot, emptyState("No keys are selected.", "Tick keys on the Short-lived keys and Product keys pages, or export the results of a bulk issue.",
        el("a", { class: "btn btn-secondary btn-sm", href: "#/short-lived" }, "Short-lived keys"), el("a", { class: "btn btn-secondary btn-sm", href: "#/product" }, "Product keys")));
      return;
    }
    setChildren(selectedSlot,
      el("div", { class: "row between" },
        el("p", {}, el("strong", {}, fmtInt(items.length)), items.length === 1 ? " key" : " keys",
          items.length > EXPORT_MAX ? `, in ${Math.ceil(items.length / EXPORT_MAX)} bundles of up to ${EXPORT_MAX}` : ""),
        el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { ctx.clearSelection(); drawSelection(); } }, "Clear all")),
      ["jwt", "product"].map((kind) => {
        const mine = items.filter(([, v]) => v.kind === kind);
        return mine.length ? el("div", { class: "chip-group" }, el("h3", { class: "section-title" }, `${KINDS[kind].title} (${fmtInt(mine.length)})`),
          el("ul", { class: "chips chips-wrap" }, mine.map(([name, v]) => el("li", { class: "chip chip-removable" },
            el("span", { title: name }, v.title || name),
            el("button", { type: "button", class: "chip-x", "aria-label": `Remove ${v.title || name}`, onclick: () => { ctx.select({ name }, false); drawSelection(); } }, icon("close")))))) : null;
      }));
  }

  form.addEventListener("submit", busy(submit, async () => {
    const names = [...ctx.selection.keys()];
    const errors = {};
    const r1 = checkRecipient(recipient.control.value);
    const r2 = checkPassphrase(passInput.value);
    if (r1) errors.recipient = r1;
    if (r2) errors.passphrase = r2;
    if (!showErrors({ recipient, passphrase }, errors)) return;
    if (!names.length) return toast("Select keys to export first.", "error");
    const groups = chunk(names, EXPORT_MAX);
    // Download-again closures keep { filename, bundle } (ciphertext) only; passphrases go straight
    // to the secret panel and are not referenced afterwards.
    const files = [];
    const passphrases = [];
    for (const [i, group] of groups.entries()) {
      const r = await post("/api/export", { names: group, recipient: recipient.control.value.trim(), ...(passInput.value ? { passphrase: passInput.value } : {}) });
      const filename = groups.length > 1 ? String(r.filename ?? "keys.bundle.json").replace(/(\.bundle)?\.json$/, `-part-${i + 1}-of-${groups.length}$&`) : r.filename;
      downloadJson(filename, r.bundle);
      files.push({ filename, bundle: r.bundle });
      if (r.passphrase) passphrases.push({ label: groups.length === 1 ? "Passphrase" : `Part ${i + 1} of ${groups.length}`, value: r.passphrase });
    }
    const generated = passphrases.length > 0;
    passInput.value = "";
    setChildren(resultSlot, el("div", { class: "callout callout-ok" }, icon("check", "icon callout-icon"), el("div", {},
      el("p", {}, el("strong", {}, files.length === 1 ? "Bundle downloaded." : `${files.length} bundles downloaded.`),
        generated ? " The generated passphrase is shown once, now." : " They are encrypted with the passphrase you entered."),
      el("ul", { class: "file-list" }, files.map((f) => el("li", {}, el("span", { class: "mono" }, f.filename), " ",
        el("button", { type: "button", class: "btn btn-ghost btn-xs", onclick: () => downloadJson(f.filename, f.bundle) }, "Download again")))))));
    if (generated) {
      showSecret({
        title: passphrases.length === 1 ? "Bundle passphrase" : "Bundle passphrases",
        intro: passphrases.length === 1
          ? "Shown once. Send it by a different channel than the file, never in the same message. Without it the bundle cannot be opened."
          : "Shown once. Each part has its own passphrase. Send them by a different channel than the files, never in the same message.",
        secrets: passphrases.splice(0),
        opener: submit,
      });
    }
  }));

  keyDetails.addEventListener("toggle", async () => {
    if (!keyDetails.open || keyBody.childElementCount) return;
    setChildren(keyBody, loadingState("Loading the public key…", 1));
    try {
      const jwk = await cachedGet("/api/bundle-key", { ttl: Infinity });
      const text = JSON.stringify(jwk, null, 2);
      setChildren(keyBody, el("pre", { class: "snippet-code" }, el("code", {}, text)),
        el("div", { class: "row" }, copyButton(() => text, { what: "Public key" }),
          el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => downloadJson("bundle-key.json", jwk) }, icon("download"), "Download bundle-key.json")));
    } catch (error) {
      setChildren(keyBody, errorState(error));
    }
  });
  drawSelection();
}

// ── Signing ─────────────────────────────────────────────────────────────────

export function renderSigning(root) {
  const refresh = el("button", { type: "button", class: "btn btn-secondary" }, icon("refresh"), "Refresh");
  const statusSlot = el("div", {});
  const run = (label, tone, fn) => {
    const button = el("button", { type: "button", class: `btn btn-${tone}` }, label);
    button.addEventListener("click", busy(button, fn));
    return button;
  };
  const migrate = run("Migrate from API Management", "secondary", async () => {
    const r = await post("/api/signing/migrate", {});
    toast(r.migrated ? "The signing secret is now in Key Vault." : "Key Vault already holds the same signing secret.");
    await load();
  });
  const push = run("Push to API Management…", "warn", async () => {
    const ok = await confirmDialog({
      title: "Push the vault's secret to API Management?", tone: "warn", typed: "PUSH", confirmLabel: "Push secret",
      message: "API Management's copy is overwritten with the value in Key Vault.",
      points: ["Short-lived keys signed with a different secret stop working at the gateway."],
    });
    if (!ok) return;
    await post("/api/signing/push", { confirm: "PUSH" });
    toast("API Management now uses the vault's signing secret.");
    await load();
  });
  const rotate = run("Rotate signing secret…", "danger", async () => {
    const ok = await confirmDialog({
      title: "Rotate the signing secret?", typed: "ROTATE", confirmLabel: "Rotate secret",
      message: "A new secret is written to Key Vault and to API Management.",
      points: ["Every short-lived key issued before now stops working immediately.", "Product keys are not affected.", "Re-issue the short-lived keys that are still needed."],
    });
    if (!ok) return;
    await post("/api/signing/rotate", { confirm: "ROTATE" });
    toast("Signing secret rotated. Re-issue the short-lived keys that are still needed.");
    await load();
  });
  const action = (title, text, button, cls = "") => el("div", { class: ["action-row", cls] }, el("div", {}, el("h3", { class: "section-title" }, title), el("p", { class: "field-hint" }, text)), button);
  addChildren(root,
    head("Signing secret", "Key Vault holds the secret that signs short-lived keys. API Management keeps an encrypted copy to check them, because a Key Vault reference would need the vault firewall opened.", refresh),
    card("Status", statusSlot),
    card("Actions",
      action("Migrate", "First run only: copies API Management's current secret into Key Vault. It never overwrites a different value.", migrate),
      action("Push", "Copies the vault's value to API Management, for example after restoring the vault.", push),
      action("Rotate", "Writes a new secret to both. Every short-lived key issued before it stops working.", rotate, "action-danger")));

  async function load() {
    setChildren(statusSlot, loadingState("Checking the signing secret…", 1));
    try {
      const s = await get("/api/signing");
      const tile = (label, ok, yes, no) => el("div", { class: ["status-tile", ok ? "is-ok" : "is-bad"] },
        icon(ok ? "check" : "alert", "icon status-icon"), el("div", {}, el("p", { class: "kpi-label" }, label), el("p", { class: "status-value" }, ok ? yes : no)));
      setChildren(statusSlot,
        el("div", { class: "status-tiles" },
          tile("Key Vault", s.vault, "Holds the secret", "No secret — migrate it"),
          tile("API Management", s.apim, "Has a copy", "No copy"),
          tile("Copies match", s.inSync, "Yes", "No")),
        s.inSync ? null : el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"),
          el("p", {}, "Keys issued here would be refused by the gateway until the copies match. Migrate on first run, or push the vault's value.")));
    } catch (error) {
      setChildren(statusSlot, errorState(error, load));
    }
  }
  refresh.addEventListener("click", busy(refresh, load));
  load();
}
