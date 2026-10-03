import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  anthropicType,
  anthropicError,
  anthropicErrorJson,
  clampMessagesBody,
  rewriteCountTokensBody,
  looksLikeApimQuotaError,
  ANTHROPIC_VERSION,
} from "../src/anthropic.mjs";

/**
 * The Claude route speaks the Anthropic Messages API, not OpenAI Chat Completions.
 *
 * That is not a detail. A client pointed at this gateway believes it is talking to the Claude
 * API: it parses `{"type":"error","error":{"type":...,"message":...}}` and nothing else. An
 * OpenAI-shaped error body reaches Claude Code as a parse failure, so the participant is told
 * the response was malformed rather than that their budget is spent.
 *
 * APIM makes this worse in one specific place: `llm-token-limit` returns its OWN body when a
 * quota is exceeded, and that body is OpenAI-shaped regardless of the route. See UNKNOWNS U11.
 *
 * Sources: https://docs.claude.com/en/api/errors ·
 *          https://code.claude.com/docs/en/llm-gateway-protocol
 */

describe("every status maps to a type the Anthropic SDKs know", () => {
  const KNOWN = new Set([
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "request_too_large",
    "rate_limit_error",
    "api_error",
    "overloaded_error",
  ]);

  const cases = [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [529, "overloaded_error"],
  ];

  for (const [status, type] of cases) {
    test(`${status} -> ${type}`, () => {
      assert.equal(anthropicType(status), type);
    });
  }

  test("an unmapped status falls back to api_error rather than inventing a type", () => {
    assert.equal(anthropicType(418), "api_error");
    assert.equal(anthropicType(undefined), "api_error");
  });

  test("every mapped type is one the SDKs recognise", () => {
    for (const [status] of cases) {
      assert.ok(KNOWN.has(anthropicType(status)), `${status} produced an unknown type`);
    }
  });
});

describe("the error envelope is exactly what an Anthropic client parses", () => {
  test("it has the top-level type and a nested error object", () => {
    const e = anthropicError(403, "budget_exhausted", "Your token budget is fully spent.");
    assert.equal(e.type, "error");
    assert.equal(e.error.type, "permission_error");
    assert.ok(typeof e.error.message === "string");
  });

  test("it carries no OpenAI fields — a client would ignore them anyway", () => {
    const e = anthropicError(403, "budget_exhausted", "spent");
    assert.equal(e.error.code, undefined);
    assert.equal(e.code, undefined);
    assert.deepEqual(Object.keys(e).sort(), ["error", "type"]);
  });

  test("the gateway's own reason survives in the message, because the envelope has no field for it", () => {
    const e = anthropicError(403, "budget_exhausted", "Your token budget is fully spent.");
    assert.match(e.error.message, /^budget_exhausted:/);
    assert.match(e.error.message, /fully spent/);
  });

  test("the JSON form is valid JSON and round-trips", () => {
    const json = anthropicErrorJson(401, "invalid_key", 'He said "no" \\ and left');
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, "error");
    assert.equal(parsed.error.type, "authentication_error");
    assert.match(parsed.error.message, /He said "no"/);
  });
});

