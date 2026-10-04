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
- [x] **P17** Claude route — the Anthropic Messages API, governed
      *Verified 2026-10-03:* `infra/policy-claude.xml` + a conditional `claude-gateway` API in
      `infra/main.bicep`. Same key, same controls, Anthropic-shaped errors. Not published on a
      tier that meters zero Anthropic tokens.
- [x] **P18** Claude Code setup documented, and the harness extended to the Claude route
      *Verified 2026-10-03:* `scripts/Test-Governance.ps1 -Route claude` exists and is wired into
      option 11; option 5 writes `.claude/settings.json` and a card covering both routes.
      Run live in P19.

- [x] **P19** Verify the Claude route live
      *Verified 2026-10-04:* 21/21 on `-Route claude`, 15/15 on `-Route openai`, against
      `apim-hackgwfl4s7jvpxekno` backed by `ai-contosohub530569751908`. A Claude Code 2.1.272
      session configured only by the generated `.claude/settings.json` completed a turn with
      tool calls. Closed UNKNOWNS U9; opened U15.

- [x] **P21** A worked example: a Claude agent with tool calls
      *Verified 2026-10-04:* `examples/claude-agent.ipynb`, executed against the live gateway.
      Two parallel `get_order_status` calls, a chained `calculate` call, a correct final answer,
      and the gateway's budget headers. `tests/example-notebook.test.mjs` keeps a key out of the
      committed outputs and pins the two mistakes the example exists to prevent.

- [x] **P22** Prove the three guarantees a key makes
      *Verified 2026-10-04:* budget, time window and revocation each measured against the live
      gateway. Revocation is now part of `Test-Governance.ps1` (24/24 on the Claude route) and
      reports NOT CHECKED rather than passing when it cannot run. UNKNOWNS U15 corrected, U16
      added.

- [x] **P24** Operator runbook and statement of work
      *Verified 2026-10-04:* `docs/RUNBOOK.md` and `docs/SOW.md`, with five new screenshots
      rendered from live captures. Found and fixed three display defects while capturing them:
      the menu showed neither the Claude route nor per-model routes, `Show-Models` marked a
      same-named deployment in another account as pinned, and `render-shots.cjs` only ran on one
      machine.

- [x] **P25** Deploy onto whatever is already there
      *Verified 2026-10-04:* option 1 reads the target first and prints a plan — instance,
      Foundry account, each pinned model, both routes, named values, role grant — then refuses
      to deploy over anything BLOCKED. Rendered against `apim-claude-gw-fzgql9`, the instance a
      previous attempt had failed on: it correctly reported the OpenAI route as UPDATE and the 7
      named values that attempt left behind, routed the Claude route around the `/claude` path
      another product owns, skipped the role grant that already existed, and blocked a model
      that is not deployed. Pins no longer default to DeepSeek. 23 new tests in
      `tests/deployment-plan.test.mjs`. Council blocked the first cut: the PowerShell had its own
      copy of the rules and the two disagreed on a classic-tier instance whose path was taken.
      The copy is gone — `Show-DeploymentPlan` now calls `scripts/plan.mjs`.

- [x] **P26** macOS and Linux run the same console
      *Acceptance:* the suite and a parse of every `.ps1` pass on `ubuntu-latest`,
      `macos-latest` and `windows-latest`; the signing secret is owner-only on each, measured by
      creating a file and reading its mode back.
      *Verified 2026-10-04:* an audit of all six `.ps1` files found exactly two Windows-only
      blocks, both the same ACL call, and nothing else — so the answer was to make the one
      implementation portable, not to write a bash twin that would have to agree with it about
      minting and revocation forever ([ADR-0010](adr/0010-cross-platform-not-a-bash-twin.md)).
      Found a real defect doing it: the ACL call sat in a `catch` that warned, so off Windows the
      signing secret kept the default umask (UNKNOWNS U19).

## Milestone M6 — Only if this outlives one event

- [ ] **P20** Report the budget from the number that enforces it
      *Acceptance:* `x-budget-used` on the Claude route tracks real consumption on a streamed
      response within the tolerance stated in UNKNOWNS U5.
      *Why:* measured 2026-10-04, a streamed 2,000-token budget stopped at 3,120 real tokens
      (+56%) while the header read 108. The cap is enforced by APIM's own quota; the header is
      fed by the cache counter, and the two disagree. Sourcing the header from
      `remaining-quota-tokens-variable-name` would make the number shown and the number enforced
      the same number. See UNKNOWNS U15.

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
