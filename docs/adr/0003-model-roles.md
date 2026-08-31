# ADR-0003 — Model roles: Flash is the agent, Pro is the reasoner

**Status:** Accepted
**Date:** 2026-08-31
**Packet:** P2

## Context

The brief asked for "DeepSeek pro and Flash" to be usable in `opencode` for building applications,
"which can use tool calls and all".

Research (Ironclad rule 9 — research beats recall) found a capability split that directly affects
whether the event works at all.

## Findings

| Model | Catalog id | Tool calling | Notes |
|---|---|---|---|
| DeepSeek V4 Pro | `DeepSeek-V4-Pro` | ❌ **Not supported** | Reasoning model. Microsoft Learn states plainly: *"It supports text-based chat completions but doesn't support tool calling."* |
| DeepSeek V4 Flash | `deepseek-v4-flash` | ✅ Supported | 284B MoE (13B active), 1M-token context, tuned for agentic coding and workflow automation |

Sources:
- [Tutorial: Get started with a DeepSeek reasoning model in Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1)
- [Microsoft Foundry model catalog — DeepSeek-V4-Flash](https://ai.azure.com/catalog/models/DeepSeek-V4-Flash)

An initial research pass searching only Microsoft Learn concluded that "DeepSeek V4 Flash does not
exist". That was **wrong** — Learn has no Flash tutorial, but the model is in the catalog. The
finding was corrected by checking the catalog directly. Recorded here because it is exactly the
failure mode rule 9 exists to prevent: absence of evidence in one source treated as evidence of
absence.

## Decision

Both models are offered, with **explicitly different roles**, and `deepseek-v4-flash` is the
**default**.

| Alias exposed to opencode | Backend | Intended use |
|---|---|---|
| `flash` | `deepseek-v4-flash` | **Default.** Agent loop, tool calls, file edits, terminal work |
| `pro` | `DeepSeek-V4-Pro` | Reasoning, architecture, hard single-shot problems. No tools. |

The admin script defaults a new key to `flash` only. Granting `pro` is a deliberate choice.

## Consequences

- A participant issued **only** `pro` cannot use `opencode` as a coding agent — the agent loop
  requires tool calls. The admin script therefore warns when `pro` is selected without `flash`.
- The gateway returns a **specific, actionable** error when a tool-calling request is aimed at `pro`,
  rather than letting the model fail opaquely. A participant at an event must not lose 40 minutes to
  this.
- Docs must state the split plainly. This is the single most likely support question of the event.

## Alternatives rejected

- **Ship Pro only** — would have produced an event where nobody could build anything.
- **Silently route `pro` → Flash on tool-calling requests** — rejected. Silently substituting a model
  the user did not ask for is exactly the kind of hidden behaviour that destroys trust in a gateway.
  Fail loudly with a clear message instead.