describe("the request body is rewritten for the backend", () => {
  const body = () => ({ model: "sonnet", max_tokens: 64000, messages: [{ role: "user", content: "hi" }] });

  test("the alias is replaced by the real deployment name", () => {
    const out = clampMessagesBody(body(), { deployment: "claude-sonnet-4-6", maxOutputTokens: 8192 });
    assert.equal(out.model, "claude-sonnet-4-6");
  });

  test("max_tokens is clamped, so one call cannot drain a budget", () => {
    const out = clampMessagesBody(body(), { deployment: "d", maxOutputTokens: 8192 });
    assert.equal(out.max_tokens, 8192);
  });

  test("a request under the cap keeps its own value", () => {
    const out = clampMessagesBody({ ...body(), max_tokens: 100 }, { deployment: "d", maxOutputTokens: 8192 });
    assert.equal(out.max_tokens, 100);
  });

  test("max_tokens is required by the Messages API, so a missing one becomes the cap", () => {
    const out = clampMessagesBody({ model: "sonnet", messages: [] }, { deployment: "d", maxOutputTokens: 8192 });
    assert.equal(out.max_tokens, 8192);
  });

  test("a junk max_tokens becomes the cap rather than throwing", () => {
    for (const bad of [null, "lots", -1, 0, {}, Number.NaN]) {
      const out = clampMessagesBody({ model: "s", max_tokens: bad }, { deployment: "d", maxOutputTokens: 8192 });
      assert.equal(out.max_tokens, 8192, `max_tokens ${JSON.stringify(bad)} was not clamped`);
    }
  });

  test("the rest of the body is untouched — thinking, tools and system all pass through", () => {
    const original = {
      model: "sonnet",
      max_tokens: 100,
      system: "be brief",
      thinking: { type: "adaptive" },
      tools: [{ name: "Read" }],
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const out = clampMessagesBody(original, { deployment: "d", maxOutputTokens: 8192 });
    assert.deepEqual(out.thinking, { type: "adaptive" });
    assert.deepEqual(out.tools, [{ name: "Read" }]);
    assert.equal(out.system, "be brief");
    assert.equal(out.stream, true);
    assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
  });

  test("there is no `n` field to clamp — that is an OpenAI concept", () => {
    const out = clampMessagesBody(body(), { deployment: "d", maxOutputTokens: 8192 });
    assert.equal(out.n, undefined, "adding `n` would be rejected by the Messages API");
  });
});

describe("count_tokens is not a Messages request", () => {
  /**
   * The policy is attached at API scope, so it runs for both operations. `max_tokens` is
   * required by /v1/messages and is NOT part of the /v1/messages/count_tokens schema — the
   * Messages API rejects unknown body fields, so injecting it turns every token count into a
   * 400. That is worse than not publishing the endpoint at all, which was the reason for
   * publishing it.
   */
  test("the alias is still replaced by the deployment name", () => {
    const out = rewriteCountTokensBody({ model: "sonnet", messages: [] }, { deployment: "claude-sonnet-4-6" });
    assert.equal(out.model, "claude-sonnet-4-6");
  });

  test("max_tokens is never added", () => {
    const out = rewriteCountTokensBody({ model: "sonnet", messages: [] }, { deployment: "d" });
    assert.equal("max_tokens" in out, false, "an unknown field makes the API reject the request");
  });

  test("a max_tokens the caller sent is removed rather than passed on", () => {
    const out = rewriteCountTokensBody({ model: "s", max_tokens: 10, messages: [] }, { deployment: "d" });
    assert.equal("max_tokens" in out, false);
  });

  test("everything count_tokens does accept is left alone", () => {
    const body = {
      model: "sonnet",
      system: "be brief",
      tools: [{ name: "Read" }],
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    };
    const out = rewriteCountTokensBody(body, { deployment: "d" });
    assert.equal(out.system, "be brief");
    assert.deepEqual(out.tools, [{ name: "Read" }]);
    assert.deepEqual(out.thinking, { type: "adaptive" });
    assert.deepEqual(out.messages, body.messages);
  });
});

describe("APIM's own quota error is recognised so it can be rewritten", () => {
  test("the OpenAI-shaped quota body is detected", () => {
    // Observed live on the sibling project's Anthropic route: llm-token-limit returns its own
    // body, OpenAI-shaped, whatever the route's wire format is.
    const apim = '{"statusCode":403,"message":"Token quota is exceeded. Try again later."}';
    assert.equal(looksLikeApimQuotaError(apim), true);
  });

  test("a body that is already Anthropic-shaped is left alone", () => {
    const ours = anthropicErrorJson(403, "budget_exhausted", "spent");
    assert.equal(looksLikeApimQuotaError(ours), false);
  });

  test("a normal completion is not mistaken for a quota error", () => {
    assert.equal(looksLikeApimQuotaError('{"type":"message","content":[]}'), false);
    assert.equal(looksLikeApimQuotaError(""), false);
    assert.equal(looksLikeApimQuotaError(null), false);
  });
});

describe("the API version the gateway speaks is pinned", () => {
  test("it is the version Claude Code sends", () => {
    // Claude Code sends `anthropic-version: 2023-06-01`; the gateway forwards it unchanged and
    // supplies it only when a caller omits it.
    assert.equal(ANTHROPIC_VERSION, "2023-06-01");
  });
});
