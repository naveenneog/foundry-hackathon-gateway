/**
 * Real adapters for the console's ports: Key Vault (data plane, 7.4) and API Management
 * (control plane, 2024-05-01), authenticated with the App Service managed identity.
 * Same API versions as poc/products-keyvault/scripts/PocKeys.ps1, which were proven live.
 *
 * Errors carry the method, the URL path (no query) and Azure's error code/message — never a
 * request body, which can hold a key.
 */

const VAULT_API = "7.4";
const APIM_API = "2024-05-01";
const IDENTITY_API = "2019-08-01";

export class AzureError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "AzureError";
    this.status = status;
    this.code = code;
  }
}

/** App Service managed identity token provider with a per-resource cache. */
export function managedIdentity({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async (resource) => {
    const hit = cache.get(resource);
    if (hit && hit.expiresAt - now() > 300_000) return hit.token;
    if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER) throw new AzureError(500, "No managed identity (IDENTITY_ENDPOINT is not set).");
    const url = `${env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=${IDENTITY_API}`;
    const res = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER } });
    if (!res.ok) throw new AzureError(res.status, `Managed identity token request failed for ${resource}.`);
    const body = await res.json();
    cache.set(resource, { token: body.access_token, expiresAt: Number(body.expires_on) * 1000 });
    return body.access_token;
  };
}

function client({ getToken, resource, fetchImpl, sleep }) {
  return async function call(method, url, { body, headers = {}, allow404 = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${await getToken(resource)}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404 && allow404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 10) * 1000);
        continue;
      }
      const text = await res.text();
      // APIM answers a policy PUT with the policy itself (raw XML), so only JSON is parsed; any
      // other body is never echoed, because a body can hold a key.
      const isJson = /json/i.test(res.headers.get("content-type") ?? "") || /^\s*[{[]/.test(text);
      let json = {};
      if (text && isJson) {
        try { json = JSON.parse(text); } catch { json = {}; }
      }
      if (!res.ok) {
        const err = json.error ?? {};
        throw new AzureError(res.status, `${method} ${url.split("?")[0]} failed (${res.status}): ${err.code ?? ""} ${err.message ?? ""}`.trim(), err.code);
      }
      return { status: res.status, json, headers: res.headers };
    }
  };
}

const lastSegment = (id) => String(id ?? "").replace(/\/+$/, "").split("/").pop();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function keyVault({ vaultUrl, getToken, fetchImpl = fetch, sleep = defaultSleep }) {
  const base = String(vaultUrl).replace(/\/+$/, "");
  const call = client({ getToken, resource: "https://vault.azure.net", fetchImpl, sleep });
  const q = `api-version=${VAULT_API}`;
  const seg = (name) => encodeURIComponent(name);
  const toSecret = (name, j) => ({ name, value: j.value, tags: j.tags ?? {}, contentType: j.contentType, version: lastSegment(j.id) });

  return {
    async getSecret(name) {
      const r = await call("GET", `${base}/secrets/${seg(name)}?${q}`, { allow404: true });
      return r ? toSecret(name, r.json) : null;
    },
    async setSecret(name, value, { tags = {}, contentType } = {}) {
      const r = await call("PUT", `${base}/secrets/${seg(name)}?${q}`, { body: { value, tags, ...(contentType ? { contentType } : {}) } });
      return toSecret(name, r.json);
    },
    async updateTags(name, tags) {
      const cur = await call("GET", `${base}/secrets/${seg(name)}?${q}`);
      const version = lastSegment(cur.json.id);
      const r = await call("PATCH", `${base}/secrets/${seg(name)}/${seg(version)}?${q}`, { body: { tags } });
      return { name, tags: r.json.tags ?? {}, version };
    },
    async listSecrets() {
      const out = [];
      let url = `${base}/secrets?${q}&maxresults=25`;
      while (url) {
        const r = await call("GET", url);
        for (const s of r.json.value ?? []) out.push({ name: lastSegment(s.id), tags: s.tags ?? {}, contentType: s.contentType });
        url = r.json.nextLink ?? null;
      }
      return out;
    },
    /** Soft delete: the secret stays recoverable for the vault's retention period. */
    async deleteSecret(name) {
      await call("DELETE", `${base}/secrets/${seg(name)}?${q}`, { allow404: true });
    },
    async getKey(name) {
      const r = await call("GET", `${base}/keys/${seg(name)}?${q}`, { allow404: true });
      return r ? { kid: r.json.key.kid, jwk: r.json.key } : null;
    },
    async createKey(name) {
      const r = await call("POST", `${base}/keys/${seg(name)}/create?${q}`, { body: { kty: "EC", crv: "P-256", key_ops: ["sign", "verify"] } });
      return { kid: r.json.key.kid, jwk: r.json.key };
    },
    /** Key Vault signs the digest; `data` is unused here and exists for the test fake. */
    async sign(kid, digest) {
      if (!String(kid).startsWith(`${base}/keys/`)) throw new AzureError(400, "Refusing to sign with a key outside this vault.");
      const r = await call("POST", `${kid}/sign?${q}`, { body: { alg: "ES256", value: Buffer.from(digest).toString("base64url") } });
      return Buffer.from(r.json.value, "base64url");
    },
  };
}

