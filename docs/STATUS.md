# Status

**Active packet:** P9 — verify the governance controls fire against a live deployment

## Delivered in this cycle

| Packet | State | Evidence |
|---|---|---|
| P1 scaffold + charter | done | `.ironclad/charter.json`, docs ledger, gate |
| P2 key lifecycle | done | `src/keys.mjs`, 33 tests |
| P3 entitlement engine | done | `src/entitlement.mjs`, 37 tests |
| P4 policy generation | done | `infra/policy.xml` transcribed from the engine |
| P5 Bicep infrastructure | done | `infra/main.bicep`, `infra/foundry-role.bicep` |
| P6 interactive admin | done | `admin.ps1` |
| P7 model selection | done | `admin.ps1` options 2 and 3 |
| P10 documentation | done | README, 5 ADRs, unknowns register |
| P8 / P9 live verification | **blocked** | needs an Azure subscription |

## Commands that prove it

```powershell
npm test                                   # 70 passing
node .ironclad/gate.mjs --stage packet     # PASS - 23 passed, 0 failed
az bicep build --file infra/main.bicep     # clean
./admin.ps1                                # option 8 verifies controls live
```

## Council verdicts

| Seat | Verdict | Notes |
|---|---|---|
| Architect | PASS-WITH-NOTES | Cache/quota split is now explicit: cache advisory, quota authoritative (U6). |
| Coder | PASS-WITH-NOTES | Dead `try/catch` in the `keys.mjs` decode path noted, harmless, left. |
| QA | PASS-WITH-NOTES | `Test-Governance.ps1` is sequential, so it cannot exercise the concurrency case in U6. |
| UX | PASS | Participant card lists every failure code and states which is retryable. |
| Security | **BLOCK → resolved** | 3 HIGH, 3 MEDIUM. All fixed; see below. |

### Security findings and their fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | Minter signed with the ASCII of the secret; APIM Base64-decodes it. Keys would never verify, on ~74% of deployments. | ADR-0005. `keyMaterial()` decodes and validates; `generateSecret()` and `New-SigningSecret` emit standard Base64. 9 regression tests. |
| 2 | HIGH | Signing secret passed in `az` argv — readable from the process table and Event ID 4688. | ACL-restricted parameters file, deleted in `finally`. |
| 3 | HIGH | `revoked-keys` is Bicep-declared, so "Deploy / update" silently un-revoked every key. | Live value read and passed through, unioned with local state. |
| 4 | MED | Cache `default-value="0"` granted a fresh budget on every eviction — the opposite of the tested canon. | `default-value="unknown"`; an unparseable value defers to the authoritative quota. |
| 5 | MED | `max_completion_tokens` unclamped, so the output cap was bypassable. | Both fields clamped defensively; `n` pinned to 1. |
| 6 | MED | `sub` collisions silently share one budget and rate limit. | GUID-derived default, plus an explicit re-issue confirmation. |
| — | bug | `GET /v1/models` always 403'd, though the participant card told people to call it. | Answered before the allowlist check, returning only that key's granted models. |

Clean on review: `verifyKey` signature verification (no `alg:none`, no algorithm confusion, no
canonicalisation bypass, constant-time compare), the model allowlist fail-closed path, the
managed-identity credential swap, and `.gitignore` coverage of `.gateway/` and `handouts/`.

## Acceptance criteria

- [x] G1 model allowlist — signed claim, enforced in policy, tested
- [x] G2 one-step key issuance — `admin.ps1` option 4
- [x] G3 time-bound — JWT `nbf`/`exp`, self-enforcing
- [x] G4 spend-bound — one-time budget; 403 stops the client (ADR-0004)
- [x] G5 attribution — `llm-emit-token-metric` per participant
- [ ] G6 **opencode verified end to end** — blocked, see below
- [x] G7 no credential leaves Azure — managed identity only

## Blocked

**G6 cannot be closed from here.** It needs an Azure subscription with a Foundry account and
DeepSeek deployments. Everything up to that boundary is tested; `scripts/Test-Governance.ps1` is
written and will prove the controls the moment a deployment exists.

## Next

1. Deploy (`./admin.ps1` → 1).
2. Run option 8 and record the output.
3. Run a real opencode session doing a file edit; confirm tool calls succeed against `flash` and
   are rejected with a clear 400 against `pro`.
4. Confirm `GET /v1/models` returns the granted aliases.
5. Close U5 with observed streaming behaviour.
