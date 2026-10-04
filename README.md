# Foundry Hackathon Gateway

Hand out **time-bound, spend-capped API keys** for models on Microsoft Foundry, so hackathon
participants can build real apps with **opencode** and **Claude Code** — and nobody holds a model
credential or can overspend.

One interactive script does everything.

```powershell
./admin.ps1
```

![Admin console](docs/images/admin-menu.png)

---

## What a participant gets

Two environment variables and one config file. That is the whole setup.

**[→ Participant setup guide](docs/SETUP.md)** — eight numbered steps, each with a
screenshot, written for someone who has never seen this project.

```bash
OPENAI_BASE_URL=https://<your-gateway>.azure-api.net/v1
OPENAI_API_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

They work in `opencode`, the OpenAI SDK, Aider, Continue, `curl` — anything that speaks the OpenAI
wire format.

For **Claude Code**, and anything else speaking the Anthropic Messages API, the same key:

```bash
ANTHROPIC_BASE_URL=https://<your-gateway>.azure-api.net/claude
ANTHROPIC_AUTH_TOKEN=<the same key>
ANTHROPIC_MODEL=<an alias the key grants>
```

`ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. The first is sent as `Authorization: Bearer`,
which is what the gateway validates; the second is sent as `x-api-key` and returns a bare 401.
Option 5 writes a `.claude/settings.json` carrying all three, which is also what makes them apply
to Claude Code's background agents — a shell export does not reach those.

Claude Code is pointed at the gateway as a plain Anthropic endpoint rather than through
`CLAUDE_CODE_USE_FOUNDRY`, so a participant needs no Azure identity at all.
See [ADR-0009](docs/adr/0009-claude-code-connection.md).

The key **is** the entitlement. It carries, signed and untamperable: which models it may call, when
it starts working, when it dies, and how many tokens it may spend. **One key, one budget** — using
both routes draws on the same allowance.

### It really builds things

A real `opencode` session through the gateway — tool calls and all:

![opencode session through the gateway](docs/images/opencode-session.png)

---

## Quickstart

```powershell
git clone https://github.com/naveenneog/foundry-hackathon-gateway
cd foundry-hackathon-gateway
az login

./admin.ps1
#  1  Deploy / update the gateway     (~5 min, or seconds onto an instance you already run)
#  4  Deploy a new model to Foundry   (if you have not already)
#  5  Issue a participant key
```

Option 5 writes `handouts/<team>/` containing a ready-to-paste `opencode.json` and a one-page card
for the participant.

### Use an API Management instance you already have

Option 1 lists every API Management instance in the subscription before it creates one:

```
  API Management instances in this subscription:
    [1] apim-corp                    StandardV2   eastus2    add
        StandardV2. Usable; 'deepseek-gateway' would be added alongside anything
        already published here.
    [2] apim-legacy                  Developer    eastus2    unusable
        The Claude route needs a v2 tier (BasicV2, StandardV2 or PremiumV2). Developer
        accepts the token policy and meters zero Anthropic tokens, so budgets would
        never fire.
    [3] Create a new instance
```

Picking one adds this gateway's API, policy and named values to it and creates nothing else. The
instance keeps its SKU, publisher details and identity. Everything written at instance scope is
prefixed `hackgw-`, so it cannot collide with another API published there.

An instance is refused rather than flagged when it cannot enforce the controls: a classic tier for
the Claude route, the Consumption tier, an instance that is not `Succeeded`, or one with no
system-assigned managed identity. See [ADR-0008](docs/adr/0008-adopt-existing-apim.md).

**Requirements:** an Azure subscription, a Microsoft Foundry (`AIServices`) account, the Azure CLI,
Node 20+, and **PowerShell 7.0 or later**.

Windows PowerShell 5.1 is **not supported** — it silently corrupts `issued-keys.json`, which breaks
revocation. See [ADR-0006](docs/adr/0006-powershell-7-requirement.md). Install with:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

`admin.ps1` runs a preflight on startup and tells you exactly what is missing:

```
  Preflight
  ---------
  [ok] PowerShell 7.6.5
  [ok] Azure CLI 2.86.0
  [ok] Signed in as <your-account>
       Subscription: Contoso Dev
  [ok] Bicep CLI
  [ok] Node v22.11.0
  [ok] Key minting works
```

---

## The controls

| Control | Participant sees |
|---|---|
| Model allowlist | **403** `model_not_permitted` |
| Access window (start and expiry) | **401** — self-enforcing, no cleanup job |
| One-time spend cap | **403** `budget_exhausted` — stops immediately |
| Tokens per minute | **429** + `Retry-After` |
| Requests per minute | **429** |
| Per-participant attribution | `x-budget-used` header + App Insights |
| No credential sprawl | nothing to leak — gateway uses its managed identity |

