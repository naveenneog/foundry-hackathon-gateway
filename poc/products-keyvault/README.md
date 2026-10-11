# Long-lived keys on API Management products, with Key Vault (proof of concept)

Roadmap packet P37. Branch `poc/apim-products-keyvault` only; the gateway on `main` (signed
JWT keys, [ADR-0002](../../docs/adr/0002-credential-transport.md)) is unchanged.

The question: can API Management's own products and subscription keys give users keys that last
for months, with a token budget per key, rotated through Key Vault without breaking the clients
that hold them? Measured on Standard v2 on 2026-10-11. The final run passed 22 of 22 checks.

## Design

| Part | What it does | File |
|---|---|---|
| Product per model pack | Allows the pack's models only (`403 model_not_allowed` otherwise). Applies a monthly token budget per key, counted on the subscription, and a monthly pool per product | [`infra/product-policy.xml`](infra/product-policy.xml) |
| Routes | Claude (`/poc/claude`, key in `x-api-key`) and OpenAI-compatible (`/poc/v1`, key in `api-key`). Each runs the product policy first, refuses a key that has no product, calls Foundry with the gateway's managed identity and removes the key header before Foundry | [`infra/api-claude-policy.xml`](infra/api-claude-policy.xml), [`infra/api-openai-policy.xml`](infra/api-openai-policy.xml) |
| Probe | `/poc/probe/whoami` returns what the gateway knows about the calling key, without a backend call and without the key | [`infra/api-probe-policy.xml`](infra/api-probe-policy.xml) |
| Key Vault | One secret per key, `poc-key-<name>`, tagged with its subscription and slot. Azure RBAC, audit log to Log Analytics | [`infra/poc.bicep`](infra/poc.bicep) |
| Keys | Issue, rotate and expire keys. Keys move between API Management and Key Vault in memory, never printed or written to disk | [`scripts/PocKeys.ps1`](scripts/PocKeys.ps1), [`scripts/Invoke-PocKey.ps1`](scripts/Invoke-PocKey.ps1) |
| Runner | A VM inside the virtual network, for a vault that accepts only private traffic (see finding 5) | [`infra/runner.bicep`](infra/runner.bicep), [`scripts/Invoke-PocRunner.ps1`](scripts/Invoke-PocRunner.ps1) |
| Claude Code | `apiKeyHelper` reads the current key from Key Vault | [`claude-code/`](claude-code/) |

```
request   client --key--> API Management (Standard v2)
            product policy: model in the pack? -> per-key monthly budget -> product pool
            route policy:   key issued on a product? -> managed identity -> Foundry (private endpoint)

rotation  job: regenerate the slot clients do not hold -> list keys -> store as the secret's next version
          client (apiKeyHelper): read the latest version; the key it held works until the next rotation
```

## Results

Standard v2 test instance from [UNKNOWNS U23](../../docs/UNKNOWNS.md), with Foundry reachable
only through a private endpoint, using models `claude-haiku-4-5` and `deepseek-v4-flash`. Final
run `10111658`, 22 of 22 checks. Times run from just before each change (the issue, rotation,
suspension or reactivation request) until the gateway answered the same way five times in a
row, checked once a second.

| Check | Result |
|---|---|
| Claude-pack key, its model | 200, `x-budget-remaining` 199984 |
| Claude-pack key, another model | 403 `model_not_allowed` (Anthropic error shape) |
| Claude-pack key on the OpenAI route | 401 |
| DeepSeek-pack key, its model / a Claude model | 200 / 403 `model_not_allowed` (OpenAI error shape) |
| No key | 401 |
| All-access key, all-APIs key, key scoped to one API | 403 `product_required`; the probe shows `product: null` for the all-access key (U26) |
| 300-token monthly budget | 403 *"Token quota is exceeded. Try again in 20 days…"* after 8 calls and 672 real tokens. Earlier runs: 7 calls and 588 tokens; 9 calls and 756 tokens (twice) |
| Budget across a rotation | the spent key's rotated replacement refused for quota on 5 of 5 calls (4 of 5 in run `10111606`) (U28) |
| New key accepted | 6.4 s |
| Rotation | new key accepted at 1.5 s; the key clients held still accepted on 5 of 5 checks |
| Regenerated key refused | 5.7 s (its replacement accepted at 9.8 s) |
| Suspended key refused / reactivated key accepted | 1.4 s / 9.8 s |
| Expiry | not enforced by the gateway (still accepted 60 s after the stored date had passed); stored as a date only; `context.Subscription.EndDate` stays empty (U24) |
| Claude Code, key from Key Vault | answered |
| Claude Code session across two rotations | finished. Its first key read returned the old key version; the old key was refused from 9.2 s after the rotations began; the session's next read, 65 s after the first, returned the new version (U27) |
| New Claude Code session after the rotations | answered with the settings unchanged |
| Vault audit log | `SecretGet` 31 and `SecretSet` 23 by the runner's managed identity, over the private network; attempts over the public network logged as `Forbidden` (earlier runs) |

## What the runs showed

1. **Budgets are counted per gateway node, then reconciled.** On the 300-token budget the
   remaining-budget header read 216, 216, 132, 48, 0, 132, 48, 0 as real use reached 84, 168,
   252, 336, 420, 504, 588, 672 tokens. These are two interleaved countdowns, each 216, 132,
   48, 0, which fits two nodes each counting the calls they served. The 403 came after about
   twice the budget; in one run the call after the first 403 still passed, and in the final run
   refusals held at once. The policy reference says counts are kept "independently at each
   gateway"
   ([llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy)).
   It does not mention nodes within one gateway. The overshoot is about one budget per node,
   which is large against a small budget and small against a monthly one of 200,000 tokens.
