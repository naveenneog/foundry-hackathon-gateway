import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/** A PowerShell single-quoted literal. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Remove the admin-only file privileges from the test process's own token, so it holds what an
 * operator who is not elevated holds.
 *
 * GitHub's Windows runners are elevated. Removing SeSecurityPrivilege alone was not enough: a
 * negative-test run with Set-Acl put back stayed green on windows-latest after the test reported
 * "held and has been removed", because Set-Acl enables SeRestorePrivilege before it writes, and
 * an elevated runner holds that too. A standard user token holds none of these four.
 * Prints "PRIV <name> 0" when one was removed and "PRIV <name> 1300" (ERROR_NOT_ALL_ASSIGNED)
 * when it was not held.
 */
const DROP_ADMIN_FILE_PRIVILEGES = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FhgPriv {
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct TP { public uint Count; public LUID Luid; public uint Attr; }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string s, string n, out LUID l);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr t, bool d, ref TP n, uint len, IntPtr p, IntPtr r);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static int Remove(string name) {
        IntPtr t;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out t)) return Marshal.GetLastWin32Error();
        try {
            LUID l;
            if (!LookupPrivilegeValue(null, name, out l)) return Marshal.GetLastWin32Error();
            TP tp = new TP { Count = 1, Luid = l, Attr = 4 };
            AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
            return Marshal.GetLastWin32Error();
        } finally { CloseHandle(t); }
    }
}
'@
foreach ($p in 'SeSecurityPrivilege', 'SeRestorePrivilege', 'SeBackupPrivilege', 'SeTakeOwnershipPrivilege') {
    "PRIV $p $([FhgPriv]::Remove($p))"
}
`;
const ADMIN_FILE_PRIVILEGES = ["SeSecurityPrivilege", "SeRestorePrivilege", "SeBackupPrivilege", "SeTakeOwnershipPrivilege"];

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

  // Get-SigningSecret re-applies Protect-File on every read, so the second call on the same file
  // is the normal case, not an edge case. It failed on Windows for every non-elevated user:
  // Set-Acl's retry compares the new descriptor's AreAuditRulesProtected with the existing file's
  // AreAccessRulesProtected, so once the first call has protected the DACL, every later call
  // tries to write the audit section and needs SeSecurityPrivilege. Every test above calls it
  // once per file, which is why the suite was green while option 1 could not read its secret.
  test("Protect-File can be applied again to a file it already protected", (t) => {
    const f = join(dir, "twice.txt");
    writeFileSync(f, "not-a-real-secret");
    const p = q(f);
    const r = run(`${isWindows ? DROP_ADMIN_FILE_PRIVILEGES : ""}
Protect-File -Path ${p}; Protect-File -Path ${p}; Protect-File -Path ${p}; 'third ok'`);
    if (isWindows) {
      const removed = [];
      for (const name of ADMIN_FILE_PRIVILEGES) {
        const m = r.stdout.match(new RegExp(`PRIV ${name} (\\d+)`));
        assert.ok(m && (m[1] === "0" || m[1] === "1300"), `could not drop ${name}: ${r.stdout} ${r.stderr}`);
        if (m[1] === "0") removed.push(name);
      }
      // Recorded so a CI log shows which case ran: an elevated runner holds these and has them
      // removed; an operator who is not elevated never held them.
      t.diagnostic(removed.length ? `held and removed: ${removed.join(", ")}` : "none of the admin file privileges were held");
    }
    assert.equal(r.status, 0, `a repeat call failed: ${r.stderr}`);
    assert.match(r.stdout, /third ok/);
    assert.doesNotMatch(r.stderr, /SeSecurityPrivilege/);
  });

  test("the Windows branch does not call Set-Acl", () => {
    // Read from the syntax tree rather than the text, so the comment explaining why Set-Acl is
    // not used does not count. This also covers the Windows branch on Linux and macOS, where the
    // test above runs chmod instead.
    const r = spawnSync(
      pwsh,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "scripts", "Platform.ps1"))}, [ref]$null, [ref]$null)
@($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] -and $args[0].GetCommandName() -in @('Set-Acl','Get-Acl') }, $true)).Count`,
      ],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "0", "Platform.ps1 calls Set-Acl or Get-Acl; see UNKNOWNS U21");
  });

  test("a path through a PowerShell drive is restricted, not rejected", () => {
    // Resolve-Path's .Path keeps PowerShell's own form of a path - 'Drive:\x' for a PowerShell
    // drive, 'Microsoft.PowerShell.Core\FileSystem::\\server\share\x' for a network share - and
    // neither FileInfo nor chmod understands it. A checkout opened from a share failed on the
    // first call. A PowerShell drive reproduces the same thing on every platform.
    const f = join(dir, "psdrive.txt");
    writeFileSync(f, "not-a-real-secret");
    const r = run(`New-PSDrive -Name FhgT -PSProvider FileSystem -Root ${q(dir)} | Out-Null
Protect-File -Path (Join-Path 'FhgT:' 'psdrive.txt')
if ($IsWindows) { "protected=$((Get-Acl -LiteralPath ${q(f)}).AreAccessRulesProtected)" }
'drive ok'`);
    assert.equal(r.status, 0, `a PowerShell-drive path failed: ${r.stderr}`);
    assert.match(r.stdout, /drive ok/);
    if (isWindows) assert.match(r.stdout, /protected=True/);
    else assert.equal(statSync(f).mode & 0o777, 0o600);
  });

  test("a failure stops a caller that does not use Stop", () => {
    // Protect-File is an advanced function. An exception from a .NET call inside one reaches the
    // caller as a statement-terminating error, so a caller running with Continue printed it and
    // carried on with the file unprotected. Only an explicit throw stops every caller.
    const f = join(dir, "locked.txt");
    writeFileSync(f, "not-a-real-secret");
    const setup = isWindows
      ? // An OWNER RIGHTS entry limits the owner to what the entries grant, so WRITE_DAC is gone
        // and restricting the file has to fail - elevated or not.
        `$info = [System.IO.FileInfo]::new(${q(f)})
$acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($info, [System.Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($x in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($x) }
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-3-4'), 'Read', 'Allow'))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'Read, Delete', 'Allow'))
[System.IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)`
      : `function chmod { $global:LASTEXITCODE = 1 }`;
    const script = `$ErrorActionPreference = 'Continue'
. ${q(join(root, "scripts", "Platform.ps1"))}
${setup}
Protect-File -Path ${q(f)}
'AFTER'`;
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    assert.doesNotMatch(r.stdout, /AFTER/, `the caller carried on after Protect-File failed: ${r.stderr}`);
    assert.notEqual(r.status, 0, "a failed restriction exited 0");
  });

  test("Write-ProtectedFile restricts the file before it writes anything into it", () => {
    // Read from the syntax tree: written the other way round, the content would exist with
    // default permissions until Protect-File ran, and every test of the final state would pass.
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(join(root, "scripts", "Platform.ps1"))}, [ref]$null, [ref]$null)
       $fn = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Write-ProtectedFile' }, $true) | Select-Object -First 1
       $calls = @($fn.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { "$($_.GetCommandName())@$($_.Extent.StartOffset)" })
       $calls -join ' '`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const at = (name) => Number((r.stdout.match(new RegExp(`${name}@(\\d+)`)) || [])[1]);
    assert.ok(at("Protect-File") > 0 && at("Set-Content") > 0, `calls not found: ${r.stdout}`);
    assert.ok(at("Protect-File") < at("Set-Content"), "Write-ProtectedFile writes before it restricts");
  });

  test("Write-ProtectedFile leaves an existing, readable file owner-only with the new content", () => {
    const f = join(dir, "existing.txt");
    writeFileSync(f, "old content");
    const p = q(f);
    const loosen = isWindows
      ? `$i = [System.IO.FileInfo]::new(${p}); $a = [System.IO.FileSystemAclExtensions]::GetAccessControl($i, 'Access')
         $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
         [System.IO.FileSystemAclExtensions]::SetAccessControl($i, $a)`
      : `& chmod 644 ${p}`;
    const r = run(`${loosen}
