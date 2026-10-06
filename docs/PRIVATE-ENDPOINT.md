# Foundry behind a private endpoint

The gateway reaches a Foundry account whose public network access is **Disabled** when the API
Management instance is **Standard v2 or Premium v2 with outbound virtual network integration**.
Basic v2 has no outbound virtual network option, so a Basic v2 gateway cannot reach a private
Foundry account [1].

Verified end to end on 2026-10-06 (results in [Evidence](#evidence); UNKNOWNS U23).

## How the traffic flows

```
  participant: Claude Code, opencode, an app
        |   HTTPS to the gateway's public endpoint (unchanged)
        v
  API Management, Standard v2
        |   outbound virtual network integration
        |   (subnet delegated to Microsoft.Web/serverFarms)
        v
  virtual network --- private DNS: <account>.services.ai.azure.com -> 10.x.x.x
        |
        v
  private endpoint (sub-resource "account")  -->  Foundry account, public network access Disabled
```

With integration, the gateway's own endpoint stays public; only its outbound calls go through the
virtual network [2]. Making the gateway endpoint private as well is a separate option (Premium v2
injection, or an inbound private endpoint) [1], and was not tested here.

## What changes

| Component | Change |
|---|---|
| API Management | Standard v2 or Premium v2, with outbound virtual network integration. Changing an existing Basic v2 instance's tier was not tested |
| Virtual network | One subnet for the integration, one for the private endpoint (requirements below) |
| Foundry account | A private endpoint, three private DNS zones, then public network access Disabled |
| This repository | No code change. Option 1 adopts the integrated instance and does not change its networking |

What does not change:

- Model discovery, the deployment plan, the role grant and model deployment all go through Azure
  Resource Manager, which the account's network setting does not affect.
- The gateway authenticates to Foundry with its managed identity, as before.
- Participant keys and the participant setup are the same. A new instance has a new gateway URL.

What else is affected: public network access is a property of the Foundry account, not of this
gateway. Once it is Disabled, every client outside the network is refused with `403 Public access
is disabled` — including other gateways on the same account that are not integrated, and direct
SDK or notebook calls.

## Requirements

| Piece | Requirement | Source |
|---|---|---|
| Tier | Standard v2 or Premium v2. The classic Developer and Premium tiers can join a network but do not meter Claude tokens (UNKNOWNS U12) | [1], [2] |
| Integration subnet | Used by this one instance only; `/27` minimum, `/24` recommended; delegated to `Microsoft.Web/serverFarms`; same region and subscription as the instance | [2] |
| NSG on the integration subnet | Outbound TCP 443 from `VirtualNetwork` to `AzureKeyVault` allowed | [2] |
| Resource provider | `Microsoft.Web` registered in the subscription | [2] |
| Private endpoint | Sub-resource `account`, in the same region as the virtual network | [3] |
| Private DNS zones | `privatelink.cognitiveservices.azure.com`, `privatelink.openai.azure.com`, `privatelink.services.ai.azure.com`, each linked to the virtual network. The gateway's Claude route uses the `services.ai.azure.com` name | [4] |
| Permissions | Network Contributor on the virtual network; Contributor or Owner on the Foundry account; Private DNS Zone Contributor for the zones; `subnets/join/action` on the integration subnet | [2], [3] |

## Steps in the Azure portal

1. **Virtual network.** Create two subnets: one for the integration (`/24`, delegated to
   `Microsoft.Web/serverFarms`, with the NSG rule above), and one for the private endpoint.
2. **API Management.** On the Standard v2 instance: **Network** › **Edit** › **Outbound
   features** › enable virtual network integration › select the virtual network and the
   integration subnet › **Save** [2].
3. **Foundry account.** **Resource Management** › **Networking** › **Private endpoint
   connections** › **+ Private endpoint**. Use the virtual network's region and the private
   endpoint subnet; the target is labelled `account` [3]. Afterwards, check that the three zones
   above exist, are linked to the virtual network, and each holds an A record for the account.
4. **Gateway.** Run `admin.ps1`, option 1, and pick the Standard v2 instance and the Foundry
   account. Then option 11 to verify both routes.
5. **Close the public endpoint.** Foundry account › **Networking** › public network access
   **Disabled** [3]. Run option 11 again.

With public access disabled last, the gateway is verified before any other client loses access.

## Steps with the Azure CLI

These are the commands used for the evidence below.

**A complete test environment.** [`infra/examples/private-foundry-test.bicep`](../infra/examples/private-foundry-test.bicep)
creates, in one resource group, a virtual network with both subnets and the NSG, a new Foundry
account with one OpenAI-route and one Claude deployment, the private endpoint with the three zones,
and a Standard v2 instance with integration. A Claude deployment needs `modelProviderData`
(UNKNOWNS U14); the template takes it as a parameter, copied from an existing Claude deployment:

```powershell
$sub = az account show --query id -o tsv
$src = az rest --method get -o json --url "https://management.azure.com/subscriptions/$sub/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>/deployments/<claude-deployment>?api-version=2025-12-01" | ConvertFrom-Json
@{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'
   parameters = @{ publisherEmail = @{ value = '<email>' }; claudeProviderData = @{ value = $src.properties.modelProviderData } } } |
  ConvertTo-Json -Depth 6 | Set-Content params.json
az group create -n rg-hackgw-pe-test -l eastus2 -o none
az deployment group create -g rg-hackgw-pe-test --template-file infra/examples/private-foundry-test.bicep --parameters "@params.json"
```

**Close the public endpoint.** `az rest` returns before the change completes, so the state is
polled afterwards:

```powershell
$url = "https://management.azure.com/subscriptions/$sub/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>?api-version=2025-12-01"
'{"properties":{"publicNetworkAccess":"Disabled"}}' | Set-Content pna.json
az rest --method patch --url $url --body "@pna.json" -o none
az rest --method get --url $url --query properties.publicNetworkAccess -o tsv   # repeat until Disabled
```

**Integration on an existing Standard v2 instance.** Through REST rather than `az apim update`,
which sets the managed identity to None unless `--enable-managed-identity true` is passed [5]:

```powershell
$svc = "https://management.azure.com/subscriptions/$sub/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<apim>?api-version=2024-05-01"
@{ properties = @{ virtualNetworkType = 'External'; virtualNetworkConfiguration = @{ subnetResourceId = '<integration-subnet-id>' } } } |
  ConvertTo-Json -Depth 5 | Set-Content vnet.json
az rest --method patch --url $svc --body "@vnet.json" -o none
az rest --method get --url $svc --query "properties.provisioningState" -o tsv   # repeat until Succeeded
```

## Verify

| Check | Expected |
|---|---|
| Option 11 | Every check passes on both routes |
| A direct call to the account from outside the network | `403` — *"Public access is disabled. Please configure private endpoint."* |
| `az network private-dns record-set a list -g <rg> -z privatelink.services.ai.azure.com` | An A record for the account with a private address |

Timing: after integration is switched on, the instance reports `Succeeded` before its traffic uses
the network. Measured on 2026-10-06: `Succeeded` after 41 s, calls 30 s later still went to the
public endpoint and were refused, and both routes answered 200 about 85 s after the switch.
Option 11 shows when the change has reached the traffic; the provisioning state does not.

## Cost

Azure Retail Prices API, eastus2, read 2026-10-06: Basic v2 unit **$0.21/hour**, Standard v2 unit
**$0.96/hour**. The private endpoint and the private DNS zones are billed separately; see the
[Private Link](https://azure.microsoft.com/pricing/details/private-link/) and
[Azure DNS](https://azure.microsoft.com/pricing/details/dns/) pricing pages.

## Evidence

Isolated resource group `rg-hackgw-pe-test` (eastus2), created from the template above.

| Step | Result |
|---|---|
| Private endpoint and DNS | Connection Approved; A records `10.61.2.4` / `.5` / `.6` for the cognitiveservices / openai / services.ai names |
| Direct call from outside, public access Enabled → Disabled | HTTP 200 → HTTP 403 *"Public access is disabled"* |
| Option 1, adopting the Standard v2 instance | Plan REUSE, both routes CREATE, role CREATE; deployed in 2 min 20 s |
| Option 11 | OpenAI route 17/17, Claude route 23/23, including tool calls, budget exhaustion and revocation |
| The same instance with integration switched off | Both routes HTTP 403 *"Public access is disabled"* — what a Basic v2 gateway gets |
| Integration switched back on | 200 on both routes about 85 s later |

Public access was Disabled throughout the gateway checks, so the gateway's 200 responses came
through the private endpoint.

Teardown:

```powershell
az group delete -n rg-hackgw-pe-test --yes --no-wait
```

Deleted Foundry accounts and API Management instances are kept in a soft-deleted state for a
period and hold their names until purged.

## References

1. [Azure API Management with an Azure virtual network](https://learn.microsoft.com/azure/api-management/virtual-network-concepts) — networking options by tier (updated 2026-06-26)
2. [Integrate API Management in a private network](https://learn.microsoft.com/azure/api-management/integrate-vnet-outbound) — Standard v2 / Premium v2 outbound integration, subnet, NSG, portal steps (updated 2026-06-25)
3. [Configure network isolation for Microsoft Foundry](https://learn.microsoft.com/azure/foundry/how-to/configure-private-link) — private endpoint on a Foundry account, public network access (updated 2026-09-30)
4. [Azure Private Endpoint private DNS zone values](https://learn.microsoft.com/azure/private-link/private-endpoint-dns) — the three zones for Foundry (updated 2026-08-11)
5. [azure-cli `apim` command module, `apim_update`](https://github.com/Azure/azure-cli/blob/dev/src/azure-cli/azure/cli/command_modules/apim/custom.py) — identity set to None without `--enable-managed-identity true`
