# ADR-0012 — Bulk issuance writes the batch's keys to one CSV

**Status:** Accepted
**Date:** 2026-10-06
**Packet:** P34
**Reverses:** "the token exists in exactly one place: the participant's handout" (`scripts/Keys.ps1`)

## Context

Bulk issuance (option 6) wrote one handout folder per participant and an `index.csv` that
"deliberately contains no tokens", so no single file held every credential in a batch. Handing
the keys out meant opening one folder per participant.

The organiser asked for the batch's keys in a CSV, so that handing them out is a mail merge or a
print run.

Two related facts at the time of the request:

- The handout files holding a key (`README.md`, `.claude/settings.json`) were written with
  default permissions: owner-only on Windows only by inheritance, readable by group and other
  under a typical umask on macOS and Linux.
- Participant names come from a file the organiser supplies, and a CSV opened in a spreadsheet
  evaluates a cell starting with `=`, `+`, `-` or `@` as a formula (OWASP, CSV injection).

## Options

**A — Keep keys only in the per-participant folders.** No change; handing out stays manual.

**B — Put the keys in `index.csv`.** `index.csv` is the file meant for co-organisers who track
distribution; adding credentials to it changes who can safely hold it.

**C — A separate `keys.csv`, owner-only, next to an unchanged `index.csv`.**

## Decision

**Option C.** `keys.csv` has one row per participant: `participant`, `key`, `key_id`, `models`,
`openai_base_url`, `anthropic_base_url`, `anthropic_model`, `budget_tokens`, `valid_from_utc`,
`valid_until_utc`.

- It is created empty, restricted to its owner, then written (`Write-ProtectedFile`), so it never
  exists with default permissions.
- The handout files holding a key are written the same way.
- In both CSVs, a value starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading
  apostrophe. The display changes; the key's `sub` claim does not.
- `index.csv` keeps no keys.

## Consequences

- One file now holds every key of a batch. It is readable only by the operator who issued the
  batch, and lives under `handouts/`, which is gitignored.
- The key is still never written to `issued-keys.json`; the state file alone cannot call the
  gateway.
- On macOS and Linux, handouts written by earlier versions keep the permissions they were written
  with.
- `tests/key-issuance.test.mjs` verifies each row's key against the signing secret, checks the
  files are owner-only on each platform, and checks the formula guard.
