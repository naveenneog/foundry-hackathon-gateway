# Status

**Active packet:** P16 — choose from the models deployed across the subscription.

M1, M2 and M3 are complete and verified live. M5 (P15–P18) was requested after that: adopt an
APIM an organisation already runs, pick from the models actually deployed in the subscription,
and serve Claude models to Claude Code.

### P15 — attach to an existing API Management instance — DONE

| Criterion | Evidence |
|---|---|
| Instances listed with a verdict | `Select-ApimInstance` in `scripts/Apim.ps1`; logic in `src/apim.mjs`, 53 tests |
| Adds to the chosen instance, creates no second one | `infra/main.bicep` `apimNew` is `if (empty(existingApimName))`; compiled with `az bicep build` |
| Classic tier refused for the Claude route | `classifyApim` blocker `classic_tier`; UNKNOWNS U12 |
| A pre-existing role assignment does not fail the deployment | `needsRoleAssignment` / `Test-FoundryRoleNeeded` |

Not in the original criteria, found during the packet and fixed: named values and the logger are
namespaced `hackgw-` so nothing collides on a shared instance, and an API path already in use is
a blocker rather than a deploy-time failure.

### P15 council

| Seat | Verdict |
|---|---|
| Architect | PASS-WITH-NOTES — two declarations (`apimNew` + `existing`) is the supported shape. The adopted instance must share the deployment's resource group; recorded in ADR-0008 rather than worked around. |
| Coder | BLOCK, cleared — 8 findings, all fixed. The critical one: `module foundryRole` lost its ARM dependency when `apim` became an `existing` reference, so every fresh deployment would resolve `identity.principalId` against an instance that did not exist yet. |
| QA | PASS — the test that should have caught that bug matched `dependsOn` anywhere in the file; it now checks every direct child. Three detectors were negative-tested: the namespace check, the transcription-parity check, and `unknowns.open`. |
| UX | PASS — every instance is listed including unusable ones, each with the reason and whether deploying would add or update. The resource group is shown rather than prompted when an instance is adopted, because a free-text answer there fails as `ResourceNotFound` on the APIM name. |
| Security | PASS — namespacing removes the cross-API overwrite. The signing secret still never appears in argv. Enabling a missing managed identity is left to the operator: `az apim update` sets identity to `None` unless `--enable-managed-identity true` is passed, so doing it automatically could strip an identity other APIs depend on. |

### Detector repaired

`unknowns.open` reads markdown **table rows** containing `OPEN`. `docs/UNKNOWNS.md` was prose, so
the check had never been able to see anything in this repository and passed while measuring
nothing. The register now has a status table, and the check was negative-tested by marking U9
`OPEN` and confirming the warning.


## Live deployment (verified 2026-08-31)

| | |
|---|---|
| Subscription | `MCAPS-Hybrid-REQ-67471-2023-navg` |
| Resource group | `rg-hackathon-gateway` (eastus2) |
| Gateway | `https://apim-hackgwfl4s7jvpxekno.azure-api.net/v1` |
| Foundry account | `foundry-plus-resource` (`rg-contosohub`, eastus2) |
| `flash` | `deepseek-v4-flash` → `DeepSeek-V4-Flash-0731` (2026-07-31) |
| `pro` | `deepseek-v4-pro` → `DeepSeek-V4-Pro` (2026-04-23) |

## Packets

| Packet | State | Evidence |
|---|---|---|
| P1 scaffold + charter | done | gate passes |
| P2 key lifecycle | done | `src/keys.mjs`, 33 tests |
| P3 entitlement engine | done | `src/entitlement.mjs`, 37 tests |
| P4 policy | done | `infra/policy.xml`, deployed and serving |
| P5 infrastructure | done | deployed; APIM BasicV2 + App Insights + Log Analytics |
| P6 interactive admin | done | `admin.ps1` |
| P7 model deployment | done | both DeepSeek models deployed via CLI |
| P8 **opencode verified** | **done** | real agent session, Write + Read tool calls |
| P9 **control verification** | **done** | 15/15 controls pass live |
| P10 documentation | done | README, 5 ADRs, unknowns register |

## Commands that prove it

```powershell
npm test                                   # 70 passing
node .ironclad/gate.mjs --stage packet     # PASS
./scripts/Test-Governance.ps1 -GatewayUrl https://apim-hackgwfl4s7jvpxekno.azure-api.net/v1 `
    -SecretPath .gateway\secret.txt        # 15 passed, 0 failed
```

## Live verification output

```
[PASS] valid key is served                -> 200
[PASS] missing key rejected               -> 401
[PASS] forged signature rejected          -> 401
[PASS] expired key rejected               -> 401
[PASS] not-yet-active key rejected        -> 401
[PASS] model allowlist enforced           -> 403
[PASS] unpinned model rejected            -> 403
[PASS] tool calls accepted on pro         -> 200
[PASS] tool calls accepted on flash       -> 200
[PASS] one-time budget exhausts (403)     -> 403
[PASS] exhausted budget is not retryable  -> True
[PASS] exhausted budget sets no Retry-After -> True
[PASS] exhausted budget reports 0 remaining -> True
[PASS] exhausted budget body says so      -> True
[PASS] budget headers returned            -> True

15 passed, 0 failed
```

opencode, through the gateway, on `flash`:

```
> build · flash
I'll create the hello.py file with the add function.
← Write hello.py
Wrote file successfully.
→ Read hello.py
Created and confirmed `hello.py` with `add(a, b)` that returns `a + b`.
```

Budget accounting across that session: **29,157 / 500,000 tokens**, tracked continuously via
`x-budget-used`.

## Acceptance criteria — all met

- [x] G1 model allowlist — 403 on an unlisted model, verified live
- [x] G2 one-step key issuance — `admin.ps1` option 4
- [x] G3 time-bound — expired and not-yet-active both rejected live
- [x] G4 spend-bound — one-time budget exhausts with 403, verified live
- [x] G5 attribution — `x-budget-used` per key; metrics to App Insights
- [x] G6 **opencode verified end to end** — real agentic session with tool calls
- [x] G7 no credential leaves Azure — managed identity only

## What live testing changed

| Finding | Consequence |
|---|---|
| `DeepSeek-V4-Pro` **does** support tool calling, contradicting Microsoft Learn | Removed the hard 400 guard rail before it shipped. ADR-0003 rewritten. |
| `token-quota="@(context.Variables[...])"` failed APIM validation | Explicit `(long)` cast. Caught only by deploying — no static check finds it. |
| Exact catalog names and versions | `DeepSeek-V4-Flash-0731` / `2026-07-31`; `admin.ps1` had wrong casing and version `1`. Fixed. |

## Remaining work (M4, optional)

Only relevant if this outlives a single event — see `docs/ROADMAP.md` P11–P13.

## Teardown

```powershell
az group delete -n rg-hackathon-gateway --yes --no-wait
az apim deletedservice purge --service-name apim-hackgwfl4s7jvpxekno --location eastus2
# The DeepSeek deployments live in rg-contosohub and are left in place:
#   az cognitiveservices account deployment delete -n foundry-plus-resource -g rg-contosohub --deployment-name deepseek-v4-flash
#   az cognitiveservices account deployment delete -n foundry-plus-resource -g rg-contosohub --deployment-name deepseek-v4-pro
```
