# Setup and usage: API Management products with Key Vault (proof of concept)

This guide covers deploying the proof of concept onto an existing API Management v2 instance,
operating its keys, and connecting clients. It applies to branch `poc/apim-products-keyvault`
only; the gateway on `main` issues signed JWT keys instead
([ADR-0002](../../docs/adr/0002-credential-transport.md)). Design and measured results are in
[README.md](README.md).

Commands are PowerShell 7, run from `poc/products-keyvault/`. They name the target explicitly
and leave the Azure CLI's default subscription unchanged:

```powershell
$target = @{ Subscription = '<subscription>'; ResourceGroup = '<resource-group>'; ApimName = '<apim-name>' }
$vault = '<vault-name>'    # printed by Deploy-Poc.ps1
```

## Requirements

| Requirement | Reason |
|---|---|
| PowerShell 7 and the Azure CLI, signed in | The scripts call API Management and Key Vault with the CLI's tokens; `Deploy-Poc.ps1` deploys a Bicep file with `az deployment group create` |
| An API Management instance on a v2 tier, with a system-assigned managed identity | `llm-token-limit` meters the Anthropic Messages API only on v2 tiers ([UNKNOWNS U12](../../docs/UNKNOWNS.md)). Measured on Standard v2 |
| A Foundry account in the same resource group, on which the instance's identity holds Cognitive Services User | The routes call Foundry with that identity ([`infra/poc.bicep`](infra/poc.bicep), parameter `foundryAccountName`) |
| Model deployments named as in the packs: `claude-haiku-4-5` and `deepseek-v4-flash` by default | A pack lists deployment names, and requests for other models are refused |
| A per-minute token limit on each deployment above the largest single request | All keys on a deployment share its limit. One opencode prompt (64.5 KB) was refused at 10,000 tokens a minute and answered at 50,000 ([U29](../../docs/UNKNOWNS.md)) |
| The operator can deploy to the resource group and create role assignments | The template gives the operator Key Vault Secrets Officer on the vault. Creating a role assignment needs `Microsoft.Authorization/roleAssignments/write`, held by Owner, User Access Administrator and Role Based Access Control Administrator ([built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged)) |
| The operator can read subscription keys | `listSecrets` is held by API Management Service Contributor; the Reader and Operator roles lack it ([finding 6](README.md#what-the-runs-showed)) |
| A network path to the vault, for issuing and rotating keys and for the Claude Code helper | The vault is created with public network access `Disabled` (`vaultPublicNetworkAccess`). The path is a private endpoint inside the virtual network, or the runner VM below |
| Optional: a Log Analytics workspace in the resource group | Receives the vault's audit log: who read or wrote which key |

## Set up

### Model packs

Each entry of `products` in [`infra/poc.bicep`](infra/poc.bicep) becomes one product:

| Field | Meaning | Default packs: Claude, DeepSeek, tiny |
|---|---|---|
| `id` | Product id, starting `poc-` | `poc-claude-pack`, `poc-deepseek-pack`, `poc-tiny-pack` |
| `displayName` | Product name shown in API Management | `POC: Claude pack`; `POC: DeepSeek pack`; `POC: tiny budget` |
| `routes` | Routes in the product: `poc-claude`, `poc-openai` | `poc-claude`; `poc-openai`; `poc-claude` |
| `models` | Deployment names a key may call | `claude-haiku-4-5`; `deepseek-v4-flash`; `claude-haiku-4-5` |
| `keyTokens` | Tokens per key per calendar month (UTC) | 200,000; 200,000; 300 |
| `poolTokens` | Tokens per product per calendar month, shared by its keys | 2,000,000; 2,000,000; 100,000 |
| `tpm` | Tokens per key per minute | 20,000 each |

The tiny pack exists to measure a spent budget. A deployment is incremental: a pack removed from
the list stays on the instance
([deployment modes](https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes)).

### Deploy

```powershell
./scripts/Deploy-Poc.ps1 @target -FoundryAccountName <foundry-account> -AuditWorkspaceName <workspace>
```

[`Deploy-Poc.ps1`](scripts/Deploy-Poc.ps1) adds the routes `poc-claude`, `poc-openai` and
`poc-probe`, the products with their policies, the vault (Azure RBAC, public network access
`Disabled`) and the operator's Key Vault Secrets Officer role. It prints the vault name and the
route URLs. A new role assignment can take a few minutes to apply. Without
`-AuditWorkspaceName` the vault has no audit log.

### Vault access through the runner

When the machine running the scripts cannot reach the vault, a VM inside the virtual network
runs them ([`infra/runner.bicep`](infra/runner.bicep),
[`scripts/Invoke-PocRunner.ps1`](scripts/Invoke-PocRunner.ps1)). Every step goes through Azure
Run Command:

```powershell
./scripts/Invoke-PocRunner.ps1 @target -VaultName $vault -Step Deploy   # private endpoint, DNS zone, NAT gateway, subnet, VM
./scripts/Invoke-PocRunner.ps1 @target -VaultName $vault -Step Setup    # Azure CLI, PowerShell, Node.js, Claude Code; CLI signed in as the VM
./scripts/Invoke-PocRunner.ps1 @target -VaultName $vault -Step Push     # key scripts to /opt/poc, compared by SHA-256
```

The virtual network (`-VnetName`, default `vnet-hackgw-pe`) needs a subnet `snet-pe` for the
vault's private endpoint and a free range `10.61.4.0/27` for the runner's subnet; both are
`runner.bicep` defaults. The VM's identity holds Key Vault Secrets Officer on the vault and API
Management Service Contributor on the instance. Anyone with Run Command on the VM can act as that
identity ([finding 6](README.md#what-the-runs-showed)); `Remove-Poc.ps1 -Runner` removes it. Cost
while deployed: [README](README.md#cost-while-deployed).

### Check

`./scripts/Test-PocClients.ps1 @target` runs every client command and example in this guide
against the gateway, with two temporary keys it deletes afterwards
([Connect a client](#connect-a-client)). `-Plan` lists its checks without calling Azure.

## Issue a key

```powershell
./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action New -Name alice -Product poc-claude-pack
```

| Result | Value |
|---|---|
| API Management subscription | `poc-alice`, on the product, active |
| Key Vault secret | `poc-key-alice`, tagged `slot=primary`, `subscription` and `product` |
| Output | Names only. The key is not printed or written to disk |
| Accepted by the gateway | 6.4 s after the request, five checks in a row ([results](README.md#results)) |

A name is 1 to 40 lowercase letters, digits and hyphens. The same action on the runner:

```powershell
./scripts/Invoke-PocRunner.ps1 @target -VaultName $vault -Step Key -KeyAction New -KeyName alice -KeyProduct poc-claude-pack
```

`-Step Key` takes `-KeyAction` (`New`, `Rotate`, `SetExpiry`, `SuspendExpired`, `Suspend`,
`Resume` or `List`), `-KeyName`, `-KeyProduct` and `-KeyExpiresOn` (`yyyy-MM-dd`), and prints no
key. Run Command returns the last 4,096 bytes of the VM's output, so a long key list loses its
first lines.

## Hand a key over

| | Read access to the secret | One-time copy |
|---|---|---|
| How | `Grant`: Key Vault Secrets User on the one secret. Claude Code reads it through `apiKeyHelper` ([Claude Code](#claude-code)) | The operator reads the key once and passes it on |
| The developer needs | An Azure sign-in and a network path to the vault | The key |
| After a rotation | The helper reads the new version ([U27](../../docs/UNKNOWNS.md)) | The key works through one rotation and is refused after the second |
| Vault that accepts private traffic only | The developer's machine reaches the vault through the private network | The key is read from API Management, which needs no path to the vault |

Read access to one secret:

```powershell
./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action Grant -Name alice -ObjectId <object-id>
```

`-PrincipalType` is `User` (the default), `Group` or `ServicePrincipal`. `Grant` assigns the role
through Azure Resource Manager, so it needs no network path to the vault, and it names the
identity by object id, so it makes no Microsoft Graph lookup. Granting the same identity again
reports that it already has access. Measured on 2026-10-12 with a managed identity that held only
this role: it read its secret 48 s after the grant, and was refused (`Forbidden`) another secret
and the list of secrets ([U30](../../docs/UNKNOWNS.md)). Microsoft recommends roles at vault scope,
with an exception where "individual secrets require individual user access"
([Key Vault RBAC](https://learn.microsoft.com/azure/key-vault/general/rbac-guide), updated
2026-08-21).

A one-time copy from the vault, where the vault is reachable. It prints the key:

```powershell
az keyvault secret show --vault-name $vault --name poc-key-alice --query value -o tsv
```

A one-time copy from API Management, which needs no path to the vault. It prints the key:

```powershell
az rest --method post --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.ApiManagement/service/<apim-name>/subscriptions/poc-alice/listSecrets?api-version=2024-05-01" --query primaryKey -o tsv
```

Clients get the primary key after `New`. Each `Rotate` prints the slot Key Vault then holds
(*"Key Vault now holds the new secondary key"*), which `--query secondaryKey` reads. The vault
copy is the settings example's helper command, which returned the key on the runner on
2026-10-11 ([README](README.md#running-it)). The API Management copy returned a 32-character key
on 2026-10-12 from a machine with no path to the vault. The copies are `az` commands rather than
script actions because the scripts print no key.

## Rotate a key

```powershell
./scripts/Invoke-PocKey.ps1 @target -VaultName $vault -Action Rotate -Name alice
```

Each API Management subscription has two keys, primary and secondary. The secret's `slot` tag
records which one clients hold. A rotation regenerates the other slot and stores its new key as
the secret's next version, with the tag switched, so the key clients hold keeps working until
the following rotation. Without a `slot` tag the rotation stops before regenerating anything.
This is the pattern in
[Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual).

| Measured, run `10111658` | Result |
|---|---|
| New key accepted | 1.5 s after the rotation |
| Key clients held | still accepted, 5 of 5 checks |
| Budget | carried over: a spent key's replacement was refused for quota ([U28](../../docs/UNKNOWNS.md)) |
| Claude Code session reading the key through `apiKeyHelper` | continued across two rotations ([U27](../../docs/UNKNOWNS.md)) |

## Expire a key

```powershell
./scripts/Invoke-PocKey.ps1 @target -Action SetExpiry -Name alice -ExpiresUtc 2027-01-31
./scripts/Invoke-PocKey.ps1 @target -Action SuspendExpired
```

API Management stores an expiry as a date only, refuses a date already past, and keeps
accepting a key after its date ([U24](../../docs/UNKNOWNS.md)). `SuspendExpired` suspends every
active key on a `poc-` product from 00:00 UTC on its stored date: a key set to 2027-01-31 is
suspended by the first run at or after 2027-01-31 00:00 UTC. It acts only when run, so a daily
schedule bounds the overrun to a day. A new date can be set on an active key only (*"Only
'active' subscriptions can be renewed"*), so a suspended key is resumed first. Neither action
uses the vault.

## Suspend and resume a key

```powershell
./scripts/Invoke-PocKey.ps1 @target -Action Suspend -Name alice
./scripts/Invoke-PocKey.ps1 @target -Action Resume -Name alice
```

A suspended key was refused (401) from 1.4 s after the request, and a resumed key accepted again
from 9.8 s ([U25](../../docs/UNKNOWNS.md)). The key's value does not change. Neither action uses
the vault.

## List keys

```powershell
./scripts/Invoke-PocKey.ps1 @target -Action List
```

One row per key on a `poc-` product: `Name` (the subscription, `poc-<name>`), `Product`, `State`
and `Expires` (a date). It reads subscriptions only, fetches no key and does not use the vault.

## Monitor

| Question | Where | Notes |
|---|---|---|
| Budget left for a key this month | `x-budget-remaining` response header | Counted per gateway node and reconciled later. It lags, and a key can overshoot by about one budget per node ([finding 1](README.md#what-the-runs-showed)) |
| Tokens left for a key this minute | `x-ratelimit-remaining-tokens` response header | The product policy's count. It replaces Foundry's header of the same name ([U29](../../docs/UNKNOWNS.md), roadmap P40) |
| The model deployment's limits | `x-ratelimit-limit-tokens`, `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests` | From Foundry, and shared by every key on the deployment |
| What the gateway knows about a key | `GET /poc/probe/whoami` | Subscription, product and dates; no model call and no tokens |
| State and expiry of every key | `Invoke-PocKey.ps1 -Action List` | |
| Who read or wrote which key | The vault's audit log, query below | Needs `-AuditWorkspaceName` at deployment |

The audit query, for the workspace's Logs page. It returned the proof of concept's reads and
writes per secret on 2026-10-12:

```kusto
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT" and OperationName in ("SecretGet", "SecretSet")
| extend secret = tostring(split(id_s, "/")[4])
| summarize reads = countif(OperationName == "SecretGet"), writes = countif(OperationName == "SecretSet"), lastSeen = max(TimeGenerated) by secret, caller = identity_claim_oid_g, result = ResultSignature
| order by lastSeen desc
```

`caller` is the object id of the identity that read or wrote the secret; `CallerIPAddress` holds
its network address.

## Connect a client

| Route | Base URL | Key header | Clients |
|---|---|---|---|
| Claude (Anthropic Messages API) | `https://<apim-name>.azure-api.net/poc/claude` | `x-api-key` | Claude Code, Anthropic SDK, opencode (`/poc/claude/v1`), curl |
| OpenAI-compatible (chat completions) | `https://<apim-name>.azure-api.net/poc/v1` | `api-key` | OpenAI SDK, opencode, curl |

A key works on its product's routes (a Claude-pack key on the OpenAI route gets 401) and for its
pack's models (other models get 403 `model_not_allowed`). The gateway reads the key from the
header in the table, or from a `subscription-key` query parameter (`subscriptionKeyParameterNames`
in [`infra/poc.bicep`](infra/poc.bicep); roadmap P42). It does not read keys from
`Authorization`, which it replaces with its own credential before calling Foundry.

The examples read the gateway and the key from two environment variables. Typing the key at a
prompt keeps it out of the shell's history file:

```powershell
$env:POC_GATEWAY = 'https://<apim-name>.azure-api.net'
$env:POC_KEY = Read-Host -MaskInput 'Key'
```

```bash
export POC_GATEWAY='https://<apim-name>.azure-api.net'
printf 'Key: ' && read -rs POC_KEY && echo && export POC_KEY
```

PSReadLine leaves a command line out of its history file only when it contains `password`,
`asplaintext`, `token`, `apikey` or `secret`
([about_PSReadLine](https://learn.microsoft.com/powershell/module/psreadline/about/about_psreadline),
updated 2026-06-16), so `$env:POC_KEY = '…'` typed with the key is saved there. `read -s`
does not echo the input ([Bash builtins](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)).

The probe answers for any key without calling a model. For a key issued as `alice` on the Claude
pack:

```bash
curl -sS --fail-with-body -H "x-api-key: $POC_KEY" "$POC_GATEWAY/poc/probe/whoami"
```

```json
{
  "subscription": "poc-alice",
  "product": "poc-claude-pack",
  "startDate": null,
  "endDate": null,
  "utcNow": "2026-10-12T10:05:33.7011592Z"
}
```

`product` is `null` for a key not issued on a product, and the model routes refuse such keys
([U26](../../docs/UNKNOWNS.md)). `endDate` stays empty even when an expiry is set
([U24](../../docs/UNKNOWNS.md)).

[`scripts/Test-PocClients.ps1`](scripts/Test-PocClients.ps1) runs the probe and every example below
against the gateway, and a test checks that each file shown here matches the file it runs. Last
run: 2026-10-12, 11 of 11.

### Claude Code

With `apiKeyHelper`, Claude Code reads the key from Key Vault, so a rotation reaches it without a
change on the developer's machine:

<!-- file: claude-code/settings.example.json -->
```json
{
  "apiKeyHelper": "az keyvault secret show --vault-name <vault-name> --name poc-key-<name> --query value -o tsv",
  "env": {
    "ANTHROPIC_BASE_URL": "https://<apim-name>.azure-api.net/poc/claude",
    "ANTHROPIC_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  }
}
```

The file goes in `~/.claude/settings.json`, or in a separate folder named by
`CLAUDE_CONFIG_DIR`, which keeps a developer's own settings apart. `<vault-name>`, `<name>` and
`<apim-name>` take real values. The helper command needs the Azure CLI signed in to the vault's
tenant, read access to the secret and a network path to the vault; for a vault in another
tenant, [`claude-code/Get-PocKey.ps1`](claude-code/Get-PocKey.ps1) takes `-Subscription`. Claude
Code caches the helper's output for five minutes and runs it again after a 401 or 403
([settings reference](https://code.claude.com/docs/en/settings-reference), read 2026-10-12).
Claude Code uses the first credential it finds in this order: a cloud provider
(`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` set),
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, then `apiKeyHelper`
([authentication precedence](https://code.claude.com/docs/en/authentication)). With any of the
first four set, the helper is not used. `Test-PocClients.ps1` runs this file with the helper
replaced by one that prints `POC_KEY`, and a control with a wrong key that has to be refused.
The `az` command itself returned the key in 0.8 s on the runner.

A fixed key, from environment variables, in PowerShell:

<!-- file: examples/claude-code-env.ps1 -->
```powershell
# Claude Code through the gateway's Claude route, with the key in an environment variable, for
# PowerShell. Reads POC_GATEWAY and POC_KEY; claude is started afterwards in the same session.
# Run by scripts/Test-PocClients.ps1; see SETUP.md.
$env:ANTHROPIC_BASE_URL = "$env:POC_GATEWAY/poc/claude"
$env:ANTHROPIC_API_KEY = $env:POC_KEY
$env:ANTHROPIC_MODEL = 'claude-haiku-4-5'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5'
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
```

Then `claude` in the same session. Without `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, Claude
Code 2.1.272 sent the pre-release `anthropic-beta` value `advisor-tool-2026-03-01` on this path
and Foundry answered 400 ([U17](../../docs/UNKNOWNS.md)). Claude Code documents the variable for
gateways that reject such values
([environment variables](https://code.claude.com/docs/en/env-vars)). In an interactive session
Claude Code asks once whether to use `ANTHROPIC_API_KEY`
([authentication](https://code.claude.com/docs/en/authentication)). Both model variables name
models in the key's pack.

`Test-PocClients.ps1` runs both Claude Code examples with the variables above cleared first and
with a new, empty `CLAUDE_CONFIG_DIR`, because settings in an existing configuration folder can
override them.

### Anthropic SDK

Python, with `pip install anthropic`:

<!-- file: examples/anthropic_sdk.py -->
```python
"""A Claude model through the gateway's Claude route, with the Anthropic SDK for Python.

The SDK sends its api_key in the x-api-key header, which is where the route reads the
subscription key. Run by scripts/Test-PocClients.ps1; see SETUP.md.

Environment:
    POC_GATEWAY  https://<apim-name>.azure-api.net
    POC_KEY      a key issued on a product whose pack includes the model below
"""
import os

import anthropic

client = anthropic.Anthropic(
    base_url=os.environ["POC_GATEWAY"] + "/poc/claude",
    api_key=os.environ["POC_KEY"],
)
message = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=16,
    messages=[{"role": "user", "content": "Reply with exactly: OK"}],
)
print(message.content[0].text)
```

### OpenAI SDK

Python, with `pip install openai`:

<!-- file: examples/openai_sdk.py -->
```python
"""A model through the gateway's OpenAI-compatible route, with the OpenAI SDK for Python.

The route reads the subscription key from the api-key header, added here as a default header.
The SDK also requires api_key and sends it as Authorization: Bearer; the gateway replaces that
header with its own credential before it calls Foundry, so any value works. Run by
scripts/Test-PocClients.ps1; see SETUP.md.

Environment:
    POC_GATEWAY  https://<apim-name>.azure-api.net
    POC_KEY      a key issued on a product whose pack includes the model below
"""
import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ["POC_GATEWAY"] + "/poc/v1",
    api_key="not-used",
    default_headers={"api-key": os.environ["POC_KEY"]},
)
response = client.chat.completions.create(
    model="deepseek-v4-flash",
    max_tokens=64,
    messages=[{"role": "user", "content": "Reply with exactly: OK"}],
)
print(response.choices[0].message.content)
```

Node.js, with `npm install openai`:

<!-- file: examples/openai_sdk.mjs -->
```javascript
// A model through the gateway's OpenAI-compatible route, with the OpenAI SDK for Node.js.
//
// The route reads the subscription key from the api-key header, added here as a default header.
// The SDK also requires apiKey and sends it as Authorization: Bearer; the gateway replaces that
// header with its own credential before it calls Foundry, so any value works. Run by
// scripts/Test-PocClients.ps1; see SETUP.md.
//
// Environment: POC_GATEWAY (https://<apim-name>.azure-api.net) and POC_KEY (a key issued on a
// product whose pack includes the model below).
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${process.env.POC_GATEWAY}/poc/v1`,
  apiKey: "not-used",
  defaultHeaders: { "api-key": process.env.POC_KEY },
});

const response = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});
console.log(response.choices[0].message.content);
```

### opencode

<!-- file: examples/opencode.json -->
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "poc": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Gateway, OpenAI-compatible route",
      "options": {
        "baseURL": "{env:POC_GATEWAY}/poc/v1",
        "apiKey": "not-used",
        "headers": {
          "api-key": "{env:POC_KEY}"
        }
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash"
        }
      }
    },
    "poc-claude": {
      "npm": "@ai-sdk/anthropic",
      "name": "Gateway, Claude route",
      "options": {
        "baseURL": "{env:POC_GATEWAY}/poc/claude/v1",
        "apiKey": "{env:POC_KEY}"
      },
      "models": {
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5"
        }
      }
    }
  }
}
```

opencode reads `opencode.json` from the project folder, or `~/.config/opencode/opencode.json`
for every project, and replaces `{env:NAME}` with the environment variable
([config](https://opencode.ai/docs/config/), read 2026-10-12). A run:
`opencode run "Reply with exactly: OK" -m poc/deepseek-v4-flash`, or
`-m poc-claude/claude-haiku-4-5`. One opencode prompt sends two requests: a title request
(2.4 KB) and the prompt with its tool definitions (64.5 KB), each asking for
`max_tokens: 32000`. The DeepSeek deployment refused the prompt at 10,000 tokens a minute and
answered it at 50,000. It did not count `max_tokens`, which Azure OpenAI deployments do count
([U29](../../docs/UNKNOWNS.md),
[quota](https://learn.microsoft.com/azure/foundry/openai/how-to/quota)).

### curl

<!-- file: examples/claude-request.json -->
```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 16,
  "messages": [
    {
      "role": "user",
      "content": "Reply with exactly: OK"
    }
  ]
}
```

```bash
curl -sS --fail-with-body "$POC_GATEWAY/poc/claude/v1/messages" -H "x-api-key: $POC_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d @examples/claude-request.json
```

<!-- file: examples/openai-request.json -->
```json
{
  "model": "deepseek-v4-flash",
  "max_tokens": 64,
  "messages": [
    {
      "role": "user",
      "content": "Reply with exactly: OK"
    }
  ]
}
```

```bash
curl -sS --fail-with-body "$POC_GATEWAY/poc/v1/chat/completions" -H "api-key: $POC_KEY" -H 'content-type: application/json' -d @examples/openai-request.json
```

The commands run from `poc/products-keyvault/`. In PowerShell on Windows the program is
`curl.exe`, the variables are `$env:POC_GATEWAY` and `$env:POC_KEY`, and arguments starting
with `@` are quoted (`'@examples/claude-request.json'`), because PowerShell reads an unquoted
`@name` as splatting. The key is part of curl's command line, which other users of the same
machine can list.

## Errors

| Response | Cause | Source |
|---|---|---|
| 401 *"Access denied due to missing subscription key…"* | No key in the route's header | Measured 2026-10-12 |
| 401 *"Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription."* | The key is wrong, suspended, or replaced by a second rotation; or a new key has not reached every gateway node yet | Measured 2026-10-12; [U25](../../docs/UNKNOWNS.md) |
| 401 on one route for a key that works on the other | The key's product does not include that route | [Results](README.md#results) |
| 403 `product_required` | The key is not issued on a product (an all-access, all-APIs or single-API key), so no budget applies | [U26](../../docs/UNKNOWNS.md) |
| 403 *"model_not_allowed: this key's product does not include the model '…'"* | The model is not in the key's pack | Measured 2026-10-12 |
| 403 *"Token quota is exceeded. Try again in …"* | The key's monthly budget or the product's pool is spent; both restart at 00:00 UTC on the 1st | [Results](README.md#results); [llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) |
| 429 from the product policy | The key's per-minute limit (`tpm`) | [llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) |
| 429 *"Your requests to … have exceeded token rate limit"* | The model deployment's per-minute limit, shared by all keys | [U29](../../docs/UNKNOWNS.md) |
| 400 *"Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header"* | Claude Code sent a pre-release capability that Foundry does not accept; `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` strips it | [U17](../../docs/UNKNOWNS.md) |
| Key Vault 403 for `New`, `Rotate` or the helper | The vault accepts private traffic only, or the caller has no role on the secret | [Finding 5](README.md#what-the-runs-showed) |

## Remove

```powershell
./scripts/Remove-Poc.ps1 @target -VaultName $vault -Runner -PurgeVault
```

[`Remove-Poc.ps1`](scripts/Remove-Poc.ps1) deletes the products `poc-claude-pack`,
`poc-deepseek-pack` and `poc-tiny-pack` with their keys, the three routes, any other `poc-` key,
the operator's vault role and the vault. `-PurgeVault` also purges the deleted vault, which
otherwise stays soft-deleted for its retention period. `-Runner` removes the runner's roles, VM,
subnet, NAT gateway, public IP, NSG and private endpoint, and the `privatelink.vaultcore.azure.net`
zone when no other record is left in it. A pack with another id stays (roadmap P41). Each step's
result is checked, and the script exits 1 if anything is left. Offline tests run it with Azure
stubbed; it has not yet been run against a deployment.

## Sources

- [Subscriptions in API Management](https://learn.microsoft.com/azure/api-management/api-management-subscriptions) (updated 2026-06-25)
- [llm-token-limit policy](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) (updated 2026-06-26)
- [Azure RBAC for Key Vault](https://learn.microsoft.com/azure/key-vault/general/rbac-guide) (updated 2026-08-21)
- [Automate the rotation of a secret with two sets of credentials](https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual) (updated 2026-07-08)
- [Azure Resource Manager deployment modes](https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes) (updated 2026-06-26)
- [Azure built-in roles for privileged access](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged) (updated 2026-07-01)
- [Manage Azure OpenAI quota](https://learn.microsoft.com/azure/foundry/openai/how-to/quota) (updated 2026-08-13)
- Claude Code: [settings reference](https://code.claude.com/docs/en/settings-reference), [authentication](https://code.claude.com/docs/en/authentication), [environment variables](https://code.claude.com/docs/en/env-vars) (read 2026-10-12)
- [opencode config](https://opencode.ai/docs/config/) (read 2026-10-12)
- Measurements: [README results](README.md#results); [UNKNOWNS](../../docs/UNKNOWNS.md) U17 and U24–U29
