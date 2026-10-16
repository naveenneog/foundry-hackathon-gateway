/**
 * Console entry point (App Service runs `node src/console/main.mjs`). Validates configuration,
 * wires the managed-identity adapters into the service, serves HTTP, and runs the opt-in product
 * key rotation sweep on an interval (App Service "Always On" keeps the process alive).
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { managedIdentity, keyVault, apim } from "./azure.mjs";
import { createService } from "./service.mjs";
import { createHandler } from "./server.mjs";

const fail = (m) => { throw new Error(`Configuration: ${m}`); };

export function loadConfig(env = process.env) {
  const vaultUrl = String(env.KEY_VAULT_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(vaultUrl)) fail("KEY_VAULT_URL must be https://<name>.vault.azure.net");
  const apimId = String(env.APIM_RESOURCE_ID ?? "");
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/[^/]+$/i.test(apimId)) fail("APIM_RESOURCE_ID must be an API Management resource id");
  const gatewayUrl = String(env.GATEWAY_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(gatewayUrl)) fail("GATEWAY_URL must be the gateway's https origin");
  const sweepMinutes = env.ROTATION_SWEEP_MINUTES === undefined ? 60 : Number(env.ROTATION_SWEEP_MINUTES);
  if (!Number.isInteger(sweepMinutes) || sweepMinutes < 0 || sweepMinutes > 1440) fail("ROTATION_SWEEP_MINUTES must be 0–1440");
  const port = Number(env.PORT ?? 8080);
  return { vaultUrl, apimId, gatewayUrl, sweepMinutes, port };
}

export function startScheduler({ service, minutes, log, timers = globalThis }) {
  if (!minutes) return null;
  const tick = async () => {
    try {
      const r = await service.runRotationSweep();
      log({ at: new Date().toISOString(), actor: "scheduler", action: "rotation-sweep", rotated: r.rotated.length, failed: r.failed });
    } catch (e) {
      log({ level: "error", action: "rotation-sweep", error: String(e?.message ?? e).slice(0, 500) });
    }
  };
  const id = timers.setInterval(tick, minutes * 60_000);
  return () => timers.clearInterval(id);
}

export function start(env = process.env) {
  const cfg = loadConfig(env);
  const log = (e) => console.log(JSON.stringify(e));
  const getToken = managedIdentity({ env });
  const service = createService({
    vault: keyVault({ vaultUrl: cfg.vaultUrl, getToken }),
    arm: apim({ apimId: cfg.apimId, getToken }),
    gatewayUrl: cfg.gatewayUrl,
    log,
  });
  const server = createServer(createHandler({ service, env, log }));
  server.listen(cfg.port, () => log({ level: "info", action: "listening", port: cfg.port, sweepMinutes: cfg.sweepMinutes }));
  startScheduler({ service, minutes: cfg.sweepMinutes, log });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) start();