2. **Key changes reach the nodes at different times.** A single check misled: a new key was
   accepted and then refused on the next call, and a regenerated key was refused and then
   accepted again. Agreement on all checks came 1.4–9.8 s after the request (U25).
3. **Keys without a product skip product policies, budgets included.** The route policy's
   `context.Product == null` check closes that path (U26). Any API added to a product without
   `<base />` first in its inbound section also skips the product's policies; the probe does
   this on purpose.
4. **Expiry is a job's work.** API Management stores only the date, refuses a date already past,
   refuses a new expiry on a suspended key (*"Only 'active' subscriptions can be renewed"*), and
   keeps accepting a key whose date has passed. `Suspend-ExpiredPocKeys` suspends keys from
   00:00 UTC on their stored date (U24).
5. **The vault had to be reached privately.** About ten minutes after the vault was created, an
   identity outside this project turned off its public network access. That setting was left as
   it is, and the template now creates the vault private (`vaultPublicNetworkAccess`, default
   `Disabled`). The scripts and Claude Code ran on a VM inside the virtual network, reaching the
   vault through a private endpoint. A client outside the network, such as a laptop, needs a
   private route to the vault in such a subscription.
6. **Anyone who can list a subscription's keys can read every key.** The action is
   `Microsoft.ApiManagement/service/subscriptions/listSecrets/action`, which API Management
   Service Contributor holds and the Reader and Operator roles do not
   ([permissions](https://learn.microsoft.com/azure/role-based-access-control/permissions/integration),
   [built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/integration)).
   The runner was given Contributor on the instance for this proof of concept; a custom role with
   only the subscription actions it calls is narrower. Anyone with Run Command on the runner VM
   can act as its identity, which can read every key in the vault and list the keys of every
   subscription on the instance, including the all-access one. The runner is therefore removed
   after a run.

## Running it

PowerShell 7 and the Azure CLI. `$t` names the target; every command passes the subscription
explicitly, and the CLI's default subscription is not changed.

```powershell
$t = @{ Subscription = '<subscription>'; ResourceGroup = '<rg>'; ApimName = '<v2 instance>' }

# Routes, products, vault, operator role (prints the vault name)
./scripts/Deploy-Poc.ps1 @t -FoundryAccountName <account> -AuditWorkspaceName <workspace>
$t.VaultName = '<vault>'

# Keys, from a machine that can reach the vault
./scripts/Invoke-PocKey.ps1 @t -Action New -Name alice -Product poc-claude-pack
./scripts/Invoke-PocKey.ps1 @t -Action Rotate -Name alice
./scripts/Invoke-PocKey.ps1 @t -Action SetExpiry -Name alice -ExpiresUtc 2027-01-31
./scripts/Invoke-PocKey.ps1 @t -Action SuspendExpired

# When the vault accepts only private traffic: the runner, then the measurement run
./scripts/Invoke-PocRunner.ps1 @t -Step Deploy      # also Setup, Push, Test, Fetch -From 1
./scripts/Test-Poc.ps1 @t                           # on a machine that can reach the vault
```

Claude Code: [`claude-code/settings.example.json`](claude-code/settings.example.json) uses
`az keyvault secret show` as the helper; on the runner it returned the 32-character key in
0.8 s. [`claude-code/Get-PocKey.ps1`](claude-code/Get-PocKey.ps1) is the helper the measurement
run used, because it records each call and the session check counts them.

## Removing it

```powershell
./scripts/Remove-Poc.ps1 @t -Runner -PurgeVault
```

This deletes the products with their keys, the routes, any leftover `poc-` keys, the runner (VM,
role assignments, subnet, NAT gateway, public IP, NSG, private endpoint) and the vault. The
`privatelink.vaultcore.azure.net` zone belongs to the resource group, so it is deleted only when
no other record is left in it. Each step's result is checked, and the script exits 1 if anything
was left behind.

The runner VM has no public IP and its subnet's NSG has no allow rules, so nothing reaches it
from the internet. Inside the virtual network, port 22 is open under Azure's default
AllowVnetInBound rule, but there is no login: password login is off and the SSH key is
discarded when the VM is deployed.

## Cost while deployed

The instance itself is not created here. The runner's VM is $0.0416 an hour (Standard_B2s, Linux)
and the NAT gateway's static IP $0.005 an hour (Azure Retail Prices API, eastus2, read
2026-10-11). The NAT gateway and the private endpoint add hourly and per-GB charges
([NAT gateway](https://azure.microsoft.com/pricing/details/azure-nat-gateway/),
[Private Link](https://azure.microsoft.com/pricing/details/private-link/)). Key Vault secret
operations are $0.03 per 10,000.

## Sources

- [Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions) (updated 2026-06-25)
- [llm-token-limit policy](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) (updated 2026-06-26)
- [Subscription REST API](https://learn.microsoft.com/rest/api/apimanagement/subscription) (api-version 2024-05-01)
- [Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual) (updated 2026-07-08)
- [Claude Code settings reference, apiKeyHelper](https://code.claude.com/docs/en/settings-reference) (read 2026-10-11)
- Measurements: [UNKNOWNS U24–U28](../../docs/UNKNOWNS.md)
