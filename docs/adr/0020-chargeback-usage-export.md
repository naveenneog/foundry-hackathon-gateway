# ADR-0020: A chargeback report exports measured usage per key and model, without prices

- **Status:** Accepted. Amends the charter non-goal "Multi-tenant billing or chargeback
  invoicing. Attribution is for observation, not finance." and the ROADMAP's deferred
  "Chargeback invoicing" entry.
- **Date:** 2026-10-24
- **Packet:** P59
- **Deciders:** owner's request of 2026-10-24

## Context

The owner, on 2026-10-24:

> "export of chargeback report, with all labels"

The charter lists chargeback invoicing as a non-goal, and the roadmap defers it, because
attribution was for observation. The two sources conflict with the request, so this record
reconciles them.

Facts:
- Usage comes from the gateway's token metrics in the workspace's `AppMetrics` table, per key id
  (a short-lived key's `jti` or a product key's subscription id), model and time (ADR-0015). The
  table keeps 90 days at no charge (P57).
- For streamed responses API Management estimates prompt and completion tokens (U5).
- Foundry prices differ by model, region and deployment type, and Claude models on Foundry are
  billed in CCU. The dashboard has no price it could state as fact.
- Key Vault tags hold each key's attribution: issued to, label, subject, Foundry, models, budget
  and lifecycle state.

## Options considered

1. **Keep the non-goal.** Administrators would copy numbers from charts by hand.
2. **A usage export with attribution, no prices.** One row per key and model with token counts,
   requests, first and last use, and the key's tags and status. Allocation, rates and invoices
   stay with the organisation's finance tools.
3. **Invoicing, with a rate card and amounts.** Needs maintained prices per model, region and
   billing unit, and still differs from the Azure invoice for streamed traffic.

## Decision

Option 2.

1. An admin-only, audit-logged export, `POST /api/chargeback`, returns a CSV for a preset period
   or a custom range of whole UTC days (90 days at most), for both key kinds or one.
2. One row per key and model with usage in the period. A key with no usage has no row. Usage
   whose key is no longer in Key Vault is reported with status `unknown` and its key id, so the
   totals match the usage views.
3. The file has a header row and no totals row, so a sum or a pivot table over it counts each
   token once. The response tells the UI the row count and totals.
4. Cells are formula-escaped and quoted as in `keys.csv` (OWASP CSV injection, RFC 4180). The
   report carries no key value, token or secret: it is built from Key Vault tags and usage rows
   only.
5. No currency column. Optional per-model rates are a "Later" roadmap entry.
6. Invoicing, prices and billing integration remain non-goals.

## Consequences

+ Finance gets the numbers without direct access to the workspace or Key Vault: the dashboard
  builds the file.
+ Tokens are the numbers the gateway's usage views show, so the report and the charts agree.
− Token counts for streamed responses are estimates (U5); the report allocates usage and does not
  reconcile with the Azure invoice.
− History is limited to the 90 days `AppMetrics` keeps; a longer report needs longer retention
  or a roll-up, which have a cost (P57).

## How we'd know this was wrong

- Finance needs amounts in the file, not only tokens: the per-model rates entry becomes a packet.
- The report is used for billing external customers: invoicing would need its own design, with
  prices, reconciliation and dispute handling.
