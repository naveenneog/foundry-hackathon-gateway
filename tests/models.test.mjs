import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseModelMap, resolveAlias, buildModelMap, ModelMapError } from "../src/models.mjs";

/**
 * The alias -> Foundry deployment map.
 *
 * APIM named values are substituted at policy COMPILE time, not at runtime, so a policy cannot
 * do {{model-}} + alias. The documented workaround is to hold every value in one named value
 * and parse it with a policy expression — which is what this module defines, and what
 * infra/policy.xml transcribes.
 *
 * Wire format:  alias=deployment;alias=deployment
 *
 * This is the canonical implementation. If you change it, change the policy too.
 */

/**
 * parseModelMap returns a null-prototype object so that inherited names like "constructor"
 * cannot masquerade as configured models. assert.deepEqual compares prototypes, so spread into
 * a plain object to compare the actual contract: the own enumerable pairs.
 */
const pairs = (map) => ({ ...map });

describe("parseModelMap", () => {
  test("returns a null-prototype object, so inherited names cannot pose as models", () => {
    assert.equal(Object.getPrototypeOf(parseModelMap("a=b")), null);
  });

  test("parses a single pair", () => {
    assert.deepEqual(pairs(parseModelMap("flash=deepseek-v4-flash")), { flash: "deepseek-v4-flash" });
  });

  test("parses several pairs", () => {
    assert.deepEqual(
      pairs(parseModelMap("flash=deepseek-v4-flash;pro=deepseek-v4-pro;llama=llama-3.3-70b")),
      { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro", llama: "llama-3.3-70b" }
    );
  });

  test("lowercases aliases but preserves deployment-name casing", () => {
    // Foundry deployment names are case sensitive; aliases are a UX affordance and are not.
    assert.deepEqual(pairs(parseModelMap("Flash=DeepSeek-V4-Flash")), { flash: "DeepSeek-V4-Flash" });
  });

  test("tolerates whitespace and stray separators", () => {
    assert.deepEqual(
      pairs(parseModelMap("  flash = deepseek-v4-flash ; ; pro=deepseek-v4-pro ;  ")),
      { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" }
    );
  });

  test("skips malformed entries rather than throwing", () => {
    // A malformed entry must not take out the whole map and strand every participant.
    assert.deepEqual(pairs(parseModelMap("flash=deepseek-v4-flash;garbage;=nope;alsobad=")), {
      flash: "deepseek-v4-flash",
    });
  });

  test("first definition wins on a duplicate alias", () => {
    assert.deepEqual(pairs(parseModelMap("flash=first;flash=second")), { flash: "first" });
  });

  test("returns an empty map for empty or missing input", () => {
    for (const v of ["", "   ", null, undefined]) {
      assert.deepEqual(pairs(parseModelMap(v)), {}, `input ${JSON.stringify(v)}`);
    }
  });

  test("keeps deployment names containing dots and dashes intact", () => {
    assert.deepEqual(pairs(parseModelMap("g=gpt-4.1-mini-2026")), { g: "gpt-4.1-mini-2026" });
  });
});

describe("resolveAlias", () => {
  const map = parseModelMap("flash=deepseek-v4-flash;pro=deepseek-v4-pro");

  test("resolves a known alias", () => {
    assert.equal(resolveAlias(map, "flash"), "deepseek-v4-flash");
  });

  test("is case insensitive", () => {
    assert.equal(resolveAlias(map, "FLASH"), "deepseek-v4-flash");
    assert.equal(resolveAlias(map, "Pro"), "deepseek-v4-pro");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(resolveAlias(map, "  flash  "), "deepseek-v4-flash");
  });

  test("returns null for an unknown alias", () => {
    assert.equal(resolveAlias(map, "gpt-4o"), null);
  });

  test("returns null for empty or non-string input", () => {
    for (const v of ["", null, undefined, 42, {}]) {
      assert.equal(resolveAlias(map, v), null, `input ${JSON.stringify(v)}`);
    }
  });

  test("does not resolve through inherited object properties", () => {
    // "constructor" and friends exist on every object; they must not look like models.
    assert.equal(resolveAlias(map, "constructor"), null);
    assert.equal(resolveAlias(map, "toString"), null);
    assert.equal(resolveAlias(map, "__proto__"), null);
  });
});

describe("buildModelMap", () => {
  test("serialises pairs into the wire format", () => {
    assert.equal(
      buildModelMap([
        { alias: "flash", deployment: "deepseek-v4-flash" },
        { alias: "pro", deployment: "deepseek-v4-pro" },
      ]),
      "flash=deepseek-v4-flash;pro=deepseek-v4-pro"
    );
  });

  test("round-trips through parseModelMap", () => {
    const pairs = [
      { alias: "flash", deployment: "deepseek-v4-flash" },
      { alias: "pro", deployment: "DeepSeek-V4-Pro" },
      { alias: "llama", deployment: "llama-3.3-70b-instruct" },
    ];
    const parsed = parseModelMap(buildModelMap(pairs));
    for (const p of pairs) {
      assert.equal(parsed[p.alias], p.deployment);
    }
  });

  test("lowercases aliases on the way in", () => {
    assert.equal(buildModelMap([{ alias: "Flash", deployment: "d" }]), "flash=d");
  });

  describe("rejects input that would corrupt the wire format", () => {
    const bad = [
      ["alias containing =", { alias: "fl=ash", deployment: "d" }],
      ["alias containing ;", { alias: "fl;ash", deployment: "d" }],
      ["deployment containing =", { alias: "f", deployment: "d=x" }],
      ["deployment containing ;", { alias: "f", deployment: "d;x" }],
      ["empty alias", { alias: "", deployment: "d" }],
      ["empty deployment", { alias: "f", deployment: "" }],
      ["whitespace-only alias", { alias: "   ", deployment: "d" }],
    ];
    for (const [name, pair] of bad) {
      test(name, () => {
        assert.throws(() => buildModelMap([pair]), ModelMapError);
      });
    }
  });

  test("rejects duplicate aliases", () => {
    // Two entries for one alias means a participant's model silently depends on parse order.
    assert.throws(
      () => buildModelMap([
        { alias: "flash", deployment: "a" },
        { alias: "FLASH", deployment: "b" },
      ]),
      ModelMapError
    );
  });

  test("rejects an empty model list", () => {
    assert.throws(() => buildModelMap([]), ModelMapError);
  });
});

describe("the map and the entitlement engine agree", () => {
  test("a key may only use aliases that exist in the map", async () => {
    const { decide, DENY } = await import("../src/entitlement.mjs");
    const map = parseModelMap("flash=deepseek-v4-flash;pro=deepseek-v4-pro");

    const grant = {
      sub: "t", jti: "k", models: ["flash", "llama"],
      notBefore: 0, expiresAt: Date.now() + 3600_000, budget: 1000,
    };

    // Granted AND in the map -> allowed, and resolvable.
    const ok = decide({ grant, model: "flash", now: Date.now(), consumed: 0, revoked: [] });
    assert.equal(ok.allow, true);
    assert.equal(resolveAlias(map, "flash"), "deepseek-v4-flash");

    // Granted but NOT in the map -> the gateway must not forward it blindly.
    const orphan = decide({ grant, model: "llama", now: Date.now(), consumed: 0, revoked: [] });
    assert.equal(orphan.allow, true, "entitlement only checks the grant");
    assert.equal(resolveAlias(map, "llama"), null, "but the map cannot resolve it, so the policy 403s");
  });
});
