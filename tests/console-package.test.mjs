import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Files under src/ (outside src/console) that liteAPIM's server modules import. */
function importedOutsideConsole() {
  const dir = join(root, "src", "console");
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "public") walk(p); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = relative(join(root, "src"), resolve(dirname(p), m[1])).replace(/\\/g, "/");
        if (!target.startsWith("console/")) out.add(target);
      }
    }
  };
  walk(dir);
  return [...out].sort();
}

/** The src/ files Deploy-Console.ps1 copies into the image beside src/console. */
function packaged() {
  const script = readFileSync(join(root, "scripts", "Deploy-Console.ps1"), "utf8");
  const m = script.match(/foreach \(\$f in ([^)]+)\) \{ Copy-Item \(Join-Path \$root "src\/\$f"\)/);
  assert.ok(m, "Deploy-Console.ps1 copies a list of src files");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test("the liteAPIM image contains every src module its server imports", () => {
  const missing = importedOutsideConsole().filter((f) => !packaged().includes(f));
  assert.deepEqual(missing, [], "add these to Deploy-Console.ps1's src copy list");
});
