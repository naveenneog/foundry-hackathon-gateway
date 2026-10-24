/**
 * Who is calling the console, and what may they do.
 *
 * App Service authentication (Easy Auth) signs the operator in and forwards the identity as the
 * `X-MS-CLIENT-PRINCIPAL` header — base64 JSON with `claims`, `name_typ`, `role_typ`. The header
 * is only trustworthy when Easy Auth is in front of the app (it strips any client-supplied copy);
 * when `WEBSITE_AUTH_ENABLED` is not "True" the header is ignored, so a local or misconfigured
 * instance fails closed rather than trusting a forged header. ADR-0013.
 */

export const ADMIN_ROLE = "Console.Admin";
export const USER_ROLE = "Console.User";

const OID_TYPES = ["http://schemas.microsoft.com/identity/claims/objectidentifier", "oid"];
const NAME_TYPES = ["preferred_username", "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn", "email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"];

const ADMIN_ACTIONS = new Set(["issue", "revoke", "rotate", "export", "sync-secret", "automation",
  "suspend", "list-all", "models", "archive", "delete", "owner", "report"]);

export function parsePrincipal(headers, env = process.env) {
  if (String(env.WEBSITE_AUTH_ENABLED ?? "").toLowerCase() !== "true") return null;
  const raw = headers?.["x-ms-client-principal"];
  if (typeof raw !== "string" || raw === "") return null;
  let doc;
  try {
    doc = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.claims)) return null;

  const roleTypes = new Set(["roles", doc.role_typ].filter(Boolean));
  const values = (types) => doc.claims.filter((c) => types.includes(c?.typ)).map((c) => String(c.val));
  const roles = [...new Set(doc.claims.filter((c) => roleTypes.has(c?.typ)).map((c) => String(c.val)))];
  const name = (values(NAME_TYPES)[0] ?? values([doc.name_typ])[0] ?? "").trim().toLowerCase();
  const oid = values(OID_TYPES)[0] ?? "";
  if (!name) return null;
  return { name, oid, roles };
}

export function roleOf(principal) {
  if (!principal) return null;
  if (principal.roles?.includes(ADMIN_ROLE)) return "admin";
  if (principal.roles?.includes(USER_ROLE)) return "user";
  return null;
}

/** @returns {{ok: true} | {ok: false, status: 401|403}} */
export function can(principal, action) {
  if (!principal) return { ok: false, status: 401 };
  const role = roleOf(principal);
  if (!role) return { ok: false, status: 403 };
  // Admin-only dashboard (ADR-0016): Console.User no longer opens it; keys reach their holders
  // by copy, keys.csv or an export bundle, as with admin.ps1.
  if (role !== "admin") return { ok: false, status: 403 };
  if (action === "read-own" || ADMIN_ACTIONS.has(action)) return { ok: true };
  return { ok: false, status: 403 };
}

export function ownsKey(principal, tags) {
  const owner = String(tags?.owner ?? "").trim().toLowerCase();
  return Boolean(principal?.name) && owner !== "" && owner === principal.name;
}
