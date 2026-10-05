import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a deployment is given, checked without deploying.
 *
 * Reported from a real run on 2026-10-05: with three Claude models pinned and nothing on the
 * OpenAI route, option 1 failed with "NamedValue Value should be between 1 and 4096 characters
 * long" on hackgw-model-map. The OpenAI map was written as an empty string. The Claude map had a
 * guard that wrote EMPTY_MAP (';') instead; the OpenAI map never needed one while every install
 * defaulted to DeepSeek pins. A deployment is all-or-nothing, so the one rejected named value
 * stopped the policies from being applied and left the new route ungoverned.
 *
 * These call the real New-DeploymentParameters from scripts/Apim.ps1.
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

/** The parameters New-DeploymentParameters produces for these pins. */
const parametersFor = (pins) => {
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(join(root, "scripts", "Models.ps1"))}
. ${q(join(root, "scripts", "Apim.ps1"))}
# The console's own helper, taken from admin.ps1 rather than rewritten here.
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "admin.ps1"))}, [ref]$null, [ref]$null)
foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Coalesce' }, $true)) {
    . ([scriptblock]::Create($f.Extent.Text))
}
function Write-Warn($t) { Write-Host "[!] $t" }
$state = [pscustomobject]@{
    foundryAccount = 'acct'; foundryResourceGroup = 'rg'; existingApimName = 'apim'
    models = @(${q(JSON.stringify(pins))} | ConvertFrom-Json)
}
$p = New-DeploymentParameters -State $state -Email 'ops@example.com' -Secret ([guid]::NewGuid().ToString()) \`
    -DeployClaude $true -ClaudePath 'claude' -GrantRole $true -Revoked ','
'PARAMS ' + ($p.parameters | ConvertTo-Json -Depth 5 -Compress)
`;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("PARAMS "));
  assert.ok(line, `no parameters were produced:\n${r.stdout}`);
  return JSON.parse(line.slice("PARAMS ".length));
};

const claude = (alias, deployment) => ({ alias, deployment, route: "claude" });
const openai = (alias, deployment) => ({ alias, deployment, route: "openai" });

describe("a deployment is never given an empty named value", () => {
  before(() => {
    assert.ok(pwsh, "PowerShell 7+ is required to run this test and was not found on PATH");
  });

  test("only Claude models pinned: the OpenAI map is EMPTY_MAP, not an empty string", () => {
    // The pins from the failed run.
    const p = parametersFor([
      claude("sonnet-5", "claude-sonnet-5"),
      claude("opus-5-5", "claude-opus-5-5"),
      claude("haiku-4-5", "claude-haiku-4-5"),
    ]);
    assert.equal(p.modelMap.value, ";", "the OpenAI map is empty, which APIM rejects and which fails the whole deployment");
    assert.equal(p.claudeModelMap.value, "sonnet-5=claude-sonnet-5;opus-5-5=claude-opus-5-5;haiku-4-5=claude-haiku-4-5");
  });

  test("only OpenAI models pinned: the Claude map is EMPTY_MAP", () => {
    const p = parametersFor([openai("flash", "deepseek-v4-flash")]);
    assert.equal(p.claudeModelMap.value, ";");
    assert.equal(p.modelMap.value, "flash=deepseek-v4-flash");
  });

  test("nothing pinned at all: both maps are EMPTY_MAP", () => {
    const p = parametersFor([]);
    assert.equal(p.modelMap.value, ";");
    assert.equal(p.claudeModelMap.value, ";");
  });

  test("both model maps are non-empty, whatever is pinned", () => {
    // Only the maps are computed here. revokedKeys and signingKey are inputs to this function,
    // so checking them here would pass whatever Invoke-Deploy does.
    for (const pins of [[], [claude("sonnet-5", "claude-sonnet-5")], [openai("flash", "deepseek-v4-flash")]]) {
      const p = parametersFor(pins);
      for (const name of ["modelMap", "claudeModelMap"]) {
        assert.ok(String(p[name]?.value ?? "").length > 0, `${name} is empty for pins ${JSON.stringify(pins)}`);
      }
    }
  });

  test("option 1 builds its parameters through New-DeploymentParameters, and nowhere else", () => {
    // The tests above call the function directly. Without this, an inline parameter table
    // coming back into Invoke-Deploy would bring the bug back with every test still green.
    const script = `
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "admin.ps1"))}, [ref]$null, [ref]$null)
$deploy = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Invoke-Deploy' }, $true) | Select-Object -First 1
$calls = @($deploy.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] -and $args[0].GetCommandName() -eq 'New-DeploymentParameters' }, $true)).Count
$inline = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.HashtableAst] -and @($args[0].KeyValuePairs | Where-Object { $_.Item1.Extent.Text -in @('modelMap', 'claudeModelMap') }).Count -gt 0 }, $true)).Count
"CALLS $calls INLINE $inline"
`;
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CALLS 1 INLINE 0/, `Invoke-Deploy must call New-DeploymentParameters once and admin.ps1 must not build the map parameters itself: ${r.stdout}`);
  });
});

describe("the template never writes an empty model map, whatever it is given", () => {
  // Defence in depth for anyone deploying infra/main.bicep directly rather than through
  // option 1: the same rejection would otherwise fail their deployment too.
  const bicep = readFileSync(join(root, "infra", "main.bicep"), "utf8");

  for (const [key, param] of [["hackgw-model-map", "modelMap"], ["hackgw-claude-model-map", "claudeModelMap"]]) {
    test(`${key} falls back to EMPTY_MAP when ${param} is empty`, () => {
      const line = bicep.split(/\r?\n/).find((l) => l.includes(`key: '${key}'`));
      assert.ok(line, `${key} is not declared in infra/main.bicep`);
      assert.match(
        line,
        new RegExp(`value:\\s*empty\\(${param}\\)\\s*\\?\\s*';'\\s*:\\s*${param}\\b`),
        `${key} can be written empty: ${line.trim()}`
      );
    });
  }

  test("the OpenAI map's default does not name deployments that may not exist", () => {
    // Pins start empty (P25). A default naming two DeepSeek deployments deployed a gateway
    // pointing at models that may not be there.
    const m = bicep.match(/param modelMap string = '([^']*)'/);
    assert.ok(m, "param modelMap has no default");
    assert.equal(m[1], ";");
  });
});