export function apim({ apimId, getToken, fetchImpl = fetch, sleep = defaultSleep, pollMs = 2000, pollLimit = 60 }) {
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/[^/]+$/i.test(apimId)) {
    throw new AzureError(500, "APIM_RESOURCE_ID is not an API Management resource id.");
  }
  const base = `https://management.azure.com${apimId}`;
  const call = client({ getToken, resource: "https://management.azure.com", fetchImpl, sleep });
  const url = (path) => `${base}${path}${path.includes("?") ? "&" : "?"}api-version=${APIM_API}`;
  const seg = (s) => encodeURIComponent(s);

  async function untilDone(r) {
    if (r.status !== 202) return r;
    const loc = r.headers.get("azure-asyncoperation") ?? r.headers.get("location");
    for (let i = 0; loc && i < pollLimit; i++) {
      await sleep(pollMs);
      const p = await call("GET", loc);
      const state = p.json?.status ?? p.json?.properties?.provisioningState;
      if (p.status === 200 && (!state || /succeeded/i.test(state))) return p;
      if (/failed|canceled/i.test(state ?? "")) throw new AzureError(500, `Long-running operation ${state}.`);
    }
    throw new AzureError(504, "Timed out waiting for API Management.");
  }

  return {
    async getNamedValue(name) {
      const r = await call("GET", url(`/namedValues/${seg(name)}`), { allow404: true });
      if (!r) return null;
      const p = r.json.properties ?? {};
      return { value: p.secret ? null : p.value, secret: Boolean(p.secret), displayName: p.displayName, tags: p.tags ?? [] };
    },
    async listNamedValue(name) {
      const r = await call("POST", url(`/namedValues/${seg(name)}/listValue`), { allow404: true });
      return r ? r.json.value ?? null : null;
    },
    async setNamedValue(name, value, { secret }) {
      const cur = await this.getNamedValue(name);
      const properties = { displayName: cur?.displayName ?? name, value, secret: Boolean(secret), ...(cur?.tags?.length ? { tags: cur.tags } : {}) };
      await untilDone(await call("PUT", url(`/namedValues/${seg(name)}`), { body: { properties }, headers: cur ? { "If-Match": "*" } : {} }));
    },
    async listProducts() {
      const out = [];
      let next = url("/products");
      while (next) {
        const r = await call("GET", next);
        for (const p of r.json.value ?? []) out.push({ id: p.name, displayName: p.properties?.displayName ?? p.name });
        next = r.json.nextLink ?? null;
      }
      return out;
    },
    async getSubscription(sid) {
      const r = await call("GET", url(`/subscriptions/${seg(sid)}`), { allow404: true });
      if (!r) return null;
      const p = r.json.properties ?? {};
      return { scope: p.scope, state: p.state, displayName: p.displayName };
    },
    async createSubscription(sid, { productId, displayName }) {
      await call("PUT", url(`/subscriptions/${seg(sid)}`), { body: { properties: { scope: `/products/${productId}`, displayName, state: "active" } } });
    },
    async listSubscriptionSecrets(sid) {
      const r = await call("POST", url(`/subscriptions/${seg(sid)}/listSecrets`));
      return { primaryKey: r.json.primaryKey, secondaryKey: r.json.secondaryKey };
    },
    async regenerateKey(sid, slot) {
      const op = { primary: "regeneratePrimaryKey", secondary: "regenerateSecondaryKey" }[slot];
      if (!op) throw new AzureError(400, `Unknown slot ${slot}.`);
      await call("POST", url(`/subscriptions/${seg(sid)}/${op}`));
    },
    async deleteSubscription(sid) {
      await call("DELETE", url(`/subscriptions/${seg(sid)}`), { headers: { "If-Match": "*" }, allow404: true });
    },
    async getProduct(id) {
      const r = await call("GET", url(`/products/${seg(id)}`), { allow404: true });
      return r ? { id: r.json.name ?? id, displayName: r.json.properties?.displayName, description: r.json.properties?.description } : null;
    },
    async createProduct(id, { displayName, description }) {
      await call("PUT", url(`/products/${seg(id)}`), { body: { properties: { displayName, description, subscriptionRequired: true, approvalRequired: false, state: "notPublished" } } });
    },
    async setProductPolicy(id, xml) {
      await call("PUT", url(`/products/${seg(id)}/policies/policy`), { body: { properties: { format: "rawxml", value: xml } } });
    },
    async linkProductApi(id, apiId) {
      await call("PUT", url(`/products/${seg(id)}/apis/${seg(apiId)}`));
    },
    async hasProductSubscriptions(id) {
      const r = await call("GET", url(`/products/${seg(id)}/subscriptions?$top=1`));
      return (r.json.value ?? []).length > 0;
    },
    async deleteProduct(id) {
      await call("DELETE", url(`/products/${seg(id)}?deleteSubscriptions=false`), { headers: { "If-Match": "*" }, allow404: true });
    },
    async setSubscriptionState(sid, state) {
      await call("PATCH", url(`/subscriptions/${seg(sid)}`), { body: { properties: { state } }, headers: { "If-Match": "*" } });
    },
  };
}

