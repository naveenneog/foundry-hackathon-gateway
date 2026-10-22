/**
 * App Service path (ADR-0015): the automation as a Function App timer. It runs the same sweep as
 * the Container Apps job, with the same environment, and has no HTTP trigger. The deploy script
 * puts this file, src/** and package.json at the root of the package.
 */

import { app } from "@azure/functions";
import { loadConfig, buildService } from "../src/console/main.mjs";
import { runOnce } from "../src/console/automation.mjs";

let service = null;

app.timer('sweep', {
  schedule: '0 */15 * * * *',
  runOnStartup: false,
  handler: async (_timer, context) => {
    const log = (e) => context.log(JSON.stringify(e));
    service ??= buildService(loadConfig({ ...process.env, ROTATION_SWEEP_MINUTES: "0" }), { log });
    const code = await runOnce({ service, log });
    if (code !== 0) throw new Error("The sweep failed for at least one key; see the log line above.");
  },
});
