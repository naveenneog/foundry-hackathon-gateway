import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildDeploymentPlan, PLAN } from "../src/apim.mjs";

/**
 * What a deployment would do, worked out before it runs.
 *
 * An ARM deployment is atomic: one resource that cannot be created fails the whole thing. That
 * happened live — an instance already published an API at `claude`, and an unrelated gateway had
 * already granted the Foundry role, so the deployment failed on both and left the API it HAD
 * created behind. The operator saw a wall of ARM JSON and a half-built gateway.
 *
 * The plan answers the question that wall of JSON did not: what is already here, what will be
 * added, and what cannot be done and why.
 */

const facts = (over = {}) => ({
  apim: { name: "apim-corp", exists: true, sku: "BasicV2", hasIdentity: true },
  existingApis: [],
  existingPaths: [],
  namedValues: [],
  roleAssigned: false,
  foundry: { name: "ai-acct", exists: true, deployments: ["deepseek-v4-flash", "claude-sonnet-5"] },
  pins: [
    { alias: "flash", deployment: "deepseek-v4-flash", route: "openai" },
    { alias: "sonnet-5", deployment: "claude-sonnet-5", route: "claude" },
  ],
  ...over,
});

const row = (plan, component) => plan.find((r) => r.component === component);

describe("the plan says what already exists", () => {
  test("an instance that is present is reused, not created", () => {
    const plan = buildDeploymentPlan(facts());
    assert.equal(row(plan, "API Management").action, PLAN.REUSE);
  });

  test("an instance that is absent is created", () => {
    const plan = buildDeploymentPlan(facts({ apim: { name: "new", exists: false } }));
    assert.equal(row(plan, "API Management").action, PLAN.CREATE);
  });

  test("an API already published is updated in place", () => {
    const plan = buildDeploymentPlan(facts({ existingApis: ["deepseek-gateway"] }));
    assert.equal(row(plan, "OpenAI route").action, PLAN.UPDATE);
  });

  test("an API not yet published is created", () => {
    assert.equal(row(buildDeploymentPlan(facts()), "OpenAI route").action, PLAN.CREATE);
  });

  test("named values already present are counted as updates", () => {
    const plan = buildDeploymentPlan(facts({ namedValues: ["hackgw-model-map", "hackgw-signing-key"] }));
    assert.equal(row(plan, "Named values").action, PLAN.UPDATE);
    assert.match(row(plan, "Named values").detail, /2 already/);
  });

  test("a role already granted is not granted again", () => {
    const plan = buildDeploymentPlan(facts({ roleAssigned: true }));
    assert.equal(row(plan, "Foundry access").action, PLAN.OK);
    assert.match(row(plan, "Foundry access").detail, /already/i);
  });

  test("a role not yet granted is granted", () => {
    assert.equal(row(buildDeploymentPlan(facts()), "Foundry access").action, PLAN.CREATE);
  });
});

describe("the plan refuses what cannot work, instead of letting ARM fail", () => {
  test("a path another API owns blocks the Claude route and names the owner", () => {
    const plan = buildDeploymentPlan(
      facts({ existingPaths: [{ name: "claude-foundry", path: "claude" }] })
    );
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.BLOCKED);
    assert.match(r.detail, /claude-foundry/);
  });

  test("a tier that cannot meter Anthropic tokens blocks the Claude route", () => {
    const plan = buildDeploymentPlan(
      facts({ apim: { name: "x", exists: true, sku: "Developer", hasIdentity: true } })
    );
    assert.equal(row(plan, "Claude route").action, PLAN.BLOCKED);
    assert.match(row(plan, "Claude route").detail, /v2/i);
  });

  test("the OpenAI route is unaffected by a Claude blocker", () => {
    const plan = buildDeploymentPlan(
      facts({ apim: { name: "x", exists: true, sku: "Developer", hasIdentity: true } })
    );
    assert.notEqual(row(plan, "OpenAI route").action, PLAN.BLOCKED);
  });

  test("no Claude pins: the route is still published, and the plan says what it will answer", () => {
    // This used to say "skipped, not published". The deployment never did that: Invoke-Deploy
    // publishes the Claude route whenever the instance can serve it, with EMPTY_MAP, so a model
    // pinned later goes live without a redeploy (ADR-0007). The plan now says what happens.
    const plan = buildDeploymentPlan(
      facts({ pins: [{ alias: "flash", deployment: "deepseek-v4-flash", route: "openai" }] })
    );
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.CREATE);
    assert.match(r.detail, /model_not_configured/);
  });

  test("only Claude models pinned: the OpenAI route says nothing is pinned on it", () => {
    // The pins from the run that failed on an empty OpenAI map.
    const plan = buildDeploymentPlan(
      facts({
        existingApis: ["deepseek-gateway"],
        pins: [
          { alias: "sonnet-5", deployment: "claude-sonnet-5", route: "claude" },
          { alias: "haiku-4-5", deployment: "claude-haiku-4-5", route: "claude" },
        ],
      })
    );
    const r = row(plan, "OpenAI route");
    assert.equal(r.action, PLAN.UPDATE);
    assert.match(r.detail, /model_not_configured/);
  });

  test("a route with models pinned carries no such note", () => {
    const plan = buildDeploymentPlan(facts());
    for (const label of ["OpenAI route", "Claude route"]) {
      assert.doesNotMatch(row(plan, label).detail, /model_not_configured/, label);
    }
  });

  test("a Claude route the caller is not publishing is skipped, naming the pins it strands", () => {
    const plan = buildDeploymentPlan(facts({ deployClaude: false }));
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.SKIP);
    assert.match(r.detail, /1 Claude pin/);
  });

  test("not publishing does not hide a Claude API that already exists", () => {
    // ARM deploys incrementally, so declining the route leaves an existing claude-gateway live
    // and untouched. "Not published" would hide it.
    const plan = buildDeploymentPlan(facts({ deployClaude: false, existingApis: ["claude-gateway"] }));
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.SKIP);
    assert.match(r.detail, /claude-gateway/);
    assert.match(r.detail, /left in place/);
  });
});