Write-ProtectedFile -Path ${p} -Value 'new content'
if ($IsWindows) { $a = Get-Acl -LiteralPath ${p}; "OTHERS $(@($a.Access | Where-Object { $_.IdentityReference.Value -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }).Count) PROTECTED $($a.AreAccessRulesProtected)" }`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(f, "utf8").trim(), "new content");
    if (isWindows) assert.match(r.stdout, /OTHERS 0 PROTECTED True/);
    else assert.equal(statSync(f).mode & 0o777, 0o600);
  });

  test("every write of the signing secret restricts the file first", () => {
    // Position-blind counting was the earlier version of this, which a move could satisfy
    // without protecting anything. These check the order that matters: the file is restricted
    // before the secret goes into it, and the reuse path re-asserts it.
    const admin = readFileSync(join(root, "admin.ps1"), "utf8");
    assert.equal(
      /Get-Acl|Set-Acl|FileSystemAccessRule|WindowsIdentity/.test(admin),
      false,
      "admin.ps1 still calls a Windows-only ACL API directly instead of Protect-File"
    );

    const body = (name) => {
      const i = admin.indexOf(`function ${name} {`);
      assert.notEqual(i, -1, `${name} not found`);
      return admin.slice(i, admin.indexOf("\nfunction ", i + 1));
    };

    for (const fn of ["New-SigningSecret", "Get-SigningSecret"]) {
      assert.match(body(fn), /Protect-File\s+-Path/, `${fn} does not restrict the secret file`);
    }

    const mk = body("New-SigningSecret");
    assert.ok(
      mk.indexOf("Protect-File") < mk.indexOf("-Value $secret"),
      "the secret is written before the file is restricted, leaving a window at default permissions"
    );
    assert.match(mk, /Remove-Item[^\n]*SecretPath/, "a failed Protect-File leaves the unprotected file on disk");
  });

  test("no operator script calls a Windows-only API outside the platform helper", () => {
    // Discovered, not listed. A hardcoded list silently stopped covering scripts/Preflight.ps1
    // when it was added, while still asserting it covered "every operator script".
    const scripts = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ps1")) scripts.push(p);
      }
    };
    walk(root);

    // The one file allowed to touch the Windows APIs is the one whose job is platform
    // differences; it guards them with $IsWindows.
    const helper = join(root, "scripts", "Platform.ps1");
    const scanned = scripts.filter((p) => p !== helper);
    assert.ok(scanned.length >= 6, `expected to find the operator scripts, found ${scanned.length}`);

    const offenders = [];
    for (const path of scanned) {
      const body = readFileSync(path, "utf8");
      for (const [api, re] of [
        ["Get-Acl", /\bGet-Acl\b/],
        ["Set-Acl", /\bSet-Acl\b/],
        ["WindowsIdentity", /WindowsIdentity/],
        ["cmd /c", /\bcmd\s+\/c\b/],
        ["%USERPROFILE%", /%USERPROFILE%/],
        ["registry provider", /\bHK(LM|CU):/],
      ]) {
        if (re.test(body)) offenders.push(`${path.slice(root.length)}: ${api}`);
      }
    }
    assert.deepEqual(offenders, [], `Windows-only calls outside scripts/Platform.ps1: ${offenders.join(", ")}`);
  });

  // A hook, not a test: a run filtered with --test-name-pattern skips tests, and left the
  // directory behind when this was one.
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
