/**
 * Console entry point (`node src/console/main.mjs`). Validates configuration, wires the
 * managed-identity adapters into the service, serves HTTP, and can run the sweep in-process.
 * The deployed dashboard sets ROTATION_SWEEP_MINUTES=0: a separate automation (a Function App
 * timer or a Container Apps job, ADR-0015) runs src/console/automation.mjs instead.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { managedIdentity, keyVault, apim, logAnalytics } from "./azure.mjs";
import { foundryDirectory } from "./azure-foundries.mjs";
import { createService } from "./service.mjs";
import { createHandler } from "./server.mjs";

const fail = (m) => { throw new Error(`Configuration: ${m}`); };
const PACK_TEMPLATE_URL = new URL("../../poc/products-keyvault/infra/product-policy.xml", import.meta.url);

export function loadConfig(env = process.env) {
  const vaultUrl = String(env.KEY_VAULT_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(vaultUrl)) fail("KEY_VAULT_URL must be https://<name>.vault.azure.net");
  const apimId = String(env.APIM_RESOURCE_ID ?? "");
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/[^/]+$/i.test(apimId)) fail("APIM_RESOURCE_ID must be an API Management resource id");
  const gatewayUrl = String(env.GATEWAY_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(gatewayUrl)) fail("GATEWAY_URL must be the gateway's https origin");
  const sweepMinutes = env.ROTATION_SWEEP_MINUTES === undefined ? 60 : Number(env.ROTATION_SWEEP_MINUTES);
  if (!Number.isInteger(sweepMinutes) || sweepMinutes < 0 || sweepMinutes > 1440) fail("ROTATION_SWEEP_MINUTES must be 0–1440");
  const foundryAccountId = env.FOUNDRY_ACCOUNT_ID ? String(env.FOUNDRY_ACCOUNT_ID) : null;
  if (foundryAccountId && !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i.test(foundryAccountId)) {
    fail("FOUNDRY_ACCOUNT_ID must be a Cognitive Services account resource id");
  }
  const workspaceId = env.LOG_WORKSPACE_ID ? String(env.LOG_WORKSPACE_ID) : null;
  if (workspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) fail("LOG_WORKSPACE_ID must be the workspace's customer id (a GUID)");
  const port = Number(env.PORT ?? 8080);
  return { vaultUrl, apimId, gatewayUrl, sweepMinutes, port, foundryAccountId, workspaceId };
}

/** The service with real adapters; shared by the dashboard and the automation. */
export function buildService(cfg, { env = process.env, log }) {
  const getToken = managedIdentity({ env });
  const service = createService({
    vault: keyVault({ vaultUrl: cfg.vaultUrl, getToken }),
    arm: apim({ apimId: cfg.apimId, getToken }),
    foundry: cfg.foundryAccountId ? foundryDirectory({ accountId: cfg.foundryAccountId, getToken }) : null,
    packTemplate: readFileSync(PACK_TEMPLATE_URL, "utf8"),
    connectionTemplates: Object.fromEntries([
      ["openai", "../../infra/policy.xml"], ["claude", "../../infra/policy-claude.xml"],
      ["productOpenai", "../../poc/products-keyvault/infra/api-openai-policy.xml"],
      ["productClaude", "../../poc/products-keyvault/infra/api-claude-policy.xml"],
    ].map(([name, path]) => [name, readFileSync(new URL(path, import.meta.url), "utf8")])),
    gatewayUrl: cfg.gatewayUrl,
    log,
  });
  if (cfg.workspaceId) service.setUsageSource(logAnalytics({ workspaceId: cfg.workspaceId, getToken }));
  return service;
}

export const summarise = (r) => ({ rotated: r.rotated.length, archived: r.archived?.length ?? 0, deleted: r.deleted?.length ?? 0, failed: r.failed });

export function startScheduler({ service, minutes, log, timers = globalThis }) {
  if (!minutes) return null;
  const tick = async () => {
    try {
      log({ at: new Date().toISOString(), actor: "scheduler", action: "sweep", ...summarise(await service.runSweep()) });
    } catch (e) {
      log({ level: "error", action: "sweep", error: String(e?.message ?? e).slice(0, 500) });
    }
  };
  const id = timers.setInterval(tick, minutes * 60_000);
  return () => timers.clearInterval(id);
}

export function start(env = process.env) {
  const cfg = loadConfig(env);
  const log = (e) => console.log(JSON.stringify(e));
  const service = buildService(cfg, { env, log });
  const server = createServer(createHandler({ service, env, log }));
  server.listen(cfg.port, () => log({ level: "info", action: "listening", port: cfg.port, sweepMinutes: cfg.sweepMinutes,
    foundry: Boolean(cfg.foundryAccountId), usage: Boolean(cfg.workspaceId) }));
  startScheduler({ service, minutes: cfg.sweepMinutes, log });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) start();
