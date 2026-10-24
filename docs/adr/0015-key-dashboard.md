# ADR-0015: Key Dashboard — hosting choice, single-IP access, usage, model choice, key lifecycle

- **Status:** Accepted. Since P60 (2026-10-24) the UI is called liteAPIM; technical names are
  unchanged (note at the end).
- **Date:** 2026-10-22
- **Packets:** P49–P54
- **Deciders:** owner's requirements of 2026-10-22; design by the coding agent

## Context

The owner's requirements for the Key Console (ADR-0013, ADR-0014) on 2026-10-22:

1. A dashboard web app and an automation app, each reachable from a single IP address.
2. Usage per key, with the key's name and an owner (a user) attached to it.
3. Use the existing API Management instance and Key Vault.
4. Hackathon keys kept apart from product keys, with usage shown for both.
5. On issue, the admin chooses one model or several models, explicitly, from the models
   deployed in Foundry. The scripts' multi-model pinning stays available.
6. Single and bulk issuance.
7. No limit on the number of keys. Expired keys move to an archive automatically. Lists show
   active keys. Archived keys can be deleted, and are deleted automatically after 30 days.
8. Usage graphs, with a light and a dark theme.
9. Hosting is chosen at install: App Service with a Function App, or Container Apps. Only the
   chosen path is deployed.
10. Minimal cost; key security first. Security testing and bug bashes on the live deployment.

Facts:
- App Service quota for this subscription in eastus2 is 0 for B1, S1, P0v3 and P1v3. Probed
  2026-10-22; each `az appservice plan create` returned "Operation cannot be completed without
  additional quota".
- The gateway already emits `llm-emit-token-metric` with a `KeyId` dimension on the hackathon
  routes. These arrive in the workspace as `AppMetrics` rows, with `Properties.KeyId`,
  `Properties.Model` and `Properties.Route` (queried 2026-10-22).
- The POC product routes emit no usage.

## Decisions

### Hosting: one parameter, two paths

`scripts/Deploy-Console.ps1 -Hosting AppService|ContainerApps` deploys one path. The
application code is the same in both.

| | `AppService` | `ContainerApps` (default) |
|---|---|---|
| Dashboard | Linux web app (B1), VNet integration in a delegated subnet | Container app; scales to zero |
| Automation | Function App (timer) on the **same plan**, so no second plan to pay for | Container Apps job (cron), same image |
| Sign-in | App Service authentication, Entra | Container Apps authentication, Entra |
| Single-IP access | Access restrictions on the app, the Function App and both `scm` sites; default deny | Ingress IP restrictions; default deny |
| Vault and APIM access | Over the VNet; managed identity | Over the VNet; managed identity |

The default is `ContainerApps` because it is the path that deploys in eastus2 today and costs
nothing while idle. The automation has no inbound endpoint on either path. The timer and the
cron job call the shared module `src/console/automation.mjs` directly.

### Single IP

`-AllowedIp` is required and must be one IPv4 address. It is applied as a `/32` allow rule,
and everything else is denied. Entra sign-in and the app roles still apply. The IP rule is an
added layer, not a replacement for sign-in.

### Usage

The source is the gateway's Application Insights workspace (`AppMetrics`), queried by the
dashboard's managed identity, which holds **Log Analytics Reader** on that workspace. There is
no extra store or roll-up job.
- **Hackathon keys** join on `Properties.KeyId = jti`.
- **Product keys:** the product policy gains `llm-emit-token-metric` with
  `KeyId = context.Subscription.Id`, `Model`, `Product`, and `Route = poc`. The two POC APIs gain
  an Application Insights diagnostic with `metrics: true`, on the existing logger
  `hackgw-appinsights`. Product keys then join on `KeyId = subscription id`.

Results are cached in memory for 60 s per query. A user sees usage only for keys they own.

### Model choice per key

The issue form asks for **one model** or **several models**. "Several" lists every pinned
model, each with its own checkbox, and none are ticked by default.
- **Hackathon keys:** the existing JWT `models` claim.
- **Product keys:** the console creates, or reuses, a product per model set and monthly
  budget. The product is named `pk-<12 hex of sha256(sorted models, monthly tokens)>`, carries
  the POC product policy template filled with those models, and is linked to both POC routes and
  the probe. Keys with the same models and budget share a product. The per-key budget is counted
  per subscription, so sharing a product does not share budgets.
