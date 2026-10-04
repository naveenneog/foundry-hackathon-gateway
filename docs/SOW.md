# Statement of Work — governed model access for a hackathon

**Project:** Foundry Hackathon Gateway
**Repository:** github.com/naveenneog/foundry-hackathon-gateway
**Version:** 1.0 · 2026-10-04
**Status:** build delivered and verified live; this document covers self-service delivery of an event

---

## 1. Background

An event needs to give external participants access to frontier models for a fixed period,
without issuing anyone a model credential and without any participant being able to spend without
limit. Handing out raw Foundry keys fails all three: the key does not expire, has no spend
ceiling, and reaches every model in the account.

This gateway puts Azure API Management in front of Microsoft Foundry and replaces the model
credential with a signed, self-expiring entitlement.

---

## 2. Objectives

| # | Objective | How it is judged |
|---|---|---|
| O1 | No model credential leaves Azure | The gateway's managed identity is the only principal with data-plane access to Foundry |
| O2 | Access expires without anyone doing anything | A key stops working at its expiry with no job, script or human action |
| O3 | Spend is capped per participant | A key stops serving requests once its token budget is spent |
| O4 | Access can be withdrawn immediately | A named key stops working within seconds, without affecting others |
| O5 | Participants can do real agent work | Tool-calling agent sessions complete through the gateway |
| O6 | An organiser can run it unaided | One interactive script; no portal clicking required for the normal path |

---

## 3. Scope

### In scope

- Azure API Management gateway fronting one Microsoft Foundry account, deployed by one command
  onto a new instance or onto one the organisation already runs.
- Two routes: OpenAI Chat Completions (`/v1`) and Anthropic Messages (`/claude`).
- Participant keys: signed JWT carrying model allowlist, activation time, expiry, one-time token
  budget and a revocation id. Issued singly or in bulk, offline.
- Model selection from any Foundry account in the subscription, with the route that serves each.
- Per-participant usage attribution to Application Insights.
- Control verification harness that proves each control fires against the live gateway.
- Participant handouts: configuration files and a one-page card per participant.
- Operator runbook ([RUNBOOK.md](RUNBOOK.md)) and participant guide ([SETUP.md](SETUP.md)).

### Out of scope

| Excluded | Reason |
|---|---|
| Entra ID / OAuth per participant | Participants are external and short-lived; key-based access is the deliberate choice ([ADR-0002](adr/0002-credential-transport.md)) |
| Chargeback or invoicing | Attribution here is for observation. See risk R3 |
| Deploying Claude models | Requires organisation metadata and Marketplace terms the CLI cannot supply ([UNKNOWNS](UNKNOWNS.md) U14). Deploy in the Foundry portal, then pin |
| Multi-region, autoscale, PTU | One region, one unit, for a time-boxed event |
| Content safety filtering | Not enabled. Required before exposing this to an untrusted public audience — roadmap P13 |
| Fine-tuning, RAG, agent hosting | Anything past inference |

---

## 4. Deliverables

| # | Deliverable | Where | Status |
|---|---|---|---|
| D1 | Gateway infrastructure as code | `infra/main.bicep` | Delivered |
| D2 | Governance policy, both routes | `infra/policy.xml`, `infra/policy-claude.xml` | Delivered |
| D3 | Key minting and entitlement logic | `src/keys.mjs`, `src/entitlement.mjs` | Delivered |
| D4 | Operator console | `admin.ps1` + `scripts/` | Delivered |
| D5 | Control verification harness | `scripts/Test-Governance.ps1` | Delivered |
| D6 | Participant handouts | generated per key into `handouts/` | Delivered |
| D7 | Worked example | `examples/claude-agent.ipynb` | Delivered, with a recorded live run |
| D8 | Operator runbook | [RUNBOOK.md](RUNBOOK.md) | Delivered |
| D9 | Participant guide | [SETUP.md](SETUP.md) | Delivered |
| D10 | Decision record and open-questions register | `docs/adr/`, [UNKNOWNS.md](UNKNOWNS.md) | Delivered, 9 ADRs |
| D11 | Automated test suite and repository gate | `tests/`, `.ironclad/gate.mjs` | Delivered, 328 tests |

---

## 5. Acceptance criteria

Each is a command, not an opinion. All were run against a live deployment on 2026-10-04.

| # | Criterion | Proof | Result |
|---|---|---|---|
| A1 | The test suite passes | `npm test` | 328 passed |
| A2 | The repository gate passes | `node .ironclad/gate.mjs --stage packet` | PASS |
| A3 | Every control fires on the OpenAI route | `admin.ps1` → 11 | 18 passed, 0 failed |
| A4 | Every control fires on the Claude route | `admin.ps1` → 11 | 24 passed, 0 failed |
| A5 | A key reaches a Claude model | Claude Code session, tool calls, file written | Completed, exit 0 |
| A6 | A key reaches a DeepSeek model | opencode session, tool calls | Completed |
| A7 | An expired key is refused | Harness, both routes | 401 |
| A8 | A spent budget is refused | Harness, both routes | 403 `budget_exhausted` |
| A9 | A revoked key is refused, others unaffected | Harness, both routes | 403 in under 10s; other keys 200 |
| A10 | No participant credential reaches Foundry | Policy replaces `Authorization`; `api-key` and `x-api-key` deleted | Asserted by test |

