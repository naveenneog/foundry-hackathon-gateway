import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { poc, read, pwsh, q } from "./poc-products-keyvault.harness.mjs";

/**
 * P38: the client examples, the live client check that runs them (Test-PocClients.ps1, through
 * its -Plan output and its pass/refusal decision), and the setup guide that shows them.
 */

describe("P38 client examples", () => {
  const dir = join(poc, "examples");
  const files = () => readdirSync(dir).filter((f) => !f.startsWith("."));
  const needsPwsh = { skip: !pwsh && "PowerShell 7 not found" };
  // -Plan prints every check from the loop that runs them, and stops before any Azure call or
  // installation; the tests run under a signed-out Azure CLI profile, so a call would fail.
  const plan = () => {
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", join(poc, "scripts", "Test-PocClients.ps1"),
      "-Subscription", "s", "-ResourceGroup", "rg-x", "-ApimName", "apim-x", "-Plan"], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const checks = [...r.stdout.matchAll(/^PLAN (\{.*\})\s*$/gm)].map((m) => JSON.parse(m[1]));
    return { checks, workDir: (r.stdout.match(/^WORKDIR (.+?)\s*$/m) || [])[1] };
  };
  const decide = (rows) => {
    const script = `. ${q(join(poc, "scripts", "PocMeasure.ps1"))}\n` + rows.map((x) =>
      `Test-PocClientResult -ExitCode ${x.exit} -Output ${q(x.output)} -Expect ${q(x.expect)}${x.refusal ? ` -Refusal ${q(x.refusal)}` : ""}`).join("\n");
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(/\r?\n/).map((l) => l.trim() === "True");
  };
  const refused401 = "Failed to authenticate. API Error: 401 Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.";

  test("every example, and the Claude Code settings example, is a check Test-PocClients.ps1 runs", needsPwsh, () => {
    const { checks } = plan();
    const expected = [...files().map((f) => `examples/${f}`), "claude-code/settings.example.json"].sort();
    assert.ok(expected.length >= 8, `expected the client examples, found ${expected.length}`);
    assert.deepEqual([...new Set(checks.map((c) => c.example).filter(Boolean))].sort(), expected);
    assert.ok(checks.some((c) => c.pack === "wrong" && c.refusal), "no control with a wrong key");
  });

  test("a check passes only on an answer, and a control only on the gateway's refusal of its key", needsPwsh, () => {
    const { checks } = plan();
    for (const c of checks.filter((x) => !x.refusal)) {
      assert.deepEqual(decide([
        { exit: 0, output: "None", expect: c.expect },
        { exit: 0, output: "null", expect: c.expect },
        { exit: 0, output: "", expect: c.expect },
      ]), [false, false, false], `${c.name}: an empty answer passes`);
    }
    const control = checks.find((x) => x.refusal);
    assert.deepEqual(decide([
      { exit: 1, output: refused401, expect: control.expect, refusal: control.refusal },
      { exit: 1, output: "API Error: 429 Too many requests", expect: control.expect, refusal: control.refusal },
      { exit: 1, output: "getaddrinfo ENOTFOUND apim-x.azure-api.net", expect: control.expect, refusal: control.refusal },
      { exit: 0, output: "OK", expect: control.expect, refusal: control.refusal },
    ]), [true, false, false, false]);
    assert.deepEqual(decide([
      { exit: 0, output: "OK", expect: "\\bOK\\b" },
      { exit: 1, output: "OK", expect: "\\bOK\\b" },
    ]), [true, false]);
  });

  test("the work folder is the user's own by default, not a shared temporary folder", needsPwsh, () => {
    const { workDir } = plan();
    const base = spawnSync(pwsh, ["-NoProfile", "-Command", "[Environment]::GetFolderPath('LocalApplicationData')"], { encoding: "utf8" }).stdout.trim();
    assert.ok(base, "no per-user data folder on this machine");
    assert.equal(workDir, join(base, "poc-clients"));
  });

  test("every environment variable a check sets or clears is saved first and restored at the end", () => {
    const code = (text) => text.replace(/<#[\s\S]*?#>/g, "").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    const harness = code(read("scripts", "Test-PocClients.ps1"));
    const dotSourced = files().filter((f) => f.endsWith(".ps1")).map((f) => code(readFileSync(join(dir, f), "utf8")));
    const touched = (harness.match(/^\$touched = (.+)$/m) || [])[1];
    assert.ok(touched, "no $touched list");
    const listed = [...touched.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const used = new Set([harness, ...dotSourced].flatMap((t) => [...t.matchAll(/\benv:([A-Z_]+)\b/g)].map((m) => m[1])));
    assert.deepEqual([...used].filter((v) => !listed.includes(v)), [], "set or cleared without being saved");
    assert.match(harness, /^foreach \(\$v in \$touched\) \{ \$saved\[\$v\] = \[Environment\]::GetEnvironmentVariable\(\$v\) \}\s*\ntry \{/m);
    // The script's own try ... finally starts at column 0; Invoke-PocClaudeCode has an indented one.
    const outerFinally = (harness.match(/^\} finally \{\r?\n([\s\S]*?)^\}\s*$/m) || [])[1] || "";
    assert.match(outerFinally, /^\s+foreach \(\$v in \$touched\) \{ \[Environment\]::SetEnvironmentVariable\(\$v, \$saved\[\$v\]\) \}\s*$/m, "the restore loop is not in the script's own finally");
    for (const v of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_AUTH_TOKEN"]) {
      assert.ok(listed.includes(v), `${v} outranks the key under test and is not cleared`);
    }
  });

  test("the guide's curl lines send what the harness sends, from the same folder", () => {
    const parts = (line) => ({
      path: (line.match(/\/poc\/[^"'\s]+/) || [])[0],
      headers: [...line.matchAll(/-H\s+["']([^:"']+):/g)].map((m) => m[1].toLowerCase()).sort(),
      data: (line.match(/-d\s+["']?@([^"'\s]+)/) || [])[1],
    });
    const shown = read("SETUP.md").split(/\r?\n/).filter((l) => /^curl /.test(l)).map(parts);
    const run = read("scripts", "Test-PocClients.ps1").split(/\r?\n/).filter((l) => /& \$curl /.test(l)).map(parts);
    assert.ok(shown.length >= 3, `expected the probe and one curl line per route in the guide, found ${shown.length}`);
    assert.deepEqual(shown.sort((a, b) => a.path.localeCompare(b.path)), run.sort((a, b) => a.path.localeCompare(b.path)));
    for (const s of shown.filter((x) => x.data)) assert.ok(existsSync(join(poc, s.data)), `${s.data} does not exist relative to poc/products-keyvault/`);
    assert.match(read("scripts", "Test-PocClients.ps1"), /Push-Location \$poc\s*\r?\n\s*try \{\s*\r?\n\s*foreach \(\$c in \$checks\) \{/, "the checks do not run from poc/products-keyvault/");
  });

  test("no example holds a key: each reads it from POC_KEY", () => {
    for (const f of files()) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/, `${f} holds something shaped like a subscription key`);
      if (/\.(py|mjs|ps1)$/.test(f)) assert.match(text, /POC_KEY/, `${f} does not read POC_KEY`);
    }
  });

  test("the JSON examples parse, and opencode sends the key in the header each route reads", () => {
    for (const f of files().filter((x) => x.endsWith(".json"))) JSON.parse(readFileSync(join(dir, f), "utf8"));
    const oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).provider;
    const openai = Object.values(oc).find((p) => p.npm === "@ai-sdk/openai-compatible");
    const claude = Object.values(oc).find((p) => p.npm === "@ai-sdk/anthropic");
    assert.equal(openai.options.headers["api-key"], "{env:POC_KEY}");
    assert.match(openai.options.baseURL, /\/poc\/v1$/);
    assert.equal(claude.options.apiKey, "{env:POC_KEY}");
    assert.match(claude.options.baseURL, /\/poc\/claude\/v1$/);
  });

  test("both Claude Code examples strip pre-release anthropic-beta values", () => {
    // Foundry refuses some of them with a 400 (UNKNOWNS U17, update of 2026-10-12).
    const settings = JSON.parse(read("claude-code", "settings.example.json"));
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
    assert.match(read("examples", "claude-code-env.ps1"), /^\$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'$/m);
  });
});

describe("P38 setup guide", () => {
  const guide = () => read("SETUP.md").replace(/\r\n/g, "\n");
  const validSet = (script, param) => {
    const m = read("scripts", script).match(new RegExp(`ValidateSet\\(([^)]*)\\)\\]\\[string\\]\\$${param}\\b`));
    assert.ok(m, `${script} has no ValidateSet for -${param}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  test("the guide exists and the proof of concept's README links it", () => {
    assert.ok(existsSync(join(poc, "SETUP.md")), "SETUP.md is missing");
    assert.match(read("README.md"), /\]\(SETUP\.md\)/);
  });

  test("the guide covers setup, every key action, every client, errors and removal", () => {
    const have = guide().split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, "").trim());
    const want = ["Requirements", "Set up", "Issue a key", "Hand a key over", "Rotate a key", "Expire a key",
      "Suspend and resume a key", "List keys", "Monitor", "Connect a client", "Claude Code", "Anthropic SDK",
      "OpenAI SDK", "opencode", "curl", "Errors", "Remove", "Sources"];
    assert.deepEqual(want.filter((h) => !have.includes(h)), []);
  });

  test("each client example appears in the guide exactly as Test-PocClients.ps1 runs it", () => {
    const shown = [...guide().matchAll(/<!-- file: (\S+) -->\n```[a-z]*\n([\s\S]*?)\n```/g)];
    const expected = readdirSync(join(poc, "examples")).filter((f) => !f.startsWith(".")).map((f) => `examples/${f}`);
    expected.push("claude-code/settings.example.json");
    assert.deepEqual(shown.map((m) => m[1]).sort(), expected.sort());
    for (const [, file, body] of shown) {
      const actual = read(...file.split("/")).replace(/\r\n/g, "\n").replace(/\n$/, "");
      assert.equal(body, actual, `the guide's copy of ${file} differs from the file`);
    }
  });

  test("every key action and runner step the guide uses exists, and every key action is shown", () => {
    const text = guide();
    const actions = [...text.matchAll(/Invoke-PocKey\.ps1\b[^\n]*?-Action (\w+)/g)].map((m) => m[1]);
    const onRunner = [...text.matchAll(/-KeyAction (\w+)/g)].map((m) => m[1]);
    const steps = [...text.matchAll(/Invoke-PocRunner\.ps1\b[^\n]*?-Step (\w+)/g)].map((m) => m[1]);
    const valid = validSet("Invoke-PocKey.ps1", "Action");
    const runnerValid = validSet("Invoke-PocRunner.ps1", "KeyAction");
    assert.deepEqual(actions.filter((a) => !valid.includes(a)), []);
    assert.deepEqual(onRunner.filter((a) => !runnerValid.includes(a)), [], "-KeyAction values the runner refuses");
    assert.deepEqual(runnerValid.filter((a) => !valid.includes(a)), [], "runner key actions Invoke-PocKey.ps1 lacks");
    assert.deepEqual(valid.filter((a) => !actions.includes(a)), [], "key actions the guide does not show");
    assert.deepEqual(steps.filter((s) => !validSet("Invoke-PocRunner.ps1", "Step").includes(s)), []);
    assert.ok(steps.includes("Key") && onRunner.length > 0, "the guide does not show key actions on the runner");
    // The guide's list of runner key actions is the runner's own.
    const listed = (text.match(/`-Step Key` takes `-KeyAction` \(([^)]*)\)/) || [])[1] || "";
    assert.deepEqual([...listed.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort(), [...runnerValid].sort());
  });

  test("every relative link in the guide resolves to a file", () => {
    const links = [...guide().matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
      .filter((l) => !/^(https?:|#|mailto:)/.test(l)).map((l) => l.split("#")[0]);
    assert.ok(links.length >= 5, `expected links to the scripts and examples, found ${links.length}`);
    for (const l of links) assert.ok(existsSync(join(poc, l)), `${l} does not exist`);
  });

  test("the guide holds no key and names no real instance", () => {
    const text = guide();
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i, "something shaped like a subscription key");
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a GUID");
    for (const m of text.matchAll(/https:\/\/([^/\s)`"']+)\.azure-api\.net/g)) {
      assert.match(m[1], /^<[^>]+>$/, `${m[0]} is not a placeholder`);
    }
  });
});
