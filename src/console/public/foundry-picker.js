// Key Dashboard — the Foundry choice that starts both issue forms (ADR-0017, ADR-0018). Only the
// Foundries connected to this API Management are offered, each with its region, resource group
// and kind; other accounts in the subscription are neither listed nor counted. The base URL of the
// chosen one shows once its models load. The choice is kept by ARM id for the page's lifetime,
// never by name, and changing it hands the caller a new account so the model choice starts again.

import { invalidate } from "./api.js";
import { badge, busy, el, emptyState, errorState, icon, loadingState, setChildren, uid } from "./dom.js";
import { accountsOf, connectedAccounts, KIND_LABEL, pickAccount } from "./foundry.js";

let chosenId = null;

/**
 * The Foundry fieldset. `onChoose(account)` runs for the first choice and every change, with null
 * when nothing can be chosen; the caller drops its model choice then.
 */
export function foundryChooser(ctx, { onChoose }) {
  const hintId = uid("foundry-hint");
  const error = el("p", { class: "field-error", id: uid("foundry-error"), hidden: true });
  const slot = el("div", {});
  const target = el("p", { class: "foundry-target", hidden: true });
  const status = el("p", { class: "sr-only", "aria-live": "polite" });
  const reload = el("button", { type: "button", class: "btn btn-ghost btn-xs" }, icon("refresh"), "Reload the list");
  const explain = el("button", { type: "button", class: "btn btn-ghost btn-xs" }, icon("help"), "Which Foundry?");
  const wrap = el("fieldset", { class: "foundry-choice", "data-help": "issue-foundry", "aria-describedby": `${hintId} ${error.id}` },
    el("legend", { class: "field-label" }, "Foundry"),
    el("p", { class: "field-hint", id: hintId }, "Keys work only with the Foundry chosen here, and only its models are listed below. Only Foundries connected to this API Management are offered."),
    slot, target, error, el("div", { class: "row" }, reload, explain), status);
  let account = null;
  let accounts = [];

  function choose(next, announce) {
    account = next ?? null;
    if (account) chosenId = account.id;
    setError(null);
    target.hidden = true;
    setChildren(target);
    for (const radio of slot.querySelectorAll(".choice-input")) radio.toggleAttribute("data-help-focus", radio.value === account?.id);
    if (announce && account) status.textContent = `${account.name} chosen. The model choice was cleared: choose from ${account.name}'s models.`;
    onChoose(account);
  }

  function option(a, name) {
    const input = el("input", { type: "radio", class: "choice-input", name, value: a.id, checked: a.id === account?.id });
    input.addEventListener("change", () => { if (input.checked && a.id !== account?.id) choose(a, true); });
    return el("label", { class: "choice-card" }, input,
      el("span", { class: "choice-text" },
        el("span", { class: "choice-name" }, a.name),
        el("span", { class: "choice-meta" }, [a.location, a.resourceGroup, KIND_LABEL[a.kind] ?? a.kind].filter(Boolean).join(" · "))),
      el("span", { class: "choice-badges" }, a.isDefault ? badge("default", "info", "The gateway's original Foundry") : null,
        a.error ? badge("check access", "warn", a.error) : null));
  }

  function draw() {
    if (!accounts.length) {
      setChildren(slot, emptyState("No Foundry is connected to this API Management yet.",
        "Keys can be issued only for a connected Foundry. Connect one and pin its models on Foundry & models, then issue keys for it.",
        el("a", { class: "btn btn-primary btn-sm", href: "#/models" }, icon("plug"), "Open Foundry & models")));
      return;
    }
    const name = uid("foundry");
    setChildren(slot, el("div", { class: "choice-list" }, accounts.map((a) => option(a, name))));
  }

  async function load(fresh = false) {
    setChildren(slot, loadingState("Loading Foundry accounts…", 2));
    let data;
    try {
      data = await ctx.foundries({ fresh });
    } catch (e) {
      accounts = [];
      setChildren(slot, errorState(e, () => load(true)));
      choose(null, false);
      return;
    }
    accounts = connectedAccounts(accountsOf(data));
    account = pickAccount(accounts, account?.id ?? chosenId, data.defaultFoundryId);
    draw();
    choose(account, false);
  }

  function setError(message) {
    error.textContent = message ?? "";
    error.hidden = !message;
    wrap.classList.toggle("is-invalid", Boolean(message));
  }

  reload.addEventListener("click", busy(reload, async () => {
    invalidate("/api/foundries", "/api/config");
    await load(true);
  }));
  explain.addEventListener("click", () => ctx.help?.("issue", explain));
  load();

  return {
    wrap,
    get account() { return account; },
    /** Shows where keys for the chosen Foundry go: the server's base URL for it, never one built here. */
    setTarget(url) {
      const text = String(url ?? "").trim();
      target.hidden = !text || !account;
      setChildren(target, text && account ? [`Keys for ${account.name} call `, el("span", { class: "mono" }, text), "."] : null);
    },
    setError,
    /** Reloads the list and chooses again, for a retry after a failed read. */
    reload: () => load(true),
    focus() {
      (slot.querySelector(".choice-input:checked") ?? slot.querySelector(".choice-input") ?? reload).focus();
    },
  };
}
