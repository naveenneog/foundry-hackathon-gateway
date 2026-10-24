// Key Dashboard — Connect another Foundry (ADR-0018). Foundry & models lists only the Foundries
// connected to this API Management. This modal dialog lists the subscription's other accounts,
// unreadable ones with their error, with search; the chosen one shows Attach, the operator's
// commands and the guide. views-foundry.js builds the attach request and the commands, so every
// request naming an account is still made there. The choice is kept by ARM id for the page's
// lifetime.

import { badge, busy, el, emptyState, icon, openModal, setChildren, uid } from "./dom.js";
import { accountStatus, candidatesLine, KIND_LABEL, matchesAccount, sameAccount, unconnectedAccounts } from "./foundry.js";
import { fmtInt } from "./lib.js";

let chosenId = null;
/** Why the last attach of an account failed, by lower-cased ARM id, for this page load. */
const failures = new Map();
const keyOf = (a) => a.id.toLowerCase();

/** An account as a radio card: name; resource group, region and kind; its deployments or its error; badges. */
export function accountCard(a, { name, checked, onChoose, badges }) {
  const input = el("input", { type: "radio", class: "choice-input", name, value: a.id, checked });
  input.addEventListener("change", () => { if (input.checked) onChoose(a); });
  const count = a.deployments === null ? "Deployments not counted" : `${fmtInt(a.deployments)} ${a.deployments === 1 ? "deployment" : "deployments"}`;
  return el("label", { class: ["choice-card", `is-${accountStatus(a).state}`] }, input,
    el("span", { class: "choice-text" },
      el("span", { class: "choice-name" }, a.name),
      el("span", { class: "choice-meta" }, [a.resourceGroup, a.location, KIND_LABEL[a.kind] ?? a.kind].filter(Boolean).join(" · ")),
      el("span", { class: a.error ? "choice-meta choice-error" : "choice-meta" }, a.error ?? count)),
    el("span", { class: "choice-badges" }, badges));
}

/**
 * Opens the dialog over `accounts` (all of discovery) and returns it. `attach(account, progress)`
 * confirms and attaches: true once attached, false when cancelled. `attached(account)` runs once
 * an attach succeeded, after the dialog has closed. `commands(account)` gives the account's
 * operator commands, shown and copied, never run.
 */
