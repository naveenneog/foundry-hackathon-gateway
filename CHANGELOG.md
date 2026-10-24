# Changelog

All notable changes to foundry-hackathon-gateway, written for a **user**, not a compiler.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **Custom usage range, chargeback report and an admin-set gateway URL (P59).**
  - Usage on the Overview, both key pages and the key drawer can cover a custom range of whole
    UTC days, from 89 days before today to today, beside the presets. Two days or fewer are
    charted by the hour. The usage APIs take `days`, or `from` and `to`.
  - **Chargeback report** on the Overview downloads `chargeback-<from>-<to>.csv`: one row per key
    and model with tokens, requests, first and last use, the key's issued-to, labels and other
    tags, status and Foundry. Usage of a key no longer in Key Vault is listed as `unknown`.
    Cells are formula-escaped; there are no prices (ADR-0020).
  - **Settings** (formerly the Signing page; `#/signing` still opens it) has **Gateway URL
    (custom domain)**. A host name that ARM lists as a gateway custom domain of this API
    Management replaces the API Management URL in new handouts, Reveal, `keys.csv`, export
    bundles and Foundry base URLs, without a restart; keys handed out before keep working.
    Stored in Key Vault and audit-logged (ADR-0019).
  - The setup guide has steps for all three; the local demo offers a custom domain to try.
- **90-day usage view (P57).** Usage charts and tables offer 24 h, 7 d, 30 d and 90 d. The
  gateway's `AppMetrics` data is kept 90 days at no charge; older usage is not retained.
- **Multiple Foundry backends (P56).** The deployed-model list discovers accounts and deployments
  across the configured subscription, with visible permission errors and explicit refresh.
  Administrators can attach another Foundry, pin its models and select it during single or bulk
  key issuance. Isolated API routes, JWT audiences and product scopes prevent cross-account use;
  existing routes and keys are unchanged. Highlighted help guides discovery, setup, pinning and
  issue. Discovery is metadata-only; an operator grants per-account inference access and can
  optionally configure a private endpoint without relaxing a firewall. ADR-0017.
- **Release branch `release/key-dashboard`: install guide, architecture and a local demo.**
  The README now opens with the Key Dashboard: an architecture illustration with a note on how
  recipients authenticate, a one-minute local try (`npm run dashboard:demo`, sample data, no
  Azure, `127.0.0.1` only), the four install commands and annotated screenshots.
  `docs/INSTALL.md` is the full install and setup guide: requirements, each step and what it
  creates, the first sign-in, a first key in Claude Code, troubleshooting and removal. Tests check
  that every link and image in both files resolves. (P55)
- **Key Dashboard amendment, branch `feature/key-dashboard`: admin-only access, scheduled
  short-lived keys and CSV distribution.** A participant's sign-in email is attribution only;
  it does not grant dashboard access. Short-lived keys now have `startInHours`, matching
  `scripts/Keys.ps1`; a future `nbf` is shown as Scheduled. Bulk issue returns the same
  formula-escaped `keys.csv` and key-free `index.csv` as the terminal workflow. The UI drops
  these from memory when the result closes or the view/page changes. Hosting can be deployed
  with no IP rule (Entra sign-in and admin role remain required); `-AllowedIp` is optional.
  Live deployment and checks recorded in `docs/STATUS.md`; operator guide in `docs/CONSOLE.md`.
  ADR-0016 supersedes the earlier `Console.User` dashboard access.
- **Branch `feature/admin-console` only: Key Console, a web app for issuing and managing
  keys.** It runs on Azure Container Apps inside the proof of concept's network, behind Entra
  sign-in, with two roles:
  - `Console.Admin` issues and revokes signed keys, minted from a signing secret now held in
    Key Vault.
  - `Console.Admin` also issues, rotates (two-slot), suspends and resumes product keys, and
    switches rotation automation per key; a background sweep applies it.
  - `Console.User` sees and reveals only their own keys.
  - Only admins export: an export is an AES-256-GCM bundle, signed by a Key Vault key, which
    the recipient verifies and opens with `scripts/open-bundle.mjs`.

  Deploy with `scripts/Deploy-Console.ps1`. The guide with screenshots is `docs/CONSOLE.md`.
  Verified live end to end, including Claude calls with console-issued keys. (P46)
- **Proof of concept, branch only: Azure portal screenshots in the UI guide.**
  `poc/products-keyvault/PORTAL.md` now shows 20 redacted screenshots of the deployed POC and of
  unsubmitted creation forms: APIM routes, product packs and their policy, subscriptions and
  their menu, and the private Key Vault's creation, firewall, private endpoint and RBAC model. A
  Screenshots section states how they were taken. (P45)
- **Proof of concept, branch only: editable draw.io architecture.**
  `poc/products-keyvault/ARCHITECTURE.drawio` has request/network and key-lifecycle pages,
  distinguishing APIM inference from private Key Vault access and management operations.
  Rotation, scheduled expiry enforcement and measured limits are explicit. PNG exports of both
  pages are embedded in the POC README. (P44)
