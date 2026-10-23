# ADR-0017: Discover Foundry accounts and bind each key to its selected backend

- **Status:** Accepted; extends ADR-0015's single-account catalogue.
- **Date:** 2026-10-23
- **Packet:** P56
- **Deciders:** owner's request of 2026-10-23

## Context

The console currently queries only `FOUNDRY_ACCOUNT_ID`. Its model list omits deployments in
other accounts, although the terminal script discovers them across the subscription. All four
inference APIs currently share that one account's endpoints. Adding a picker without changing
routing would issue keys that point to the wrong account.

The requested flow is: discover deployed models, attach a Foundry backend, pin models, select
that Foundry when issuing single or bulk keys, and provide contextual help.

## Decision

1. List AIServices and OpenAI accounts across the APIM subscription, including deployments from
   every account. Show unreadable accounts as errors rather than silently omitting them.
   Refresh re-queries ARM; newly deployed models need no app redeploy.
2. Keep the configured account as the legacy/default connection, with its existing routes,
   audiences, aliases and keys unchanged.
3. Attach another account by its validated ARM resource ID, never by a user-supplied URL.
   Derive endpoints from ARM. Create namespaced APIM backend resources, four inference APIs
   under `/foundry/<connection-id>/...`, their operations, policies and diagnostics, plus two
   account-local model maps. Persist the connection in a Key Vault metadata secret only after
   provisioning succeeds. Idempotent retries repair partial provisioning.
4. Reuse the existing full gateway policies; account-specific copies replace only model-map
   named values and the JWT audience. A short-lived key for one connection has that connection's
   audience. Sending it to another connection fails JWT validation. Product subscriptions are
   linked only to their own account's APIs and their product hash includes the connection.
5. Pass `foundryId` through model pinning, single/bulk issuance, reveal and export. Store the
   connection identifier as key metadata. Returned handouts and CSVs use the selected
   connection's base URLs. A missing `foundryId` preserves existing caller behaviour.
6. The installer grants metadata-only discovery actions across the configured subscription to
   the dashboard identity: account read and deployment read. It does not grant subscription
   Contributor, account key access, or RBAC write permissions to the dashboard.
7. Backend attachment does not grant Azure roles or relax private networking. An operator helper
   grants the gateway identity inference access on an explicitly selected account. The UI
   explains this boundary, provides the exact setup command and exposes a small explicit
   connection test after pinning. A test failure is visible, not presented as a working backend.
   An explicit operator `-ConfigurePrivateEndpoint` option can create a per-account private
   endpoint in the existing gateway VNet and register its three existing private DNS zones.
   This addresses private-zone shadowing found in live testing (U49), without changing the
   account's public network access or firewall.
8. UI: Foundry/account filter, deployment list with account/region/state, Attach, Refresh, account-
   local pins and a Foundry selector on both single and bulk issue forms. Highlightable help
   explains discovery permissions, attachment versus inference readiness, private DNS, model
   names versus aliases and safe key distribution.

## Consequences

- Existing issued keys and routes keep their behaviour.
- Identical deployment names in different Foundry accounts remain unambiguous.
- Each attached account adds four APIM APIs, but no new compute service.
- Private endpoint routing still requires the account to be reachable from APIM's VNet.
- The dashboard deliberately cannot elevate its own or APIM's permissions. Operators perform
  required per-account inference-role grants.
- Newly discovered accounts can be browsed before attachment; keys can be issued only for an
  attached account and ready, routable deployments.

## Detectors

Tests must show two accounts with the same deployment name, pagination, unreadable accounts,
wrong subscription/URL refusal, wrong-connection key rejection, different product IDs per
connection, single/bulk/handout parity and unchanged legacy routes. Live checks exercise a
second existing Foundry account, with wrong-account controls.
