import { test } from "node:test";
import assert from "node:assert/strict";

import { startDemo } from "../scripts/dashboard-demo.mjs";

test("dashboard demo: serves the real UI and API on 127.0.0.1 with seeded keys and usage, admin only", async () => {
  const { server, url } = await startDemo({ port: 0, quiet: true });
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(server.address().address, "127.0.0.1", "never listens beyond this machine");
    assert.equal((await fetch(url)).status, 200);
    assert.deepEqual(await (await fetch(url + "api/me")).json(), { name: "admin@contoso.com", role: "admin" });
    const shortLived = (await (await fetch(url + "api/keys?kind=jwt")).json()).keys;
    const product = (await (await fetch(url + "api/keys?kind=product")).json()).keys;
    assert.ok(shortLived.length >= 5 && product.length >= 3);
    assert.ok(shortLived.some((k) => k.status === "scheduled"), "one key starts later");
    assert.ok((await (await fetch(url + "api/keys?kind=jwt&status=archived")).json()).keys.length >= 1);
    const usage = await (await fetch(url + "api/usage?kind=product&days=7")).json();
    assert.ok(usage.total.tokens > 0);
    const foundries = await (await fetch(url + "api/foundries")).json();
    const connected = foundries.accounts.filter((a) => a.connected);
    const waiting = foundries.accounts.filter((a) => !a.connected);
    assert.deepEqual(connected.map((a) => a.name).sort(), ["aif-secondary", "aif-test"], "Foundry & models lists the default and one attached Foundry");
    assert.ok(waiting.filter((a) => !a.error).length >= 3, "several accounts to practise Connect another Foundry without Azure");
    assert.ok(waiting.some((a) => a.error), "and one the dashboard cannot read");
    const attached = connected.find((a) => a.connectionId !== "default");
    const models = await (await fetch(url + `api/models?foundryId=${encodeURIComponent(attached.id)}`)).json();
    assert.ok(models.pins.openai.length >= 1, "the attached Foundry has a pinned alias to test");
    const test = await fetch(url + "api/foundries/test", {
      method: "POST", headers: { "content-type": "application/json", origin: url.replace(/\/$/, "") },
      body: JSON.stringify({ alias: "flash", route: "openai" }),
    });
    assert.equal((await test.json()).ok, true, "the demo simulates inference instead of making external requests");
    const practice = await fetch(url + "api/foundries/attach", {
      method: "POST", headers: { "content-type": "application/json", origin: url.replace(/\/$/, "") },
      body: JSON.stringify({ foundryId: waiting.find((a) => !a.error).id }),
    });
    assert.equal(practice.status, 200, "attaching one of them works in the demo");
  } finally {
    server.close();
  }
});
