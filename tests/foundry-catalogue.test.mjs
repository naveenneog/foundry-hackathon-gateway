import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  wireFormatOf,
  buildCatalogue,
  routeFor,
  canPin,
  suggestAlias,
  WIRE,
} from "../src/foundry.mjs";
import { parseModelMap, resolveAlias, mergeModelMaps, EMPTY_MAP } from "../src/models.mjs";

/**
 * Choosing from the models that are actually deployed in the subscription.
 *
 * The thing that makes this more than a list: a Foundry account serves Claude models on a
 * different endpoint, in a different wire format, from everything else. `/openai/v1` speaks
 * OpenAI Chat Completions; `/anthropic` speaks the Anthropic Messages API. Pinning a Claude
 * deployment to the OpenAI route produces a gateway that authenticates correctly, forwards
 * correctly, and returns a 404 from a backend that has never heard of the model.
 *
 * So the wire format is part of what a deployment IS, and a pin that crosses routes is refused
 * at the point of pinning rather than discovered by a participant.
 */

const deployment = (over = {}) => ({
  name: "deepseek-v4-flash",
  properties: {
    model: { format: "DeepSeek", name: "DeepSeek-V4-Flash-0731", version: "2026-07-31" },
    provisioningState: "Succeeded",
  },
  ...over,
});

const claude = () =>
  deployment({
    name: "claude-sonnet-4-6",
    properties: {
      model: { format: "Anthropic", name: "claude-sonnet-4-6", version: "2" },
      provisioningState: "Succeeded",
    },
  });

describe("a deployment knows which wire format it speaks", () => {
  test("DeepSeek speaks OpenAI Chat Completions", () => {
    assert.equal(wireFormatOf(deployment()), WIRE.OPENAI);
  });

  test("OpenAI models speak OpenAI Chat Completions", () => {
    const d = deployment({ properties: { model: { format: "OpenAI", name: "gpt-5.6-terra" }, provisioningState: "Succeeded" } });
    assert.equal(wireFormatOf(d), WIRE.OPENAI);
  });

  test("Anthropic speaks the Messages API", () => {
    assert.equal(wireFormatOf(claude()), WIRE.ANTHROPIC);
  });

  test("the format is matched case-insensitively — ARM is not consistent about it", () => {
    const d = deployment({ properties: { model: { format: "anthropic", name: "claude-opus-4-8" }, provisioningState: "Succeeded" } });
    assert.equal(wireFormatOf(d), WIRE.ANTHROPIC);
  });

  test("a Claude model whose format field is missing is still Anthropic", () => {
    // Guessing from the format alone fails closed into the wrong route, which is the one
    // outcome that produces an opaque 404 for a participant.
    const d = deployment({ properties: { model: { name: "claude-haiku-4-5" }, provisioningState: "Succeeded" } });
    assert.equal(wireFormatOf(d), WIRE.ANTHROPIC);
  });

  test("an unrecognised format is unknown rather than assumed to be OpenAI", () => {
    const d = deployment({ properties: { model: { format: "Cohere", name: "command-r" }, provisioningState: "Succeeded" } });
    assert.equal(wireFormatOf(d), WIRE.UNKNOWN);
  });

  test("junk never reads as a usable format", () => {
    for (const value of [null, undefined, {}, "deepseek", 42]) {
      assert.equal(wireFormatOf(value), WIRE.UNKNOWN);
    }
  });
});

