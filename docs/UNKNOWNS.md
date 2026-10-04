# Unknowns register

Ironclad rule 8: unknowns are written down *before* implementation, then closed by research with a
citation, or by an explicitly labelled assumption with its blast radius.

## Register

The gate reads this table. `OPEN` fails `--stage release` and warns at `--stage packet`; an
assumption is only closed if it names its blast radius and the detector that would catch it.

| Id | Subject | Status |
|---|---|---|
| U1 | Exact DeepSeek model names | RESOLVED |
| U2 | Foundry inference endpoint shape | RESOLVED |
| U2b | Managed identity audience, `/openai/v1` | RESOLVED |
| U3 | `llm-token-limit` parsing and APIM tier | RESOLVED |
| U4 | Credential transport | RESOLVED |
| U4b | DeepSeek tool calling | RESOLVED |
| U5 | Streaming token accounting | RESOLVED |
| U7 | Status-code consistency across budget paths | RESOLVED |
| U8 | Single-call overshoot on a small budget | MEASURED |
| U9 | Managed identity audience, `/anthropic` | RESOLVED |
| U10 | Backend host for the Claude route | RESOLVED |
| U11 | OpenAI-shaped quota error on the Anthropic route | RESOLVED |
| U12 | APIM tier required to meter Anthropic tokens | RESOLVED |
| U13 | Claude Code model ids versus gateway aliases | RESOLVED |
| U14 | Claude deployment needs provider metadata | RESOLVED |
| U15 | Streamed completion tokens are not metered on the Claude route | MEASURED |

---


## Open

_(none)_

---

## Closed

### U15 — Streamed completion tokens are not metered on the Claude route — MEASURED, bounded

**Measured live, 2026-10-04**, one participant, one key, three requests in order:

| Request | `max_tokens` | `x-budget-used` after |
|---|---|---|
| non-streamed, 200-word essay | 400 | 419 |
| **streamed**, 200-word essay | 400 | 435 (**+16**) |
| non-streamed, trivial | 8 | 451 (+16) |

The non-streamed essay counted 419 tokens — prompt plus completion, as expected. The streamed
essay of the same size added **16**, which is the prompt alone. Completion tokens on a streamed
Anthropic response are counted as zero.

APIM documents that when `stream: true`, "completion tokens are also estimated when responses are
streamed". On the Anthropic Messages shape that estimate is evidently zero.

**Why it matters here specifically:** Claude Code always streams. So the route where this is
worst is the route Claude Code uses, and `x-budget-used` under-reports real spend substantially.
This differs from the OpenAI route, where a full streamed `opencode` session was tracked
continuously (U5, 29,157 tokens) — so the two routes are NOT equivalent and U5 does not cover it.

**What still holds.** Every other control was verified live and fires: allowlist, time window,
revocation, per-minute token and request limits, and the budget's own 403 path. The budget is not
unbounded either — it is bounded by three things that do work:

- `max_tokens` is clamped to `hackgw-max-output-tokens` (8,192) on every request, so one call has
  a hard ceiling.
- `hackgw-calls-per-minute` (240) bounds requests per participant per minute.
- Prompt tokens ARE counted, and a Claude Code conversation's prompt grows with every turn, so a
  long session does eventually trip the budget — later than the true spend, not never.

**Residual risk:** for an event, a participant using Claude Code can consume meaningfully more
than their stated allowance before the cap fires. Acceptable for a time-boxed event with a
spending cap on the subscription; not acceptable as a billing control.

**Revisit if this outlives one event:** P20. The honest fix is to stop treating the token counter
as authoritative for streamed traffic and meter from Foundry's own usage telemetry, or disable
streaming on the route (which would break Claude Code).

Sources: measured as above ·
[llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy)
("Completion tokens are also estimated when responses are streamed", retrieved 2026-10-03).

### U9 — Managed-identity audience for the Foundry `/anthropic` route — RESOLVED

**`https://ai.azure.com` is correct.** Verified live 2026-10-04: with
`authentication-managed-identity resource="https://ai.azure.com"`, a participant key returned
`200` from `claude-sonnet-5` through
`https://ai-contosohub530569751908.services.ai.azure.com/anthropic/v1/messages`, and a full
Claude Code session completed with tool calls.

The assumption recorded below held. The detector described — a 401 from the backend as distinct
from `validate-jwt` — never fired.

