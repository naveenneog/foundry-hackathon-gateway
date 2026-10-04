# Status

**Active packet:** none — M5 complete and verified live.

M1, M2, M3 and M5 are complete. M5 (P15–P19) added: adopt an APIM an organisation already runs,
pick from the models actually deployed in the subscription, serve Claude models to Claude Code,
and prove it live.

## Live deployment (verified 2026-10-04)

| | |
|---|---|
| Subscription | `MCAPS-Hybrid-REQ-67471-2023-navg` |
| Resource group | `rg-hackathon-gateway` (eastus2) |
| API Management | `apim-hackgwfl4s7jvpxekno` (BasicV2, adopted rather than recreated) |
| Foundry account | `ai-contosohub530569751908` (`rg-contosohub`, eastus2) |
| OpenAI route | `https://apim-hackgwfl4s7jvpxekno.azure-api.net/v1` |
| Claude route | `https://apim-hackgwfl4s7jvpxekno.azure-api.net/claude` |
| Claude backend | `https://ai-contosohub530569751908.services.ai.azure.com/anthropic` |
| `flash` / `pro` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `sonnet-5` / `opus-5` | `claude-sonnet-5` / `claude-opus-5` |

### P22 — prove the three guarantees a key makes — DONE

Asked directly: does a key spend only its budget, only within its window, and stop on revocation?
Each measured against the live gateway rather than asserted from the policy.

**Budget — enforced, accuracy depends on streaming.** Same key shape, same prompt, 2,000-token
budget, 500 `max_tokens` per request:

| | Stopped after | Real tokens spent | `x-budget-used` |
|---|---|---|---|
| `stream: false` | 5th request | 2,080 (+4%) | 2,080 — exact |
| `stream: true` | 7th request | 3,120 (+56%) | 108 — wrong by 29× |

The cap fires on both. The header is the part that breaks: it is fed by the cache counter, while
the cap is enforced by APIM's own quota. This **corrects** yesterday's U15, which said streamed
completions were not metered at all — they are, by the quota, just not by the counter.

**Time window — enforced with nothing running.** `exp` and `nbf` are checked by `validate-jwt`
on every request; expired and not-yet-active keys both return 401, verified on both routes. The
gateway's clock decides, with 60 seconds of permitted skew.

**Revocation — under ten seconds, and only the key named.** Previously untested: the harness had
no revocation check at all, which is why this packet exists. It now mints a key, confirms 200,
adds its `jti` to the denylist, polls until refused, and confirms a second key is unaffected. It
refused on the first poll on the Claude route and the second on the OpenAI route, against a
five-second polling interval — so "under ten seconds", not "one second".

The check needs to edit a named value, so it runs only when `-ApimName` and `-ResourceGroup` are
supplied and reports **NOT CHECKED** otherwise. It restores the denylist in a `finally` block, so
an interrupted run cannot leave real keys un-revoked.

```
Test-Governance.ps1 -Route claude ... -ApimName ... -ResourceGroup ...
  [PASS] key works before revocation        -> 200
  [PASS] revoked key rejected               -> 403     revocation took effect in 1s
  [PASS] other keys unaffected by revocation -> 200
  24 passed, 0 failed
```

### P21 — a worked example: a Claude agent with tool calls — DONE

`examples/claude-agent.ipynb`, executed against the live gateway and committed with its output.
Forty lines of agent loop on the ordinary `anthropic` SDK: two parallel `get_order_status`
calls, a chained `calculate`, a correct final answer, and the gateway's budget headers.

The notebook reads the key from the environment and never writes it to a cell.
`tests/example-notebook.test.mjs` enforces that — negative-tested by injecting a JWT into a cell
output and confirming the failure — and pins the two mistakes the example exists to prevent:
`ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN`, and shortening the alias to a Claude Code
model slot.

### P19 — verify the Claude route live — DONE

```
Test-Governance.ps1 -Route claude   21 passed, 0 failed
Test-Governance.ps1 -Route openai   15 passed, 0 failed
```

