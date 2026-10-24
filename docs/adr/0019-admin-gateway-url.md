# ADR-0019: The dashboard hands out an admin-set gateway URL only when API Management serves it

- **Status:** Accepted
- **Date:** 2026-10-24
- **Packet:** P59
- **Deciders:** owner's request of 2026-10-24; design by the coding agent

## Context

The owner, on 2026-10-24:

> "DNS url, if the admin updates that, apim url should be replaced with the admin provided DNS
> url in the keys generated and copy and wherever APIM url is shown"

Facts:
- The dashboard's gateway origin is the `GATEWAY_URL` setting, which `scripts/Deploy-Console.ps1`
  sets to the instance's `gatewayUrl` (`https://<name>.azure-api.net`) and `loadConfig` checks as
  an https origin (`src/console/main.mjs`). Only a redeploy changes it.
- Every URL the dashboard hands out derives from it: single and bulk handouts, reveal and copy,
  `keys.csv`, the export bundle, and each Foundry connection's base URL (`/foundry/<id>/...`,
  ADR-0017). The UI displays the server's values and builds no gateway URL itself.
- Keys are sent to this host. A wrong host is a key leak, not only a broken link.
- API Management answers only on its default gateway hostname and the gateway custom domains
  configured on it; the default hostname cannot be removed (U52).
- ARM lists the configured hostnames in `properties.hostnameConfigurations`; gateway hostnames
  have `type: Proxy` (U51). `admin.ps1` already prefers the instance's `Proxy` custom domain for
  handouts and refuses wildcards (P32).
- The dashboard identity holds API Management Service Contributor on the instance, which can
  read the service (U51).
- Deleting a Key Vault secret blocks recreating the same name while it is soft-deleted (U54).

## Options considered

1. **Accept any https URL the admin types.** Simple, and it would allow a Front Door or
   Application Gateway hostname in front of API Management. A typo or a hostile entry would
   send every new key to a host nobody controls, and nothing could tell the two cases apart.
2. **Accept a URL after the server probes it.** The server would send requests to an
   admin-supplied address (server-side request forgery), and an answer does not prove the host
   is this gateway.
3. **Accept only a hostname that ARM lists as a gateway (`Proxy`) hostname of this API
   Management, and store it in Key Vault.** Whoever can add a hostname to API Management already
   controls the gateway; the dashboard adds no new trust.

## Decision

Option 3: API Management's own hostname list is the only source of trust.

1. **Input.** `https://<hostname>`, lowercased, with an optional `:443` and trailing `/`. Refused:
   a path, query, fragment, user info, any other port, an IP literal, a wildcard, a single-label
   host and anything that is not ASCII letters, digits, hyphens and dots.
2. **Verification before saving.** One ARM read of the service (`api-version=2024-05-01`, the
   version the adapter already uses). The hostname must equal, ignoring case, the `hostName` of
   an entry with `type: Proxy`. Otherwise the request fails with 400, saying to add the custom
   domain to API Management's gateway first. The dashboard never sends a request to the
   admin-provided URL and does not look it up in DNS.
3. **Storage.** Key Vault secret `console-gateway-url`, value `{"url":"https://<hostname>"}`,
   tags `kind=gateway-url`, `updatedBy`, `updatedAt`. **Reset to API Management URL** writes
   `{"url":null}` instead of deleting the secret (U54). Each change is a new secret version. The
   audit log records `set-gateway-url` and `reset-gateway-url` with the old and new URLs.
4. **One resolver.** `effectiveGatewayUrl()` in `src/console/gateway-url.mjs` returns the stored
   URL while ARM still lists it as a gateway hostname, and `GATEWAY_URL` otherwise. A stored
   value that fails the input rules is ignored. Every URL the dashboard emits comes from it:
   handouts, reveal, `keys.csv`, the export bundle, `/api/config` and connection base URLs, and
   the attach result. A test fails if any module reads the configured URL other than through
   the resolver.
5. **Propagation.** The resolver caches its answer for 30 seconds per replica; the replica that
   saves a change uses it at once. A new or restarted replica reads the vault first. The
   Container Apps dashboard runs at most one replica (`infra/console.bicep`).
6. **Requests the dashboard sends.** The Foundry connection test keeps calling `GATEWAY_URL`.
7. **Distributed keys.** Handouts and CSVs already sent are not rewritten. They keep working,
   because API Management keeps answering on its default hostname (U52). The Settings page says
   so.

## Consequences

+ Keys are handed out only with hostnames API Management serves. If the domain is removed from
  API Management, new handouts fall back to the API Management URL within 30 seconds.
+ No redeploy to change the URL in handouts.
− While a custom domain is set, each replica reads the vault and ARM once per 30 seconds when it
  needs the URL. If either read fails, the request that needed the URL fails, as other ARM
  failures already do.
− A Front Door or Application Gateway hostname in front of API Management cannot be set here;
  `admin.ps1` still accepts a typed host for that case (P32).
− The dashboard does not check DNS or the certificate. An admin checks that the name resolves to
  the gateway, for example by calling it with a key.
− Browser tabs that were already open show the old URL in forms until they are reloaded. The
  server builds every handout, so the keys themselves carry the current URL.
− The dashboard identity's role could also write hostnames; the code only reads them.

## How we'd know this was wrong

- An organisation needs a Front Door or Application Gateway hostname in handouts. That needs a
  second trust source, such as the Front Door routes in ARM, and a new decision.
- ARM throttles the service read: the cache period would grow.
- A key is handed out with a hostname API Management does not list: the resolver tests and the
  module scan would have missed a path, and the scan must be widened.
