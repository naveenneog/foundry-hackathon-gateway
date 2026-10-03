/**
 * The Anthropic Messages wire format, as this gateway has to speak it.
 *
 * A client pointed at the Claude route believes it is talking to the Claude API. It parses
 * `{"type":"error","error":{"type":...,"message":...}}` and nothing else, so an OpenAI-shaped
 * error body arrives as a parse failure: the participant is told the response was malformed
 * rather than that their budget is spent.
 *
 * Two things follow, and both are transcribed into infra/policy-claude.xml:
 *
 *  1. Every rejection this gateway writes uses the envelope below. The gateway's own reason
 *     (`budget_exhausted`, `model_not_permitted`) has no field in that envelope, so it leads the
 *     message instead — it is the first thing a participant reads in Claude Code's error.
 *
 *  2. APIM's `llm-token-limit` returns its OWN body when a quota is exceeded, and that body is
 *     OpenAI-shaped whatever the route speaks. It has to be recognised and rewritten on the way
 *     out. See UNKNOWNS U11.
 *
 * Sources: https://docs.claude.com/en/api/errors ·
 *          https://code.claude.com/docs/en/llm-gateway-protocol
 */

/** The version Claude Code sends, and the one the gateway supplies when a caller omits it. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Status code -> the error type the Anthropic SDKs recognise. */
const TYPE_FOR_STATUS = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

/**
 * The Anthropic error type for an HTTP status.
 * An unmapped status is `api_error` rather than an invented type, because a type the SDK does
 * not know is handled as an unparseable response.
 */
export function anthropicType(status) {
  return TYPE_FOR_STATUS[Number(status)] ?? "api_error";
}

/**
 * Build the error envelope.
 *
 * @param {number} status  the HTTP status being returned
 * @param {string} code    this gateway's own reason, e.g. "budget_exhausted"
 * @param {string} message what the participant should read
 */
export function anthropicError(status, code, message) {
  const reason = typeof code === "string" && code.trim() !== "" ? `${code.trim()}: ` : "";
  return {
    type: "error",
    error: {
      type: anthropicType(status),
      message: `${reason}${String(message ?? "")}`,
    },
  };
}

/** The envelope, serialised. */
export function anthropicErrorJson(status, code, message) {
  return JSON.stringify(anthropicError(status, code, message));
}

/**
 * Rewrite a Messages request for the backend: the alias becomes the real deployment name, and
 * the completion length is capped.
 *
 * `max_tokens` is REQUIRED by the Messages API, so an absent or unusable value becomes the cap
 * rather than being left out. There is no `n` here — that is an OpenAI concept, and sending it
 * would be rejected.
 *
 * @param {object} body
 * @param {{deployment: string, maxOutputTokens: number}} options
 */
export function clampMessagesBody(body, { deployment, maxOutputTokens }) {
  const out = { ...(body ?? {}) };
  out.model = deployment;

  const cap = Number(maxOutputTokens);
  const requested = Number(out.max_tokens);
  out.max_tokens =
    Number.isInteger(requested) && requested > 0 && requested <= cap ? requested : cap;

  return out;
}

/**
 * Rewrite a count_tokens request for the backend.
 *
 * Only the model. `max_tokens` is required by /v1/messages and is NOT part of the
 * /v1/messages/count_tokens schema; the Messages API rejects unknown body fields, so adding it
 * turns every token count into a 400. One policy serves both operations, so the difference has
 * to be explicit.
 *
 * https://docs.claude.com/en/api/messages-count-tokens
 */
export function rewriteCountTokensBody(body, { deployment }) {
  const out = { ...(body ?? {}) };
  out.model = deployment;
  delete out.max_tokens;
  return out;
}

/**
 * Whether a response body is APIM's own OpenAI-shaped quota error.
 *
 * Deliberately narrow: it matches the quota body's shape, not any body containing the word
 * "quota", so a model's own response can never be rewritten as a gateway error.
 */
export function looksLikeApimQuotaError(bodyText) {
  if (typeof bodyText !== "string" || bodyText.trim() === "") return false;
  if (bodyText.includes('"type":"error"')) return false;
  return /"statusCode"\s*:\s*403/.test(bodyText) && /quota is exceeded/i.test(bodyText);
}
