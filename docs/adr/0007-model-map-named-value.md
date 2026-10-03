# ADR-0007 — Any number of pinned models, held in one named value

**Status:** Accepted
**Date:** 2026-09-01
**Packet:** P7 (recorded retrospectively; `admin.ps1` and `scripts/Models.ps1` already cite it)

## Context

The first version supported exactly two models, `flash` and `pro`, as two fields in local state
and two named values on the gateway. Adding a third meant editing the state shape, the Bicep, the
policy and the admin script together.

The obvious fix — one named value per model, `model-flash`, `model-pro` — does not work. APIM
substitutes `{{named-value}}` at policy **compile** time, not at request time, so a policy cannot
construct a reference such as `{{model-}} + alias`. Microsoft's documented workaround is to hold
every value in a single named value and parse it with a policy expression.

## Decision

The alias map lives in **one** named value, `hackgw-model-map`, in the wire format:

```
alias=deployment;alias=deployment
```

`src/models.mjs` is the canonical, unit-tested parser (`parseModelMap`, `buildModelMap`,
`resolveAlias`). `infra/policy.xml` step 5c is its transcription into a policy expression, and
`ConvertTo-ModelMapString` in `scripts/Models.ps1` is its transcription into PowerShell. All three
agree on the same two structural separators, `;` and `=`, and all three reject a value containing
either.

## Consequences

**Positive**
- Any number of models, with no change to the state shape, the Bicep or the policy.
- **Adding or repointing a model is a named-value edit, not a redeployment.** Verified live: a
  third model was serving in roughly 20 seconds.
- Participants address short aliases, so a deployment can be renamed or replaced without anyone
  editing their configuration.

**Negative**
- Three transcriptions of one parser. The comment in each names the other two; `src/models.mjs` is
  the one to change first.
- An alias or deployment name containing `;` or `=` cannot be represented. All three
  implementations reject it rather than silently truncating the map.
- A malformed entry is skipped rather than failing the whole map, so one typo cannot strand every
  participant at an event. The consequence is that a mistyped pin fails as
  `model_not_configured` for that alias alone.

## Reference

[Azure API Management policy expressions](https://learn.microsoft.com/en-us/azure/api-management/api-management-policy-expressions) ·
[Named values in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)
