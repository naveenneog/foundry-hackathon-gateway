// Shared by the poc-products-keyvault*.test.mjs suites: the proof of concept's paths, and
// PowerShell runners that replace Azure with stubs. Not a test file itself.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const poc = join(root, "poc", "products-keyvault");
export const read = (...p) => readFileSync(join(poc, ...p), "utf8");
export const inboundOf = (xml) =>
  xml.slice(xml.indexOf("<inbound>"), xml.indexOf("</inbound>")).replace(/<!--[\s\S]*?-->/g, "");

export const pwsh = (() => {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  }
  return null;
})();
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Run PocKeys.ps1 functions with `az` and Invoke-RestMethod stubbed. `responses` are matched in
 * order by method and a regex on the URI. Returns the script's own output and, separately, every
 * HTTP call it made, so a test can assert both on what was sent and on what was printed.
 */
export const runKeys = ({ responses, call, tokenLifetime = 3600 }) => {
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(join(poc, "scripts", "PocKeys.ps1"))}
. ${q(join(poc, "scripts", "PocMeasure.ps1"))}
$global:TokenFetches = 0
function az {
    $line = @($args) -join ' '; $global:LASTEXITCODE = 0
    if ($line -like 'account show*') { return 'sub-123' }
    if ($line -like 'account get-access-token*') {
        $global:TokenFetches++
        return (@{ accessToken = 'TOKEN'; expires_on = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + ${tokenLifetime} } | ConvertTo-Json -Compress)
    }
    throw "unexpected az call: $line"
}
$global:Calls = [System.Collections.Generic.List[object]]::new()
$global:Responses = @(${q(JSON.stringify(responses))} | ConvertFrom-Json)
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $Body, $ContentType)
    $global:Calls.Add([pscustomobject]@{ method = "$Method"; uri = "$Uri"; body = $Body; auth = $Headers.Authorization; ifMatch = $Headers['If-Match'] })
    foreach ($r in $global:Responses) {
        if ("$Method" -eq $r.method -and "$Uri" -match $r.match) {
            if ($r.error) { throw $r.error }
            return $r.body
        }
    }
    throw "unexpected call: $Method $Uri"
}
$failed = $null
try {
    $ctx = New-PocContext -Subscription 'sub-name' -ResourceGroup 'rg-x' -ApimName 'apim-x' -VaultName 'kv-x'
    ${call}
} catch { $failed = $_.Exception.Message }
"=== CALLS"
foreach ($c in $global:Calls) { $c | ConvertTo-Json -Compress -Depth 8 }
"=== FAILED $failed"
`;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [own = "", rest = ""] = String(r.stdout).split("=== CALLS");
  const [callText = "", failed = ""] = rest.split("=== FAILED");
  const calls = callText.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  for (const c of calls) if (typeof c.body === "string" && c.body.trim().startsWith("{")) c.body = JSON.parse(c.body);
  return { ...r, own, calls, failed: failed.trim() };
};

/**
 * Run a whole script with `az` and Invoke-RestMethod stubbed. `az` rules match the joined
 * arguments in order ({ match, out, exit }); any other az call succeeds with no output. A file
 * passed to az as @path (a Run Command script) is recorded. Returns the output, the script's
 * exit code, a terminating error if any, and every az and HTTP call.
 */
export const runScript = ({ file, args, az = [], responses = [] }) => {
  const script = `
$ErrorActionPreference = 'Stop'
$global:AzCalls = [System.Collections.Generic.List[string]]::new()
$global:AzScripts = [System.Collections.Generic.List[string]]::new()
$global:AzRules = @(${q(JSON.stringify(az))} | ConvertFrom-Json)
function az {
    $line = @($args) -join ' '
    $global:LASTEXITCODE = 0
    if ($line -like 'account show*') { return '00000000-0000-0000-0000-000000000123' }
    if ($line -like 'account get-access-token*') { return (@{ accessToken = 'TOKEN'; expires_on = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600 } | ConvertTo-Json -Compress) }
    $global:AzCalls.Add($line)
    foreach ($a in $args) { if ("$a" -like '@*' -and (Test-Path -LiteralPath "$a".Substring(1))) { $global:AzScripts.Add((Get-Content -Raw -LiteralPath "$a".Substring(1))) } }
    foreach ($r in $global:AzRules) { if ($line -match $r.match) { $global:LASTEXITCODE = [int]$r.exit; return $r.out } }
}
$global:Calls = [System.Collections.Generic.List[object]]::new()
$global:Responses = @(${q(JSON.stringify(responses))} | ConvertFrom-Json)
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $Body, $ContentType)
    $global:Calls.Add([pscustomobject]@{ method = "$Method"; uri = "$Uri" })
    foreach ($r in $global:Responses) {
        if ("$Method" -eq $r.method -and "$Uri" -match $r.match) {
            if ($r.error) { throw $r.error }
            return $r.body
        }
    }
    throw "unexpected call: $Method $Uri"
}
$failed = ''
$global:LASTEXITCODE = 0
try { & ${q(file)} ${args} } catch { $failed = $_.Exception.Message }
"=== EXIT $LASTEXITCODE"
"=== FAILED $failed"
"=== AZ"
foreach ($c in $global:AzCalls) { "AZ $c" }
"=== SCRIPTS"
foreach ($s in $global:AzScripts) { $s | ConvertTo-Json -Compress }
"=== HTTP"
foreach ($c in $global:Calls) { "HTTP $($c.method) $($c.uri)" }
`;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const out = String(r.stdout);
  const section = (name) => (out.split(`=== ${name}`)[1] || "").split("=== ")[0];
  return {
    own: out.split("=== EXIT")[0],
    exit: Number((out.match(/=== EXIT (\d+)/) || [])[1]),
    failed: (out.match(/=== FAILED (.*)/) || [])[1]?.trim() || "",
    az: [...section("AZ").matchAll(/^AZ (.*)$/gm)].map((m) => m[1].trim()),
    scripts: section("SCRIPTS").split(/\r?\n/).filter((l) => l.startsWith('"')).map((l) => JSON.parse(l)),
    http: [...section("HTTP").matchAll(/^HTTP (\S+) (\S+)$/gm)].map((m) => `${m[1]} ${m[2]}`),
    stderr: String(r.stderr),
  };
};
