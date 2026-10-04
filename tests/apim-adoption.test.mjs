import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyApim,
  rankApim,
  needsRoleAssignment,
  suggestFreePath,
  apiIdForRoute,
  apiPathForRoute,
  ROUTE,
  UNSUITABLE,
} from "../src/apim.mjs";

/**
 * Adopting an APIM instance an organisation already runs.
 *
 * The decision that matters here is the tier. `llm-token-limit` parses the Anthropic Messages
 * shape only on v2 tiers; a classic tier accepts the identical policy and meters zero tokens.
 * A budget that is configured, reported as configured, and enforces nothing is worse than no
 * budget at all, so a classic tier is REFUSED for the Claude route rather than warned about.
 *
 * See UNKNOWNS U12 and ADR-0008.
 */

const apim = (over = {}) => ({
  name: "apim-corp",
  resourceGroup: "rg-platform",
  location: "eastus2",
  sku: { name: "BasicV2", capacity: 1 },
  provisioningState: "Succeeded",
  identity: { type: "SystemAssigned", principalId: "11111111-2222-3333-4444-555555555555" },
  ...over,
});

describe("tier suitability for the Claude route", () => {
  for (const sku of ["BasicV2", "StandardV2", "PremiumV2"]) {
    test(`${sku} is suitable — v2 tiers meter Anthropic tokens`, () => {
      const v = classifyApim(apim({ sku: { name: sku } }), { route: ROUTE.CLAUDE });
      assert.equal(v.suitable, true);
      assert.deepEqual(v.blockers, []);
    });
  }

  for (const sku of ["Developer", "Basic", "Standard", "Premium", "Consumption"]) {
    test(`${sku} is refused — it would meter zero Anthropic tokens`, () => {
      const v = classifyApim(apim({ sku: { name: sku } }), { route: ROUTE.CLAUDE });
      assert.equal(v.suitable, false, `${sku} must not be offered for the Claude route`);
      assert.ok(
        v.blockers.includes(UNSUITABLE.CLASSIC_TIER),
        `${sku} must be blocked for the stated reason, not an incidental one`
      );
      assert.match(v.reason, /v2/i);
    });
  }

  test("the refusal explains the silent-failure consequence, not just the rule", () => {
    const v = classifyApim(apim({ sku: { name: "Developer" } }), { route: ROUTE.CLAUDE });
    assert.match(v.reason, /zero|never|silent/i);
  });
});

describe("tier suitability for the DeepSeek (OpenAI-shaped) route", () => {
  test("a classic tier is fine — the OpenAI shape parses on all tiers", () => {
    const v = classifyApim(apim({ sku: { name: "Developer" } }), { route: ROUTE.OPENAI });
    assert.equal(v.suitable, true);
    assert.deepEqual(v.blockers, []);
  });

  test("Consumption is still refused — it cannot hold a managed identity or named values", () => {
    const v = classifyApim(apim({ sku: { name: "Consumption" } }), { route: ROUTE.OPENAI });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.CONSUMPTION_TIER));
  });
});

describe("an instance that is not ready cannot take an API", () => {
  for (const state of ["Activating", "Updating", "Failed", "Deleting"]) {
    test(`provisioningState ${state} is refused`, () => {
      const v = classifyApim(apim({ provisioningState: state }), { route: ROUTE.CLAUDE });
      assert.equal(v.suitable, false);
      assert.ok(v.blockers.includes(UNSUITABLE.NOT_READY));
    });
  }

  test("Succeeded is accepted", () => {
    const v = classifyApim(apim({ provisioningState: "Succeeded" }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, true);
  });
});

describe("the operator is told what deploying would do to the instance", () => {
  test("an instance already carrying the API would be updated, not duplicated", () => {
    const v = classifyApim(apim(), { route: ROUTE.CLAUDE, existingApis: ["claude-gateway"] });
    assert.equal(v.suitable, true);
    assert.equal(v.action, "update");
    assert.match(v.note, /already/i);
  });

  test("an instance without the API would have it added", () => {
    const v = classifyApim(apim(), { route: ROUTE.CLAUDE, existingApis: ["some-other-api"] });
    assert.equal(v.action, "add");
  });

  test("an unrelated API on the instance is not mistaken for ours", () => {
    const v = classifyApim(apim(), { route: ROUTE.CLAUDE, existingApis: ["claude-gateway-v2"] });
    assert.equal(v.action, "add", "matching must be exact, not a prefix");
  });
});

describe("a missing or malformed instance never reads as suitable", () => {
  const junk = [null, undefined, {}, { name: "x" }, { name: "x", sku: null }, "apim-corp"];
  for (const value of junk) {
    test(`${JSON.stringify(value)} is refused rather than defaulting to usable`, () => {
      const v = classifyApim(value, { route: ROUTE.CLAUDE });
      assert.equal(v.suitable, false);
    });
  }

  test("an unknown route is refused — a new route must opt in deliberately", () => {
    const v = classifyApim(apim(), { route: "something-new" });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.UNKNOWN_ROUTE));
  });
});

