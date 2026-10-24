// Key Dashboard — the setup guide (ADR-0017): from a Foundry account to keys in people's hands, then
// the gateway URL keys name, the usage period and the chargeback report (P59).
//
// A docked, non-modal panel. Help opens it; Escape closes it and focus returns to what opened it.
// "Show me" highlights the part of the page a step is about: a CSS class with a step label, keyboard
// focus and an aria description, all removed when the page changes, the step changes or the guide
// closes. It navigates only by fixed routes through ctx.go, so leaving a page still wipes secrets
// (app.js). Nothing polls and nothing is stored.

import { el, icon, setChildren, uid } from "./dom.js";

export const STEPS = Object.freeze([
  {
    id: "discover", title: "Find Foundry accounts", where: "Foundry & models", routes: ["models"], go: "models", target: "foundry-accounts",
    text: [
      "Foundry & models lists the Foundries connected to this API Management: the gateway's default account and each attached one. Only these get pinned aliases and keys.",
      "Connect another Foundry lists the other Foundry (AI Services) and Azure OpenAI accounts in the dashboard's Azure subscription. Listing reads metadata only: account and deployment read access. That access does not mean the gateway may call a model.",
      "Deployed something new? Select Refresh from Azure; nothing refreshes by itself. An account the dashboard cannot read shows its error, never an empty list.",
    ],
  },
  {
    id: "attach", title: "Attach a Foundry", where: "Foundry & models", routes: ["models"], go: "models", target: "foundry-attach",
    text: [
      "Connect another Foundry opens the accounts this API Management does not route to yet, with search. Choose one and select Attach: it gets its own gateway routes, alias maps and key audience in API Management. The default account keeps its original routes.",
      "Attaching configures routing only. It does not grant permissions or open private networks, so it is no proof that requests will work. The account then joins the connected list, selected for the next steps.",
    ],
  },
  {
    id: "access", title: "Grant access and check the network", where: "Foundry & models", routes: ["models"], go: "models", target: "foundry-access",
    text: [
      "The gateway's managed identity needs an inference role on each attached account. The dashboard cannot grant roles: copy the setup command and have someone who can assign roles run it in PowerShell.",
      "With a private endpoint, the account must be reachable from API Management's virtual network, with its private DNS zone linked to that network. Where offered, the optional network setup command creates the account's private endpoint and DNS record there without changing its public access or firewall; a private endpoint is billed.",
      "After pinning an alias, Test connection sends one small request through the gateway. It uses a few tokens; a failure shows the status and what to check, and a DNS or timeout failure opens the network setup command.",
    ],
  },
  {
    id: "pin", title: "Pin models to aliases", where: "Foundry & models", routes: ["models"], go: "models", target: "foundry-deployments",
    text: [
      "Short-lived keys grant aliases: gateway names pinned to a deployment, per Foundry and route. Product keys grant the deployment name itself.",
      "Two accounts may deploy the same name; each Foundry has its own pins, so they never mix. Deployments the gateway cannot serve, such as embeddings, images or audio, stay listed with the reason.",
    ],
  },
  {
    id: "gateway", title: "Choose the gateway URL keys name", where: "Settings", routes: ["settings"], go: "settings", target: "gateway-url",
    text: [
      "Keys and their setup name API Management's own URL unless a custom domain replaces it. Gateway URL on Settings takes https:// and a host name that is a gateway custom domain of this API Management; add the custom domain in the Azure portal first.",
      "New single and bulk keys, Reveal, keys.csv, export bundles and the Foundry base URLs then use it. Keys already handed out keep working, because API Management also answers on its own URL. Reset to API Management URL goes back.",
    ],
  },
  {
    id: "issue", title: "Choose the Foundry when issuing", where: "Short-lived keys, Issue one", go: "issue", target: "issue-foundry",
    routes: ["short-lived/issue", "short-lived/bulk", "product/issue", "product/bulk"],
    text: [
      "Single and bulk issue start with the Foundry. Only Foundries connected to this API Management are offered, and a key can call only that Foundry's models.",
      "Changing the Foundry clears the model choice, so a key never mixes accounts. The base URL shown is the one its keys use.",
    ],
  },
  {
    id: "distribute", title: "Hand out keys safely", where: "Short-lived keys, Issue in bulk", routes: ["short-lived/bulk", "product/bulk"], go: "bulk", target: "bulk-rows",
    text: [
      "A single key is copied from its panel, which masks it and clears it after 60 seconds.",
      "Bulk issue gives keys.csv with every key (send each person only their own row, then delete the file), index.csv with no keys, or an encrypted bundle.",
      "The dashboard keeps no key values in the browser. Issued to is an email for attribution and usage; it gives no dashboard access.",
    ],
  },
  {
    id: "period", title: "Choose the usage period", where: "Overview", routes: ["overview", "short-lived", "product"], go: "overview", target: "usage-period",
    text: [
      "Usage covers the last 24 hours, 7, 30 or 90 days, or a custom range: choose Custom, then the first and last day, and Apply. Days are whole UTC days, both included.",
      "Usage is kept for 90 days at no charge, so a range starts at most 89 days before today. Two days or fewer are charted by the hour, longer ranges by the day.",
    ],
  },
  {
    id: "chargeback", title: "Export a chargeback report", where: "Overview", routes: ["overview"], go: "overview", target: "chargeback",
    text: [
      "Chargeback report downloads a CSV for the period chosen at the top of the Overview, for both key kinds or one: a row per key and model with tokens, requests, first and last use, who the key is issued to, its label and tags, status and Foundry.",
      "Usage of a key no longer in Key Vault is listed as unknown, with its key id. The file has no prices: Foundry pricing varies by model, and Claude is billed in CCU.",
    ],
  },
]);

