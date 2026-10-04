#!/usr/bin/env node
/**
 * Work out what a deployment would do. Reads the facts on stdin, writes the plan on stdout.
 *
 * Thin shim over src/apim.mjs so admin.ps1 never reimplements the logic. It used to: the
 * PowerShell carried its own transcription of buildDeploymentPlan, and the two drifted in the
 * worst possible direction - the tested copy blocked a route that the shipping copy created.
 * The decision a reviewer reads has to be the decision an operator gets, so there is now one.
 *
 * Input:  the facts object buildDeploymentPlan takes
 * Output: {rows: [{component, action, detail}], blocked: <count>}, or {error}
 */

import { buildDeploymentPlan, PLAN } from "../src/apim.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const rows = buildDeploymentPlan(JSON.parse(raw));
    process.stdout.write(JSON.stringify({ rows, blocked: rows.filter((r) => r.action === PLAN.BLOCKED).length }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  }
});
