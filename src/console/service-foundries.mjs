/** Discover, attach and test account-isolated gateway connections (ADR-0017). */
import { connectionInfo, provisionConnection } from "./connections.mjs";
import { ACCOUNT_ID } from "./azure-foundries.mjs";
import { pinsFromMaps } from "./pinning.mjs";
import { mintKey } from "../keys.mjs";

const PREFIX = "gw-foundry-";
const SIGNING = "gw-signing-secret";

export function foundriesApi({ foundry, vault, arm, gatewayUrl, vnetName, connectionTemplates, requireAdmin, guard, ServiceError, audit, clock, inferenceFetch }) {
  const defaultId = foundry?.defaultAccountId;
  const legacy = connectionInfo({
    id: defaultId ?? "/subscriptions/default/resourceGroups/default/providers/Microsoft.CognitiveServices/accounts/default",
    name: defaultId?.split("/").at(-1) ?? "Configured Foundry", kind: "AIServices",
  }, gatewayUrl, true);
  if (!defaultId) legacy.foundryId = null;

  function validateId(id) {
    const m = ACCOUNT_ID.exec(String(id));
    if (!m) throw new ServiceError(400, "Expected a Foundry account resource id.");
    const sub = ACCOUNT_ID.exec(defaultId ?? "")?.[1];
    if (!sub || m[1].toLowerCase() !== sub.toLowerCase()) throw new ServiceError(400, "Foundry must be in the configured subscription.");
  }

  async function getAccount(id) {
    if (!foundry) return null;
    if (id) validateId(id);
    return foundry.getAccount(id || defaultId);
  }

  async function connectionFor(id, { allowUnattached = false } = {}) {
    if (id !== undefined && id !== null && typeof id !== "string") throw new ServiceError(400, "Foundry selection must be an account resource id.");
    if (!id || id.toLowerCase() === defaultId?.toLowerCase()) return { ...legacy, connected: true };
    validateId(id);
    const shell = connectionInfo({ id, name: id.split("/").at(-1) }, gatewayUrl);
    const saved = await vault.getSecret(`${PREFIX}${shell.id}`);
    if (!saved) {
      if (allowUnattached) return { ...shell, connected: false };
      throw new ServiceError(409, "Attach this Foundry in Foundry & models before issuing or pinning keys.");
    }
    let account;
    try { account = JSON.parse(saved.value); } catch { throw new ServiceError(500, "The stored Foundry connection is unreadable; attach it again to repair it."); }
    if (account.id?.toLowerCase() !== id.toLowerCase() || !["AIServices", "OpenAI"].includes(account.kind)) {
      throw new ServiceError(500, "The stored Foundry connection does not match its account.");
    }
    return { ...connectionInfo(account, gatewayUrl), connected: true };
  }

  const setupCommand = (id) => {
    const apim = String(arm.resourceId ?? "").split("/");
    return `pwsh scripts/Connect-Foundry.ps1 -Subscription '${foundry?.subscriptionId ?? ""}' -ResourceGroup '${apim[4] ?? ""}' -ApimName '${apim[8] ?? ""}' -FoundryAccountId '${id}'`;
  };
  const networkCommand = (id) => `${setupCommand(id)} -ConfigurePrivateEndpoint -VnetName '${vnetName ?? "<gateway-vnet>"}'`;

  async function discoverFoundries() {
    if (!foundry?.listAccounts) return { accounts: [], defaultFoundryId: defaultId ?? null, note: "Subscription discovery is not configured." };
    const [accounts, secrets] = await Promise.all([foundry.listAccounts(), vault.listSecrets()]);
    const saved = new Set(secrets.filter((s) => s.tags?.kind === "foundry-connection").map((s) => s.name));
    return {
      subscriptionId: foundry.subscriptionId, defaultFoundryId: defaultId,
      accounts: accounts.map((a) => {
        const c = connectionInfo(a, gatewayUrl, a.id.toLowerCase() === defaultId?.toLowerCase());
        return { id: a.id, name: a.name, kind: a.kind, resourceGroup: a.resourceGroup, location: a.location,
          connected: c.id === "default" || saved.has(`${PREFIX}${c.id}`), connectionId: c.id,
          deployments: a.deployments.length, ...(a.error ? { error: a.error } : {}), setupCommand: setupCommand(a.id), networkCommand: networkCommand(a.id) };
      }),
    };
  }

  async function listFoundries(actor) {
    requireAdmin(actor);
    return discoverFoundries();
  }

  async function connectionForKey(tags) {
    if (!tags?.foundry || tags.foundry === "default") return connectionFor();
    if (!/^f[0-9a-f]{12}$/.test(tags.foundry)) throw new ServiceError(500, "Invalid key Foundry metadata.");
    const saved = await vault.getSecret(`${PREFIX}${tags.foundry}`);
    if (!saved) throw new ServiceError(409, "This key's Foundry connection is missing; reattach that account.");
    let account;
    try { account = JSON.parse(saved.value); } catch { throw new ServiceError(500, "Unreadable Foundry metadata."); }
    const c = await connectionFor(account.id);
    if (c.id !== tags.foundry) throw new ServiceError(500, "Key Foundry metadata does not match its connection.");
    return c;
  }

  async function attachFoundry(actor, { foundryId } = {}) {
    requireAdmin(actor);
    validateId(foundryId);
    const account = await getAccount(foundryId);
    const c = connectionInfo(account, gatewayUrl, foundryId.toLowerCase() === defaultId?.toLowerCase());
    if (c.id !== "default") {
      await guard(() => provisionConnection(arm, c, account, connectionTemplates));
      await vault.setSecret(`${PREFIX}${c.id}`, JSON.stringify({ id: account.id, name: account.name, kind: account.kind }), {
        contentType: "application/json", tags: { kind: "foundry-connection", connectedAt: new Date(clock()).toISOString() },
      });
    }
    audit(actor, "attach-foundry", { foundryId, connection: c.id });
    return { attached: true, foundryId, foundryName: account.name, connectionId: c.id, gatewayUrl: c.gatewayUrl,
      setupCommand: setupCommand(foundryId), networkCommand: networkCommand(foundryId),
      message: "Routing configured. Gateway inference permissions and private-network access still need to be verified." };
  }

  async function testFoundry(actor, { foundryId, alias, route } = {}) {
    requireAdmin(actor);
    const c = await connectionFor(foundryId);
    if (!["openai", "claude"].includes(route) || typeof alias !== "string") throw new ServiceError(400, "Select a pinned alias and its route.");
    const map = await arm.getNamedValue(c.mapNames[route]);
    const pins = pinsFromMaps({ [route]: map?.value });
    if (!pins[route].some((p) => p.alias === alias)) throw new ServiceError(400, "Pin this model on the selected Foundry before testing it.");
    const signing = await vault.getSecret(SIGNING);
    if (!signing) throw new ServiceError(409, "Migrate the signing secret before testing inference.");
    const { token } = mintKey({ secret: signing.value, subject: "backend-connection-test", models: [alias], budget: 256,
      audience: c.audience, notBefore: clock(), expiresAt: clock() + 60_000 });
    let response;
    try {
      response = await inferenceFetch(`${c.gatewayUrl}${route === "claude" ? "/claude/v1/messages" : "/v1/chat/completions"}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: alias, max_tokens: 16, messages: [{ role: "user", content: "Reply: OK" }] }),
      });
    } catch (e) {
      if (!(e instanceof TypeError) && !["TimeoutError", "AbortError"].includes(e.name)) throw e;
      audit(actor, "test-foundry", { foundryId: c.foundryId, status: 0 });
      return { ok: false, status: 0, detail: "Gateway connection failed or timed out. Check APIM networking and private DNS." };
    }
    let diagnostic = "";
    if (response.ok) {
      await response.arrayBuffer();
    } else {
      const text = await response.text();
      try {
        const body = JSON.parse(text);
        diagnostic = String(body.error?.message ?? body.message ?? "").slice(0, 1000);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    audit(actor, "test-foundry", { foundryId: c.foundryId, status: response.status });
    if (/No such host|NameResolution|DNS/i.test(diagnostic)) {
      return { ok: false, status: response.status, code: "backend_dns",
        detail: "APIM cannot resolve this Foundry endpoint. Its VNet may link a private DNS zone without this account's record. Configure a private endpoint and DNS for the selected account, then retry." };
    }
    return { ok: response.ok, status: response.status, detail: response.ok ? "Model responded through the selected Foundry gateway route."
      : `Gateway returned ${response.status}. Check model pins, APIM inference permission, private networking and DNS; wait for APIM/RBAC propagation before retrying.` };
  }

  return { connectionFor, connectionForKey, getAccount, setupCommand, networkCommand, discoverFoundries, listFoundries, attachFoundry, testFoundry };
}
