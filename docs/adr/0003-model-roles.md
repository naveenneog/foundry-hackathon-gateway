# ADR-0003 — Model roles: Flash is the default, Pro is the reasoner

**Status:** Accepted (revised 2026-08-31 after live testing)
**Packet:** P2, corrected in P9

## Context

The brief asked for DeepSeek Pro and Flash to be usable in `opencode` for building applications,
"which can use tool calls and all".

This ADR was written twice. The first version was based on documentation and was **wrong**. It is
kept here in full, because the way it was wrong is more instructive than the conclusion.

## What the documentation says

Microsoft Learn states plainly of `DeepSeek-V4-Pro`:

> *"It supports text-based chat completions but doesn't support tool calling."*
> — [Tutorial: Get started with a DeepSeek reasoning model](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1)

On that basis the gateway originally **hard-blocked** tool-carrying requests aimed at `pro`,
returning a `400` with an explanatory message, on the reasoning that failing loudly beats failing
opaquely.

## What actually happens

Tested directly against `DeepSeek-V4-Pro` (version `2026-04-23`) deployed in
`foundry-plus-resource`, eastus2, on 2026-08-31:

```
### deepseek-v4-flash  -> HTTP 200
     TOOL CALL: get_weather({"city": "Paris"})
### deepseek-v4-pro    -> HTTP 200
     TOOL CALL: get_weather({"city": "Paris"})
```

**Pro returns well-formed `tool_calls`.** The documentation is stale or wrong for this model
version. Verified again through the gateway itself in `scripts/Test-Governance.ps1`, where both
`tool calls accepted on pro` and `tool calls accepted on flash` pass.

## Decision

**The guard rail was removed before it ever shipped.** Blocking a capability that demonstrably
works is worse than the confusion it was meant to prevent — a participant told "this model cannot
do tool calls" by the gateway has no way to discover that it can.

Both models are offered. `flash` remains the **default**, on capability rather than exclusion:

| Alias | Foundry deployment | Model | Role |
|---|---|---|---|
| `flash` | `deepseek-v4-flash` | `DeepSeek-V4-Flash-0731` | **Default.** 284B MoE, 1M context, tuned for agentic coding. Faster and cheaper per turn. |
| `pro` | `deepseek-v4-pro` | `DeepSeek-V4-Pro` | Reasoning. Tool calling works, but it is a reasoning model: slower and more expensive per turn. |

The policy now sets an advisory `modelHint` variable instead of refusing the request.

## Also corrected here: the model names

An initial research pass searching only Microsoft Learn concluded *"DeepSeek V4 Flash does not
exist"*. Learn has no Flash tutorial, so absence of evidence was nearly taken as evidence of
absence. The catalog disproved it, and `az cognitiveservices model list` confirmed the exact
casing and versions:

```
DeepSeek-V4-Flash        2026-04-23   GlobalStandard
DeepSeek-V4-Pro          2026-04-23   GlobalStandard
DeepSeek-V4-Flash-0731   2026-07-31   GlobalStandard
```

`DeepSeek-V4-Flash-0731` is the newer build, tuned for coding agents, and is what `flash` points at.

## Consequences

- Participants may use either model for agent work. `flash` is the sensible default on cost and
  latency, not on capability.
- The docs in this repo state the *observed* behaviour and say when it was observed, because the
  upstream documentation contradicts it.
- `Test-Governance.ps1` asserts tool calling works on both, so if a future model version genuinely
  drops support, the harness catches it rather than a participant discovering it mid-build.

## Note for future readers

Two failure modes nearly shipped here, and both came from trusting a single source:

1. **A doc search that found nothing** was nearly read as "the thing does not exist".
2. **A doc statement that was wrong** was nearly encoded as a hard block in production.

Neither survived contact with `az cognitiveservices model list` and one live HTTP request. When a
capability claim determines whether a control blocks traffic, test it against the real endpoint
before shipping the control.
