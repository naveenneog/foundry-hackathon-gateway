#!/usr/bin/env node
/**
 * Open a Key Console export bundle: verify the admin signature, then decrypt.
 *
 *   node scripts/open-bundle.mjs <bundle.json> --key <bundle-key.json> --out <keys.json>
 *
 * The passphrase is read from BUNDLE_PASSPHRASE, or prompted for. Get bundle-key.json (the public
 * verification key) from the console over a channel you trust, not from the sender of the bundle.
 * The decrypted keys go to --out (owner-only permissions), never to the terminal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { openBundle } from "../src/console/bundle.mjs";

function args(argv) {
  const out = { file: null, key: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") out.key = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (!out.file) out.file = argv[i];
  }
  return out;
}

async function passphrase() {
  if (process.env.BUNDLE_PASSPHRASE) return process.env.BUNDLE_PASSPHRASE;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await rl.question("Passphrase: ");
  } finally {
    rl.close();
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.file || !a.key || !a.out) {
    console.error("Usage: node scripts/open-bundle.mjs <bundle.json> --key <bundle-key.json> --out <keys.json>");
    return 2;
  }
  try {
    const bundle = JSON.parse(readFileSync(a.file, "utf8"));
    const publicJwk = JSON.parse(readFileSync(a.key, "utf8"));
    const { header, payload } = openBundle(bundle, { passphrase: await passphrase(), publicJwk });
    writeFileSync(a.out, JSON.stringify(payload, null, 2), { mode: 0o600 });
    console.error(`Signed by ${header.issuedBy.name} at ${header.issuedAt} for "${header.recipient}".`);
    console.error(`Contents: ${header.contents.join(", ")}`);
    console.error(`Decrypted ${payload.keys.length} key(s) to ${a.out}. Delete it once the keys are configured.`);
    return 0;
  } catch (e) {
    console.error(`Refused: ${e.message}`);
    return 1;
  }
}

process.exitCode = await main();
