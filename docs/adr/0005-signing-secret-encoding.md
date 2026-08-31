# ADR-0005 — The signing secret is Base64-encoded key material

**Status:** Accepted
**Date:** 2026-08-31
**Packet:** P2
**Origin:** Security council seat, Alert 1 (HIGH)

## Context

The gateway signs participant keys with HS256 in `src/keys.mjs`, and APIM verifies them with
`validate-jwt` using a symmetric `<key>` supplied as a named value. Both sides must derive
**byte-identical** HMAC key material from the same stored string, or every signature mismatches.

The first implementation got this wrong in two compounding ways.

1. **The minter used the wrong bytes.** `createHmac("sha256", secret)` where `secret` is a string
   makes Node use the **ASCII bytes of that string** as the key. APIM documents the opposite: a
   symmetric key *"must be provided inline within the policy in the Base64-encoded form"* — it
   **Base64-decodes** the named value first.
   ([validate-jwt reference](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy))

2. **The stored form was not decodable anyway.** `New-SigningSecret` produced base64url by
   substituting `-` and `_` for `+` and `/` and stripping padding. A value containing `-` or `_` is
   not valid standard Base64.

## Why this was rated HIGH despite failing closed

Nothing is granted when signatures mismatch — the gateway returns 401 and no access leaks. But:

- It **disables the only authentication control**. The gateway does not work at all.
- It is **deployment-dependent**, and therefore looks intermittent. Whether the random 32 bytes
  encode without `+` or `/` was measured at roughly **26%** over 20,000 samples. So about a quarter
  of deployments produce a decodable-but-different key, and three quarters produce an undecodable
  one — different failure modes from the same code.
- The obvious field fix is catastrophic. Under event time pressure, "make the secret Base64-clean"
  invites someone to type a passphrase, which silently shrinks the HMAC key to a handful of bytes.

## Decision

**The canonical secret is 32 random bytes, stored as standard, padded Base64.** Both sides decode
it before use.

- `generateSecret()` returns `randomBytes(32).toString("base64")` — standard alphabet, padded.
- `New-SigningSecret` in `admin.ps1` returns `[Convert]::ToBase64String($bytes)` with no substitution.
- `keys.mjs` derives the key through `keyMaterial(secret)`, which Base64-decodes and validates.

`keyMaterial()` rejects anything that is not usable key material:

| Input | Result |
|---|---|
| Not standard Base64 (`-`, `_`, spaces, punctuation) | `KeyError` naming the fix |
| Decodes to fewer than 32 bytes | `KeyError` stating the actual length |
| Missing or empty | `KeyError` |

The passphrase case is called out explicitly in the error message, because that is the wrong repair
someone will reach for.

## Verification

`tests/hmac-key-derivation.test.mjs` pins the contract:

- `generateSecret()` output always matches `/^[A-Za-z0-9+/]+={0,2}$/` and decodes to 32 bytes
  (asserted over 200 and 500 samples respectively, since the original bug was probabilistic).
- The signature equals HMAC over the **decoded** key and **does not** equal HMAC over the ASCII
  string — so the test cannot pass by accident.
- A test asserts the two derivations genuinely differ, so the check above is not vacuous.
- One test simulates APIM directly: Base64-decode the named value, HMAC the raw
  `header.payload` segments, compare to the token's signature.
- A passphrase and an 8-byte secret are both rejected.

End to end, `scripts/Test-Governance.ps1` check #1 fails immediately if the two sides ever diverge
again.

## Consequences

- Rotating the secret still invalidates every outstanding key at once — the intended emergency stop.
- The stored secret is longer (44 characters, padded) than the old base64url form. Harmless.
- Anyone hand-setting the `signing-key` named value must supply standard Base64. The error message
  says so.

## Note for future readers

`createHmac("sha256", someString)` and `createHmac("sha256", Buffer.from(someString, "base64"))`
are both valid JavaScript and neither warns. The difference is invisible until it is verified
against a second implementation. If you touch key derivation, run
`tests/hmac-key-derivation.test.mjs` — it exists precisely to catch this.
