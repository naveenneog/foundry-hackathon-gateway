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
 * tested is the code an operator runs, not a JavaScript copy of it. The stub checks the resource
 * group as az does, and state goes through JSON on every save and load as it does on disk.
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

// Three accounts in one subscription. Names unique to account B make a leak unambiguous;
// acct-empty exists and has no deployments.
const ACCOUNTS = [
  { name: "acct-a", resourceGroup: "rg-a", location: "eastus2", kind: "AIServices" },
  { name: "acct-b", resourceGroup: "rg-b", location: "eastus2", kind: "AIServices" },
  { name: "acct-empty", resourceGroup: "rg-e", location: "eastus2", kind: "AIServices" },
];
const DEPLOYMENTS = {
  "acct-a": [dep("claude-sonnet-5", "claude-sonnet-5", "Anthropic"), dep("deepseek-v4-flash", "DeepSeek-V4-Flash", "DeepSeek")],
  "acct-b": [dep("gpt-4o-only-in-b", "gpt-4o", "OpenAI"), dep("claude-opus-only-in-b", "claude-opus-5", "Anthropic")],
  "acct-empty": [],
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
    $g = if ($a -contains '-g') { $a[[array]::IndexOf($a, '-g') + 1] } else { $null }
    if ($line -like 'cognitiveservices account list*') { return ($global:Accounts | ConvertTo-Json -Depth 8 -AsArray) }
    # Like az: an account is found only in the resource group it is in, and a failure prints
    # nothing on stdout.
    $hit = @($global:Accounts | Where-Object { $_.name -eq $n -and $_.resourceGroup -eq $g })
    if ($line -like 'cognitiveservices account show*') {
        if ($hit.Count -eq 0) { $global:LASTEXITCODE = 3; return }
        return ($hit[0] | ConvertTo-Json -Depth 8)
    }
    if ($line -like 'cognitiveservices account deployment list*') {
        if ($hit.Count -eq 0) { $global:LASTEXITCODE = 3; return }
        $d = @($global:Deps.$n)
        if ($d.Count -eq 0) { return '[]' }
        return ($d | ConvertTo-Json -Depth 8 -AsArray)
    }
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

# State goes through JSON on every save and load, as it does on disk, so a change held only in
# memory is not mistaken for a saved one.
$global:Disk = [pscustomobject]@{
    foundryAccount = ${q(account)}; foundryResourceGroup = ${q(resourceGroup)}; apimName = $null
    models = @(${q(JSON.stringify(pins))} | ConvertFrom-Json)
} | ConvertTo-Json -Depth 8
function Get-State { return ($global:Disk | ConvertFrom-Json) }
function Save-State($s) {
    $global:Disk = $s | ConvertTo-Json -Depth 8
    Write-Host "SAVED account=$($s.foundryAccount) rg=$($s.foundryResourceGroup) pins=$((@($s.models) | ForEach-Object { $_.deployment }) -join ',')"
}

${call}
`;
  return spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
};

/** The output after a marker, failing if the marker is missing rather than searching nothing. */
const after = (stdout, marker) => {
  const i = stdout.indexOf(marker);
  assert.ok(i >= 0, `expected '${marker}' in the output:\n${stdout}`);
  return stdout.slice(i);
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

  test("the pin editor marks a current pin that is not in the account", () => {
    // A state file from before scoping can hold pins from another account. They are kept - the
    // operator decides - but not shown as if they work.
    const pins = [{ alias: "gpt", deployment: "gpt-4o-only-in-b", route: "openai" }];
    const r = scenario({ account: "acct-a", resourceGroup: "rg-a", pins, answers: ["q"], call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const line = after(r.stdout, "Current pins").split(/\r?\n/).find((l) => l.includes("gpt-4o-only-in-b"));
    assert.ok(line, "the pin was not shown");
    assert.match(line, /MISSING in acct-a/, `expected the pin to be marked, got: ${line}`);
  });

  test("with no account chosen, the picker asks for one first and lists only that one", () => {
    // 2 = acct-b, a = list, 1 = first row, alias = suggested, s = save
    const r = scenario({ answers: ["2", "a", "1", "<default>", "s"], call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /\[1\] acct-a/, "the accounts were not offered");
    assert.doesNotMatch(after(r.stdout, "? Action -> a"), /claude-sonnet-5|deepseek-v4-flash/, "acct-a deployments were listed after choosing acct-b");
    assert.match(r.stdout, /SAVED account=acct-b rg=rg-b pins=gpt-4o-only-in-b/);
  });

  test("an account chosen in option 3 is kept even when nothing is pinned", () => {
    // Option 4 deploys a model into the chosen account. When option 3 held the choice only in
    // memory, an empty account sent the operator to option 4, which then had no account.
    const r = scenario({ answers: ["3"], call: "Edit-ModelPins; $s = Get-State; \"DISK account=$($s.foundryAccount) rg=$($s.foundryResourceGroup)\"" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /DISK account=acct-empty rg=rg-e/);
  });

  test("an account with no deployments says so and pins nothing", () => {
    const r = scenario({ account: "acct-empty", resourceGroup: "rg-e", call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /No model deployments were found in 'acct-empty'/);
    assert.doesNotMatch(r.stdout, /unroutable|SAVED/);
  });

  test("an account recorded with the wrong resource group is found, not reported empty", () => {
    // Scoping made the resource group matter: `account show -n acct-b -g rg-a` fails, and an
    // empty list read as "no deployments" for an account that has two.
    const r = scenario({ account: "acct-b", resourceGroup: "rg-a", answers: ["a", "", "q"], call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.doesNotMatch(r.stdout, /No model deployments/);
    assert.match(r.stdout, /gpt-4o-only-in-b/);
    assert.match(r.stdout, /rg-b/, "the operator was not told where the account actually is");
  });

  test("an account that is not in the subscription is reported as not found, not as empty", () => {
    const r = scenario({ account: "acct-gone", resourceGroup: "rg-x", call: "Edit-ModelPins" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /'acct-gone' was not found/);
    assert.doesNotMatch(r.stdout, /No model deployments/);
  });
});

describe("option 1 records the account where it actually is", () => {
  const read = "$s = Get-State; $ok = Read-FoundryAccount -State $s; \"RESULT ok=$ok account=$($s.foundryAccount) rg=$($s.foundryResourceGroup)\"";

  test("typing another account name takes that account's resource group", () => {
    // The resource-group prompt used to default to the previous account's group, so changing
    // account in option 1 recorded a pair that does not exist.
    const r = scenario({ account: "acct-a", resourceGroup: "rg-a", answers: ["acct-b", "<default>"], call: read });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /RESULT ok=True account=acct-b rg=rg-b/);
  });

  test("a recorded account that no longer exists offers the list again", () => {
    const r = scenario({ account: "acct-gone", resourceGroup: "rg-x", answers: ["2", "<default>", "<default>"], call: read });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /'acct-gone' was not found/);
    assert.match(r.stdout, /RESULT ok=True account=acct-b rg=rg-b/);
  });

  test("an empty account name stops rather than carrying on with none", () => {
    // x = not a number at the list, then Enter at the name prompt, whose default is empty.
    const r = scenario({ answers: ["x", "<default>"], call: read });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /RESULT ok=False/);
  });
});