**Sign-off condition:** A1–A10 green against the organisation's own deployment, not this one.
Re-running A3 and A4 on your gateway reproduces A7–A9 as a side effect.

---

## 6. Assumptions

| # | Assumption | If it is wrong |
|---|---|---|
| S1 | An Azure subscription exists with rights to create API Management and assign roles on the Foundry account | Deployment fails at the role assignment |
| S2 | The Foundry account already holds the models to be used | The gateway deploys and returns 404 on every call. Option 1 checks this before deploying |
| S3 | An adopted API Management instance is a v2 SKU, if the Claude route is wanted | The Claude route is not published. Both the console and the template refuse it ([UNKNOWNS](UNKNOWNS.md) U12) |
| S4 | The event is time-boxed | The budget counter and the quota are sized for one event, not a year of operation |
| S5 | Participants hold no Azure identity | Confirmed by design — this is why keys, not Entra, are used |

---

## 7. Dependencies — what the organiser provides

| # | Item | When |
|---|---|---|
| C1 | Azure subscription and sign-in | Before Step 1 |
| C2 | A Foundry (`AIServices`) account with models deployed | Before Step 2 |
| C3 | Azure Marketplace terms accepted, if Claude models are used | Before pinning a Claude model |
| C4 | A machine with PowerShell 7+, Azure CLI and Node 20+ | Before Step 1 |
| C5 | Participant list, budget per participant, and the access window | Before Step 4 |

---

## 8. Roles

| Role | Responsibility |
|---|---|
| Organiser | Runs `admin.ps1`. Holds `.gateway/secret.txt`. Issues, revokes and tears down |
| Participant | Receives a key and a card. Holds no Azure credential |
| Subscription owner | Grants the organiser rights under C1, and owns the spend |

One organiser mints keys. If a second machine is involved, `.gateway/secret.txt` must be copied
to it out of band — a second machine that deploys without it generates a new signing secret and
invalidates every key already issued. The console's preflight detects this and refuses to
continue.

---

## 9. Schedule

| Phase | Work | Duration |
|---|---|---|
| P1 | Prerequisites (C1–C4) | Varies; usually access requests |
| P2 | Deploy onto an existing API Management instance | Minutes |
| P2' | Or create a new instance | 30–45 minutes, mostly waiting on API Management |
| P3 | Pin models | Minutes |
| P4 | Issue keys | Under a second per key; bulk issuance is offline |
| P5 | Verify the controls | ~5 minutes per route |
| P6 | Event | As planned |
| P7 | Tear down | Minutes, plus the name purge |

---

## 10. Cost

The gateway bills whether or not anyone uses it.

| Driver | Note |
|---|---|
| API Management Basic v2, 1 unit | ~$250/month. **Zero if an existing instance is adopted** |
| Log Analytics and Application Insights | Ingestion-based, small at this volume |
| DeepSeek and OpenAI-shaped models | Pay-per-token, unchanged by the gateway |
| Claude models | Claude Consumption Units, billed through Azure Marketplace |

Participant spend is bounded by the per-key budget, subject to R3 below. Teardown is Step 8 of
the runbook and is the only reliable way to stop the fixed cost.

---

## 11. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | An adopted API Management instance is a classic tier, so Anthropic token metering silently reports zero | Medium | High — a budget that cannot fire | Refused by the console *and* the template. Not a warning ([UNKNOWNS](UNKNOWNS.md) U12) |
| R2 | A participant exceeds their stated budget | High on the Claude route | Medium | Measured: +4% non-streamed, **+56% streamed**. Bounded by the `max_tokens` clamp and the request-rate limit. Size budgets accordingly ([UNKNOWNS](UNKNOWNS.md) U15) |
| R3 | `x-budget-used` under-reports on the Claude route | Certain when streaming | Medium | Documented as a floor, not a figure. Do not use it for chargeback. Roadmap P20 |
| R4 | A Claude Code release advertises a capability Foundry rejects | Medium | Medium — a 400 naming the value | Scratch `CLAUDE_CONFIG_DIR` in the runbook. Roadmap P23 ([UNKNOWNS](UNKNOWNS.md) U17) |
| R5 | The signing secret is lost or diverges between machines | Low | High — every issued key dies | Preflight compares the local secret with the deployed one on every start |
| R6 | A key leaks during the event | Medium | Medium | Revocation in under ten seconds, exact-match. Budgets and expiry bound the damage |
| R7 | The gateway points at a Foundry account without the models | Low | High — 404 on every call | Option 1 verifies the deployments exist before deploying |
| R8 | The gateway is left running after the event | Medium | Medium — ongoing cost | Teardown is Step 8; `purge` releases the name |

---

## 12. Change control

Changes to this gateway follow the process in [AGENTS.md](../AGENTS.md): one packet at a time
from [ROADMAP.md](ROADMAP.md), test first, five-seat review, and
`node .ironclad/gate.mjs --stage packet` exiting zero as the definition of done. Decisions that
are hard to reverse are recorded as ADRs in `docs/adr/`.

Anything learned by running it goes in [UNKNOWNS.md](UNKNOWNS.md) with the measurement that
established it. Four entries in that register came from live runs contradicting documentation or
a reasonable assumption, which is the reason the register exists.

---

## 13. Sign-off

| | Name | Date |
|---|---|---|
| Organiser | | |
| Subscription owner | | |

Sign-off is against §5 run on the organisation's own deployment.
