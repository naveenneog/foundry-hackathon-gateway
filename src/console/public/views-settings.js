// liteAPIM — Settings: the gateway URL that keys are handed out with (P59, ADR-0019) and the
// secret that signs short-lived keys (moved here from the Signing page). Both read fresh state on
// every visit; nothing here is cached.

import { get, invalidate, post } from "./api.js";
import { addChildren, badge, busy, confirmDialog, el, errorState, field, icon, loadingState, setChildren, showErrors, toast, uid } from "./dom.js";
import { checkGatewayUrl, fmtRelative } from "./lib.js";

function card(title, { attrs, actions } = {}, ...children) {
  const id = uid("card");
  return el("section", { class: "card", "aria-labelledby": id, ...attrs },
    actions ? el("div", { class: "card-head" }, el("h2", { class: "card-title", id }, title), actions) : el("h2", { class: "card-title", id }, title),
    children);
}

export function renderSettings(root) {
  addChildren(root,
    el("header", { class: "view-head" },
      el("div", {}, el("h1", { class: "view-title", tabindex: "-1" }, "Settings"),
        el("p", { class: "lede" }, "The address keys are handed out with, and the secret that signs short-lived keys."))),
    gatewayUrlCard(),
    signingCard());
}

// ── Gateway URL (custom domain) ─────────────────────────────────────────────

function gatewayUrlCard() {
  const statusSlot = el("div", { class: "gateway-status" });
  const offerSlot = el("div", {});
  const input = el("input", { type: "url", class: "input mono", placeholder: "https://ai.contoso.com", autocomplete: "off", spellcheck: "false", "data-help-focus": true });
  const url = field({ label: "Gateway URL (custom domain)", control: input,
    hint: "https:// and a host name only. It must be a gateway custom domain of this API Management: add it in the Azure portal (the API Management instance, Custom domains) first." });
  const save = el("button", { type: "submit", class: "btn btn-primary" }, "Save");
  const reset = el("button", { type: "button", class: "btn btn-secondary", hidden: true }, "Reset to API Management URL");
  const form = el("form", { class: "gateway-form", novalidate: true }, url.wrap, el("div", { class: "form-actions" }, save, reset));
  let current = null;

  function draw(s) {
    current = s;
    const custom = s.effectiveUrl !== s.apimUrl;
    setChildren(statusSlot,
      el("p", { class: "gateway-now" }, "New keys use ", el("span", { class: "mono id-text" }, s.effectiveUrl), " ",
        custom ? badge("custom domain", "ok") : badge("API Management URL", "grey")),
      s.problem ? el("div", { class: "callout callout-warn" }, icon("alert", "icon callout-icon"), el("p", {}, s.problem)) : null,
      el("p", { class: "field-hint" }, "Keys already handed out keep working: API Management answers on its own URL, ",
        el("span", { class: "mono" }, s.apimUrl), ", and on each custom domain."),
      s.updatedAt ? el("p", { class: "field-hint" }, `Changed by ${s.updatedBy ?? "an admin"}, ${fmtRelative(s.updatedAt)}.`) : null);
    reset.hidden = !s.customUrl && !s.problem;
    const offers = Array.isArray(s.candidates) ? s.candidates : [];
    setChildren(offerSlot, offers.length
      ? el("div", { class: "gateway-offers" }, el("p", { class: "field-hint" }, "Gateway custom domains on this API Management:"),
        el("ul", { class: "chips chips-wrap" }, offers.map((o) => el("li", {},
          el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { input.value = o; url.setError(null); input.focus(); } }, `Use ${o}`)))))
      : el("p", { class: "field-hint" }, "This API Management has no gateway custom domain yet. Add one in the Azure portal (the API Management instance, Custom domains), then choose it here."));
  }

  async function load() {
    setChildren(statusSlot, loadingState("Reading the gateway URL…", 1));
    try {
      draw(await get("/api/gateway-url"));
    } catch (error) {
      setChildren(statusSlot, errorState(error, load));
    }
  }

  /** After a change: issue forms read the Foundry config (and its base URL) again. */
  async function applied(message) {
    invalidate("/api/config");
    toast(message);
    await load();
  }

  form.addEventListener("submit", busy(save, async () => {
    const value = input.value.trim();
    const problem = checkGatewayUrl(value);
    if (!showErrors({ url }, problem ? { url: problem } : {})) return;
    let r;
    try {
      r = await post("/api/gateway-url", { url: value });
    } catch (error) {
      if (error?.status !== 400) throw error;
      showErrors({ url }, { url: error.message });
      return;
    }
    await applied(r.changed
      ? `New keys now use ${r.effectiveUrl}. Keys already handed out keep working on ${r.apimUrl}.`
      : `${r.effectiveUrl} is already in use.`);
  }));

  reset.addEventListener("click", busy(reset, async () => {
    const apimUrl = current?.apimUrl ?? "the API Management URL";
    const ok = await confirmDialog({
      title: "Use the API Management URL again?", tone: "warn", confirmLabel: "Reset",
      message: `New keys, Reveal, keys.csv, export bundles and Foundry base URLs will name ${apimUrl}.`,
      points: ["Keys handed out with the custom domain keep working while it stays a custom domain of API Management."],
    });
    if (!ok) return;
    const r = await post("/api/gateway-url/reset", {});
    await applied(`New keys use ${r.effectiveUrl} again.`);
    input.focus();
  }));

  load();
  return card("Gateway URL", { attrs: { "data-help": "gateway-url" } },
    el("p", {}, "Keys, their setup snippets, keys.csv, export bundles and the Foundry base URLs name this address. It is API Management's own URL unless a custom domain of API Management replaces it."),
    statusSlot, form, offerSlot,
    el("p", { class: "field-hint" }, "Other replicas of liteAPIM use a change within 30 seconds; browser tabs that are already open, after a reload."));
}

// ── Signing secret ──────────────────────────────────────────────────────────

function signingCard() {
  const refresh = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("refresh"), "Refresh");
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
  return card("Signing secret", { actions: refresh },
    el("p", {}, "Key Vault holds the secret that signs short-lived keys. API Management keeps an encrypted copy to check them, because a Key Vault reference would need the vault firewall opened."),
    statusSlot,
    action("Migrate", "First run only: copies API Management's current secret into Key Vault. It never overwrites a different value.", migrate),
    action("Push", "Copies the vault's value to API Management, for example after restoring the vault.", push),
    action("Rotate", "Writes a new secret to both. Every short-lived key issued before it stops working.", rotate, "action-danger"));
}
