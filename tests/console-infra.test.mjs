import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bicep = readFileSync("infra/console.bicep", "utf8").replace(/\r\n/g, "\n");
const deploy = readFileSync("scripts/Deploy-Console.ps1", "utf8").replace(/\r\n/g, "\n");

test("console infra: HTTPS only, TLS 1.2, no FTP or basic publishing credentials, all egress through the VNet", () => {
  for (const s of ["httpsOnly: true", "minTlsVersion: '1.2'", "ftpsState: 'Disabled'", "vnetRouteAllEnabled: true",
    "type: 'SystemAssigned'", "alwaysOn: true", "healthCheckPath: '/healthz'"]) {
    assert.ok(bicep.includes(s), s);
  }
  assert.match(bicep, /name: 'ftp'\n\s+properties: \{ allow: false \}/);
  assert.match(bicep, /name: 'scm'\n\s+properties: \{ allow: false \}/);
  assert.match(bicep, /serviceName: 'Microsoft.Web\/serverFarms'/);
});

test("console infra: sign-in is required everywhere except the health probe, with no client secret", () => {
  assert.match(bicep, /requireAuthentication: true/);
  assert.match(bicep, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(bicep, /excludedPaths: \[ '\/healthz' \]/);
  assert.ok(!/clientSecret/i.test(bicep.replace(/\/\/.*$/gm, "")), "no client secret setting");
  assert.match(bicep, /tokenStore: \{ enabled: false \}/);
});

test("console infra: the app identity gets exactly the three data/control-plane roles it uses", () => {
  const assigned = [...bicep.matchAll(/roles\.(\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(assigned)].sort(), ["apiManagementServiceContributor", "keyVaultCryptoOfficer", "keyVaultSecretsOfficer"]);
  assert.ok(!/Owner|'8e3af657|b24988ac/.test(bicep), "no Owner or Contributor");
});

test("deploy script: assignment required, ID-token sign-in, Linux-safe zip, nothing secret printed", () => {
  assert.match(deploy, /appRoleAssignmentRequired=true/);
  assert.match(deploy, /--enable-id-token-issuance true/);
  assert.match(deploy, /Console\.Admin/);
  assert.match(deploy, /Console\.User/);
  assert.match(deploy, /Replace\('\\', '\/'\)/);
  assert.ok(!/Write-Host[^\n]*\$[\w.()$]*(appId|\.id\b|principalId|token|secret)/i.test(deploy), "no ids or secrets echoed");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(deploy), "no hard-coded GUIDs");
});
