/** Boundary validation for every console request body. Throws InputError (HTTP 400). */

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const SUBJECT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const MAX_BUDGET = 100_000_000;
const MAX_HOURS = 24 * 90;

const fail = (m) => { throw new InputError(m); };

export function validateOwner(owner) {
  const o = String(owner ?? "").trim().toLowerCase();
  return EMAIL_RE.test(o) ? o : fail("Owner must be the user's sign-in name (an email address).");
}

export function validateJwtRequest(body, { allowedModels }) {
  const owner = validateOwner(body?.owner);
  const subject = String(body?.subject ?? "").trim();
  if (!SUBJECT_RE.test(subject)) fail("Subject: 1–64 letters, digits, dot, dash or underscore.");
  const models = [...new Set((Array.isArray(body?.models) ? body.models : []).map((m) => String(m).trim().toLowerCase()))];
  if (models.length === 0) fail("Grant at least one model.");
  for (const m of models) if (!allowedModels.includes(m)) fail(`Unknown model alias: ${m}`);
  const budget = Number(body?.budget);
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) fail(`Budget: a whole number of tokens, 1–${MAX_BUDGET}.`);
  const hours = Number(body?.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) fail(`Window: up to ${MAX_HOURS} hours.`);
  const label = body?.label == null || body.label === "" ? undefined : String(body.label).slice(0, 80);
  return { owner, subject, models, budget, hours, label };
}

export function validateProductKeyRequest(body, { products }) {
  const owner = validateOwner(body?.owner);
  const name = String(body?.name ?? "").trim();
  if (!NAME_RE.test(name)) fail("Name: 2–40 lowercase letters, digits or dashes.");
  const product = String(body?.product ?? "");
  if (!products.includes(product)) fail(`Unknown product: ${product}`);
  let rotateDays = null;
  if (body?.rotateDays != null && body.rotateDays !== "") {
    rotateDays = Number(body.rotateDays);
    if (!Number.isInteger(rotateDays) || rotateDays < 1 || rotateDays > 90) fail("Rotate every 1–90 days.");
  }
  return { owner, name, product, rotateDays, subscriptionId: `poc-${name}`, secretName: `poc-key-${name}` };
}
