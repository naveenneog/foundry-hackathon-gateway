# Key Dashboard

A web app for gateway administrators. It issues and manages two key types:

- **Short-lived keys:** signed HS256 keys, with a model allowlist, token budget, activation time
  and expiry. The signing secret is held in Key Vault.
- **Product keys:** API Management subscription keys held in Key Vault. They can be limited to
  one or several Foundry deployments, rotated between two slots, suspended, and enrolled in
  automatic rotation.

The dashboard also shows per-key usage, separately for short-lived and product keys. Administrators
distribute keys by copying a single key, downloading the script-compatible `keys.csv` and
key-free `index.csv`, or creating an encrypted bundle signed by a Key Vault key.

Decisions: [ADR-0013](adr/0013-admin-console.md) (core design),
[ADR-0014](adr/0014-console-on-container-apps.md) (Container Apps hosting),
[ADR-0015](adr/0015-key-dashboard.md) (dashboard), and
[ADR-0016](adr/0016-admin-only-short-lived-keys.md) (admin-only access and distribution).

---

## Access

**Only `Console.Admin` can open the dashboard.** It requires Entra sign-in and the `Console.Admin`
app role. A signed-in person without that role gets 403 on every API; the UI displays
"This dashboard is for administrators. Ask an admin for your key." The deploy script assigns
the operator and optional `-Admins` entries. It does not assign `Console.User`.

**Issued to** is the email address the administrator records for attribution and usage reporting.
It does not grant dashboard access. The recipient does not sign in to reveal the key: the
administrator copies it or distributes that recipient's row from `keys.csv`.

The app role comes from the platform-authenticated `X-MS-CLIENT-PRINCIPAL` header. The app
refuses a missing principal (401), a non-admin role (403) and a client-supplied principal header.

---

## Deploy

Prerequisites:
- the proof of concept deployed: APIM Standard v2, private vault `kv-poc-*`, and the VNet;
- Azure CLI signed in as someone who can create an app registration and assign roles in the
  resource group.

```powershell
# Default path: Container Apps. No IP restriction; Entra sign-in is still required.
pwsh scripts/Deploy-Console.ps1 -Subscription <subscription> -ResourceGroup <rg>

# Optionally assign additional admins and/or restrict inbound access.
pwsh scripts/Deploy-Console.ps1 -Subscription <subscription> -ResourceGroup <rg> `
    -Admins ops1@contoso.com,ops2@contoso.com -AllowedIp 203.0.113.7

# Alternate path: App Service web app and Function App on one plan.
pwsh scripts/Deploy-Console.ps1 -Subscription <subscription> -ResourceGroup <rg> `
    -Hosting AppService
```

The script, in order:

1. Finds the APIM instance, the vault and the VNet in the resource group.
2. Creates or updates the app registration `hackgw-key-console`, ensures the admin role, and
   sets "assignment required". The legacy `Console.User` role grants no dashboard access.
3. Assigns the signed-in operator `Console.Admin` and each `-Admins` entry `Console.Admin`.
4. Grants sign-in consent (`openid profile email`) for each administrator as a per-user
   `oauth2PermissionGrant`. This is for tenants that block user consent. If the grant fails, the
   script warns; then ask a tenant admin to grant admin consent once.
5. Builds the image in Azure Container Registry with ACR Tasks. Docker is not needed locally,
   and the registry admin user stays off.
6. Deploys only the selected hosting path:
   - **ContainerApps** (default): `infra/console.bicep`, a scale-to-zero web app and a scheduled
     job for automation;
   - **AppService**: `infra/console-appservice.bicep`, a web app and a Function App timer on one
     plan. This template builds, but the subscription's zero App Service quota in eastus2 blocks
     ARM validate/what-if and live deployment.

   Container Apps creates an environment injected into the POC VNet. App Service uses its
   delegated VNet-integration subnet. Each path creates the dashboard with built-in Entra
   authentication and HTTPS only, and a managed identity with Key Vault Secrets Officer,
   Key Vault Crypto Officer and API Management Service Contributor.