describe("an instance with no system-assigned identity cannot reach Foundry", () => {
  /**
   * The gateway authenticates to Foundry as the APIM instance itself. Without a
   * system-assigned identity there is no principal to grant Cognitive Services User to, so the
   * deployment would succeed and every model call would come back 401.
   *
   * Enabling it is also not something to do silently on someone else's shared instance:
   * `az apim update` sets identity to None unless --enable-managed-identity true is passed
   * (azure-cli dev, apim/custom.py apim_update: `if not enable_managed_identity:
   * instance.identity = None`), so a careless fix can strip an identity the instance's other
   * APIs depend on.
   */
  test("no identity block at all is refused", () => {
    const v = classifyApim(apim({ identity: undefined }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.NO_IDENTITY));
  });

  test("identity type None is refused", () => {
    const v = classifyApim(apim({ identity: { type: "None" } }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.NO_IDENTITY));
  });

  test("UserAssigned only is refused — the policy requests a system-assigned token", () => {
    const v = classifyApim(apim({ identity: { type: "UserAssigned" } }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.NO_IDENTITY));
  });

  test("SystemAssigned is accepted", () => {
    const v = classifyApim(apim({ identity: { type: "SystemAssigned", principalId: "p" } }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, true);
  });

  test("SystemAssigned, UserAssigned is accepted — the system half is what is used", () => {
    const v = classifyApim(apim({ identity: { type: "SystemAssigned, UserAssigned", principalId: "p" } }), { route: ROUTE.CLAUDE });
    assert.equal(v.suitable, true);
  });

  test("the remedy names the flag, because omitting it strips the identity", () => {
    const v = classifyApim(apim({ identity: { type: "None" } }), { route: ROUTE.CLAUDE });
    assert.match(v.reason, /--enable-managed-identity true/);
  });
});

describe("an API path already in use on the instance blocks the deploy", () => {
  /**
   * APIM requires the path to be unique across the instance. Reporting an instance as usable
   * and then failing on a duplicate path promises something the check cannot deliver, which is
   * exactly the kind of late surprise adoption is supposed to remove.
   */
  test("another API already published at this route's path is a blocker", () => {
    const v = classifyApim(apim(), {
      route: ROUTE.OPENAI,
      existingPaths: [{ name: "billing-api", path: "v1" }],
    });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.PATH_TAKEN));
    assert.match(v.reason, /billing-api/);
  });

  test("our own API at that path is not a collision — that is an update", () => {
    const v = classifyApim(apim(), {
      route: ROUTE.OPENAI,
      existingApis: ["deepseek-gateway"],
      existingPaths: [{ name: "deepseek-gateway", path: "v1" }],
    });
    assert.equal(v.suitable, true);
    assert.equal(v.action, "update");
  });

  test("an API on a different path is irrelevant", () => {
    const v = classifyApim(apim(), {
      route: ROUTE.OPENAI,
      existingPaths: [{ name: "billing-api", path: "billing" }],
    });
    assert.equal(v.suitable, true);
  });

  test("path comparison ignores case and surrounding slashes, as APIM does", () => {
    const v = classifyApim(apim(), {
      route: ROUTE.OPENAI,
      existingPaths: [{ name: "billing-api", path: "/V1/" }],
    });
    assert.equal(v.suitable, false);
    assert.ok(v.blockers.includes(UNSUITABLE.PATH_TAKEN));
  });

  test("the Claude route uses its own path, so it does not collide with the OpenAI one", () => {
    const v = classifyApim(apim(), {
      route: ROUTE.CLAUDE,
      existingPaths: [{ name: "deepseek-gateway", path: "v1" }],
    });
    assert.equal(v.suitable, true);
  });

  test("no path information at all does not invent a collision", () => {
    const v = classifyApim(apim(), { route: ROUTE.OPENAI });
    assert.equal(v.suitable, true);
  });
});

