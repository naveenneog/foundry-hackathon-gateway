// Key Dashboard — Foundry & models (ADR-0017, ADR-0018): the Foundries connected to this API
// Management, that is the default account and each attached one, with their deployments. See the
// access each still needs, test it, and pin its deployments to aliases of its own. The
// subscription's other accounts are listed only in Connect another Foundry (foundry-connect.js),
// which attaches them through this view. The chosen account is kept by ARM id while the page is
// open. Nothing polls: Refresh from Azure re-reads accounts, deployments, pins and config.

import { apiPath, cachedGet, invalidate, post } from "./api.js";
import {
  addChildren, badge, busy, confirmDialog, copyButton, el, emptyState, errorState, icon, loadingState, routeBadge, setChildren, toast, uid,
} from "./dom.js";
import {
  accountsOf, accountStatus, attachBody, attachSummary, commandsFor, connectedAccounts, connectedLine, deploymentState, FOUNDRY_CACHES, foreignAnswer, KIND_LABEL,
  matchesAccount, matchesDeployment, parseChoice, pickAccount, pinBlockReason, pinBody, routeReason, testAvailability, testBody, testSummary, unpinBody,
} from "./foundry.js";
import { accountCard, openConnectDialog } from "./foundry-connect.js";
import { checkAlias, fmtInt, ROUTE_LABEL } from "./lib.js";

const WIRE_LABEL = { "openai-chat-completions": "OpenAI chat completions", "anthropic-messages": "Anthropic Messages", unknown: "Unknown format" };
const FILTER_FROM = 7;

/** The account on screen, by ARM id, kept for the page's lifetime. */
let chosenId = null;
/** Attach and test outcomes per account, for this page load only. They hold no key or token. */
const outcomes = new Map();
function outcomeOf(id) {
  const key = String(id).toLowerCase();
  if (!outcomes.has(key)) outcomes.set(key, {});
  return outcomes.get(key);
}

/** The role setup command, shown and copied for an operator; the dashboard never runs it. */
function setupBlock(setup, helpFocus) {
  if (!setup) return el("p", { class: "field-hint" }, "The server sent no setup command for this account.");
  const copy = copyButton(() => setup, { label: "Copy command", what: "Setup command" });
  if (helpFocus) copy.setAttribute("data-help-focus", "");
  return [el("p", { class: "field-hint" }, "Have someone who can assign roles on the account run this in PowerShell. The dashboard shows it and never runs it."),
    el("pre", { class: "snippet-code" }, el("code", {}, setup)), el("div", { class: "row" }, copy)];
}

/** An unconnected account's operator commands, for Connect another Foundry. */
const candidateCommands = (a) => [setupBlock(a.setupCommand, false), a.networkCommand ? networkSetup(a.networkCommand, false) : null];

/** The optional private-network command: copy only, closed unless the last test points at the network. */
function networkSetup(command, suggested) {
  return el("details", { class: ["disclosure", "network-setup", suggested ? "is-suggested" : null], open: suggested },
    el("summary", {}, "Private network setup (optional)"),
    el("div", {},
      el("p", {}, "Only for an account that API Management must reach privately. It creates a private endpoint and a private DNS record for this account in the gateway's virtual network. It does not change the account's public network access or firewall."),
      el("p", { class: "field-hint" }, "Run it as an operator in PowerShell; the dashboard never runs it. A private endpoint is billed by the hour and for the data it processes."),
      el("pre", { class: "snippet-code" }, el("code", {}, command)),
      el("div", { class: "row" }, copyButton(() => command, { label: "Copy network command", what: "Network setup command" }))));
}

const accountBadges = (a) => [a.isDefault ? badge("default", "info", "The gateway's original Foundry") : null, a.error ? badge("check access", "warn", a.error) : null];

function card(title, attrs, ...children) {
  const id = uid("card");
  return el("section", { class: "card", "aria-labelledby": id, ...attrs }, el("h2", { class: "card-title", id }, title), children);
}

function subsection(title, iconName, attrs, slot) {
  const id = uid("sub");
  return el("section", { class: "subsection", "aria-labelledby": id, ...attrs }, el("h3", { class: "section-title", id }, icon(iconName), title), slot);
}

/** Attach and test outcomes: warn for "routing only", ok or bad for a test, with what to check. */
function notice(s) {
  return el("div", { class: `callout callout-${s.tone}` }, icon(s.tone === "ok" ? "check" : "alert", "icon callout-icon"),
    el("div", {}, el("p", {}, el("strong", {}, s.title)), s.lines.map((line) => el("p", { class: "callout-detail" }, line)),
      s.guidance?.length ? [el("p", {}, "What to check:"), el("ul", { class: "dialog-points" }, s.guidance.map((g) => el("li", {}, g)))] : null));
}

