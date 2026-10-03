# Roadmap

A packet is *one behaviour, testable in isolation, shippable in one commit*.

---

## Milestone M1 — The gate holds ✅

- [x] **P1**  Project scaffold, charter and docs ledger
- [x] **P2**  Key minting and verification with a signed, tamper-proof entitlement
      *Verified:* forged signature, tampered claims, `alg:none` and algorithm-confusion all rejected.
- [x] **P3**  Entitlement decision engine
      *Verified:* pure function, exhaustive denial reasons, fails closed on unknown input.
- [x] **P4**  Governance policy
      *Verified:* deployed and serving traffic.

## Milestone M2 — It runs on Azure ✅

- [x] **P5**  Bicep infrastructure
      *Verified:* APIM BasicV2 + App Insights + Log Analytics deployed to `rg-hackathon-gateway`.
- [x] **P6**  Interactive admin console
- [x] **P7**  Model deployment and selection
      *Verified:* `DeepSeek-V4-Flash-0731` and `DeepSeek-V4-Pro` deployed to `foundry-plus-resource`.

## Milestone M3 — A participant can actually build something ✅

- [x] **P8**  opencode verified end to end
      *Verified 2026-08-31:* a real session created `hello.py` via Write and Read tool calls
      through the gateway, on `flash`, with budget tracked across the session.
- [x] **P9**  Control verification against a live gateway
      *Verified:* 15/15 checks pass in `scripts/Test-Governance.ps1`.
- [x] **P10** Documentation

## Milestone M5 — Bring your own gateway, and bring Claude

Requested after M3: adopt an APIM instance an organisation already runs, choose from the models
that are actually deployed in the subscription, and serve Claude models to Claude Code.

- [x] **P15** Attach to an existing API Management instance
      *Verified 2026-10-03:* `src/apim.mjs` + `scripts/Apim.ps1` judge every instance in the
      subscription; `infra/main.bicep` adopts one via `existingApimName` and creates none.
      Named values and the logger are namespaced so nothing collides on a shared instance.
- [x] **P16** Choose from the models deployed across the subscription
      *Verified 2026-10-03:* `src/foundry.mjs` + `scripts/Models.ps1` list every Foundry account's
      deployments, classify each by wire format, and refuse a pin that crosses routes.
- [ ] **P17** Claude route — the Anthropic Messages API, governed
      *Acceptance:* `POST {gateway}/claude/v1/messages` with a participant key reaches a Claude
      deployment in Foundry. The same key controls apply — allowlist, time window, one-time
      budget, revocation, attribution — and every rejection is an Anthropic-shaped error body.
- [ ] **P18** Claude Code verified, and the participant setup documented
      *Acceptance:* `scripts/Test-Governance.ps1 -Route claude` proves each control fires against
      a live Claude route, and the README states the exact `ANTHROPIC_BASE_URL` /
      `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` values a participant sets.

## Milestone M4 — Hardening (only if this outlives one event)

- [ ] **P11** Move the budget counter to external Redis
      *Acceptance:* counter survives an APIM restart and is atomic under concurrency.
      *Why:* the cache read-modify-write is last-writer-wins, so `x-budget-used` under-counts when
      an agent issues parallel tool calls. The `token-quota` still holds the cap, so this is an
      accuracy issue rather than a spend issue. See UNKNOWNS U6.
- [ ] **P12** Streaming token reconciliation
      *Acceptance:* recorded consumption for a streamed response is within 5% of billed usage.
      *Why:* APIM estimates rather than counts when streaming.
- [ ] **P13** Content safety on the public path
      *Acceptance:* `llm-content-safety` blocks a known-harmful prompt with 403.
      *Why:* mandatory before exposing this to an untrusted public audience.
- [ ] **P14** Concurrency test in the verification harness
      *Acceptance:* N parallel requests against a small budget still stop at the cap.
      *Why:* `Test-Governance.ps1` is sequential today, so it cannot exercise P11's failure mode.

---

## Deferred (explicitly not now)

- Entra ID auth path — charter non-goal; participants are external and short-lived.
- Multi-region, autoscale, PTU — an event runs in one region on one unit.
- Chargeback invoicing — attribution here is for observation, not finance.
