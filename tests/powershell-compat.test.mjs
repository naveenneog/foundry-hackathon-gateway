import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards against PowerShell 7-only syntax creeping into the operator-facing scripts.
 *
 * Windows PowerShell 5.1 ships by default on Windows and is what most people will run. The
 * constructs below are *parse-time* errors there, which means the script dies before a single
 * line executes — so no runtime version check, no #Requires, and no friendly error message can
 * rescue it. The user simply sees a wall of "Unexpected token '??'".
 *
 * This actually happened. admin.ps1 shipped with six `??` operators and was unusable on 5.1.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FILES = ["admin.ps1", "scripts/Test-Governance.ps1"];

/**
 * Strip comments and string literals before scanning, so that prose *describing* the forbidden
 * syntax (as the comments in those files do) does not trip the detector.
 */
function stripNoise(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, "")   // block comments
    .replace(/(^|\s)#.*$/gm, "$1")  // line comments
    .replace(/'(?:[^']|'')*'/g, "''")   // single-quoted strings
    .replace(/"(?:[^"`]|`.)*"/g, '""'); // double-quoted strings
}

const FORBIDDEN = [
  {
    name: "?? null-coalescing operator",
    re: /\?\?/,
    fix: "use the Coalesce helper in admin.ps1, or an explicit if",
  },
  {
    name: "?. null-conditional operator",
    re: /\$\w+\?\./,
    fix: "guard with an explicit $null check",
  },
  {
    name: "ternary ? :",
    re: /\)\s*\?\s+[^:\n]+\s+:\s/,
    fix: "use if/else",
  },
  {
    name: "ForEach-Object -Parallel",
    re: /ForEach-Object\s+(-\w+\s+)*-Parallel\b/i,
    fix: "use a sequential loop",
  },
  {
    name: "ConvertFrom-Json -AsHashtable",
    re: /-AsHashtable\b/i,
    fix: "convert the PSCustomObject manually",
  },
  {
    name: "RandomNumberGenerator::Fill (.NET Core only)",
    re: /RandomNumberGenerator\]::Fill\s*\(/,
    fix: "use [RandomNumberGenerator]::Create().GetBytes()",
  },
];

describe("PowerShell scripts must parse on Windows PowerShell 5.1", () => {
  for (const file of FILES) {
    const src = stripNoise(fs.readFileSync(path.join(root, file), "utf8"));

    for (const { name, re, fix } of FORBIDDEN) {
      test(`${file} — no ${name}`, () => {
        const line = src.split(/\r?\n/).findIndex((l) => re.test(l));
        assert.equal(
          line,
          -1,
          `${file}:${line + 1} uses ${name}, which is a parse error on PowerShell 5.1. Fix: ${fix}.`
        );
      });
    }
  }

  test("Test-Governance.ps1 only uses -SkipHttpErrorCheck behind a version guard", () => {
    const raw = fs.readFileSync(path.join(root, "scripts/Test-Governance.ps1"), "utf8");
    const stripped = stripNoise(raw);

    // Passing it as a literal parameter would fail to bind on 5.1. It may only be splatted in
    // after checking the host version.
    assert.ok(
      !/Invoke-WebRequest[^\n]*-SkipHttpErrorCheck/.test(stripped),
      "-SkipHttpErrorCheck must not be passed directly to Invoke-WebRequest; splat it in behind a PSVersion check."
    );

    if (/SkipHttpErrorCheck/.test(stripped)) {
      assert.ok(
        /PSVersionTable\.PSVersion\.Major\s+-ge\s+7/.test(stripped),
        "-SkipHttpErrorCheck is used without a PSVersion >= 7 guard."
      );
    }
  });

  test("admin.ps1 defines the Coalesce helper it relies on", () => {
    const raw = fs.readFileSync(path.join(root, "admin.ps1"), "utf8");
    assert.match(raw, /function\s+Coalesce\b/, "admin.ps1 must define Coalesce as the ?? stand-in");
  });
});
