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
    assert.equal(foundries.accounts.length, 2, "practice selecting and attaching another Foundry without Azure");
    const test = await fetch(url + "api/foundries/test", {
      method: "POST", headers: { "content-type": "application/json", origin: url.replace(/\/$/, "") },
      body: JSON.stringify({ alias: "flash", route: "openai" }),
    });
    assert.equal((await test.json()).ok, true, "the demo simulates inference instead of making external requests");
  } finally {
    server.close();
  }
});