describe("a taken path can be worked around rather than only refused", () => {
  /**
   * An instance already running another Claude gateway owns `/claude`. Refusing outright means
   * that instance can never serve this route, which is the wrong answer when the operator
   * deliberately chose it. Offering a free path makes it usable; the participant's base URL
   * changes, which is why it is offered rather than taken silently.
   */
  test("the preferred path is returned when it is free", () => {
    assert.equal(suggestFreePath([], "claude"), "claude");
    assert.equal(suggestFreePath([{ name: "other", path: "v1" }], "claude"), "claude");
  });

  test("a taken path yields a suffixed alternative", () => {
    assert.equal(suggestFreePath([{ name: "claude-foundry", path: "claude" }], "claude"), "claude-hackgw");
  });

  test("it keeps going when the alternative is taken too", () => {
    const taken = [
      { name: "a", path: "claude" },
      { name: "b", path: "claude-hackgw" },
    ];
    assert.equal(suggestFreePath(taken, "claude"), "claude-hackgw-2");
  });

  test("comparison ignores case and surrounding slashes, as APIM does", () => {
    assert.equal(suggestFreePath([{ name: "a", path: "/CLAUDE/" }], "claude"), "claude-hackgw");
  });

  test("our own API holding the path is not a collision", () => {
    assert.equal(
      suggestFreePath([{ name: "claude-gateway", path: "claude" }], "claude", "claude-gateway"),
      "claude"
    );
  });

  test("junk input returns the preferred path rather than throwing", () => {
    assert.equal(suggestFreePath(null, "claude"), "claude");
    assert.equal(suggestFreePath(undefined, "claude"), "claude");
    assert.equal(suggestFreePath([null, {}, "x"], "claude"), "claude");
  });
});

describe("ranking puts the instances an operator can actually use first", () => {
  const list = [
    apim({ name: "apim-classic", sku: { name: "Developer" } }),
    apim({ name: "apim-ready", sku: { name: "StandardV2" } }),
    apim({ name: "apim-busy", sku: { name: "BasicV2" }, provisioningState: "Updating" }),
    apim({ name: "apim-has-api", sku: { name: "BasicV2" } }),
  ];

  test("suitable instances come before unsuitable ones", () => {
    const ranked = rankApim(list, { route: ROUTE.CLAUDE, existingApisByName: { "apim-has-api": ["claude-gateway"] } });
    const firstUnsuitable = ranked.findIndex((r) => !r.suitable);
    const lastSuitable = ranked.map((r) => r.suitable).lastIndexOf(true);
    assert.ok(lastSuitable < firstUnsuitable, "a suitable instance must never sort below an unsuitable one");
  });

  test("an instance already carrying the API is preferred — it is the one being operated", () => {
    const ranked = rankApim(list, { route: ROUTE.CLAUDE, existingApisByName: { "apim-has-api": ["claude-gateway"] } });
    assert.equal(ranked[0].name, "apim-has-api");
  });

  test("every instance is listed, including the unusable ones, with a reason", () => {
    const ranked = rankApim(list, { route: ROUTE.CLAUDE });
    assert.equal(ranked.length, list.length, "hiding an instance looks like it does not exist");
    for (const r of ranked) {
      assert.ok(typeof r.reason === "string" && r.reason.length > 0);
    }
  });

  test("an empty subscription yields an empty list rather than throwing", () => {
    assert.deepEqual(rankApim([], { route: ROUTE.CLAUDE }), []);
    assert.deepEqual(rankApim(null, { route: ROUTE.CLAUDE }), []);
  });
});

