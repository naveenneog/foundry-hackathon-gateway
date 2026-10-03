import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Claude route: the Anthropic Messages API, governed by the same key.
 *
 * A participant sets ANTHROPIC_BASE_URL to this gateway and ANTHROPIC_AUTH_TOKEN to their key.
 * Claude Code then treats the gateway as the Claude API and cannot tell what is behind it, so
 * the gateway has to behave like the Claude API in the ways a client actually depends on:
 * the Messages endpoints, Anthropic-shaped errors, forwarded version and beta headers, and a
 * stream that is relayed rather than buffered.
 *
 * Sources: https://code.claude.com/docs/en/llm-gateway-protocol ·
 *          https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = fs.readFileSync(path.join(root, "infra/policy-claude.xml"), "utf8");
const bicep = fs.readFileSync(path.join(root, "infra/main.bicep"), "utf8");
const code = policy.replace(/<!--[\s\S]*?-->/g, "");

describe("the gateway publishes the endpoints a Claude client calls", () => {
  test("the API is published at the `claude` path", () => {
    assert.match(bicep, /path: claudeApiPath/);
    assert.match(bicep, /var claudeApiPath = 'claude'/);
  });

  test("POST /v1/messages exists — without it nothing works at all", () => {
    assert.match(bicep, /urlTemplate: '\/v1\/messages'/);
  });

  test("POST /v1/messages/count_tokens exists", () => {
    // Optional per the protocol, but without it Claude Code falls back to a character-based
    // estimate of context usage, which it then shows the participant.
    assert.match(bicep, /urlTemplate: '\/v1\/messages\/count_tokens'/);
  });

  test("the backend is the Foundry Anthropic endpoint", () => {
    assert.match(bicep, /anthropic/i);
    assert.match(
      bicep,
      /serviceUrl: claudeServiceUrl/,
      "The Claude API must point at the /anthropic endpoint, not the /openai/v1 one."
    );
  });

  test("the backend host is read from the account rather than assumed", () => {
    // A Foundry account's published endpoint and its resource name can differ. The existing
    // OpenAI route already learned this: it builds from customSubDomainName, not the name.
    assert.match(
      bicep,
      /foundry\.properties\.endpoints/,
      "The endpoint should come from the account's own published endpoints."
    );
    assert.match(
      bicep,
      /anthropic'/,
      "The Anthropic surface hangs off that published base."
    );
  });
});

describe("the same key controls this route", () => {
  test("the participant JWT is validated with the same signing key", () => {
    assert.match(code, /<validate-jwt/);
    assert.match(code, /\{\{hackgw-signing-key\}\}/);
  });

  test("the issuer and audience match the ones the minter writes", () => {
    assert.match(code, /<audience>hackathon-gateway<\/audience>/);
    assert.match(code, /<issuer>foundry-hackathon-gateway<\/issuer>/);
  });

  test("revocation is checked with sentinel commas, so one id cannot revoke a longer one", () => {
    assert.match(code, /\{\{hackgw-revoked-keys\}\}/);
    assert.match(code, /","\s*\+.*\+\s*","/s);
  });

  test("the model allowlist comes from the signed claim", () => {
    assert.match(code, /grantedModels/);
  });

  test("the one-time budget is enforced", () => {
    assert.match(code, /<llm-token-limit/);
    assert.match(code, /token-quota=/);
  });

  test("the alias is resolved from this route's own map", () => {
    assert.match(
      code,
      /\{\{hackgw-claude-model-map\}\}/,
      "The Claude route must use its own map: an alias pinned for the OpenAI route names a " +
      "deployment this backend cannot serve."
    );
  });

  test("usage is attributed per participant", () => {
    assert.match(code, /<llm-emit-token-metric/);
  });
});

describe("every error this route returns is Anthropic-shaped", () => {
  /**
   * An Anthropic client parses {"type":"error","error":{"type":...,"message":...}} and nothing
   * else. An OpenAI-shaped body reaches Claude Code as a malformed response, so a participant
   * whose budget is spent is told the stream broke.
   */
  const bodies = [...code.matchAll(/<set-body>([\s\S]*?)<\/set-body>/g)].map((m) => m[1]);
  const errorBodies = bodies.filter((b) => /error/i.test(b));

  test("the policy returns error bodies at all — otherwise this proves nothing", () => {
    assert.ok(errorBodies.length >= 4, `Found ${errorBodies.length} error bodies in the policy.`);
  });

  for (const [i, body] of errorBodies.entries()) {
    test(`error body ${i + 1} uses the Anthropic envelope`, () => {
      assert.match(
        body,
        /"type"\s*,?\s*"error"|"type":"error"/,
        `This body is not wrapped in {"type":"error",...}:\n${body.trim().slice(0, 200)}`
      );
    });

    test(`error body ${i + 1} carries no OpenAI-only fields`, () => {
      assert.ok(
        !/"code"\s*:\s*"/.test(body),
        `The Anthropic error object has no "code" field; the reason belongs in the message:\n${body.trim().slice(0, 200)}`
      );
    });
  }

  test("APIM's own quota error is rewritten where it actually lands", () => {
    // llm-token-limit RAISES an error rather than returning a response, and a policy error
    // jumps straight to on-error — <outbound> never runs. An earlier revision put the rewrite
    // in outbound, where it could never have fired. See UNKNOWNS U11.
    const onError = code.match(/<on-error>[\s\S]*<\/on-error>/)?.[0] ?? "";
    assert.match(onError, /QuotaExceeded/, "The budget rejection is not handled in on-error.");
    assert.match(onError, /budget_exhausted/);
    assert.ok(
      !/<outbound>[\s\S]*quota is exceeded[\s\S]*<\/outbound>/i.test(code),
      "A quota rewrite in outbound is dead code: the error never reaches that section."
    );
  });

  test("on-error uses return-response, because set-body alone is not legal there", () => {
    // https://learn.microsoft.com/en-us/azure/api-management/api-management-error-handling-policies
    // lists what on-error permits. set-body is absent; a policy document using it fails
    // validation on deployment, taking the whole template with it.
    const onError = code.match(/<on-error>[\s\S]*<\/on-error>/)?.[0] ?? "";
    assert.ok(onError.length > 0, "There is no on-error section.");
    const stripped = onError.replace(/<return-response>[\s\S]*?<\/return-response>/g, "");
    assert.ok(
      !/<set-body>/.test(stripped),
      "on-error has a set-body outside a return-response, which APIM rejects at deployment time."
    );
  });

  test("the count_tokens operation does not get max_tokens injected", () => {
    // max_tokens is required by /v1/messages and is not part of the count_tokens schema. The
    // Messages API rejects unknown body fields, so injecting it makes every token count a 400.
    assert.match(
      code,
      /context\.Operation\.Id == "count-tokens"/,
      "The body rewrite does not distinguish the two operations."
    );
    assert.match(code, /body\.Remove\("max_tokens"\)/);
  });
});

