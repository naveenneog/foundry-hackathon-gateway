import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The model picker lists the deployments of the Foundry account the gateway uses, and no other.
 *
 * It listed every account in the subscription. The gateway reaches exactly one account - both
 * routes point at it - so every other row was a deployment that would 404 if pinned, kept in the
 * list behind a "Pin it anyway?" prompt. Reported from a real run: after choosing the
 * subscription and the account, the picker showed 54 deployments across four accounts.
 *
 * These drive the real functions in scripts/Models.ps1 with `az` replaced by a stub, so what is
 * tested is the code an operator runs, not a JavaScript copy of it.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

const pwsh = (() => {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  }
  return null;
})();

const dep = (name, model, format) => ({
  name,
  properties: { model: { name: model, format, version: "1" }, provisioningState: "Succeeded" },
});

// Two accounts in one subscription. Names unique to account B make a leak unambiguous.
const ACCOUNTS = [
  { name: "acct-a", resourceGroup: "rg-a", location: "eastus2", kind: "AIServices" },
  { name: "acct-b", resourceGroup: "rg-b", location: "eastus2", kind: "AIServices" },
];
const DEPLOYMENTS = {
  "acct-a": [dep("claude-sonnet-5", "claude-sonnet-5", "Anthropic"), dep("deepseek-v4-flash", "DeepSeek-V4-Flash", "DeepSeek")],
  "acct-b": [dep("gpt-4o-only-in-b", "gpt-4o", "OpenAI"), dep("claude-opus-only-in-b", "claude-opus-5", "Anthropic")],
};
const ONLY_IN_B = /gpt-4o-only-in-b|claude-opus-only-in-b/;

/**
 * Run a scenario against scripts/Models.ps1.
 * answers: what Read-Default returns, in order; '<default>' returns the prompt's default.
 */
const scenario = ({ account = "", resourceGroup = "", pins = [], answers = [], call }) => {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(join(root, "scripts", "Models.ps1"))}

$global:Accounts = ${q(JSON.stringify(ACCOUNTS))} | ConvertFrom-Json
$global:Deps = ${q(JSON.stringify(DEPLOYMENTS))} | ConvertFrom-Json
function az {
    $a = @($args); $line = $a -join ' '; $global:LASTEXITCODE = 0
    $n = if ($a -contains '-n') { $a[[array]::IndexOf($a, '-n') + 1] } else { $null }
    if ($line -like 'cognitiveservices account list*') { return ($global:Accounts | ConvertTo-Json -Depth 8 -AsArray) }
    if ($line -like 'cognitiveservices account show*') {
        $hit = @($global:Accounts | Where-Object { $_.name -eq $n })
        if ($hit.Count -eq 0) { $global:LASTEXITCODE = 3; return }
        return ($hit[0] | ConvertTo-Json -Depth 8)
    }
    if ($line -like 'cognitiveservices account deployment list*') { return (@($global:Deps.$n) | ConvertTo-Json -Depth 8 -AsArray) }
    throw "unexpected az call: $line"
}
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
    Write-Host "? $Prompt -> $v"
    if ($v -eq '<default>') { return $Default }
    return $v
}
function Confirm-Action($Prompt) { Write-Host "? $Prompt -> y"; return $true }
$global:State = [pscustomobject]@{
    foundryAccount = ${q(account)}; foundryResourceGroup = ${q(resourceGroup)}; apimName = $null
    models = @(${q(JSON.stringify(pins))} | ConvertFrom-Json)
}
function Get-State { return $global:State }
function Save-State($s) { Write-Host "SAVED account=$($s.foundryAccount) rg=$($s.foundryResourceGroup) pins=$((@($s.models) | ForEach-Object { $_.deployment }) -join ',')" }

${call}
`;
  return spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
};

describe("the model picker is scoped to the gateway's Foundry account", () => {
  before(() => {
    assert.ok(pwsh, "PowerShell 7+ is required to run this test and was not found on PATH");
  });

  test("with an account chosen, the pin picker lists only that account's deployments", () => {
    // a = list, '' = not a number (back to the menu), q = cancel
    const r = scenario({ account: "acct-a", resourceGroup: "rg-a", answers: ["a", "", "q"], call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /claude-sonnet-5/);
    assert.match(r.stdout, /deepseek-v4-flash/);
    assert.doesNotMatch(r.stdout, ONLY_IN_B, "deployments from another account were offered for pinning");
  });

  test("option 2 lists only the chosen account's deployments", () => {
    const r = scenario({ account: "acct-a", resourceGroup: "rg-a", call: "Show-Models" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /deepseek-v4-flash/);
    assert.doesNotMatch(r.stdout, ONLY_IN_B, "option 2 listed deployments from another account");
  });

  test("a pin whose deployment is in a different account is reported missing, not ok", () => {
    // The gateway cannot reach it, so "ok" would be a lie. Matching on the name across the whole
    // subscription is how it used to pass.
    const pins = [{ alias: "gpt", deployment: "gpt-4o-only-in-b", route: "openai" }];
    const r = scenario({ account: "acct-a", resourceGroup: "rg-a", pins, call: "Show-Models" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const line = r.stdout.split(/\r?\n/).find((l) => l.includes("gpt-4o-only-in-b"));
    assert.ok(line, "the pin was not shown at all");
    assert.match(line, /MISSING/, `expected MISSING, got: ${line}`);
  });

  test("with no account chosen, the picker asks for one first and lists only that one", () => {
    // 2 = acct-b, a = list, 1 = first row, alias = suggested, s = save
    const r = scenario({ answers: ["2", "a", "1", "<default>", "s"], call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /acct-a/, "the accounts were not offered");
    const listing = r.stdout.slice(r.stdout.indexOf("? Action -> a"));
    assert.doesNotMatch(listing, /claude-sonnet-5|deepseek-v4-flash/, "acct-a deployments were listed after choosing acct-b");
    assert.match(r.stdout, /SAVED account=acct-b rg=rg-b pins=gpt-4o-only-in-b/);
  });

  test("an account with no deployments says so and pins nothing", () => {
    const r = scenario({ account: "acct-empty", resourceGroup: "rg-x", call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.doesNotMatch(r.stdout, /SAVED/);
    assert.match(r.stdout, /acct-empty/, "the message does not name the account it looked in");
  });
});