describe("the PowerShell transcription knows the same rules as the module", () => {
  /**
   * scripts/Apim.ps1 is a transcription of this module, and a transcription drifts. It already
   * did once: `malformed` existed here and not there, so an instance with an unreadable SKU was
   * refused by the module and accepted by the script that operators actually run.
   *
   * This compares the vocabulary of both implementations. It cannot prove they agree on
   * behaviour, but a rule that exists on only one side cannot hide.
   */
  const ps = fs.readFileSync(
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "scripts/Apim.ps1"),
    "utf8"
  );

  const psBlockers = new Set([...ps.matchAll(/\$blockers\s*\+=\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const jsBlockers = new Set(Object.values(UNSUITABLE));

  test("both sides declare blockers at all — otherwise this proves nothing", () => {
    assert.ok(psBlockers.size >= 5, `Found ${psBlockers.size} blockers in Apim.ps1.`);
    assert.ok(jsBlockers.size >= 5, `Found ${jsBlockers.size} blockers in apim.mjs.`);
  });

  test("every blocker the module can raise is also raised by the script", () => {
    // unknown_route is unreachable in PowerShell: the parameter is [ValidateSet].
    const expected = [...jsBlockers].filter((b) => b !== UNSUITABLE.UNKNOWN_ROUTE);
    const missing = expected.filter((b) => !psBlockers.has(b));
    assert.deepEqual(
      missing,
      [],
      `scripts/Apim.ps1 never raises ${missing.join(", ")}, so it would accept an instance this ` +
      `module refuses.`
    );
  });

  test("the script raises no blocker the module does not know about", () => {
    const extra = [...psBlockers].filter((b) => !jsBlockers.has(b));
    assert.deepEqual(extra, [], `scripts/Apim.ps1 raises ${extra.join(", ")}, which apim.mjs has no name for.`);
  });

  test("both sides map each route to the same API id and path", () => {
    for (const route of Object.values(ROUTE)) {
      const id = apiIdForRoute(route);
      const apiPath = apiPathForRoute(route);
      assert.match(
        ps,
        new RegExp(`${route}\\s*=\\s*'${id}'`),
        `Apim.ps1 does not map ${route} to the API id '${id}'.`
      );
      assert.match(
        ps,
        new RegExp(`${route}\\s*=\\s*'${apiPath}'`),
        `Apim.ps1 does not map ${route} to the path '${apiPath}'.`
      );
    }
  });
});

describe("the Foundry role assignment is created only when it is missing", () => {
  const PRINCIPAL = "11111111-2222-3333-4444-555555555555";
  const SCOPE = "/subscriptions/s/resourceGroups/rg-contosohub/providers/Microsoft.CognitiveServices/accounts/foundry-plus-resource";
  const ROLE = "a97b65f3-24c7-4388-baec-2e87135dc908";

  test("an equivalent existing assignment means no new one — creating it fails the deployment", () => {
    const existing = [{ principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: `/x/${ROLE}` }];
    assert.equal(needsRoleAssignment(existing, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), false);
  });

  test("no assignments at all means one is needed", () => {
    assert.equal(needsRoleAssignment([], { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), true);
  });

  test("the same role for a different principal does not count", () => {
    const existing = [{ principalId: "other", scope: SCOPE, roleDefinitionId: `/x/${ROLE}` }];
    assert.equal(needsRoleAssignment(existing, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), true);
  });

  test("the same principal at a different scope does not count", () => {
    const existing = [{ principalId: PRINCIPAL, scope: "/subscriptions/s/resourceGroups/elsewhere", roleDefinitionId: `/x/${ROLE}` }];
    assert.equal(needsRoleAssignment(existing, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), true);
  });

  test("a different role for the same principal and scope does not count", () => {
    const existing = [{ principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: "/x/00000000-0000-0000-0000-000000000000" }];
    assert.equal(needsRoleAssignment(existing, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), true);
  });

  test("scope comparison ignores case and a trailing slash, which ARM returns inconsistently", () => {
    const existing = [{ principalId: PRINCIPAL, scope: SCOPE.toUpperCase() + "/", roleDefinitionId: `/x/${ROLE}` }];
    assert.equal(needsRoleAssignment(existing, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), false);
  });

  test("an unreadable assignment list means assume it is needed and let ARM arbitrate", () => {
    // Failing closed here would skip a grant the gateway needs, producing 401s from Foundry
    // that look like a policy fault. ARM rejects a true duplicate; that is the safer error.
    assert.equal(needsRoleAssignment(null, { principalId: PRINCIPAL, scope: SCOPE, roleDefinitionId: ROLE }), true);
  });
});
