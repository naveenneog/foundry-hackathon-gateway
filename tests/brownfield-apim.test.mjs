import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deploying onto an API Management instance somebody else already runs.
 *
 * Named values are INSTANCE-wide, not API-wide. On a shared instance an unprefixed
 * `signing-key` or `model-map` would overwrite whatever another team's API is already using
 * under that name — a silent, cross-API data change that no test of ours would ever see.
 *
 * So every named value this gateway owns carries the `hackgw-` prefix, and these tests pin
 * that: a reference the Bicep does not declare, or a declaration without the prefix, fails
 * here rather than in someone else's production API. The same check catches a half-finished
 * rename, where the policy references one name and the Bicep declares another.
 *
 * See ADR-0008.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bicep = fs.readFileSync(path.join(root, "infra/main.bicep"), "utf8");

/** Every policy file, so a new route cannot quietly reference an undeclared named value. */
const policyFiles = fs
  .readdirSync(path.join(root, "infra"))
  .filter((f) => f.endsWith(".xml"))
  .map((f) => fs.readFileSync(path.join(root, "infra", f), "utf8"));
const policy = policyFiles.join("\n");

const PREFIX = "hackgw-";

/**
 * Every {{named-value}} the policy substitutes at compile time.
 *
 * Comments are stripped first: the policy explains the {{named-value}} mechanism and the
 * impossible {{model-}}+alias construction in prose, and prose is not a reference.
 */
const policyCode = policy.replace(/<!--[\s\S]*?-->/g, "");
const referenced = new Set([...policyCode.matchAll(/\{\{([a-zA-Z0-9-]+)\}\}/g)].map((m) => m[1]));

/** Every namespaced literal the Bicep declares. */
const declared = new Set(
  [...bicep.matchAll(/'(hackgw-[a-z0-9-]+)'/g)].map((m) => m[1])
);

describe("the policy and the infrastructure agree on every named value", () => {
  test("the policy actually references named values — otherwise this file proves nothing", () => {
    assert.ok(policyFiles.length >= 2, `Expected several policy files, found ${policyFiles.length}.`);
    assert.ok(
      referenced.size >= 5,
      `Expected the policies to reference several named values, found ${referenced.size}. ` +
      `If they stopped using them, these tests are measuring nothing and must be rewritten.`
    );
  });

  test("every named value the policy references is declared in main.bicep", () => {
    const missing = [...referenced].filter((n) => !declared.has(n));
    assert.deepEqual(
      missing,
      [],
      `policy.xml references ${missing.join(", ")}, which main.bicep does not create. ` +
      `APIM fails the policy at deployment time with an opaque validation error.`
    );
  });

  test("every named value is namespaced, so a shared instance cannot collide", () => {
    const unprefixed = [...referenced].filter((n) => !n.startsWith(PREFIX));
    assert.deepEqual(
      unprefixed,
      [],
      `${unprefixed.join(", ")} would be created instance-wide under a generic name and could ` +
      `overwrite another API's named value on a shared API Management instance.`
    );
  });
});

describe("the policy documents are well-formed enough to deploy", () => {
  /**
   * An XML comment may not contain `--`. A decorative rule of dashes inside a comment is the
   * easy way to write one, and it fails validation when the policy is PUT — taking the whole
   * ARM deployment with it. Caught here rather than at deploy time.
   */
  const names = fs.readdirSync(path.join(root, "infra")).filter((f) => f.endsWith(".xml"));

  test("there are policy files to check", () => {
    assert.ok(names.length >= 2, `Found ${names.length} policy files.`);
  });

  for (const name of names) {
    const src = fs.readFileSync(path.join(root, "infra", name), "utf8");

    test(`${name} has balanced comment markers`, () => {
      const open = (src.match(/<!--/g) ?? []).length;
      const close = (src.match(/-->/g) ?? []).length;
      assert.equal(open, close, `${open} comment openings and ${close} closings.`);
    });

    test(`${name} has no '--' inside a comment`, () => {
      const offenders = [...src.matchAll(/<!--([\s\S]*?)-->/g)]
        .filter((m) => m[1].includes("--"))
        .map((m) => m[1].trim().split("\n")[0].slice(0, 60));
      assert.deepEqual(
        offenders,
        [],
        `An XML comment cannot contain '--'. APIM rejects the policy document: ${offenders.join(" | ")}`
      );
    });
  }
});

