# Architecture and design flow: API Management products with Key Vault (proof of concept)

This document describes how the proof of concept on branch `poc/apim-products-keyvault` is put
together and how a request and a key move through it. Setup steps are in [SETUP.md](SETUP.md)
(scripts) and [PORTAL.md](PORTAL.md) (Azure portal); measured results are in
[README.md](README.md). The gateway on `main` uses signed JWT keys instead
([ADR-0002](../../docs/adr/0002-credential-transport.md)).

## Components

| Component | What it is | Role in the design | Defined in |
|---|---|---|---|
| API Management instance | An existing instance on a v2 tier, with a system-assigned managed identity | Accepts client requests, checks keys, applies budgets, calls Foundry | Existing; [`infra/poc.bicep`](infra/poc.bicep) references it |
| Routes (APIs) | `poc-claude`, `poc-openai`, `poc-probe` | One base URL per client protocol. The Claude and OpenAI-compatible routes refuse keys without a pack and call Foundry with the managed identity; the probe answers in its own policy, for any valid key | `routes` in [`infra/poc.bicep`](infra/poc.bicep); [`api-claude-policy.xml`](infra/api-claude-policy.xml), [`api-openai-policy.xml`](infra/api-openai-policy.xml), [`api-probe-policy.xml`](infra/api-probe-policy.xml) |
| Packs (products) | `poc-claude-pack`, `poc-deepseek-pack`, `poc-tiny-pack` | Each holds a list of models, a monthly budget per key, a monthly pool and a per-minute limit per key | `products` in [`infra/poc.bicep`](infra/poc.bicep); [`product-policy.xml`](infra/product-policy.xml) |
| Keys (subscriptions) | `poc-<name>`, each scoped to one pack, with a primary and a secondary key | A user's credential. Its state (active or suspended) and stored expiry date live here | Created by [`scripts/PocKeys.ps1`](scripts/PocKeys.ps1) |
| Foundry account | An existing account with the model deployments | Serves the models, reached through a private endpoint ([U23](../../docs/UNKNOWNS.md)) | Existing |
| Key Vault | `kv-poc-<hash>`, Azure RBAC, public network access `Disabled`, firewall default Deny with the trusted-services bypass off (`bypass: 'None'`) | One secret per key, `poc-key-<name>`; each version is the key clients get after a rotation | [`infra/poc.bicep`](infra/poc.bicep) |
| Vault private endpoint | Private endpoint in subnet `snet-pe`, zone `privatelink.vaultcore.azure.net`, created with the runner (`Invoke-PocRunner.ps1 -Step Deploy`) and removed by `Remove-Poc.ps1 -Runner` | With public access disabled and the trusted-services bypass off, the only network path to the vault | [`infra/runner.bicep`](infra/runner.bicep) |
| Runner VM | Ubuntu VM in subnet `snet-poc-runner`, outbound through a NAT gateway, no public IP; deployed with the private endpoint and removed with it | Runs the key scripts inside the network, driven through Run Command | [`infra/runner.bicep`](infra/runner.bicep), [`scripts/Invoke-PocRunner.ps1`](scripts/Invoke-PocRunner.ps1) |
| Log Analytics workspace (optional) | An existing workspace | Receives the vault's audit log: who read or wrote which key | `vaultAudit` in [`infra/poc.bicep`](infra/poc.bicep) |
| Operator scripts | PowerShell 7 with the Azure CLI's tokens | Issue, hand over, rotate, expire, suspend, list and remove keys over the two REST APIs | [`scripts/`](scripts/) |

The routes, with the header each one reads the key from:

| Route | Path | Key header | Backend | Operations |
|---|---|---|---|---|
| `poc-claude` | `poc/claude` | `x-api-key` | Foundry, Anthropic Messages API | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| `poc-openai` | `poc/v1` | `api-key` | Foundry, OpenAI-compatible `/openai/v1` | `POST /chat/completions` |
| `poc-probe` | `poc/probe` | `x-api-key` | none: the policy answers | `GET /whoami` |

Each route also accepts the key in a `subscription-key` query parameter (roadmap P42).

## Identities and roles