A real Claude Code session (v2.1.272), configured only by the `.claude/settings.json` that
option 5 generates, created a file through tool calls and exited 0:

```
> Create hello.py with add(a,b)... then read it back and reply DONE.
DONE
hello.py  ->  def add(a, b):
                  return a + b
```

### What live testing changed, again

| Finding | Consequence |
|---|---|
| **`sonnet`, `opus` and `haiku` are Claude Code model slots.** With `ANTHROPIC_MODEL=sonnet` the client sent `claude-sonnet-5` instead, and the key was refused. | `suggestAlias` now keeps the version (`claude-sonnet-5` → `sonnet-5`), pinning refuses a reserved alias, and the card says why. Nothing static could have caught this. |
| **A machine with Claude Code already configured overrides the participant's variables.** A `settings.json` carrying `model`, `ANTHROPIC_DEFAULT_*_MODEL` or `CLAUDE_CODE_USE_FOUNDRY` wins over the env, and requests go to the old destination. | Documented in the card with the fix (`claude --settings`, or merge and remove the conflicting keys). |
| **Streamed completions are not metered on the Claude route.** 419 tokens counted non-streamed; 16 for the same request streamed. Claude Code always streams. | Recorded as UNKNOWNS U15 with its bound, and in the README's known limits. The cap is not a billing control on this route. |
| The gateway's configured Foundry account held no deployments at all | The OpenAI route had been returning 404 on every call. Repointing it at the account that actually has the models fixed it. |

### Council — P19

| Seat | Verdict |
|---|---|
| Architect | PASS — one Foundry account serves both routes, so no second account or role grant was needed. |
| Coder | PASS-WITH-NOTES — the reserved-alias fix is in `src/foundry.mjs` with the PowerShell transcribing it, and a parity test pins the list on both sides. |
| QA | PASS — both routes verified against the live gateway, then re-verified after the alias change. The end-to-end run used the generated handout verbatim rather than hand-written settings. |
| UX | PASS — the three failures a participant can hit (wrong variable, slot-name alias, pre-existing config) are each named in the card with the fix. |
| Security | PASS — no participant credential reaches Foundry; the managed-identity audience is confirmed correct by a 200. |

---

### P18 — Claude Code setup and verification harness — DONE

| Criterion | Evidence |
|---|---|
| The harness covers the Claude route | `scripts/Test-Governance.ps1 -Route claude`; option 11 runs it per route that has pins |
| The participant setup is documented exactly | README and the generated card name `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` |
| A key is usable in Claude Code | option 5 writes `.claude/settings.json` with the env block; verified by generating handouts for all three grant combinations |

### P18 council

| Seat | Verdict |
|---|---|
| Architect | PASS — one harness parameterised by route rather than a second copy; the request shape, headers and tool schema are the only route-specific parts. |
| Coder | BLOCK, cleared — 3 findings. With only one model pinned on a route, the allowlist test asked for a model the key *did* grant and would have reported a working control as broken. A key granting only Claude models, issued before the Claude route was published, printed its token nowhere and wrote it nowhere — the key was minted and lost. The "unpinned model" test used `gpt-4o`, which an operator could legitimately have pinned under that alias. |
| QA | PASS — the handout generator was run for all three grant combinations and the lost-token case reproduced before the fix and confirmed after. The ghost alias is now generated so it cannot collide. |
| UX | PASS — the card leads with the two mistakes that produce a bare 401 and a 403: the wrong credential variable, and a missing `ANTHROPIC_MODEL`. |
| Security | PASS — `handouts/` is gitignored, which covers the new `.claude/settings.json`. The token is printed once, as before. |

### P17 — Claude route, the Anthropic Messages API — DONE

| Criterion | Evidence |
|---|---|
| `POST {gateway}/claude/v1/messages` reaches a Claude deployment | `infra/main.bicep` `claudeApi`, backend `endpoints['AI Foundry API'] + anthropic` |
| The same key controls apply | `infra/policy-claude.xml` steps 1–9, same claims and counters as the OpenAI route |
| Every rejection is Anthropic-shaped | `src/anthropic.mjs`, 29 tests; `tests/claude-route.test.mjs` asserts every error body in the policy |
| One budget across both routes | both policies write the cache key `used-<sub>` with identical semantics |