export const NOTES = Object.freeze([
  "Aliases or deployment names: short-lived keys grant the aliases pinned on Foundry & models; product keys grant deployment names directly.",
  "A model deployed a minute ago appears after Refresh from Azure on Foundry & models. Pin it before issuing keys for it.",
  "Discovery reads metadata only. The gateway's inference permission is separate, and the dashboard cannot grant it.",
  "Private endpoints: API Management must reach each account over its virtual network, with private DNS linked to that network.",
  "Gateway URL: only a gateway custom domain of this API Management can replace its URL in keys, and the dashboard never sends a request to it.",
]);

/** Fixed routes only: the router wipes secrets on every one of them. */
const GO = {
  models: (ctx) => ctx.go("#/models"),
  issue: (ctx) => ctx.go("#/short-lived/issue"),
  bulk: (ctx) => ctx.go("#/short-lived/bulk"),
  overview: (ctx) => ctx.go("#/overview"),
  settings: (ctx) => ctx.go("#/settings"),
};
const WAIT_MS = 6000;
const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/**
 * Highlights `section`: outline class, step label, an aria description on what gets focus (its
 * control, else the section itself), scrolled into view. Returns a function restoring every
 * attribute exactly as it was.
 */
function markTarget(section, { label, describedBy, control, moveFocus, reduced }) {
  const target = control ?? section;
  const before = { tabindex: section.getAttribute("tabindex"), describedBy: target.getAttribute("aria-describedby") };
  const addTabindex = !control && before.tabindex === null;
  section.classList.add("help-target");
  section.setAttribute("data-help-label", label);
  if (addTabindex) section.setAttribute("tabindex", "-1");
  target.setAttribute("aria-describedby", [before.describedBy, describedBy].filter(Boolean).join(" "));
  section.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
  if (moveFocus) target.focus?.({ preventScroll: true });
  return () => {
    section.classList.remove("help-target");
    section.removeAttribute("data-help-label");
    if (addTabindex) section.removeAttribute("tabindex");
    if (before.describedBy === null) target.removeAttribute("aria-describedby");
    else target.setAttribute("aria-describedby", before.describedBy);
  };
}

