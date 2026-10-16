import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, createHash } from "node:crypto";

import { parsePrincipal, roleOf, can, ownsKey } from "../src/console/auth.mjs";
import { createBundle, openBundle, generatePassphrase, BundleError } from "../src/console/bundle.mjs";
import { isDue, otherSlot, parseRotateDays } from "../src/console/rotation.mjs";
import { addRevoked, removeRevoked, isRevoked } from "../src/console/revocation.mjs";
import { jwtHandout, productHandout } from "../src/console/handout.mjs";
import { validateJwtRequest, validateProductKeyRequest, InputError } from "../src/console/validate.mjs";

const ROLE_TYP = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const principalHeader = (claims, extra = {}) => Buffer.from(JSON.stringify({
  auth_typ: "aad", name_typ: "name", role_typ: ROLE_TYP, claims, ...extra,
})).toString("base64");
const claim = (typ, val) => ({ typ, val });
const AUTH_ON = { WEBSITE_AUTH_ENABLED: "True" };

test("auth: no Easy Auth means no principal, even if the header is forged", () => {
  const h = { "x-ms-client-principal": principalHeader([claim(ROLE_TYP, "Console.Admin")]) };
  assert.equal(parsePrincipal(h, {}), null);
  assert.equal(parsePrincipal(h, { WEBSITE_AUTH_ENABLED: "False" }), null);
});

test("auth: missing or malformed header yields no principal", () => {
  assert.equal(parsePrincipal({}, AUTH_ON), null);
  assert.equal(parsePrincipal({ "x-ms-client-principal": "%%%not-base64" }, AUTH_ON), null);
  assert.equal(parsePrincipal({ "x-ms-client-principal": Buffer.from("[]").toString("base64") }, AUTH_ON), null);
});

test("auth: roles are read from role_typ and from a plain roles claim; owner is lowercased", () => {
  const p = parsePrincipal({ "x-ms-client-principal": principalHeader([
    claim("preferred_username", "Ada@Contoso.com"),
    claim("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid-1"),
    claim(ROLE_TYP, "Console.User"),
    claim("roles", "Console.Admin"),
  ]) }, AUTH_ON);
  assert.equal(p.name, "ada@contoso.com");
  assert.equal(p.oid, "oid-1");
  assert.deepEqual(p.roles.sort(), ["Console.Admin", "Console.User"]);
  assert.equal(roleOf(p), "admin");
});

test("auth: role matrix fails closed", () => {
  const user = { name: "u@x.com", oid: "1", roles: ["Console.User"] };
  const admin = { name: "a@x.com", oid: "2", roles: ["Console.Admin"] };
  const none = { name: "n@x.com", oid: "3", roles: ["Something.Else"] };
  assert.equal(roleOf(none), null);
  assert.equal(can(null, "read-own").status, 401);
  assert.equal(can(none, "read-own").status, 403);
  assert.equal(can(user, "read-own").ok, true);
  for (const action of ["issue", "revoke", "rotate", "export", "sync-secret", "automation"]) {
    assert.equal(can(user, action).status, 403, action);
    assert.equal(can(admin, action).ok, true, action);
  }
  assert.equal(can(admin, "unknown-action").status, 403);
});

test("auth: ownership compares the owner tag case-insensitively and rejects missing tags", () => {
  const user = { name: "u@x.com", roles: ["Console.User"] };
  assert.equal(ownsKey(user, { owner: "U@X.com" }), true);
  assert.equal(ownsKey(user, { owner: "other@x.com" }), false);
  assert.equal(ownsKey(user, {}), false);
  assert.equal(ownsKey(null, { owner: "u@x.com" }), false);
});

function kvLikeSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // Key Vault signs a caller-supplied SHA-256 digest and returns raw r||s. Node cannot sign a
  // bare digest, so the fake signs the data with SHA-256 — the same digest — after checking it.
  const signDigest = async (digest, data) => {
    assert.deepEqual(digest, createHash("sha256").update(data).digest());
    return nodeSign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  };
  return { signDigest, publicJwk: publicKey.export({ format: "jwk" }), kid: "https://kv/keys/bundle-signing/v1" };
}

const admin = { name: "admin@x.com", oid: "oid-a" };
const payload = { keys: [{ kind: "jwt", subject: "team-1", token: "eyJ.secret.value" }] };

