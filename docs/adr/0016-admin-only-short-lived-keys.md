# ADR-0016: Admin-only dashboard, short-lived keys with an activation delay, CSV distribution

- **Status:** Accepted. Supersedes the `Console.User` role of ADR-0013 and the per-user
  visibility in ADR-0015; every other decision in both stands.
- **Date:** 2026-10-23
- **Packets:** P49–P54 (amendment)
- **Deciders:** owner's decision of 2026-10-23

## Context

The owner, on 2026-10-23:

> "if you look at the script which issues keys it has a feature when key will get activated how
> many hours from now, that is missing from hackathon keys instead of calling hack keys call them
> as short lived keys, and User dont want to give access of this dashboard to any othwr person to
> reveal the keys our old design of just copying keys from here or bulk sending via csv still
> holds true not this design."

`scripts/Keys.ps1` `Read-KeySettings` asks "Start in how many hours from now (0 = immediately)"
and mints `nbf = now + start` and `exp = nbf + window`. `New-BulkKeys` writes `keys.csv`, with
one row per participant and their key, and `index.csv`, with no keys (ADR-0012).

## Decisions

1. **Admin-only.** Only `Console.Admin` opens the dashboard; every API refuses anyone else with
   403, in the router and again in the service. `Deploy-Console.ps1` assigns the operator and any
   `-Admins`, and assigns `Console.User` to nobody. The app role definition stays in existing
   registrations and grants nothing.
2. **Owner is attribution.** "Issued to" names who a key is for. Usage is reported per owner. The
   owner gets no access.
3. **Short-lived keys** is the name for the HS256 keys formerly called hackathon keys. The API
   kind stays `jwt`.
4. **Activation delay.** `startInHours` (0–2160) sets `nbf = now + start` and
   `exp = nbf + hours`, as the script does. A key whose `nbf` is in the future has the status
   `scheduled` and is listed as active.
5. **Distribution by copy or CSV.** A single key is revealed once and copied. Bulk issuance
   returns each key and a server-built `keysCsv` with the same columns as `admin.ps1`'s
   `keys.csv`, formula-escaped (OWASP CSV injection). It also returns a key-free `indexCsv`. The
   encrypted export bundle remains available.

## Consequences

- Key values travel in the bulk response to an admin's browser. The response is `no-store` and
  the UI drops it when the result closes. The CSV holds every key in the batch, as `keys.csv`
  always has.
- No participant can see their own usage. Admins see all of it.

## How we'd know this was wrong

- A request for participants to fetch their own key reopens the `Console.User` role, with
  ADR-0013's ownership checks, which are still in git history.