Every response carries the live budget:

```
x-budget-used: 29157
x-budget-total: 500000
x-budget-remaining: 470843
```

### Verify the controls yourself

`./admin.ps1` → option 8. It mints deliberately broken keys — expired, forged, wrong model,
exhausted — and asserts the gateway rejects each for the right reason.

![Governance controls verified](docs/images/governance-checks.png)

A control that never fires is not a control.

---

## How it works

![Architecture](docs/images/architecture.svg)

A participant's key is a **signed JWT**, not an API Management subscription key. That choice buys
three things:

- **The time window enforces itself.** `exp` and `nbf` are validated on every request by
  `validate-jwt`. No timer job, no reaper, nothing to forget. API Management's own
  `expirationDate` field is [audit metadata the platform never acts on](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions).
- **Issuing a key is offline.** Minting 200 keys takes under a second and zero Azure API calls.
- **It is the native transport.** `opencode` sends `Authorization: Bearer <key>`, and API Management
  validates a subscription key *before* any policy runs — so no policy can rescue that header.

Full reasoning: [ADR-0002](docs/adr/0002-credential-transport.md).

---

## The models

Any number can be pinned, on either route ([ADR-0007](docs/adr/0007-model-map-named-value.md)).
What a route can serve is decided by the wire format the model speaks, not by preference:

| Route | Base URL | Wire format | Foundry endpoint |
|---|---|---|---|
| `v1` | `https://<gw>.azure-api.net/v1` | OpenAI Chat Completions | `/openai/v1` |
| `claude` | `https://<gw>.azure-api.net/claude` | Anthropic Messages | `/anthropic` |

Option 3 lists every deployment in the subscription with the route that serves it, and refuses a
pin that crosses routes — a Claude model on the OpenAI route reaches a backend that has never
heard of it and returns an opaque 404.

The default DeepSeek pins:

| Alias | Foundry deployment | Best for |
|---|---|---|
| `flash` | `DeepSeek-V4-Flash-0731` | **Default.** Agent loop, file edits. Faster, cheaper. |
| `pro` | `DeepSeek-V4-Pro` | Hard reasoning. Slower, pricier. |

Both support tool calling, so both work in `opencode`.

Claude models are deployed in the Foundry portal rather than from here: they need organisation
details and Azure Marketplace terms that the CLI cannot supply
([UNKNOWNS U14](docs/UNKNOWNS.md)). Once deployed, pin one with option 3.

The Claude route needs an API Management **v2** tier. `llm-token-limit` parses the Anthropic
Messages shape on v2 tiers only; on a classic tier it meters zero tokens and a budget would never
fire, so the route is not published there.

Verified live on 2026-08-31 — a single `opencode` run through the gateway used **Grep**, **Bash**,
**Read** and **Write**:

```
> build · flash
✱ Grep "TODO" in src · 2 matches
$ (Get-ChildItem -Path src -File).Count
3
← Write REPORT.md
Wrote file successfully.
Done. Files with TODOs: src/alpha.py, src/gamma.py. Total files in src/: 3.
```

> Microsoft Learn states `DeepSeek-V4-Pro` *"doesn't support tool calling"*. Live testing
> disproved it — it returns well-formed `tool_calls`. An earlier version of this gateway
> hard-blocked tools on `pro` on the strength of that doc; the block was removed before shipping.
> The verification harness asserts tool calling on both models, so a genuine future regression is
> caught by the harness rather than by a participant mid-build. See
> [ADR-0003](docs/adr/0003-model-roles.md).

---

## Tuning

Limits are API Management named values, so changing one is a config edit, not a redeployment.
Every name is prefixed `hackgw-`, so nothing here can collide with another API on a shared
instance ([ADR-0008](docs/adr/0008-adopt-existing-apim.md)):

| Named value | Default | Meaning |
|---|---|---|
| `hackgw-tpm-per-key` | 40,000 | tokens/minute per participant |
| `hackgw-calls-per-minute` | 240 | request ceiling per participant |
| `hackgw-max-output-tokens` | 8,192 | hard cap on any single completion |
| `hackgw-model-map` | — | `alias=deployment;alias=deployment` ([ADR-0007](docs/adr/0007-model-map-named-value.md)) |
| `hackgw-revoked-keys` | `,` | denylist, managed by `admin.ps1` |
| `hackgw-signing-key` | — | HS256 secret; rotating it invalidates every outstanding key |

```powershell
az apim nv update -g rg-hackathon-gateway --service-name <apim> `
    --named-value-id hackgw-max-output-tokens --value 4096