- **Proof of concept, branch `poc/apim-products-keyvault` only: Azure portal steps and an
  architecture document.** `poc/products-keyvault/PORTAL.md` builds in the Azure portal what the
  template builds and runs each key operation by hand, citing Microsoft Learn for every step;
  where Learn names no portal label, or the portal cannot reach a private vault, it names the
  script action. `poc/products-keyvault/ARCHITECTURE.md` describes the components, identities and
  roles, network paths, the request flow, each key flow and the design decisions. Tests compare
  both documents with the templates. (P43)
- **Proof of concept, branch `poc/apim-products-keyvault` only: a setup and usage guide.**
  `poc/products-keyvault/SETUP.md` covers requirements, deployment, issuing, handing over,
  rotating, expiring, suspending and listing keys, monitoring, and connecting Claude Code, the
  Anthropic and OpenAI SDKs, opencode and curl, with an error table. Each client example is a
  file in `poc/products-keyvault/examples/`, run against the gateway by `Test-PocClients.ps1`
  with the probe and a wrong-key control (11 of 11 on 2026-10-12); tests check that the guide's
  copies match the files. New key actions: `List`, `Suspend` and `Resume`, which need no vault;
  `Grant`, which gives one identity read access to one key's secret without a path to the vault,
  and `Revoke`, which takes it away; and `-Step Key` on the runner, whose steps now fail when
  the script fails on the VM. `Remove-Poc.ps1` also deletes the read access `Grant` gave, and
  has offline tests. Claude Code examples set
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: with `ANTHROPIC_API_KEY`, Claude Code 2.1.272
  otherwise got a 400 for a pre-release `anthropic-beta` value (UNKNOWNS U17). (P38)
- **Proof of concept, branch `poc/apim-products-keyvault` only: long-lived keys on API
  Management products, with the keys in Key Vault.** One product per model pack, one
  subscription key per user, a monthly token budget per key and per product, two-key rotation
  through Key Vault, and a job that suspends expired keys. Measured on Standard v2: 22 of 22
  checks, including a Claude Code session that kept working across two key rotations with
  `apiKeyHelper` reading Key Vault. Budgets are reconciled across gateway nodes after the fact,
  so a small budget was overshot by about one budget per node. See
  `poc/products-keyvault/README.md`. (P37)
- **Participants' base URLs use the gateway's custom domain when it has one.** Key issuance asks
  once for the hostname, defaulting to the instance's custom gateway domain, then to a hostname
  typed before (for a front door the instance cannot report), then to `*.azure-api.net`. Each
  route keeps its path. Wildcard hostnames are not offered, and an instance that cannot be read
  is reported rather than skipped. (P32)
- **Expired keys move to an archive.** Option 7 lists keys that can still be used; keys more than
  ten minutes past their expiry move to `.gateway/issued-keys-archive.json`. Archived ids still
  count when a new key reuses one, because the budget counters are keyed on the id. When the
  archive file cannot be read, nothing is moved and option 7 says so. (P33)
- **Bulk issuance writes `keys.csv`.** One row per participant with the key, base URLs, model,
  budget and validity, readable only by the operator; names a spreadsheet would run as formulas
  are neutralised. The handout files holding a key are now owner-only as well. See
  [ADR-0012](docs/adr/0012-bulk-keys-in-one-csv.md). (P34)
- **Foundry behind a private endpoint, verified.** The README lists what an API Management
  instance needs to reach a Foundry account whose public access is disabled: Standard v2 or
  Premium v2, outbound VNet integration on a delegated subnet, and the three private DNS zones.
  Tested end to end: option 11 passed 17/17 and 23/23 through the private endpoint, and the same
  instance without VNet integration — as a Basic v2 gateway is — was refused on both routes.
  [docs/PRIVATE-ENDPOINT.md](docs/PRIVATE-ENDPOINT.md) gives the portal and CLI steps, and
  `infra/examples/private-foundry-test.bicep` is the template the test ran. (P31)
- **macOS and Linux run the same console.** PowerShell 7 is cross-platform and was already
  required, so `admin.ps1` runs on all three platforms rather than acquiring a bash twin that
  would have to agree with it about minting and revocation forever
  ([ADR-0010](docs/adr/0010-cross-platform-not-a-bash-twin.md)). `admin.sh` is a 40-line launcher
  that checks `pwsh`, `az` and `node` and hands over. CI runs the suite, and parses every `.ps1`,
  on `ubuntu-latest`, `macos-latest` and `windows-latest`. (P26)
- **A deployment plan, shown before anything is deployed.** Option 1 reads the target and prints
  what exists and what it would do — instance, Foundry account, every pinned model, both routes,
  named values and the role grant — then stops on anything that would fail. An ARM deployment is
  all-or-nothing, so one impossible resource used to take the whole thing down and leave behind
  whatever it had already created. (P25)
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
- **The Signing page is part of Settings (P59).** The navigation says **Settings**; the signing
  secret is its second card, after **Gateway URL**. `#/signing` still opens it. The charter's
  chargeback non-goal now covers invoicing and prices only; a usage export is in scope
  (ADR-0020).
