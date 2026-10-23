/**
 * Console business logic. Pure orchestration over two injected ports — `vault` (Key Vault) and
 * `arm` (API Management control plane) — so every rule is tested with in-memory fakes and the
 * HTTP layer stays thin. Roles are enforced here as well as in the router (defence in depth);
 * ownership is enforced only here. Secret values never reach the audit log. ADR-0013.
 */

import { mintKey } from "../keys.mjs";
import { generateSecret } from "../keys.mjs";
import { createBundle, generatePassphrase } from "./bundle.mjs";
import { jwtHandout, productHandout } from "./handout.mjs";
import { addRevoked, isRevoked } from "./revocation.mjs";
import { isDue, otherSlot } from "./rotation.mjs";
import { validateJwtRequest, validateProductKeyRequest, InputError } from "./validate.mjs";
import { modelsApi } from "./service-models.mjs";
import { resolveGrant, ensurePack } from "./packs.mjs";
import { lifecycleApi } from "./service-lifecycle.mjs";
import { usageApi } from "./service-usage.mjs";
import { keysCsv, indexCsv } from "./csv.mjs";
import { foundriesApi } from "./service-foundries.mjs";

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export const SIGNING_SECRET_NAME = "gw-signing-secret";
export const BUNDLE_KEY = "bundle-signing";
export const PRODUCT_CONTENT_TYPE = "API Management subscription key";
const BULK_MAX = 50;
const EXPORT_MAX = 500;
const NV = { signing: "hackgw-signing-key", models: "hackgw-model-map", claude: "hackgw-claude-model-map", revoked: "hackgw-revoked-keys" };

const parseMap = (value) => String(value ?? "").split(";").map((e) => e.split("=")[0].trim().toLowerCase()).filter(Boolean);
const kindOf = (s) => s?.tags?.kind === "jwt" ? "jwt"
  : s?.tags?.kind === "product" || s?.contentType === PRODUCT_CONTENT_TYPE ? "product" : null;