test("bundle: round-trips and binds the header to the ciphertext", async () => {
  const s = kvLikeSigner();
  const passphrase = generatePassphrase();
  assert.ok(passphrase.length >= 16);
  const b = await createBundle({ payload, passphrase, admin, recipient: "team-1 lead", contents: ["jwt team-1"], signer: s, now: 1_700_000_000_000 });
  assert.equal(b.header.issuedBy.name, "admin@x.com");
  assert.equal(b.header.alg, "ES256");
  assert.equal(b.header.kid, s.kid);
  assert.ok(!JSON.stringify(b).includes("eyJ.secret.value"), "plaintext must not leak");
  const opened = openBundle(b, { passphrase, publicJwk: s.publicJwk });
  assert.deepEqual(opened.payload, payload);
  assert.equal(opened.header.recipient, "team-1 lead");
});

test("bundle: tampering, wrong passphrase and wrong key all fail before any plaintext", async () => {
  const s = kvLikeSigner();
  const other = kvLikeSigner();
  const passphrase = "correct horse battery staple";
  const b = await createBundle({ payload, passphrase, admin, recipient: "r", contents: ["c"], signer: s });
  const clone = () => JSON.parse(JSON.stringify(b));

  const t1 = clone(); t1.header.recipient = "mallory";
  assert.throws(() => openBundle(t1, { passphrase, publicJwk: s.publicJwk }), /signature/i);

  const t2 = clone(); const ct = Buffer.from(t2.ciphertext, "base64"); ct[0] ^= 1; t2.ciphertext = ct.toString("base64");
  assert.throws(() => openBundle(t2, { passphrase, publicJwk: s.publicJwk }), /hash|tamper/i);

  assert.throws(() => openBundle(b, { passphrase: "wrong passphrase 1234", publicJwk: s.publicJwk }), /passphrase|decrypt/i);
  assert.throws(() => openBundle(b, { passphrase, publicJwk: other.publicJwk }), /signature/i);
  assert.throws(() => openBundle({ ...clone(), signature: undefined }, { passphrase, publicJwk: s.publicJwk }), BundleError);
});

test("bundle: weak passphrases and missing admin identity are refused", async () => {
  const s = kvLikeSigner();
  await assert.rejects(createBundle({ payload, passphrase: "short", admin, recipient: "r", contents: [], signer: s }), /16/);
  await assert.rejects(createBundle({ payload, passphrase: "long enough passphrase", admin: {}, recipient: "r", contents: [], signer: s }), /admin/i);
});

test("bundle: the signature covers SHA-256 of the canonical header", async () => {
  const s = kvLikeSigner();
  let seen;
  const signer = { ...s, signDigest: async (d, data) => { seen = d; return s.signDigest(d, data); } };
  const b = await createBundle({ payload, passphrase: "long enough passphrase", admin, recipient: "r", contents: [], signer });
  const sortedKeys = (v) => Array.isArray(v) ? v.map(sortedKeys)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v;
  const expected = createHash("sha256").update(JSON.stringify(sortedKeys(b.header))).digest();
  assert.deepEqual(seen, expected);
});

test("rotation: enrolment and due dates", () => {
  assert.equal(parseRotateDays("30"), 30);
  for (const bad of ["0", "91", "abc", "", undefined, "7.5"]) assert.equal(parseRotateDays(bad), null, String(bad));
  const day = 86_400_000;
  const now = Date.parse("2026-10-16T00:00:00Z");
  assert.equal(isDue({ rotateDays: "7", rotatedAt: new Date(now - 8 * day).toISOString() }, now), true);
  assert.equal(isDue({ rotateDays: "7", rotatedAt: new Date(now - 6 * day).toISOString() }, now), false);
  assert.equal(isDue({ rotateDays: "7" }, now), true, "never rotated means due");
  assert.equal(isDue({ rotatedAt: new Date(0).toISOString() }, now), false, "not enrolled");
  assert.equal(isDue({ rotateDays: "7", rotatedAt: "garbage" }, now), true);
  assert.equal(otherSlot("primary"), "secondary");
  assert.equal(otherSlot("secondary"), "primary");
  assert.throws(() => otherSlot("tertiary"));
});

