/** Subscription-wide ARM discovery. No inference credentials or account keys are read. */
import { azureClient, AzureError } from "./azure.mjs";

const API = "2024-10-01";
export const ACCOUNT_ID = /^\/subscriptions\/([a-z0-9-]+)\/resourceGroups\/([a-z0-9._()-]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([a-z0-9-]+)$/i;

export function foundryDirectory({ accountId, getToken, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const home = ACCOUNT_ID.exec(String(accountId));
  if (!home) throw new AzureError(500, "FOUNDRY_ACCOUNT_ID must be an account resource id.");
  const subscriptionId = home[1];
  const call = azureClient({ getToken, resource: "https://management.azure.com", fetchImpl, sleep });

  function validate(id) {
    const m = ACCOUNT_ID.exec(String(id));
    if (!m) throw new AzureError(400, "Expected a Cognitive Services account resource id.");
    if (m[1].toLowerCase() !== subscriptionId.toLowerCase()) throw new AzureError(400, "Foundry must be in the configured subscription.");
    return m;
  }

  async function pages(url) {
    const out = [];
    const visited = new Set();
    while (url) {
      if (new URL(url).origin !== "https://management.azure.com" || visited.has(url)) throw new AzureError(502, "Invalid ARM pagination link.");
      visited.add(url);
      const r = await call("GET", url);
      out.push(...(r.json.value ?? []));
      url = r.json.nextLink ?? null;
    }
    return out;
  }

  const shape = (a, m) => ({
    id: a.id, name: a.name, kind: a.kind, resourceGroup: m[2], location: a.location,
    properties: a.properties ?? {},
  });
  const deployments = (id) => pages(`https://management.azure.com${id}/deployments?api-version=${API}`);

  return {
    defaultAccountId: accountId,
    subscriptionId,
    async getAccount(id = accountId) {
      const m = validate(id);
      const r = await call("GET", `https://management.azure.com${id}?api-version=${API}`);
      if (!["AIServices", "OpenAI"].includes(r.json.kind)) throw new AzureError(400, "This account is not Foundry or Azure OpenAI.");
      return { ...shape(r.json, m), deployments: await deployments(id) };
    },
    async listAccounts() {
      const accounts = (await pages(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=${API}`))
        .filter((a) => ["AIServices", "OpenAI"].includes(a.kind));
      const out = [];
      // Bound deployment discovery fan-out so larger subscriptions do not burst ARM.
      for (let i = 0; i < accounts.length; i += 4) {
        out.push(...await Promise.all(accounts.slice(i, i + 4).map(async (a) => {
          const metadata = shape(a, validate(a.id));
          try {
            return { ...metadata, deployments: await deployments(a.id) };
          } catch (e) {
            if (!(e instanceof AzureError)) throw e;
            return { ...metadata, deployments: [], error: e.message };
          }
        })));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
  };
}
