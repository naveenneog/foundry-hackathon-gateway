# Status

**Active packet:** none. P63 (liteAPIM on an existing Basic v2 gateway) is committed locally on
`release/key-dashboard` and not pushed; its liteAPIM runs beside the Basic v2 instance. P60 and
the preceding P59 and P58 changes are published and deployed to the Standard v2 app (P60's
release commit is `08dc5ee`). Next candidates: P64 (revoke), P65 (reinstall), P61 (narrow
screens).

P55 (release branch) and P49–P54 are published on `release/key-dashboard`, not merged to `main`.
Design: ADR-0015; owner amendment:
ADR-0016. App Service quota in eastus2 is 0 (U40), so Container Apps is the live path. The App
Service template builds; ARM validate/what-if is blocked by the zero quota. The live dashboard has no IP restriction; Entra
sign-in and the admin role remain required.

### P63 — liteAPIM on an existing Basic v2 API Management — DONE

The owner asked on 2026-10-26: "can you test this setup on basic v2 existing apim". Target: the
project's own Basic v2 instance `apim-hackgwfl4s7jvpxekno` (`rg-hackathon-gateway`, no virtual
network, system-assigned identity, routes `deepseek-gateway` and `claude-gateway` from P19), with
Foundry `ai-contosohub530569751908` in another resource group, `rg-contosohub`, which has public
network access Enabled. Design: ADR-0021.

Blockers, each verified on 2026-10-26 by read-only probes and then fixed test-first:
- `poc.bicep` read the Foundry only from the APIM's resource group, and `Deploy-Poc.ps1` had no
  way to name another. Now `-FoundryResourceGroup`; the parameter is passed only when it
  differs, so same-group deployments pass the same parameters.
- `Deploy-Console.ps1` required a VNet, the vault, an AIServices account and an App Insights
  component in the resource group, and took the first component listed. That resource group
  also holds the unrelated `appi-aum-aum-naveen`. Now:
  - `-FoundryResourceGroup` and `-FoundryAccountName`, falling back to discovery;
  - the workspace of the component the `hackgw-appinsights` logger writes to; with no logger,
    the only component, otherwise a refusal;
  - with no VNet, a refusal unless `-CreateNetwork`.
- `console.bicep` and `console-appservice.bicep` scoped the Foundry Reader assignment to an
  account in their own resource group. A cross-group scope does not compile (`BCP139`, U60). The
  same-group assignment is kept, with the same name, under a condition; a Foundry elsewhere gets
  it from `infra/console-foundry-reader.bicep`.
