# Charter — Foundry Hackathon Gateway

## What this is

A governed Azure API Management gateway that hands out **time-bound, spend-capped API keys** for
DeepSeek models hosted in Microsoft Foundry, so hackathon participants can build applications with
`opencode` (and any OpenAI-compatible agent harness) without anyone holding a model credential or
being able to overspend.

The sibling project `claude-code-foundry-gateway` solves the *enterprise* case: Entra ID identity,
per-developer tiers, indefinite access. This project solves the *event* case: **key-based,
disposable, hard-capped access that expires by itself.**

## Goals

| # | Goal | Observable outcome |
|---|---|---|
| G1 | Admin pins the model allowlist | A key issued for `flash` cannot call `pro`; gateway returns 403 |
| G2 | Admin provisions a participant key in one interactive step | `./admin.ps1` → new key printed, ready to paste into opencode |
| G3 | Keys are time-bound | After the window closes the key returns 403 without any human action |
| G4 | Keys are spend-bound | A one-time token budget that does **not** reset; exhaustion returns 403 permanently |
| G5 | Usage is attributable per participant | Token consumption per key, queryable |
| G6 | Works in `opencode` including tool calls | A participant can actually build an app end to end |
| G7 | No Foundry credential leaves Azure | Gateway managed identity is the only principal with data-plane access |

## Non-goals

- **Entra ID / OAuth.** Deliberately excluded. Hackathon participants may be external, short-lived,
  and using machines we do not manage. Key-based auth is the explicit choice (see ADR-0002).
- Multi-tenant billing or chargeback invoicing. Attribution is for observation, not finance.
- Model fine-tuning, RAG, agent hosting, or anything past inference.
- Production-grade HA. Single region, single APIM unit is fine for an event.

## Constraints

| Constraint | Consequence |
|---|---|
| Participants use `opencode`, which speaks the **OpenAI Chat Completions** wire format | The gateway must expose an OpenAI-compatible surface, not the Foundry-native one |
| `opencode` sends credentials as `Authorization: Bearer <key>` | The key transport must accommodate this — see UNKNOWN U6 |
| Tool calling and streaming must work | Streaming changes how APIM counts tokens; budgets must still hold |
| APIM token counters reset per fixed window | A true one-time budget needs a durable counter (see ADR-0003) |
| The event is time-boxed | Deploy must be one command and teardown must be complete |

## Quality bar

- Every governance control has a test that **proves it fires** — a 403 that never fires is not a control.
- The admin script is usable by someone who did not build it, under time pressure, at an event.
- No secret is ever written to a log, a commit, or a transcript.
- The gateway fails **closed**: any ambiguity in entitlement, window or budget denies the request.

## Definition of done

`node .ironclad/gate.mjs --stage packet` exits 0, and the control it implements has been
demonstrated firing against a live deployment or a faithful local harness.
