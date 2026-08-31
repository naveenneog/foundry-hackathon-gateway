# Foundry Hackathon Gateway

Hand out **time-bound, spend-capped API keys** for DeepSeek models on Microsoft Foundry, so
hackathon participants can build real applications with **opencode** — and nobody holds a model
credential or can overspend.

```powershell
./admin.ps1
```

One interactive script deploys the gateway, pins the models, issues keys, revokes them, and shows
consumption.

Sibling project: [`claude-code-foundry-gateway`](../../../claude-code-foundry-gateway) solves the
*enterprise* case (Entra ID, per-developer tiers, indefinite access). This one solves the *event*
case: key-based, disposable, hard-capped, self-expiring.

---

## What a participant gets

```
OPENAI_BASE_URL=https://apim-hackgw1234.azure-api.net/v1
OPENAI_API_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

That is it. Those two variables work in `opencode`, the OpenAI SDK, Aider, Continue, or anything
else that speaks the OpenAI wire format.

The key **is** the entitlement. It carries — signed, and therefore untamperable — which models it
may call, when it becomes active, when it dies, and how many tokens it may spend.

---

## The controls

| Control | Mechanism | Participant sees |
|---|---|---|
| Model allowlist | signed `models` claim, checked in policy | **403** `model_not_permitted` |
| Time window | JWT `nbf` / `exp`, enforced by `validate-jwt` | **401** — no automation needed |
| One-time spend cap | cache counter + `token-quota` backstop | **403** `budget_exhausted` — **stops immediately** |
| Burst protection | `llm-token-limit` tokens/minute | **429** + `Retry-After` (genuinely retryable) |
| Runaway agent loop | `rate-limit-by-key` on request count | **429** |
| Tools against a reasoning model | explicit guard rail | **400** with a useful message |
| Attribution | `llm-emit-token-metric` → App Insights | per-participant tokens |
| No credential sprawl | gateway managed identity | nothing to leak |

> **Why a spent budget is 403 and not 429.** 429 is the intuitive choice, but every
> OpenAI-compatible client treats it as *retryable*: the OpenAI SDK retries it and **sleeps for the
> exact `Retry-After` value**, and the Vercel AI SDK behind opencode backs off and retries. A
> one-time budget never refills, so those retries can only fail — and a truthful `Retry-After`
> (seconds until the key expires) would hang an obedient client for hours. 403 is not retried by
> either SDK, so the agent stops the instant the budget is gone. See
> [ADR-0004](docs/adr/0004-budget-exhausted-status.md).

Live budget is returned on every response:

```
x-budget-used: 41233
x-budget-total: 2000000
x-budget-remaining: 1958767
```

---

## The two models — read this before running an event

| Alias | Foundry deployment | Tool calling | Use for |
|---|---|---|---|
| `flash` | `deepseek-v4-flash` | ✅ **Yes** | **Building.** Agent loop, file edits, terminal work |
| `pro` | `DeepSeek-V4-Pro` | ❌ **No** | Hard reasoning, one-shot questions |

`DeepSeek-V4-Pro` is a *reasoning* model and
[does not support tool calling](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1).
`opencode`'s agent loop is built on tool calls, so **a participant given only `pro` cannot build
anything.** The gateway therefore defaults new keys to `flash`, warns if you grant `pro` alone, and
returns an explicit `400` if a tool-calling request is aimed at `pro` — rather than letting it fail
opaquely and cost somebody their morning.

See [ADR-0003](docs/adr/0003-model-roles.md).

---

## Why a JWT and not an APIM subscription key

APIM validates a subscription key **before any inbound policy runs**. `opencode` sends
`Authorization: Bearer <key>`, and no policy can rescue that — the request is already rejected.

A signed JWT is the *native* transport for a `Bearer` credential, and it brings three things a
subscription key cannot:

- **`exp` gives time-bounding for free.** No timer job, no cleanup, no reaper. APIM's own
  `expirationDate` field is [audit metadata that the platform never enforces](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions).
- **`nbf` gives scheduled activation** in the same credential.
- **Issuance is offline.** Minting 200 keys is a local operation taking under a second, with zero
  Azure API calls. At an event, that matters.

Full reasoning: [ADR-0002](docs/adr/0002-credential-transport.md).

---

## Quickstart

```powershell
git clone <this repo>
cd foundry-hackathon-gateway
az login

./admin.ps1
#  1  Deploy / update the gateway      (~5 min, APIM v2 provisions in minutes)
#  3  Deploy a DeepSeek model          (if you have not already)
#  4  Issue a participant key
```

Option 4 writes `handouts/<team>/` containing a ready-to-paste `opencode.json` and a one-page card.

### Verify the controls actually fire

```powershell
./admin.ps1   # option 8
```

Mints deliberately broken keys — expired, forged, wrong model, exhausted — and asserts the gateway
rejects each for the right reason. **A control that never fires is not a control.**

---

## Repository layout

```
admin.ps1                    interactive admin console — start here
src/
  entitlement.mjs            the access decision, as a pure tested function
  keys.mjs                   HS256 key minting and verification (zero dependencies)
infra/
  main.bicep                 APIM, observability, API, policy, RBAC
  foundry-role.bicep         Cognitive Services User for the gateway identity only
  policy.xml                 the governance policy
scripts/
  mint.mjs                   thin shim so admin.ps1 never reimplements JWS
  Test-Governance.ps1        proves each control fires
tests/                       49 tests, including tamper and alg:none attacks
docs/
  CHARTER.md                 goals, non-goals, constraints
  ROADMAP.md                 milestones and packets
  UNKNOWNS.md                what we did not know, and how each was closed
  adr/                       architecture decisions and their reasoning
```

`src/entitlement.mjs` is the canonical statement of the access rules; `infra/policy.xml` is its
transcription into APIM policy expressions. **If you change one, change both** — the tests guard
the former, and `Test-Governance.ps1` guards the latter.

---

## Tuning

Limits are APIM named values, so changing one is a config edit rather than a redeployment:

| Named value | Default | Meaning |
|---|---|---|
| `tpm-per-key` | 40,000 | tokens/minute ceiling per participant |
| `calls-per-minute` | 240 | request ceiling per participant |
| `max-output-tokens` | 8,192 | hard cap on any single completion |
| `model-flash` | `deepseek-v4-flash` | what `flash` resolves to |
| `model-pro` | `DeepSeek-V4-Pro` | what `pro` resolves to |
| `revoked-keys` | `,` | denylist, managed by `admin.ps1` |

```powershell
az apim nv update -g rg-hackathon-gateway --service-name <apim> `
    --named-value-id max-output-tokens --value 4096
```

**Emergency stop:** rotating `signing-key` invalidates every outstanding key at once.

---

## Known limits

- **Streaming drifts the counter.** APIM *estimates* tokens on streamed responses rather than
  reading actual usage, so lifetime consumption is approximate. The `Yearly` `token-quota` runs
  underneath as the authoritative cap. See `docs/UNKNOWNS.md` U5.
- **The budget counter uses APIM's internal cache**, which is best-effort. An eviction could grant
  one extra budget; the quota backstop bounds the damage. Move to external Redis if this outlives
  a single event. See U6.
- **JWTs cannot be revoked before `exp`** — that is the trade for offline issuance. The `jti`
  denylist covers it, at the cost of one named-value update.

---

## Teardown

```powershell
./admin.ps1   # option 9
```

Then purge the soft-deleted APIM, or its globally unique name stays taken:

```powershell
az apim deletedservice purge --service-name <apim-name> --location <region>
```

---

## License

MIT
