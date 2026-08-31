# ADR-0004 — Budget exhaustion returns 403, not 429

**Status:** Accepted
**Date:** 2026-08-31
**Packet:** P3/P4

## Context

The one-time token budget is permanent: it does not reset. When it is spent, what should the
gateway return, and — the question that actually matters — **what makes the client stop?**

429 was proposed first, on the reasoning that OpenAI-compatible clients surface a 403 as an
authentication failure ("invalid API key"), which sends a participant hunting for the wrong
problem. 429 reads as "you hit a limit", which is what happened.

That reasoning was wrong, and the mitigation proposed alongside it made things worse.

## The evidence

| Status | OpenAI SDK | Vercel AI SDK (`@ai-sdk/openai-compatible`, used by opencode) |
|---|---|---|
| **403** | **Not retried.** Terminal. | Not retried. Terminal. |
| **429** | **Retried** (default 2×). On 429 it *"will sleep for the exact time given in `Retry-After`"*. | `isRetryable: true`; retried with exponential backoff. |

Sources: [OpenAI Python error handling](https://mmacy.github.io/openai-python/1.14.3/error-handling/) ·
[AI SDK APICallError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error)

Two consequences follow.

1. **429 does not stop the agent — it makes it spin.** A one-time budget never refills, so every
   retry is guaranteed to fail. The participant sees a hang, not an answer.

2. **The proposed mitigation was actively harmful.** The idea was to set a *truthful* `Retry-After`
   — the seconds remaining until the key expires — so that well-behaved clients would not storm the
   gateway. But the OpenAI SDK **sleeps for exactly that value**. With a 48-hour key window, an
   obedient client would hang for up to 30 hours instead of failing in milliseconds. The more
   correct the client, the worse the outcome.

## Decision

**403, with no `Retry-After`.**

403 is not retried by either SDK. The agent loop stops immediately, which is the required
behaviour.

The original concern — that 403 looks like an authentication failure — is real, but it is a
*messaging* problem, not a *status code* problem. It is addressed in the response instead:

| Signal | Value |
|---|---|
| body `error.code` | `budget_exhausted` |
| body `error.type` | `insufficient_quota` (OpenAI's own type for this condition) |
| body `error.message` | leads with *"This is NOT an invalid key"* |
| `x-budget-remaining` | `0` |
| `x-budget-exhausted` | `true` |

## What every other denial does

All terminal denials return **403 with no `Retry-After`**, because retrying can never help:
`expired`, `model_not_permitted`, `revoked`, `budget_exhausted`.

`invalid_grant` returns **401** — that one genuinely is an authentication failure.

`not_yet_active` is the single exception: it returns 403 but *does* carry `retryAfter`, because the
key really does start working later. The 403 still prevents the SDK from auto-retrying; the hint is
for the human reading the error, not the machine.

## Consequences

**Positive**
- The agent stops the instant the budget is spent. No spinning, no multi-hour hang.
- Fast, unambiguous failure is the correct behaviour at a time-boxed event.
- `insufficient_quota` matches OpenAI semantics, so clients that special-case it still behave well.

**Negative**
- A participant who reads only the status code may still think their key is broken. Mitigated by
  the message, the two headers, and the participant card, which lists exactly this case.

## Note for future readers

The intuitive answer here ("a limit was hit, so 429") is the wrong one, and it is wrong in a way
that only shows up under a real agent loop. If you are tempted to change this back, re-read the
table above first. `tests/budget-status.test.mjs` asserts the current behaviour explicitly,
including a test that fails if the status becomes 429.
