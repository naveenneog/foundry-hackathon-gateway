import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PowerShell 7.0+ is a hard requirement for the operator-facing scripts. See
 * docs/adr/0006-powershell-7-requirement.md.
 *
 * These tests guard the one thing that makes that requirement *usable*: a `#Requires -Version`
 * declaration. Without it, running on Windows PowerShell 5.1 — the default shell on Windows —
 * produces either a wall of "Unexpected token" parse errors or, worse, silent data corruption.
 * With it, the host refuses the script up front with a clear, actionable message.
 *
 * Verified empirically: #Requires is honoured *before* the file is parsed, so it produces the
 * clean message even when the script contains PowerShell 7-only syntax.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OPERATOR_SCRIPTS = ["admin.ps1", "scripts/Test-Governance.ps1"];
const MIN_MAJOR = 7;

describe("operator scripts declare their PowerShell requirement", () => {
  for (const file of OPERATOR_SCRIPTS) {
    const src = fs.readFileSync(path.join(root, file), "utf8");

    test(`${file} declares #Requires -Version ${MIN_MAJOR}.0`, () => {
      const m = src.match(/^#Requires\s+-Version\s+(\d+)(?:\.(\d+))?/mi);
      assert.ok(
        m,
        `${file} has no "#Requires -Version" line. Windows PowerShell 5.1 users would hit parse ` +
        `errors or silent data corruption instead of a clear message.`
      );
      assert.ok(
        Number(m[1]) >= MIN_MAJOR,
        `${file} requires PowerShell ${m[1]}, but ${MIN_MAJOR}.0 is the technical floor.`
      );
    });

    test(`${file} puts #Requires before any executable code`, () => {
      // A #Requires buried after real statements still works, but keeping it first is what
      // makes the requirement obvious to anyone opening the file.
      const firstCode = src
        .split(/\r?\n/)
        .findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#") && !l.trim().startsWith("<#"));
      const requiresLine = src.split(/\r?\n/).findIndex((l) => /^#Requires\s/i.test(l.trim()));
      assert.ok(requiresLine >= 0, `${file} is missing #Requires`);
      assert.ok(
        firstCode === -1 || requiresLine < firstCode,
        `${file} declares #Requires at line ${requiresLine + 1}, after code at line ${firstCode + 1}.`
      );
    });
  }
});

describe("the preflight enforces the requirement at runtime too", () => {
  // The preflight lives in its own file, dot-sourced by admin.ps1, to keep that file within
  // its complexity budget.
  const preflight = fs.readFileSync(path.join(root, "scripts/Preflight.ps1"), "utf8");

  test("Preflight.ps1 hard-fails below PowerShell 7", () => {
    assert.match(
      preflight,
      /\$psv\.Major\s+-lt\s+7/,
      "The preflight must check PSVersion.Major -lt 7 and fail, not warn."
    );
  });

  test("the failure tells the user how to install PowerShell 7", () => {
    assert.match(
      preflight,
      /winget install .*Microsoft\.PowerShell/,
      "An unsupported-version error must include the install command, not just the problem."
    );
  });

  test("admin.ps1 actually dot-sources the preflight", () => {
    const admin = fs.readFileSync(path.join(root, "admin.ps1"), "utf8");
    assert.match(
      admin,
      /^\s*\.\s+\(Join-Path\s+\$PSScriptRoot\s+'scripts\/Preflight\.ps1'\)/m,
      "admin.ps1 must dot-source scripts/Preflight.ps1, or the checks never run."
    );
  });

  test("the preflight warns about signing-secret drift", () => {
    // Drift makes every issued key fail with a bare 401 and no diagnostic. It caused a real
    // outage when the gateway was redeployed from a second machine.
    assert.match(
      preflight,
      /signing-key/,
      "The preflight must compare the local secret against the deployed signing-key named value."
    );
  });
});
