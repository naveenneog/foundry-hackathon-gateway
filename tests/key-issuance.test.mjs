import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Key issuance as the operator runs it: scripts/Keys.ps1, scripts/Apim.ps1 and the state
 * functions from admin.ps1, with `az` replaced by a stub and every file written to a scratch
 * directory. Tokens are minted by the real scripts/mint.mjs with a throwaway secret.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

const pwsh = (() => {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  }
  return null;
})();

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const scratch = [];

const BASE_STATE = {
  apimName: "apim-x",
  existingApimName: "apim-x",
  resourceGroup: "rg-x",
  gatewayUrl: "https://apim-x.azure-api.net/v1",
  claudeGatewayUrl: "https://apim-x.azure-api.net/claude-hackgw",
  models: [
    { alias: "flash", deployment: "deepseek-v4-flash", route: "openai" },
    { alias: "sonnet-5", deployment: "claude-sonnet-5", route: "claude" },
  ],
};

const BUILT_IN = { type: "Proxy", hostName: "apim-x.azure-api.net", certificateSource: "BuiltIn", defaultSslBinding: false };
const CUSTOM = { type: "Proxy", hostName: "ai.contoso.invalid", certificateSource: "Managed", defaultSslBinding: true };

/**
 * Run a scenario. `apim` is what `az apim show` returns (null = the call fails); `answers` feed
 * Read-Default in order ('<default>' takes the prompt's default).
 */
const run = ({ state = BASE_STATE, apim = { name: "apim-x", hostnameConfigurations: [BUILT_IN] }, answers = [], call }) => {
  const dir = mkdtempSync(join(tmpdir(), "fhg-keys-"));
  scratch.push(dir);
  const script = `
$ErrorActionPreference = 'Stop'
$script:Root        = ${q(root)}
$script:StateDir    = ${q(join(dir, ".gateway"))}
$script:KeysPath    = Join-Path $script:StateDir 'issued-keys.json'
$script:ArchivePath = Join-Path $script:StateDir 'issued-keys-archive.json'
$script:HandoutsDir = ${q(join(dir, "handouts"))}

# The console's own state helpers, taken from admin.ps1 rather than rewritten here.
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "admin.ps1"))}, [ref]$null, [ref]$null)
$want = 'Coalesce', 'ConvertTo-Dto', 'Initialize-StateDir', 'Get-IssuedKeys', 'Save-IssuedKeys', 'Get-ArchivedKeys', 'Save-ArchivedKeys', 'Read-KeyRecords', 'Write-KeyRecords'
foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($want -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
}
. ${q(join(root, "scripts", "Platform.ps1"))}
. ${q(join(root, "scripts", "Apim.ps1"))}
. ${q(join(root, "scripts", "Models.ps1"))}
. ${q(join(root, "scripts", "Keys.ps1"))}

function Write-Head($t) { Write-Host "== $t" }
function Write-Ok($t)   { Write-Host "[ok] $t" }
function Write-Info($t) { Write-Host "     $t" }
function Write-Warn($t) { Write-Host "[!] $t" }
function Write-Err($t)  { Write-Host "[x] $t" }
$global:Answers = [System.Collections.Generic.Queue[string]]::new()
foreach ($x in @(${answers.map(q).join(", ")})) { $global:Answers.Enqueue($x) }
function Read-Default($Prompt, $Default) {
    if ($global:Answers.Count -eq 0) { throw "ran out of answers at prompt: $Prompt" }
    $v = $global:Answers.Dequeue()
    Write-Host "? $Prompt [$Default] -> $v"
    if ($v -eq '<default>') { return $Default }
    return $v
}
function Confirm-Action($Prompt) { Write-Host "? $Prompt -> y"; return $true }

$bytes = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$global:Secret = [Convert]::ToBase64String($bytes)
function Get-SigningSecret { return $global:Secret }

$global:Disk = ${q(JSON.stringify(state))}
function Get-State { return ($global:Disk | ConvertFrom-Json) }
function Save-State($s) { $global:Disk = $s | ConvertTo-Json -Depth 8; Write-Host "SAVED-STATE" }

$global:ApimShow = ${q(apim === null ? "" : JSON.stringify(apim))}
function az {
    $line = @($args) -join ' '; $global:LASTEXITCODE = 0
    if ($line -like 'apim show*') {
        if (-not $global:ApimShow) { $global:LASTEXITCODE = 3; return }
        return $global:ApimShow
    }
    throw "unexpected az call: $line"
}
function Set-GatewayNamedValue { param($Id, $Value, $State) Write-Host "NAMED-VALUE $Id=$Value"; return $true }

${call}
"SECRET-FOR-TEST $global:Secret"
`;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return { ...r, dir };
};