/** The Help button and its panel. app.js mounts both and calls routed() after every route. */
export function createGuide(ctx) {
  const titleId = uid("help-title");
  let isOpen = false;
  let current = 0;
  let route = "";
  let view = null;
  let opener = null;
  let pending = null;
  let clearMark = null;
  let stopWaiting = null;

  const button = el("button", { type: "button", class: "help-toggle", "aria-expanded": "false", "aria-controls": "help-panel" },
    icon("help"), el("span", {}, "Help"));
  const closeX = el("button", { type: "button", class: "btn-icon", "aria-label": "Close the guide", "data-help-close": true }, icon("close"));
  const steps = el("ol", { class: "help-steps" });
  const back = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-help-back": true }, "Back");
  const next = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-help-next": true }, "Next");
  const position = el("p", { class: "help-position" });
  const live = el("p", { class: "sr-only", "aria-live": "polite" });
  const panel = el("aside", { id: "help-panel", class: "help-panel", "aria-labelledby": titleId, hidden: true },
    el("div", { class: "help-head" }, el("h2", { class: "help-title", id: titleId }, icon("help"), "Setup guide"), closeX),
    el("p", { class: "help-intro" }, "From a Foundry account to keys in people's hands, then their usage and chargeback. Show me highlights each step on the page; Escape closes the guide."),
    steps,
    el("div", { class: "help-foot" }, back, position, next),
    el("details", { class: "disclosure help-notes" }, el("summary", {}, "Good to know"),
      el("ul", { class: "help-note-list" }, NOTES.map((n) => el("li", {}, n)))),
    live);

  const say = (message) => { live.textContent = message; };

  function unmark() {
    clearMark?.();
    clearMark = null;
  }
  function stopWait() {
    stopWaiting?.();
    stopWaiting = null;
  }

  function mark(step, section, moveFocus) {
    unmark();
    const control = section.querySelector("[data-help-focus]");
    const usable = control && !control.disabled && control.getAttribute("aria-disabled") !== "true" ? control : null;
    clearMark = markTarget(section, {
      label: `Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}: ${step.title}`, describedBy: `help-desc-${step.id}`,
      control: usable, moveFocus, reduced: reducedMotion(),
    });
    say(`Highlighted on the page: ${step.title}.`);
  }

  /** Highlights the step's section in `root` now, or when the view renders it (bounded; no polling). */
  function markWhenReady(step, root, moveFocus) {
    stopWait();
    const find = () => root.querySelector(`[data-help="${step.target}"]`);
    const found = find();
    if (found) return mark(step, found, moveFocus);
    if (typeof MutationObserver !== "function") return say(`${step.title}: not on this page yet.`);
    const observer = new MutationObserver(() => {
      const section = find();
      if (!section) return;
      stopWait();
      mark(step, section, moveFocus);
    });
    observer.observe(root, { childList: true, subtree: true });
    const timer = setTimeout(stopWait, WAIT_MS);
    stopWaiting = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }

  function show(step) {
    unmark();
    if (view && step.routes.includes(route)) return markWhenReady(step, view, true);
    pending = step.id;
    GO[step.go](ctx);
  }

  function render(focusHead = false) {
    setChildren(steps, STEPS.map((s, i) => {
      const here = i === current;
      const bodyId = `help-step-${s.id}`;
      const head = el("button", { type: "button", class: "help-step-head", "aria-expanded": String(here), "aria-controls": here ? bodyId : undefined, "data-step": s.id },
        el("span", { class: "help-step-num", "aria-hidden": "true" }, String(i + 1)), el("span", {}, s.title));
      head.addEventListener("click", () => select(i, true));
      if (!here) return el("li", { class: "help-step" }, el("h3", { class: "help-step-title" }, head));
      const onPage = s.routes.includes(route);
      const showMe = el("button", { type: "button", class: "btn btn-primary btn-sm", "data-help-show": true, "aria-describedby": `${bodyId}-where` }, "Show me");
      showMe.addEventListener("click", () => show(s));
      return el("li", { class: "help-step is-current", "aria-current": "step" },
        el("h3", { class: "help-step-title" }, head),
        el("div", { class: "help-step-body", id: bodyId },
          el("div", { class: "help-step-text", id: `help-desc-${s.id}` }, s.text.map((t) => el("p", {}, t))),
          el("div", { class: "help-step-actions" }, showMe,
            el("span", { class: "help-where", id: `${bodyId}-where` }, onPage ? "Highlights it on this page." : `Opens ${s.where}.`))));
    }));
    position.textContent = `Step ${current + 1} of ${STEPS.length}`;
    back.setAttribute("aria-disabled", String(current === 0));
    next.setAttribute("aria-disabled", String(current === STEPS.length - 1));
    if (focusHead) steps.querySelector(`[data-step="${STEPS[current].id}"]`)?.focus();
  }

  function select(i, focusHead = false) {
    const to = Math.max(0, Math.min(STEPS.length - 1, i));
    if (to !== current) {
      unmark();
      stopWait();
      pending = null;
      current = to;
    }
    render(focusHead);
  }

  /** Escape closes the guide and its highlight wherever focus is, unless a modal dialog is open: its Escape is its own. */
  function onKey(event) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    close();
  }

  /** Opens the guide, at `stepId` if given. With `highlight`, marks that step's section on this page without moving focus. */
  function open(stepId, from, { highlight = false } = {}) {
    const i = STEPS.findIndex((s) => s.id === stepId);
    if (i !== -1 && i !== current) {
      unmark();
      stopWait();
      pending = null;
      current = i;
    }
    opener = from ?? button;
    if (!isOpen) {
      isOpen = true;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      document.body.classList.add("help-open");
      document.addEventListener("keydown", onKey);
    }
    render(true);
    if (highlight && view && STEPS[current].routes.includes(route)) markWhenReady(STEPS[current], view, false);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    unmark();
    stopWait();
    pending = null;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.body.classList.remove("help-open");
    document.removeEventListener("keydown", onKey);
    const to = opener?.isConnected ? opener : button;
    opener = null;
    to.focus();
  }

  /** After every route: the old page's highlight is gone; a pending one lands only on its own page. */
  function routed(nextView, nextRoute) {
    unmark();
    stopWait();
    view = nextView;
    route = String(nextRoute ?? "");
    const step = STEPS.find((s) => s.id === pending);
    pending = null;
    if (step && step.routes.includes(route)) markWhenReady(step, nextView, true);
    if (isOpen) render();
  }

  button.addEventListener("click", () => (isOpen ? close() : open(null, button)));
  closeX.addEventListener("click", close);
  back.addEventListener("click", () => { if (current > 0) select(current - 1); });
  next.addEventListener("click", () => { if (current < STEPS.length - 1) select(current + 1); });

  return { button, panel, open, close, routed, get isOpen() { return isOpen; } };
}
