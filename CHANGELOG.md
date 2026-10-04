# Changelog

All notable changes to foundry-hackathon-gateway, written for a **user**, not a compiler.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **An operator runbook and a statement of work.** `docs/RUNBOOK.md` walks the whole path with
  screenshots from live runs: deploy or adopt, pin, issue, verify, use, revoke, tear down.
  `docs/SOW.md` states scope, deliverables, acceptance criteria that are commands rather than
  opinions, and the measured risks. (P24)
- **Claude models, through the same key.** A second route speaks the Anthropic Messages API at
  `{gateway}/claude`, backed by Foundry's `/anthropic` endpoint. A participant points Claude Code
  at it with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` — the same key, the same allowlist,
  time window, one-time budget, revocation and attribution, and no Azure identity on their
  machine. (P17, ADR-0009)
- **Revocation is now part of the control harness.** It was never tested. `Test-Governance.ps1`
  mints a key, revokes it, polls until the gateway refuses it, and confirms other keys are
  unaffected — measured at 1 second. It reports NOT CHECKED rather than passing when run without
  `-ApimName` and `-ResourceGroup`. (P22, UNKNOWNS U16)
- **A worked example.** `examples/claude-agent.ipynb` builds a two-tool agent on a Claude model
  with the ordinary `anthropic` SDK. The committed copy holds the output of a real run against
  the live gateway — two parallel tool calls, a chained calculation, and the gateway's budget
  headers. `tests/example-notebook.test.mjs` keeps a key from ever being committed in its
  outputs. (P21)
- **The handout configures Claude Code.** Options 5 and 6 write a `.claude/settings.json` with
  the three variables, which is also what makes them apply to Claude Code's background agents,
  and a card that leads with the two mistakes producing a bare 401 or 403. (P18)
- **The control harness covers both routes.** `scripts/Test-Governance.ps1 -Route claude` checks
  the same controls plus three Claude-specific ones: every rejection is in the Anthropic error
  envelope, a spent budget names `budget_exhausted`, and `count_tokens` works. Option 11 runs it
  once per route that has models pinned. (P18)
- **Pick from the models deployed anywhere in the subscription.** Options 2 and 3 list every
  Foundry account's deployments grouped by account, show which route can serve each one, and
  refuse a pin that crosses routes — a Claude model on the OpenAI route would return an opaque
  404 from a backend that has never heard of it. (P16)
- **Deploy onto an API Management instance you already run.** `admin.ps1` option 1 lists the
  instances in the subscription with a verdict for each, says whether deploying would add or
  update the API, and refuses an instance that cannot serve the route. Leave the list to create a
  new instance as before. (P15, ADR-0008)
- Ironclad engineering discipline: charter, ledger, council and an executable gate. (P-0)

### Changed
- Pins carry the route that can serve them, and there is one alias map per route
  (`hackgw-model-map`, `hackgw-claude-model-map`). Existing pins are read as OpenAI-shaped. (P16)
- Named values and the Application Insights logger are prefixed `hackgw-`, so nothing this
  gateway writes can overwrite another API's configuration on a shared instance. Reads fall back
  to the old unprefixed names, so an existing deployment keeps working until it is next deployed.
  (P15)
- The unknowns register carries a status table. The gate reads table rows, so before this the
  `unknowns.open` check could not see this file's entries and passed without measuring anything.
  (P15)

### Fixed
- The admin menu shows the Claude route and the route of each pinned model. It showed neither.
  (P24)
- `Show-Models` marked a deployment as pinned when another Foundry account happened to hold a
  deployment of the same name. It now matches on account as well, since the gateway can only
  reach its own account. (P24)
- `render-shots.cjs` resolved Playwright from one hardcoded absolute path and failed anywhere
  else. It now searches, and falls back to the installed Edge rather than requiring a 130MB
  browser download to regenerate a screenshot. (P24)
- Claude-route aliases no longer collide with Claude Code's model slots. `sonnet`, `opus` and
  `haiku` are resolved client-side to Claude Code's own model ids, so a key granting them was
  refused with 403. Suggested aliases keep the version (`claude-sonnet-5` → `sonnet-5`) and
  pinning a reserved name is refused. Found by running Claude Code against the live gateway.
  (P19, UNKNOWNS U13)
- Option 9 reads both routes' alias maps. With one map per route it read only the OpenAI map, so
  a key granting a Claude alias was reported as "not pinned" — the confidently wrong answer that
  tool exists to prevent. (P16)
- ADR-0007 is written. `admin.ps1` and `scripts/Models.ps1` cited it, but the file did not exist.
  (P15)

### Known
- On the Claude route a streamed budget overshoots by about half again: measured, a 2,000-token
  budget stopped at 3,120 real tokens streamed against 2,080 non-streamed. The cap is enforced
  either way; `x-budget-used` is what breaks, reading 108 where 3,120 had been spent. Treat it as
  a floor on that route. (UNKNOWNS U15, roadmap P20)

### Removed
