# ADR-0010 — One cross-platform script, not a bash twin

**Status:** Accepted
**Date:** 2026-10-04
**Packet:** P26

## Context

The request was "make an equivalent script for Mac and Linux, and test them in CI". The operator
console is `admin.ps1` plus five dot-sourced modules under `scripts/` — about 2,400 lines of
PowerShell covering deployment, model pinning, key issuance, revocation and diagnosis.

The obvious reading is a second implementation in bash. That is worth examining before it is
rejected, because it is what was asked for.

ADR-0006 already requires PowerShell 7, and the reason it gives is relevant here: PowerShell 5.1
was dropped because five separate incompatibilities were found by running the script, one of which
corrupted `issued-keys.json` silently. The cost of a second dialect was measured, not assumed.

## Options

**A — A bash port of `admin.ps1`.** Literally what was asked. It also doubles every future change,
and the two copies have to agree about key minting, revocation and budget arithmetic. This repo has
already paid for transcription drift twice: `Show-DeploymentPlan` carried a copy of
`buildDeploymentPlan` whose verdict differed from the tested one on a classic-tier instance (P25),
and `scripts/Models.ps1` still carries transcriptions of `src/foundry.mjs` guarded by parity tests.
A 2,400-line transcription in a second language, maintained by whoever is next in the repo, drifts
the first time someone fixes one side only. The failure mode is a revocation that appears to
succeed on one platform and does not on the other — the exact failure ADR-0006 called "the worst
failure this project can have".

**B — Rewrite the console in Node.** The signing, diagnosis and planning logic is already Node and
already tested; the PowerShell is the thinner half. This is the right long-term shape, but it
rewrites working, live-verified code for a portability problem that is currently eight lines wide.
Filed as a roadmap entry rather than done here.

**C — Make the one implementation run everywhere.** PowerShell 7 is cross-platform and already
required. An audit of all six `.ps1` files found exactly two Windows-only blocks, both the same
ACL call, and nothing else: no `cmd /c`, no backslash path building, no `%USERPROFILE%`, no
registry, no COM.

## Decision

**Option C.** The scripts become cross-platform; there is no second implementation.

The two ACL blocks are replaced by one `Protect-File` helper that restricts a file to its owner
using the mechanism the running platform has — `Get-Acl`/`Set-Acl` on Windows, `chmod 600`
elsewhere — and **fails loudly** rather than warning if it cannot.

`admin.sh` is added as a launcher, not a port: it checks for `pwsh`, `az` and `node`, prints the
install command for whichever is missing, and execs `admin.ps1`. It is 40 lines and has no
behaviour to drift.

## Consequences

- One implementation, three platforms. A fix lands once.
- CI runs the suite on `ubuntu-latest`, `macos-latest` and `windows-latest`. The permission check
  runs under `pwsh` on each and asserts the mode of a file it actually created, so the claim
  "cross-platform" is measured per platform rather than asserted once.
- `Protect-File` now throws where the old code warned. That is a deliberate behaviour change: a
  signing secret left world-readable is not a warning, and the old `catch` is precisely why U19
  could exist unnoticed. The failure names the file and the platform.
- Someone who genuinely wants bash still cannot have it. If that becomes a real requirement, option
  B is the answer, not option A.
- macOS and Linux operators are not yet covered by a live end-to-end run; only the test suite and
  the parse check run there. Recorded as a known limit in the README rather than implied otherwise.
