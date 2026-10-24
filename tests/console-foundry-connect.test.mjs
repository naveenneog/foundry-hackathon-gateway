// Key Dashboard UI, P58 (ADR-0018): Foundry & models lists only the Foundries connected to this
// API Management; the subscription's other accounts appear only in Connect another Foundry. The
// pure helpers (foundry.js) run as they are; the views run against the fake DOM in
// console-dom.harness.mjs with a stubbed fetch.

import { test } from "node:test";
import assert from "node:assert/strict";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const foundry = await import(new URL("foundry.js", PUBLIC));

// ── Five accounts: two connected, two that can be attached, one unreadable ──

const SUB = "/subscriptions/00000000-0000-4000-8000-000000000002";
const armId = (rg, name) => `${SUB}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${name}`;
const MAIN = armId("rg-gateway", "foundry-main");
const RESEARCH = armId("rg-research", "foundry-research");
const NEW = armId("rg-research", "foundry-new");
const SPARE = armId("rg-spare", "aoai-spare");
const LOCKED = armId("rg-locked", "openai-locked");
const LOCKED_ERROR = "AuthorizationFailed: the dashboard cannot read this account's deployments.";

/** One discovery entry, as GET /api/foundries sends it; not connected unless `extra` says so. */
const account = (id, extra = {}) => ({
  id, name: id.split("/").at(-1), resourceGroup: id.split("/")[4], location: "eastus2", kind: "AIServices", connected: false, deployments: 1,
  setupCommand: `pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId '${id}'`,
  networkCommand: `pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId '${id}' -ConfigurePrivateEndpoint -VnetName 'vnet-gw'`,
  ...extra,
});
const discovery = (...accounts) => ({ subscriptionId: "00000000-0000-4000-8000-000000000002", defaultFoundryId: MAIN, accounts });
const FIVE = () => discovery(
  account(MAIN, { connected: true, connectionId: "default", deployments: 3 }),
  account(RESEARCH, { connected: true, connectionId: "f0123456789ab", location: "swedencentral", deployments: 2 }),
  account(NEW, { location: "westus3" }),
  account(SPARE, { kind: "OpenAI", location: "westeurope", deployments: 4 }),
  account(LOCKED, { kind: "OpenAI", deployments: 0, error: LOCKED_ERROR }),
);

// ── foundry.js: what each list counts ───────────────────────────────────────

test("the page counts only connected Foundries; Connect another Foundry counts and searches the rest", () => {
  const all = foundry.accountsOf(FIVE());
  assert.deepEqual(foundry.unconnectedAccounts(all).map((a) => a.name), ["aoai-spare", "foundry-new", "openai-locked"], "unreadable accounts included");
  assert.deepEqual(foundry.unconnectedAccounts(null), []);

  assert.equal(foundry.connectedLine(all), "2 Foundries connected to this API Management · 5 deployments.");
  assert.equal(foundry.connectedLine(all.filter((a) => a.isDefault)), "1 Foundry connected to this API Management · 3 deployments.");
  assert.equal(foundry.connectedLine(foundry.unconnectedAccounts(all)), "", "with none connected, the empty state speaks instead");
  const uncounted = foundry.accountsOf(discovery(account(MAIN, { connected: true, connectionId: "default", deployments: undefined })));
  assert.equal(foundry.connectedLine(uncounted), "1 Foundry connected to this API Management · 0 deployments in those that could be read.");

  assert.equal(foundry.candidatesLine(all), "3 accounts not connected: 2 can be attached, 1 unreadable.");
  assert.equal(foundry.candidatesLine(all, 1), "3 accounts not connected: 2 can be attached, 1 unreadable · 1 shown.");
  assert.equal(foundry.candidatesLine(all, 3), "3 accounts not connected: 2 can be attached, 1 unreadable.", "an unfiltered list says nothing about shown");
  assert.equal(foundry.candidatesLine(foundry.connectedAccounts(all)), "");

  const spare = all.find((a) => a.id === SPARE);
  assert.equal(foundry.matchesAccount(spare, "WESTEUROPE openai"), true, "region and kind, any case");
  assert.equal(foundry.matchesAccount(spare, "rg-spare"), true, "resource group");
  assert.equal(foundry.matchesAccount(spare, "spare locked"), false, "every term must match");
  assert.equal(foundry.matchesAccount(all.find((a) => a.id === LOCKED), "unreadable"), true, "the state is searchable");
  assert.equal(foundry.matchesAccount(spare, "  "), true);
});
