# Status

**Active packet:** none — P26 complete, CI green on all three platforms.

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

### P26 — macOS and Linux run the same console — DONE (`7557aaf`, `5bf3c45`, `6bcb87e`)

The request was "an equivalent script for Mac and Linux, tested in CI". An audit of all six
`.ps1` files found exactly two Windows-only blocks, both the same ACL call: no `cmd /c`, no
backslash path building, no registry, no COM. PowerShell 7 is cross-platform and already required
by ADR-0006, so a bash twin would be a 2,400-line transcription of working code — and this repo
has already paid for transcription drift twice, most recently in P25. ADR-0010 records the
decision to make the one implementation portable instead.

Writing the test found a real defect rather than confirming the code was fine. `New-SigningSecret`
restricted the secret with `Get-Acl`/`Set-Acl` and a `FileSystemAccessRule` — all Windows-only —
inside a `try`/`catch` that warned and continued. On Linux and macOS that `catch` fires every
time, so the file kept the default umask while appearing to be protected. The same applied to the
deployment parameters file, which holds the secret in cleartext until the `finally` removes it.

`Protect-File` (`scripts/Platform.ps1`) replaces both: ACLs on Windows, `chmod 600` elsewhere,
verified by reading the mode back, and it throws where the old code warned.

**Measured** on run
[37207259672](https://github.com/naveenneog/foundry-hackathon-gateway/actions/runs/37207259672):
364/364 on `ubuntu-latest`, `macos-latest` and `windows-latest`, with `ok 2 - the file is readable
only by its owner` present in the Linux log — the mode assertion executed rather than skipped.
UNKNOWNS U19 and U20 closed.

The first run also failed the launcher check, for a reason worth keeping: the step cleared `PATH`,
which meant `/usr/bin/env bash` could not be resolved and `admin.sh` never ran at all. It also
showed `admin.sh` used `dirname` — an external command — before reaching its own prerequisite
check, so with a broken `PATH` it would die before printing the guidance it exists to print. Both
fixed; the path is now resolved with bash parameter expansion, and the step resolves `bash`
before clearing `PATH`.

### Council — P26

Three BLOCKs, all on the same theme: the packet was green on paths nothing executed.

| Seat | Verdict | Finding |
|---|---|---|
| Architect | PASS-WITH-NOTES | the detector enforcing "cross-platform" covered 6 of 8 `.ps1` files |
| Coder | BLOCK | `"$@"` under `set -u` on bash 3.2; unprotected secret persisted; fail-open read-back |
| QA | BLOCK | the handover line had zero execution coverage on any platform |
| UX | PASS-WITH-NOTES | Debian-only guidance for every Linux; a throw exited the whole console |
| Security | BLOCK | the error path re-created U19, and the reuse path never re-protected |

The three that mattered most, because the suite was green over all of them:

1. **macOS ships bash 3.2**, where `set -u` treats `"$@"` as unset with no arguments — so
   `./admin.sh` with no arguments, the documented way to open the menu, would have died with
   `$@: unbound variable`. `macos-latest` was green because the only launcher check cleared
   `PATH` and exited long before the handover line. Fixed with `${1+"$@"}`, and CI now execs
   that line against a fake `pwsh` with zero arguments, with one argument, and under `/bin/bash`
   explicitly.
2. **A failed `Protect-File` left the secret on disk.** `Set-Content` ran first, so the file
   already existed with the default umask; the throw then aborted the run, and the next run's
   `Get-SigningSecret` reused it without re-checking and reported success. That is U19 again, on
   the error path this packet added. The file is now created empty, restricted, then written —
   no window at all — removed if the restriction fails, and re-asserted on every read.
3. **The mode read-back failed open.** `stat` exiting non-zero skipped the check and returned
   success, on exactly the mounts (exFAT, 9p, some SMB and NFS) where `chmod` also returns 0 for
   a world-readable file — so both halves failed together and silently. Unreadable or
   unparseable output is now a failure.

Also fixed: the Windows-only-API scan discovers `.ps1` files instead of listing them (it had
silently stopped covering `scripts/Preflight.ps1`); the menu catches per action rather than
exiting with a stack trace; the non-macOS install guidance points at the pages that branch by
distro rather than Debian-only commands; `admin.sh` follows symlinks, since putting a launcher on
`PATH` by symlink is the usual reason to have one.

Both new ordering assertions were negative-tested: writing before restricting, and dropping the
cleanup, each turn the test red.

**Verified** on run
[37208582696](https://github.com/naveenneog/foundry-hackathon-gateway/actions/runs/37208582696):
green on all four jobs. The macOS log reads
`/bin/bash (3.2.57(1)-release): HANDOVER ok args=3` — the handover line executing with zero
arguments under the exact bash that would have rejected it.

### P25 — deploy onto whatever is already there — DONE (`3eab12e`)

An operator ran option 1 against their own instance, `apim-claude-gw-fzgql9`, and the deployment
failed. ARM deployments are atomic, so it also left the instance half-built. Three separate
defects, all of them the same mistake — code that assumed an empty target:

| | What happened | Fix |
|---|---|---|
| Path collision | Another product already published an API at `/claude`, so `claude-gateway` could not be created there. The picker knew; the deploy did not. | `claudeApiPath` is a Bicep parameter; `suggestFreePath` offers `claude-hackgw` |
| Role grant | The account already had the role, from a different assignment name, so `guid()` determinism did not help. `RoleAssignmentExists`. | `grantFoundryRole` parameter, set from `Test-FoundryRoleNeeded` |
| Default pins | A new install started pinned to two DeepSeek deployments that need not exist. | Pins start empty; option 1 pins from the subscription |

The general fix is that option 1 now **reads the target before it writes to it** and prints what
it found:

```
    API Management   REUSE    apim-claude-gw-fzgql9 (BasicV2) is reused as-is.
    Foundry account  OK       ai-contosohub530569751908, 29 deployment(s).
    Model: sonnet-5  OK       claude-sonnet-5 (claude).
    Model: ghost     BLOCKED  'not-deployed-anywhere' is not deployed in ...
    OpenAI route     UPDATE   'deepseek-gateway' is already published; policy and operations are updated.
    Claude route     CREATE   'claude-gateway' will be added at /claude-hackgw.
    Named values     UPDATE   7 already present; values are refreshed.
    Foundry access   OK       Already granted; not re-granting.
```

That output is from the real failing instance. The 7 named values and the published
`deepseek-gateway` are what its half-applied deployment left behind; the plan reports them as
UPDATE rather than CREATE, which is the checkpoint behaviour asked for. A BLOCKED row stops the
deployment unless the operator confirms.

`buildDeploymentPlan` in `src/apim.mjs` holds the decision logic and is tested in isolation
(`tests/deployment-plan.test.mjs`, 23 tests). `Show-DeploymentPlan` gathers the facts and renders
the answer, reaching the decision through `scripts/plan.mjs` — the same stdin-JSON shim pattern
`mint.mjs` and `diagnose.mjs` already use.

Council found that the first cut of this did **not** work that way: the PowerShell carried its own
transcription of the rules, and the two copies drifted in the worst direction. On an instance that
was both on a classic tier *and* had `/claude` taken, the tested copy said BLOCKED and the shipping
copy said CREATE — it would have published a Claude route whose token cap meters nothing, which is
exactly what ADR-0009 exists to prevent. The blockers arrive in one array and the path workaround
masked the tier. Fixed in both the rule (a path collision is curable, a tier is not, so the tier is
judged first) and the structure (the transcription is deleted; there is one copy now).

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