describe("the plan checks the models actually exist", () => {
  test("a pin whose deployment is absent is blocked, naming it", () => {
    const plan = buildDeploymentPlan(
      facts({ foundry: { name: "ai-acct", exists: true, deployments: ["claude-sonnet-5"] } })
    );
    const r = row(plan, "Model: flash");
    assert.equal(r.action, PLAN.BLOCKED);
    assert.match(r.detail, /deepseek-v4-flash/);
  });

  test("a pin whose deployment is present is fine", () => {
    assert.equal(row(buildDeploymentPlan(facts()), "Model: flash").action, PLAN.OK);
  });

  test("a missing Foundry account blocks every pin", () => {
    const plan = buildDeploymentPlan(
      facts({ foundry: { name: "gone", exists: false, deployments: [] } })
    );
    assert.equal(row(plan, "Foundry account").action, PLAN.BLOCKED);
  });
});

describe("the plan is safe to show for any input", () => {
  test("no pins at all still produces a plan, publishing both routes empty", () => {
    const plan = buildDeploymentPlan(facts({ pins: [] }));
    assert.ok(plan.length >= 4);
    for (const label of ["OpenAI route", "Claude route"]) {
      assert.equal(row(plan, label).action, PLAN.CREATE, label);
      assert.match(row(plan, label).detail, /model_not_configured/, label);
    }
  });

  test("junk facts produce a plan rather than an exception", () => {
    for (const value of [null, undefined, {}, "nonsense"]) {
      const plan = buildDeploymentPlan(value);
      assert.ok(Array.isArray(plan), `${JSON.stringify(value)} did not produce a plan`);
    }
  });

  test("every row has a component, an action and a detail", () => {
    for (const r of buildDeploymentPlan(facts())) {
      assert.ok(typeof r.component === "string" && r.component.length > 0);
      assert.ok(Object.values(PLAN).includes(r.action), `${r.action} is not a known action`);
      assert.ok(typeof r.detail === "string");
    }
  });

  test("blocked rows are what a caller counts to decide whether to stop", () => {
    const clean = buildDeploymentPlan(facts());
    assert.equal(clean.filter((r) => r.action === PLAN.BLOCKED).length, 0);

    const broken = buildDeploymentPlan(
      facts({ foundry: { name: "gone", exists: false, deployments: [] } })
    );
    assert.ok(broken.filter((r) => r.action === PLAN.BLOCKED).length > 0);
  });
});

describe("a path collision is worked around; a classic tier is not", () => {
  const taken = [{ name: "claude-foundry", path: "claude" }];

  test("the route moves to the path the caller settled on", () => {
    const plan = buildDeploymentPlan(facts({ existingPaths: taken, claudePath: "claude-hackgw" }));
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.CREATE);
    assert.match(r.detail, /\/claude-hackgw/);
  });

  test("without an alternative path the route is blocked, not created", () => {
    const r = row(buildDeploymentPlan(facts({ existingPaths: taken })), "Claude route");
    assert.equal(r.action, PLAN.BLOCKED);
    assert.match(r.detail, /claude-foundry/);
  });

  test("an alternative path that is ALSO taken is blocked", () => {
    const both = [...taken, { name: "someone-else", path: "claude-hackgw" }];
    const r = row(buildDeploymentPlan(facts({ existingPaths: both, claudePath: "claude-hackgw" })), "Claude route");
    assert.equal(r.action, PLAN.BLOCKED);
    assert.match(r.detail, /someone-else/);
  });

  // The bug this describes: both blockers arrive in one array, and the path workaround used to
  // mask the tier. A classic tier meters no Anthropic tokens, so publishing there ships a budget
  // that silently enforces nothing - the one outcome ADR-0009 says must never happen.
  test("a free path does NOT rescue a classic tier", () => {
    const plan = buildDeploymentPlan(
      facts({
        apim: { name: "apim-corp", exists: true, sku: "Developer", hasIdentity: true },
        existingPaths: taken,
        claudePath: "claude-hackgw",
      })
    );
    const r = row(plan, "Claude route");
    assert.equal(r.action, PLAN.BLOCKED);
    assert.match(r.detail, /v2/i);
  });

  test("the OpenAI route is unaffected by the Claude path", () => {
    const plan = buildDeploymentPlan(facts({ existingPaths: taken, claudePath: "claude-hackgw" }));
    assert.equal(row(plan, "OpenAI route").action, PLAN.CREATE);
  });
});
