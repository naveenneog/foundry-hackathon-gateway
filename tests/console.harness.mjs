/**
 * In-memory fakes for the console's two Azure dependencies. They implement the same interface
 * as src/console/azure.mjs so the service and server tests exercise real logic without Azure.
 */

import { generateKeyPairSync, randomBytes, sign as nodeSign, createHash } from "node:crypto";
import { createService } from "../src/console/service.mjs";

export function fakeVault() {
  const secrets = new Map();
  const keys = new Map();
  let version = 0;
  const calls = [];
  return {
    calls,
    secrets,
    async getSecret(name) {
      const s = secrets.get(name);
      return s ? { ...s, tags: { ...s.tags } } : null;
    },
    async setSecret(name, value, { tags = {}, contentType } = {}) {
      calls.push(["setSecret", name]);
      const s = { name, value, tags: { ...tags }, contentType, version: `v${++version}` };
      secrets.set(name, s);
      return { ...s };
    },
    async deleteSecret(name) {
      calls.push(["deleteSecret", name]);
      secrets.delete(name);
    },
    async updateTags(name, tags) {
      const s = secrets.get(name);
      if (!s) throw Object.assign(new Error("SecretNotFound"), { status: 404 });
      s.tags = { ...tags };
      return { ...s };
    },
    async listSecrets() {
      return [...secrets.values()].map(({ name, tags, contentType }) => ({ name, tags: { ...tags }, contentType }));
    },
    async getKey(name) {
      const k = keys.get(name);
      return k ? { kid: k.kid, jwk: k.jwk } : null;
    },
    async createKey(name) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const kid = `https://fake.vault/keys/${name}/${randomBytes(4).toString("hex")}`;
      const jwk = { ...publicKey.export({ format: "jwk" }), kid };
      keys.set(name, { kid, jwk, privateKey });
      return { kid, jwk };
    },
    // Real Key Vault receives only the digest; Node cannot sign a bare digest, so the fake signs
    // the data with SHA-256 after checking it hashes to the digest it was given.
    async sign(kid, digest, data) {
      const k = [...keys.values()].find((x) => x.kid === kid);
      if (!k) throw new Error("KeyNotFound");
      if (!createHash("sha256").update(data).digest().equals(digest)) throw new Error("digest mismatch");
      return nodeSign("sha256", data, { key: k.privateKey, dsaEncoding: "ieee-p1363" });
    },
  };
}

export function fakeArm({ signingKey = randomBytes(32).toString("base64") } = {}) {
  const namedValues = new Map([
    ["hackgw-signing-key", { value: signingKey, secret: true }],
    ["hackgw-model-map", { value: "flash=deepseek-v4-flash", secret: false }],
    ["hackgw-claude-model-map", { value: "haiku-4-5=claude-haiku-4-5", secret: false }],
    ["hackgw-revoked-keys", { value: ",", secret: false }],
  ]);
  const subscriptions = new Map();
  const products = new Map(["poc-claude-pack", "poc-deepseek-pack", "poc-tiny-pack"].map((id) => [id, { displayName: id, apis: [], policy: "" }]));
  const calls = [];
  const backends = new Map();
  const apis = new Map();
  const newKey = () => randomBytes(16).toString("hex");
  const sub = (sid) => {
    const s = subscriptions.get(sid);
    if (!s) throw Object.assign(new Error(`subscription ${sid} not found`), { status: 404 });
    return s;
  };
  return {
    namedValues,
    subscriptions,
    products,
    calls,
    backends,
    apis,
    async putBackend(id, properties) { backends.set(id, properties); },
    async putApi(id, properties) {
      apis.set(id, { properties, operations: apis.get(id)?.operations ?? new Map() });
    },
    async putOperation(api, id, properties) { apis.get(api).operations.set(id, properties); },
    async setApiPolicy(id, xml) { apis.get(id).policy = xml; },
    async setApiDiagnostic(id, properties) { apis.get(id).diagnostic = properties; },
    async getNamedValue(name) {
      const nv = namedValues.get(name);
      if (!nv) return null;
      return { value: nv.secret ? null : nv.value, secret: nv.secret };
    },
    async listNamedValue(name) {
      return namedValues.get(name)?.value ?? null;
    },
    async setNamedValue(name, value, { secret }) {
      namedValues.set(name, { value, secret });
    },
    async listProducts() {
      return [...products.keys()].map((id) => ({ id, displayName: products.get(id).displayName }));
    },
    async getSubscription(sid) {
      const s = subscriptions.get(sid);
      return s ? { scope: s.scope, state: s.state, displayName: s.displayName } : null;
    },
    async createSubscription(sid, { productId, displayName }) {
      subscriptions.set(sid, { scope: `/products/${productId}`, state: "active", displayName, primaryKey: newKey(), secondaryKey: newKey() });
    },
    async listSubscriptionSecrets(sid) {
      const s = sub(sid);
      return { primaryKey: s.primaryKey, secondaryKey: s.secondaryKey };
    },
    async regenerateKey(sid, slot) {
      sub(sid)[`${slot}Key`] = newKey();
    },
    async setSubscriptionState(sid, state) {
      sub(sid).state = state;
    },
    async deleteSubscription(sid) {
      calls.push(["deleteSubscription", sid]);
      subscriptions.delete(sid);
    },
    async getProduct(id) {
      const p = products.get(id);
      return p ? { id, displayName: p.displayName, description: p.description } : null;
    },
    async createProduct(id, { displayName, description }) {
      calls.push(["createProduct", id]);
      products.set(id, { displayName, description, apis: [], policy: "" });
    },
    async setProductPolicy(id, xml) {
      products.get(id).policy = xml;
    },
    async linkProductApi(id, apiId) {
      const p = products.get(id);
      if (!p.apis.includes(apiId)) p.apis.push(apiId);
    },
    async hasProductSubscriptions(id) {
      return [...subscriptions.values()].some((s) => s.scope === `/products/${id}`);
    },
    async deleteProduct(id) {
      calls.push(["deleteProduct", id]);
      products.delete(id);
    },
  };
}

export const ADMIN = { name: "admin@contoso.com", oid: "oid-admin", role: "admin" };
export const ALICE = { name: "alice@contoso.com", oid: "oid-alice", role: "user" };
export const BOB = { name: "bob@contoso.com", oid: "oid-bob", role: "user" };

const deployment = (name, format, state = "Succeeded") => ({ name, properties: { model: { name, format, version: "1" }, provisioningState: state } });

/** The Foundry account the gateway serves, as the ARM adapter returns it. */
export function fakeFoundry() {
  return {
    async getAccount() {
      return { name: "aif-test", resourceGroup: "rg-test", location: "eastus2", deployments: [
        deployment("deepseek-v4-flash", "DeepSeek"),
        deployment("claude-haiku-4-5", "Anthropic"),
        deployment("claude-sonnet-5", "Anthropic"),
        deployment("gpt-pending", "OpenAI", "Creating"),
        deployment("mystery", "Unheard"),
      ] };
    },
  };
}

export function harness({ now = Date.parse("2026-10-16T09:00:00Z") } = {}) {
  const vault = fakeVault();
  const arm = fakeArm();
  const foundry = fakeFoundry();
  const audit = [];
  const clock = { now };
  const service = createService({
    vault, arm, foundry,
    clock: () => clock.now,
    log: (event) => audit.push(event),
    gatewayUrl: "https://gw.example.net",
  });
  return { vault, arm, foundry, audit, clock, service };
}