test("revocation: the ,a,b, list stays well-formed and idempotent", () => {
  const a = "k_0123456789abcdef", b = "k_fedcba9876543210";
  let list = ",";
  list = addRevoked(list, a);
  assert.equal(list, `,${a},`);
  list = addRevoked(list, a);
  assert.equal(list, `,${a},`);
  list = addRevoked(list, b);
  assert.equal(isRevoked(list, b), true);
  list = removeRevoked(list, a);
  assert.equal(list, `,${b},`);
  assert.equal(removeRevoked(list, b), ",");
  assert.equal(addRevoked("", a), `,${a},`);
  assert.throws(() => addRevoked(list, "k_1,evil"), /jti/);
});

test("handout: signed keys give opencode and Claude Code settings on the right routes", () => {
  const h = jwtHandout({ gatewayUrl: "https://gw.example.net/", token: "T", models: ["flash", "haiku-4-5"], claudeModels: ["haiku-4-5"] });
  assert.equal(h.env.OPENAI_BASE_URL, "https://gw.example.net/v1");
  assert.equal(h.env.OPENAI_API_KEY, "T");
  assert.equal(h.claudeSettings.env.ANTHROPIC_BASE_URL, "https://gw.example.net/claude");
  assert.equal(h.claudeSettings.env.ANTHROPIC_AUTH_TOKEN, "T");
  assert.equal(h.claudeSettings.env.ANTHROPIC_MODEL, "haiku-4-5");
  assert.deepEqual(Object.keys(h.opencode.provider["hackathon-gateway"].models), ["flash"]);
  const onlyOpenAi = jwtHandout({ gatewayUrl: "https://gw", token: "T", models: ["flash"], claudeModels: ["haiku-4-5"] });
  assert.equal(onlyOpenAi.claudeSettings, null);
});

test("handout: product keys use the POC routes and their headers", () => {
  const h = productHandout({ gatewayUrl: "https://gw.example.net", key: "K", claudeModel: "claude-haiku-4-5" });
  assert.equal(h.claudeSettings.env.ANTHROPIC_BASE_URL, "https://gw.example.net/poc/claude");
  assert.equal(h.claudeSettings.env.ANTHROPIC_API_KEY, "K");
  assert.match(h.curl, /api-key: K/);
});

test("validate: signed-key requests are checked against the model maps", () => {
  const allowed = ["flash", "haiku-4-5"];
  const ok = validateJwtRequest({ owner: "Ada@Contoso.com", subject: "team-1", models: ["flash"], budget: 50000, hours: 48 }, { allowedModels: allowed });
  assert.equal(ok.owner, "ada@contoso.com");
  assert.equal(ok.budget, 50000);
  const bad = [
    { owner: "not-an-email", subject: "t", models: ["flash"], budget: 1, hours: 1 },
    { owner: "a@b.co", subject: "has space", models: ["flash"], budget: 1, hours: 1 },
    { owner: "a@b.co", subject: "t", models: ["gpt-unknown"], budget: 1, hours: 1 },
    { owner: "a@b.co", subject: "t", models: [], budget: 1, hours: 1 },
    { owner: "a@b.co", subject: "t", models: ["flash"], budget: -5, hours: 1 },
    { owner: "a@b.co", subject: "t", models: ["flash"], budget: 1e12, hours: 1 },
    { owner: "a@b.co", subject: "t", models: ["flash"], budget: 1, hours: 24 * 400 },
  ];
  for (const b of bad) assert.throws(() => validateJwtRequest(b, { allowedModels: allowed }), InputError, JSON.stringify(b));
});

test("validate: product key requests are limited to known products and safe names", () => {
  const products = ["poc-claude-pack", "poc-tiny-pack"];
  const ok = validateProductKeyRequest({ owner: "a@b.co", name: "team-1", product: "poc-tiny-pack", rotateDays: 30 }, { products });
  assert.equal(ok.subscriptionId, "poc-team-1");
  assert.equal(ok.secretName, "poc-key-team-1");
  assert.equal(ok.rotateDays, 30);
  assert.equal(validateProductKeyRequest({ owner: "a@b.co", name: "t2", product: "poc-tiny-pack" }, { products }).rotateDays, null);
  for (const b of [
    { owner: "a@b.co", name: "Team 1", product: "poc-tiny-pack" },
    { owner: "a@b.co", name: "team-1", product: "starter" },
    { owner: "a@b.co", name: "team-1", product: "poc-tiny-pack", rotateDays: 365 },
  ]) assert.throws(() => validateProductKeyRequest(b, { products }), InputError, JSON.stringify(b));
});