**Live verification is P18.** Everything here is proven statically and by unit test; no request
has been made against a deployed Claude route.

### P17 council

| Seat | Verdict |
|---|---|
| Architect | PASS — a separate API with its own policy rather than another operation, because the endpoint, the wire format and the error shape all differ. The alias map is per-route for the same reason. |
| Coder | BLOCK, cleared — 3 defects. `set-body` is not legal in `on-error`, which would have failed the deployment outright. The body clamp ran for `count_tokens`, injecting a field that endpoint rejects, making every token count a 400. The quota rewrite sat in `<outbound>`, which a policy error never reaches. |
| QA | PASS — a comment containing `--` (illegal in XML, rejected by APIM) was found by validating the policy as XML, and is now a negative-tested detector. The `on-error` and `count_tokens` fixes each have their own assertion. |
| UX | PASS — the rejection for a missing `ANTHROPIC_MODEL` names the variable, because Claude Code otherwise sends its own default model id and the allowlist refuses it with no clue why. |
| Security | PASS — the participant token never reaches Foundry; both `api-key` and `x-api-key` are stripped. `context.LastError.Message` carries pipeline diagnostics, not named values. |

### P16 — choose from the models deployed across the subscription — DONE

| Criterion | Evidence |
|---|---|
| Lists every Foundry account's deployments | `Get-FoundryCatalogue`; logic in `src/foundry.mjs`, 36 tests |
| Shows the wire format each model speaks | `wireFormatOf` / `Get-WireFormat`, pinned by a parity test |
| Refuses a pin that crosses routes | `canPin` / `Test-CanPin` |

One map per route: `hackgw-model-map` and `hackgw-claude-model-map`. A route with no pins is
written as a lone `;`, never an empty string, so removing a route's last pin still lands.

### P16 council

| Seat | Verdict |
|---|---|
| Architect | PASS — the wire format is a property of the deployment, so the route is derived rather than chosen. A model can only be pinned where it can actually be served. |
| Coder | BLOCK, cleared — 2 findings. Splitting the map by route broke key diagnosis: it read only the OpenAI map, so a valid Claude alias was reported `model_not_configured`. Reproduced and fixed with `mergeModelMaps`. Dead code (`Get-FoundryDeployments`, zero callers) removed. |
| QA | PASS — the format-parity detector was negative-tested by removing a format from the script. The diagnosis regression was proved by running a real minted key through `diagnoseKey` before and after. |
| UX | PASS — deployments are grouped by account, and one in a different account than the gateway's warns before pinning, because the gateway can only reach its own account. Claude models are named in option 4 as portal-only rather than being silently absent. |
| Security | PASS — discovery is read-only. No new credential path; the alias map still carries no secret. |

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


## Earlier live deployment (2026-08-31, superseded)

The gateway was first verified against `foundry-plus-resource`. By 2026-10-04 its configured
account was `aif-gfsrxqjqqzije`, which held **no deployments at all**, so the OpenAI route had
been returning 404 on every call. P19 repointed it at `ai-contosohub530569751908`, which holds
both the DeepSeek and the Claude models, and both routes now pass.

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
| P15 adopt an existing APIM | done | `src/apim.mjs`, `scripts/Apim.ps1`, ADR-0008 |
| P16 subscription-wide models | done | `src/foundry.mjs`, route-aware pinning |
| P17 Claude route | done | `infra/policy-claude.xml`, ADR-0009 |
| P18 Claude Code handout + harness | done | `.claude/settings.json`, `-Route claude` |
| P19 **live verification** | **done** | 21/21 claude, 15/15 openai, real Claude Code session |
| P21 worked example | done | `examples/claude-agent.ipynb`, executed against the live gateway |

## Commands that prove it

```powershell
npm test                                   # 328 passing
node .ironclad/gate.mjs --stage packet     # PASS
./admin.ps1                                # 11  Verify the controls (runs both routes)
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
