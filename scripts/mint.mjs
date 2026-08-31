#!/usr/bin/env node
/**
 * Mint a participant key. Reads a JSON request on stdin, writes a JSON result on stdout.
 *
 * Kept as a thin shim over src/keys.mjs so that admin.ps1 never reimplements JWS in
 * PowerShell — the tested implementation is the only one.
 *
 * Input:  {secret, subject, models[], budget, notBefore, expiresAt, label?}
 * Output: {token, jti} | {error}
 */

import { mintKey } from "../src/keys.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const req = JSON.parse(raw);
    const { token, jti } = mintKey({
      secret: req.secret,
      subject: req.subject,
      models: req.models,
      budget: Number(req.budget),
      notBefore: Number(req.notBefore),
      expiresAt: Number(req.expiresAt),
      label: req.label || undefined,
    });
    process.stdout.write(JSON.stringify({ token, jti }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  }
});