export function openConnectDialog(ctx, { accounts, subscriptionId, opener, attach, attached, commands }) {
  const candidates = unconnectedAccounts(accounts);
  let current = candidates.find((a) => sameAccount(a.id, chosenId)) ?? candidates.find((a) => !a.error) ?? candidates[0] ?? null;
  let attachButton = null;
  const titleId = uid("connect-title");
  const search = el("input", { type: "search", class: "input", placeholder: "Search by name, resource group, region or kind", "aria-label": "Search accounts to connect" });
  const count = el("p", { class: "count", "aria-live": "polite" });
  const listSlot = el("div", {});
  const detailsSlot = el("div", {});
  const progress = el("p", { class: "field-hint connect-progress", "aria-live": "polite" });
  const closeX = el("button", { type: "button", class: "btn-icon", "aria-label": "Close" }, icon("close"));
  const close = el("button", { type: "button", class: "btn btn-secondary" }, "Close");
  const dialog = el("dialog", { class: "dialog dialog-wide connect-dialog", "aria-labelledby": titleId },
    el("div", { class: "dialog-head" }, el("h2", { class: "dialog-title", id: titleId }, icon("plug"), el("span", {}, "Connect another Foundry")), closeX),
    el("div", { class: "dialog-body" },
      el("p", {}, "Foundry and Azure OpenAI accounts in the subscription that this API Management does not route to yet. Attaching one gives it gateway routes, aliases and a key audience of its own, and adds it to the connected list."),
      el("p", { class: "field-hint" }, "Listing an account needs only read access to its metadata. It says nothing about whether the gateway may call it."),
      candidates.length ? el("div", { class: "toolbar" }, el("div", { class: "search" }, icon("search", "icon search-icon"), search), count) : null,
      listSlot, detailsSlot),
    el("div", { class: "dialog-actions connect-actions" }, progress, close));

  const shown = () => candidates.filter((a) => matchesAccount(a, search.value));

  function drawList() {
    if (!candidates.length) {
      setChildren(listSlot, emptyState("No other Foundry accounts were found.",
        `The dashboard looks for Foundry (AI Services) and Azure OpenAI accounts in subscription ${subscriptionId || "(not reported)"}. Create one, or give the dashboard read access to one, then select Refresh from Azure.`));
      return drawDetails();
    }
    const list = shown();
    count.textContent = candidatesLine(candidates, list.length);
    if (list.length) {
      const name = uid("connect");
      setChildren(listSlot, el("fieldset", { class: "choice-list" }, el("legend", { class: "sr-only" }, "Account to connect"),
        list.map((a) => accountCard(a, { name, checked: a.id === current?.id, onChoose: choose, badges: badge(accountStatus(a).label, accountStatus(a).tone) }))));
    } else {
      const clear = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Clear search");
      clear.addEventListener("click", () => { search.value = ""; drawList(); search.focus(); });
      setChildren(listSlot, emptyState("No accounts match.", "Try another search.", clear));
    }
    drawDetails();
  }

  function choose(a) {
    current = a;
    chosenId = a.id;
    drawDetails();
  }

  /** The chosen account, while the search shows it: Attach or why not, what attaching needs, and help. */
  function drawDetails() {
    attachButton = null;
    const a = current && shown().some((x) => x.id === current.id) ? current : null;
    if (!a) return setChildren(detailsSlot, candidates.length ? el("p", { class: "muted" }, "Choose an account to see what attaching it needs.") : null);
    const headingId = uid("connect-account");
    const how = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, icon("help"), "How attaching works");
    how.addEventListener("click", () => {
      // The guide is outside this modal dialog, so it stays inert until the dialog closes (U50).
      dialog.addEventListener("close", () => ctx.help?.("attach", opener), { once: true });
      dialog.close();
    });
    setChildren(detailsSlot, el("section", { class: "subsection connect-details", "aria-labelledby": headingId },
      el("h3", { class: "section-title", id: headingId }, icon("plug"), a.name),
      el("p", { class: "mono id-text" }, a.id),
      a.error ? unreadable(a, how) : attachable(a, how)));
  }

  function unreadable(a, how) {
    return [
      el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"), el("div", {},
        el("p", {}, el("strong", {}, "The dashboard cannot read this account. "), a.error),
        el("p", {}, "Attaching needs the account and its deployments to be readable. Give the dashboard read access there, then select Refresh from Azure."))),
      el("div", { class: "row" }, how),
    ];
  }

  function attachable(a, how) {
    const failed = failures.get(keyOf(a));
    attachButton = el("button", { type: "button", class: "btn btn-primary" }, icon("plug"), `Attach ${a.name}`);
    attachButton.addEventListener("click", busy(attachButton, () => run(a)));
    return [
      el("p", {}, "Attach creates the account's own gateway routes, alias maps and key audience in API Management. Existing routes, aliases and keys do not change. It does not grant the gateway access or open private networking."),
      failed ? el("div", { class: "callout callout-bad" }, icon("alert", "icon callout-icon"), el("div", {},
        el("p", {}, el("strong", {}, "Attaching failed. "), failed),
        el("p", {}, "Fix the cause, then select Attach again: it repairs a partial attempt."))) : null,
      el("div", { class: "row" }, attachButton, how),
      el("h4", { class: "test-title" }, "Access the gateway needs"),
      el("p", {}, "The gateway calls the account with its managed identity, which needs an inference role there. The dashboard only reads metadata, so it cannot grant that role."),
      commands(a),
    ];
  }

  async function run(a) {
    failures.delete(keyOf(a));
    let done;
    try {
      done = await attach(a, progress);
    } catch (error) {
      failures.set(keyOf(a), error.message);
      progress.textContent = "";
      if (dialog.open && current?.id === a.id) {
        drawDetails();
        attachButton?.focus();
      }
      throw error;
    }
    if (!done) return;
    if (!dialog.open) return attached(a);
    // After openModal's own close handling has put focus back on the opener.
    dialog.addEventListener("close", () => attached(a), { once: true });
    dialog.close();
  }

  search.addEventListener("input", drawList);
  closeX.addEventListener("click", () => dialog.close());
  close.addEventListener("click", () => dialog.close());
  drawList();
  return openModal(dialog, { opener, initialFocus: candidates.length ? search : close });
}
