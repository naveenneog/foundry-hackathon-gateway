// Key Dashboard — the per-key drawer: details, the key's own usage, who it is issued to, rotation
// and lifecycle actions. Destructive actions confirm first; every change refreshes the list, and
// the drawer redraws from the refreshed key (or closes when the key left the list).

import { apiPath, cachedGet, keyPath, post } from "./api.js";
import { usageBody } from "./charts.js";
import {
  badge, busy, confirmDialog, el, errorState, field, icon, kindBadge, loadingState, openModal, periodSwitch, routeBadge, setChildren, showErrors, statusBadge, toast, uid,
} from "./dom.js";
import {
  checkOwner, checkWhole, deleteDate, fmtDate, fmtDateTime, fmtInt, fmtRelative, isArchived, keyStatus, keyTitle, LIMITS, normalizeOwner, routeOf,
} from "./lib.js";
import { accountForKey, accountsOf, keyFoundry } from "./foundry.js";
import { revealKey } from "./secret.js";

/**
 * The key's Foundry account and that Foundry's config (for route badges). A key without Foundry
 * metadata belongs to the default; either value is null when it cannot be read.
 */
async function keyContext(ctx, k) {
  const accounts = await ctx.foundries().then(accountsOf, () => null);
  const account = accounts ? accountForKey(accounts, k) : null;
  const config = account ? ctx.config(account.id) : keyFoundry(k).isDefault ? ctx.config() : null;
  return { account, config: await Promise.resolve(config).catch(() => null) };
}

/**
 * Opens the drawer for `key`. `onChanged()` refreshes the list after an admin action and resolves
 * to the refreshed keys, from which the drawer redraws itself.
 */
