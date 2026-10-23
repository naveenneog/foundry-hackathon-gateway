/** Account-isolated APIM routes. Existing routes/maps/audiences are never repointed (ADR-0017). */
import { createHash } from "node:crypto";
import { InputError } from "./validate.mjs";
import { ACCOUNT_ID } from "./azure-foundries.mjs";

export function connectionInfo(account, gatewayUrl, legacy = false) {
  if (!ACCOUNT_ID.test(String(account.id))) throw new InputError("Expected a Foundry account resource id.");
  const id = legacy ? "default" : `f${createHash("sha256").update(account.id.toLowerCase()).digest("hex").slice(0, 12)}`;
  const prefix = `hackgw-${id}`;
  return {
    id, foundryId: account.id, name: account.name, kind: account.kind,
    gatewayUrl: `${gatewayUrl.replace(/\/+$/, "")}${legacy ? "" : `/foundry/${id}`}`,
    audience: legacy ? "hackathon-gateway" : `hackathon-gateway-${id}`,
    mapNames: legacy ? { openai: "hackgw-model-map", claude: "hackgw-claude-model-map" }
      : { openai: `${prefix}-model-map`, claude: `${prefix}-claude-model-map` },
    apiIds: legacy ? { openai: "deepseek-gateway", claude: "claude-gateway", productOpenai: "poc-openai", productClaude: "poc-claude" }
      : { openai: `${prefix}-openai`, claude: `${prefix}-claude`, productOpenai: `${prefix}-product-openai`, productClaude: `${prefix}-product-claude` },
    backendIds: { openai: `${prefix}-openai`, claude: `${prefix}-claude` },
  };
}

export function accountEndpoints(account) {
  if (!["AIServices", "OpenAI"].includes(account.kind)) throw new InputError("Expected Foundry or Azure OpenAI.");
  const domain = account.properties?.customSubDomainName;
  if (typeof domain !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/i.test(domain)) throw new InputError("Foundry has no valid custom subdomain; configure it in Azure first.");
  return {
    openai: `https://${domain}.openai.azure.com/openai/v1`,
    claude: `https://${domain}.services.ai.azure.com/anthropic`,
    // Current /openai/v1 SDK samples use ai.azure.com for Azure OpenAI as well as Foundry.
    audience: "https://ai.azure.com",
  };
}

const operations = {
  openai: [["chat-completions", "POST", "/chat/completions"], ["list-models", "GET", "/models"]],
  claude: [["messages", "POST", "/v1/messages"], ["count-tokens", "POST", "/v1/messages/count_tokens"]],
  productOpenai: [["chat-completions", "POST", "/chat/completions"]],
  productClaude: [["messages", "POST", "/v1/messages"], ["count-tokens", "POST", "/v1/messages/count_tokens"]],
};
const suffix = { openai: "v1", claude: "claude", productOpenai: "poc/v1", productClaude: "poc/claude" };

export async function provisionConnection(arm, connection, account, templates) {
  const c = connection;
  const endpoints = accountEndpoints(account);
  for (const route of ["openai", ...(account.kind === "AIServices" ? ["claude"] : [])]) {
    await arm.putBackend(c.backendIds[route], { protocol: "http", url: endpoints[route] });
  }
  for (const name of Object.values(c.mapNames)) {
    if (!(await arm.getNamedValue(name))) await arm.setNamedValue(name, ";", { secret: false });
  }
  for (const [type, ops] of Object.entries(operations)) {
    const route = type.toLowerCase().includes("claude") ? "claude" : "openai";
    if (account.kind === "OpenAI" && route === "claude") continue;
    let policy = templates?.[type];
    if (!policy?.includes("</inbound>")) throw new Error(`Missing ${type} connection policy template.`);
    if (!type.startsWith("product")) {
      if (!policy.includes("<audience>hackathon-gateway</audience>")) throw new Error("Gateway policy has no expected audience.");
      policy = policy.replace("<audience>hackathon-gateway</audience>", `<audience>${c.audience}</audience>`)
        .replaceAll("{{hackgw-model-map}}", `{{${c.mapNames.openai}}}`)
        .replaceAll("{{hackgw-claude-model-map}}", `{{${c.mapNames.claude}}}`);
    }
    policy = policy.replace('resource="https://ai.azure.com"', `resource="${endpoints.audience}"`)
      .replace("</inbound>", `    <set-backend-service backend-id="${c.backendIds[route]}" />\n    </inbound>`);
    const apiId = c.apiIds[type];
    await arm.putApi(apiId, {
      displayName: `Key Dashboard: ${account.name} ${type}`,
      path: `foundry/${c.id}/${suffix[type]}`,
      protocols: ["https"], serviceUrl: endpoints[route],
      subscriptionRequired: type.startsWith("product"),
      ...(type.startsWith("product") ? { subscriptionKeyParameterNames: { header: route === "claude" ? "x-api-key" : "api-key", query: "subscription-key" } } : {}),
    });
    for (const [id, method, urlTemplate] of ops) {
      await arm.putOperation(apiId, id, { displayName: id, method, urlTemplate, responses: [{ statusCode: 200 }] });
    }
    await arm.setApiPolicy(apiId, policy);
    const noPayload = { headers: [], body: { bytes: 0 } };
    await arm.setApiDiagnostic(apiId, {
      metrics: true, alwaysLog: "allErrors", verbosity: "information", httpCorrelationProtocol: "W3C",
      sampling: { samplingType: "fixed", percentage: 100 },
      frontend: { request: noPayload, response: noPayload }, backend: { request: noPayload, response: noPayload },
    });
  }
}