const FOUNDRY_API = "2024-10-01";

/** The Foundry (AIServices) account the gateway serves, and its model deployments. Reader is enough. */
export function foundryAccount({ accountId, getToken, fetchImpl = fetch, sleep = defaultSleep }) {
  const m = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i.exec(String(accountId));
  if (!m) throw new AzureError(500, "FOUNDRY_ACCOUNT_ID is not a Cognitive Services account resource id.");
  const call = client({ getToken, resource: "https://management.azure.com", fetchImpl, sleep });
  const base = `https://management.azure.com${accountId}`;
  return {
    async getAccount() {
      const acct = await call("GET", `${base}?api-version=${FOUNDRY_API}`);
      const deployments = [];
      let next = `${base}/deployments?api-version=${FOUNDRY_API}`;
      while (next) {
        const r = await call("GET", next);
        deployments.push(...(r.json.value ?? []));
        next = r.json.nextLink ?? null;
      }
      return { name: acct.json.name, resourceGroup: m[1], location: acct.json.location, deployments };
    },
  };
}

/** Log Analytics query API, as the workspace's Log Analytics Reader. Rows come back as objects. */
export function logAnalytics({ workspaceId, getToken, fetchImpl = fetch, sleep = defaultSleep }) {
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(String(workspaceId))) throw new AzureError(500, "LOG_WORKSPACE_ID is not a workspace id.");
  const call = client({ getToken, resource: "https://api.loganalytics.io", fetchImpl, sleep });
  return {
    async query(query, { timespan }) {
      const r = await call("POST", `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, { body: { query, timespan } });
      const table = r.json.tables?.[0] ?? { columns: [], rows: [] };
      return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c.name, row[i]])));
    },
  };
}