export function createService({ vault, arm, foundry = null, packTemplate: initialTemplate = null, connectionTemplates = null,
  inferenceFetch = fetch, clock = Date.now, log = () => {}, gatewayUrl }) {
  let packTemplate = initialTemplate;
  const gwBase = String(gatewayUrl ?? "").replace(/\/+$/, "");
  const audit = (actor, action, fields = {}) =>
    log({ at: new Date(clock()).toISOString(), actor: typeof actor === "string" ? actor : actor?.name, action, ...fields });

  const requireAdmin = (actor) => {
    if (actor?.role !== "admin") throw new ServiceError(403, "Admin role required.");
  };
  // Admin-only dashboard (ADR-0016): owner is a tag for attribution, not an access grant.
  const owns = (actor) => actor?.role === "admin";

  /** A key the actor may see, or 404 — never revealing whether someone else's key exists. */
  async function visibleKey(actor, name) {
    const s = typeof name === "string" && /^[A-Za-z0-9-]{1,127}$/.test(name) ? await vault.getSecret(name) : null;
    if (!s || !kindOf(s) || !owns(actor, s)) throw new ServiceError(404, "No such key.");
    return s;
  }
  async function productSecret(name) {
    const s = await vault.getSecret(name);
    if (!s || kindOf(s) !== "product" || !/^poc-[a-z0-9-]+$/.test(s.tags?.subscription ?? "") || !["primary", "secondary"].includes(s.tags?.slot)) {
      throw new ServiceError(404, "No such product key (missing slot or subscription tags).");
    }
    return s;
  }
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof InputError) throw new ServiceError(400, e.message);
      throw e;
    }
  };

  const connections = foundriesApi({ vault, arm, foundry, gatewayUrl, connectionTemplates, inferenceFetch, clock, requireAdmin, audit, guard, ServiceError });
  const models = modelsApi({ arm, connections, requireAdmin, audit, guard });

  async function config() {
    const [m, c, products, deployments] = await Promise.all([arm.getNamedValue(NV.models), arm.getNamedValue(NV.claude), arm.listProducts(),
      models.grantableDeployments()]);
    const claude = parseMap(c?.value);
    return {
      gatewayUrl,
      models: { openai: parseMap(m?.value), claude },
      products: products.map((p) => p.id).filter((id) => id.startsWith("poc-")),
      deployments,
    };
  }

  async function signingStatus(actor) {
    requireAdmin(actor);
    const [v, a] = await Promise.all([vault.getSecret(SIGNING_SECRET_NAME), arm.listNamedValue(NV.signing)]);
    return { vault: Boolean(v), apim: Boolean(a), inSync: Boolean(v && a && v.value === a) };
  }

  async function migrateSigningSecret(actor) {
    requireAdmin(actor);
    const [v, a] = await Promise.all([vault.getSecret(SIGNING_SECRET_NAME), arm.listNamedValue(NV.signing)]);
    if (!a) throw new ServiceError(409, `APIM has no ${NV.signing} named value to migrate.`);
    if (v && v.value !== a) throw new ServiceError(409, "The vault already holds a different signing secret; push or rotate explicitly.");
    if (!v) await vault.setSecret(SIGNING_SECRET_NAME, a, { contentType: "HS256 signing secret (Base64)", tags: { kind: "signing", source: "apim-migration" } });
    audit(actor, "migrate-signing-secret", { changed: !v });
    return { migrated: !v };
  }

  const confirmOrFail = (body, word) => {
    if (body?.confirm !== word) throw new ServiceError(400, `Type ${word} to confirm: this invalidates or replaces the gateway's signing secret.`);
  };

  async function pushSigningSecret(actor, body) {
    requireAdmin(actor);
    confirmOrFail(body, "PUSH");
    const v = await vault.getSecret(SIGNING_SECRET_NAME);
    if (!v) throw new ServiceError(409, "The vault holds no signing secret; migrate first.");
    await arm.setNamedValue(NV.signing, v.value, { secret: true });
    audit(actor, "push-signing-secret", { version: v.version });
    return { pushed: true };
  }

  async function rotateSigningSecret(actor, body) {
    requireAdmin(actor);
    confirmOrFail(body, "ROTATE");
    const v = await vault.setSecret(SIGNING_SECRET_NAME, generateSecret(), { contentType: "HS256 signing secret (Base64)", tags: { kind: "signing", source: "console-rotation" } });
    await arm.setNamedValue(NV.signing, v.value, { secret: true });
    audit(actor, "rotate-signing-secret", { version: v.version });
    return { rotated: true };
  }

  async function signingSecret() {
    const secret = await vault.getSecret(SIGNING_SECRET_NAME);
    if (!secret) throw new ServiceError(409, "The vault holds no signing secret yet; migrate it from APIM first.");
    return secret;
  }

  async function mintAndStore(actor, req, secret) {
    const notBefore = clock() + Math.round(req.startInHours * 3_600_000);
    const expiresAt = notBefore + Math.round(req.hours * 3_600_000);
    const { token, jti } = mintKey({ secret: secret.value, subject: req.subject, models: req.models, budget: req.budget, notBefore, expiresAt, label: req.label });
    const name = `jwt-${jti.replace("_", "-")}`;
    await vault.setSecret(name, token, {
      contentType: "application/jwt",
      tags: { kind: "jwt", jti, owner: req.owner, subject: req.subject, models: req.models.join(","), budget: String(req.budget),
        notBefore: new Date(notBefore).toISOString(), expires: new Date(expiresAt).toISOString(), revoked: "false", issuedBy: actor.name, ...(req.label ? { label: req.label } : {}) },
    });
    return { name, jti, token, notBefore, expiresAt };
  }

  async function issueJwt(actor, body) {
    requireAdmin(actor);
    const cfg = await config();
    const req = await guard(async () => validateJwtRequest(body, { allowedModels: [...cfg.models.openai, ...cfg.models.claude] }));
    const { name, jti, token, notBefore, expiresAt } = await mintAndStore(actor, req, await signingSecret());
    audit(actor, "issue-jwt", { jti, owner: req.owner, subject: req.subject, models: req.models.join(","), budget: req.budget, startInHours: req.startInHours });
    return { name, jti, token, notBefore, expiresAt, handout: jwtHandout({ gatewayUrl, token, models: req.models, claudeModels: cfg.models.claude }) };
  }

  const entriesOf = (body) => {
    const entries = body?.entries;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > BULK_MAX) throw new ServiceError(400, `Send 1–${BULK_MAX} rows per request.`);
    return entries;
  };

  /**
   * Many keys on one grant, returned with a keys.csv to send out, as admin.ps1 does (ADR-0016).
   * Rows fail one by one. The response goes only to an admin and is never cached or logged.
   */
  async function issueJwtBulk(actor, body) {
    requireAdmin(actor);
    const entries = entriesOf(body);
    const cfg = await config();
    const allowedModels = [...cfg.models.openai, ...cfg.models.claude];
    const common = { models: body.models, budget: body.budget, hours: body.hours, startInHours: body.startInHours, label: body.label };
    await guard(async () => validateJwtRequest({ ...common, owner: "check@example.com", subject: "check" }, { allowedModels }));
    const secret = await signingSecret();
    const issued = [];
    const failed = [];
    for (const [index, row] of entries.entries()) {
      try {
        const req = validateJwtRequest({ ...common, owner: row?.owner, subject: row?.subject }, { allowedModels });
        const k = await mintAndStore(actor, req, secret);
        const claude = req.models.filter((m) => cfg.models.claude.includes(m));
        issued.push({ name: k.name, owner: req.owner, subject: req.subject, jti: k.jti, token: k.token, models: req.models, budget: req.budget,
          notBefore: k.notBefore, expiresAt: k.expiresAt,
          openaiBaseUrl: req.models.length > claude.length ? `${gwBase}/v1` : "", anthropicBaseUrl: claude.length ? `${gwBase}/claude` : "", anthropicModel: claude[0] ?? "" });
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        failed.push({ index, error: e.message });
      }
    }
    audit(actor, "issue-jwt-bulk", { issued: issued.length, failed: failed.length, models: common.models?.join?.(","), names: issued.map((k) => k.name) });
    return { issued, failed, keysCsv: keysCsv(issued, "jwt"), indexCsv: indexCsv(issued, "jwt") };
  }

  async function revealKey(actor, name) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    audit(actor, "reveal", { name });
    const kind = kindOf(s);
    if (kind === "jwt") {
      const cfg = await config();
      const models = String(s.tags.models ?? "").split(",").filter(Boolean);
      return { name, kind, value: s.value, tags: s.tags, handout: jwtHandout({ gatewayUrl, token: s.value, models, claudeModels: cfg.models.claude }) };
    }
    return { name, kind, value: s.value, tags: s.tags, handout: productHandout({ gatewayUrl, key: s.value }) };
  }

  async function revokeJwt(actor, name) {
    requireAdmin(actor);
    const s = await visibleKey(actor, name);
    if (kindOf(s) !== "jwt" || !s.tags.jti) throw new ServiceError(400, "Only signed keys are revoked; suspend product keys instead.");
    const current = (await arm.getNamedValue(NV.revoked))?.value ?? ",";
    const next = addRevoked(current, s.tags.jti);
    if (next !== current) await arm.setNamedValue(NV.revoked, next, { secret: false });
    if (s.tags.revoked !== "true" || s.tags.archived !== "true") {
      const at = new Date(clock()).toISOString();
      await vault.updateTags(name, { ...s.tags, revoked: "true", revokedAt: s.tags.revokedAt ?? at, archived: "true", archivedAt: s.tags.archivedAt ?? at, archiveReason: "revoked" });
    }
    audit(actor, "revoke-jwt", { jti: s.tags.jti, name });
    return { revoked: true, jti: s.tags.jti };
  }

  async function productGrant(req) {
    if (!req.models) return { product: req.product, grantTags: {} };
    const grant = await guard(async () => resolveGrant(req.models, await models.grantableDeployments()));
    if (!packTemplate) throw new ServiceError(500, "The product policy template is not loaded.");
    const product = (await ensurePack(arm, packTemplate, { grant, monthlyTokens: req.monthlyTokens })).id;
    return { product, grantTags: { models: grant.map((g) => g.deployment).join(","), monthlyTokens: String(req.monthlyTokens) } };
  }

  async function createProductKey(actor, req, { product, grantTags }) {
    if (await arm.getSubscription(req.subscriptionId) || await vault.getSecret(req.secretName)) {
      throw new ServiceError(409, `A product key named ${req.name} already exists.`);
    }
    await arm.createSubscription(req.subscriptionId, { productId: product, displayName: `${req.name} (${req.owner})` });
    const keys = await arm.listSubscriptionSecrets(req.subscriptionId);
    const tags = { kind: "product", slot: "primary", subscription: req.subscriptionId, product, owner: req.owner,
      rotatedAt: new Date(clock()).toISOString(), state: "active", ...grantTags,
      ...(req.expiresDays ? { expires: new Date(clock() + req.expiresDays * 86_400_000).toISOString() } : {}),
      ...(req.rotateDays ? { rotateDays: String(req.rotateDays) } : {}) };
    await vault.setSecret(req.secretName, keys.primaryKey, { contentType: PRODUCT_CONTENT_TYPE, tags });
    return { name: req.secretName, subscriptionId: req.subscriptionId, product, key: keys.primaryKey };
  }

  async function issueProductKey(actor, body) {
    requireAdmin(actor);
    const cfg = await config();
    const req = await guard(async () => validateProductKeyRequest(body, { products: cfg.products }));
    const grant = await productGrant(req);
    const { key: _key, ...out } = await createProductKey(actor, req, grant);
    audit(actor, "issue-product", { name: req.secretName, product: grant.product, owner: req.owner, models: grant.grantTags.models, rotateDays: req.rotateDays });
    return out;
  }

  async function issueProductBulk(actor, body) {
    requireAdmin(actor);
    const entries = entriesOf(body);
    const cfg = await config();
    const common = { models: body.models, monthlyTokens: body.monthlyTokens, rotateDays: body.rotateDays, expiresDays: body.expiresDays, product: body.product };
    const first = await guard(async () => validateProductKeyRequest({ ...common, owner: "check@example.com", name: "check" }, { products: cfg.products }));
    const grant = await productGrant(first);
    const granted = (grant.grantTags.models ?? "").split(",");
    const routes = new Set((await models.grantableDeployments()).filter((d) => granted.includes(d.deployment)).map((d) => d.route));
    const issued = [];
    const failed = [];
    for (const [index, row] of entries.entries()) {
      try {
        const req = validateProductKeyRequest({ ...common, owner: row?.owner, name: row?.name }, { products: cfg.products });
        const k = await createProductKey(actor, req, grant);
        issued.push({ name: k.name, label: req.name, owner: req.owner, subscriptionId: k.subscriptionId, key: k.key,
          models: (grant.grantTags.models ?? "").split(",").filter(Boolean), monthlyTokens: req.monthlyTokens ?? null,
          expiresAt: req.expiresDays ? clock() + req.expiresDays * 86_400_000 : null,
          anthropicBaseUrl: !grant.grantTags.models || routes.has("claude") ? `${gwBase}/poc/claude` : "", openaiBaseUrl: routes.has("openai") ? `${gwBase}/poc/v1` : "" });
      } catch (e) {
        if (!(e instanceof InputError) && !(e instanceof ServiceError && e.status === 409)) throw e;
        failed.push({ index, error: e.message });
      }
    }
    audit(actor, "issue-product-bulk", { issued: issued.length, failed: failed.length, product: grant.product, names: issued.map((k) => k.name) });
    return { issued, failed, keysCsv: keysCsv(issued, "product"), indexCsv: indexCsv(issued, "product") };
  }

  async function rotate(name, actorName) {
    const s = await productSecret(name);
    const slot = otherSlot(s.tags.slot);
    await arm.regenerateKey(s.tags.subscription, slot);
    const keys = await arm.listSubscriptionSecrets(s.tags.subscription);
    const value = slot === "primary" ? keys.primaryKey : keys.secondaryKey;
    await vault.setSecret(name, value, { contentType: PRODUCT_CONTENT_TYPE, tags: { ...s.tags, slot, rotatedAt: new Date(clock()).toISOString() } });
    audit(actorName, "rotate-product", { name, slot });
    return { name, slot };
  }

  async function rotateProductKey(actor, name) {
    requireAdmin(actor);
    return rotate(name, actor.name);
  }

  async function setProductState(actor, name, state) {
    requireAdmin(actor);
    if (!["active", "suspended"].includes(state)) throw new ServiceError(400, "State must be active or suspended.");
    const s = await productSecret(name);
    await arm.setSubscriptionState(s.tags.subscription, state);
    await vault.updateTags(name, { ...s.tags, state });
    audit(actor, "set-product-state", { name, state });
    return { name, state };
  }

  async function setAutomation(actor, name, rotateDays) {
    requireAdmin(actor);
    const s = await productSecret(name);
    const tags = { ...s.tags };
    if (rotateDays == null || rotateDays === "") {
      delete tags.rotateDays;
    } else {
      const n = Number(rotateDays);
      if (!Number.isInteger(n) || n < 1 || n > 90) throw new ServiceError(400, "Rotate every 1–90 days.");
      tags.rotateDays = String(n);
    }
    await vault.updateTags(name, tags);
    audit(actor, "set-automation", { name, rotateDays: tags.rotateDays ?? null });
    return { name, rotateDays: tags.rotateDays ? Number(tags.rotateDays) : null };
  }

  async function runRotationSweep() {
    const now = clock();
    const due = (await vault.listSecrets()).filter((s) => kindOf(s) === "product" && isDue(s.tags, now)).map((s) => s.name).sort();
    const rotated = [];
    const failed = [];
    for (const name of due) {
      try {
        await rotate(name, "scheduler");
        rotated.push(name);
      } catch (e) {
        failed.push(name);
        audit("scheduler", "rotate-product-failed", { name, error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { rotated, failed };
  }

  let bundleKey = null;
  async function ensureBundleKey() {
    bundleKey ??= (await vault.getKey(BUNDLE_KEY)) ?? (await vault.createKey(BUNDLE_KEY));
    return bundleKey;
  }
  async function bundlePublicKey() {
    const { jwk, kid } = await ensureBundleKey();
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid };
  }

  async function exportBundle(actor, { names, recipient, passphrase } = {}) {
    requireAdmin(actor);
    if (!Array.isArray(names) || names.length === 0 || names.length > EXPORT_MAX) throw new ServiceError(400, `Choose 1–${EXPORT_MAX} keys to export.`);
    const who = String(recipient ?? "").trim();
    if (!who || who.length > 120) throw new ServiceError(400, "Name the recipient (up to 120 characters).");
    const cfg = await config();
    const keys = [];
    for (const name of names) {
      const s = await visibleKey(actor, name);
      const kind = kindOf(s);
      const models = String(s.tags.models ?? "").split(",").filter(Boolean);
      keys.push({ name, kind, value: s.value, tags: s.tags,
        handout: kind === "jwt" ? jwtHandout({ gatewayUrl, token: s.value, models, claudeModels: cfg.models.claude }) : productHandout({ gatewayUrl, key: s.value }) });
    }
    const generated = passphrase ? undefined : generatePassphrase();
    const { kid } = await ensureBundleKey();
    const signer = { kid, signDigest: (digest, data) => vault.sign(kid, digest, data) };
    let bundle;
    try {
      bundle = await createBundle({ payload: { keys }, passphrase: passphrase ?? generated, admin: actor, recipient: who,
        contents: keys.map((k) => `${k.kind}:${k.name}`), signer, now: clock() });
    } catch (e) {
      if (e.name === "BundleError") throw new ServiceError(400, e.message);
      throw e;
    }
    audit(actor, "export", { recipient: who, names, ciphertextSha256: bundle.header.ciphertextSha256 });
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, "-");
    return { bundle, filename: `keys-${stamp}.bundle.json`, ...(generated ? { passphrase: generated } : {}) };
  }

  const setPackTemplate = (xml) => { packTemplate = xml; };
  const usageFns = usageApi({ vault, clock, owns, kindOf, visibleKey, ServiceError, requireAdmin });
  const revocations = {
    async add(jti) {
      const current = (await arm.getNamedValue(NV.revoked))?.value ?? ",";
      const next = addRevoked(current, jti);
      if (next !== current) await arm.setNamedValue(NV.revoked, next, { secret: false });
    },
    async has(jti) {
      return isRevoked((await arm.getNamedValue(NV.revoked))?.value ?? ",", jti);
    },
  };
  const lifecycle = lifecycleApi({ vault, arm, clock, audit, requireAdmin, owns, kindOf, visibleKey, rotate, ServiceError, revokedName: NV.revoked, guard, revocations });

  return { ...models, ...lifecycle, ...usageFns, listFoundries: connections.listFoundries, attachFoundry: connections.attachFoundry,
    testFoundry: connections.testFoundry, setPackTemplate, config, signingStatus, migrateSigningSecret, pushSigningSecret, rotateSigningSecret, issueJwt, issueJwtBulk, issueProductBulk, revealKey,
    revokeJwt, issueProductKey, rotateProductKey, setProductState, setAutomation, runRotationSweep, bundlePublicKey, exportBundle };
}