- **Foundry & models lists only the Foundries connected to this API Management (P58).** The
  account list, lede and count cover the default connection and each attached account, the only
  accounts short-lived and product keys can use. The subscription's other accounts, unreadable
  ones with their error, appear only in a separate **Connect another Foundry** dialog with search,
  Attach, the operator setup and network commands, and help. After an attach, the account is
  selected in the connected list. With nothing connected, the page shows an empty state with that
  action. The issue forms no longer count unattached accounts, and the guide's Attach step
  highlights the new action. The local demo serves two connected Foundries and four to connect.
  Server APIs are unchanged. ADR-0018.
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
- **Usage of a key no longer in Key Vault had no name in the Overview's Top keys (P59).** It now
  reads "Unknown key `<key id>`", as in the chargeback report.
- **Charts widened the page on a narrow screen (P59).** Each chart's data table for assistive
  technology carried the visually-hidden class itself, and a table ignores `width: 1px`: at 390 px
  an hourly chart added 123 px of horizontal scrolling. The table now sits in a hidden block.
- **Deploying with only Claude models pinned failed** with *"NamedValue Value should be between
  1 and 4096 characters long"*. The OpenAI route's model map was written as an empty string,
  which APIM rejects. The Claude map already wrote `;` (EMPTY_MAP) for that case, but the OpenAI
  map had never needed to while every install defaulted to DeepSeek pins. A deployment is
  all-or-nothing, so the one rejected named value also kept the new route's policy from being
  applied. Both maps now go through `Get-ModelMapValue`, `infra/main.bicep` applies the same
  guard for anyone deploying it directly, and its `modelMap` default is `;` rather than two
  DeepSeek deployments. (P29)
- **The deployment plan said a Claude route with no pins "is not published"**; the deployment
  published it anyway, with an empty map. The plan now says what happens: a route with nothing
  pinned is published and answers `model_not_configured` until a model is pinned. A Claude
  route the operator chose not to publish is reported as such, with the pins it strands. (P29)
- **Options 2 and 3 listed every Foundry account's deployments, even after an account was
  chosen.** The gateway reaches one account — both routes point at it — so the other rows were
  deployments that would answer 404, offered behind a "Pin it anyway?" prompt; a real run listed
  54 deployments from four accounts, 25 of them unreachable. Both options now list only the
  chosen account. Option 3 with no account chosen asks for one first instead of pinning against
  an empty account name, and keeps the choice even when nothing is pinned. Option 2 reports a pin
  whose deployment is in another account as `MISSING` rather than `ok`. An account recorded with
  the wrong resource group is found where it is rather than shown as empty, and option 1 takes
  the resource group from the account instead of defaulting to the previous one. See
  [ADR-0011](docs/adr/0011-pin-from-the-gateways-account.md). (P28)
- **Option 1 stopped with "The process does not possess the 'SeSecurityPrivilege' privilege"**
  on Windows, for every operator who was not elevated. P26 made `Get-SigningSecret` re-apply
  the file restriction on every read, and PowerShell's `Set-Acl` succeeds on a file the first
  time and fails every time after: once the DACL is protected, its retry tries to write the
  audit section, which needs a privilege ordinary users do not hold. `Protect-File` now writes
  the DACL through .NET, which persists only what changed. See UNKNOWNS U21. (P27)
- **The signing secret was world-readable on macOS and Linux.** It was restricted with
  `Get-Acl`/`Set-Acl` and a `FileSystemAccessRule` — all Windows-only — inside a `try`/`catch`
  that warned and carried on. Off Windows that `catch` fired every time and the file kept the
  default umask. The same applied to the deployment parameters file, which holds the secret in
  cleartext. Both files are now created empty, restricted by `Protect-File`, and only then
  written, so there is no window at default permissions; the secret is removed if it cannot be
  restricted, and the permissions are re-asserted every time it is read. (P26)
- `./admin.sh` with no arguments would have failed on a stock Mac. macOS ships bash 3.2, where
  `set -u` treats `"$@"` as unset when there are no arguments — and no arguments is how the menu
  opens. (P26)
- Deploying onto an instance that already publishes an API at `claude` failed the whole
  deployment. The picker knew about the collision and the deploy did not, so it tried anyway and
  failed with `Cannot create API 'claude-gateway' with the same Path 'claude'` — after it had
  already created the other API. The Claude path is now a parameter, and a collision offers an
  alternative path instead of failing. (P25)
- Deploying onto a Foundry account another gateway already had access to failed with
  `RoleAssignmentExists`. `Test-FoundryRoleNeeded` existed but was never called; the role grant
  is now conditional. (P25)
- New installations no longer assume two DeepSeek deployments exist. Pins start empty and option
  1 pins from what is actually deployed in the subscription, because defaulting sent people
  straight into a deployment that could only return 404. (P25)
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
