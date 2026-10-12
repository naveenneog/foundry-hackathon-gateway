# Azure portal steps: API Management products with Key Vault (proof of concept)

These steps create in the Azure portal what [`infra/poc.bicep`](infra/poc.bicep) creates, and run
the key operations of [SETUP.md](SETUP.md) by hand. The design is in
[ARCHITECTURE.md](ARCHITECTURE.md).

The steps follow Microsoft Learn, read on 2026-10-12 (pages and their dates are under
[Sources](#sources)). They were not run in the portal in this proof of concept; the scripts were
([U31](../../docs/UNKNOWNS.md)). Where Learn describes an action without naming its portal label,
the step describes the action and names the script action that does the same thing. Names,
paths, headers and numbers are the template's, and tests compare them with `infra/poc.bicep`.

The script commands below run from `poc/products-keyvault/` with these two values, as in SETUP.md:

```powershell
$target = @{ Subscription = '<subscription>'; ResourceGroup = '<resource-group>'; ApimName = '<apim-name>' }
$vault = '<vault-name>'
```

## Prerequisites

| Item | Portal steps | Source |
|---|---|---|
| An API Management instance on a v2 tier | An existing instance; `llm-token-limit` meters the Anthropic Messages API only on v2 tiers ([U12](../../docs/UNKNOWNS.md)) | [llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) |
| The instance's system-assigned managed identity | The instance › **Security** › **Managed identities** › **System assigned** › **Status** On › **Save** | [Managed identities in API Management](https://learn.microsoft.com/azure/api-management/api-management-howto-use-managed-service-identity) |
| Cognitive Services User for that identity on the Foundry account, the role these runs used | The Foundry account › **Access control (IAM)** › **Add** › **Add role assignment** › the role › **Next** › **Managed identity** › **+ Select members** › the instance › **Select** › **Review + assign** | [Assign Azure roles using the portal](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal) |
| A network path from the instance to Foundry | Outbound virtual network integration and a private endpoint on the Foundry account, as in [docs/PRIVATE-ENDPOINT.md](../../docs/PRIVATE-ENDPOINT.md) ([U23](../../docs/UNKNOWNS.md)) | [Integrate API Management in a private network](https://learn.microsoft.com/azure/api-management/integrate-vnet-outbound) |
| A subnet for the vault's private endpoint | A subnet in that virtual network; `snet-pe` in the test environment ([`private-foundry-test.bicep`](../../infra/examples/private-foundry-test.bicep)) | [Integrate Key Vault with Private Link](https://learn.microsoft.com/azure/key-vault/general/private-link-service) |
| The Foundry endpoints | The Foundry account › **Resource Management** › **Keys and Endpoint** shows the endpoint; its host name begins with the account's custom subdomain, `<account>` below. Claude: `https://<account>.services.ai.azure.com/anthropic`. OpenAI-compatible: `https://<account>.openai.azure.com/openai/v1` | [Create a Foundry resource](https://learn.microsoft.com/azure/ai-services/multi-service-resource); `claudeServiceUrl` and `openaiServiceUrl` in [`infra/poc.bicep`](infra/poc.bicep) |

## Routes

Three APIs, one per route:

| Name | Display name | API URL suffix | Web service URL | Subscription key header | Policy |
|---|---|---|---|---|---|
| `poc-claude` | POC: Claude on Foundry, product keys | `poc/claude` | `https://<account>.services.ai.azure.com/anthropic` | `x-api-key` | [`api-claude-policy.xml`](infra/api-claude-policy.xml) |
| `poc-openai` | POC: OpenAI-compatible on Foundry, product keys | `poc/v1` | `https://<account>.openai.azure.com/openai/v1` | `api-key` | [`api-openai-policy.xml`](infra/api-openai-policy.xml) |
| `poc-probe` | POC: what the gateway knows about a key | `poc/probe` | none; its policy answers without calling a backend | `x-api-key` | [`api-probe-policy.xml`](infra/api-probe-policy.xml) |

1. **Create each API.** **APIs** › **+ Add API** › **HTTP**: **Display name**, **Name**, **Web
   service URL**, **URL scheme** HTTPS and **API URL suffix** as in the table; no product yet,
   the packs add the routes › **Create**
   ([Add an API manually](https://learn.microsoft.com/azure/api-management/add-api-manually); the
   fields are described in
   [Import and publish your first API](https://learn.microsoft.com/azure/api-management/import-and-publish)).
2. **The key header.** On the API's **Settings** tab: subscription required on, the subscription
   key header name from the table, and the query parameter name `subscription-key`. Learn states
   the defaults (`Ocp-Apim-Subscription-Key`, `subscription-key`) and that "in the portal, update
   these names on the Settings tab of an API"; it does not quote the field labels
   ([Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions)).
3. **Operations.** **Design** tab › **+ Add operation**: the method and URL, and the operation's
   name as **Display name** › **Save**
   ([Add an API manually](https://learn.microsoft.com/azure/api-management/add-api-manually)):

   | API | Operation | Method | URL |
   |---|---|---|---|
   | `poc-claude` | `messages` | POST | `/v1/messages` |
   | `poc-claude` | `count-tokens` | POST | `/v1/messages/count_tokens` |
   | `poc-openai` | `chat-completions` | POST | `/chat/completions` |
   | `poc-probe` | `whoami` | GET | `/whoami` |

4. **Policy.** **Design** › **All operations** › **Inbound processing** › **</>** (the code
   editor): replace the whole document with the policy file's content › **Save**
   ([Set or edit policies](https://learn.microsoft.com/azure/api-management/set-edit-policies)).

## Packs

One product per pack. Its policy is [`infra/product-policy.xml`](infra/product-policy.xml) with
the four placeholders replaced by the pack's values: `__MODELS__` the deployment names a key may
call, several separated by `|`; `__KEY_TOKENS__` the tokens per key per calendar month (UTC);
`__POOL_TOKENS__` the tokens per pack per calendar month; `__TPM__` the tokens per key per
minute.

| Id | Display name | APIs | `__MODELS__` | `__KEY_TOKENS__` | `__POOL_TOKENS__` | `__TPM__` |
|---|---|---|---|---|---|---|
| `poc-claude-pack` | POC: Claude pack | poc-claude, poc-probe | claude-haiku-4-5 | 200000 | 2000000 | 20000 |
| `poc-deepseek-pack` | POC: DeepSeek pack | poc-openai, poc-probe | deepseek-v4-flash | 200000 | 2000000 | 20000 |
| `poc-tiny-pack` | POC: tiny budget | poc-claude, poc-probe | claude-haiku-4-5 | 300 | 100000 | 20000 |

1. **Create each product.** **Products** › **+ Add**: **Display name**, the id, a
   **Description**; **State** not published (the template keeps packs out of the developer
   portal, and the gateway serves them either way); **Requires subscription** on; **Requires
   approval** off; **APIs** as in the table › **Create**
   ([Create and publish a product](https://learn.microsoft.com/azure/api-management/api-management-howto-add-products)).
   Learn's field list has no id field. `-Action New` and `-Action List` need ids starting `poc-`,
   and `Remove-Poc.ps1` deletes these three ids by name (roadmap P41), so the product's id has to
   be the table's ([U31](../../docs/UNKNOWNS.md)).
2. **Policy.** The product › **Policies** › **</>**: replace the document with
   `product-policy.xml`'s content, placeholders replaced › **Save**
   ([Set or edit policies](https://learn.microsoft.com/azure/api-management/set-edit-policies)).

## Key Vault

1. **Create the vault.** **Key vaults** › **Create**: a name, the region, the Standard tier;
   soft-delete retention 7 days and purge protection off, the template's settings, so the vault
   can be removed completely (Learn: retention is 7 to 90 days); the permission model **Azure
   role-based access control**; on **Networking**, **Disable public access** and **+ Create a
   private endpoint** in the private endpoint subnet (`snet-pe` in the test environment), with
   the private DNS zone `privatelink.vaultcore.azure.net` › **Review + create**
   ([quickstart](https://learn.microsoft.com/azure/key-vault/general/quick-create-portal),
   [soft-delete](https://learn.microsoft.com/azure/key-vault/general/soft-delete-overview),
   [Key Vault RBAC](https://learn.microsoft.com/azure/key-vault/general/rbac-guide),
   [network security](https://learn.microsoft.com/azure/key-vault/general/network-security),
   [Private Link](https://learn.microsoft.com/azure/key-vault/general/private-link-service)).
   For a vault that exists: **Networking** › **Private endpoint connections** › **+ Create**,
   resource type `Microsoft.KeyVault/vaults`, target sub-resource `vault`, the virtual network
   and subnet, the same zone › **Review + Create**.
2. **Close the trusted-services bypass.** The template sets the firewall's default action to Deny
   with no bypass. Learn: "Disabling public access doesn't suppress the trusted services bypass:
   trusted services continue to reach the vault and don't require a private endpoint." The vault
   › **Networking** › **Firewalls and virtual networks** › under **Exception**, clear **Allow
   trusted Microsoft services to bypass this firewall** › **Save**
   ([network security](https://learn.microsoft.com/azure/key-vault/general/network-security)).
   The same with the Azure CLI:
   `az keyvault update --name <vault-name> --resource-group <resource-group> --bypass None --default-action Deny`
   ([az keyvault update](https://learn.microsoft.com/cli/azure/keyvault#az-keyvault-update)).
3. **The operator's role.** The vault › **Access control (IAM)** › **Add** › **Add role
   assignment** › Key Vault Secrets Officer › the operator › **Review + assign**
   ([Assign Azure roles using the portal](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal)).
4. **Audit log (optional).** The vault › **Diagnostic settings** › **Add diagnostic setting** ›
   category group **audit** › **Send to Log Analytics workspace** › **Save**
   ([Key Vault logging](https://learn.microsoft.com/azure/key-vault/general/howto-logging)).
   Queries run from the vault's **Logs**
   ([Monitor Key Vault](https://learn.microsoft.com/azure/key-vault/general/monitor-key-vault)); the
   query in [SETUP.md](SETUP.md#monitor) lists reads and writes per key.

**A private vault in the portal.** Learn states: "Although users can browse to a key vault from
the Azure portal, they might not be able to list keys, secrets, or certificates if their client
machine is not in the allowed list"
([network security](https://learn.microsoft.com/azure/key-vault/general/network-security)), while
operations on the vault resource itself "are not affected by firewalls and virtual network rules"
([service endpoints](https://learn.microsoft.com/azure/key-vault/general/overview-vnet-service-endpoints)).
The steps below that open a secret (issuing, a role on one secret, rotating) therefore need a
browser on the private network, for example on a VM inside it ([U32](../../docs/UNKNOWNS.md)). The
script actions `New` and `Rotate` need a path to the vault as well; from outside the network they
run on the runner: `./scripts/Invoke-PocRunner.ps1 @target -VaultName $vault -Step Key -KeyAction New -KeyName alice -KeyProduct poc-claude-pack`.
The script actions `Grant`, `Revoke`, `SetExpiry`, `SuspendExpired`, `Suspend`, `Resume` and `List` need no path to the vault.

## Issue a key

1. **The subscription.** **Subscriptions** › **Add subscription**: **Name** `poc-<name>`, a
   **Display name**, **Scope** the pack's product, no user › **Create**. Each subscription has a
   primary and a secondary key
   ([Create subscriptions](https://learn.microsoft.com/azure/api-management/api-management-howto-create-subscriptions)).
2. **The secret.** Copy the subscription's primary key from its keys view. The vault ›
   **Objects** › **Secrets** › **+ Generate/Import**: **Upload options** Manual, **Name**
   `poc-key-<name>`, the primary key as the value › **Create**
   ([Set and retrieve a secret](https://learn.microsoft.com/azure/key-vault/secrets/quick-create-portal)).
   Give the version the content type `API Management subscription key` and the tags `slot`
   (`primary`), `subscription` (`poc-<name>`) and `product` (the pack): the scripts write all
   three on every version, and `Rotate` reads `slot` and `subscription` and stops without them.
   Tags and the content type belong to a version:
   [Set Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/set-secret/set-secret) creates
   a new version from the request, and
   [Update Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/update-secret/update-secret)
   changes one version. Learn's
   quickstart names only the name and value fields, so the content type and tag fields are not
   quoted here ([U31](../../docs/UNKNOWNS.md)).

Script: `./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action New -Name alice -Product poc-claude-pack`.
The script keeps the key in memory. The portal steps pass it through the clipboard; Windows keeps
copied text in its clipboard history when that is on, and syncs the history to other devices when
**Sync across devices** is on
([Clipboard in Windows](https://support.microsoft.com/windows/clipboard-in-windows-c436501e-985d-1c8d-97ea-fe46ddf338c6)).

## Hand a key over

**Read access to one secret.** The secret › **Access control (IAM)** › **Add** › **Add role
assignment** › Key Vault Secrets User › the developer › **Review + assign** (Learn's "Secret scope
role assignment",
[Key Vault RBAC](https://learn.microsoft.com/azure/key-vault/general/rbac-guide)). Removing it: the
secret › **Access control (IAM)** › **Role assignments** › select the assignment › **Remove** ›
**Yes**
([Remove role assignments](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-remove)).
Learn's path opens the secret first, which reads the vault, so with a private vault these steps
need the private network ([U32](../../docs/UNKNOWNS.md)). The script actions make the same change
through Azure Resource Manager only ([U30](../../docs/UNKNOWNS.md)):
`./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action Grant -Name alice -ObjectId <object-id>`
and `-Action Revoke` with the same arguments.

**One-time copy.** The current key is the one the secret's `slot` tag names: the primary key until
the first rotation, then the slot the last `Rotate` printed. The subscription's keys view in API
Management shows both keys and needs no path to the vault
([Create subscriptions](https://learn.microsoft.com/azure/api-management/api-management-howto-create-subscriptions)).
A copy of the other key is refused after the next rotation.

## Rotate a key

1. **Find the slot clients hold.** The secret's current version has it in its `slot` tag
   ([Update Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/update-secret/update-secret)).
2. **Regenerate the other key.** In API Management, regenerate the subscription's other key, and
   copy it. Each subscription has two keys
   ([Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions));
   Learn does not name the portal entry that regenerates one.
3. **Store it as the next version.** A new version of the secret holding the new key, with the
   content type `API Management subscription key` and all three tags: `slot` (the slot just
   regenerated), `subscription` (`poc-<name>`) and `product` (the pack).
   [Set Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/set-secret/set-secret)
   creates the new version from what the request holds, and `Rotate` reads `slot` and
   `subscription` from the current version. Learn does
   not document creating a secret version in the portal ([U31](../../docs/UNKNOWNS.md)).

The key clients hold keeps working until the following rotation, the pattern in
[Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual).
Script: `./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action Rotate -Name alice`, which
reads the slot from the tag and stops when the tag is missing.

## Expire a key

Learn states: "API Management doesn't provide built-in features to manage the lifecycle of
subscription keys, such as setting expiration dates or automatically rotating keys"
([Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions)).
The REST API has an `expirationDate`, which "is for audit purposes only and the subscription is
not automatically expired"
([Subscription REST API](https://learn.microsoft.com/rest/api/apimanagement/subscription/create-or-update));
no portal field for it is documented ([U33](../../docs/UNKNOWNS.md)). The script actions set it
and enforce it: `./scripts/Invoke-PocKey.ps1 @target -Action SetExpiry -Name alice -ExpiresUtc 2027-01-31`,
and `-Action SuspendExpired` on a schedule, which suspends keys from 00:00 UTC on their stored date
([U24](../../docs/UNKNOWNS.md)).

## Suspend and resume a key

Learn states that "you can suspend, cancel, or delete any subscription (including the built-in
all-access subscription) to prevent API access"
([Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions)),
without naming the portal entries ([U33](../../docs/UNKNOWNS.md)). Script:
`./scripts/Invoke-PocKey.ps1 @target -Action Suspend -Name alice` and `-Action Resume`. Measured:
refused 1.4 s after suspending, accepted again 9.8 s after resuming ([U25](../../docs/UNKNOWNS.md)).

## List keys

**Subscriptions** lists the instance's keys
([Create subscriptions](https://learn.microsoft.com/azure/api-management/api-management-howto-create-subscriptions)).
Script: `./scripts/Invoke-PocKey.ps1 @target -Action List`, which shows each key on a `poc-` pack
with its pack, state and stored expiry date.

## Remove

The roles on the key secrets go before the vault: a role assignment names the secret's path,
which a vault created again under the same name would reuse.

1. **Keys, packs and routes.** The keys on each pack (**Subscriptions**), then the packs
   (**Products**) and the routes (**APIs**). Learn documents deleting a product together with its
   subscriptions only for the Azure CLI (`--delete-subscriptions true`)
   ([Create and publish a product](https://learn.microsoft.com/azure/api-management/api-management-howto-add-products)).
2. **Roles on the key secrets.** Each secret › **Access control (IAM)** › **Role assignments** ›
   **Remove**
   ([Remove role assignments](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-remove)).
   With a private vault this needs the private network ([U32](../../docs/UNKNOWNS.md)).
3. **The vault's private endpoint.** The private endpoint, whose network interface goes with it,
   and its record in the zone `privatelink.vaultcore.azure.net`; the zone itself when no other
   record is left in it
   ([Manage private endpoints](https://learn.microsoft.com/azure/private-link/manage-private-endpoint)).
4. **The vault.** The operator's role on it, then the vault. Learn documents deleting a vault as
   part of deleting its resource group, which here holds the instance as well. A deleted vault is
   purged from **Key vaults** › **Manage deleted vaults** › the subscription › the vault
   ([recovery management](https://learn.microsoft.com/azure/key-vault/general/key-vault-recovery)).

`Remove-Poc.ps1 -Runner -PurgeVault` removes the same resources ([SETUP.md](SETUP.md#remove)):
`-Runner` covers the private endpoint and the zone when it is empty, together with the runner. It
lists the roles on key secrets without a path to the vault, deletes the vault alone, and keeps it
while a role on a key secret remains.

## Sources

Microsoft Learn, read 2026-10-12; the dates are each page's last update.

- [Managed identities in API Management](https://learn.microsoft.com/azure/api-management/api-management-howto-use-managed-service-identity) (2026-06-25)
- [Assign Azure roles using the Azure portal](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal) (2026-03-17)
- [Remove Azure role assignments](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-remove) (2026-05-07)
- [Integrate API Management in a private network](https://learn.microsoft.com/azure/api-management/integrate-vnet-outbound) (2026-06-25)
- [Create a Foundry resource](https://learn.microsoft.com/azure/ai-services/multi-service-resource) (2026-09-25)
- [Add an API manually](https://learn.microsoft.com/azure/api-management/add-api-manually) (2026-09-14)
- [Import and publish your first API](https://learn.microsoft.com/azure/api-management/import-and-publish) (2026-06-25)
- [Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions) (2026-06-25)
- [Set or edit policies](https://learn.microsoft.com/azure/api-management/set-edit-policies) (2026-06-26)
- [Create and publish a product](https://learn.microsoft.com/azure/api-management/api-management-howto-add-products) (2026-06-25)
- [Create subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-howto-create-subscriptions) (2026-06-25)
- [Subscription REST API, create or update](https://learn.microsoft.com/rest/api/apimanagement/subscription/create-or-update) (api-version 2024-05-01)
- [Create a key vault using the Azure portal](https://learn.microsoft.com/azure/key-vault/general/quick-create-portal) (2026-06-12)
- [Key Vault soft-delete overview](https://learn.microsoft.com/azure/key-vault/general/soft-delete-overview) (2026-06-12)
- [Azure RBAC for Key Vault](https://learn.microsoft.com/azure/key-vault/general/rbac-guide) (2026-08-21)
- [Key Vault network security](https://learn.microsoft.com/azure/key-vault/general/network-security) (2026-10-06)
- [Key Vault virtual network service endpoints](https://learn.microsoft.com/azure/key-vault/general/overview-vnet-service-endpoints) (2026-10-09)
- [Integrate Key Vault with Azure Private Link](https://learn.microsoft.com/azure/key-vault/general/private-link-service) (2026-06-12)
- [az keyvault](https://learn.microsoft.com/cli/azure/keyvault) (2026-07-07)
- [Key Vault REST API, Set Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/set-secret/set-secret) (2025-10-14)
- [Key Vault REST API, Update Secret](https://learn.microsoft.com/rest/api/keyvault/secrets/update-secret/update-secret) (2025-10-14)
- [Set and retrieve a secret using the Azure portal](https://learn.microsoft.com/azure/key-vault/secrets/quick-create-portal) (2026-06-12)
- [Enable Key Vault logging](https://learn.microsoft.com/azure/key-vault/general/howto-logging) (2026-06-12)
- [Monitor Azure Key Vault](https://learn.microsoft.com/azure/key-vault/general/monitor-key-vault) (2026-06-12)
- [Manage Azure private endpoints](https://learn.microsoft.com/azure/private-link/manage-private-endpoint) (2026-04-02)
- [Key Vault recovery management](https://learn.microsoft.com/azure/key-vault/general/key-vault-recovery) (2026-06-12)
- [llm-token-limit policy](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) (2026-06-26)
- [Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual) (2026-07-08)
- [Clipboard in Windows](https://support.microsoft.com/windows/clipboard-in-windows-c436501e-985d-1c8d-97ea-fe46ddf338c6) (Microsoft Support, 2026-09-28)