```

**Emergency stop:** rotating `hackgw-signing-key` invalidates every outstanding key at once.

A gateway deployed before the prefix existed still has the old unprefixed names. `admin.ps1`
reads either, and the next deployment writes only the prefixed ones — the old values are left in
place and are no longer read, so delete them once the gateway has been redeployed.

### If two people run the event

The signing secret lives in `.gateway/secret.txt`, which is **gitignored** — cloning the repo
does not give you a working one. Keys minted with a different secret than the gateway holds are
rejected with a bare `401`, and the gateway's message cannot tell you why.

- **One organiser mints keys.** Simplest, and the default assumption.
- **Or copy `.gateway/secret.txt`** to the second machine out of band. Treat it like a password —
  it can mint a key for anyone, with any budget, for any model.
- **Do not re-run option 1 on a second machine** without that file. It generates a new secret,
  redeploys, and silently invalidates every key the first machine issued.

`admin.ps1` catches this on startup and refuses to continue:

```
[x]  Signing secret does NOT match the deployed gateway.
     Every key minted here would be rejected with 401.
```

Menu option **9 — Why is a key being rejected?** takes a key and names the actual cause
(wrong secret, not yet active, expired, revoked, or a model the gateway has not pinned)
instead of the gateway's one-size-fits-all message.

---

## Cost

| Item | Approx |
|---|---|
| API Management Basic v2, 1 unit | ~$250/month |
| Log Analytics + Application Insights | ingestion-based, small at this volume |
| DeepSeek tokens | pay-per-token, unchanged by the gateway |

The gateway bills whether or not anyone uses it. Tear it down when the event ends:

```powershell
./admin.ps1   # option 9
az apim deletedservice purge --service-name <apim-name> --location <region>
```

`purge` matters — a soft-deleted API Management instance keeps its globally unique name.

---

## Repository layout

```
admin.ps1                    interactive admin console — start here
src/
  entitlement.mjs            the access decision, as a pure tested function
  keys.mjs                   HS256 key minting and verification (zero dependencies)
  models.mjs                 the alias map, parsed and built
  apim.mjs                   which API Management instance can host this, and why not
  foundry.mjs                the models in the subscription, and the route that serves each
  anthropic.mjs              the Anthropic error envelope and body rewrites
infra/
  main.bicep                 gateway, observability, both APIs, policy, RBAC
  policy.xml                 the governance policy, OpenAI route
  policy-claude.xml          the governance policy, Claude route
scripts/
  mint.mjs                   thin shim so admin.ps1 never reimplements JWS
  Apim.ps1                   instance discovery and named-value access
  Models.ps1                 model discovery and pinning
  Keys.ps1                   key issuance and handouts
  Test-Governance.ps1        proves each control fires, per route
tests/                       317 tests, including tamper and alg:none attacks
docs/adr/                    architecture decisions and their reasoning
docs/UNKNOWNS.md             what we did not know, and how each was closed
```

`src/*.mjs` is the canonical statement of the rules; the policies and the PowerShell are
transcriptions of it. **Change one, change both** — the unit tests guard the modules, static
parity tests guard the transcriptions, and `Test-Governance.ps1` guards the deployed behaviour.

```powershell
npm test                                  # 70 tests
node .ironclad/gate.mjs --stage packet    # full quality gate
```

---

## Known limits

- **A single call can overshoot a small budget.** The budget is checked *before* a request, so the
  request that crosses the line still completes. Measured: a 300-token budget was overshot to 3,507
  by one call. The overshoot is bounded by one request — roughly `prompt + max-output-tokens`
  (default 8,192) — so it is negligible against a realistic budget and material only if you issue
  very small ones. Subsequent calls are refused.
- **Streaming drifts the counter.** API Management estimates tokens on streamed responses rather
  than reading actual usage, so `x-budget-used` is approximate. The `token-quota` underneath is the
  authoritative cap. See `docs/UNKNOWNS.md` U5.
- **On the Claude route, a streamed completion is not counted at all.** Measured 2026-10-04: a
  non-streamed 400-token completion counted 419 tokens; the same request with `stream: true`
  counted 16 — the prompt only. **Claude Code always streams**, so real spend runs well ahead of
  `x-budget-used` there. Three things still bound it: `max_tokens` is clamped to
  `hackgw-max-output-tokens` on every request, `hackgw-calls-per-minute` bounds request rate, and
  prompt tokens *are* counted and grow with every turn, so a long session does eventually trip the
  budget — later than the true spend, not never. Fine for a time-boxed event with a subscription
  spending cap; not a billing control. See `docs/UNKNOWNS.md` U15.
- **The budget counter uses the internal cache**, which is best-effort and not atomic under
  concurrency. The quota backstop bounds the damage. Move to external Redis if this outlives one
  event — roadmap P11.
- **JWTs cannot be revoked before `exp`** — the trade for offline issuance. The `jti` denylist
  covers it at the cost of one named-value update.

---

## License

MIT
