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

test("dashboard demo: a custom usage range, a chargeback report with usage of a key gone from Key Vault, and a custom domain to try", async () => {
  const { server, url } = await startDemo({ port: 0, quiet: true });
  const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", origin: url.replace(/\/$/, "") }, body: JSON.stringify(body) });
  const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  try {
    const range = await (await fetch(url + `api/usage?kind=jwt&from=${day(6)}&to=${day(0)}`)).json();
    assert.deepEqual(range.range, { from: day(6), to: day(0) });
    assert.equal(range.series.length, 7);
    assert.ok(range.total.tokens > 0, "synthetic usage answers a custom range too");
    const twoDays = await (await fetch(url + `api/usage?kind=product&from=${day(1)}&to=${day(0)}`)).json();
    assert.equal(twoDays.bucket, "hour");
    assert.ok(twoDays.series.filter((p) => p.tokens > 0).length > 2, "two days of synthetic usage come by the hour");
    assert.equal(twoDays.series.reduce((sum, p) => sum + p.tokens, 0), twoDays.total.tokens);
    const past = await (await fetch(url + `api/usage?kind=jwt&from=${day(40)}&to=${day(31)}`)).json();
    assert.ok(past.total.tokens > 0);
    assert.equal(past.series.reduce((sum, p) => sum + p.tokens, 0), past.total.tokens, "every synthetic row falls inside the range asked for");
    const overview = await (await fetch(url + "api/usage?kind=jwt&days=30")).json();
    assert.ok(overview.byKey.some((k) => k.name === null && k.keyId), "some usage belongs to a key no longer in Key Vault");

    const report = await (await post("api/chargeback", { days: 30, kind: "all" })).json();
    assert.equal(report.filename, `chargeback-${day(30)}-${day(0)}.csv`);
    assert.ok(report.rows > 5);
    assert.match(report.csv, /^period_start_utc,period_end_utc,key_kind,/);
    assert.match(report.csv, /,unknown,/);
    assert.match(report.csv, /\r\n[^\r\n]*,product,poc-key-/);

    const settings = await (await fetch(url + "api/gateway-url")).json();
    assert.deepEqual(settings.candidates, ["https://ai.contoso.example"], "one gateway custom domain on offer");
    assert.equal((await post("api/gateway-url", { url: "https://developer.contoso.example" })).status, 400, "a developer portal domain is refused");
    assert.equal((await post("api/gateway-url", { url: "https://ai.contoso.example" })).status, 200);
    assert.equal((await (await fetch(url + "api/config")).json()).gatewayUrl, "https://ai.contoso.example");
    assert.equal((await post("api/gateway-url/reset", {})).status, 200);
    assert.equal((await (await fetch(url + "api/config")).json()).gatewayUrl, "https://gw.example.net");
  } finally {
    server.close();
  }
});
