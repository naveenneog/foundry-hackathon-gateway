import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const bicep = read("infra/console.bicep");
const deploy = read("scripts/Deploy-Console.ps1");
const dockerfile = read("infra/console.Dockerfile");
const code = (s) => s.replace(/\/\/.*$/gm, "");

test("console infra: HTTPS-only ingress, VNet-injected environment, one replica, health probes", () => {
  for (const s of ["allowInsecure: false", "requireHttps: true", "infrastructureSubnetId: subnet.id",
    "serviceName: 'Microsoft.App/environments'", "minReplicas: 1, maxReplicas: 1", "path: '/healthz'"]) {
    assert.ok(bicep.includes(s), s);
  }
  assert.match(bicep, /type: 'SystemAssigned,UserAssigned'/);
});

test("console infra: sign-in is required everywhere except the health probe, with no client secret", () => {
  assert.match(bicep, /containerApps\/authConfigs/);
  assert.match(bicep, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(bicep, /excludedPaths: \[ '\/healthz' \]/);
  assert.ok(!/clientSecret/i.test(code(bicep)), "no client secret setting");
  // The console trusts the principal header only because platform sign-in is configured here.
  assert.match(bicep, /name: 'WEBSITE_AUTH_ENABLED', value: 'True'/);
});

test("console infra: identities get exactly the roles they use, no registry passwords", () => {
  const assigned = [...bicep.matchAll(/roles\.(\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(assigned)].sort(),
    ["acrPull", "apiManagementServiceContributor", "keyVaultCryptoOfficer", "keyVaultSecretsOfficer"]);
  assert.match(bicep, /scope: registry\n\s+name: guid\(registry\.id, pullIdentity\.id/);
  assert.ok(!/Owner|'8e3af657|b24988ac/.test(bicep), "no Owner or Contributor");
  assert.ok(!/passwordSecretRef|adminUserEnabled: true/.test(bicep), "no registry admin credentials");
});

test("console image: minimal base, non-root, runs the console entry point", () => {
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\//m);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /CMD \["node", "src\/console\/main\.mjs"\]/);
});

test("deploy script: assignment required, ID-token sign-in, admin-less registry, nothing secret printed", () => {
  assert.match(deploy, /appRoleAssignmentRequired=true/);
  assert.match(deploy, /--enable-id-token-issuance true/);
  assert.match(deploy, /Console\.Admin/);
  assert.match(deploy, /Console\.User/);
  assert.match(deploy, /--admin-enabled false/);
  assert.match(deploy, /acr build/);
  // Tenants that disable user consent need a per-user grant for sign-in scopes (measured live).
  assert.match(deploy, /oauth2PermissionGrants/);
  assert.match(deploy, /consentType = 'Principal'/);
  assert.match(deploy, /scope = 'openid profile email'/);
  assert.ok(!/Write-Host[^\n]*\$[\w.()$]*(appId|\.id\b|principalId|token|secret)/i.test(deploy), "no ids or secrets echoed");
  // Only the public, tenant-independent Microsoft Graph ids (app id; openid, profile, email scopes).
  const WELL_KNOWN = ["00000003-0000-0000-c000-000000000000", "37f7f235-527c-4136-accd-4a02d197296e",
    "14dad69e-099b-42c9-810b-d002981feec1", "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0"];
  const guids = deploy.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  assert.deepEqual(guids.filter((g) => !WELL_KNOWN.includes(g.toLowerCase())), [], "no hard-coded tenant GUIDs");
});