7. Sets the redirect URI, waits for `/healthz`, and prints the URL.

`-AllowedIp` is optional. When supplied, it applies an inbound allow rule; omit it for Entra-only
access. The live installation has no IP restriction because the administrator's NAT egress address
rotates. The automation has no inbound endpoint.

**First sign-in as admin:** open **Signing secret**, then click **Migrate from API Management**.
This copies the gateway's current signing secret into Key Vault. Keys already issued keep
working.

---

## Using it

### Keys

![Admin overview with separate active key counts and short-lived/product usage charts](images/console/console-overview.png)

![Short-lived key list and active/archived key actions](images/console/console-keys.png)

The dashboard lists active keys by default, with a separate archived view. **Issued to** labels
the intended holder; only administrators can see or reveal keys. For each key:

- **Reveal** returns the value and a ready-to-paste client setup.
- **Rotate** regenerates the slot not in use, then moves the stored value to it. The old value
  keeps working until the next rotation, so clients can switch without downtime.
- **Suspend / Resume** turns the subscription off and on.
- **Automation** sets "rotate every N days". Leave it blank to switch it off.
- **Run rotation automation now** rotates every key that is due.

Expired short-lived keys, revoked keys and expired product keys move to the archive automatically.
Product subscriptions are suspended before archiving. An admin can delete archived keys; the
automation deletes them 30 days after archive. Deletion is a Key Vault soft delete, not a purge.

A change to a product key reaches the gateway within about 20 seconds (16 s measured).

