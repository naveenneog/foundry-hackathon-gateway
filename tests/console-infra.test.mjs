import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const bicep = read("infra/console.bicep");
const deploy = read("scripts/Deploy-Console.ps1");
const dockerfile = read("infra/console.Dockerfile");
const code = (s) => s.replace(/\/\/.*$/gm, "");

test("console infra: HTTPS-only ingress, VNet-injected environment, scales to zero, health probes", () => {
  for (const s of ["allowInsecure: false", "requireHttps: true", "infrastructureSubnetId: subnet.id",
    "serviceName: 'Microsoft.App/environments'", "minReplicas: 0, maxReplicas: 1", "path: '/healthz'"]) {
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
    ["acrPull", "apiManagementServiceContributor", "keyVaultCryptoOfficer", "keyVaultSecretsOfficer", "logAnalyticsDataReader", "reader"]);
  // The automation job has only what the sweep uses: no bundle signing, no usage, no Foundry.
  const jobRoles = [...bicep.matchAll(/principalId: job\.identity\.principalId[\s\S]*?roles\.(\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(jobRoles.sort(), ["apiManagementServiceContributor", "keyVaultSecretsOfficer"]);
  assert.match(bicep, /scope: workspace\n\s+name: guid\(workspace\.id, app\.id, roles\.logAnalyticsDataReader\)/);
  assert.match(bicep, /scope: foundry\n\s+name: guid\(foundry\.id, app\.id, roles\.reader\)/);
  assert.match(bicep, /scope: registry\n\s+name: guid\(registry\.id, pullIdentity\.id/);
  assert.ok(!/Owner|'8e3af657|b24988ac/.test(bicep), "no Owner or Contributor");
  assert.ok(!/passwordSecretRef|adminUserEnabled: true/.test(bicep), "no registry admin credentials");
});

test("console image: distroless Node 24, non-root, runs the console entry point, carries the pack template", () => {
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/azurelinux\/distroless\/nodejs:24-nonroot$/m);
  assert.match(dockerfile, /^USER nonroot$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node"\]$/m);
  assert.match(dockerfile, /^CMD \["src\/console\/main\.mjs"\]$/m);
  assert.match(dockerfile, /COPY poc\/products-keyvault\/infra\/product-policy\.xml/);
});

test("console infra (Container Apps): one allowed IP, a cron job for the automation, no in-process sweep", () => {
  // Optional: no CIDR means no IP rule (owner's decision 2026-10-23); sign-in still applies.
  assert.match(bicep, /ipSecurityRestrictions: empty\(allowedCidr\) \? \[\] : \[\n\s+\{ name: 'allowed-ip', ipAddressRange: allowedCidr, action: 'Allow' \}\n\s+\]/);
  assert.match(bicep, /param allowedCidr string = ''/);
  assert.match(bicep, /resource job 'Microsoft\.App\/jobs@/);
  assert.match(bicep, /triggerType: 'Schedule'/);
  assert.match(bicep, /cronExpression: automationCron/);
  assert.match(bicep, /command: \[ 'node', 'src\/console\/automation\.mjs' \]/);
  assert.match(bicep, /name: 'ROTATION_SWEEP_MINUTES', value: '0'/);
  assert.match(bicep, /name: 'FOUNDRY_ACCOUNT_ID', value: foundry\.id/);
  assert.match(bicep, /name: 'LOG_WORKSPACE_ID', value: workspace\.properties\.customerId/);
});

test("deploy script: assignment required, ID-token sign-in, admin-less registry, nothing secret printed", () => {
  assert.match(deploy, /appRoleAssignmentRequired=true/);
  assert.match(deploy, /--enable-id-token-issuance true/);
  assert.match(deploy, /Console\.Admin/);
  // Admin-only (ADR-0016): -Admins adds more admins; nobody is given Console.User.
  assert.match(deploy, /\[string\[\]\]\$Admins = @\(\)/);
  assert.doesNotMatch(deploy, /\$Users\b/);
  assert.doesNotMatch(deploy, /Grant-ConsoleRole[^\n]*'Console\.User'/);
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

const appsvc = read("infra/console-appservice.bicep");
const fnPkg = JSON.parse(read("functions/package.json"));
const fnHost = JSON.parse(read("functions/host.json"));
const fnCode = read("functions/sweep.mjs");

test("console infra (App Service): web app and Function App on one plan, VNet-integrated, single IP on app and scm", () => {
  assert.match(appsvc, /resource plan 'Microsoft\.Web\/serverfarms@/);
  assert.equal((appsvc.match(/serverFarmId: plan\.id/g) ?? []).length, 2, "both sites on the one plan");
  assert.equal((appsvc.match(/virtualNetworkSubnetId: subnet\.id/g) ?? []).length, 2);
  assert.match(appsvc, /serviceName: 'Microsoft\.Web\/serverFarms'/);
  for (const s of ["httpsOnly: true", "scmIpSecurityRestrictionsUseMain: true",
    "ftpsState: 'Disabled'", "minTlsVersion: '1.2'", "alwaysOn: true", "vnetRouteAllEnabled: true"]) {
    assert.equal(appsvc.split(s).length - 1, 2, `${s} on both sites`);
  }
  assert.equal((appsvc.match(/ipAddress: allowedCidr/g) ?? []).length, 1, "one rule");
  assert.equal((appsvc.match(/ipSecurityRestrictions: ipRules/g) ?? []).length, 2, "used by both sites");
  assert.equal((appsvc.match(/ipSecurityRestrictionsDefaultAction: empty\(allowedCidr\) \? 'Allow' : 'Deny'/g) ?? []).length, 2, "deny by default only when an address is given");
  assert.match(appsvc, /var ipRules = empty\(allowedCidr\) \? \[\] : \[/);
  assert.equal((appsvc.match(/basicPublishingCredentialsPolicies/g) ?? []).length, 4, "ftp and scm basic auth off on both sites");
  assert.match(appsvc, /linuxFxVersion: 'NODE\|24-lts'/);
});

test("console infra (App Service): platform sign-in on the dashboard, identity-only storage for the Function App", () => {
  assert.match(appsvc, /config@[\d-]+' = \{\n\s+parent: web\n\s+name: 'authsettingsV2'/);
  assert.match(appsvc, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(appsvc, /excludedPaths: \[ '\/healthz' \]/);
  assert.ok(!/clientSecret/i.test(code(appsvc)), "no client secret setting");
  assert.match(appsvc, /allowSharedKeyAccess: false/);
  assert.match(appsvc, /name: 'AzureWebJobsStorage__accountName'/);
  assert.ok(!/AccountKey=|listKeys\(/.test(appsvc), "no storage keys");
  assert.match(appsvc, /name: 'ROTATION_SWEEP_MINUTES', value: '0'/);
  const roles = [...new Set([...appsvc.matchAll(/roles\.(\w+)\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(roles, ["apiManagementServiceContributor", "keyVaultCryptoOfficer", "keyVaultSecretsOfficer", "logAnalyticsDataReader",
    "reader", "storageBlobDataOwner", "storageQueueDataContributor", "storageTableDataContributor"]);
  assert.ok(!/Owner'|'8e3af657|b24988ac/.test(appsvc), "no Owner or Contributor");
});

test("function app: v4 Node model, a timer that runs the shared automation, no HTTP trigger", () => {
  assert.equal(fnPkg.type, "module");
  assert.equal(fnPkg.main, "functions/sweep.mjs");
  assert.match(fnPkg.dependencies["@azure/functions"], /^\d+\.\d+\.\d+$/, "pinned exactly");
  assert.equal(fnHost.version, "2.0");
  assert.match(fnCode, /app\.timer\('sweep', \{\s*schedule: '0 \*\/15 \* \* \* \*'/);
  assert.match(fnCode, /runOnce/);
  assert.doesNotMatch(fnCode, /app\.http/);
});

test("deploy script: the hosting is chosen at install and only that path is deployed; one IPv4 is required", () => {
  assert.match(deploy, /\[ValidateSet\('ContainerApps', 'AppService'\)\]\[string\]\$Hosting = 'ContainerApps'/);
  assert.match(deploy, /\[string\]\$AllowedIp = ''/);
  assert.doesNotMatch(deploy, /\[Parameter\(Mandatory\)\]\[string\]\$AllowedIp/);
  assert.match(deploy, /\[System\.Net\.IPAddress\]::TryParse/);
  assert.match(deploy, /prefix -lt 24/, "a CIDR, when given for a NAT pool, is at most a /24");
  assert.match(deploy, /allowedCidr=\$allowedCidr/);
  assert.match(deploy, /if \(\$Hosting -eq 'AppService'\)/);
  assert.match(deploy, /infra\/console-appservice\.bicep/);
  assert.match(deploy, /infra\/console\.bicep/);
  assert.match(deploy, /(Invoke-Az|az) webapp deploy/);
  assert.match(deploy, /(Invoke-Az|az) functionapp deployment source config-zip/);
  assert.match(deploy, /npm ci --omit=dev|npm install --omit=dev/);
});
test("usage telemetry: metrics on the POC routes, no headers or bodies logged", () => {
  const tel = read("infra/console-telemetry.bicep");
  assert.match(tel, /metrics: true/);
  assert.match(tel, /headers: \[\]/);
  assert.match(tel, /body: \{ bytes: 0 \}/);
  assert.match(tel, /frontend: \{ request: noPayload, response: noPayload \}/);
  assert.match(tel, /backend: \{ request: noPayload, response: noPayload \}/);
  assert.match(deploy, /infra\/console-telemetry\.bicep/);
});
test("deploy script: refuses to run when the active tenant is not the subscription's, before any Entra change", () => {
  // `az ad` and Graph calls use the CLI's active account, not --subscription. On a shared machine
  // another process can switch it, and the app registration would be made in the wrong tenant.
  const guard = deploy.indexOf("Assert-SameTenant");
  assert.ok(guard > 0, "a tenant guard exists");
  assert.match(deploy, /az account show --subscription \$Subscription --query tenantId/);
  assert.match(deploy, /az account show --query tenantId/);
  const firstAd = deploy.search(/Invoke-Az ad /);
  assert.ok(deploy.indexOf("Assert-SameTenant\n") < firstAd || deploy.indexOf("Assert-SameTenant\r\n") < firstAd, "guard runs before the first az ad call");
});

test("deploy script: fails when the dashboard never answers /healthz, instead of reporting success", () => {
  assert.match(deploy, /\$healthy = \$false/);
  assert.match(deploy, /if \(-not \$healthy\) \{ throw/);
});