describe("the catalogue spans every Foundry account in the subscription", () => {
  const accounts = [
    {
      name: "foundry-plus-resource",
      resourceGroup: "rg-contosohub",
      location: "eastus2",
      deployments: [deployment(), claude()],
    },
    {
      name: "foundry-west",
      resourceGroup: "rg-west",
      location: "westus",
      deployments: [deployment({ name: "deepseek-v4-pro" })],
    },
  ];

  test("every deployment from every account appears once", () => {
    const list = buildCatalogue(accounts);
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((d) => d.deployment).sort(),
      ["claude-sonnet-4-6", "deepseek-v4-flash", "deepseek-v4-pro"]
    );
  });

  test("each entry carries the account it came from — two accounts can use the same name", () => {
    const list = buildCatalogue(accounts);
    const flash = list.find((d) => d.deployment === "deepseek-v4-flash");
    assert.equal(flash.account, "foundry-plus-resource");
    assert.equal(flash.resourceGroup, "rg-contosohub");
  });

  test("each entry carries its wire format and the route that serves it", () => {
    const list = buildCatalogue(accounts);
    const c = list.find((d) => d.deployment === "claude-sonnet-4-6");
    assert.equal(c.wire, WIRE.ANTHROPIC);
    assert.equal(c.route, "claude");

    const f = list.find((d) => d.deployment === "deepseek-v4-flash");
    assert.equal(f.route, "openai");
  });

  test("a deployment that is not Succeeded is listed but marked not ready", () => {
    const list = buildCatalogue([
      {
        name: "a",
        resourceGroup: "rg",
        deployments: [
          deployment({ name: "half-built", properties: { model: { format: "DeepSeek", name: "X" }, provisioningState: "Creating" } }),
        ],
      },
    ]);
    assert.equal(list.length, 1, "hiding it makes it look like it does not exist");
    assert.equal(list[0].ready, false);
  });

  test("an account with no deployments contributes nothing and does not throw", () => {
    assert.deepEqual(buildCatalogue([{ name: "empty", resourceGroup: "rg", deployments: [] }]), []);
    assert.deepEqual(buildCatalogue([{ name: "empty", resourceGroup: "rg" }]), []);
  });

  test("no accounts at all yields an empty catalogue", () => {
    assert.deepEqual(buildCatalogue([]), []);
    assert.deepEqual(buildCatalogue(null), []);
  });
});

describe("a pin may not cross routes", () => {
  test("a Claude deployment cannot be pinned to the OpenAI route", () => {
    const entry = buildCatalogue([{ name: "a", resourceGroup: "rg", deployments: [claude()] }])[0];
    const verdict = canPin(entry, "openai");
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /Anthropic|Messages/i);
  });

  test("a DeepSeek deployment cannot be pinned to the Claude route", () => {
    const entry = buildCatalogue([{ name: "a", resourceGroup: "rg", deployments: [deployment()] }])[0];
    const verdict = canPin(entry, "claude");
    assert.equal(verdict.allowed, false);
  });

  test("each is allowed on its own route", () => {
    const [d, c] = buildCatalogue([{ name: "a", resourceGroup: "rg", deployments: [deployment(), claude()] }]);
    assert.equal(canPin(d, "openai").allowed, true);
    assert.equal(canPin(c, "claude").allowed, true);
  });

  test("a model of unknown format is refused on both routes rather than guessed", () => {
    const entry = buildCatalogue([
      { name: "a", resourceGroup: "rg", deployments: [deployment({ properties: { model: { format: "Cohere", name: "command-r" }, provisioningState: "Succeeded" } })] },
    ])[0];
    assert.equal(canPin(entry, "openai").allowed, false);
    assert.equal(canPin(entry, "claude").allowed, false);
  });

  test("a deployment that is not ready is refused — it would 404 until it finishes", () => {
    const entry = buildCatalogue([
      { name: "a", resourceGroup: "rg", deployments: [deployment({ properties: { model: { format: "DeepSeek", name: "X" }, provisioningState: "Creating" } })] },
    ])[0];
    assert.equal(canPin(entry, "openai").allowed, false);
    assert.match(entry.state, /Creating/);
  });
});

describe("routeFor maps a wire format to the route that serves it", () => {
  test("the Anthropic Messages format is served by the Claude route", () => {
    assert.equal(routeFor(WIRE.ANTHROPIC), "claude");
  });
  test("the OpenAI format is served by the OpenAI route", () => {
    assert.equal(routeFor(WIRE.OPENAI), "openai");
  });
  test("an unknown format has no route", () => {
    assert.equal(routeFor(WIRE.UNKNOWN), null);
    assert.equal(routeFor("nonsense"), null);
  });
});

describe("maps from different routes merge into one lookup", () => {
  /**
   * There is one map per route. Anything that has to answer "is this alias configured at all?"
   * — key diagnosis, for one — must see every route's map, or it reports a perfectly good
   * Claude alias as unconfigured. That is the confidently wrong answer the diagnosis tool
   * exists to prevent.
   */
  test("an alias from either map resolves", () => {
    const merged = mergeModelMaps("flash=deepseek-v4-flash", "sonnet=claude-sonnet-4-6");
    const map = parseModelMap(merged);
    assert.equal(resolveAlias(map, "flash"), "deepseek-v4-flash");
    assert.equal(resolveAlias(map, "sonnet"), "claude-sonnet-4-6");
  });

  test("an empty map contributes nothing and leaves no stray separator", () => {
    const merged = mergeModelMaps("", "sonnet=claude-sonnet-4-6", EMPTY_MAP);
    assert.equal(Object.keys(parseModelMap(merged)).length, 1);
    assert.equal(resolveAlias(parseModelMap(merged), "sonnet"), "claude-sonnet-4-6");
  });

  test("merging nothing yields a map with no entries rather than throwing", () => {
    assert.deepEqual(parseModelMap(mergeModelMaps()), Object.create(null));
    assert.deepEqual(parseModelMap(mergeModelMaps(null, undefined, "")), Object.create(null));
  });

  test("the first map wins a duplicate alias, matching parseModelMap", () => {
    const map = parseModelMap(mergeModelMaps("x=first", "x=second"));
    assert.equal(resolveAlias(map, "x"), "first");
  });
});