Usage charts cover 24 h, 7 d, 30 d or 90 d. The data is the gateway's `AppMetrics` table, an
Application Insights table that keeps 90 days at no charge, even though the workspace default is
30 days ([Learn: log tables with 90-day default retention](https://learn.microsoft.com/azure/azure-monitor/logs/data-retention-configure#log-tables-with-90-day-default-retention)).
Usage older than 90 days is removed. Raising the table's retention (up to 730 days of analytics
retention) keeps more, at an [extra cost](https://azure.microsoft.com/pricing/details/monitor/).
Check a workspace with `az monitor log-analytics workspace table show --name AppMetrics`.

### Foundry discovery, backend attachment and model pinning

**Foundry & models** lists the Foundry and Azure OpenAI accounts connected to this gateway's API
Management: the original (default) account and each attached account
([ADR-0018](adr/0018-connected-foundries-only.md)). Short-lived and product keys are issued only
for these. Its count covers connected Foundries and their deployments. **Refresh from Azure**
re-reads accounts and deployments from ARM; newly deployed models do not require an app redeploy.

**Connect another Foundry** opens a dialog that lists the other AIServices and Azure OpenAI
accounts the dashboard discovers in the configured subscription, including accounts outside the
gateway's resource group, with search. An account the dashboard cannot read is listed there with
its error, not omitted. These accounts do not appear in the connected list until they are
attached. If no Foundry is connected, the page shows an empty state with the same action.

![Subscription-wide Foundry account discovery with connection states and deployment counts](images/console/console-foundries.png)

The screenshot predates P58: it shows unattached accounts in the main list, where they no longer
appear.

1. In **Connect another Foundry**, choose the account by its name, resource group and region.
   Deployment names may repeat across accounts; the account's resource ID distinguishes them.
2. **Attach** provisions that account's APIM backends and isolated gateway routes. It does not
   give the dashboard permission to grant Azure roles or open a firewall. After it succeeds, the
   dialog closes and the account is selected in the connected list. A failed attach keeps the
   dialog open with the error; selecting Attach again repairs a partial attempt.
3. Run the displayed operator setup command to grant the APIM managed identity inference access
   on the account. The dialog shows it before attaching, and the account's access section shows
   it afterwards. If the gateway's private DNS zones have no record for this account, the optional
   private-endpoint setup command creates the endpoint and records in its VNet.
4. Pin aliases for ready chat/messages deployments. Embeddings, image, audio, realtime and
   unsupported model formats remain visible with a reason; this gateway does not expose their
   modality-specific APIs.
5. **Test** makes a small inference request through APIM. Attachment is configuration, not proof
   that RBAC and networking work; a failure shows the next setup step.

The **Help** control explains these steps and highlights the relevant controls; its Attach step
highlights **Connect another Foundry**. **How attaching works** inside the dialog closes the
dialog first, because the guide cannot be used while a modal dialog is open. Discovery uses
metadata-only read permissions. Inference uses APIM's separate identity and per-account role.
Private endpoint setup is an operator action; no public-network or firewall settings are relaxed.

![Setup guide highlighting the account discovery controls](images/console/console-foundry-help.png)

The original account keeps its existing `/v1`, `/claude` and `/poc/*` routes. Other accounts use
`/foundry/<connection-id>/...`. Returned handouts, CSVs and encrypted exports contain the correct
selected-account URLs. A short-lived key for one account is rejected at another account's routes;
product keys are linked only to their own account's APIs.

### Issue a short-lived key

![Issue a short-lived key: intended holder, subject, models, token budget, activation delay and validity](images/console/console-issue-signed.png)

The key is minted with the signing secret in Key Vault. Select a connected **Foundry**, then
choose one or several of that account's pinned aliases. Changing the Foundry clears the model
selection so a grant cannot accidentally use a different account's models.
**Starts in (hours from now)** defaults to 0; a future start is shown as **Scheduled**. The
gateway checks `nbf`, expiry, the model allowlist and token budget. This matches
`scripts/Keys.ps1`'s `Read-KeySettings`. **Revoke** adds the key ID to the gateway's denylist.

### Bulk issue and distribute

![Short-lived key form with activation delay and calculated validity window](images/console/console-issue-signed.png)

![Bulk short-lived key form with model grant, start delay and CSV input rows](images/console/console-short-lived-bulk.png)

The **Bulk issue** form accepts CSV rows (`owner,subject` for short-lived keys;
`owner,name` for product keys). It submits at most 50 rows per request and displays names and
owners, not key values.

- **Download keys.csv** is the distribution file. It contains every key in the batch, with one
  row per recipient and the base URL, model(s), budget and validity columns. Send each person only
  their own row, then delete the file.
- **Download index.csv** has the recipient and key identifier, but no keys; it can be shared with
  co-organisers.
- **Export as encrypted bundle** uses the signed, passphrase-encrypted format below.

The browser keeps both CSV strings only in memory and discards them when the result closes, the
view changes or the page unloads. The files are not written to browser storage.

### Issue a product key

![Issue a product key: owner, name, product pack and optional automatic rotation](images/console/console-issue-product.png)

Select a connected **Foundry**, then one or several of its deployments. This creates/reuses a product whose policy allows
exactly those deployments and stores each APIM subscription's primary key in Key Vault.

![Product key issue form with Foundry deployments, monthly budget and rotation settings](images/console/console-issue-product.png)

![Bulk product key form with model grant and CSV input rows](images/console/console-product-bulk.png)

### Client setup

The client setup shown by **Reveal** depends on the key type:

| Key | Route | Header | Claude Code |
|---|---|---|---|
| Signed | `/claude/v1/messages`, `/v1/chat/completions` | `Authorization: Bearer` | `ANTHROPIC_AUTH_TOKEN` |
| Product | `/poc/claude/v1/messages` | `x-api-key` | `ANTHROPIC_API_KEY` |

The setup also sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`, or `OPENAI_BASE_URL` and
`OPENAI_API_KEY` for the OpenAI-compatible route.

### Export bundle (admins)

![Export bundle: recipient, passphrase, and the public verification key](images/console/console-export.png)

To export:

1. Tick keys on the **Keys** tab.
2. Enter a recipient and a passphrase. If you leave the passphrase blank, the console generates
   one and shows it once.
3. Download the bundle.

The bundle is a JSON file:
- encrypted with AES-256-GCM under a key derived from the passphrase with scrypt;
- signed with ES256 by the Key Vault key `bundle-signing`, so the private key never leaves the
  vault.

**Send the passphrase by a different channel than the file.** Each export is logged with the
admin's name and the key names, never the values.

The recipient opens it:

```bash
# bundle-key.json: the public key from "Bundle verification key", obtained from the console,
# not from whoever sent the bundle
BUNDLE_PASSPHRASE='…' node scripts/open-bundle.mjs bundle.json --key bundle-key.json --out keys.json
```

`open-bundle.mjs` checks the signature before decrypting. It refuses a bundle whose header or
ciphertext was changed. It writes the keys to `--out` with owner-only permissions, never to the
terminal.

### Signing secret (admins)

![Signing secret: where it is held, whether the copies match, and the three actions](images/console/console-signing.png)

Key Vault holds the secret. API Management receives a copy as an encrypted named value, because
a Key Vault reference would need the vault firewall opened to trusted services (U36). The page
shows whether the two copies match, and has three actions:

- **Migrate:** first run only; copies the APIM secret into the vault.
- **Push:** copies the vault value to APIM.
- **Rotate:** writes a new secret to both. Every signed key issued before it stops working.

---

## Security notes

- **Sign-in:** every request except `/healthz` needs Entra sign-in. Plain HTTP is redirected to
  HTTPS.
- **Headers:**
  - a strict Content Security Policy, with no inline script;
  - `X-Frame-Options: DENY`;
  - `Referrer-Policy: same-origin`. A same-origin `Referer` is required: Container Apps
    authentication refuses cookie-authenticated browser POSTs without one (measured).
- **Secret handling:**
  - Secret values never reach the logs.
  - The app has no client secret and no registry password; it uses managed identities only.
  - Key Vault is reached only over the private network.
- **Dashboard access:** remove the administrator's app-role assignment in Entra. Keys are
  distributed out-of-band by the administrator; the intended holder has no dashboard role.
- **Network access:** the live deployment has no IP allowlist, because the administrator's public
  egress IP changes. Entra authentication and the `Console.Admin` role are still required.

## Measured on the deployment (2026-10-16 to 2026-10-23)

**Signed keys:**
- A console-issued key called `/v1` and `/claude` successfully (200).
- After **Revoke**, both routes returned 403.

**Product keys:**
- The primary key worked.
- **Rotate:** the new key worked; the old one kept working through the overlap. After a second
  rotation, the original key was rejected (401).
- **Suspend** returned 401, and **Resume** returned 200. Each change took effect within 16 s.

**Rotation sweep:** it rotated a key that was due, and rotated nothing on a second run.

**Bundles:**
- A genuine bundle opened.
- A bundle with an edited header was refused (bad signature).
- A bundle with a flipped ciphertext byte was refused.

**Historical P46 role test:** before ADR-0016, `Console.User` saw only its own keys and every
admin action returned 403. That behaviour was superseded: the dashboard is now admin-only, and
owners cannot sign in to reveal keys.

**ADR-0016 live checks (2026-10-23):**
- No IP restrictions are configured. `/healthz` returned 200 from both the workstation and the
  private runner VM; `/api/me` returned 401 without sign-in.
- A bulk short-lived key with a one-hour delay had a future JWT `nbf`, appeared as `scheduled`,
  and was included in `keys.csv`; its key-free index did not contain the key. Revoke returned 200.
- A bulk product key appeared in `keys.csv`, not in `index.csv`; archive and delete both returned
  200.
- The runner VM resolved the vault to `10.61.2.7` and Foundry to `10.61.2.4`. The vault responded
  over its private endpoint; dashboard traffic from the VM reached the app.

The interface screenshots were captured from the live UI on 2026-10-23/24. Account/resource
names, subscription IDs and header identities are replaced with generic examples before capture;
no key values are shown.
