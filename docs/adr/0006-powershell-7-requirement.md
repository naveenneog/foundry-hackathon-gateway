# ADR-0006 — PowerShell 7.0 is a hard requirement

**Status:** Accepted
**Date:** 2026-08-31
**Packet:** P6

## Context

`admin.ps1` and `scripts/Test-Governance.ps1` are the operator-facing scripts. They were
originally written on PowerShell 7 and shipped without stating a requirement.

Windows PowerShell 5.1 is the default shell on Windows, so that is what an organiser gets by
double-clicking or opening a normal terminal. Running there produced, in sequence:

| # | Symptom on 5.1 | Cause |
|---|---|---|
| 1 | A wall of `Unexpected token '??'` | `??` null-coalescing is PowerShell 7+ |
| 2 | `Method invocation failed ... Fill` | `RandomNumberGenerator::Fill` is .NET Core only |
| 3 | Parameter binding failure | `-SkipHttpErrorCheck` is PowerShell 7+ |
| 4 | `Unable to find type [HttpResponseException]` | naming a 7-only type in a `catch` filter |
| 5 | `String was not recognized as a valid DateTime` | **silent data corruption** — see below |

Each was found only by *running* the script, and each surfaced in front of a user.

### The one that decided it

Finding 5 was not a display bug. On 5.1, `,$Keys | ConvertTo-Json` serialises the array
**wrapper** rather than the array:

```json
{ "value": [ { "jti": "k_1", ... } ], "Count": 1 }
```

Reading that back yields one object with none of the key fields. Measured on both hosts:

```
powershell.exe   expiresAt=[]
pwsh             expiresAt=[2026-09-02 15:00:00Z]
```

So `issued-keys.json` was **corrupted on write**. That broke the key listing visibly — and
`Revoke-Key`, which iterates the same records, **silently**. A revocation that appears to succeed
but does not is the worst failure this project can have.

## Decision

**PowerShell 7.0 or later is required.** Windows PowerShell 5.1 is explicitly unsupported.

Enforced in two places:

1. **`#Requires -Version 7.0`** at the top of each operator script. Verified empirically that the
   host honours this *before parsing the file*, so it produces a clean, actionable message even
   when the script contains 7-only syntax:

   > The script 'admin.ps1' cannot be run because it contained a "#requires" statement for
   > Windows PowerShell 7.0. The version of Windows PowerShell that is required by the script
   > does not match the currently running version of Windows PowerShell 5.1.

2. **The preflight** hard-fails below 7.0 with the install command, as belt-and-braces for
   dot-sourced or otherwise non-standard invocation.

### Why 7.0 and not something higher

7.0 is the genuine technical floor — it is what `??`, `-SkipHttpErrorCheck` and correct
`ConvertTo-Json` array handling require. Picking a higher minimum would exclude working hosts for
no reason. The preflight *warns* below 7.4 because 7.0–7.3 are past end of support, but does not
block.

## Why not keep supporting 5.1

It was working when this decision was taken — 15/15 controls passed on both hosts. The argument
against continuing:

- **Five distinct incompatibilities in one script, all found at runtime.** That is the shape of a
  long tail, not a closed set. Confidence that a sixth does not exist is low, and the cost of
  discovering it is an organiser stuck mid-event.
- **The audience is small and controllable.** Organisers are typically one to three people who set
  the event up in advance. Participants never run PowerShell at all — they need `opencode` and two
  environment variables.
- **Installing is one command**: `winget install --id Microsoft.PowerShell --source winget`.
- **The failure mode was silent.** Finding 5 corrupted state rather than erroring. A compatibility
  surface that can silently corrupt data is not worth carrying for a three-person audience.

## Consequences

- Organisers on a locked-down machine without install rights cannot run the admin console. They can
  still deploy with `az deployment group create` directly, and mint keys with
  `node scripts/mint.mjs` — neither needs PowerShell.
- The cross-version code written for 5.1 was simplified back where it added complexity
  (`Invoke-Gateway` no longer branches). The genuinely-more-correct fixes were kept: explicit array
  form in `Save-IssuedKeys`, culture-invariant date parsing, and defensive rendering of malformed
  records — all of which also repair a file corrupted by an earlier 5.1 run.
- `tests/powershell-requirement.test.mjs` asserts both scripts declare `#Requires -Version 7.0`
  before any executable line, and that the preflight fails rather than warns.
