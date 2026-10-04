import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The signing secret must be owner-only on every platform the console runs on.
 *
 * It was not. `New-SigningSecret` restricted the file with Get-Acl/Set-Acl and a
 * FileSystemAccessRule - all three Windows-only - inside a try/catch that warned and carried on.
 * On Linux and macOS that catch fires, and the file keeps the default umask: world-readable on a
 * typical box. The secret mints a key for any participant, any budget, any model.
 *
 * These tests run the real PowerShell helper against a real file and read the mode back, because
 * the previous version of this claim was "the code calls Set-Acl", which was true and useless.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const isWindows = process.platform === "win32";

const pwsh = (() => {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  }
  return null;
})();

/** Run a snippet with scripts/Platform.ps1 loaded. */
const run = (snippet) => {
  const script = `$ErrorActionPreference='Stop'
. '${join(root, "scripts", "Platform.ps1").replace(/\\/g, "\\\\")}'
${snippet}`;
  return spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
};

describe("the signing secret is owner-only on this platform", () => {
  let dir;

  before(() => {
    // U20: a skip here would make the whole cross-platform claim vacuous on the platform that
    // needed checking, so this fails instead. pwsh 7 is a stated prerequisite (ADR-0006).
    assert.ok(pwsh, "PowerShell 7+ is required to run this test and was not found on PATH");
    dir = mkdtempSync(join(tmpdir(), "fhg-perm-"));
  });

  test("Protect-File exists and reports success", () => {
    const f = join(dir, "secret.txt");
    writeFileSync(f, "not-a-real-secret");
    const r = run(`Protect-File -Path '${f.replace(/\\/g, "\\\\")}'; 'done'`);
    assert.equal(r.status, 0, `Protect-File failed: ${r.stderr}`);
    assert.match(r.stdout, /done/);
  });

  test("the file is readable only by its owner", () => {
    const f = join(dir, "mode.txt");
    writeFileSync(f, "not-a-real-secret");
    const r = run(`Protect-File -Path '${f.replace(/\\/g, "\\\\")}'`);
    assert.equal(r.status, 0, `Protect-File failed: ${r.stderr}`);

    if (isWindows) {
      // Inheritance off, and no identity on the list beyond the owner.
      const acl = run(
        `$a = Get-Acl '${f.replace(/\\/g, "\\\\")}'
         [pscustomobject]@{ protected = $a.AreAccessRulesProtected
                            ids = @($a.Access | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress`
      );
      const got = JSON.parse(acl.stdout.trim());
      assert.equal(got.protected, true, "inherited ACEs were left in place");
      const me = run("[System.Security.Principal.WindowsIdentity]::GetCurrent().Name").stdout.trim();
      const others = [].concat(got.ids).filter((i) => i.toLowerCase() !== me.toLowerCase());
      assert.deepEqual(others, [], `other identities can read the secret: ${others.join(", ")}`);
    } else {
      // 0600. Group and other bits must both be clear.
      const mode = statSync(f).mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `expected 0600, got 0${mode.toString(8)} - the secret is readable by group or world`
      );
    }
  });

  test("a file that does not exist is an error, not a silent pass", () => {
    const r = run(`Protect-File -Path '${join(dir, "nope.txt").replace(/\\/g, "\\\\")}'`);
    assert.notEqual(r.status, 0, "restricting a missing file reported success");
  });

  test("New-SigningSecret and the parameters file both use the helper", () => {
    // Both write the secret to disk; both have to be covered, and the old code had two copies of
    // the Windows-only block rather than one call.
    const admin = readFileSync(join(root, "admin.ps1"), "utf8");
    assert.equal(
      /Get-Acl|Set-Acl|FileSystemAccessRule|WindowsIdentity/.test(admin),
      false,
      "admin.ps1 still calls a Windows-only ACL API directly instead of Protect-File"
    );
    assert.equal((admin.match(/Protect-File\s+-Path/g) || []).length, 2, "expected both secret-bearing writes to call Protect-File");
  });

  test("no operator script calls a Windows-only API outside the platform helper", () => {
    const files = ["admin.ps1", "scripts/Apim.ps1", "scripts/Keys.ps1", "scripts/Models.ps1", "scripts/Test-Governance.ps1", "scripts/Admin-Preflight.ps1"];
    const offenders = [];
    for (const rel of files) {
      const body = readFileSync(join(root, rel), "utf8");
      for (const [api, re] of [
        ["Get-Acl", /\bGet-Acl\b/],
        ["Set-Acl", /\bSet-Acl\b/],
        ["WindowsIdentity", /WindowsIdentity/],
        ["cmd /c", /\bcmd\s+\/c\b/],
        ["%USERPROFILE%", /%USERPROFILE%/],
        ["registry provider", /\bHK(LM|CU):/],
      ]) {
        if (re.test(body)) offenders.push(`${rel}: ${api}`);
      }
    }
    assert.deepEqual(offenders, [], `Windows-only calls outside scripts/Platform.ps1: ${offenders.join(", ")}`);
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
