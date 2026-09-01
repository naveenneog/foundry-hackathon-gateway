#!/usr/bin/env node
/**
 * Explain why a key is being rejected. Reads a JSON request on stdin, writes a report on stdout.
 *
 * Thin shim over src/diagnose.mjs so admin.ps1 never reimplements the logic.
 *
 * Input:  {token, secret, modelMap, revoked[]}
 * Output: the report object from diagnoseKey, or {error}
 */

import { diagnoseKey } from "../src/diagnose.mjs";
import { parseModelMap } from "../src/models.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const req = JSON.parse(raw);
    const report = diagnoseKey({
      token: String(req.token || "").trim(),
      secret: req.secret,
      now: Date.now(),
      modelMap: parseModelMap(req.modelMap || ""),
      revoked: Array.isArray(req.revoked) ? req.revoked : [],
    });
    process.stdout.write(JSON.stringify(report));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  }
});
