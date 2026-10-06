import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyKey } from "../src/keys.mjs";

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
const run = ({ state = BASE_STATE, apim = { name: "apim-x", hostnameConfigurations: [BUILT_IN] }, answers = [], keys = null, archive = null, files = {}, call }) => {
  const dir = mkdtempSync(join(tmpdir(), "fhg-keys-"));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // '<DIR>' in an answer stands for the scratch directory, for prompts that take a path.
  answers = answers.map((a) => a.replace("<DIR>", dir));
  const script = `
$ErrorActionPreference = 'Stop'
$script:Root        = ${q(root)}
$script:StateDir    = ${q(join(dir, ".gateway"))}
$script:KeysPath    = Join-Path $script:StateDir 'issued-keys.json'
$script:ArchivePath = Join-Path $script:StateDir 'issued-keys-archive.json'
$script:HandoutsDir = ${q(join(dir, "handouts"))}

# The console's own state helpers, taken from admin.ps1 rather than rewritten here.
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "admin.ps1"))}, [ref]$null, [ref]$null)
$want = 'Coalesce', 'ConvertTo-Dto', 'Initialize-StateDir', 'Get-IssuedKeys', 'Save-IssuedKeys', 'Get-ArchivedKeys', 'Save-ArchivedKeys', 'Read-KeyRecords', 'Write-KeyRecords', 'Test-KeyRecordsFile', 'Show-Keys', 'Revoke-Key'
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

New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
${keys === null ? "" : `Set-Content -Path $script:KeysPath -Value ${q(JSON.stringify(keys))} -Encoding UTF8`}
${archive === null ? "" : typeof archive === "string"
    ? `Set-Content -Path $script:ArchivePath -Value ${q(archive)} -Encoding UTF8 -NoNewline`
    : `Set-Content -Path $script:ArchivePath -Value ${q(JSON.stringify(archive))} -Encoding UTF8`}

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

  test("when the instance cannot be read, the built-in host is used, and the operator is told", () => {
    // A failed read (expired login, wrong subscription) is not the same as "no custom domain".
    const r = run({ apim: null, answers: ["<default>"], call: "\"HOST [$(Read-ParticipantHost -State (Get-State))]\"" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOST \[apim-x\.azure-api\.net\]/);
    assert.match(r.stdout, /\[!\] .*could not be read/i);
  });

  test("a wildcard custom domain is not offered: it is not a hostname a participant can use", () => {
    // Wildcard gateway hostnames are valid in API Management; a base URL needs a concrete one.
    const wildcard = { type: "Proxy", hostName: "*.contoso.invalid", defaultSslBinding: true };
    const r = run({
      apim: { name: "apim-x", hostnameConfigurations: [BUILT_IN, wildcard, { ...CUSTOM, defaultSslBinding: false }] },
      call: "\"HOST [$(Get-GatewayCustomHost -State (Get-State))]\"",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /HOST \[ai\.contoso\.invalid\]/);

    const only = run({ apim: { name: "apim-x", hostnameConfigurations: [BUILT_IN, wildcard] }, call: "\"HOST [$(Get-GatewayCustomHost -State (Get-State))]\"" });
    assert.match(only.stdout, /HOST \[\]/);
  });

  test("a pasted URL's port is not silently dropped", () => {
    const r = run({ answers: ["https://gw.example.invalid:8443/"], call: "\"HOST [$(Read-ParticipantHost -State (Get-State))]\"" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /\[!\] .*8443/);
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

// Records as New-Key writes them: dates in the 'u' format.
const when = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
const HOUR = 3600_000;
const key = (jti, subject, expiresAt, revoked = false) => ({
  jti, subject, label: "", models: "flash", budget: 1000,
  notBefore: when(-48 * HOUR), expiresAt, issuedAt: when(-48 * HOUR), revoked,
});
const LISTS = "\"ISSUED $((@(Get-IssuedKeys) | ForEach-Object { $_.jti }) -join ',')\"; \"ARCHIVED $((@(Get-ArchivedKeys) | ForEach-Object { $_.jti }) -join ',')\"";

describe("expired keys move to an archive and stop showing", () => {
  test("the key list shows current keys; keys long expired move to the archive", () => {
    const r = run({
      keys: [
        key("k-active", "p-active", when(2 * HOUR)),
        key("k-recent", "p-recent", when(-2 * 60_000)),
        key("k-old", "p-old", when(-48 * HOUR)),
        key("k-oldrev", "p-oldrev", when(-24 * HOUR), true),
        key("k-bad", "p-bad", "soon"),
      ],
      call: `Show-Keys; ${LISTS}`,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const listing = r.stdout.slice(0, r.stdout.indexOf("ISSUED "));
    assert.doesNotMatch(listing, /p-old\b|p-oldrev/, "a long-expired key is still listed");
    // Still listed: current, inside the grace period (the gateway allows 60 s of clock skew, so
    // a key is archived only once it is clearly past it), and one whose date cannot be read.
    for (const p of ["p-active", "p-recent", "p-bad"]) assert.match(listing, new RegExp(p));
    assert.match(listing, /2 expired key\(s\) moved to the archive/);
    assert.match(r.stdout, /ISSUED k-active,k-recent,k-bad/);
    assert.match(r.stdout, /ARCHIVED k-old,k-oldrev/);
  });

  test("archiving again does not duplicate a key already in the archive", () => {
    const r = run({
      keys: [key("k-old", "p-old", when(-48 * HOUR)), key("k-old2", "p-old2", when(-48 * HOUR))],
      archive: [key("k-old", "p-old", when(-48 * HOUR))],
      call: `[void](Move-ExpiredKeysToArchive); [void](Move-ExpiredKeysToArchive); ${LISTS}`,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /ISSUED \r?\n/);
    assert.match(r.stdout, /ARCHIVED k-old,k-old2\r?\n/);
  });

  test("an id used only by an archived key still warns that counters are shared", () => {
    // Budget, rate limit and quota are keyed on the subject, so an expired key's spend can
    // count against a new key with the same id. Archiving must not hide that.
    const r = run({
      archive: [key("k-old", "team-old", when(-48 * HOUR))],
      answers: ["n"],
      call: "\"FREE $(Test-SubjectFree 'team-old')\"; \"NEW $(Test-SubjectFree 'team-new')\"",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /FREE False/);
    assert.match(r.stdout, /NEW True/);
    assert.match(r.stdout, /expired/);
  });

  test("bulk issuance sees ids used by archived keys", () => {
    // 1 = numbered teams, 2 keys, prefix 'team', then 2 = cancel at the clash prompt.
    const r = run({
      archive: [key("k-old", "team-01", when(-48 * HOUR))],
      answers: ["1", "2", "team", "2"],
      call: "New-BulkKeys",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /team-01/);
    assert.match(r.stdout, /Cancelled/);
  });

  test("an archive that cannot be read is left alone, and nothing is archived over it", () => {
    // Overwriting it would lose every archived id, and a reused id would then inherit that
    // key's spend without a warning. A hand edit or an interrupted write leaves it like this.
    // (A trailing comma is not one of these cases: ConvertFrom-Json accepts it, and the archive
    // is read and kept.)
    for (const broken of ['[{"jti":"k-a","subject":"team-0', '[{"jti":"k-a" "subject":"team-01"}]', ""]) {
      const r = run({
        keys: [key("k-old", "p-old", when(-48 * HOUR))],
        archive: broken,
        call: `Show-Keys; ${LISTS}; "RAW [$(Get-Content $script:ArchivePath -Raw)]"`,
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /ISSUED k-old/, `an expired key was moved over a broken archive (${JSON.stringify(broken)})`);
      assert.ok(r.stdout.includes(`RAW [${broken}]`), `the broken archive was rewritten (${JSON.stringify(broken)})`);
      assert.match(r.stdout, /\[!\] .*archive/i);
    }
  });

  test("a revocation push keeps unexpired revocations and drops archived ones", () => {
    // Revoke-Key rebuilds the denylist from the current keys. An archived key is past its
    // expiry by more than the gateway's clock skew, so `exp` refuses it on its own.
    const r = run({
      keys: [
        key("k1", "p1", when(1 * HOUR), true),
        key("k2", "p2", when(2 * HOUR)),
        key("k3", "p3", when(-48 * HOUR), true),
      ],
      answers: ["1"],
      call: "Revoke-Key",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("NAMED-VALUE revoked-keys="));
    assert.ok(line, `no denylist was pushed:\n${r.stdout}`);
    assert.match(line, /,k1,/);
    assert.match(line, /,k2,/);
    assert.doesNotMatch(line, /k3/);
  });
});

/** Parse the CSV PowerShell's ConvertTo-Csv writes: every field quoted, quotes doubled. */
const parseCsv = (text) => {
  const rows = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l !== "")) {
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

const batchOf = (dir) => {
  const base = join(dir, "handouts");
  const batch = readdirSync(base).find((d) => d.startsWith("batch-"));
  assert.ok(batch, `no batch folder under ${base}`);
  return join(base, batch);
};

/** True when only the file's owner can read it, judged the way each platform judges it. */
const ownerOnly = (path) => {
  if (process.platform !== "win32") return (statSync(path).mode & 0o077) === 0;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command",
    `$a = Get-Acl -LiteralPath ${q(path)}; $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
     "$($a.AreAccessRulesProtected) $(@($a.Access | Where-Object { $_.IdentityReference.Value -ne $me }).Count)"`], { encoding: "utf8" });
  return r.stdout.trim() === "True 0";
};

const secretOf = (stdout) => stdout.match(/SECRET-FOR-TEST (\S+)/)[1];

// Bulk answers: 1 = numbered teams, 3 keys, prefix 'team'; then key settings (all models, 48 h,
// start now, 1000 tokens) and the hostname prompt.
const BULK = ["1", "3", "team", "a", "48", "0", "1000", "<default>"];

describe("bulk issuance writes the batch's keys to one CSV", () => {
  test("keys.csv has a row per participant with a working key and its base URLs", () => {
    const r = run({ apim: { name: "apim-x", hostnameConfigurations: [BUILT_IN, CUSTOM] }, answers: BULK, call: "New-BulkKeys" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const csvPath = join(batchOf(r.dir), "keys.csv");
    assert.ok(existsSync(csvPath), `keys.csv was not written:\n${r.stdout}`);

    const rows = parseCsv(readFileSync(csvPath, "utf8"));
    assert.deepEqual(rows.map((x) => x.participant), ["team-01", "team-02", "team-03"]);
    const secret = secretOf(r.stdout);
    for (const row of rows) {
      // The key in the file is the one the gateway will accept for that participant.
      const claims = verifyKey(row.key, secret);
      assert.equal(claims.sub, row.participant);
      assert.equal(row.key_id, claims.jti);
      assert.equal(row.openai_base_url, "https://ai.contoso.invalid/v1");
      assert.equal(row.anthropic_base_url, "https://ai.contoso.invalid/claude-hackgw");
      assert.equal(row.anthropic_model, "sonnet-5");
      assert.equal(row.models, "flash sonnet-5");
      assert.equal(row.budget_tokens, "1000");
      assert.match(row.valid_from_utc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      assert.match(row.valid_until_utc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
  });

  test("keys.csv and every handout file holding a token are readable only by their owner", () => {
    const r = run({ answers: BULK, call: "New-BulkKeys" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const batch = batchOf(r.dir);
    const files = [
      join(batch, "keys.csv"),
      join(batch, "team-01", "README.md"),
      join(batch, "team-01", ".claude", "settings.json"),
    ];
    for (const f of files) assert.ok(ownerOnly(f), `${f} is readable by others`);
  });

  test("a name a spreadsheet would run as a formula is neutralised in both CSVs", () => {
    // OWASP CSV injection: a cell starting with = + - @ runs as a formula in Excel and Sheets.
    // 2 = names from a file, then the key settings and the hostname prompt.
    const r = run({
      files: { "participants.txt": "=1+1\n@risk\nalice\n" },
      answers: ["2", "<DIR>/participants.txt", "a", "48", "0", "1000", "<default>"],
      call: "New-BulkKeys",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const batch = batchOf(r.dir);
    for (const name of ["keys.csv", "index.csv"]) {
      const rows = parseCsv(readFileSync(join(batch, name), "utf8"));
      const names = rows.map((x) => x.participant ?? x.subject);
      assert.deepEqual(names, ["'=1+1", "'@risk", "alice"], `${name} carries a live formula: ${names.join(" | ")}`);
    }
    // Only the display is guarded: the key still names the participant as given.
    const keyRow = parseCsv(readFileSync(join(batch, "keys.csv"), "utf8"))[0];
    assert.equal(verifyKey(keyRow.key, secretOf(r.stdout)).sub, "=1+1");
  });

  test("index.csv still holds no tokens", () => {
    const r = run({ answers: BULK, call: "New-BulkKeys" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const index = readFileSync(join(batchOf(r.dir), "index.csv"), "utf8");
    assert.doesNotMatch(index, /eyJ[A-Za-z0-9_-]+\./, "index.csv contains a token");
  });
});
