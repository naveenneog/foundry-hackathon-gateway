# ADR-0009 — Claude Code connects as a plain Anthropic gateway, not through Foundry mode

**Status:** Accepted
**Date:** 2026-10-03
**Packet:** P17

## Context

Claude models in Microsoft Foundry are served on a different endpoint, in a different wire
format, from everything else this gateway fronts:

| | OpenAI route | Claude route |
|---|---|---|
| Backend | `https://<acct>.openai.azure.com/openai/v1` | `https://<acct>.services.ai.azure.com/anthropic` |
| Format | OpenAI Chat Completions | Anthropic Messages |
| Endpoint | `POST /chat/completions` | `POST /v1/messages` |

Claude Code can reach a gateway three ways, and the choice determines what a participant must
have on their machine:

1. **Foundry mode** — `CLAUDE_CODE_USE_FOUNDRY=1` + `ANTHROPIC_FOUNDRY_BASE_URL`. Claude Code
   obtains a Microsoft Entra token, normally from `az login`.
2. **Bedrock / Agent Platform mode** — not applicable.
3. **Anthropic Messages mode** — `ANTHROPIC_BASE_URL` + a credential variable. Claude Code treats
   the gateway as the Claude API and cannot tell what is behind it.

The sibling project `claude-code-foundry-gateway` uses option 1, correctly: it solves the
enterprise case, where every developer already has an Entra identity and per-person attribution
should follow it.

## Decision

**Option 3.** Participants set:

```
ANTHROPIC_BASE_URL  = https://<apim>.azure-api.net/claude
ANTHROPIC_AUTH_TOKEN = <the participant key>
ANTHROPIC_MODEL      = <an alias their key grants>
```

Three reasons, in order of weight.

**1. Foundry mode needs an Azure identity on the participant's machine.** That is the charter's
central non-goal. Participants are external, short-lived, and on machines nobody manages; the
whole point of this gateway is that a key is the entitlement and no Azure credential leaves
Azure. Option 1 would require giving every participant a tenant identity, which is slower to
arrange than the event is long.

**2. `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer`**, which is exactly what
`validate-jwt` already reads. The same key, the same minting path and the same controls work on
both routes, with no second credential type. `ANTHROPIC_API_KEY` would arrive as `x-api-key`
instead — which is why the participant card names the variable explicitly; the same key in the
wrong variable produces a bare 401.

**3. Anthropic documents this shape for a gateway in front of Foundry.** "Microsoft Foundry and
the Claude Platform on AWS implement the Anthropic Messages format. Claude Code routes to them
through their own variables […] but **a gateway fronting either implements the Anthropic Messages
row above**."

## What the gateway therefore owes a client

A client in this mode believes it is talking to the Claude API, so the gateway has to behave like
it in the ways a client depends on:

| Requirement | Consequence of getting it wrong |
|---|---|
| `POST /v1/messages` | Nothing works |
| `POST /v1/messages/count_tokens` | Claude Code shows a character-based context estimate |
| Errors as `{"type":"error","error":{"type":…,"message":…}}` | A spent budget reads as a malformed response |
| Forward `anthropic-version` and `anthropic-beta` unchanged | Features of a given Claude Code release break silently |
| Relay the stream; never buffer | Claude Code stalls |
| Keep bytes flowing | The client aborts after five minutes of silence |

The gateway's own reason (`budget_exhausted`, `model_not_permitted`) has no field in the Anthropic
error object, so it leads the message instead. `src/anthropic.mjs` holds the envelope, the
`max_tokens` clamp and the quota-error detection; `infra/policy-claude.xml` transcribes them.

## Consequences

**Positive**
- One key, two routes, one budget. The budget counter is keyed on `sub`, so a participant cannot
  double their allowance by using both.
- Nothing Azure-specific reaches a participant machine. Two environment variables and a model
  name, the same shape as the opencode handout.
- Claude Code cannot tell it is not talking to Anthropic, so features keep working across
  releases as long as the headers are forwarded.

**Negative**
- Per-participant attribution comes from the key, not an Entra identity. Correct for an event,
  wrong for an enterprise — which is what the sibling project is for.
- **A participant must set `ANTHROPIC_MODEL`, and the alias must not be `sonnet`, `opus` or
  `haiku`.** Verified live 2026-10-04: Claude Code resolves those three *client-side* to its own
  default model ids, so `ANTHROPIC_MODEL=sonnet` left the machine as `claude-sonnet-5` and the
  gateway refused it. `ANTHROPIC_MODEL=sonnet-5` was sent literally and worked. `suggestAlias`
  therefore keeps the version, and pinning a reserved name to the Claude route is refused.
- **A machine that already has Claude Code configured overrides the participant's variables.** A
  `settings.json` carrying `model`, `ANTHROPIC_DEFAULT_*_MODEL` or `CLAUDE_CODE_USE_FOUNDRY` wins
  over the environment, and requests go to the old destination. Observed on the development
  machine, which was configured for the sibling project's Foundry mode: three attempts failed
  before the profile was isolated. The participant card names the symptom and the fix.
- Claude Code assumes a 200K context window for an unrecognised model id such as a short alias,
  and says so on every session. It under-reports a 1M-window model rather than over-reporting,
  so it fails safe.
- The route needs a v2 API Management tier. `llm-token-limit` parses the Anthropic Messages shape
  on v2 tiers only; on a classic tier it meters zero and the budget never fires, so the route is
  simply not published there (UNKNOWNS U12).
- **Streamed completions are not metered on this route** (UNKNOWNS U15). Claude Code always
  streams, so the budget runs behind real spend. Bounded, but not a billing control.

## References

- [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol) (retrieved 2026-10-03)
- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect) (retrieved 2026-10-03)
- [Deploy and use Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude) (retrieved 2026-10-03)
- [llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy) (retrieved 2026-10-03)
- UNKNOWNS U9 (backend audience), U11 (quota error shape), U12 (tier), U13 (model ids)