describe("the protocol requirements a gateway must meet", () => {
  test("the request body is not buffered — Claude Code stalls on a buffered stream", () => {
    assert.match(code, /buffer-request-body="false"/);
  });

  test("anthropic-version and anthropic-beta are never deleted", () => {
    // They must reach the upstream unchanged: stripping anthropic-beta breaks the capabilities
    // a Claude Code release depends on, and the set changes with every release.
    for (const header of ["anthropic-version", "anthropic-beta"]) {
      assert.ok(
        !new RegExp(`<set-header name="${header}"[^>]*exists-action="delete"`, "i").test(code),
        `${header} is deleted, which breaks the features that depend on it.`
      );
    }
  });

  test("the participant's own token is replaced by the gateway identity", () => {
    assert.match(code, /<authentication-managed-identity/);
    assert.match(
      code,
      /resource="https:\/\/ai\.azure\.com"/,
      "The audience must be https://ai.azure.com — see UNKNOWNS U9."
    );
  });

  test("the api-key header is stripped, so no participant credential reaches Foundry", () => {
    assert.match(code, /<set-header name="api-key" exists-action="delete"/);
  });

  test("the timeout is long enough for an agent turn", () => {
    const m = code.match(/forward-request timeout="(\d+)"/);
    assert.ok(m, "No forward-request timeout is set.");
    assert.ok(Number(m[1]) >= 300, `A ${m[1]}s timeout is short for a thinking model's turn.`);
  });
});

describe("the participant handout configures Claude Code correctly", () => {
  /**
   * The single most likely way a participant fails: putting a perfectly good key in
   * ANTHROPIC_API_KEY. That is sent as `x-api-key`; this gateway validates
   * `Authorization: Bearer`, which is what ANTHROPIC_AUTH_TOKEN produces. The result is a bare
   * 401 with nothing to go on.
   *
   * https://code.claude.com/docs/en/llm-gateway-connect
   */
  const keys = fs.readFileSync(path.join(root, "scripts/Keys.ps1"), "utf8");

  test("it writes a settings file, which is what reaches background agents", () => {
    assert.match(keys, /\.claude/);
    assert.match(keys, /settings\.json/);
  });

  test("the credential goes in ANTHROPIC_AUTH_TOKEN", () => {
    assert.match(keys, /ANTHROPIC_AUTH_TOKEN\s*=\s*\$Token/);
  });

  test("ANTHROPIC_API_KEY is never set to the key", () => {
    assert.ok(
      !/ANTHROPIC_API_KEY\s*=\s*\$Token/.test(keys),
      "That variable is sent as x-api-key and the gateway would reject it."
    );
  });

  test("the base URL and a model are set too", () => {
    assert.match(keys, /ANTHROPIC_BASE_URL/);
    assert.match(
      keys,
      /ANTHROPIC_MODEL/,
      "Without it Claude Code sends its own default model id, which is not an alias here."
    );
  });

  test("the card explains the variable that catches people out", () => {
    assert.match(keys, /ANTHROPIC_AUTH_TOKEN``, not ``ANTHROPIC_API_KEY/);
  });
});

describe("the route can be left out of a deployment that cannot serve it", () => {
  test("a parameter controls whether the Claude route is deployed", () => {
    // A classic-tier instance meters zero Anthropic tokens, so deploying this route onto one
    // would publish a budget that silently never fires. See UNKNOWNS U12.
    assert.match(bicep, /param deployClaudeRoute bool/);
  });

  test("every Claude resource is conditional on it", () => {
    const blocks = bicep.split(/\n(?=resource |module )/);
    const claudeBlocks = blocks.filter((b) => /^resource claude/i.test(b));
    assert.ok(claudeBlocks.length >= 4, `Found ${claudeBlocks.length} Claude resources.`);
    const unconditional = claudeBlocks
      .filter((b) => !/= if \(claudeRouteEnabled\)/.test(b))
      .map((b) => b.split("\n")[0].trim());
    assert.deepEqual(unconditional, [], `${unconditional.join(" | ")} deploy unconditionally.`);
  });

  test("the template refuses the route on a tier that cannot meter it", () => {
    // admin.ps1 checks too, but a direct `az deployment group create` bypasses it entirely.
    assert.match(bicep, /var claudeTierOk = .*endsWith\(toLower\(apimSku\), 'v2'\)/);
    assert.match(bicep, /var claudeRouteEnabled = deployClaudeRoute && claudeTierOk/);
  });
});
