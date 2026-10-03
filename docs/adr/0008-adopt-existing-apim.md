# ADR-0008 — Deploy onto an API Management instance the organisation already runs

**Status:** Accepted
**Date:** 2026-10-03
**Packet:** P15

## Context

The gateway created its own API Management instance. An organisation that already runs one has a
provisioned, network-configured, monitored instance sitting there, and provisioning a second takes
tens of minutes and duplicates cost.

Adopting someone else's instance is a different problem from creating one. The instance is shared:
other APIs are published on it, and anything this deployment writes at instance scope is visible
to them.

## Decision

`infra/main.bicep` takes `existingApimName`. When it is empty the instance is created as before;
when it is set, the instance is referenced as `existing` and only this gateway's own resources are
added to it.

Three consequences were designed for explicitly.

### 1. The instance is never redeclared

Two declarations: `apimNew` creates one only `if (empty(existingApimName))`, and `apim` is an
`existing` reference that every child hangs off. A second full declaration would reset SKU,
publisher details and identity on an instance we do not own. An `existing` reference produces no
ARM dependency, so the children carry an explicit `dependsOn: [apimNew]`.

### 2. Everything instance-scoped is namespaced

Named values are instance-wide, not API-wide. An unprefixed `signing-key` or `model-map` would
overwrite whatever another team's API already uses under that name — a silent, cross-API data
change that no test of this gateway would ever observe. Every named value this gateway owns is
therefore prefixed `hackgw-`, and the Application Insights logger is `hackgw-appinsights` rather
than `appinsights`, which is the name nearly every APIM sample uses and therefore the one most
likely to already exist.

`tests/brownfield-apim.test.mjs` pins all of it: every `{{reference}}` in the policy is declared in
the Bicep, every name carries the prefix, and no script addresses a named value directly instead
of going through `Get-`/`Set-GatewayNamedValue`.

Reads fall back to the unprefixed name, so a gateway deployed before this change keeps working
until its next deployment.

### 3. An unsuitable instance is refused, not flagged

`src/apim.mjs` judges an instance and `scripts/Apim.ps1` transcribes that judgement. Four
conditions block adoption:

| Blocker | Why it is fatal |
|---|---|
| Classic tier, for the Claude route | `llm-token-limit` parses the Anthropic Messages shape **only on v2 tiers**. A classic tier accepts the identical policy and meters zero tokens, so every budget is configured, displayed as configured, and enforces nothing. See UNKNOWNS U12. |
| Consumption tier | No named values and no managed identity. |
| Not `Succeeded` | Cannot accept an API yet. |
| No system-assigned identity | There is no principal to grant Foundry access to. The deployment would succeed and every model call would return 401. |

The tier is a refusal rather than a warning because the failure mode is a control that reports
itself as present and cannot fire. The OpenAI-shaped route is unaffected — it parses on all tiers
(UNKNOWNS U3) — so the same instance can be usable for DeepSeek and refused for Claude, and the
picker shows both verdicts.

## Consequences

**Positive**
- Deployment onto an existing instance takes seconds rather than tens of minutes.
- Nothing this gateway writes can collide with another API on a shared instance.
- An instance that would silently fail to enforce budgets cannot be chosen by accident.

**Negative**
- The adopted instance must live in the deployment's resource group, because ARM child resources
  share their parent's scope. `admin.ps1` sets the resource group from the chosen instance.
- Enabling a missing managed identity is left to the operator, deliberately. `az apim update` sets
  `identity` to `None` unless `--enable-managed-identity true` is passed
  ([azure-cli `apim_update`](https://github.com/Azure/azure-cli/blob/dev/src/azure-cli/azure/cli/command_modules/apim/custom.py):
  `if not enable_managed_identity: instance.identity = None`), so doing it automatically on a
  shared instance risks stripping an identity other APIs depend on. The blocker message quotes the
  command including the flag.
- Named values changed name. The read fallback covers the transition; the next deployment writes
  only the prefixed names.