after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

before(() => {
  assert.ok(pwsh, "PowerShell 7+ is required to run this test and was not found on PATH");
});

// Answers for New-ParticipantKey up to the hostname prompt: subject, label, models (all),
// hours, start, budget.
const SINGLE = ["team-x", "", "a", "48", "0", "1000"];

describe("participant base URLs use the gateway's custom domain when it has one", () => {
  test("a custom domain becomes the default host, and each route keeps its own path", () => {
    const r = run({
      apim: { name: "apim-x", hostnameConfigurations: [BUILT_IN, CUSTOM] },
      answers: [...SINGLE, "<default>", "y"],
      call: "New-ParticipantKey",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /OPENAI_BASE_URL=https:\/\/ai\.contoso\.invalid\/v1/);
    assert.match(r.stdout, /ANTHROPIC_BASE_URL=https:\/\/ai\.contoso\.invalid\/claude-hackgw/);

    const readme = readFileSync(join(r.dir, "handouts", "team-x", "README.md"), "utf8");
    assert.match(readme, /https:\/\/ai\.contoso\.invalid\/v1/);
    assert.match(readme, /https:\/\/ai\.contoso\.invalid\/claude-hackgw/);
    assert.doesNotMatch(readme, /azure-api\.net/, "the handout still names the built-in host");
    const settings = JSON.parse(readFileSync(join(r.dir, "handouts", "team-x", ".claude", "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://ai.contoso.invalid/claude-hackgw");
  });

  test("without a custom domain the built-in host is used, as before", () => {
    const r = run({ answers: [...SINGLE, "<default>", "y"], call: "New-ParticipantKey" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /OPENAI_BASE_URL=https:\/\/apim-x\.azure-api\.net\/v1/);
  });

  test("of several custom domains, the default SSL binding is chosen; other hostname types are ignored", () => {
    const r = run({
      apim: {
        name: "apim-x",
        hostnameConfigurations: [
          BUILT_IN,
          { type: "Management", hostName: "mgmt.contoso.invalid", defaultSslBinding: true },
          { type: "Proxy", hostName: "other.contoso.invalid", defaultSslBinding: false },
          CUSTOM,
        ],
      },
      call: "\"HOST [$(Get-GatewayCustomHost -State (Get-State))]\"",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOST \[ai\.contoso\.invalid\]/);
  });

  test("when the instance cannot be read, the built-in host is used", () => {
    const r = run({ apim: null, answers: ["<default>"], call: "\"HOST [$(Read-ParticipantHost -State (Get-State))]\"" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOST \[apim-x\.azure-api\.net\]/);
  });

  test("a hostname typed by the operator is used, accepted as a URL, and offered next time", () => {
    // A front door or application gateway in front of API Management is not visible on the
    // instance, so the operator types it once.
    const r = run({
      answers: ["https://gw.example.invalid/", "<default>"],
      call: "$h1 = Read-ParticipantHost -State (Get-State); $h2 = Read-ParticipantHost -State (Get-State); \"HOSTS [$h1] [$h2]\"; \"URLS $((Get-ParticipantUrls -State (Get-State) -HostName $h1).openai)\"",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOSTS \[gw\.example\.invalid\] \[gw\.example\.invalid\]/);
    assert.match(r.stdout, /URLS https:\/\/gw\.example\.invalid\/v1/);
  });

  test("something that is not a hostname falls back to the built-in host", () => {
    const r = run({ answers: ["not a host!"], call: "\"HOST [$(Read-ParticipantHost -State (Get-State))]\"" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOST \[apim-x\.azure-api\.net\]/);
  });
});
