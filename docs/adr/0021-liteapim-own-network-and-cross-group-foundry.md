# ADR-0021: liteAPIM on a gateway without a VNet gets an opt-in network of its own; the Foundry may be in another resource group

- **Status:** Accepted
- **Date:** 2026-10-26
- **Packet:** P63
- **Deciders:** owner (request: "can you test this setup on basic v2 existing apim"), Copilot

## Context

ADR-0014 and ADR-0015 place liteAPIM in the gateway's VNet, where the private Key Vault and the
private Foundry are reachable. The installers assumed that VNet, the product-key vault, the Foundry
account and the gateway's Application Insights component all sit in the APIM's resource group.

The project's own Basic v2 gateway, `apim-hackgwfl4s7jvpxekno` in `rg-hackathon-gateway`, breaks
four of those assumptions (verified 2026-10-26 by read-only probes):

- it has no VNet: `virtualNetworkType` is `None`, and Basic v2 has no outbound virtual network
  option ([PRIVATE-ENDPOINT.md](../PRIVATE-ENDPOINT.md) [1]);
- its Foundry, `ai-contosohub530569751908`, is in `rg-contosohub` with public network access
  Enabled, and APIM's managed identity already holds Cognitive Services User on it;
- its resource group also holds an unrelated Application Insights component
  (`appi-aum-aum-naveen`);
- its signing secret is a plain APIM named value, so APIM itself needs no path to the vault.

The product-key vault is created with public network access Disabled, and that stays: it holds
every product key. liteAPIM's app and its automation job must therefore reach it through a
private endpoint in some VNet.

A role assignment cannot target a resource in another resource group from a resource-group
deployment (Bicep `BCP139`, measured 2026-10-26; U60).

## Options considered

1. **Open the vault to liteAPIM's outbound addresses.** No new network. Rejected: the vault
   holds every product key, the charter keeps it private, and Container Apps' outbound
   addresses are shared.
2. **Reuse the runner VM path (`Invoke-PocRunner.ps1 -Step Deploy`).** It makes the vault's
   private endpoint, but needs an existing VNet and adds a VM, a public IP and a NAT gateway
   that liteAPIM does not use.
3. **Create a liteAPIM-only VNet, only when the operator asks (`-CreateNetwork`).** A VNet
   (default `10.65.0.0/24`), a delegated `/27` for the workload-profiles Container Apps
   environment (U58), a `/28` for private endpoints, the vault's private endpoint and the
   `privatelink.vaultcore.azure.net` zone and link (reused when the zone exists). Each billable
   resource is printed before it is created. Without the switch, a resource group with no VNet
   is refused with a message naming it.
4. **Create that network automatically.** Simpler to run, but it adds billable resources the
   operator did not ask for.

For the Foundry: either require it beside APIM (excludes this gateway), or accept
`-FoundryResourceGroup`, reading the account with a scoped `existing` reference and assigning
liteAPIM's Reader role through a module deployed into the Foundry's resource group.

## Decision

Option 3, and the Foundry may be in another resource group.

- `Deploy-Console.ps1 -CreateNetwork` (Container Apps hosting only) deploys
  `infra/console-network.bicep`. Re-runs recognise the network by its name,
  `vnet-console-<suffix>`, and keep its address space. `-CreateNetwork` beside an existing
  gateway VNet is refused, so no second network is added there. `GATEWAY_VNET_NAME` is empty for
  a liteAPIM-only network: liteAPIM's VNet is not one the gateway can use for a private Foundry.
- `-FoundryResourceGroup` / `-FoundryAccountName` on `Deploy-Console.ps1`, and
  `-FoundryResourceGroup` on `Deploy-Poc.ps1`. A Foundry in the gateway's resource group keeps
  the same Reader assignment, under the same name; one elsewhere gets it from
  `infra/console-foundry-reader.bicep`. Installs in a single resource group pass exactly the
  previous template parameters: a what-if on 2026-10-26 against the Standard v2 install gave the
  same 15 changes for the old and the new `console.bicep`, and the same 25 for the old and the
  new `poc.bicep`.
- The usage workspace comes from the component the gateway's `hackgw-appinsights` logger
  writes to, not the first component listed.
- `Deploy-Console.ps1` refuses to repoint an app registration whose redirect URI belongs to
  another app unless `-TakeOverRegistration` is given, because `az ad app update
  --web-redirect-uris` replaces the list. Each install uses its own `-AppRegistrationName`.
- A Basic v2 gateway needs a Foundry with public network access, which APIM calls with its
  managed identity. A private Foundry needs Standard v2 or Premium v2 (ADR-0008, U23).

## Consequences

+ liteAPIM runs beside a Basic v2 gateway with the vault still private and no VM or NAT gateway.
+ Standard v2 installs deploy as before.
+ A second install cannot silently end sign-in on another install.
− `-CreateNetwork` adds a private endpoint (USD 0.01 per hour, about USD 7.30 per 730-hour month,
  plus USD 0.01 per GB) and, if new, a private DNS zone (USD 0.50 per month plus USD 0.40 per
  million queries) (Azure Retail Prices API, read 2026-10-26).
− The operator scripts that use the runner VM (`Invoke-PocRunner.ps1`) have no path to the vault
  in this layout; liteAPIM is the way to issue and rotate product keys there.
− Basic v2 allows 200 products and 15,000 subscriptions per instance, against 500 and 25,000 on
  Standard v2 (U56).
− Installing again after liteAPIM's app or job was deleted fails until the deleted identities'
  role assignments are removed, because the assignment names come from the resource ids
  (measured 2026-10-27; ROADMAP P65).

## How we'd know this was wrong

- liteAPIM's `/api/signing` or the automation job fails to reach the vault from the new VNet
  (U57). The P63 live run on 2026-10-27 measured both working.
- A redeploy of `console-network.bicep` on a network in use fails or drops `snet-console`.
- An install with a Foundry in another resource group gets a second Reader assignment, or none.
- An owner needs liteAPIM in an existing VNet that is not in the APIM's resource group; this
  ADR does not cover that.