describe("no script reaches past the namespace", () => {
  /**
   * Every named-value call goes through Get-/Set-GatewayNamedValue in scripts/Apim.ps1, which
   * applies the prefix and keeps a read fallback to the old unprefixed name. A script that
   * calls `az apim nv ... --named-value-id model-map` directly would read a name this gateway
   * no longer writes, and silently see stale configuration.
   */
  const scripts = fs
    .readdirSync(path.join(root, "scripts"))
    .filter((f) => f.endsWith(".ps1"))
    .map((f) => ["scripts/" + f, fs.readFileSync(path.join(root, "scripts", f), "utf8")]);
  scripts.push(["admin.ps1", fs.readFileSync(path.join(root, "admin.ps1"), "utf8")]);
  // The README's tuning section is an executable procedure, not prose: an unprefixed id there
  // runs, exits 0, and changes a value the policy no longer reads.
  scripts.push(["README.md", fs.readFileSync(path.join(root, "README.md"), "utf8")]);
  scripts.push(["docs/SETUP.md", fs.readFileSync(path.join(root, "docs/SETUP.md"), "utf8")]);

  test("the scripts are readable — otherwise this check proves nothing", () => {
    assert.ok(scripts.length >= 4, `Expected several PowerShell scripts, found ${scripts.length}.`);
  });

  for (const [name, src] of scripts) {
    test(`${name} uses no unprefixed named-value id`, () => {
      const literals = [...src.matchAll(/--named-value-id\s+([^\s`]+)/g)]
        .map((m) => m[1])
        // A value containing a variable is an expression, not a bare name. The helper in
        // Apim.ps1 builds "$script:NvPrefix$Id" and falls back to $Id on reads, deliberately.
        .filter((v) => !v.includes("$"));
      const unprefixed = literals.filter((v) => !v.startsWith(PREFIX));
      assert.deepEqual(
        unprefixed,
        [],
        `${name} addresses ${unprefixed.join(", ")} directly. Use Get-/Set-GatewayNamedValue so ` +
        `the prefix and the migration fallback apply.`
      );
    });
  }
});

describe("main.bicep can adopt an instance instead of creating one", () => {
  test("it takes the name of an existing instance", () => {
    assert.match(
      bicep,
      /param existingApimName string = ''/,
      "There is no way to name an instance to deploy onto."
    );
  });

  test("it creates an instance only when none was named", () => {
    assert.match(
      bicep,
      /resource apimNew 'Microsoft\.ApiManagement\/service@[^']+' = if \(empty\(existingApimName\)\)/,
      "The API Management resource is created unconditionally, so adopting an instance would " +
      "try to redefine it and overwrite its publisher, SKU and identity."
    );
  });

  test("it references the instance as existing, so adoption never rewrites its properties", () => {
    assert.match(
      bicep,
      /resource apim 'Microsoft\.ApiManagement\/service@[^']+' existing = \{/,
      "Children must hang off an `existing` reference; a second full declaration would " +
      "reset SKU, publisher details and identity on an instance we do not own."
    );
  });

  test("every resource that hangs off the instance waits for it", () => {
    // An `existing` reference produces no ARM dependency, so each child needs an explicit one.
    // Checking that `dependsOn: [apimNew]` appears SOMEWHERE is not enough: the module that
    // grants Foundry access reads apim.identity.principalId and was the one child that lost
    // its dependency, which ARM then scheduled in the first wave against an instance that did
    // not exist yet.
    const blocks = bicep.split(/\n(?=resource |module )/);
    // Direct children only. A grandchild hanging off `api` inherits that chain; a resource
    // whose parent is the `existing` reference, or which reads its identity, does not.
    const dependents = blocks.filter(
      (b) => /parent:\s*apim\b/.test(b) || /apim\.identity\.principalId/.test(b)
    );

    assert.ok(
      dependents.length >= 5,
      `Expected several resources hanging off the instance, found ${dependents.length}. ` +
      `If the template was restructured, this check needs rewriting rather than deleting.`
    );

    const missing = dependents
      .filter((b) => !/dependsOn:\s*\[[^\]]*apimNew/s.test(b))
      .map((b) => b.split("\n")[0].trim());

    assert.deepEqual(
      missing,
      [],
      `${missing.join(" | ")} do not depend on apimNew. On a fresh deployment ARM evaluates ` +
      `them before the instance exists.`
    );
  });

  test("the Application Insights logger is namespaced too", () => {
    // A logger called `appinsights` is the name almost every APIM sample uses, so on a shared
    // instance it is the one most likely to already exist and be repointed by this deployment.
    assert.match(
      bicep,
      /name: 'hackgw-appinsights'/,
      "The logger name is generic and would repoint an existing logger of the same name."
    );
  });
});
