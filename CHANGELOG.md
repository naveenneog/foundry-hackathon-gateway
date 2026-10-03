# Changelog

All notable changes to foundry-hackathon-gateway, written for a **user**, not a compiler.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **Claude models, through the same key.** A second route speaks the Anthropic Messages API at
  `{gateway}/claude`, backed by Foundry's `/anthropic` endpoint. A participant points Claude Code
  at it with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` — the same key, the same allowlist,
  time window, one-time budget, revocation and attribution, and no Azure identity on their
  machine. (P17, ADR-0009)
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
- Option 9 reads both routes' alias maps. With one map per route it read only the OpenAI map, so
  a key granting a Claude alias was reported as "not pinned" — the confidently wrong answer that
  tool exists to prevent. (P16)
- ADR-0007 is written. `admin.ps1` and `scripts/Models.ps1` cited it, but the file did not exist.
  (P15)

### Removed
