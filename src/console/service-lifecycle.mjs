/** Console service: lists by kind and status, archive, delete, owner tags and the sweep (P51). */

import { statusOf, inArchive, archivedAtOf, deleteAfterOf, isArchiveDue, isDeleteDue, pruneRevocations } from "./lifecycle.mjs";
import { isDue } from "./rotation.mjs";
import { validateOwner } from "./validate.mjs";

const PACK_RE = /^pk-[0-9a-f]{12}$/;
const KINDS = ["jwt", "product"];
const STATUSES = ["active", "archived"];

export function lifecycleApi(ctx) {
  const { vault, arm, clock, audit, requireAdmin, owns, kindOf, visibleKey, rotate, ServiceError, revokedName, guard, revocations } = ctx;
  const unexpired = (s) => !(Date.parse(s.tags?.expires ?? "") <= clock());
  const nowIso = () => new Date(clock()).toISOString();

  function shape(s, now) {
    const kind = kindOf(s);
    const t = s.tags ?? {};
    const archived = inArchive(kind, t, now);
    return {
      name: s.name, kind, ...t,
      models: String(t.models ?? "").split(",").filter(Boolean),
      status: statusOf(kind, t, now),
      archived,
      ...(archived ? { archivedAt: archivedAtOf(t), deleteAfter: deleteAfterOf(t) } : {}),
      ...(t.rotateDays ? { rotateDays: Number(t.rotateDays) } : {}),
    };
  }

  async function listKeys(actor, { kind, status = "active" } = {}) {
    if (kind !== undefined && kind !== "" && !KINDS.includes(kind)) throw new ServiceError(400, "kind must be jwt or product.");
    if (!STATUSES.includes(status)) throw new ServiceError(400, "status must be active or archived.");
    const now = clock();
    return (await vault.listSecrets())
      .filter((s) => kindOf(s) && owns(actor, s) && (!kind || kindOf(s) === kind))
      .map((s) => shape(s, now))
      .filter((k) => k.archived === (status === "archived"))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function markArchived(s, actorName, reason) {
    const kind = kindOf(s);
    if (kind === "product" && s.tags.subscription) {
      await arm.setSubscriptionState(s.tags.subscription, "suspended");
    }
    // An archived key must not work: a signed key that has not expired goes on the gateway's
    // revocation list, because its token is self-contained (security review, 2026-10-22).
    let revokedTags = {};
    if (kind === "jwt" && s.tags.jti && s.tags.revoked !== "true" && unexpired(s)) {
      await revocations.add(s.tags.jti);
      revokedTags = { revoked: "true", revokedAt: nowIso() };
    }
    const tags = { ...s.tags, ...revokedTags, archived: "true", archivedAt: nowIso(), archiveReason: reason, ...(kind === "product" ? { state: "suspended" } : {}) };
    await vault.updateTags(s.name, tags);
    audit(actorName, "archive-key", { name: s.name, reason });
  }

  async function archiveKey(actor, name) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    if (s.tags.archived !== "true") await markArchived(s, actor.name, "admin");
    return { name, archived: true };
  }

  async function removeKey(s, actorName) {
    // Deleting the secret loses the jti; an unexpired token must already be refused by the gateway.
    if (kindOf(s) === "jwt" && unexpired(s) && !(s.tags.jti && await revocations.has(s.tags.jti))) {
      throw new ServiceError(409, "Revoke this signed key before deleting it: it has not expired and the gateway would still accept it.");
    }
    if (kindOf(s) === "product" && s.tags.subscription) {
      await arm.deleteSubscription(s.tags.subscription);
      const pack = s.tags.product;
      if (PACK_RE.test(pack ?? "") && !(await arm.hasProductSubscriptions(pack))) await arm.deleteProduct(pack);
    }
    // A revoked jti stays on the revocation list until it expires; the sweep prunes it then.
    await vault.deleteSecret(s.name);
    audit(actorName, "delete-key", { name: s.name, kind: kindOf(s) });
  }

  async function deleteKey(actor, name) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    if (!inArchive(kindOf(s), s.tags, clock())) throw new ServiceError(409, "Archive the key before deleting it.");
    await removeKey(s, actor.name);
    return { name, deleted: true };
  }

  async function setOwner(actor, name, body) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    const owner = await guard(async () => validateOwner(body?.owner));
    const label = body?.label == null ? s.tags.label : String(body.label).trim().slice(0, 80);
    const tags = { ...s.tags, owner, ...(label ? { label } : {}) };
    if (!label) delete tags.label;
    await vault.updateTags(name, tags);
    audit(actor, "set-owner", { name, owner, label: label ?? null });
    return { name, owner, label: label ?? null };
  }

  /** The automation: rotation, archive, deletion, revocation pruning. One failure never stops the rest. */
  async function runSweep() {
    const out = { rotated: [], archived: [], deleted: [], failed: [] };
    const attempt = async (list, name, fn) => {
      try {
        await fn();
        list.push(name);
      } catch (e) {
        out.failed.push(name);
        audit("scheduler", "sweep-failed", { name, error: String(e?.message ?? e).slice(0, 200) });
      }
    };
    const now = clock();
    const keys = (await vault.listSecrets()).filter((s) => kindOf(s)).sort((a, b) => a.name.localeCompare(b.name));
    for (const s of keys) {
      const kind = kindOf(s);
      if (isDeleteDue(s.tags, now)) {
        await attempt(out.deleted, s.name, () => removeKey(s, "scheduler"));
      } else if (isArchiveDue(kind, s.tags, now)) {
        const reason = statusOf(kind, s.tags, now);
        await attempt(out.archived, s.name, async () => markArchived(await vault.getSecret(s.name), "scheduler", reason));
      } else if (kind === "product" && s.tags.archived !== "true" && isDue(s.tags, now)) {
        await attempt(out.rotated, s.name, () => rotate(s.name, "scheduler"));
      }
    }
    const expiry = new Map(keys.filter((s) => kindOf(s) === "jwt" && s.tags.jti).map((s) => [s.tags.jti, Date.parse(s.tags.expires ?? "")]));
    const current = (await arm.getNamedValue(revokedName))?.value ?? ",";
    const pruned = pruneRevocations(current, expiry, now);
    if (pruned !== current) {
      await arm.setNamedValue(revokedName, pruned, { secret: false });
      audit("scheduler", "prune-revocations", { before: current.split(",").filter(Boolean).length, after: pruned.split(",").filter(Boolean).length });
    }
    return out;
  }

  return { listKeys, archiveKey, deleteKey, setOwner, runSweep };
}