- The legacy packs remain selectable for existing keys only.

The **Models** page lists the Foundry deployments in the gateway's Foundry account. It pins
and unpins aliases using `src/foundry.mjs` (`canPin`, `suggestAlias`) and `src/models.mjs`
(`buildModelMap`), the same canonical code that `scripts/Models.ps1` transcribes. A pin goes
to the route its wire format allows, and nowhere else.

### Lifecycle and archive

- **Active**, the default list: not expired, not archived.
- **Archived:**
  - A hackathon key whose expiry has passed, or a revoked one, is archived automatically.
  - A product key past its optional expiry date is suspended in APIM, then archived.
  - An admin can also archive any key by hand.
  - The archive is recorded as Key Vault tags `archived=true` and `archivedAt`.
- **Deleted:** an admin can delete an archived key, and the automation deletes archived keys
  30 days after `archivedAt`.
  - For a product key, the APIM subscription is deleted, then the vault secret.
  - For a hackathon key, the vault secret is deleted. Its `jti` is removed from the revocation
    list once it has expired, because expiry already refuses it. This keeps the 4096-character
    named value from filling up.
  - Vault deletion is soft, within the vault's retention period. Nothing is purged.
- **No count limit:** listing pages through Key Vault. Bulk issuance takes any number of rows;
  the browser sends them in batches of 50.

### Security

- Key values exist only in Key Vault and are shown on an explicit reveal. The browser never
  stores them. The reveal box clears itself after 60 seconds.
- Every state change still needs JSON plus a same-origin Origin header. The CSP still forbids
  inline script and inline style.
- Bulk issuance returns no key values. The admin gets the values through an export bundle
  (ADR-0013).
- The automation identity has exactly the dashboard's data-plane roles. It has no inbound
  endpoint.

## Consequences

+ One codebase, two hosting paths. The owner picks per install.
+ Usage costs nothing extra beyond the existing workspace ingestion.
+ The revocation list stays bounded with an unlimited number of keys.
− The App Service template passes `az bicep build`, but this subscription's zero eastus2 quota
  blocks ARM validate/what-if and live deployment. Its hosting path remains unverified here.
− Per-model-set products add APIM products over time. Unused ones (no subscriptions) are
  removed by the automation.
− `AppMetrics` arrive minutes after the call (ingestion latency), so usage is not real time.

## How we'd know this was wrong

- `llm-emit-token-metric` is refused at product scope (U41). Then the metric moves to the POC
  API policies, keyed by `context.Subscription.Id`.
- Usage queries are slow or throttled at the scale of thousands of keys. Then a daily roll-up
  table is added.
- A Function App on a B1 plan does not run timer triggers reliably. Then Always On is
  required, or the automation moves to a WebJob.

## Note: the UI is called liteAPIM (P60, 2026-10-24)

The owner renamed the UI "liteAPIM" on 2026-10-24. The app this ADR calls the Key Dashboard, and
ADR-0013 and ADR-0014 call the Key Console, is the same app; its header, page title, setup guide,
messages and guides now say liteAPIM, introduced in the guides as "liteAPIM (the admin key
dashboard)". The decisions above are unchanged.

The rename is display text only. These keep their names, because deployed keys, installs and
scripts depend on them: the `release/key-dashboard` branch; `src/console/`,
`scripts/Deploy-Console.ps1`, `scripts/dashboard-demo.mjs` and the other file names; environment
variables; API paths; Key Vault secret names such as `console-gateway-url`; the
`hackgw-key-console` app registration and its `Console.Admin` role; JWT audiences; CSV and bundle
columns; and Azure resource names. The display names the app gives the API Management APIs and
products it creates ("Key Dashboard: …", "Created by the Key Dashboard") also stay: they are Azure
metadata, not shown in the UI, and renaming them for new resources only would split one install
between two names. `tests/console-brand.test.mjs` lists those display names as the only allowed
use of an old name in the app's code.
