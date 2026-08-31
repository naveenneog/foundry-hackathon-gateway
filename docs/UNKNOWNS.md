# Unknowns register

Ironclad rule 8: unknowns are written down *before* implementation, then closed by research with a
citation, or by an explicitly labelled assumption with its blast radius.

---

## Open

_(none blocking — see Closed)_

### U5 — Streaming token accounting drifts

**Status:** RESEARCHED, accepted as a known limit
**Packet:** P12
**Finding:** APIM documents that when `stream: true` is set, *"prompt tokens are always estimated
regardless of the `estimate-prompt-tokens` setting. Completion tokens are also estimated when
responses are streamed."*
([llm-token-limit](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy))
`opencode` streams constantly, so the lifetime counter is an estimate, not a measurement.
**Consequence:** the one-time budget is approximate at the margin.
**Mitigation shipped:** the `Yearly` `token-quota` in step 7 of the policy runs on APIM's own
accounting and is the authoritative cap. The cache counter is the fast path, not the source of truth.
**Still to verify on a live deployment:** whether DeepSeek on Foundry honours
`stream_options: {include_usage: true}`, which would let APIM read real counts instead of estimating.

---

## Closed

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

### U6 — Durable one-time budget storage — ASSUMED, risk accepted and bounded

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
