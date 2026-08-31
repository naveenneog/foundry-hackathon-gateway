# ADR-0002 — Credential transport: self-issued JWT, not APIM subscription keys

**Status:** Accepted
**Date:** 2026-08-31
**Packet:** P2/P3

## Context

Participants use `opencode`, an OpenAI-compatible client. Like every OpenAI-compatible client it
sends its credential as `Authorization: Bearer <token>`.

The charter requires keys that are **time-bound** and carry a **one-time spend cap**, issued
programmatically by an admin at an event.

Three transports were considered.

### The trap that eliminates the obvious option

APIM validates a subscription key **before any inbound policy executes**. A request without a
recognised key is rejected at the gateway with 401 and the policy never runs. Therefore a policy
that reads `Authorization: Bearer <key>` and rewrites it into `Ocp-Apim-Subscription-Key`
**cannot work** — by the time it would run, the request is already rejected.

Source: [Subscriptions in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)

## Options

| Option | Verdict |
|---|---|
| **A. APIM subscription key, default header** | Rejected. `opencode` cannot send `Ocp-Apim-Subscription-Key`; it sends `Authorization`. |
| **B. Rename the subscription key header to `Authorization` via `subscriptionKeyParameterNames`** | Rejected. APIM would then read the *raw* header value as the key, but `opencode` sends the `Bearer ` prefix, so lookup fails. |
| **C. `subscriptionRequired: false` + self-issued JWT validated by `validate-jwt`** | **Accepted.** |

## Decision

Issue each participant a **signed JWT** (HS256) and set `subscriptionRequired: false` on the API.
The gateway validates it with `validate-jwt` using a symmetric signing secret held as an APIM named
value.

`Authorization: Bearer <jwt>` is the *native* transport for a JWT, so `opencode` works unmodified.

The token carries the entitlement in its own claims:

| Claim | Purpose |
|---|---|
| `sub` | participant identity — the counter key for budgets and attribution |
| `nbf` | **activation** — the key does not work before this instant |
| `exp` | **expiry** — the key stops working after this instant, enforced by `validate-jwt` |
| `models` | comma-delimited model allowlist, signed and therefore tamper-proof |
| `budget` | the one-time token allowance, for display and cross-check |
| `jti` | unique id, so a specific key can be revoked by denylist |

## Consequences

**Positive**

- Time-bounding is **free and self-enforcing**. `validate-jwt` requires and validates `exp` by
  default, so an expired key dies with no timer job, no cleanup, no cache entry.
- `nbf` provides scheduled activation in the same credential.
- The model allowlist is *signed*. A participant cannot edit their own entitlement.
- **Key issuance is offline** — minting a JWT is a local operation. An admin can issue 200 keys in a
  second without a single Azure API call. This matters enormously at an event.
- No APIM subscription objects to create, list, suspend or garbage-collect.

**Negative**

- JWTs are stateless and therefore **cannot be revoked before `exp`**. Mitigated by a `jti`
  denylist named value checked in policy, and by keeping tokens short-lived (an event is 1–3 days).
- We lose APIM's built-in per-subscription analytics. Mitigated: we emit our own metric dimensions
  keyed on `sub`, which is strictly more useful here.
- The signing secret is a single point of compromise. Mitigated: stored as a *secret* named value,
  never written to disk by the admin script, and rotatable — rotating it invalidates every
  outstanding key at once, which is a useful emergency stop.

## Follow-up

The one-time spend cap cannot live in the JWT (a token cannot count its own consumption). It is
handled separately in ADR-0003.