- `-CreateNetwork` (Container Apps only) deploys `infra/console-network.bicep`:
  `vnet-console-<suffix>`, default `10.65.0.0/24` (no VNet in the subscription used 10.65 on
  2026-10-26; outside the Standard v2 gateway's `10.61.0.0/16`, so the two could be peered),
  `snet-console` (`/27`, delegated to `Microsoft.App/environments`, the workload-profiles minimum,
  U58), `snet-pe` (`/28`), `pe-<vault>` and a link to `privatelink.vaultcore.azure.net`, created
  unless the resource group already has it. It prints each billable resource first. No VM or NAT
  gateway. `-NetworkPrefix` must be private IPv4, `/16` to `/26`, aligned, outside
  `10.61.0.0/16` and `172.30.0.0/15`. `-CreateNetwork` beside a gateway VNet is refused.
  `GATEWAY_VNET_NAME` is empty for this network (`gatewayVnetName`), because the gateway cannot
  use it for a private Foundry.
- `Deploy-Console.ps1` replaces the registration's redirect URIs. It now refuses, before any
  Entra change and again just before the update, when a redirect URI's host is not this app's,
  unless `-TakeOverRegistration` is given.
- For this instance, the derived environment and job names were 34 characters; they are now
  capped at 32 with `take()` (U59), which leaves 28-character names such as the Standard v2
  install's unchanged.

**Standard v2 unchanged.** A what-if on 2026-10-26 against `rg-hackgw-pe-test`, with the
parameters of its last deployments, gave the same result for the old and the new templates:
`console.bicep` 13 Modify and 2 NoChange, no Create (same 15 resource ids, including the eight
role assignments); `poc.bicep` 6 Create, 13 Modify and 6 NoChange for both (drift since
2026-10-11, identical for both). On that install the `hackgw-appinsights` logger points to its
only component, `appi-hackgwrv6pom6njwpfm`. The Standard v2 dashboard was not redeployed.

**Live on the Basic v2 instance, 2026-10-27:**

| Check | Result |
|---|---|
| `Deploy-Poc.ps1 -FoundryResourceGroup rg-contosohub` | Vault `kv-poc-ccaia767ovtdk` (public network access Disabled, RBAC); `poc-claude`, `poc-openai`, `poc-probe`; three `poc-*` products. The `poc-*` service URLs equal the existing routes' (same Foundry) |
| APIM before and after, by name and SHA-256 of path, service URL, policy and operations | `claude-gateway` and `deepseek-gateway` unchanged; global policy unchanged; 22 named values with the same names and values, except `hackgw-revoked-keys`, which changed only when the test key was revoked; `hackgw-claude-model-map` back to its original value after the test pin was removed |
| `Deploy-Console.ps1 … -AppRegistrationName hackgw-key-console-basicv2 -CreateNetwork` | Printed the billable resources; created the network, registry, environment, app and job. Second network deploy on a VNet in use (redeploy): succeeded, `snet-console` kept |
| Same command with the default registration `hackgw-key-console`, writes blocked by a wrapper | Refused: "App registration hackgw-key-console already signs in another app (ca-console-rv6pom6njwpfm…)"; 0 write commands attempted |
| `/healthz` | 200 `{"ok":true}`; `/api/me` without sign-in: 302 |
| Standard v2 registration redirect URIs | Unchanged before, during and after (one URI, `ca-console-rv6pom6njwpfm…`) |
| Standard v2 dashboard sign-in (debug Edge) | Account picker with the Standard v2 `redirect_uri`, then `/api/me` 200, role admin |
| Basic v2 liteAPIM sign-in (debug Edge) | `/api/me` 200, role admin |
| Signing secret | `/api/signing` `vault:false`; Migrate 200 `migrated:true`; then `inSync:true` |
| Pin `haiku-4-5` → `claude-haiku-4-5` (removed after the test) | 200 |
| Short-lived key for `haiku-4-5` | `/claude/v1/messages` 200 "ok"; `sonnet-5` 403 `model_not_permitted` |
| Product key for `claude-haiku-4-5` (product `pk-bffbcfcdcba7`, 20,000 tokens a month) | `/poc/claude` with `x-api-key` 200 "ok", twice; `x-budget-remaining` 19,985 then 19,970; `claude-sonnet-5` 403 `model_not_allowed` (U55) |
| Usage in liteAPIM (`log-hackgwfl4s7jvpxekno`) | Short-lived 15 tokens, 1 request; product 30 tokens, 2 requests; per key the same |
| Automation job, started once | `Succeeded` in about 40 s; logged `failed: []` (U57) |
| Test keys | Product key suspended and archived. Short-lived key: its `jti` is in `hackgw-revoked-keys`, but the vault tag update returned 400, so liteAPIM still lists it as active (U61, P64); it expires 2 hours after issue |

Found during the live run:
- The first install named the VNet `vnet-liteapim-<suffix>`, which broke the guides' single
  spelling of liteAPIM and the `console` naming of the other resources. It is now
  `vnet-console-<suffix>`. The first environment, app, job, endpoint, link and VNet were deleted;
  the zone was kept, so the second install exercised the reuse path.
- Installing again under the same names failed with `RoleAssignmentUpdateNotPermitted` on seven
  role assignments of the deleted identities (their names come from the resource ids). They and
  the old identity's subscription-level discovery assignment were deleted, and the install was
  rerun. One scheduled job run in that window logged `403 Forbidden` from the vault. Filed as
  P65; INSTALL.md's removal steps and troubleshooting say to remove those assignments.
- Revoking a short-lived key fails at the vault tag update (U61, filed as P64). Not P63's code
  path; the same on Standard v2.

**liteAPIM (Basic v2):** https://ca-console-hackgwfl4s7jvpxekno.ashysand-04919649.eastus2.azurecontainerapps.io,
app registration `hackgw-key-console-basicv2`, left running.

Created in `rg-hackathon-gateway`, with East US 2 list prices from the Azure Retail Prices API
(read 2026-10-26):

| Resource | Monthly cost driver |
|---|---|
| `pe-kv-poc-ccaia767ovtdk` (private endpoint) | USD 0.01 per hour, about USD 7.30 per 730 hours, plus USD 0.01 per GB |
| `privatelink.vaultcore.azure.net` (private DNS zone) | USD 0.50 per month, plus USD 0.40 per million queries |
| `crconsolehackgwfl4s7jvpxekno` (Container Registry Basic) | USD 0.1666 per day, about USD 5.07 per month |
| `cae-ca-console-hackgwfl4s7jvpxek`, `ca-console-hackgwfl4s7jvpxekno`, `job-ca-console-hackgwfl4s7jvpxek` | No environment charge without a Dedicated profile; active vCPU USD 0.000024 per second, memory USD 0.000003 per GiB-second, after the monthly free grant |
| `kv-poc-ccaia767ovtdk` (Key Vault Standard) | USD 0.03 per 10,000 operations |
| `log-ca-console-hackgwfl4s7jvpxekno` | USD 2.76 per GB after 5 GB a month |
| `vnet-console-hackgwfl4s7jvpxekno`, `id-ca-console-hackgwfl4s7jvpxekno-pull` | No charge |

Fixed cost about USD 12.87 a month (endpoint, zone, registry), plus usage. Not created: runner VM,
NAT gateway, public IP.

Verified: `npm test` 815/815 (794 before; 21 new in `tests/basicv2-poc.test.mjs`,
`tests/basicv2-templates.test.mjs` and `tests/basicv2-deploy-console.test.mjs`). Each failed
first for the missing behaviour. 20 mutants, all caught: 3 in `Deploy-Poc.ps1`, 4 in
`console.bicep` and 13 in `Deploy-Console.ps1`. The detector tests reject a Foundry pinned to the
APIM's group, a lost or renamed same-group assignment, an unscoped module, a VM, a NAT gateway,
public vault access, a missing delegation, a forced zone and an overlapping prefix. Two existing
pins moved to the renamed symbols with the same strength: `scope: foundryInGroup` for the Reader
assignment, and `value: gatewayVnetName` with `param gatewayVnetName string = vnetName` for
`GATEWAY_VNET_NAME` in `console.bicep`. All 17 PowerShell blocks in INSTALL.md parse.

Council: Architect PASS (opt-in network and cross-group Foundry recorded in ADR-0021; the
Standard v2 templates give the same what-if; no new dependency; the network is a separate
template that never touches the vault's public access). Coder PASS (discovery split into small
functions with unit tests; same-group parameters unchanged and pinned by a test; names capped
without changing existing ones). QA PASS-WITH-NOTES (tests first, 20 mutants caught, live
evidence table above; the reinstall failure and the revoke failure are filed as P65 and P64, not
fixed here). UX PASS (refusals name the switch to use and the billable resources come before
creation; INSTALL.md has a runnable path with expected output, costs and removal). Security PASS
(vault stays private; the registration guard stopped a live takeover attempt with no write;
no key, token or secret printed; test keys suspended, archived or revoked at the gateway).

### P62 — Installation guide for a novice administrator — DONE

The owner asked for the deployment guide to be assessed from a novice human user's perspective,
rated and improved.

- Clarified the two starting points and which infrastructure the liteAPIM installer does not
  create.
- Replaced unresolved PowerShell placeholder commands with prompts and defined variables.
- Added the missing `params.json` creation step for a new test stack, expected deployment outputs,
  first-success checks and a safer removal explanation.
- Replaced the incomplete Claude curl example with a PowerShell request that reads the key
  without echoing it. Updated the README's Azure installation summary to direct readers to the
  runnable guide.
- Added a guide regression test for setup-path choice, input handling, placeholders and
  verification checkpoints.

**Novice-readability rating (1–5, based on path clarity, prerequisites, command usability,
success checks and recovery/safety):** 2.0 before, 4.4 after. Subscores: path choice 1→5,
prerequisites 3→4, command usability 1→4, success checks 2→5 and recovery/safety 3→4. The guide
still depends on Azure quota, tenant permissions and a pre-existing Claude deployment for the
from-scratch test path; those external prerequisites prevent a full 5/5.

Council: Architect PASS (documentation clarifies existing resource boundaries without changing
deployment behavior). Coder PASS (PowerShell blocks parsed; no implementation code changed). QA
PASS (new docs test failed before the guide edits, then passed; links and markdown checks pass).
UX PASS (paths, expected results and recovery are explicit; residual external requirements are
called out). Security PASS (custom-domain trust and key separation remain unchanged; the test
prompt does not echo the short-lived key).

Verified 2026-10-25: `npm test` 794/794; packet gate 22 passed, 1 existing warning, 0 failed,
3 skipped. The 8 focused documentation tests pass, and all 13 PowerShell code blocks parse. No
Azure resources were changed.

### P60 — UI rebranded as liteAPIM — DONE

The owner asked on 2026-10-24, after P59: "Also rebrand the UI as liteAPIM".

- **The UI.** The header brand is `liteAPIM` alone: the "Foundry Gateway" line and the "Key
  Dashboard" subtitle are dropped, so one name appears. The brand link's accessible name is the
  name; the key mark stays decorative. The page title is "liteAPIM", then
  "<page> · liteAPIM" per route; the sign-in screen says "Sign in to liteAPIM", the
  administrators-only screen "liteAPIM is for administrators. Ask an admin for your key.", and the
  loading text, the no-script note and the start-up failure name liteAPIM. The setup guide opens
  with "liteAPIM (the admin key dashboard)". Sentences in which the app named itself ("The
  dashboard cannot read this account", "the console generates one") also say liteAPIM, in the
  browser modules, the usage-not-configured message, the bundle signature error, the product
  template error and the demo's sample Azure error. "dashboard access" stays: it describes access.
- **The demo and the deploy script.** The demo prints `liteAPIM demo (sample data, no Azure)`.
  `Deploy-Console.ps1`'s synopsis names liteAPIM, and its last line prints
  `liteAPIM (<hosting>): <url>` with "sign in as an admin, open Settings, then under Signing
  secret select Migrate from API Management": it still said to open "Signing secret", a page P59
  merged into Settings.
- **The guides.** README, `docs/CONSOLE.md` and `docs/INSTALL.md` say "liteAPIM (the admin key
  dashboard)" at first mention and liteAPIM after it; the README section and install step 4 are
  headed liteAPIM, and the links to them follow. Each guide says the screenshots and the
  architecture illustration predate the name. ADR-0015 has a dated note on the name.
- **Unchanged on purpose:** the branch, file names, environment variables, API paths, Key Vault
  secret names, the `hackgw-key-console` app registration and its roles, JWT audiences, CSV and
  bundle columns, Azure resource names, and the display names the app gives the API Management APIs
  and products it creates ("Key Dashboard: …"), which are Azure metadata, not shown in the UI.

Commits: `c9d6f0e` plan, `74027d2` UI, `1376fd7` deploy script, `0c44a70` guides and ADR note,
and this entry.

Verified:
- `npm test` 793/793 (786 before): `tests/console-brand.test.mjs` (3 tests), one deploy-script
  test and three guide tests. Four existing pins moved to the new exact text and stay exact: the
  served `<title>` (console-server), the administrators-only message (console-ui), the README
  heading and install step 4 (dashboard-release-docs).
- Each check failed first for the right reason. 39 mutants, all caught: 28 on the UI, the server
  messages, the demo and the deploy script (old title, brand, casing, a kept subtitle, an
  announced mark, each changed message, another spelling, a widened Azure display name), and 11
  on the guides (first mention, "the dashboard", headings, anchors, the quoted message).
- Edge 155 over CDP on the local demo, light and dark, at 1360 px and 390 px: 154 of 156 checks.
  The brand link is named liteAPIM and fits the top bar; every route's title ends "· liteAPIM";
  no page, the guide or the Connect another Foundry dialog shows an old name or "the dashboard";
  the guide opens with "liteAPIM (the admin key dashboard)" and Escape closes it; with
  JavaScript off the title is liteAPIM and the note says liteAPIM needs JavaScript; axe found no
  violations on the Overview, Settings and Foundry & models in either theme; no console errors.
  The two failures are 15 px of horizontal overflow on Foundry & models at 390 px, in both themes,
  from the Test connection model list: the same 15 px at `c1a2673`, before P60, so not fixed here
  and filed as P61. Below about 400 px the theme switch also stacks vertically, as before P60.
- Screenshots were not retaken.

Council: Architect PASS (display text only; no identifier, path, schema or resource renamed; the
brand test lists the API Management display names as the only allowed old name in code, with the
reason in ADR-0015). Coder PASS (one string per message changed; four exact pins moved to the new
text, none loosened). QA PASS (tests first, 39 mutants caught, browser checks in both themes and
two widths; the pre-existing overflow measured before and after and filed). UX PASS-WITH-NOTES
(one name on every page; the brand keeps its mark, size and contrast in both themes; the name's
lowercase start sits at the beginning of some sentences, as the owner's casing requires; the
screenshots and illustration still show the earlier name; the 390 px overflow and the stacked
theme switch predate P60, filed as P61). Security PASS (no change to authentication, roles,
audiences, secret names or key handling; deployed keys and installs are unaffected).

### P59 — custom usage range, chargeback export, admin gateway DNS URL — DONE

The owner asked on 2026-10-24 for a custom date range on usage, an export of a chargeback report
with all key labels, and an admin-set DNS URL that replaces the API Management URL in issued keys,
copied setup and everywhere the URL is shown.

- **Range.** The Overview, both key pages and the key drawer offer **Custom** beside 24 h, 7 d,
  30 d and 90 d: labelled **From (UTC)** and **To (UTC)** date inputs, limited to the 90 days
  `AppMetrics` keeps at no charge, with Apply (or Enter). The usage APIs take `days`, or `from` and
  `to`, never both; the server refuses anything but strict `YYYY-MM-DD`, a reversed range, an end
  after today or a start before today − 89 days with 400. `buildUsageQuery` writes the
  `datetime()` bounds itself from whole UTC days and checks them again; the Logs query gets the
  same window as `timespan` (U53). Two days or fewer are hourly, longer ranges daily, zero-filled
  up to the current bucket. The 60 s cache key holds the period.
- **Chargeback.** `POST /api/chargeback` (admin-only, audit-logged) and the Overview's
  **Chargeback report** card return `chargeback-<from>-<to>.csv` for the chosen period, both kinds
  or one: one row per key and model with 26 columns, from the period to first and last use.
  Usage whose key is gone is `unknown` with its key id; the Overview's Top keys now names it
  "Unknown key `<id>`" instead of showing an empty name. Built from tags and usage rows only;
  cells are formula-escaped and RFC 4180-quoted; no totals row and no prices (ADR-0020, which
  amends the charter's chargeback non-goal; per-model rates are a "Later" roadmap entry).
- **Gateway URL.** **Settings** (the Signing page, renamed; `#/signing` still opens it) has
  **Gateway URL (custom domain)**. Only `https://<hostname>` is accepted, and only if ARM lists the
  host name as a `Proxy` entry of this API Management's `hostnameConfigurations` (U51); otherwise
  400 saying to add the custom domain to API Management first. It is stored in Key Vault as
  `console-gateway-url` (reset writes `{"url":null}`, U54) and audit-logged with the old and new
  URLs. One resolver, `effectiveGatewayUrl()`, supplies every emitted URL; each replica caches it
  for 30 s and checks the host name with ARM again when it reads the setting again. The connection
  test keeps calling `GATEWAY_URL`; the dashboard never requests the admin-provided URL. The card
  says that handed-out keys keep working (U52) and lists the gateway custom domains on offer.
- **Help and demo.** The guide has nine steps; the gateway URL, the usage period and the
  chargeback report each highlight their control with Show me, and Escape closes the guide. The
  demo answers each query's window, includes usage of a deleted key and offers
  `ai.contoso.example`.

Commits: `5fda509` plan, `798e103` range (server), `9a6ab52` range (UI), `0e18208` chargeback
(server), `c9d039d` chargeback (UI), `648fb11` gateway URL (server), `8f21105` Settings,
`8168b0f` demo, `f086615` help, `165b496` chart table overflow, `03d616a` review fixes, `f7de90d`
guides, `3693006` this entry, and `35c1ef6`, which renames the Key Vault secret-name constant to
`GATEWAY_URL_SECRET_NAME` after the gate's credential scan read the old name as a credential.

Verified:
- `npm test` 786/786 (734 before): 52 new tests in eight new files and the demo test. Three
  existing guide assertions changed with the step count and stay exact ("Step 1 of 9", "Step 2 of
  9", the last two steps), and the fake DOM now reflects the `id` property as browsers do.
- Each behaviour failed first. 142 mutants: 140 caught, two equivalent (a `typeof` check that a
  stricter comparison already covers, and one of two overlapping host rules). Five survived their
  first run and each led to a stronger test: the cache key, a browser date check, Reset's Cancel,
  the demo's hourly rows and the guide's focus target.
- The resolver scan: every emitter names the custom domain and none the API Management URL, and
  the reverse after a reset; a scan fails if any module reads the configured URL other than through
  the resolver. Each of its six rules was removed in turn and each removal was caught, and a real
  bypass in `service.mjs` trips the scan on its own.
- An independent code review found two defects, both fixed test-first in `03d616a`: a save or
  reset could be undone for 30 s by a read of the setting running at the same time, and a last
  label such as `0x7f`, which the URL standard reads as an IPv4 number, gave 500 instead of 400.
- Edge 155 over CDP on the local demo, light and dark: 88 of 88 checks. axe found no violations on
  the Overview with a custom range, the key drawer and Settings (with and without a custom domain).
  The range form opens without moving focus, Tab reaches From (UTC), Enter applies; downloads were
  read back; Reveal named the custom domain; Show me and Escape behaved; no console errors or CSP
  violations apart from the deliberate 400. The first run found 123 px of horizontal overflow at
  390 px: chart data tables for assistive technology, an issue that predates P59, fixed in
  `165b496` (0 px after).
- Not run against Azure: nothing was deployed. The ARM shape (U51) and the Logs query window (U53)
  are documented, not measured; the first live use of each is the check.
- Screenshots were not retaken; README, CONSOLE.md and INSTALL.md say which ones predate P59.

Council: Architect PASS (one resolver for the gateway URL and a scan that keeps it the only
source; pure builders in `usage.mjs` and `chargeback.mjs`; the conflict with the charter's
non-goal reconciled in ADR-0020 before any code; every module within its size budget). Coder PASS
(the two review findings and the overflow fixed with failing tests first; `days`-only callers
unchanged). QA PASS (tests first, 140 mutants caught, browser checks in both themes; live Azure
checks listed as open). UX PASS-WITH-NOTES (labels, focus, keyboard, Escape and axe verified in
both themes; with Custom open the period control takes the header's full width and pushes Refresh
to the next line, and the guide's highlight around it is as wide; browser tabs already open show
a new gateway URL in forms only after a reload; screenshots predate P59). Security PASS (the
gateway URL is trusted only as an ARM-listed gateway host name, never requested, re-checked on
every refresh and stored with versioned history and an audit trail; KQL holds only values the
server formatted; the chargeback file holds no secret and escapes formulas; new routes are
admin-only with the same-origin JSON check; residual: the dashboard identity's role could write
host names, though the code only reads them, and DNS for the custom domain is not checked).

### P58 — Foundry page shows only APIM-connected accounts — DONE

The owner asked on 2026-10-24 that Foundry & models list only the Foundries connected to the
selected API Management, because short-lived and product keys are an APIM feature. The page
listed every account in the subscription (16 live), with Attach on the unattached ones.

- The account list, lede and count cover the accounts discovery marks `connected`: the default
  connection and each attached account.
- **Connect another Foundry** is a modal dialog (`foundry-connect.js`, opened through
  `openModal`) that lists the other discovered accounts, unreadable ones with their error, with
  search. The chosen account shows Attach, the role setup command, the optional private-network
  command and **How attaching works**, which closes the dialog before it opens the guide (U50).
  A successful attach closes the dialog and selects the account in the connected list; a failed
  attach keeps the dialog open with the error and focus on Attach.
- With nothing connected, the page shows an empty state with the same action. The issue forms
  no longer count unconnected accounts; their empty state links to Foundry & models.
- The guide's Attach step highlights Connect another Foundry; the step text describes connected
  Foundries.
- The local demo attaches `aif-secondary` (with a pinned alias) and adds four unconnected
  accounts, one of them unreadable.
- Server APIs and their validation are unchanged. The server's static allow-list serves the new
  module.

Commits: `a4d739b` plan, `e23a5aa` shared fake DOM, `dc1a4e1` count helpers, `1c70d39` page and
dialog, `a441f06` issue forms, `f0b9c1e` demo, `ffa40ef` focus fix after review.

Verified:
- `npm test` 734/734 (721 before). 13 new tests; the demo test now requires two connected and
  several unconnected accounts. `summaryLine`, which counted every subscription account, was
  replaced, and its assertions in the P56 test now check `connectedLine` and `candidatesLine`.
- Each behaviour failed first: the page rendered 5 radios for 2 connected accounts; there was no
  Connect another Foundry button; the issue form said "3 more accounts are not attached or not
  readable"; the demo's connected list was `aif-test` only.
- 42 mutants, all caught. The first run let two survive, and the two assertions were tightened:
  the guide opens only after the modal closed, and focus is on the re-rendered Attach button.
- An independent code review found one defect: focus that the admin moved during the reload
  after an attach was taken back. The focus check now runs after the reload (`ffa40ef`, with a
  failing test first).
- Edge via Playwright on the local demo: 47 of 48 checks passed in light and dark. axe found no
  violations on the page, the dialog, the unreadable-account state and the issue form; Tab and
  Shift+Tab stayed inside the dialog for 80 presses; Escape closed the dialog, then the guide;
  an attach selected the account and moved focus to its setup command; there were no console or
  CSP errors. The remaining check found 1 px of horizontal overflow at 390 px in the access
  section, which is identical on `cf895a7`.
- Screenshots were not retaken. README and CONSOLE.md state that `console-foundries.png`
  predates P58.

Council: Architect PASS (UI only, recorded in ADR-0018; requests that name an account stay in
`views-foundry.js`, pure rules in `foundry.js`). Coder PASS (unattached-account branches removed
from the page; the review finding fixed with a test). QA PASS (failing tests first, 42 mutants
caught, browser checks). UX PASS-WITH-NOTES (focus, keyboard, Escape and axe verified in both
themes; while highlighted, the guide's step label overlaps the cards above the connect row, as
other highlights overlap what is above them; the 1 px overflow at 390 px predates P58). Security
PASS (no new endpoint or data flow; DOM built only through `el()`; attach validation and
admin-only authorisation unchanged on the server; hiding an account in the browser is not
relied on as a control).

### P57 — 90-day usage view — DONE

Usage periods were 1, 7 and 30 days. The `AppMetrics` table keeps 90 days at no charge
(Learn, data-retention-configure, retrieved 2026-10-24; live table on
`log-hackgwrv6pom6njwpfm`: retentionInDays 90, totalRetentionInDays 90, default). The server
and browser now offer 90 days; other periods return 400. Longer history (table retention or a
roll-up store) has a cost and is not built; it needs an owner decision.

Council: Architect PASS (one period list per side, parity test). Coder PASS (two-line change,
daily buckets reused). QA PASS (RED failed on the missing 90; 365 refused). UX PASS (fourth
segment in the existing control). Security PASS (period still allow-listed before KQL).

### P56 — multi-Foundry discovery, attachment, selection and highlighted help — DONE

The catalogue now discovers AIServices and OpenAI accounts across the configured subscription.
Its first live response showed 16 accounts and 79 deployments instead of two deployments from
one account. An independent ARM list is used in live checks so a newly created account cannot
be silently missed. Account permission failures are displayed, not turned into empty lists.

Each attached account has isolated APIM backends, API paths, model maps and a short-lived-key
audience. Product hashes/API links and single/bulk handouts, CSVs, reveal and export are
account-specific. The original account's routes, maps and audience remain unchanged.

The UI was built by Opus 5.5 at max effort. It includes Foundry/account selection, refreshed
deployment lists, account-local pins, Attach, an explicit bounded connection Test, key issue
Foundry selection, and help that highlights each setup step. Unsupported non-chat deployments
remain visible with the reason they cannot be pinned to the chat/messages APIs.

**Live bug-bash findings and fixes (2026-10-23/24):**
- APIM rejected readable source policy copies above 16 KiB. Deployed copies now remove comments
  and formatting only; tests require the payload bound and every enforcement guard.
- Attached-account DNS failed because linked private DNS zones had only the original account's
  records. Explicit operator private-endpoint setup fixed this without relaxing a firewall.
  Original private DNS records remain unchanged; the new endpoint is Approved/Succeeded.
- APIM returned 502 for duplicate product display names despite distinct product IDs.
  Product display names now include their stable ID before any truncated description; tests
  cover equal models in different accounts and different budget variants.
- Escape after **Show me** cleared the highlight without closing the help guide. The Opus UI
  follow-up fixed it test-first; one Escape now closes the guide and restores its opener, while
  modal dialogs retain their own Escape handling.

**Live generated-key/client checks:**
- Selected-account short-lived and product keys each returned 401 on the default account's
  routes. An ungranted model returned 403.
- OpenAI-compatible and Claude inference on the attached account each returned 200.
- OpenCode 1.18.21 used a newly dashboard-issued short-lived key through the attached account
  and exited 0 with `OK`.
- Anthropic Python SDK 1.15.0 used both a newly issued short-lived key and a product key through
  the selected account; each replied `OK` (12 input / 4 output tokens in the smoke test).
- Test short-lived keys were revoked; test product keys were suspended and deleted. Empty APIM
  diagnostic products were individually removed. The original backend connection test remains
  successful.

**Browser and regression verification:**
- All 720 repository tests pass. The 55 UI tests include account identity, cache refresh,
  account changes clearing stale grants, highlight lifecycle and keyboard/modal precedence.
- All 14 final live browser checks passed: discovery matched an independent ARM account list;
  the secondary account's Opus deployment appeared; Help highlighted the control and Escape
  closed it; the UI connection test succeeded; all four single/bulk key forms cleared their
  model choice when switching Foundry; 900px had no document overflow. No console/CSP errors.
- The catalogue refreshed to 17 accounts / 81 deployments as more resources appeared during
  testing. The implementation does not hardcode account/model counts.
- The local demo simulates inference tests too; it sends no requests to Azure or the sample
  gateway. New screenshots show account selection, deployed Claude models, issue-time Foundry
  choice and highlighted help, with identifying text replaced before capture.
- The packet gate exits 0 (22 passed, one pre-existing `src/diagnose.mjs` warning). All 15
  browser modules pass syntax checks; both hosting templates and the new optional
  private-endpoint template build.

Backend and UI security reviews reported no vulnerabilities. Discovery grants only the two
account/deployment metadata-read actions. The dashboard cannot grant roles or modify firewalls;
operator commands are displayed/copied only. New API operations are blocked until their full
governance policy is installed. Negative checks caught all five backend isolation mutants with
clean imports and unchanged test counts; the UI agent caught 28 UI regressions.

**Council — P56**

| Seat | Verdict | Evidence |
|---|---|---|
| Architect | PASS | ADR-0017 isolates attached accounts by API paths, model maps, JWT audiences and product links; old routes are unchanged |
| Coder | PASS | Shared canonical model rules, existing governance policy copies, trusted ARM-derived hosts; partial APIs fail closed and attachment is retryable |
| QA | PASS | 720 tests, five clean-import backend mutants, 14 live browser checks, actual OpenCode/SDK calls and wrong-account controls |
| UX | PASS | Opus 5.5 max UI; all accounts/deployment states visible; account choice on all issue forms; guided highlights; Escape bug fixed; axe in both themes |
| Security | PASS | Backend/UI reviews found no vulnerabilities; subscription discovery is metadata-only, operator access setup is explicit, no dashboard elevation/firewall relaxation |

Live source image: `ecbc672` (final guide keyboard fix). Empty diagnostic APIM products were
removed; selected-account private connectivity remains available for the attached backend.

### P55 — release branch, README, install guide, local demo — DONE

`release/key-dashboard` is cut from `feature/key-dashboard` and pushed to GitHub; nothing is
merged to `main`. The README leads with the Key Dashboard, and `docs/INSTALL.md` is the install
and setup guide. `scripts/dashboard-demo.mjs` (`npm run dashboard:demo`) runs the real server and
UI on the unit-test fakes with seeded data, bound to 127.0.0.1. The owner's architecture
illustration shows recipients obtaining Entra tokens; the README and the guide state beside it
that recipients use dashboard-issued keys instead.

Verified:
- `npm test` 657/657.
- New tests: every README and INSTALL link and image resolves; the demo binds to 127.0.0.1 and
  serves seeded keys and usage.
- Each new check was negative-tested: a broken image link and a `0.0.0.0` bind each failed the
  suite.
- Before the push: the 23 commits being published contain no tenant ids, resource suffixes or
  personal emails. The subscription name in STATUS is already on `main`.
### P49–P54 — Key Dashboard — DONE (branch `feature/key-dashboard`)

**Owner's amendment (2026-10-23, ADR-0016):** admin-only dashboard; owner is attribution, not
access. Rename hackathon keys to short-lived keys, with the same `startInHours` activation delay
as `scripts/Keys.ps1`. Key distribution remains administrator copy, `keys.csv` / `index.csv`,
or the encrypted bundle. No participant is given dashboard access.

**Implemented:**
- Foundry deployment list and model pin/unpin, using the same `canPin`, `suggestAlias` and model
  map serialization as the scripts.
- One or several explicitly selected models per key. Short-lived keys use pinned aliases;
  product keys use Foundry deployment names, enforced by a model-set product policy.
- Separate short-lived and product views, usage by key/model/day, overview chart, light/dark
  theme. Product usage was measured live at 40 tokens across two product keys (3 requests).
- Unlimited listing via Key Vault pagination; expiry and revocation archive keys, product
  subscriptions suspend on archive, and archived keys delete after 30 days. Admin bulk issuance
  handles any number of rows in 50-row requests.
- Hosting is selected at install: Container Apps (live) or App Service plus Function App. The
  Container Apps deployment has a cron job for automation, scales the dashboard to zero, and
  has no IP restriction. `-AllowedIp` is optional; Entra sign-in is always required.
- Bulk keys go to the administrator's browser as the script-compatible `keys.csv` plus a
  key-free `index.csv`. The UI does not show key values in the result table and drops the CSVs
  on close, route change and pagehide.

**Owner access decision:** only `Console.Admin` may use the dashboard. The service and the
router both refuse non-admins with 403. A key's “Issued to” email is only an attribution tag.
This supersedes the earlier `Console.User` visibility behaviour in P46/ADR-0013.

**Live deployment checks (2026-10-23):**
- The IP restriction is absent (`ipSecurityRestrictions: []`); `/healthz` returned 200 on five
  consecutive requests from the workstation and on the private runner VM.
- `/api/me` returned 200 for the assigned admin; unauthenticated `/api/me` returned 401.
- Bulk short-lived issuance with a one-hour delay returned a key whose JWT `nbf` was in the
  future, listed with status `scheduled`. `keys.csv` contained the key and `index.csv` did not.
  Revoke returned 200.
- Product bulk issuance returned `keys.csv` and a key-free `index.csv`; archive and delete each
  returned 200.
- Private runner VM resolved the vault to `10.61.2.7` and Foundry to `10.61.2.4`; unauthenticated
  data-plane calls returned the expected 401/404 rather than network failures. Dashboard
  `/healthz` returned 200 and `/api/me` returned 401 from inside the VNet.
- The automation job completed successfully in the VNet. Product usage matched the two live
  product keys. Earlier live checks covered gateway enforcement, model pinning and two-slot
  product rotation.

**Security and bug bash:** security review found no browser UI vulnerabilities. The backend
review's finding that archiving a live signed key did not revoke its self-contained JWT was
fixed in `49c2f0a`; tests now require revoke-before-delete. Live issuance tests covered the one-
and two-model product grants, a wrong model (403), short-lived `nbf`, the CSV contents and
archive/delete. UI interaction checks covered 27 browser flows; axe found no violations in
light or dark mode. No live prompt or request body is logged.

**Verification:** `npm test` (652 passed, 0 failed); `node --test tests/console-ui.test.mjs`
(32 passed); `node --check` on 11 browser modules; both Bicep templates build; UI security review
reported no findings; backend security finding fixed; pre-commit gate passes. The only gate
warning is the existing credential-shaped test literal in `src/diagnose.mjs`.

**Council — P49–P54, direct review, two security reviews and live checks.**

| Seat | Verdict | Evidence |
|---|---|---|
| Architect | PASS | ADR-0015/0016 decisions are explicit; hosting is selectable; existing APIM, vault, Foundry and workspace are reused |
| Coder | PASS | Service adapters isolate Azure; role checks are duplicated in router/service; bulk response follows the script's CSV contract |
| QA | PASS | 652 tests; 32 UI tests; live delayed activation, CSV content, wrong-model refusal, archive/delete; private-network DNS and auth checks |
| UX | PASS | Separate short-lived/product pages, light/dark charts, scheduled badge, admin-only state; 27 browser interactions and axe in both themes |
| Security | PASS-WITH-NOTES | UI review found no issues; backend review's archive/revocation finding was fixed/tested. No IP restriction is deployed by owner decision; Entra and admin role remain required |

Commit `c498193` contains the UI amendment; backend amendment `e0e795a`; optional IP rule
`e78fdbb`. The live image is built from `c498193`. Nothing has been pushed or merged.

### P46 — Key Console — DONE (branch `feature/admin-console`)

A web app (`src/console/`) on Azure Container Apps, in the POC VNet, behind Entra sign-in. Its
roles are `Console.Admin` and `Console.User`. It covers:
- signed (HS256) keys, minted from `gw-signing-secret` in the private vault;
- product keys stored in Key Vault, with two-slot rotation and opt-in automation (a sweep every
  60 min);
- admin-only export as an ES256-signed, scrypt and AES-256-GCM bundle, opened by
  `scripts/open-bundle.mjs`.

Deploy: `scripts/Deploy-Console.ps1`. Guide: `docs/CONSOLE.md`. Decisions: ADR-0013, ADR-0014.
App Service quota was 0 in eastus2, so hosting is Container Apps. U37, U38 and U39 are
resolved. **Historical note:** P46's `Console.User` access was superseded by ADR-0016 on
2026-10-23; the current dashboard is admin-only.

**Live evidence (2026-10-16/17):**
- **Signed key:** `/v1` (flash) returned 200 and `/claude` (haiku-4-5) returned 200. After
  revoke, both returned 403.
- **Product key:**
  - the primary key was accepted;
  - after rotation, the new key was accepted within 16 s and the old one kept working through
    the overlap; after a second rotation, the original returned 401;
  - suspend returned 401 and resume returned 200, each within 16 s.
- **Automation sweep:** it rotated the one due key, and rotated nothing on a second run.
- **Bundle:**
  - a genuine bundle opened;
  - a bundle with an edited header was refused;
  - a bundle with a flipped ciphertext was refused.
- **User role:** only own keys were visible; another person's key returned 404; every admin
  action returned 403.
- **Without sign-in:** `/healthz` returned 200; `/api/me` returned 401, including with a spoofed
  principal header; plain HTTP was redirected with 301.

**Findings:**
- **Easy Auth on Container Apps returns a bodyless 403 to cookie-authenticated browser POSTs
  without a same-origin `Referer`.** The fix, written test-first, is `Referrer-Policy:
  same-origin`. Changing CORS or the proxy convention did not help.
- **The tenant blocks user consent.** Admin consent returned 403, so the script grants per-user
  consent instead; for other users this is still open (P47).
- **Keys from the POC runner have no owner, so no user can see them (P48).**
- **UX:** a narrow window spilled the key table out of its card; it now scrolls inside it.

**Test-first slip:** `src/console/azure.mjs` was written before its tests. Mitigation: the tests
in `tests/console-azure.test.mjs` were added before the commit, and each was checked by mutating
the code under test and seeing it fail. The other P46 code was written red first.

**Council — P46, direct review plus the live run.**

| Seat | Verdict | Evidence |
|---|---|---|
| Architect | PASS-WITH-NOTES | Role check in one function (`auth.can`); Azure behind adapters; no per-request vault dependency at the gateway. Hosting changed by ADR-0014, not silently. Notes: single replica, so the sweep cannot double-run; P47 and P48 filed |
| Coder | PASS-WITH-NOTES | Modules small and pure where possible; inputs validated at the boundary (`validate.mjs`). Note: the `azure.mjs` test-first slip above |
| QA | PASS | `npm test` and the console suites green; live end-to-end for both key types, both roles, bundle tamper cases and the sweep; the Referer bug fixed with a test |
| UX | PASS-WITH-NOTES | Role-shaped UI (user sees one tab, no export); secrets shown once with a different-channel hint; table overflow fixed. Note: no user-role screenshot published, because it would show a real identity |
| Security | PASS | Entra sign-in with assignment required; spoofed principal refused; managed identities only, no client secret or registry password; vault private; bundle signed in the vault and tamper-checked; CSP and frame denial; no secret values logged; screenshots redacted |

Verified: `npm test` and `node .ironclad/gate.mjs --stage packet`.

P45 — illustrated Azure portal guide — DONE (pushed at `5d6b71a`).

### P45 — Azure portal screenshots in PORTAL.md — DONE (branch only)

`poc/products-keyvault/PORTAL.md` now carries 20 real Azure portal screenshots in
`poc/products-keyvault/portal-screenshots/`, placed in the steps they illustrate: the instance's
managed identity and network; the Create an HTTP API form, an API's Settings and Design; the
packs, the Add product form, a pack's overview, APIs, policy and subscriptions; the Create key
vault form (access configuration, networking), the vault's firewall, private endpoint
connection and access configuration, and its Secrets refusing a browser outside the private
network; the New subscription pane, the subscription menu and the Subscriptions list. A new
**Screenshots** section states provenance: captured 2026-10-13 from the deployed POC; identifying
values replaced in the page (DOM) before capture, nothing changed in Azure; creation forms
opened, not submitted; keys masked by the portal and never revealed. The vault's role
assignments are not pictured (the blade lists other principals by name). Portal labels seen for
regenerate, suspend and activate are recorded as "seen in the portal" (narrows U31/U33). U35
resolved. No Azure resources changed.

**Council — P45, direct review.**

| Seat | Verdict | Evidence |
|---|---|---|
| Architect | PASS | Screenshots placed beside the steps they illustrate; deployed state distinguished from unsubmitted forms and from data-plane views that need the private network |
| Coder | PASS | Images embedded as indented lines inside steps so the step parser keeps them; numbered lower-case names; no runtime change |
| QA | PASS | Four screenshot tests failed for the missing images and note, then passed; the 28 document tests still pass |
| UX | PASS-WITH-NOTES | Each image has descriptive alt text and a lead-in; 1600 px portal captures are legible; the subscription menu is shown once and referenced from Suspend |
| Security | PASS | Every published image visually reviewed for keys, names, emails, tenant, GUIDs and resource names; IAM view dropped for listing other principals; header account area masked |

Verified: `node --test tests/poc-products-keyvault-portal-screenshots.test.mjs
tests/poc-products-keyvault-docs.test.mjs` (32 of 32) and `node .ironclad/gate.mjs --stage packet`.

P44 was pushed to `origin/poc/apim-products-keyvault` at `abdfd18`; CI run 38440393875 passed.

### P44 — editable draw.io architecture — DONE (branch only)

`poc/products-keyvault/ARCHITECTURE.drawio` has two editable pages: **Request and network**
and **Key lifecycle**. Inference, private secret access and management traffic are distinct;
the gateway has no per-request Key Vault dependency. The diagram covers issuance, handover,
two-slot rotation, scheduled `SuspendExpired`, suspension and per-secret read revocation, with
the budget overshoot and query-key forwarding limits. README and ARCHITECTURE link the file.
No new service behaviour or architecture decision; the existing P43 sources and measurements
apply. No Azure changes, push or merge.

**Council — P44, direct review against P43 architecture and its code-derived checks.**

| Seat | Verdict | Evidence |
|---|---|---|
| Architect | PASS | Inference and key distribution are separate; private endpoint paths match the POC network; no gateway-to-vault request arrow |
| Coder | PASS | Native uncompressed draw.io XML; two pages, unique ids and connected edges; no runtime changes |
| QA | PASS | Three contract tests failed for the missing file, then passed; existing 28 doc tests still pass; XML parsing and page bounds checked |
| UX | PASS-WITH-NOTES | Descriptive pages, labelled arrows, consistent service colours, readable text sizes; no interactive draw.io render was performed |
| Security | PASS | No credential values or resource identifiers; query forwarding, broad APIM key access via the management API, and copied-key revocation limits stated |

Verified: `node --test tests/poc-products-keyvault-diagram.test.mjs
tests/poc-products-keyvault-docs.test.mjs` (31 of 31), XML parsed with PowerShell's XML reader,
all 34 vertices inside their page bounds. `node .ironclad/gate.mjs --stage packet` passed
(exit 0, full suite; the existing `src/diagnose.mjs` credential-shape warning is unchanged).
Commit: `3b10fbb` (diagram, links, tests and ledger); local only.
PNG exports `architecture-request-network.png` and `architecture-key-lifecycle.png` (draw.io
desktop, scale 1.5) are embedded in the POC README; a test checks the embeds and the PNG
signature. The page-1 band heading was moved so it no longer overlaps an arrow label.

P43 is done on branch `poc/apim-products-keyvault`, pushed to `origin`
on 2026-10-13 at `d79c4f3` (CI run 38367703480 passed: the suite on Windows, macOS and Ubuntu,
and the packet gate) and not merged to `main`; merging is the owner's decision. Filed for this
branch: P40, P41, P42. Open packets for `main`: P39
(recorded on this branch only), P36, P35, P30, P20.

### P43 — portal steps and architecture — DONE (branch only)

`poc/products-keyvault/PORTAL.md` builds in the Azure portal what `infra/poc.bicep` builds and
runs each key operation by hand; every numbered step and prerequisite cites Microsoft Learn.
`poc/products-keyvault/ARCHITECTURE.md` describes the components, identities and roles, network
paths, the request flow, each key flow and the design decisions. U31 (ASSUMED, the steps were not
run in the portal), U32 and U33 (RESOLVED) were logged before writing and closed by research.
`tests/poc-products-keyvault-docs.test.mjs` (28 tests) reads both documents' tables by column and
compares them with the templates, policies and scripts.

**Council — P43, round 1.** BLOCK at every seat; all five BLOCKs fixed with tests.

| Finding | Fix |
|---|---|
| **BLOCK B1.** A vault built from PORTAL.md kept the trusted-services bypass the template turns off; Learn: "Disabling public access doesn't suppress the trusted services bypass" | A step clears **Allow trusted Microsoft services to bypass this firewall**, with `az keyvault update --bypass None --default-action Deny`; a test ties it to the template's `bypass: 'None'` |
| **BLOCK B2.** "The client's key never leaves the gateway" was false: a key in the `subscription-key` query parameter reaches Foundry | Stated with P42; a test rejects the claim while no route policy removes the query parameter |
| **BLOCK B3.** The portal tag steps wrote a version without `subscription`, which the next scripted `Rotate` refuses | Issue and Rotate give the content type and all three tags for the version they write; a test reads that step |
| **BLOCK B4.** The table tests ignored columns: swapped budgets passed | Tables are read by column from the header row; the council's swaps now fail |
| **BLOCK B5.** Roles and scopes were compared with nothing in the code | Role ids in `poc.bicep`, `runner.bicep` and `PocKeys.ps1` are mapped to names, and each identity's role and scope is checked in both documents |
| Architecture: the probe described as refusing keys and calling Foundry; the custom-role wording; the private endpoint's origin and the bypass behind "only path" (A1–A3) | Corrected, with tests for the bypass and the endpoint's removal |
| Tests: counts, both content types, the probe route from the template (C1–C3); policy file and service URL per route, template network and product values, header meanings, anchors, command parameters, per-step citations (Q1–Q6) | Each has a check |
| Portal walkthrough: removal left the vault's private endpoint and claimed the script's order; the one-time copy did not name the current key; the runner path and `SuspendExpired` were missing; no Foundry endpoint location, subnet prerequisite or `$target`; API labels cited from the wrong page; P41 (U1–U9) | Corrected; the endpoint location, subnet, `$target` and the runner step are in the document |
| Clipboard history keeps a copied key (S1) | Stated, with Microsoft Support's clipboard page |
| The uncommitted CHANGELOG entry claimed per-step Learn citations and comparison with the templates, which Q6, B4 and B5 contradicted (L1) | Both claims hold after Q6, B4 and B5 |

Mutations caught: 24 of 24, including every change the council made to defeat the first tests.

**Council — P43, round 2.** No BLOCK; every seat PASS-WITH-NOTES. All round-1 findings resolved;
the fixes introduced nine notes, each fixed below.

| Finding | Fix |
|---|---|
| N1. Remove step 3 cited "Manage private endpoints", which does not cover deleting an endpoint | Cites "What is a private endpoint?" (the network interface's lifecycle) and "DNS integration" (the zone group's records are deleted with the endpoint); the step names the zone's virtual network link |
| N2. Rotate step 1 cited Update Secret for reading the `slot` tag | Cites Get Secret, which returns a version's tags, and states that Learn does not document viewing them in the portal (U31) |
| N3. The portal-made private endpoint had no name; `Remove-Poc.ps1` deletes only `pe-<vault-name>` | Both creation flows name it `pe-<vault-name>`; the removal paragraph says the script deletes the endpoint and the zone's link `link-<vnet-name>` by the names `runner.bicep` gives them. A test reads both names from `runner.bicep` and `Remove-Poc.ps1` |
| N4. The custom-role list lacked read | Added; a test derives the list from the subscription calls in `PocKeys.ps1` and `Remove-Poc.ps1` |
| Nit. The probe answers "for any key" | "for any valid key", in ARCHITECTURE.md and SETUP.md |
| N5. The runner command works only after `Deploy`, `Setup` and `Push` | Names the three steps and links SETUP.md's runner section; states that `Deploy` creates `pe-<vault-name>` and its zone, so the runner path needs no endpoint from step 1. A test compares the steps with SETUP.md and checks that `Deploy` deploys `runner.bicep` |
| N6. `-KeyAction` values were not checked | Checked against the runner's `ValidateSet` |
| N7. The endpoint lookup used **Keys and Endpoint**, which also shows the account's keys | Uses the account's **Overview** ("On the Overview page, note the Endpoint value"); a test rejects "Keys and Endpoint" |
| N8. The template's published `AI Foundry API` branch of the Claude URL was not compared | The prerequisite describes it; a test reads the branch from the template |
| N9. Passed: a "never forwarded" claim, the runner's roles with swapped scopes, `approvalRequired: true` in the template, any Learn page as a step's citation | The claim check covers forward, send, go, travel and see, and "not … Foundry or backend"; runner roles are paired with their scopes from `runner.bicep`; the template may not require approval (the deployed packs read `approvalRequired` false, measured 2026-10-12); the steps behind N1, N2 and the vault's private endpoint cite their specific pages |

Also new: each document's Sources list holds exactly the pages it cites, each with its date. It
caught the virtual network links page missing from PORTAL.md and ARCHITECTURE.md's undated
entries.

Found while checking the N5 fix: the runner's `Deploy` cannot take over a private endpoint or
zone link made in step 1. Azure refused a change to an existing endpoint's connection and a
second link from the zone to the same virtual network (U34, measured 2026-10-12). PORTAL.md states
that a vault reached through the runner gets its private endpoint from `Deploy`, and a test reads
the connection and link names from `runner.bicep`.

Mutations caught: 24 of 24 on the round-2 checks and 3 of 3 on U34's. The round-1 sets still fail
the tests that cover them (24 of 24, 3 of 3); the first set's expected test names predate the
round-1 renames, and its mutants fail the renamed tests.

**Council — P43, round 3.** No BLOCK. Architect, Coder and Security: PASS. QA and UX:
PASS-WITH-NOTES. N1–N9, the nit and L1 confirmed resolved; three new notes, each fixed below.

| Finding | Fix |
|---|---|
| R3-1. The runner limit (U34) appeared only after step 1, which had already created the endpoint; no recovery was given | Step 1 states that a vault whose key scripts run on the runner gets its endpoint, zone and link from `Deploy`, and when `Deploy` fails; **The runner and step 1** gives the recovery (delete step 1's endpoint, then the zone's link) and its effect: the virtual network resolves none of the zone's records until `Deploy` links it again (Learn's Private DNS overview). Step 1 puts the zone in the vault's resource group (R4-1 below corrects where the vault goes) |
| R3-2. Remove step 3 cited the virtual network links page, which does not cover deleting a link or a zone | Cites the Private DNS REST pages Private Zones - Delete ("Private DNS zone cannot be deleted unless all virtual network links to it are removed") and Virtual Network Links - Delete |
| R3-3. The claim check rejected true sentences ("A request refused for its pack does not reach Foundry", "Keys never go to disk") and missed "The client's key stays inside the gateway"; two assertions pinned whole sentences | The check reads clause by clause and needs a key as the subject; a self-test holds 9 sentences it flags and 9 it passes, the council's included. The runner test checks facts (names, links, order, U34) in the paragraphs instead of sentences; rewording three sentences without changing their facts passes |

Mutations caught: 17 of 17 on the round-3 checks (seven of them on the claim check, each caught by
its self-test) and 3 of 3 replacing two mutants whose text was rewritten; the earlier sets are
still caught.

**Council — P43, round 4.** No BLOCK. Architect, Coder, QA and Security: PASS. UX:
PASS-WITH-NOTES. R3-1, R3-2 and R3-3 confirmed resolved; one new note, fixed below.

| Finding | Fix |
|---|---|
| R4-1. Step 1 did not say where to create the vault. The scripts build its id in `$target`'s resource group, the instance's, where `poc.bicep` creates it, and `runner.bicep` and `Remove-Poc.ps1` look there for the vault, the endpoint and the zone. With the vault elsewhere, `Grant`, `Revoke` and `Deploy` fail, and `Remove-Poc.ps1` reads the vault as absent and leaves it, the roles on its secrets, the endpoint and the zone | Step 1 creates the vault in the **Subscription** and **Resource Group** in `$target`, with the zone in the same group, and ties a vault that exists to that group. A test reads the placement from `poc.bicep`, `PocKeys.ps1` and `Remove-Poc.ps1` |

Mutations caught: 6 of 6, three on the document and three on the code it is compared with.

Commits: `e99f007` (documents and tests), `1f19780` (round 1), `aff43f9` (round 2), `2ef8c84`
(U34), `726826b` (round 3), `60a3713` (round 4). Proved by `node --test
tests/poc-products-keyvault*.test.mjs` (91 of 91) and `node .ironclad/gate.mjs --stage packet`
(exit 0). Not proved: the steps were not run in the Azure portal (U31, ASSUMED).

### P38 — setup and usage guide — DONE (branch only)

`poc/products-keyvault/SETUP.md` covers requirements, deployment, the runner, issuing, handing
over, rotating, expiring, suspending and listing keys, monitoring, six clients and removal. Its
client snippets are files in `examples/`, and `Test-PocClients.ps1` runs each one, plus the
probe and a wrong-key control, against the live gateway: 11 of 11 on 2026-10-12. Tests check
that the guide's copies equal the files, that its curl lines send what the harness sends, and
that every key action and runner step it names exists.

New operator actions, test-first: `List`, `Suspend`, `Resume` (no vault needed), `Grant` and
`Revoke` (Key Vault Secrets User on one secret, by object id, through Azure Resource Manager),
and `-Step Key` on the runner. The one-time copies of a key stay `az` commands, because the
scripts print no key (acceptance amended in the roadmap).

Measured on 2026-10-12: U29 (the DeepSeek deployment's per-minute limit did not count
`max_tokens`; one opencode prompt is 64.5 KB; a capacity change took 8.5 minutes), U30 (an
identity with the role on one secret read it 48 s after the grant and got `Forbidden` for
another secret and for the list), and the U17 update (Claude Code 2.1.272 with
`ANTHROPIC_API_KEY` needs `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`). The runner VM was found
deallocated; it was started for the U30 and runner checks and deallocated again.

**Council — P38, round 1.** Architect and Coder: PASS-WITH-NOTES. QA, UX and Security: BLOCK.

| Finding | Fix |
|---|---|
| **BLOCK Q1.** The test that every example is run matched names anywhere in the harness; its header comment alone passed it | Checks are one table run by one loop; `-Plan` prints that loop's checks without calling Azure, and the test compares them with `examples/` (`a53a911`) |
| **BLOCK Q2.** Handover and removal, both named in the guide, had no script action or test | `Grant` with tests (`f0bd139`); `Remove-Poc.ps1` tested offline with Azure stubbed (`fd3e933`); the one-time copies recorded as `az` commands by design |
| **BLOCK U1.** With the vault private, the guide had no way to hand a key over | `Grant` needs no path to the vault; a one-time copy from API Management `listSecrets`, run live (`f0bd139`) |
| **BLOCK S1.** The work folder defaulted to `/tmp/poc-clients` on Linux, where another user could plant code that runs with a key | Per-user `LocalApplicationData` folder, with a test (`a53a911`) |
| A control passed on any failure; OpenAI checks accepted any output; `CLAUDE_CODE_USE_*` not cleared; skipped checks not counted (Q4) | 401 required (unit-tested); `OK` required; cleared and restored; a skip fails the run |
| `-Step Key` exited 0 when the action failed on the VM (C2) | Exit status printed last and checked; live: a failing action exits 1 (`fd3e933`) |
| Restore loop untested (Q3); `-KeyExpiresOn` untested (Q5); vault-free Suspend and Resume untested (Q6) | Tests for each |
| Guide: curl paths (U3), probe before a key exists (U4), Graph lookup (U5), `displayName` (U6), credential precedence and config folder (U7), key in shell history (S2), query-parameter key (U2) | Corrected; P42 filed for the query parameter (S3) |
| P39 and the U17 update concern `main` but live on this branch (A1) | Kept here; carried to `main` when the branch is merged or abandoned (owner's decision) |
| WIP over budget (A3) | Committed in five focused commits |
| venv errors and the Store `python3` alias on Windows (C1) | venv exit code checked, `py -3` on Windows, imports verified (`a53a911`) |
| A role on one secret was unmeasured and unlogged (A2) | Measured as U30 (`f0bd139`) |

Mutations caught: 13 of 13 on the harness tests (including the council's own), 8 of 8 on `Grant`,
13 of 13 on removal, runner and key-step tests.

**Council — P38, round 2.** Coder: PASS. Architect, QA, UX and Security: PASS-WITH-NOTES. All
round-1 BLOCKs confirmed fixed; no new BLOCK.

| Finding | Fix |
|---|---|
| The POC test file was 858 lines against the 800-line budget (R2-A1) | Split by responsibility into three suites and a helper module, no test changed (`8093970`) |
| The roadmap amendment overstated test coverage; `SetExpiry` had no offline test (R2-A2) | `SetExpiry` test added; amendment names what is tested offline and what only live |
| STATUS table lacked C1 and A2 (R2-A3) | Rows added above |
| The restore test also matched the `finally` inside `Invoke-PocClaudeCode` (R2-Q1) | Anchored to the script's own `try`/`finally` at column 0; the council's move-the-loop mutation now fails it |
| "First four" in the credential order; a wrong splatting reason; the harness's tools not listed; no source for `<object-id>` (R2-U1 to U4) | Corrected; the splatting claim was checked on PowerShell 7 |
| `Grant`'s role assignments outlived removal, and there was no way to undo one (R2-S1) | `Revoke` action with tests; `Remove-Poc.ps1` deletes the grants on the vault's key secrets before the vault. Live: `az role assignment list --all` found a grant, `Revoke` deleted it, a second `Revoke` reported none |

Mutations caught: 12 of 12 on the round-2 tests (one survivor at first, closed by adding a
vault-scope assignment to the test data).

**Council — P38, round 3.** Architect, QA and UX: PASS. Security: PASS-WITH-NOTES. Coder: BLOCK,
cleared.

| Finding | Fix |
|---|---|
| **BLOCK R3-C1.** When the grant cleanup failed, `Remove-Poc.ps1` deleted the vault anyway, and a re-run found no vault, skipped the grants and exited 0. The subscription-wide `az role assignment list --all` also needs read rights on the whole subscription | Role assignments on key secrets are listed at the resource group (`Get-PocKeyGrants`): measured to include assignments on single secrets, and it works after the vault is gone. While one cannot be listed or removed, the vault is kept and the run exits 1. The script now ends with an explicit `exit 0`, which a new test showed was missing (the last `az` call's code 3 leaked). Live: the listing found a temporary grant on a secret |

Mutations caught: 7 of 7 on the R3-C1 tests.

**Council — P38, round 4.** Coder: PASS-WITH-NOTES, R3-C1 cleared. Security: PASS. Architect, QA
and UX: PASS.

| Finding | Fix |
|---|---|
| Every failure of `az keyvault show` was read as "the vault is not there"; with the new `exit 0` an authorisation or network error gave a clean exit (R4-C1) | The suggested rule (only exit code 3 means "not there") was measured first and does not hold: `az keyvault show` exits 1 for a missing vault, `az vm show` and `az apim show` exit 3. The vault is now read through Resource Manager (`Get-PocResource`: 404 means not there, any other error fails the run and keeps the vault); the runner VM's lookup treats only exit 3 as not there; the instance id comes from the context instead of a lookup. Live: the real vault read as there, a missing name as 404 |

Mutations caught: 6 of 6 on the R4-C1 tests.

**Done.** Gate (`node .ironclad/gate.mjs --stage packet`): PASS, 22 checks, one warning that
predates this branch (`src/diagnose.mjs`). 63 offline tests in the three
`tests/poc-products-keyvault*.test.mjs` suites. Commits: `338b57f`, `3c334e2`, `b91443d`, `a53a911`,
`f0bd139`, `fd3e933`, `8093970`, `59a7482`, `e1c252e` and the commit that records this.

### P37 — products and Key Vault on Standard v2 — DONE (branch only)

Work lives in `poc/products-keyvault/` and runs against the Standard v2 test instance in
`rg-hackgw-pe-test` (Foundry reachable only through a private endpoint, UNKNOWNS U23). Every
resource it creates is named `poc-`; the instance's `deepseek-gateway` and `claude-gateway`
APIs are not changed.

Final run `10111658` passed 22 of 22 checks (results table in the POC README). The four runs
before it changed the method, not the design:

- **Expiry.** API Management refuses an expiry already past and keeps only the date, so the
  test lets a stored date pass instead of setting one in the past. A suspended key has to be
  reactivated before it can be renewed.
- **One check is not enough.** The gateway's nodes learn about a key change at different times,
  so every time is "five checks in a row".
- **U28.** The remaining-budget header lags. U28 is decided by whether a spent key, once
  rotated, is still refused for quota, not by comparing header values.

The vault's public network access was turned off by an identity outside this project about ten
minutes after it was created. That was left in place: `runner.bicep` adds a private endpoint and
a VM inside the virtual network, and the measurements ran there.

**Council — P37.** Architect, Coder, UX and Security: PASS-WITH-NOTES. QA: BLOCK, cleared. Both
BLOCK fixes have tests that were red first. Seven mutants across the tested fixes (timing,
session check, token expiry, vault default, name validation) were all caught. The `Test-Poc.ps1`
changes are checked by run `10111658`. `Remove-Poc.ps1` is parsed but has not been run yet.

| Finding | Fix |
|---|---|
| **BLOCK.** Times were taken from the wrong moment: a new key's after four more keys were issued (2.2 s reported), the session key's refusal from the end of the rotations | `Measure-PocUntil` in `PocMeasure.ps1` times from a given moment, before each request; re-run: 6.4 s for a new key |
| **BLOCK.** U27 passed on a count of helper reads, which a session holding a never-refused key would also pass | the helper logs the secret version per read; `Test-PocSessionRefresh` requires the first read to return the old version and a later read, after the refusal, the new one; the rotations start after the session's first read |
| A refusal counted as any status other than 200 | 401 required |
| One probe decided that an expiry is not enforced | 60 s of five-in-a-row checks |
| Tokens reused for 30 minutes regardless of expiry | reused until five minutes before `expires_on` |
| The template set the vault's public access to Enabled, so a redeploy would reopen it | `vaultPublicNetworkAccess` defaults to Disabled, firewall default Deny |
| Names reached the runner's root shell unquoted | validated before any Azure call, and quoted |
| `Remove-Poc.ps1` reported removals without checking them, and deleted the resource group's privatelink zone unconditionally | every step checked, exit 1 if anything is left; the zone goes only when empty |
| Docs: "no inbound path", and the runner identity's reach | stated as measured: nothing from the internet; port 22 inside the network with no login; Run Command on the VM acts as its identity, so the runner is removed after a run |

Offline: 27 tests in `tests/poc-products-keyvault.test.mjs`, written first. Mutations caught:
6 of 6 on the policies and key scripts, 2 of 2 on the runner template, 7 of 7 on the council
fixes.

### P32–P34 — handouts and the key list — DONE (`119d94b`, `222c109`, `b31ec20` + council fixes)

Three operator requests, each test-first against the real `Keys.ps1` / `Apim.ps1` with `az`
stubbed (`tests/key-issuance.test.mjs`, 18 tests):

- **P32 — custom domain.** Issuance asks once for the hostname in participants' base URLs and
  defaults to the instance's custom gateway domain. No instance in the subscription has one, so
  this is tested against a stubbed `az apim show`, not live.
- **P33 — archive.** Option 7 moves keys more than ten minutes past expiry to
  `issued-keys-archive.json`. Ten minutes because the gateway allows 60 s of clock skew on `exp`
  and archived keys leave the denylist Revoke-Key pushes. Archived ids still count for id reuse:
  the budget counters are keyed on `sub` (`policy.xml` counter keys). Checked against a copy of
  this machine's real key records: both expired keys archived.
- **P34 — bulk CSV.** `keys.csv` per batch, owner-only, every key verified against the signing
  secret in the test, formula-safe names. The handout files holding a key are now owner-only
  too — they were not, on macOS and Linux. Reverses a recorded choice:
  [ADR-0012](adr/0012-bulk-keys-in-one-csv.md).

**Council — P32–P34.** Architect, QA, UX and Security: PASS-WITH-NOTES. Coder: BLOCK, cleared.

| Note | Fix |
|---|---|
| **BLOCK.** An archive that could not be read was treated as empty, and the next option 7 overwrote it with the newly expired keys. Every archived id was lost, and a reused id would then share that key's spend with no warning | Archiving stops with a warning when the archive exists but cannot be read, and the file is left unchanged. Tested with a truncated file, a missing comma and an empty file |
| When `az apim show` failed (signed out, no access), issuance fell back to `*.azure-api.net` with no message | Same fallback, with a warning naming the instance |
| A wildcard gateway hostname (`*.contoso.com`) could become the default base URL | Wildcard hostnames are not offered |
| A pasted URL's port was dropped with no message | A warning names the port |
| Nothing tested that `Write-ProtectedFile` restricts a file before writing to it, or that it tightens a file that already exists | One test checks the call order in the function's syntax tree; another loosens an existing file first and checks it ends owner-only (no other access rules on Windows, mode 600 elsewhere) |

Each fix was mutation-checked: six mutants, one per fix, each applied to an otherwise unchanged
tree. All six still parsed, and each failed its own test on the intended assertion; the
unmutated control passed. Writing the archive test showed that `ConvertFrom-Json` accepts a
trailing comma (`[{…},]` reads as one record), so such an archive is readable and is kept; the
test uses inputs PowerShell rejects.

Reviewer finding outside these packets, filed as P35: names read from a participants file go into
the handout path unchanged (`Keys.ps1:287-291`, `:499`, both from `0177eb3`), so a line such as
`../x` writes a handout outside the batch folder. Found while fixing the BLOCK and filed as P36:
an unreadable `issued-keys.json` is also read as empty, and issuing a key writes over it; the
next revocation then drops earlier revocations from the denylist. Both predate this batch.

### P31 — Foundry behind a private endpoint — DONE (verified, documentation only)

Asked whether the gateway works when Foundry is reachable only through a private endpoint. It
does on Standard v2 or Premium v2 with outbound VNet integration, and not on Basic v2, which has
no outbound virtual network option. Measured end to end in an isolated resource group with the
real option 1 and option 11: 17/17 and 23/23 with the Foundry account's public access disabled.
Turning the instance's VNet integration off reproduced the Basic v2 failure (`403 Public access is
disabled`) on both routes; turning it back on recovered in about 85 seconds. Evidence and steps in
UNKNOWNS U23; requirements in the README.

No code changed: an adopted instance's networking is not touched by the deployment, so option 1
already works once the instance is integrated. The guide is `docs/PRIVATE-ENDPOINT.md`; the
template the test deployed is `infra/examples/private-foundry-test.bicep`, unchanged.

M1, M2, M3 and M5 are complete. M5 (P15–P19) added: adopt an APIM an organisation already runs,
pick from the models actually deployed in the subscription, serve Claude models to Claude Code,
and prove it live.

### P29 — a route with nothing pinned deploys — DONE

Reported 2026-10-05: with three Claude models pinned and nothing on the OpenAI route, option 1
failed with *"NamedValue Value should be between 1 and 4096 characters long"*. The deployment's
operations list shows exactly one failure out of 21: `namedValues/hackgw-model-map`, the OpenAI
route's map, sent as an empty string.

The Claude map already wrote `;` (EMPTY_MAP) when empty. The OpenAI map never needed to: until
P25 every install defaulted to DeepSeek pins, and until P28 pinning only Claude models was the
unusual case. Both changes made it the normal case.

What the failure left behind, read back from the instance: `claude-gateway` was created at
`/claude-hackgw` with **no policy**, because the policies depend on the named value that failed.
An unauthenticated call to it returns 401 from Foundry (nothing adds credentials), so it is not an
open route, but it is ungoverned until a deployment that publishes the Claude route succeeds.
Declining the alternative path is not that: ARM deploys incrementally and leaves the API in place.

| | Fix |
|---|---|
| Empty map sent to APIM | `Get-ModelMapValue` writes `;` for a route with nothing pinned; deployment and live push both use it |
| Template accepted an empty map | `infra/main.bicep` writes `;` when either map is empty; `modelMap` defaults to `;`, not two DeepSeek deployments |
| Plan said a Claude route with no pins "is not published" | It is published, with `;`. The plan says so, and that the route answers `model_not_configured` until a model is pinned |
| Plan blurred "not publishing" with "no pins" | The decision not to publish is passed to the plan as itself |

`New-DeploymentParameters` was moved out of `Invoke-Deploy` unchanged first, so the failing value
could be tested: with the operator's three Claude pins, the test was RED with the map empty,
before the fix. APIM accepting `;` was an untested assumption until now; a live probe confirmed it
(UNKNOWNS U22). Rendered against the operator's instance, the plan now reads *"OpenAI route UPDATE
… Nothing is pinned on this route, so it answers model_not_configured"*, and the suggested Claude
path stays `/claude-hackgw` (the operator's own API is not counted as a collision), so the next
run updates it in place.

**Council — P29.** Coder and Security: PASS. Architect and QA: PASS-WITH-NOTES, both closed:

- Declining the alternative Claude path made the plan say "not published" while ARM's
  incremental mode left an existing `claude-gateway` live. The plan now says it is left in place,
  including its policy.
- Nothing tested that `Invoke-Deploy` uses `New-DeploymentParameters`, so an inline parameter
  table coming back would have reintroduced the bug with every test green. An AST test now
  requires exactly one call and no other parameter table; removing the call turns it red. Two
  "non-empty" checks on values the test itself supplied were removed as unfalsifiable.

Reviewer finding outside this packet, filed as P30: the revoked-key list is one named value, so
APIM's 4,096-character limit is reached at the 216th revocation.

### P27 — `Protect-File` can be applied more than once — DONE (`c9ee7bf`, `73d4c7e`, `1383425`)

An operator ran option 1 and it stopped with *"The process does not possess the
'SeSecurityPrivilege' privilege which is required for this operation"* at `Platform.ps1:37`.

This was a defect introduced by P26, in the step most likely to run. P26 made `Get-SigningSecret`
re-apply `Protect-File` on every read. On Windows, for a user who is not elevated, `Set-Acl`
succeeds on a file the first time and fails every time after, so the second read of the secret
failed. Option 1 reads it right after pinning. The cause is a comparison in `Set-Acl`'s own retry
path, documented with sources in UNKNOWNS U21. Every test called `Protect-File` once per file,
so the suite was green.

The fix writes the DACL through .NET, which persists only the sections that changed. A new test
applies it three times to one file; it was RED with the operator's exact message. The real
`Get-SigningSecret` read the real, already-protected secret three times afterwards; the owner was
unchanged and one access rule remained.

**Council — P27.** Coder, QA and Security: PASS-WITH-NOTES. Three notes, all fixed with a test
that was RED first:

| Note | Fix |
|---|---|
| A checkout on a network share failed: `.Path` keeps PowerShell's own path form | `.ProviderPath`; tested through a PowerShell drive on all three platforms |
| The local `Stop` did not stop a `Continue` caller; an advanced function's .NET error is statement-terminating | try/catch that rethrows with `throw` |
| The regression test could not fail in CI: the Windows runner is elevated | the test removes the admin-only file privileges from its own token |

The third note's suggested fix was not enough, and only running it showed that. A throwaway
branch with `Set-Acl` put back stayed green on `windows-latest` with `SeSecurityPrivilege`
removed: `Set-Acl` enables `SeRestorePrivilege` before writing, and the runner holds that too.
Removing all four admin-only file privileges made the same mutant fail there with the operator's
message ([run 37218967361](https://github.com/naveenneog/foundry-hackathon-gateway/actions/runs/37218967361)).
The branch was deleted. The cleanup step also moved into an `after()` hook, because a run filtered
by test name skipped it and left files behind.

### P28 — options 2 and 3 list only the chosen account's models — DONE (`e959874` + council fixes)

The same run listed 54 deployments from four Foundry accounts in the pin picker, after the
operator had chosen one account. The gateway reaches one account, so 25 of them could not work.
P16 chose the subscription-wide list; [ADR-0011](adr/0011-pin-from-the-gateways-account.md)
reverses it. Writing the tests found two more consequences: option 2 marked a pin `ok` if its
deployment existed in any account, and option 3 with no account chosen pinned against an empty
account name.

`tests/model-picker.test.mjs` drives the real `Models.ps1` functions with `az` stubbed, so it
tests the shipping code. Five tests, all RED before the change. Read-only against the live
subscription: the picker listed exactly the 29 deployments of `ai-contosohub530569751908`.

**Council — P28.** Architect: PASS. Coder, QA, UX: PASS-WITH-NOTES. The main note: scoping made
the account's resource group matter, and nothing kept it right. With the wrong group, `account
show` fails and the account looked empty ("No model deployments were found"). Option 1 offered no
way out, because its resource-group prompt defaulted to the previous account's group.

| Note | Fix |
|---|---|
| Wrong resource group reads as "no deployments" | options 2 and 3 look the account up by name and use the group it is in |
| Option 1 recorded name/group pairs that do not exist | `Read-FoundryAccount` takes the group from the account; offers the list again if the recorded account is gone |
| An account not in the subscription read as empty | reported as not found |
| An account chosen in option 3 was kept only in memory | saved when chosen, so option 4 can use it |
| An empty name in option 1 carried on as `''` | stops |
| Pins from another account were not marked in option 3 | marked `MISSING in <account>` |
| The stub ignored `-g`, returned `[null]` for no deployments, and shared one state object | stub checks the group, returns `[]`, state round-trips through JSON |

Twelve tests now, seven of them RED before the fixes. Read-only against the live subscription with
a deliberately wrong resource group: *"'ai-contosohub530569751908' is in resource group
'rg-contosohub' … Using 'rg-contosohub'"*, then all 29 deployments.

## Live deployment (verified 2026-10-04)

| | |
|---|---|
| Subscription | `MCAPS-Hybrid-REQ-67471-2023-navg` |
| Resource group | `rg-hackathon-gateway` (eastus2) |
| API Management | `apim-hackgwfl4s7jvpxekno` (BasicV2, adopted rather than recreated) |
| Foundry account | `ai-contosohub530569751908` (`rg-contosohub`, eastus2) |
| OpenAI route | `https://apim-hackgwfl4s7jvpxekno.azure-api.net/v1` |
| Claude route | `https://apim-hackgwfl4s7jvpxekno.azure-api.net/claude` |
| Claude backend | `https://ai-contosohub530569751908.services.ai.azure.com/anthropic` |
| `flash` / `pro` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `sonnet-5` / `opus-5` | `claude-sonnet-5` / `claude-opus-5` |

### P26 — macOS and Linux run the same console — DONE (`7557aaf`, `5bf3c45`, `6bcb87e`)

The request was "an equivalent script for Mac and Linux, tested in CI". An audit of all six
`.ps1` files found exactly two Windows-only blocks, both the same ACL call: no `cmd /c`, no
backslash path building, no registry, no COM. PowerShell 7 is cross-platform and already required
by ADR-0006, so a bash twin would be a 2,400-line transcription of working code — and this repo
has already paid for transcription drift twice, most recently in P25. ADR-0010 records the
decision to make the one implementation portable instead.

Writing the test found a real defect rather than confirming the code was fine. `New-SigningSecret`
restricted the secret with `Get-Acl`/`Set-Acl` and a `FileSystemAccessRule` — all Windows-only —
inside a `try`/`catch` that warned and continued. On Linux and macOS that `catch` fires every
time, so the file kept the default umask while appearing to be protected. The same applied to the
deployment parameters file, which holds the secret in cleartext until the `finally` removes it.

`Protect-File` (`scripts/Platform.ps1`) replaces both: ACLs on Windows, `chmod 600` elsewhere,
verified by reading the mode back, and it throws where the old code warned.

**Measured** on run
[37207259672](https://github.com/naveenneog/foundry-hackathon-gateway/actions/runs/37207259672):
364/364 on `ubuntu-latest`, `macos-latest` and `windows-latest`, with `ok 2 - the file is readable
only by its owner` present in the Linux log — the mode assertion executed rather than skipped.
UNKNOWNS U19 and U20 closed.

The first run also failed the launcher check, for a reason worth keeping: the step cleared `PATH`,
which meant `/usr/bin/env bash` could not be resolved and `admin.sh` never ran at all. It also
showed `admin.sh` used `dirname` — an external command — before reaching its own prerequisite
check, so with a broken `PATH` it would die before printing the guidance it exists to print. Both
fixed; the path is now resolved with bash parameter expansion, and the step resolves `bash`
before clearing `PATH`.

### Council — P26

Three BLOCKs, all on the same theme: the packet was green on paths nothing executed.

| Seat | Verdict | Finding |
|---|---|---|
| Architect | PASS-WITH-NOTES | the detector enforcing "cross-platform" covered 6 of 8 `.ps1` files |
| Coder | BLOCK | `"$@"` under `set -u` on bash 3.2; unprotected secret persisted; fail-open read-back |
| QA | BLOCK | the handover line had zero execution coverage on any platform |
| UX | PASS-WITH-NOTES | Debian-only guidance for every Linux; a throw exited the whole console |
| Security | BLOCK | the error path re-created U19, and the reuse path never re-protected |

The three that mattered most, because the suite was green over all of them:

1. **macOS ships bash 3.2**, where `set -u` treats `"$@"` as unset with no arguments — so
   `./admin.sh` with no arguments, the documented way to open the menu, would have died with
   `$@: unbound variable`. `macos-latest` was green because the only launcher check cleared
   `PATH` and exited long before the handover line. Fixed with `${1+"$@"}`, and CI now execs
   that line against a fake `pwsh` with zero arguments, with one argument, and under `/bin/bash`
   explicitly.
2. **A failed `Protect-File` left the secret on disk.** `Set-Content` ran first, so the file
   already existed with the default umask; the throw then aborted the run, and the next run's
   `Get-SigningSecret` reused it without re-checking and reported success. That is U19 again, on
   the error path this packet added. The file is now created empty, restricted, then written —
   no window at all — removed if the restriction fails, and re-asserted on every read.
3. **The mode read-back failed open.** `stat` exiting non-zero skipped the check and returned
   success, on exactly the mounts (exFAT, 9p, some SMB and NFS) where `chmod` also returns 0 for
   a world-readable file — so both halves failed together and silently. Unreadable or
   unparseable output is now a failure.

Also fixed: the Windows-only-API scan discovers `.ps1` files instead of listing them (it had
silently stopped covering `scripts/Preflight.ps1`); the menu catches per action rather than
exiting with a stack trace; the non-macOS install guidance points at the pages that branch by
distro rather than Debian-only commands; `admin.sh` follows symlinks, since putting a launcher on
`PATH` by symlink is the usual reason to have one.

Both new ordering assertions were negative-tested: writing before restricting, and dropping the
cleanup, each turn the test red.

**Verified** on run
[37208582696](https://github.com/naveenneog/foundry-hackathon-gateway/actions/runs/37208582696):
green on all four jobs. The macOS log reads
`/bin/bash (3.2.57(1)-release): HANDOVER ok args=3` — the handover line executing with zero
arguments under the exact bash that would have rejected it.

### P25 — deploy onto whatever is already there — DONE (`3eab12e`)

An operator ran option 1 against their own instance, `apim-claude-gw-fzgql9`, and the deployment
failed. ARM deployments are atomic, so it also left the instance half-built. Three separate
defects, all of them the same mistake — code that assumed an empty target:

| | What happened | Fix |
|---|---|---|
| Path collision | Another product already published an API at `/claude`, so `claude-gateway` could not be created there. The picker knew; the deploy did not. | `claudeApiPath` is a Bicep parameter; `suggestFreePath` offers `claude-hackgw` |
| Role grant | The account already had the role, from a different assignment name, so `guid()` determinism did not help. `RoleAssignmentExists`. | `grantFoundryRole` parameter, set from `Test-FoundryRoleNeeded` |
| Default pins | A new install started pinned to two DeepSeek deployments that need not exist. | Pins start empty; option 1 pins from the subscription |

The general fix is that option 1 now **reads the target before it writes to it** and prints what
it found:

```
    API Management   REUSE    apim-claude-gw-fzgql9 (BasicV2) is reused as-is.
    Foundry account  OK       ai-contosohub530569751908, 29 deployment(s).
    Model: sonnet-5  OK       claude-sonnet-5 (claude).
    Model: ghost     BLOCKED  'not-deployed-anywhere' is not deployed in ...
    OpenAI route     UPDATE   'deepseek-gateway' is already published; policy and operations are updated.
    Claude route     CREATE   'claude-gateway' will be added at /claude-hackgw.
    Named values     UPDATE   7 already present; values are refreshed.
    Foundry access   OK       Already granted; not re-granting.
```

That output is from the real failing instance. The 7 named values and the published
`deepseek-gateway` are what its half-applied deployment left behind; the plan reports them as
UPDATE rather than CREATE, which is the checkpoint behaviour asked for. A BLOCKED row stops the
deployment unless the operator confirms.

`buildDeploymentPlan` in `src/apim.mjs` holds the decision logic and is tested in isolation
(`tests/deployment-plan.test.mjs`, 23 tests). `Show-DeploymentPlan` gathers the facts and renders
the answer, reaching the decision through `scripts/plan.mjs` — the same stdin-JSON shim pattern
`mint.mjs` and `diagnose.mjs` already use.

Council found that the first cut of this did **not** work that way: the PowerShell carried its own
transcription of the rules, and the two copies drifted in the worst direction. On an instance that
was both on a classic tier *and* had `/claude` taken, the tested copy said BLOCKED and the shipping
copy said CREATE — it would have published a Claude route whose token cap meters nothing, which is
exactly what ADR-0009 exists to prevent. The blockers arrive in one array and the path workaround
masked the tier. Fixed in both the rule (a path collision is curable, a tier is not, so the tier is
judged first) and the structure (the transcription is deleted; there is one copy now).

### P22 — prove the three guarantees a key makes — DONE

Asked directly: does a key spend only its budget, only within its window, and stop on revocation?
Each measured against the live gateway rather than asserted from the policy.

**Budget — enforced, accuracy depends on streaming.** Same key shape, same prompt, 2,000-token
budget, 500 `max_tokens` per request:

| | Stopped after | Real tokens spent | `x-budget-used` |
|---|---|---|---|
| `stream: false` | 5th request | 2,080 (+4%) | 2,080 — exact |
| `stream: true` | 7th request | 3,120 (+56%) | 108 — wrong by 29× |

The cap fires on both. The header is the part that breaks: it is fed by the cache counter, while
the cap is enforced by APIM's own quota. This **corrects** yesterday's U15, which said streamed
completions were not metered at all — they are, by the quota, just not by the counter.

**Time window — enforced with nothing running.** `exp` and `nbf` are checked by `validate-jwt`
on every request; expired and not-yet-active keys both return 401, verified on both routes. The
gateway's clock decides, with 60 seconds of permitted skew.

**Revocation — under ten seconds, and only the key named.** Previously untested: the harness had
no revocation check at all, which is why this packet exists. It now mints a key, confirms 200,
adds its `jti` to the denylist, polls until refused, and confirms a second key is unaffected. It
refused on the first poll on the Claude route and the second on the OpenAI route, against a
five-second polling interval — so "under ten seconds", not "one second".

The check needs to edit a named value, so it runs only when `-ApimName` and `-ResourceGroup` are
supplied and reports **NOT CHECKED** otherwise. It restores the denylist in a `finally` block, so
an interrupted run cannot leave real keys un-revoked.

```
Test-Governance.ps1 -Route claude ... -ApimName ... -ResourceGroup ...
  [PASS] key works before revocation        -> 200
  [PASS] revoked key rejected               -> 403     revocation took effect in 1s
  [PASS] other keys unaffected by revocation -> 200
  24 passed, 0 failed
```

### P21 — a worked example: a Claude agent with tool calls — DONE

`examples/claude-agent.ipynb`, executed against the live gateway and committed with its output.
Forty lines of agent loop on the ordinary `anthropic` SDK: two parallel `get_order_status`
calls, a chained `calculate`, a correct final answer, and the gateway's budget headers.

The notebook reads the key from the environment and never writes it to a cell.
`tests/example-notebook.test.mjs` enforces that — negative-tested by injecting a JWT into a cell
output and confirming the failure — and pins the two mistakes the example exists to prevent:
`ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN`, and shortening the alias to a Claude Code
model slot.

### P19 — verify the Claude route live — DONE

```
Test-Governance.ps1 -Route claude   21 passed, 0 failed
Test-Governance.ps1 -Route openai   15 passed, 0 failed
```

A real Claude Code session (v2.1.272), configured only by the `.claude/settings.json` that
option 5 generates, created a file through tool calls and exited 0:

```
> Create hello.py with add(a,b)... then read it back and reply DONE.
DONE
hello.py  ->  def add(a, b):
                  return a + b
```

### What live testing changed, again

| Finding | Consequence |
|---|---|
| **`sonnet`, `opus` and `haiku` are Claude Code model slots.** With `ANTHROPIC_MODEL=sonnet` the client sent `claude-sonnet-5` instead, and the key was refused. | `suggestAlias` now keeps the version (`claude-sonnet-5` → `sonnet-5`), pinning refuses a reserved alias, and the card says why. Nothing static could have caught this. |
| **A machine with Claude Code already configured overrides the participant's variables.** A `settings.json` carrying `model`, `ANTHROPIC_DEFAULT_*_MODEL` or `CLAUDE_CODE_USE_FOUNDRY` wins over the env, and requests go to the old destination. | Documented in the card with the fix (`claude --settings`, or merge and remove the conflicting keys). |
| **Streamed completions are not metered on the Claude route.** 419 tokens counted non-streamed; 16 for the same request streamed. Claude Code always streams. | Recorded as UNKNOWNS U15 with its bound, and in the README's known limits. The cap is not a billing control on this route. |
| The gateway's configured Foundry account held no deployments at all | The OpenAI route had been returning 404 on every call. Repointing it at the account that actually has the models fixed it. |

### Council — P19

| Seat | Verdict |
|---|---|
| Architect | PASS — one Foundry account serves both routes, so no second account or role grant was needed. |
| Coder | PASS-WITH-NOTES — the reserved-alias fix is in `src/foundry.mjs` with the PowerShell transcribing it, and a parity test pins the list on both sides. |
| QA | PASS — both routes verified against the live gateway, then re-verified after the alias change. The end-to-end run used the generated handout verbatim rather than hand-written settings. |
| UX | PASS — the three failures a participant can hit (wrong variable, slot-name alias, pre-existing config) are each named in the card with the fix. |
| Security | PASS — no participant credential reaches Foundry; the managed-identity audience is confirmed correct by a 200. |

---

### P18 — Claude Code setup and verification harness — DONE

| Criterion | Evidence |
|---|---|
| The harness covers the Claude route | `scripts/Test-Governance.ps1 -Route claude`; option 11 runs it per route that has pins |
| The participant setup is documented exactly | README and the generated card name `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` |
| A key is usable in Claude Code | option 5 writes `.claude/settings.json` with the env block; verified by generating handouts for all three grant combinations |

### P18 council

| Seat | Verdict |
|---|---|
| Architect | PASS — one harness parameterised by route rather than a second copy; the request shape, headers and tool schema are the only route-specific parts. |
| Coder | BLOCK, cleared — 3 findings. With only one model pinned on a route, the allowlist test asked for a model the key *did* grant and would have reported a working control as broken. A key granting only Claude models, issued before the Claude route was published, printed its token nowhere and wrote it nowhere — the key was minted and lost. The "unpinned model" test used `gpt-4o`, which an operator could legitimately have pinned under that alias. |
| QA | PASS — the handout generator was run for all three grant combinations and the lost-token case reproduced before the fix and confirmed after. The ghost alias is now generated so it cannot collide. |
| UX | PASS — the card leads with the two mistakes that produce a bare 401 and a 403: the wrong credential variable, and a missing `ANTHROPIC_MODEL`. |
| Security | PASS — `handouts/` is gitignored, which covers the new `.claude/settings.json`. The token is printed once, as before. |

### P17 — Claude route, the Anthropic Messages API — DONE

| Criterion | Evidence |
|---|---|
| `POST {gateway}/claude/v1/messages` reaches a Claude deployment | `infra/main.bicep` `claudeApi`, backend `endpoints['AI Foundry API'] + anthropic` |
| The same key controls apply | `infra/policy-claude.xml` steps 1–9, same claims and counters as the OpenAI route |
| Every rejection is Anthropic-shaped | `src/anthropic.mjs`, 29 tests; `tests/claude-route.test.mjs` asserts every error body in the policy |
| One budget across both routes | both policies write the cache key `used-<sub>` with identical semantics |

**Live verification is P18.** Everything here is proven statically and by unit test; no request
has been made against a deployed Claude route.

### P17 council

| Seat | Verdict |
|---|---|
| Architect | PASS — a separate API with its own policy rather than another operation, because the endpoint, the wire format and the error shape all differ. The alias map is per-route for the same reason. |
| Coder | BLOCK, cleared — 3 defects. `set-body` is not legal in `on-error`, which would have failed the deployment outright. The body clamp ran for `count_tokens`, injecting a field that endpoint rejects, making every token count a 400. The quota rewrite sat in `<outbound>`, which a policy error never reaches. |
| QA | PASS — a comment containing `--` (illegal in XML, rejected by APIM) was found by validating the policy as XML, and is now a negative-tested detector. The `on-error` and `count_tokens` fixes each have their own assertion. |
| UX | PASS — the rejection for a missing `ANTHROPIC_MODEL` names the variable, because Claude Code otherwise sends its own default model id and the allowlist refuses it with no clue why. |
| Security | PASS — the participant token never reaches Foundry; both `api-key` and `x-api-key` are stripped. `context.LastError.Message` carries pipeline diagnostics, not named values. |

### P16 — choose from the models deployed across the subscription — DONE

| Criterion | Evidence |
|---|---|
| Lists every Foundry account's deployments | `Get-FoundryCatalogue`; logic in `src/foundry.mjs`, 36 tests |
| Shows the wire format each model speaks | `wireFormatOf` / `Get-WireFormat`, pinned by a parity test |
| Refuses a pin that crosses routes | `canPin` / `Test-CanPin` |

One map per route: `hackgw-model-map` and `hackgw-claude-model-map`. A route with no pins is
written as a lone `;`, never an empty string, so removing a route's last pin still lands.

### P16 council

| Seat | Verdict |
|---|---|
| Architect | PASS — the wire format is a property of the deployment, so the route is derived rather than chosen. A model can only be pinned where it can actually be served. |
| Coder | BLOCK, cleared — 2 findings. Splitting the map by route broke key diagnosis: it read only the OpenAI map, so a valid Claude alias was reported `model_not_configured`. Reproduced and fixed with `mergeModelMaps`. Dead code (`Get-FoundryDeployments`, zero callers) removed. |
| QA | PASS — the format-parity detector was negative-tested by removing a format from the script. The diagnosis regression was proved by running a real minted key through `diagnoseKey` before and after. |
| UX | PASS — deployments are grouped by account, and one in a different account than the gateway's warns before pinning, because the gateway can only reach its own account. Claude models are named in option 4 as portal-only rather than being silently absent. |
| Security | PASS — discovery is read-only. No new credential path; the alias map still carries no secret. |

### P15 — attach to an existing API Management instance — DONE

| Criterion | Evidence |
|---|---|
| Instances listed with a verdict | `Select-ApimInstance` in `scripts/Apim.ps1`; logic in `src/apim.mjs`, 53 tests |
| Adds to the chosen instance, creates no second one | `infra/main.bicep` `apimNew` is `if (empty(existingApimName))`; compiled with `az bicep build` |
| Classic tier refused for the Claude route | `classifyApim` blocker `classic_tier`; UNKNOWNS U12 |
| A pre-existing role assignment does not fail the deployment | `needsRoleAssignment` / `Test-FoundryRoleNeeded` |

Not in the original criteria, found during the packet and fixed: named values and the logger are
namespaced `hackgw-` so nothing collides on a shared instance, and an API path already in use is
a blocker rather than a deploy-time failure.

### P15 council

| Seat | Verdict |
|---|---|
| Architect | PASS-WITH-NOTES — two declarations (`apimNew` + `existing`) is the supported shape. The adopted instance must share the deployment's resource group; recorded in ADR-0008 rather than worked around. |
| Coder | BLOCK, cleared — 8 findings, all fixed. The critical one: `module foundryRole` lost its ARM dependency when `apim` became an `existing` reference, so every fresh deployment would resolve `identity.principalId` against an instance that did not exist yet. |
| QA | PASS — the test that should have caught that bug matched `dependsOn` anywhere in the file; it now checks every direct child. Three detectors were negative-tested: the namespace check, the transcription-parity check, and `unknowns.open`. |
| UX | PASS — every instance is listed including unusable ones, each with the reason and whether deploying would add or update. The resource group is shown rather than prompted when an instance is adopted, because a free-text answer there fails as `ResourceNotFound` on the APIM name. |
| Security | PASS — namespacing removes the cross-API overwrite. The signing secret still never appears in argv. Enabling a missing managed identity is left to the operator: `az apim update` sets identity to `None` unless `--enable-managed-identity true` is passed, so doing it automatically could strip an identity other APIs depend on. |

### Detector repaired

`unknowns.open` reads markdown **table rows** containing `OPEN`. `docs/UNKNOWNS.md` was prose, so
the check had never been able to see anything in this repository and passed while measuring
nothing. The register now has a status table, and the check was negative-tested by marking U9
`OPEN` and confirming the warning.


## Earlier live deployment (2026-08-31, superseded)

The gateway was first verified against `foundry-plus-resource`. By 2026-10-04 its configured
account was `aif-gfsrxqjqqzije`, which held **no deployments at all**, so the OpenAI route had
been returning 404 on every call. P19 repointed it at `ai-contosohub530569751908`, which holds
both the DeepSeek and the Claude models, and both routes now pass.

## Packets

| Packet | State | Evidence |
|---|---|---|
| P1 scaffold + charter | done | gate passes |
| P2 key lifecycle | done | `src/keys.mjs`, 33 tests |
| P3 entitlement engine | done | `src/entitlement.mjs`, 37 tests |
| P4 policy | done | `infra/policy.xml`, deployed and serving |
| P5 infrastructure | done | deployed; APIM BasicV2 + App Insights + Log Analytics |
| P6 interactive admin | done | `admin.ps1` |
| P7 model deployment | done | both DeepSeek models deployed via CLI |
| P8 **opencode verified** | **done** | real agent session, Write + Read tool calls |
| P9 **control verification** | **done** | 15/15 controls pass live |
| P10 documentation | done | README, 5 ADRs, unknowns register |
| P15 adopt an existing APIM | done | `src/apim.mjs`, `scripts/Apim.ps1`, ADR-0008 |
| P16 subscription-wide models | done | `src/foundry.mjs`, route-aware pinning |
| P17 Claude route | done | `infra/policy-claude.xml`, ADR-0009 |
| P18 Claude Code handout + harness | done | `.claude/settings.json`, `-Route claude` |
| P19 **live verification** | **done** | 21/21 claude, 15/15 openai, real Claude Code session |
| P21 worked example | done | `examples/claude-agent.ipynb`, executed against the live gateway |

## Commands that prove it

```powershell
npm test                                   # 328 passing
node .ironclad/gate.mjs --stage packet     # PASS
./admin.ps1                                # 11  Verify the controls (runs both routes)
```

## Live verification output

```
[PASS] valid key is served                -> 200
[PASS] missing key rejected               -> 401
[PASS] forged signature rejected          -> 401
[PASS] expired key rejected               -> 401
[PASS] not-yet-active key rejected        -> 401
[PASS] model allowlist enforced           -> 403
[PASS] unpinned model rejected            -> 403
[PASS] tool calls accepted on pro         -> 200
[PASS] tool calls accepted on flash       -> 200
[PASS] one-time budget exhausts (403)     -> 403
[PASS] exhausted budget is not retryable  -> True
[PASS] exhausted budget sets no Retry-After -> True
[PASS] exhausted budget reports 0 remaining -> True
[PASS] exhausted budget body says so      -> True
[PASS] budget headers returned            -> True

15 passed, 0 failed
```

opencode, through the gateway, on `flash`:

```
> build · flash
I'll create the hello.py file with the add function.
← Write hello.py
Wrote file successfully.
→ Read hello.py
Created and confirmed `hello.py` with `add(a, b)` that returns `a + b`.
```

Budget accounting across that session: **29,157 / 500,000 tokens**, tracked continuously via
`x-budget-used`.

## Acceptance criteria — all met

- [x] G1 model allowlist — 403 on an unlisted model, verified live
- [x] G2 one-step key issuance — `admin.ps1` option 4
- [x] G3 time-bound — expired and not-yet-active both rejected live
- [x] G4 spend-bound — one-time budget exhausts with 403, verified live
- [x] G5 attribution — `x-budget-used` per key; metrics to App Insights
- [x] G6 **opencode verified end to end** — real agentic session with tool calls
- [x] G7 no credential leaves Azure — managed identity only

## What live testing changed

| Finding | Consequence |
|---|---|
| `DeepSeek-V4-Pro` **does** support tool calling, contradicting Microsoft Learn | Removed the hard 400 guard rail before it shipped. ADR-0003 rewritten. |
| `token-quota="@(context.Variables[...])"` failed APIM validation | Explicit `(long)` cast. Caught only by deploying — no static check finds it. |
| Exact catalog names and versions | `DeepSeek-V4-Flash-0731` / `2026-07-31`; `admin.ps1` had wrong casing and version `1`. Fixed. |

## Remaining work (M4, optional)

Only relevant if this outlives a single event — see `docs/ROADMAP.md` P11–P13.

## Teardown

```powershell
az group delete -n rg-hackathon-gateway --yes --no-wait
az apim deletedservice purge --service-name apim-hackgwfl4s7jvpxekno --location eastus2
# The DeepSeek deployments live in rg-contosohub and are left in place:
#   az cognitiveservices account deployment delete -n foundry-plus-resource -g rg-contosohub --deployment-name deepseek-v4-flash
#   az cognitiveservices account deployment delete -n foundry-plus-resource -g rg-contosohub --deployment-name deepseek-v4-pro
```
