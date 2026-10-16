/**
 * Opt-in rotation automation for product keys. A key is enrolled when its vault secret carries a
 * `rotateDays` tag of 1–90; it is due when `rotatedAt` is older than that, unreadable, or absent.
 * ADR-0013 decision 5.
 */

const DAY_MS = 86_400_000;

export function parseRotateDays(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 90 ? n : null;
}

export function isDue(tags, now = Date.now()) {
  const days = parseRotateDays(tags?.rotateDays);
  if (days === null) return false;
  const last = Date.parse(tags?.rotatedAt ?? "");
  if (!Number.isFinite(last)) return true;
  return now - last >= days * DAY_MS;
}

/** Rotation regenerates the slot NOT in use, so callers still holding the current key keep working. */
export function otherSlot(slot) {
  if (slot === "primary") return "secondary";
  if (slot === "secondary") return "primary";
  throw new Error(`Unknown key slot: ${slot}`);
}