describe("the empty map is written as a separator, never as an empty string", () => {
  test("EMPTY_MAP parses to no entries", () => {
    // An APIM named value cannot reliably hold an empty string, and the removal case - where
    // the last pin for a route is taken away - is exactly when the write matters most.
    assert.deepEqual(parseModelMap(EMPTY_MAP), Object.create(null));
  });

  test("EMPTY_MAP is not an empty string", () => {
    assert.notEqual(EMPTY_MAP, "");
    assert.ok(EMPTY_MAP.length > 0);
  });
});

describe("the PowerShell transcription knows the same formats as the module", () => {
  /**
   * scripts/Models.ps1 transcribes this module. The drift that matters is a model format known
   * to one side and not the other: a format missing from the script reads as `unknown` and
   * becomes unpinnable, and a format missing from the module silently routes a model to an
   * endpoint that cannot serve it.
   */
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ps = fs.readFileSync(path.join(root, "scripts/Models.ps1"), "utf8");

  const psFormats = new Set(
    (ps.match(/\$script:OpenAiFormats\s*=\s*@\(([^)]*)\)/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean)
  );

  test("the script declares a format list at all — otherwise this proves nothing", () => {
    assert.ok(psFormats.size >= 3, `Found ${psFormats.size} formats in Models.ps1.`);
  });

  test("both sides accept the same OpenAI-shaped model formats", () => {
    // Derived from the module rather than hardcoded, so adding a format in one place fails here.
    const jsFormats = new Set(
      ["openai", "deepseek", "meta", "mistral ai", "mistral", "microsoft", "xai", "ai21 labs", "anthropic", "cohere"].filter(
        (f) =>
          wireFormatOf({ properties: { model: { format: f, name: "x" } } }) === WIRE.OPENAI
      )
    );
    assert.deepEqual(
      [...psFormats].sort(),
      [...jsFormats].sort(),
      "scripts/Models.ps1 and src/foundry.mjs disagree about which formats are OpenAI-shaped."
    );
  });

  test("both sides treat Anthropic as the Messages format", () => {
    assert.match(ps, /anthropic-messages/, "Models.ps1 has no Anthropic wire format.");
    assert.equal(wireFormatOf({ properties: { model: { format: "Anthropic", name: "x" } } }), WIRE.ANTHROPIC);
  });

  test("both sides route a Claude-named model by name when the format is missing", () => {
    assert.match(
      ps,
      /\$name\.StartsWith\('claude'\)/,
      "Models.ps1 does not fall back to the model name, so a Claude deployment with no format " +
      "field would be routed to the OpenAI endpoint."
    );
  });
});

describe("the suggested alias is short, legal and stable", () => {
  test("a DeepSeek deployment name loses its prefix", () => {
    assert.equal(suggestAlias("deepseek-v4-flash"), "flash");
  });

  test("a Claude deployment keeps a recognisable short name", () => {
    assert.equal(suggestAlias("claude-sonnet-4-6"), "sonnet");
    assert.equal(suggestAlias("claude-opus-4-8"), "opus");
    assert.equal(suggestAlias("claude-haiku-4-5"), "haiku");
  });

  test("an alias never contains the map's structural separators", () => {
    // `;` and `=` would split the model map. See ADR-0007.
    for (const name of ["weird;name", "a=b", "x;y=z"]) {
      const alias = suggestAlias(name);
      assert.ok(!alias.includes(";") && !alias.includes("="), `${alias} would corrupt the map`);
    }
  });

  test("an unrecognised name is lowercased and passed through", () => {
    assert.equal(suggestAlias("My-Model"), "my-model");
  });

  test("an empty or junk name yields an empty alias rather than throwing", () => {
    for (const value of ["", null, undefined, 42]) {
      assert.equal(suggestAlias(value), "");
    }
  });
});
