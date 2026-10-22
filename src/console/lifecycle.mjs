/**
 * Key lifecycle rules (P51, ADR-0015). Pure functions over a key's Key Vault tags.
 *
 * A key is archived once it can no longer be used: a hackathon key that expired or was revoked,
 * a product key past its optional expiry, or any key an admin archives. An expired key counts as
 * archived from its expiry even before the automation writes the tag, so lists never show a dead
 * key as active. Archived keys are deleted 30 days after archiving.
 */

const DAY_MS = 86_400_000;
export const DELETE_AFTER_DAYS = 30;

const time = (s) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? t : null;
};
const expiredAt = (tags, now) => {
  const e = time(tags?.expires);
  return e !== null && e <= now ? e : null;
};

export function statusOf(kind, tags, now) {
  if (tags?.archived === "true") return "archived";
  if (kind === "jwt" && tags?.revoked === "true") return "revoked";
  if (expiredAt(tags, now) !== null) return "expired";
  if (kind === "product" && tags?.state === "suspended") return "suspended";
  return "active";
}

/** Whether the key belongs in the archive view (whether or not the tag has been written yet). */
export const inArchive = (kind, tags, now) => ["archived", "revoked", "expired"].includes(statusOf(kind, tags, now));

/** The automation archives a key that is in the archive view but not yet tagged. */
export const isArchiveDue = (kind, tags, now) => tags?.archived !== "true" && inArchive(kind, tags, now);

/** When the key was archived: the tag, else its expiry, else null (revoked before tagging). */
export function archivedAtOf(tags) {
  if (tags?.archivedAt && time(tags.archivedAt) !== null) return new Date(time(tags.archivedAt)).toISOString();
  if (tags?.revokedAt && time(tags.revokedAt) !== null) return new Date(time(tags.revokedAt)).toISOString();
  const e = time(tags?.expires);
  return e === null ? null : new Date(e).toISOString();
}

export function deleteAfterOf(tags) {
  const at = time(archivedAtOf(tags));
  return at === null ? null : new Date(at + DELETE_AFTER_DAYS * DAY_MS).toISOString();
}

/** Only keys whose archive is recorded are deleted automatically. */
export function isDeleteDue(tags, now) {
  if (tags?.archived !== "true") return false;
  const at = time(tags?.archivedAt);
  return at !== null && now >= at + DELETE_AFTER_DAYS * DAY_MS;
}

/**
 * Drop revocation entries for keys known to have expired: the gateway refuses an expired token
 * anyway, and the named value holds at most 4096 characters. Unknown jtis are kept.
 * @param {Map<string, number>} expiryByJti
 */
export function pruneRevocations(list, expiryByJti, now) {
  const items = String(list ?? "").split(",").filter(Boolean);
  const kept = items.filter((j) => {
    const e = expiryByJti.get(j);
    return !(typeof e === "number" && e <= now);
  });
  return kept.length ? `,${kept.join(",")},` : ",";
}
