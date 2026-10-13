import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poc } from "./poc-products-keyvault.harness.mjs";

const diagram = () => readFileSync(join(poc, "ARCHITECTURE.drawio"), "utf8");
const cells = (xml) => [...xml.matchAll(/<mxCell\b([^>]+)>/g)].map((match) => {
  const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return attrs;
});

test("P44 diagram has two editable pages and valid graph references", () => {
  const xml = diagram();
  assert.match(xml, /^<mxfile\b/);
  assert.deepEqual([...xml.matchAll(/<diagram[^>]+name="([^"]+)"/g)].map((m) => m[1]),
    ["Request and network", "Key lifecycle"]);
  for (const page of xml.split(/<diagram\b/).slice(1)) {
    const graph = cells(page);
    const ids = new Set(graph.map((cell) => cell.id));
    assert.equal(ids.size, graph.length, "cell ids are unique on each page");
    for (const cell of graph) {
      for (const ref of ["parent", "source", "target"]) {
        if (cell[ref]) assert.ok(ids.has(cell[ref]), `${cell.id}: missing ${ref} ${cell[ref]}`);
      }
      if (cell.edge === "1") assert.ok(cell.source && cell.target, `${cell.id}: arrow must connect nodes`);
    }
  }
});

test("P44 request paths distinguish inference from private secret reads", () => {
  const graph = cells(diagram().split("</diagram>")[0]);
  const hasEdge = (source, target) => graph.some((c) => c.edge === "1" && c.source === source && c.target === target);
  for (const pair of [["client", "apim"], ["apim", "foundry-pe"], ["foundry-pe", "foundry"],
    ["helper", "vault-pe"], ["runner", "vault-pe"], ["vault-pe", "vault"], ["operator", "arm"], ["arm", "subscriptions"]]) {
    assert.ok(hasEdge(...pair), `missing path ${pair.join(" -> ")}`);
  }
  assert.ok(!hasEdge("apim", "vault") && !hasEdge("apim", "vault-pe"), "gateway does not fetch a vault key per request");
  const text = graph.map((c) => c.value || "").join(" ");
  for (const term of ["poc/claude", "x-api-key", "poc/v1", "api-key", "context.Subscription.Id",
    "https://ai.azure.com", "public access Disabled", "bypass: None", "private network", "P42", "overshoot"]) {
    assert.ok(text.includes(term), `missing ${term}`);
  }
});

test("P44 lifecycle shows explicit orchestration, expiry and revocation limits", () => {
  const xml = diagram();
  for (const term of ["regenerate", "inactive slot", "new secret version", "slot", "subscription", "product",
    "SuspendExpired", "not enforced", "budget survives rotation", "Revoke", "Suspend", "next rotation",
    "No automatic Key Vault rotation job", "No Foundry key"]) {
    assert.ok(xml.includes(term), `missing ${term}`);
  }
  for (const file of ["README.md", "ARCHITECTURE.md"]) {
    assert.ok(readFileSync(join(poc, file), "utf8").includes("[Editable draw.io diagram](ARCHITECTURE.drawio)"));
  }
});