export async function openKeyDrawer(ctx, key, { opener, onChanged }) {
  const { account, config } = await keyContext(ctx, key);
  const titleId = uid("drawer-title");
  const panel = el("div", { class: "drawer-panel" });
  const dialog = el("dialog", { class: "drawer", "aria-labelledby": titleId }, panel);
  let days = ctx.period;
  let k = { ...key, status: keyStatus(key) };

  const after = async (message) => {
    toast(message);
    const list = (await onChanged()) ?? [];
    const next = list.find((x) => x.name === k.name);
    if (!next || isArchived(next) !== isArchived(k)) {
      dialog.close();
      return;
    }
    k = { ...next, status: keyStatus(next) };
    render();
  };

  function render() {
    // A redraw replaces every control; keep keyboard focus on the same one (or the close button).
    const active = document.activeElement;
    const refocus = panel.isConnected && (panel.contains(active) || active === document.body)
      ? active?.getAttribute?.("data-focus-id") ?? "drawer-close" : null;
    const archived = isArchived(k);
    const closeX = el("button", { type: "button", class: "btn-icon", "data-focus-id": "drawer-close", "aria-label": "Close details" }, icon("close"));
    closeX.addEventListener("click", () => dialog.close());
    let reveal = null;
    if (["active", "scheduled", "suspended"].includes(k.status)) {
      reveal = el("button", { type: "button", class: "btn btn-primary", "data-focus-id": "drawer-reveal" }, icon("key"), "Reveal key");
      reveal.addEventListener("click", busy(reveal, () => revealKey({ name: k.name, label: keyTitle(k), kind: k.kind, models: k.models, opener: reveal })));
    }
    setChildren(panel,
      el("header", { class: "drawer-head" },
        el("div", { class: "drawer-heading" },
          el("div", { class: "row row-tight" }, kindBadge(k.kind), statusBadge(k.status),
            k.rotateDays && !archived ? badge(`auto ${k.rotateDays}d`, "auto", `Rotates automatically every ${k.rotateDays} days`) : null),
          el("h2", { class: "drawer-title", id: titleId }, keyTitle(k)),
          el("p", { class: "mono muted" }, k.name)),
        closeX),
      el("div", { class: "drawer-body" },
        reveal ? el("div", { class: "row" }, reveal, el("p", { class: "field-hint" }, "Shown masked; clears itself after 60 seconds.")) : null,
        detailsSection(),
        usageSection(),
        archived ? null : ownerSection(),
        !archived && k.kind === "product" ? rotationSection() : null,
        lifecycleSection(archived)));
    if (refocus) (panel.querySelector(`[data-focus-id="${CSS.escape(refocus)}"]`) ?? closeX).focus();
  }

  function detailsSection() {
    const rows = [];
    const add = (term, ...value) => rows.push(el("dt", {}, term), el("dd", {}, ...value));
    add("Issued to", k.owner || el("span", { class: "muted" }, "not recorded"));
    if (k.label) add("Label", k.label);
    if (k.subject) add("Subject", k.subject);
    const foundry = keyFoundry(k);
    add("Foundry", foundry.name,
      account ? el("span", { class: "muted" }, ` · ${[account.location, account.resourceGroup].filter(Boolean).join(" · ")}`) : null,
      foundry.isDefault ? null : el("span", { class: "cell-sub mono" }, `connection ${foundry.connectionId}`));
    add("Models", Array.isArray(k.models) && k.models.length
      ? el("ul", { class: "model-list" }, k.models.map((m) => el("li", {}, el("span", { class: "mono" }, m), routeBadge(routeOf(k.kind, config, m)))))
      : "—");
    if (k.kind === "jwt") add("Token budget", `${fmtInt(k.budget)} tokens over the key's life`);
    if (k.kind === "product" && k.monthlyTokens) add("Monthly tokens", `${fmtInt(k.monthlyTokens)} a month`);
    if (k.notBefore) add(k.status === "scheduled" ? "Starts" : "Started", fmtDateTime(k.notBefore), el("span", { class: "muted" }, ` (${fmtRelative(k.notBefore)})`));
    if (k.expires) add("Expires", fmtDateTime(k.expires), el("span", { class: "muted" }, ` (${fmtRelative(k.expires)})`));
    if (k.issuedBy) add("Issued by", k.issuedBy);
    if (k.jti) add("Key id", el("span", { class: "mono" }, k.jti));
    if (k.product) add("Product", el("span", { class: "mono" }, k.product));
    if (k.slot) add("Slot in use", k.slot);
    if (k.rotatedAt) add("Last rotated", fmtDateTime(k.rotatedAt));
    if (k.kind === "product") add("Automatic rotation", k.rotateDays ? `every ${k.rotateDays} days` : "off");
    if (k.archivedAt) add("Archived", fmtDateTime(k.archivedAt));
    const del = deleteDate(k);
    if (isArchived(k) && del) add("Deleted on", fmtDate(del), el("span", { class: "muted" }, ` (${fmtRelative(del)})`));
    return el("section", { class: "drawer-section" }, el("h3", { class: "section-title" }, "Details"), el("dl", { class: "details" }, rows));
  }

  function usageSection() {
    const slot = el("div", {});
    const load = async (fresh = false) => {
      const want = days;
      setChildren(slot, loadingState("Loading usage…", 2));
      try {
        const data = await cachedGet(apiPath(`/api/usage/${encodeURIComponent(k.name)}`, { days: want }), { fresh });
        if (want === days) setChildren(slot, usageBody(k.kind, data, want, { title: keyTitle(k), compact: true }));
      } catch (error) {
        setChildren(slot, errorState(error, () => load(true)));
      }
    };
    load();
    return el("section", { class: "drawer-section" },
      el("div", { class: "card-head" }, el("h3", { class: "section-title" }, "Usage"), periodSwitch(days, (d) => { days = d; load(); })),
      slot);
  }

  function ownerSection() {
    const owner = field({ label: "Issued to", control: el("input", { type: "email", class: "input", value: k.owner ?? "", autocomplete: "off", spellcheck: "false" }),
      hint: "For attribution and usage; this person does not get dashboard access." });
    const label = field({ label: "Label", optional: true, control: el("input", { type: "text", class: "input", value: k.label ?? "", maxlength: String(LIMITS.label) }) });
    const save = el("button", { type: "submit", class: "btn btn-secondary", "data-focus-id": "drawer-owner" }, "Save");
    const form = el("form", { class: "form-grid", novalidate: true }, owner.wrap, label.wrap, el("div", { class: "form-actions" }, save));
    form.addEventListener("submit", busy(save, async () => {
      const errors = {};
      const ownerError = checkOwner(owner.control.value);
      if (ownerError) errors.owner = ownerError;
      if (label.control.value.trim().length > LIMITS.label) errors.label = `Label: up to ${LIMITS.label} characters.`;
      if (!showErrors({ owner, label }, errors)) return;
      await post(keyPath(k.name, "owner"), { owner: normalizeOwner(owner.control.value), label: label.control.value.trim() });
      await after(`Saved who ${keyTitle(k)} is issued to.`);
    }));
    return el("section", { class: "drawer-section" }, el("h3", { class: "section-title" }, "Issued to and label"), form);
  }

  function rotationSection() {
    const rotate = el("button", { type: "button", class: "btn btn-secondary", "data-focus-id": "drawer-rotate" }, icon("refresh"), "Rotate now");
    rotate.addEventListener("click", busy(rotate, async () => {
      const ok = await confirmDialog({
        title: `Rotate ${keyTitle(k)} now?`, tone: "warn", confirmLabel: "Rotate key",
        message: "API Management regenerates the slot that clients are not using, and Key Vault stores the new key.",
        points: ["The current key keeps working until the next rotation, so clients can switch without downtime.", "The key from before the previous rotation stops working."],
      });
      if (!ok) return;
      const r = await post(keyPath(k.name, "rotate"), {});
      await after(`Rotated ${keyTitle(k)}: clients should now use the ${r.slot ?? "new"} key.`);
    }));
    const daysField = field({ label: "Rotate automatically every (days)", control: el("input", { type: "number", class: "input input-narrow", min: "1", max: "90", step: "1", inputmode: "numeric", value: k.rotateDays ?? "" }),
      hint: "1 to 90 days. The automation rotates the key when it is due." });
    const save = el("button", { type: "submit", class: "btn btn-secondary", "data-focus-id": "drawer-automation" }, "Save");
    const off = k.rotateDays ? el("button", { type: "button", class: "btn btn-ghost" }, "Turn off") : null;
    const form = el("form", { class: "form-inline", novalidate: true }, daysField.wrap, el("div", { class: "form-actions" }, save, off));
    form.addEventListener("submit", busy(save, async () => {
      const error = checkWhole(daysField.control.value, LIMITS.rotateDays, "rotation days");
      if (!showErrors({ days: daysField }, error ? { days: error } : {})) return;
      await post(keyPath(k.name, "automation"), { rotateDays: Number(daysField.control.value) });
      await after(`${keyTitle(k)} now rotates every ${Number(daysField.control.value)} days.`);
    }));
    off?.addEventListener("click", busy(off, async () => {
      await post(keyPath(k.name, "automation"), { rotateDays: "" });
      await after(`Automatic rotation is off for ${keyTitle(k)}.`);
    }));
    return el("section", { class: "drawer-section" }, el("h3", { class: "section-title" }, "Rotation"),
      el("p", { class: "field-hint" }, k.rotatedAt ? `Last rotated ${fmtRelative(k.rotatedAt)}; clients use the ${k.slot ?? "current"} slot.` : "Not rotated yet."),
      el("div", { class: "row" }, rotate), form);
  }

  function action(label, tone, run, id = label) {
    const button = el("button", { type: "button", class: `btn btn-${tone}`, "data-focus-id": `drawer-${id}` }, label);
    button.addEventListener("click", busy(button, run));
    return button;
  }

  function lifecycleSection(archived) {
    const t = keyTitle(k);
    const buttons = [];
    if (archived) {
      buttons.push(action("Delete key", "danger", async () => {
        const ok = await confirmDialog({
          title: `Delete ${t}?`, confirmLabel: "Delete key",
          message: "The key's secret is deleted from Key Vault (soft delete, recoverable by an Azure admin within the vault's retention period).",
          points: k.kind === "product" ? ["Its API Management subscription is deleted first."] : [],
        });
        if (!ok) return;
        await post(keyPath(k.name, "delete"), {});
        await after(`Deleted ${t}.`);
      }));
    } else {
      if (k.kind === "jwt" && ["active", "scheduled"].includes(k.status)) {
        buttons.push(action("Revoke key", "danger", async () => {
          const ok = await confirmDialog({
            title: `Revoke ${t}?`, confirmLabel: "Revoke key",
            message: "The gateway refuses this key on every route within seconds. This cannot be undone.",
            points: ["The key moves to the archive and is deleted 30 days later."],
          });
          if (!ok) return;
          await post(keyPath(k.name, "revoke"), {});
          await after(`Revoked ${t}.`);
        }));
      }
      if (k.kind === "product") {
        const suspended = k.status === "suspended";
        buttons.push(action(suspended ? "Resume key" : "Suspend key", suspended ? "secondary" : "warn", async () => {
          if (!suspended && !(await confirmDialog({
            title: `Suspend ${t}?`, tone: "warn", confirmLabel: "Suspend key",
            message: "Every request with this key is refused until you resume it. The change reaches the gateway within about 20 seconds.",
          }))) return;
          await post(keyPath(k.name, "state"), { state: suspended ? "active" : "suspended" });
          await after(`${t} is ${suspended ? "active again" : "suspended"}.`);
        }, "state"));
      }
      buttons.push(action("Archive key", "danger-ghost", async () => {
        const ok = await confirmDialog({
          title: `Archive ${t}?`, confirmLabel: "Archive key",
          message: "The key leaves the active list and is deleted automatically 30 days later.",
          points: [k.kind === "jwt" ? "Archiving also revokes it: the gateway refuses it within seconds." : "Archiving suspends its subscription: the gateway refuses it within about 20 seconds."],
        });
        if (!ok) return;
        await post(keyPath(k.name, "archive"), {});
        await after(`Archived ${t}.`);
      }));
    }
    return el("section", { class: "drawer-section drawer-danger" },
      el("h3", { class: "section-title" }, archived ? "Delete" : "Lifecycle"),
      el("div", { class: "row" }, buttons));
  }

  render();
  openModal(dialog, { opener, closeOnBackdrop: true, initialFocus: panel.querySelector(".btn-icon") });
}
