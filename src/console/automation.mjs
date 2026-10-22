/**
 * The automation (ADR-0015): one sweep — rotate due product keys, archive expired or revoked
 * keys, delete keys archived 30 days ago, prune expired revocations — then exit. Run by a
 * Container Apps cron job (`node src/console/automation.mjs`) or a Function App timer, with the
 * same environment as the dashboard. It has no inbound endpoint.
 */

import { pathToFileURL } from "node:url";
import { loadConfig, buildService, summarise } from "./main.mjs";

/** @returns {Promise<0|1>} the process exit code: 1 if the sweep failed or any key failed. */
export async function runOnce({ service, log }) {
  try {
    const r = await service.runSweep();
    const s = summarise(r);
    log({ level: "info", actor: "automation", action: "sweep", ...s });
    return s.failed.length ? 1 : 0;
  } catch (e) {
    log({ level: "error", actor: "automation", action: "sweep", error: String(e?.message ?? e).slice(0, 500) });
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const log = (e) => console.log(JSON.stringify(e));
  const cfg = loadConfig({ ...process.env, ROTATION_SWEEP_MINUTES: "0" });
  process.exitCode = await runOnce({ service: buildService(cfg, { log }), log });
}
