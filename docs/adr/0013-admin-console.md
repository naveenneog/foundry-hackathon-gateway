# ADR-0013 — A web admin console with Entra sign-in, Key Vault as the source of every secret

**Status:** Accepted
**Date:** 2026-10-16
**Packet:** P46
**Clarifies:** the charter's non-goal "Entra ID / OAuth" (participants), and ADR-0002
**Reverses:** "the token is never persisted" (`scripts/Keys.ps1`) for keys issued from the console

## Context

The owner asked for one UI that combines the original signed-key system (HS256 keys, ADR-0005)
with the products + Key Vault proof of concept (P37), with admin controls, the signing secret
kept in Key Vault, automated rotation that can be switched on per key, roles that give users
their own keys and admins alone the export, and exports that are encrypted and signed by the
admin for sending.

## Decisions

1. **Operators sign in; participants still do not.** The charter excludes Entra ID for
   *participants*, who may be external and short-lived (ADR-0002). The console is used by
   organisers and by people who receive keys, so it signs them in with Entra ID through App
   Service built-in authentication. Participant keys stay bearer keys; the gateway policies do
   not change.
2. **Two app roles, enforced in the app, failing closed.** `Console.Admin` issues, revokes,
   suspends, rotates, switches automation and exports. `Console.User` sees only the keys whose
   `owner` is their sign-in name, and can reveal them. A principal with neither role gets 403;
   a request without the platform's principal header gets 401. The app trusts
   `X-MS-CLIENT-PRINCIPAL` only when the platform reports authentication enabled, because
   "external requests aren't allowed to set these headers" holds only then
   ([Learn](https://learn.microsoft.com/azure/app-service/configure-authentication-user-identities)).
3. **Key Vault is the source of the signing secret.** The secret moves from APIM's named value
   into the POC vault (`gw-signing-secret`), and the console signs keys from it. APIM keeps its
   encrypted *secret* named value, written by the console from the vault. A Key Vault reference
   was rejected: with a firewalled vault Learn requires "Allow trusted Microsoft services to
   bypass this firewall"
   ([Learn](https://learn.microsoft.com/azure/api-management/api-management-howto-properties)),
   which the POC closed on purpose (P43, U32). The migration refuses to overwrite a vault value
   that differs from APIM's, so issued keys cannot be invalidated by accident.
4. **Issued keys are stored, in the vault only.** So a user can fetch their own key, each signed
   key is a vault secret `jwt-<jti>` tagged with owner, subject, models, budget and expiry; the
   vault is private (U32) and RBAC-only. This reverses "the token is never persisted" for the
   console; `admin.ps1` keeps its behaviour.
5. **Rotation automation is opt-in per product key.** Tags `rotateDays` (1–90) and `rotatedAt`
   on `poc-key-<name>`; an hourly in-process job rotates due keys with the POC's two-slot rule
   (regenerate the slot clients do not hold). The plan runs on App Service with Always On.
6. **Exports are encrypted bundles signed with a Key Vault key.** AES-256-GCM under a key
   derived by scrypt from a passphrase of at least 16 characters (or one the console generates),
   to be sent by another channel. The header — including the admin's name and object id, time,
   recipient and contents — is the GCM additional data and is signed ES256 by a non-exportable
   P-256 key `bundle-signing` in the vault. `scripts/open-bundle.mjs` verifies the signature
   before decrypting. The signature proves the console produced the file at the named admin's
   request; it is not the admin's personal key.
7. **No runtime dependencies.** `node:http`, `fetch` and `node:crypto` only, as `src/keys.mjs`.
   Azure is called over REST with the app's managed identity.

## Consequences

- New billable resources: an App Service plan (B1) and a web app with VNet integration in a new
  subnet of the POC network, and an Entra app registration.
- The app's identity holds Key Vault Secrets Officer and Crypto Officer on the vault, and API
  Management Service Contributor on the instance.
- Anyone who is Admin can export every key; the export is audited to the app log.
- A lost passphrase makes a bundle unreadable; nothing recovers it.
