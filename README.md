# Foundry Hackathon Gateway

Hand out **time-bound, spend-capped API keys** for DeepSeek models on Microsoft Foundry, so
hackathon participants can build real apps with **opencode** — and nobody holds a model credential
or can overspend.

One interactive script does everything.

```powershell
./admin.ps1
```

![Admin console](docs/images/admin-menu.png)

---

## What a participant gets

Two environment variables. That is the whole setup.

```bash
OPENAI_BASE_URL=https://<your-gateway>.azure-api.net/v1
OPENAI_API_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

They work in `opencode`, the OpenAI SDK, Aider, Continue, `curl` — anything that speaks the OpenAI
wire format.

The key **is** the entitlement. It carries, signed and untamperable: which models it may call, when
it starts working, when it dies, and how many tokens it may spend.

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
#  1  Deploy / update the gateway     (~5 min)
#  3  Deploy a DeepSeek model         (if you have not already)
#  4  Issue a participant key
```

Option 4 writes `handouts/<team>/` containing a ready-to-paste `opencode.json` and a one-page card
for the participant.

**Requirements:** an Azure subscription, a Microsoft Foundry (`AIServices`) account, the Azure CLI,
PowerShell 7+, and Node 20+.

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

## The two models

| Alias | Foundry deployment | Best for |
|---|---|---|
| `flash` | `DeepSeek-V4-Flash-0731` | **Default.** Agent loop, file edits. Faster, cheaper. |
| `pro` | `DeepSeek-V4-Pro` | Hard reasoning. Slower, pricier. |

Both support tool calling, so both work in `opencode`.

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

Limits are API Management named values, so changing one is a config edit, not a redeployment:

| Named value | Default | Meaning |
|---|---|---|
| `tpm-per-key` | 40,000 | tokens/minute per participant |
| `calls-per-minute` | 240 | request ceiling per participant |
| `max-output-tokens` | 8,192 | hard cap on any single completion |
| `model-flash` / `model-pro` | — | what each alias resolves to |
| `revoked-keys` | `,` | denylist, managed by `admin.ps1` |

```powershell
az apim nv update -g rg-hackathon-gateway --service-name <apim> `
    --named-value-id max-output-tokens --value 4096
```

**Emergency stop:** rotating `signing-key` invalidates every outstanding key at once.

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
infra/
  main.bicep                 gateway, observability, API, policy, RBAC
  policy.xml                 the governance policy
scripts/
  mint.mjs                   thin shim so admin.ps1 never reimplements JWS
  Test-Governance.ps1        proves each control fires
tests/                       70 tests, including tamper and alg:none attacks
docs/adr/                    architecture decisions and their reasoning
docs/UNKNOWNS.md             what we did not know, and how each was closed
```

`src/entitlement.mjs` is the canonical statement of the access rules; `infra/policy.xml` is its
transcription into policy expressions. **Change one, change both** — the tests guard the former,
`Test-Governance.ps1` guards the latter.

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
- **The budget counter uses the internal cache**, which is best-effort and not atomic under
  concurrency. The quota backstop bounds the damage. Move to external Redis if this outlives one
  event — roadmap P11.
- **JWTs cannot be revoked before `exp`** — the trade for offline issuance. The `jti` denylist
  covers it at the cost of one named-value update.

---

## License

MIT
