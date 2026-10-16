# ADR-0014: Host the Key Console on Azure Container Apps, not App Service

- **Status:** Accepted (amends the hosting choice in ADR-0013; every other ADR-0013 decision stands)
- **Date:** 2026-10-16
- **Packet:** P46
- **Deciders:** coding agent (operator away; recorded for review)

## Context
ADR-0013 planned a Linux App Service (B1) with VNet integration. On first deploy, VERIFIED this
session: the subscription has **zero App Service quota in eastus2** for every SKU probed (B1, B2, B3,
S1, P0v3, P1v3 all fail with `InternalSubscriptionIsOverQuotaForSku`, "Current Limit: 0"). The
console must run in the gateway's region because it reaches the private vault through the
gateway's VNet (`vnet-hackgw-pe`, eastus2). Container Apps environments already run in eastus2 in
this subscription (VERIFIED: a dozen `Microsoft.App/managedEnvironments` listed), and
`Microsoft.App` and `Microsoft.ContainerRegistry` are registered. There is no local Docker.

## Options considered
1. **Request App Service quota** — keeps ADR-0013 exactly; costs an unbounded wait on a quota
   ticket while the operator is away.
2. **App Service in another region + VNet peering** — quota there is unknown, adds a peered VNet
   and a second DNS link; more moving parts for a POC.
3. **Container Apps (Consumption workload profile) injected into a new /27 in the same VNet** —
   same platform sign-in model (Easy Auth injects `X-MS-CLIENT-PRINCIPAL`), same managed identity
   protocol (`IDENTITY_ENDPOINT` + `X-IDENTITY-HEADER`), so the console code is unchanged. Needs an
   image: built in the cloud with ACR Tasks.

## Decision
Option 3, because it is deployable now with zero application-code change.

- Image `key-console:<git-sha>-<timestamp>` built by `az acr build` from a minimal context
  (`src/keys.mjs`, `src/console/**`, `package.json`, `infra/console.Dockerfile`), base
  `mcr.microsoft.com/azurelinux/base/nodejs:20`, running as UID 1000.
- Registry admin user disabled; a **user-assigned identity with AcrPull only** pulls the image.
  The **system-assigned identity** keeps exactly the ADR-0013 roles (Key Vault Secrets Officer,
  Key Vault Crypto Officer, API Management Service Contributor). Splitting them means the pull
  role exists before the app is created, and the app's data-plane identity can't push images.
- `WEBSITE_AUTH_ENABLED=True` is set explicitly in the container env. On App Service the platform
  sets it; on Container Apps it does not, so the template asserts it next to the `authConfigs`
  resource that makes it true. Without it the console still fails closed (401).
- `minReplicas = maxReplicas = 1`: the rotation sweep runs in-process and must not run twice.
- The environment is dedicated to the console, so no other app can reach it on the internal
  network and bypass sign-in.

## Consequences
+ Deployable today; no code change; image is immutable and tagged with the commit.
+ Registry has no passwords; image pull and data-plane access are separate identities.
− New billable resources: a Container Apps environment, a Basic container registry, a Log
  Analytics workspace (30-day retention), a user-assigned identity.
− `WEBSITE_AUTH_ENABLED` is now an operator assertion rather than a platform fact. Guarded by
  `tests/console-infra.test.mjs`, which requires the `authConfigs` resource next to it.

## How we'd know this was wrong
- The live principal header on Container Apps lacks role claims (U37) — then roles must come from
  a different source and this hosting choice needs revisiting.
- The app can't resolve the private vault from the environment (U39).
- App Service quota appears in eastus2 and the extra registry/environment become cost that
  matters — then moving back is a template swap; the code is host-neutral.