export function renderFoundry(root, ctx) {
  const guide = el("button", { type: "button", class: "btn btn-ghost" }, icon("help"), "How this works");
  guide.addEventListener("click", () => ctx.help?.("discover", guide));
  const refresh = el("button", { type: "button", class: "btn btn-secondary", "data-help-focus": true }, icon("refresh"), "Refresh from Azure");
  const summary = el("p", { class: "count", "aria-live": "polite" });
  const filter = el("input", { type: "search", class: "input", placeholder: "Filter connected Foundries", "aria-label": "Filter connected Foundries" });
  const filterBox = el("div", { class: "search", hidden: true }, icon("search", "icon search-icon"), filter);
  const noteSlot = el("div", {});
  const listSlot = el("div", {});
  const accountsId = uid("card");
  const accountTitle = el("h2", { class: "card-title", id: uid("card"), tabindex: "-1" }, "Foundry account");
  const detailsSlot = el("div", {});
  const routesSlot = el("div", { class: "subsection-body" });
  const accessSlot = el("div", { class: "subsection-body" });
  const pinsHint = el("p", { class: "field-hint" });
  const pinsSlot = el("div", {});
  const depHint = el("p", { class: "field-hint" });
  const search = el("input", { type: "search", class: "input", placeholder: "Search deployments, models or aliases", "aria-label": "Search deployments" });
  const depCount = el("p", { class: "count", "aria-live": "polite" });
  const depSlot = el("div", {});

  addChildren(root,
    el("header", { class: "view-head" },
      el("div", {}, el("h1", { class: "view-title", tabindex: "-1" }, "Foundry & models"),
        el("p", { class: "lede" }, "The Foundry and Azure OpenAI accounts connected to this API Management, with their deployments. Pin a Foundry's models to aliases, then issue keys for it. Connect another Foundry to add one.")),
      el("div", { class: "view-actions" }, guide)),
    el("section", { class: "card", "aria-labelledby": accountsId, "data-help": "foundry-accounts" },
      el("div", { class: "card-head" }, el("h2", { class: "card-title", id: accountsId }, "Connected Foundries"), refresh),
      el("p", { class: "field-hint" }, "Each has gateway routes, aliases and a key audience of its own in this API Management. Keys are issued only for these Foundries."),
      el("div", { class: "toolbar" }, filterBox, summary), noteSlot, listSlot),
    el("section", { class: "card", "aria-labelledby": accountTitle.getAttribute("id") }, accountTitle, detailsSlot,
      subsection("Gateway routes", "plug", {}, routesSlot),
      subsection("Access and connection test", "key", { "data-help": "foundry-access" }, accessSlot)),
    card("Pinned aliases", { "data-help": "foundry-pins" }, pinsHint, pinsSlot),
    card("Deployments", { "data-help": "foundry-deployments" }, depHint,
      el("div", { class: "toolbar" }, el("div", { class: "search" }, icon("search", "icon search-icon"), search), depCount), depSlot));

  let discovery = null;
  let selected = null;
  let models = null;
  let turn = 0;

  async function load(fresh = false) {
    setChildren(listSlot, loadingState("Finding Foundry accounts…", 3));
    setChildren(noteSlot);
    summary.textContent = "";
    let data;
    try {
      data = await ctx.foundries({ fresh });
    } catch (error) {
      discovery = { error };
      selected = null;
      setChildren(listSlot, errorState(error, () => load(true)));
      drawAccount();
      return;
    }
    if (!root.isConnected) return;
    const accounts = accountsOf(data);
    const connected = connectedAccounts(accounts);
    discovery = { accounts, connected, data };
    selected = pickAccount(connected, chosenId, data.defaultFoundryId);
    chosenId = selected?.id ?? null;
    drawAccounts();
    await loadModels(fresh);
  }

  async function loadModels(fresh = false) {
    const account = selected;
    const mine = ++turn;
    models = null;
    drawAccount();
    if (!account) return;
    try {
      const data = await cachedGet(apiPath("/api/models", { foundryId: account.id }), { ttl: Infinity, fresh });
      if (mine !== turn) return;
      const foreign = foreignAnswer(data, account);
      models = foreign ? { error: new Error(foreign) } : data;
    } catch (error) {
      if (mine !== turn) return;
      models = { error };
    }
    drawModels();
    drawAccess();
  }

  function choose(a) {
    if (selected?.id === a.id) return;
    selected = a;
    chosenId = a.id;
    loadModels(false);
  }

  // ── Accounts ──

  function drawAccounts() {
    const { connected, data } = discovery;
    summary.textContent = connectedLine(connected);
    const note = typeof data.note === "string" ? data.note.trim() : "";
    setChildren(noteSlot, note ? el("div", { class: "callout callout-warn" }, icon("alert", "icon callout-icon"), el("p", {}, note)) : null);
    filterBox.hidden = connected.length < FILTER_FROM;
    if (!connected.length) {
      setChildren(listSlot, el("div", { "data-help": "foundry-attach" }, emptyState("No Foundry is connected to this API Management yet.",
        "Keys can be issued only for a Foundry that API Management routes to. Connect a Foundry or Azure OpenAI account to give it gateway routes, then pin its models.",
        connectButton("btn-primary"))));
      return;
    }
    const shown = connected.filter((a) => matchesAccount(a, filter.value));
    const name = uid("account");
    setChildren(listSlot,
      shown.length
        ? el("fieldset", { class: "choice-list" }, el("legend", { class: "sr-only" }, "Connected Foundry"),
          shown.map((a) => accountCard(a, { name, checked: a.id === selected?.id, onChoose: choose, badges: accountBadges(a) })))
        : emptyState("No connected Foundry matches.", "Try another filter."),
      el("div", { class: "action-row connect-row", "data-help": "foundry-attach" },
        el("div", {}, el("p", { class: "field-hint" }, "Other accounts in the subscription are listed only once connected. Connecting one gives it gateway routes, aliases and a key audience of its own.")),
        connectButton("btn-secondary")));
  }

  /** Opens Connect another Foundry over the accounts discovery found; one button at a time carries data-focus-id. */
  function connectButton(variant) {
    const button = el("button", { type: "button", class: ["btn", variant], "data-help-focus": true, "data-focus-id": "foundry-connect" }, icon("plug"), "Connect another Foundry");
    button.addEventListener("click", () => openConnectDialog(ctx, {
      accounts: discovery.accounts, subscriptionId: discovery.data.subscriptionId, opener: button,
      attach: attachAccount, attached: afterAttach, commands: candidateCommands,
    }));
    return button;
  }

  // ── The chosen account ──

  function drawAccount() {
    const a = selected;
    accountTitle.textContent = a ? a.name : "Foundry account";
    if (!a) {
      setChildren(detailsSlot, el("p", { class: "muted" }, discovery?.error ? "The account list could not be loaded." : "Connect a Foundry to see its routes, access, pins and deployments."));
      for (const slot of [routesSlot, accessSlot, pinsSlot, depSlot]) setChildren(slot);
      pinsHint.textContent = "";
      depHint.textContent = "";
      depCount.textContent = "";
      return;
    }
    drawDetails(a);
    drawRoutes(a);
    drawAccess();
    if (!models) {
      pinsHint.textContent = "";
      depHint.textContent = "";
      depCount.textContent = "";
      setChildren(pinsSlot, loadingState("Loading pins…", 2));
      setChildren(depSlot, loadingState(`Loading ${a.name}'s deployments…`, 4));
    }
  }

  function drawDetails(a) {
    const st = accountStatus(a);
    const rows = [];
    const add = (term, ...value) => rows.push(el("dt", {}, term), el("dd", {}, ...value));
    add("State", badge(st.label, st.tone), " ", el("span", { class: st.state === "error" ? "text-bad" : "muted" }, st.detail));
    add("Kind", KIND_LABEL[a.kind] ?? (a.kind || "—"));
    add("Resource group", a.resourceGroup || "—");
    add("Region", a.location || "—");
    add("Deployments", a.deployments === null ? "not counted" : fmtInt(a.deployments));
    add("Resource ID", el("span", { class: "mono id-text" }, a.id));
    setChildren(detailsSlot, el("dl", { class: "details" }, rows));
  }

  /** A connected account's routes. Attaching another account happens in Connect another Foundry. */
  function drawRoutes(a) {
    const how = el("button", { type: "button", class: "btn btn-ghost btn-xs" }, icon("help"), "How attaching works");
    how.addEventListener("click", () => ctx.help?.("attach", how));
    const base = el("span", { class: "mono id-text" }, "loading…");
    const attached = outcomeOf(a.id).attach;
    setChildren(routesSlot,
      a.isDefault
        ? el("p", {}, "The gateway's default Foundry: its original routes, aliases and keys.")
        : el("p", {}, "Attached as connection ", el("span", { class: "mono" }, a.connectionId ?? "not reported"), ", with its own routes, aliases and key audience."),
      el("p", { class: "field-hint" }, "Keys for this Foundry call ", base),
      attached ? notice(attached) : null,
      el("div", { class: "row" }, how));
    showBaseUrl(a, base);
  }

  async function showBaseUrl(a, node) {
    try {
      const config = await ctx.config(a.id);
      node.textContent = foreignAnswer(config, a) ? "not available: the server answered for another Foundry" : String(config.gatewayUrl || "not reported");
    } catch (error) {
      node.textContent = `not available (${error.message})`;
    }
  }

  /** Confirms, then attaches `a`: true once API Management routes to it, false when cancelled. Connect another Foundry calls it. */
  async function attachAccount(a, progress) {
    const ok = await confirmDialog({
      title: `Attach ${a.name}?`, tone: "primary", confirmLabel: "Attach Foundry",
      message: "API Management gets gateway routes for this account, with its own alias maps and key audience. Existing routes, aliases and keys do not change.",
      points: ["It does not grant the gateway access to the account or open private networking.", "Next: run the setup command it shows, pin aliases, then test the connection."],
    });
    if (!ok) return false;
    progress.textContent = `Attaching ${a.name}. API Management can take a minute or two.`;
    outcomeOf(a.id).attach = attachSummary(await post("/api/foundries/attach", attachBody(a)));
    return true;
  }

  /** After an attach: the account joins the connected list, selected. Its access section takes focus unless the admin is busy elsewhere. */
  async function afterAttach(a) {
    const active = document.activeElement;
    const idle = !active || active === document.body || listSlot.contains(active);
    invalidate(...FOUNDRY_CACHES);
    chosenId = a.id;
    toast(`Routing configured for ${a.name}. Access is not verified yet: run the setup command, pin an alias, then test.`);
    await load(true);
    if (idle && root.isConnected && selected?.id === a.id) (accessSlot.querySelector("[data-help-focus]") ?? accountTitle).focus();
  }

  function drawAccess() {
    const a = selected;
    if (!a) return setChildren(accessSlot);
    const out = outcomeOf(a.id);
    const { setup, network } = commandsFor(out.attach, models && !models.error ? models : null, a);
    const networkBox = network ? networkSetup(network, out.test?.suggestNetwork === true) : null;
    const availability = models && !models.error ? testAvailability(a, models.pins)
      : { allowed: false, reason: models?.error ? "This Foundry's pins could not be read; see Deployments below." : "Loading this Foundry's pins…", choices: [] };
    setChildren(accessSlot,
      el("p", {}, "The gateway calls this account with its managed identity, which needs an inference role here. The dashboard only reads metadata, so it cannot grant that role."),
      setupBlock(setup, true),
      networkBox ?? el("p", { class: "field-hint" }, "Private endpoint? API Management must reach the account from its virtual network, with the account's private DNS zone linked to that network."),
      testControls(a, availability, out, !setup, networkBox));
  }

  /** A test outcome; one that points at the network also points at the network command, when there is one. */
  function testNotice(outcome, networkBox) {
    if (!outcome.suggestNetwork || !networkBox) return notice(outcome);
    return notice({ ...outcome, guidance: [...outcome.guidance, "Private network setup, above, has the command that does this for this account."] });
  }

  function testControls(a, availability, out, focusHere, networkBox) {
    const result = el("div", { "aria-live": "polite" }, out.test ? testNotice(out.test, networkBox) : null);
    const reasonId = uid("test-why");
    const choice = el("select", { class: "input", "aria-label": "Alias to test", disabled: !availability.allowed },
      availability.choices.map((c) => el("option", { value: c.value }, `${c.alias} · ${ROUTE_LABEL[c.route]} · ${c.deployment}`)));
    const run = el("button", { type: "button", class: "btn btn-secondary", disabled: !availability.allowed, "aria-describedby": availability.allowed ? undefined : reasonId,
      "data-help-focus": focusHere || undefined }, "Test connection");
    run.addEventListener("click", busy(run, async () => {
      const picked = parseChoice(choice.value);
      if (!picked) return;
      const ok = await confirmDialog({
        title: "Send a test request?", tone: "primary", confirmLabel: "Send test request",
        message: `The gateway sends one small inference request to ${picked.alias} on ${a.name}.`,
        points: ["It uses a few tokens, billed to that account.", "No key is created or shown.", "It checks the gateway's permission and network path end to end."],
      });
      if (!ok) return;
      setChildren(result, loadingState("Sending the test request…", 1));
      let outcome;
      try {
        outcome = testSummary(await post("/api/foundries/test", testBody(a, picked)), picked.alias);
      } catch (error) {
        if (error.status === 401) {
          setChildren(result);
          throw error;
        }
        outcome = testSummary({ ok: false, status: error.status, detail: error.message }, picked.alias);
      }
      out.test = outcome;
      setChildren(result, testNotice(outcome, networkBox));
      if (outcome.suggestNetwork && networkBox) {
        networkBox.open = true;
        networkBox.classList.add("is-suggested");
      }
    }));
    return el("div", { class: "test-box" },
      el("h4", { class: "test-title" }, "Test connection"),
      el("p", { class: "field-hint" }, "Run it after granting access and pinning an alias. One small request through the gateway; it uses a few tokens."),
      el("div", { class: "row" }, choice, run),
      availability.allowed ? null : el("p", { class: "field-hint", id: reasonId }, availability.reason),
      result);
  }

  // ── Pins and deployments ──

  function drawModels() {
    const a = selected;
    if (!a || !models) return;
    if (models.error) {
      pinsHint.textContent = "";
      depHint.textContent = `In ${a.name}.`;
      depCount.textContent = "";
      setChildren(pinsSlot, el("p", { class: "muted" }, "Pins are not shown: this Foundry's deployments could not be read."));
      setChildren(depSlot, errorState(models.error, () => loadModels(true)));
      return;
    }
    drawPins(a);
    drawDeployments(a);
  }

  async function changed(message) {
    toast(message);
    invalidate("/api/models", "/api/config");
    await loadModels(true);
  }

  function drawPins(a) {
    pinsHint.textContent = `Short-lived keys for ${a.name} grant these aliases. Each Foundry has its own pins, per route.`;
    const pins = models.pins ?? {};
    const routes = a.kind === "OpenAI" ? ["openai"] : ["openai", "claude"];
    setChildren(pinsSlot, el("div", { class: "pin-columns" }, routes.map((route) => {
      const list = Array.isArray(pins[route]) ? pins[route] : [];
      return el("div", { class: "pin-column" },
        el("h3", { class: "section-title" }, routeBadge(route), ` ${ROUTE_LABEL[route]} route`),
        list.length ? el("table", { class: "table table-dense" },
          el("caption", { class: "sr-only" }, `Aliases pinned to the ${ROUTE_LABEL[route]} route of ${a.name}`),
          el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Alias"), el("th", { scope: "col" }, "Deployment"), el("th", { scope: "col" }, el("span", { class: "sr-only" }, "Actions")))),
          el("tbody", {}, list.map((p) => {
            const unpin = el("button", { type: "button", class: "btn btn-danger-ghost btn-sm", "aria-label": `Unpin ${p.alias}` }, "Unpin");
            unpin.addEventListener("click", busy(unpin, async () => {
              const ok = await confirmDialog({
                title: `Unpin ${p.alias}?`, confirmLabel: "Unpin alias",
                message: `Short-lived keys for ${a.name} that grant ${p.alias} are refused for it until an alias of that name is pinned again.`,
              });
              if (!ok) return;
              await post("/api/models/unpin", unpinBody(a, p.alias, route));
              await changed(`Unpinned ${p.alias} from the ${ROUTE_LABEL[route]} route of ${a.name}.`);
            }));
            return el("tr", {}, el("th", { scope: "row", class: "mono" }, p.alias), el("td", { class: "mono" }, p.deployment), el("td", { class: "actions" }, unpin));
          }))) : el("p", { class: "muted" }, "Nothing is pinned to this route."));
    })));
  }

  function drawDeployments(a) {
    const all = Array.isArray(models.deployments) ? models.deployments : [];
    const usable = (d) => !pinBlockReason(d, a.connected);
    const sorted = [...all].sort((x, y) => Number(usable(y)) - Number(usable(x)) || String(x.deployment).localeCompare(String(y.deployment)));
    const list = sorted.filter((d) => matchesDeployment(d, search.value));
    const pinnable = all.filter(usable).length;
    depHint.textContent = `In ${a.name}. Product keys grant these deployment names directly; short-lived keys grant aliases pinned to them. Deployments the gateway cannot serve stay listed with the reason.`;
    depCount.textContent = !all.length ? "" : `${fmtInt(all.length)} ${all.length === 1 ? "deployment" : "deployments"}: ${fmtInt(pinnable)} can be pinned${
      all.length > pinnable ? `, ${fmtInt(all.length - pinnable)} cannot` : ""}${list.length < all.length ? ` · ${fmtInt(list.length)} shown` : ""}.`;
    if (!all.length) return setChildren(depSlot, emptyState("No deployments in this Foundry.", `Deploy a model in ${a.name}, then select Refresh from Azure.`));
    if (!list.length) {
      const clear = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Clear search");
      clear.addEventListener("click", () => { search.value = ""; drawDeployments(a); search.focus(); });
      return setChildren(depSlot, emptyState("No deployments match.", "Try another search.", clear));
    }
    setChildren(depSlot, el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("caption", { class: "sr-only" }, `Deployments in ${a.name}`),
      el("thead", {}, el("tr", {}, ["Deployment", "Model", "Format and route", "State", "Pinned as", "Pin an alias"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, list.map((d) => deploymentRow(a, d))))));
  }

  function deploymentRow(a, d) {
    const blocked = pinBlockReason(d, a.connected);
    const reasonId = uid("why");
    const alias = el("input", { type: "text", class: "input input-narrow mono", value: d.suggestedAlias ?? "", disabled: Boolean(blocked), spellcheck: "false", autocomplete: "off", "aria-label": `Alias for ${d.deployment}` });
    const pin = el("button", { type: "submit", class: "btn btn-secondary btn-sm", disabled: Boolean(blocked), "aria-describedby": blocked ? reasonId : undefined }, "Pin");
    const error = el("p", { class: "field-error", hidden: true, id: uid("pin-error") });
    alias.setAttribute("aria-describedby", blocked ? reasonId : error.id);
    const form = el("form", { class: "pin-form", novalidate: true }, el("div", { class: "row row-tight" }, alias, pin), error,
      blocked ? el("p", { class: "field-hint", id: reasonId }, blocked) : null);
    form.addEventListener("submit", busy(pin, async () => {
      if (selected?.id !== a.id || pinBlockReason(d, a.connected)) return;
      const value = alias.value.trim().toLowerCase();
      const taken = ["openai", "claude"].flatMap((r) => (Array.isArray(models?.pins?.[r]) ? models.pins[r] : [])).find((p) => p.alias === value);
      const message = checkAlias(value, d.route) ?? (taken ? `${value} is already pinned to ${taken.deployment} on this Foundry. Unpin it first.` : null);
      error.textContent = message ?? "";
      error.hidden = !message;
      if (message) {
        alias.setAttribute("aria-invalid", "true");
        alias.focus();
        return;
      }
      alias.removeAttribute("aria-invalid");
      await post("/api/models/pin", pinBody(a, d, value));
      await changed(`Pinned ${value} to ${d.deployment} on the ${ROUTE_LABEL[d.route]} route of ${a.name}.`);
    }));
    const pinned = Array.isArray(d.pinnedAs) ? d.pinnedAs : [];
    const state = deploymentState(d);
    const noRoute = routeReason(d);
    return el("tr", { class: blocked ? "row-muted" : null },
      el("th", { scope: "row", class: "mono" }, d.deployment),
      el("td", {}, d.model ?? "—", d.version ? el("span", { class: "cell-sub" }, `version ${d.version}`) : null),
      el("td", {}, el("span", {}, WIRE_LABEL[d.wire] ?? d.wire ?? "—"), el("span", { class: "cell-sub" }, d.route ? routeBadge(d.route) : badge("no route", "grey")),
        noRoute && noRoute !== blocked ? el("span", { class: "cell-sub cell-why" }, noRoute) : null),
      el("td", {}, badge(state.label, state.tone), state.reason ? el("span", { class: "cell-sub cell-why" }, state.reason) : null),
      el("td", {}, pinned.length ? el("span", { class: "chips" }, pinned.map((p) => el("span", { class: "chip mono", title: `${ROUTE_LABEL[p.route] ?? p.route} route` }, p.alias)))
        : el("span", { class: "muted" }, "—")),
      el("td", { class: "pin-cell" }, form));
  }

  search.addEventListener("input", () => { if (selected && models && !models.error) drawDeployments(selected); });
  filter.addEventListener("input", () => { if (discovery?.accounts) drawAccounts(); });
  refresh.addEventListener("click", busy(refresh, async () => {
    invalidate(...FOUNDRY_CACHES);
    await load(true);
  }));
  load();
}
