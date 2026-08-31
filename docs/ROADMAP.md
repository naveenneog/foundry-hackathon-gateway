# Roadmap

A packet is *one behaviour, testable in isolation, shippable in one commit*.

---

## Milestone M1 — The gate holds

The governance controls exist and are proven to fire. Nothing here needs Azure.

- [x] **P1**  Project scaffold, charter and docs ledger
      *Acceptance:* `gate --stage packet` runs and reports honestly.
- [x] **P2**  Key minting and verification with a signed, tamper-proof entitlement
      *Acceptance:* round trip works; forged signature, tampered claims, `alg:none` and
      algorithm-confusion attacks are all rejected. 25 tests.
- [x] **P3**  Entitlement decision engine
      *Acceptance:* pure function returning `allow` or a specific reason
      (`not_yet_active`, `expired`, `revoked`, `model_not_permitted`, `budget_exhausted`).
      Fails closed on unknown or malformed input, including a cache miss. 24 tests.
- [x] **P4**  Governance policy
      *Acceptance:* `infra/policy.xml` transcribes the decision engine, adds the managed-identity
      swap, alias mapping, `max_tokens` clamp and metric emission.

## Milestone M2 — It runs on Azure

- [x] **P5**  Bicep infrastructure
      *Acceptance:* APIM v2 with system-assigned identity, App Insights with
      `CustomMetricsOptedInType: WithDimensions`, diagnostics with `metrics: true`, named values,
      and `Cognitive Services User` granted to the gateway identity only.
- [x] **P6**  Interactive admin console
      *Acceptance:* deploy, pin models, issue key, list, revoke, usage, verify, teardown — all
      from one menu; destructive actions require typed confirmation.
- [x] **P7**  Model deployment and selection
      *Acceptance:* discovers existing Foundry deployments, shows which are pinned, can deploy
      DeepSeek Flash or Pro.

## Milestone M3 — A participant can actually build something

- [ ] **P8**  opencode verified end to end
      *Acceptance:* a real session that reads a file, writes a file and completes a task using
      `flash`; and a tool-calling request against `pro` rejected with a clear 400.
      **Blocked:** needs a live Azure subscription with DeepSeek deployments.
- [ ] **P9**  Control verification against a live gateway
      *Acceptance:* all ten checks in `scripts/Test-Governance.ps1` pass, output recorded.
      **Blocked:** same.
- [x] **P10** Documentation
      *Acceptance:* README, participant card generator, ADRs, unknowns register.

## Milestone M4 — Hardening (only if this outlives one event)

- [ ] **P11** Move the budget counter to external Redis
      *Acceptance:* counter survives an APIM restart. Closes UNKNOWNS U6.
- [ ] **P12** Streaming token reconciliation
      *Acceptance:* consumption recorded for a streamed response is within 5% of billed usage.
      Closes U5.
- [ ] **P13** Content safety on the public path
      *Acceptance:* `llm-content-safety` blocks a known-harmful prompt with 403.

---

## Deferred (explicitly not now)

- Entra ID auth path — charter non-goal; participants are external and short-lived.
- Multi-region, autoscale, PTU — an event runs in one region on one unit.
- Chargeback invoicing — attribution here is for observation, not finance.
