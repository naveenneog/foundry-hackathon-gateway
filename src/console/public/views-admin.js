// liteAPIM — admin views: Export (encrypted, signed bundles). The signing secret and the gateway
// URL are on Settings (views-settings.js); Foundry accounts, deployments and pins are views-foundry.js.

import { cachedGet, post } from "./api.js";
import {
  addChildren, busy, copyButton, downloadJson, el, emptyState, errorState, field, icon, loadingState, setChildren, showErrors, toast, uid,
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
  const passphrase = field({ label: "Passphrase", optional: true, control: passInput, hint: `At least ${LIMITS.passphrase} characters. Leave it blank and liteAPIM generates one and shows it once.` });
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
    head("Export", "An encrypted bundle (AES-256-GCM, scrypt) signed by liteAPIM's Key Vault key. Send the passphrase by a different channel than the file."),
    card("Selected keys", selectedSlot),
    card("Create the bundle", form, resultSlot),
    card("Opening a bundle", el("p", {}, "The recipient checks the signature and decrypts with the public verification key, obtained from liteAPIM rather than from the sender:"),
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