The sibling project's use of `https://cognitiveservices.azure.com` is not contradicted: it
reaches Foundry through `endpoints['AI Foundry API']` on a `*.cognitiveservices.azure.com` host.
The audience tracks the host, so both are right for their own route.

Source: [Deploy and use Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
(`get_bearer_token_provider(DefaultAzureCredential(), "https://ai.azure.com/.default")`) ·
live verification, `scripts/Test-Governance.ps1 -Route claude`, 21/21.

### U13 — Which model id Claude Code sends, and how it maps to a gateway alias — RESEARCHED

Claude Code sends Anthropic model ids such as `claude-opus-4-8` by default. It accepts an
arbitrary gateway alias, and when it does not recognise an id it still sends the full set of
Claude API request fields, which the Foundry Anthropic endpoint accepts because it is at parity
with Anthropic's own API.

Two consequences, both handled:

1. A participant must pin `ANTHROPIC_MODEL` to the alias their key grants. Without it Claude Code
   asks for `claude-opus-4-8`, the allowlist does not contain that alias, and the gateway answers
   `403 model_not_permitted` — correct, but confusing.
2. For an unrecognised id Claude Code assumes a 200K context window. The aliases here are short
   names, so the assumption applies. It under-reports context on a 1M-window model rather than
   over-reporting, so it fails safe.

With `ANTHROPIC_AUTH_TOKEN` set, background tasks use the main model rather than a separate Haiku
model, so one pinned alias is sufficient and no second model needs granting.

Source: [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
(retrieved 2026-10-03).

### U12 — APIM tier required to meter Anthropic Messages traffic — RESEARCHED

`llm-token-limit` lists its supported schemas as "OpenAI Chat Completions or Responses API;
**Anthropic Messages API (currently supported in API Management v2 tiers)**; Google Vertex AI API".

A classic tier accepts the policy and meters zero tokens, so every budget silently never fires.
The sibling project records the same finding independently (`infra/main.bicep:25`).

**Consequence, and it is the reason U12 is not merely informational:** attaching to an
*existing* APIM (P15) cannot treat the SKU as a preference. An existing classic-tier instance is
rejected for the Claude route rather than warned about, because the failure mode is a control
that appears to be configured and enforces nothing.

This is also why U3's finding does not generalise: the OpenAI shape parses on all tiers, the
Anthropic shape does not.

Source: [llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy)
(retrieved 2026-10-03).

### U11 — `llm-token-limit` emits an OpenAI-shaped error on the Anthropic route — RESEARCHED

When the quota is exceeded the policy returns its own body, which is OpenAI-shaped
(`Reason=OpenAITokenQuotaExceeded`, `{"statusCode":403,"message":"Token quota is exceeded..."}`)
regardless of the route's wire format. An Anthropic client does not parse that shape, so a
budget rejection surfaces as a parse error rather than as the reason it happened.

The sibling found this only by deploying (`infra/policy.xml:872-881`) and rewrites the response.

**Where the rewrite has to live, which is not where it was first written.** `llm-token-limit`
*raises a policy error* rather than returning a response, and "if an error occurs, processing
immediately jumps to the `on-error` policy section" — so `<outbound>` never runs for a budget
rejection. A first revision of `infra/policy-claude.xml` put the rewrite in `<outbound>`, where
it could never have fired. It is now in `<on-error>`, keyed on
`context.LastError.Reason` containing `QuotaExceeded`. The sibling's own record of the symptom
(`Reason=OpenAITokenQuotaExceeded`) is the evidence: `Reason` is a `context.LastError` field and
is only readable from `on-error`.

A second constraint applies in that section: **`set-body` is not among the policies `on-error`
permits**, so the body is emitted with `return-response`, which is. A policy document that uses
`set-body` there fails validation when it is PUT and takes the whole ARM deployment with it.

Sources: sibling repo `claude-code-foundry-gateway/infra/policy.xml:872-881` ·
[Error handling in API Management policies](https://learn.microsoft.com/en-us/azure/api-management/api-management-error-handling-policies)
(allowed policies in `on-error`, retrieved 2026-10-03).

### U10 — Backend host for the Claude route — RESEARCHED

Learn documents the base URL as `https://<resource-name>.services.ai.azure.com/anthropic`, with
the target URI `.../anthropic/v1/messages`.

This project does not hardcode that pattern. The existing `/openai/v1` route already builds its
host from `customSubDomainName` rather than the resource name, because the two can differ. The
Claude route reads the published endpoint from the account instead:
`foundry.properties.endpoints['AI Foundry API']`, the approach the sibling uses
(`infra/main.bicep:324-334`), with the documented `services.ai.azure.com` form as the fallback
when that key is absent.

Source: [Deploy and use Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
(retrieved 2026-10-03) · sibling repo `infra/main.bicep:324-334`.

### U14 — Claude model deployment needs provider metadata the CLI cannot send — RESEARCHED

Claude deployments require `modelProviderData` (`organizationName`, `industry`, `countryCode`)
and `format: Anthropic`. `az cognitiveservices account deployment create` has no parameter for
that object, so it fails with `InvalidModelProviderData`. Deployment needs an ARM `PUT`.

**Scope decision:** this gateway *lists and pins* Claude deployments; it does not create them.
Creating one also requires accepting Azure Marketplace terms, which is an interactive, billable,
per-organisation action. Option 4 therefore continues to deploy only models it can create
correctly, and reports Claude models as "deploy in the Foundry portal" rather than failing
halfway through.

Sources: sibling repo `docs/SETUP.md:82-109` ·
[Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models)
("Claude models in Foundry require an Azure Marketplace subscription", retrieved 2026-10-03).

### U5 — Streaming token accounting — RESOLVED (drift confirmed usable in practice)

**Finding stands:** APIM documents that with `stream: true`, *"prompt tokens are always estimated
regardless of the `estimate-prompt-tokens` setting. Completion tokens are also estimated when
responses are streamed."*
([llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy))

**Observed live, 2026-08-31:** a full `opencode` agent session (Write + Read tool calls, streamed)
through the gateway consumed **29,157 tokens** against a 500,000 budget, and `x-budget-used`
tracked continuously and monotonically throughout. The counter is an estimate, but a working and
usable one — not a figure that silently stays at zero, which was the real risk.

**Design position unchanged:** the cache counter is advisory and drives the fast, friendly 403; the
`Yearly` `token-quota` runs on APIM's own accounting and is the authoritative cap. Verified live —
`one-time budget exhausts (403)` passes in `scripts/Test-Governance.ps1`.

**Residual:** exact per-token billing reconciliation is out of scope (charter non-goal —
attribution here is for observation, not finance).

### U1 — Exact DeepSeek model names — RESOLVED

`DeepSeek-V4-Pro` and `deepseek-v4-flash` are both real, plus `DeepSeek-R1` and `DeepSeek-V3-0324`.
Both target models are "sold directly by Azure" (no Marketplace subscription needed).

> **A research failure worth recording.** The first pass searched only Microsoft Learn and
> concluded *"DeepSeek V4 Flash does not exist"*. Learn has no Flash tutorial, but the model is in
> the catalog. Absence of evidence in one source was nearly treated as evidence of absence — which
> would have shipped an event where the only agent-capable model was missing. Corrected by checking
> the catalog directly.

Sources: [Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure) ·
[catalog: DeepSeek-V4-Flash](https://ai.azure.com/catalog/models/DeepSeek-V4-Flash)

### U2 — Foundry inference endpoint shape — RESOLVED

The OpenAI v1 passthrough route:

```
https://<resource>.openai.azure.com/openai/v1/chat/completions
```

- Deployment name travels in the request body as `model`, **not** in the URL path.
- **No `api-version` query parameter** is required for `/openai/v1`.
- The classic `/openai/deployments/<name>/...` route is Azure OpenAI only and does **not** serve DeepSeek.

Applied in `infra/main.bicep` (`serviceUrl`).

Source: [Tutorial: Get started with a DeepSeek reasoning model](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1)

### U2b — Managed identity audience — RESOLVED (and it is a trap)

The audience is **`https://ai.azure.com`**, *not* `https://cognitiveservices.azure.com`.

This differs from the sibling `claude-code-foundry-gateway`, which correctly uses the Cognitive
Services audience for its route. Copying that value here produces 401s from the `/openai/v1`
endpoint. Applied in `infra/policy.xml` step 10, with a comment so nobody "fixes" it back.

Source: as above — every official sample uses `https://ai.azure.com/.default`.

### U3 — `llm-token-limit` parsing and APIM tier — RESOLVED

DeepSeek returns an OpenAI-Chat-Completions-shaped response including
`usage.prompt_tokens` / `completion_tokens` / `total_tokens`, so APIM parses it.

Critically: the documented v2-tier restriction applies **only to the Anthropic Messages API shape**.
The OpenAI shape is parsed on **all tiers**. The silent-zero-token trap that shaped the sibling
project's SKU choice therefore does **not** apply here. BasicV2 is still the default, but for
provisioning speed rather than correctness.

Source: [llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy)

### U4 — Credential transport — RESOLVED

APIM validates a subscription key **before inbound policy executes**, so a policy cannot remap
`Authorization: Bearer <key>` onto `Ocp-Apim-Subscription-Key`. Renaming the key header to
`Authorization` also fails, because APIM would read the literal string `Bearer <key>` as the key.

Resolved by dropping APIM subscriptions entirely in favour of a self-issued HS256 JWT validated by
`validate-jwt` — which is the *native* transport for a `Bearer` credential, and additionally makes
the time window self-enforcing. Full reasoning in [ADR-0002](adr/0002-credential-transport.md).

Source: [Subscriptions in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)

### U4b — Tool calling support — RESOLVED (and it changed the design)

`DeepSeek-V4-Pro` is a reasoning model and **does not support tool calling**:
*"It supports text-based chat completions but doesn't support tool calling."*
`deepseek-v4-flash` does support it and is tuned for agentic coding.

Since `opencode`'s agent loop is built on tool calls, `flash` became the default and a guard rail
was added to reject tool-carrying requests aimed at `pro` with an explanatory 400. See
[ADR-0003](adr/0003-model-roles.md).

Source: [Tutorial: Get started with a DeepSeek reasoning model](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1)

### U7 — Status-code consistency between the two budget paths — RESOLVED

There are two places a spent budget is detected: the cache counter (policy step 6) and the
`llm-token-limit` `token-quota` backstop (step 7). APIM's quota returns `403` natively and that is
not configurable.

An earlier revision returned `429` from the cache path, which would have meant two different status
codes for the same condition depending on which path fired. ADR-0004 reverted the cache path to
`403` — for independent reasons — and the two are now consistent by construction. No normalisation
layer is needed.

### U8 — Single-call overshoot on a small budget — MEASURED, bounded

**Observed live, 2026-08-31:** a key with a 300-token budget returned `HTTP 200` with
`x-budget-used: 3507` on its first call, then `403 budget_exhausted` on the next.

**Cause, and why it is by design:** the budget is checked *before* a request. The request that
crosses the line still completes; only subsequent ones are refused. Pre-emptively rejecting would
require `estimate-prompt-tokens="true"`, which trades accuracy for a guess and rejects requests
that would in fact have fitted.

**The bound:** worst-case overshoot is one request — roughly `prompt + max-output-tokens`. The
`max-output-tokens` clamp (default 8,192, applied to both `max_tokens` and `max_completion_tokens`)
is what keeps this finite. Against a realistic budget of millions of tokens the overshoot is
negligible; it is only material for very small budgets, which is exactly the case above.

**Action:** documented in the README's known limits. No code change — the alternative is worse.
**The cache counter is advisory. The `token-quota` is authoritative.** That split is deliberate and
is what makes the assumption safe:

- The cache gives the *fast, friendly* rejection with a clear `budget_exhausted` message.
- The `Yearly` `token-quota` lives in APIM's own store, is atomic, and is the real cap.

Two consequences follow, both handled:

1. **A cache miss must not be read as zero consumption.** `default-value="unknown"` makes
   `long.TryParse` fail, and the policy then *defers to the quota* rather than granting a fresh
   budget (fail-open) or denying outright (which would brick a participant over a cache we do not
   control). This mirrors `entitlement.mjs`, which denies on unknown consumption because it has no
   authoritative fallback available.

2. **The read-modify-write across inbound/outbound is not atomic.** With N requests in flight, all
   read the same value and the last write wins, so the cache counter under-counts under
   concurrency — and `opencode` issues parallel tool calls. This makes `x-budget-used` an
   approximation, and it means the cache path may not fire first. The quota still holds the cap.

**Residual risk:** the effective ceiling is the quota plus APIM's documented concurrency overshoot,
not exactly the issued budget. Acceptable for a time-boxed event; not acceptable for chargeback.

**Revisit if this outlives one event:** do P11 — move to external Redis with an atomic `INCRBY`,
or delete the cache counter entirely and source `x-budget-used` from
`remaining-quota-tokens-variable-name` so there is a single enforcement point.
