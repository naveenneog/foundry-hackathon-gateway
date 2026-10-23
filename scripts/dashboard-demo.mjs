#!/usr/bin/env node
/**
 * Try the Key Dashboard without Azure: `node scripts/dashboard-demo.mjs`, then open
 * http://127.0.0.1:8090/.
 *
 * Runs the real server, service and browser UI (src/console/) against the in-memory Key Vault,
 * API Management and Foundry fakes the unit tests use (tests/console.harness.mjs), with seeded
 * keys and synthetic usage. Every request is treated as signed in as a demo admin, so it listens
 * on 127.0.0.1 only. Nothing leaves the machine and nothing is kept after it stops.
 *
 *   PORT=8091 node scripts/dashboard-demo.mjs
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createHandler } from "../src/console/server.mjs";
import { harness } from "../tests/console.harness.mjs";

const TEMPLATE = new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url);
const ADMIN = { name: "admin@contoso.com", oid: "demo-admin", role: "admin" };
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function seed(h) {
  h.service.setPackTemplate(readFileSync(TEMPLATE, "utf8"));
  await h.service.migrateSigningSecret(ADMIN);
  const people = ["alex", "sam", "kim", "lee", "ria"];
  for (const [i, p] of people.entries()) {
    await h.service.issueJwt(ADMIN, { owner: `${p}@contoso.com`, subject: `team-${i + 1}`, models: i % 2 ? ["flash", "haiku-4-5"] : ["haiku-4-5"],
      budget: 50_000 * (i + 1), hours: 24 * (i + 2), label: `Hackathon team ${i + 1}` });
  }
  await h.service.issueJwt(ADMIN, { owner: "dev@contoso.com", subject: "late-team", models: ["flash"], budget: 20_000, hours: 24, startInHours: 12, label: "Starts tomorrow" });
  const old = await h.service.issueJwt(ADMIN, { owner: "old@contoso.com", subject: "old-team", models: ["flash"], budget: 1_000, hours: 1 });
  await h.service.revokeJwt(ADMIN, old.name);
  const products = [["alex", ["claude-haiku-4-5"], 30], ["sam", ["claude-haiku-4-5", "deepseek-v4-flash"], undefined], ["kim", ["deepseek-v4-flash"], undefined]];
  for (const [p, models, rotateDays] of products) {
    await h.service.issueProductKey(ADMIN, { owner: `${p}@contoso.com`, name: `${p}-app`, models, monthlyTokens: 200_000, rotateDays });
  }
}

/** Synthetic AppMetrics rows in the shape the real query returns, deterministic per run. */
function syntheticUsage(h, now) {
  let state = 7;
  const rnd = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  return {
    async query(q) {
      const kind = q.includes('Route == "poc"') ? "product" : "jwt";
      const hourly = q.includes("1h");
      const count = hourly ? 24 : Number(/ago\((\d+)d\)/.exec(q)?.[1] ?? 7);
      const bucket = hourly ? HOUR : DAY;
      const end = Math.floor(now() / bucket) * bucket;
      const only = /KeyId == "([^"]+)"/.exec(q)?.[1];
      const keys = [...h.vault.secrets.values()].filter((s) => s.tags.kind === kind)
        .map((s) => ({ id: s.tags.jti ?? s.tags.subscription, models: String(s.tags.models ?? "flash").split(",") }))
        .filter((k) => !only || k.id === only);
      const rows = [];
      for (const k of keys) {
        for (let b = 0; b < count; b++) {
          if (rnd() < 0.35) continue;
          const at = new Date(end - b * bucket).toISOString();
          const model = k.models[Math.floor(rnd() * k.models.length)];
          const total = Math.round(rnd() * (hourly ? 900 : 9_000));
          const prompt = Math.round(total * 0.7);
          const calls = 1 + Math.floor(rnd() * 6);
          rows.push({ Bucket: at, KeyId: k.id, Model: model, Name: "Total Tokens", Tokens: total, Calls: calls },
            { Bucket: at, KeyId: k.id, Model: model, Name: "Prompt Tokens", Tokens: prompt, Calls: calls },
            { Bucket: at, KeyId: k.id, Model: model, Name: "Completion Tokens", Tokens: total - prompt, Calls: calls });
        }
      }
      return rows;
    },
  };
}

export async function startDemo({ port = Number(process.env.PORT ?? 8090), quiet = false } = {}) {
  const h = harness({
    now: Date.now(),
    inferenceFetch: async () => Response.json({ demo: true }),
  });
  const tick = setInterval(() => { h.clock.now = Date.now(); }, 1_000);
  tick.unref();
  await seed(h);
  h.service.setUsageSource(syntheticUsage(h, () => h.clock.now));
  const principal = Buffer.from(JSON.stringify({ auth_typ: "aad", name_typ: "name", role_typ: "roles",
    claims: [{ typ: "preferred_username", val: ADMIN.name }, { typ: "oid", val: ADMIN.oid }, { typ: "roles", val: "Console.Admin" }] })).toString("base64");
  const handler = createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} });
  const server = createServer((req, res) => {
    req.headers["x-ms-client-principal"] = principal;
    handler(req, res);
  });
  server.on("close", () => clearInterval(tick));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (!quiet) console.log(`Key Dashboard demo (sample data, no Azure): ${url}  — Ctrl+C to stop`);
  return { server, url };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await startDemo();