| Identity | Role | Scope | Used for |
|---|---|---|---|
| The instance's system-assigned managed identity | Cognitive Services User | Foundry account | Calling the models; token audience `https://ai.azure.com` |
| Operator | Key Vault Secrets Officer | Vault (the template assigns it) | Writing each key into its secret, reading the slot tag |
| Operator | API Management Service Contributor, or a custom role with the subscription actions the scripts call (read, create, list keys, regenerate, update, delete) | Instance | Creating keys, reading and regenerating them, changing their state and expiry, and deleting them on removal ([finding 6](README.md#what-the-runs-showed)) |
| Operator | Owner, User Access Administrator or Role Based Access Control Administrator | Resource group | Assigning and removing the per-secret read role (`Grant`, `Revoke`, removal) |
| Runner VM's managed identity | Key Vault Secrets Officer; API Management Service Contributor | Vault; instance | The key scripts on the runner |
| Developer | Key Vault Secrets User | One secret, `poc-key-<name>` | Claude Code's `apiKeyHelper` reading the current key ([U30](../../docs/UNKNOWNS.md)) |

No Foundry key exists in the design: the gateway authenticates to Foundry with its managed
identity. Both key headers are removed before the call; a key sent in the `subscription-key`
query parameter is passed on to Foundry (roadmap P42).

## Network paths

```
  client (Claude Code, SDK, opencode, curl)
     |  HTTPS, key in x-api-key or api-key
     v
  API Management (public gateway endpoint)
     |  outbound virtual network integration
     v
  virtual network --- private endpoint --> Foundry account (public access Disabled)
                  \-- private endpoint --> Key Vault (public access Disabled)
                         ^          ^
                         |          |  apiKeyHelper (Key Vault data plane)
     runner VM ----------/          developer machine on the private network
     (snet-poc-runner, NAT outbound only)

  operator --> Azure Resource Manager (management.azure.com, public):
               products, routes, keys (subscriptions), role assignments
```

| Path | Network | Needs a path to the vault |
|---|---|---|
| Client to gateway | Internet, HTTPS | No |
| Gateway to Foundry | Virtual network integration and the Foundry private endpoint ([docs/PRIVATE-ENDPOINT.md](../../docs/PRIVATE-ENDPOINT.md)) | No |
| Issue and rotate a key (`New`, `Rotate`) | Resource Manager plus the vault's data plane | Yes |
| `Grant`, `Revoke`, `List`, `Suspend`, `Resume`, `SetExpiry`, removal | Resource Manager only | No |
| Claude Code's `apiKeyHelper` | The vault's data plane | Yes |

## Request flow

```
client          API Management                                         Foundry
  |  request + key  |                                                     |
  |---------------->| 1 key -> subscription -> pack (401 if unknown,      |
  |                 |   suspended or not on this route)                   |
  |                 | 2 pack policy (runs first, through <base />):       |
  |                 |   a model in the pack?           else 403           |
  |                 |   per-key monthly budget          else 403          |
  |                 |   per-key tokens per minute       else 429          |
  |                 |   pack's monthly pool             else 403          |
  |                 | 3 route policy:                                     |
  |                 |   key issued on a pack?  else 403 product_required  |
  |                 |   managed-identity token -> Authorization           |
  |                 |   x-api-key and api-key headers removed             |
  |                 |---------------------------------------------------->|
  |                 |<----------------------------------------------------|
  |                 | 4 tokens in the response counted against both       |
  |<----------------|   budgets; x-budget-remaining set                   |
```

1. API Management finds the key's subscription and its product. A missing, wrong or suspended
   key, or a key whose pack does not include the route, gets 401
   ([results](README.md#results)).
2. The pack's policy reads `model` from the request body and refuses a model outside the pack
   with 403 `model_not_allowed`. Two `llm-token-limit` policies follow: one counted on
   `context.Subscription.Id` (the key's monthly budget and per-minute limit), one on the pack
   (the monthly pool). A spent budget returns 403, a spent per-minute limit 429
   ([llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy)).
   The policy reports the remaining budget in `x-budget-remaining` and the per-minute count in
   `x-ratelimit-remaining-tokens` (roadmap P40).
3. The route's policy refuses a key that has no pack, which skipped every pack policy above
   ([U26](../../docs/UNKNOWNS.md)), then replaces `Authorization` with a managed-identity token
   for `https://ai.azure.com` and removes both key headers.
4. Foundry answers. The token counts in its response are added to both counters.

The probe route answers in its own policy, without `<base />` in its inbound section, so it calls
no model and counts no tokens.

## Key lifecycle

Each key is two linked records: the subscription `poc-<name>` in API Management and the secret
`poc-key-<name>` in Key Vault. The secret's tags are `slot` (`primary` or `secondary`: which of
the subscription's two keys clients hold), `subscription` and `product`.

### Issue

```
operator script                 API Management                    Key Vault
  | PUT subscription poc-<name>      |                                 |
  |   scope /products/<pack>, active |                                 |
  |--------------------------------->|                                 |
  | POST .../listSecrets             |                                 |
  |--------------------------------->|                                 |
  |<----- primary and secondary -----|                                 |
  | PUT secret poc-key-<name> = primary, tags slot=primary, ...        |
  |------------------------------------------------------------------->|
```

The key exists only in memory between the two calls; nothing is printed or written to disk. The
gateway accepted a new key 6.4 s after the request ([results](README.md#results)).

### Hand over

- **Read access.** `Grant` assigns Key Vault Secrets User on the one secret, by object id,
  through Resource Manager. The developer's Claude Code runs `apiKeyHelper` (`az keyvault secret
  show`), caches the output for five minutes, and runs it again after a 401 or 403
  ([settings reference](https://code.claude.com/docs/en/settings-reference)). A grant on the
  secret covers every later version of it.
- **One-time copy.** The operator reads the key once, from the vault or from API Management's
  `listSecrets`, and passes it on. A copy works through one rotation and is refused after the
  second.

### Rotate

```
operator script                 Key Vault                        API Management
  | GET poc-key-<name>              |                                  |
  |-------------------------------->|                                  |
  |<--- slot=primary (clients hold the primary key)                    |
  | POST .../regenerateSecondaryKey                                    |
  |------------------------------------------------------------------->|
  | POST .../listSecrets                                               |
  |------------------------------------------------------------------->|
  | PUT poc-key-<name> = secondary, slot=secondary (a new version)     |
  |-------------------------------->|                                  |
```

The script regenerates the slot clients do not hold, so the key they hold keeps working until the
next rotation; without a `slot` tag it stops before regenerating anything. This is the two-key
pattern in
[Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual).
The budget is counted on the subscription, so it carries across a rotation
([U28](../../docs/UNKNOWNS.md)); a Claude Code session reading through `apiKeyHelper` continued
across two rotations ([U27](../../docs/UNKNOWNS.md)).

### Expire

`SetExpiry` stores a date on the subscription. API Management keeps only the date, refuses one
already past, and keeps accepting the key after it ([U24](../../docs/UNKNOWNS.md)). `SuspendExpired`
lists the keys on `poc-` packs and suspends each active one from 00:00 UTC on its stored date, so
expiry is enforced by running that action on a schedule.

### Suspend and resume

`Suspend` and `Resume` change the subscription's state. A suspended key was refused (401) from
1.4 s after the request, and a resumed key accepted again from 9.8 s ([U25](../../docs/UNKNOWNS.md)).
The key's value and its secret do not change.

### Revoke

`Revoke` lists the role assignments that apply to the secret and deletes the identity's Key Vault
Secrets User assignment at exactly that scope. Other roles, other identities and wider scopes stay.
The key itself keeps working; `Suspend` stops it.

### Remove

[`Remove-Poc.ps1`](scripts/Remove-Poc.ps1) deletes the packs with their keys, the routes and any
other `poc-` key, then every role assignment on the vault's key secrets (listed at the resource
group, which also works after the vault is gone), and only then the vault. While an assignment
cannot be listed or removed, or the vault cannot be read, the vault is kept and the script exits 1:
an assignment names the secret's path, which a vault created again under the same name would reuse.

## Design decisions

| Decision | Reason | Consequence |
|---|---|---|
| API Management subscription keys rather than signed JWT keys | The question of P37: long-lived keys with the gateway's own suspension and two-key rotation, and no signing secret | A key is a bearer secret held by API Management; anyone with `listSecrets` on the instance can read every key ([finding 6](README.md#what-the-runs-showed)) |
| One product per model pack | A product policy runs for every key on the product, so the model list and budgets are set once per pack | A user with two packs holds two keys |
| Budget counted on `context.Subscription.Id` | The subscription outlives its keys | The budget carries across rotation ([U28](../../docs/UNKNOWNS.md)) |
| `<base />` first in each route, and a `product_required` check | Keys without a product (all-access, all-APIs, single-API) skip product policies ([U26](../../docs/UNKNOWNS.md)) | Only keys issued on a pack reach a model |
| Managed identity to Foundry, key headers removed | The client's key is not a Foundry credential, and a subscription key "is by default passed to the backend and might be exposed in backend monitoring logs" unless a policy removes it ([Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions)) | No Foundry key exists to leak or rotate. The query parameter is not removed yet (roadmap P42) |
| Key Vault holds the current key, with a `slot` tag | Clients and the rotation job need one place that says which key is current | Rotation never invalidates the key clients hold; a wrong guess would have, so a missing tag stops it |
| Read access per secret (`Grant`) | Each developer reads only their own key ([U30](../../docs/UNKNOWNS.md)) | Microsoft recommends vault-scope roles except where "individual secrets require individual user access" ([Key Vault RBAC](https://learn.microsoft.com/azure/key-vault/general/rbac-guide)) |
| Vault public network access `Disabled` by default | An identity outside the project turned it off about ten minutes after the vault was created ([finding 5](README.md#what-the-runs-showed)), and a redeploy does not reopen it | Issuing and rotating keys, and `apiKeyHelper`, need a private path; the runner VM provides one |
| Expiry enforced by a scheduled job | The gateway does not enforce a subscription's expiry date ([U24](../../docs/UNKNOWNS.md)) | A key is usable until the next `SuspendExpired` run after its date |
| Scripts on the two REST APIs with the Azure CLI's tokens | Keys stay in memory; names are validated before they reach a URL or a shell | The one-time copies are `az` commands outside the scripts, because the scripts print no key |

## Measured behaviour

| Behaviour | Measured | Source |
|---|---|---|
| A monthly budget is counted per gateway node and reconciled later; a 300-token budget let 588–756 tokens through | Standard v2, 2026-10-11 | [finding 1](README.md#what-the-runs-showed) |
| Key changes reach the nodes at different times: 1.4–9.8 s until five checks in a row agree | Standard v2, 2026-10-11 | [U25](../../docs/UNKNOWNS.md) |
| The gateway keeps accepting a key after its expiry date | Standard v2, 2026-10-11 | [U24](../../docs/UNKNOWNS.md) |
| The budget carries across a rotation | Standard v2, 2026-10-11 | [U28](../../docs/UNKNOWNS.md) |
| A read role on one secret applied within 48 s and did not extend to other secrets | 2026-10-12 | [U30](../../docs/UNKNOWNS.md) |
| A Foundry deployment's per-minute limit is shared by every key on it; one opencode prompt is 64.5 KB | 2026-10-12 | [U29](../../docs/UNKNOWNS.md) |

## Limits

- A small budget can be overshot by about one budget per gateway node (finding 1).
- `listSecrets` on the instance reads every key, including the all-access key (finding 6).
- Anyone with Run Command on the runner VM can act as its identity, so the runner is removed after
  a run ([README](README.md#removing-it)).
- The per-key per-minute header overwrites Foundry's header of the same name (roadmap P40).
- `Remove-Poc.ps1` deletes the three default packs by name (roadmap P41).
- API Management also accepts a key in a URL query parameter (roadmap P42).
- Deployment and the runner's `Deploy`, `Setup` and `Push` steps have no offline tests; they were
  run live in P37.

## Sources

Read 2026-10-12; the dates are each page's last update.

- [Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions) (2026-06-25)
- [llm-token-limit policy](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) (2026-06-26)
- [Azure RBAC for Key Vault](https://learn.microsoft.com/azure/key-vault/general/rbac-guide) (2026-08-21)
- [Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual) (2026-07-08)
- [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference) (Anthropic, 2026-10-11)
- Measurements: [README results](README.md#results); [UNKNOWNS](../../docs/UNKNOWNS.md) U23–U30
