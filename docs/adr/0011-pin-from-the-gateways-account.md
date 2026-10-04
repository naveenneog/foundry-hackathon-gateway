# ADR-0011 — Pin models only from the gateway's Foundry account

**Status:** Accepted
**Date:** 2026-10-04
**Packet:** P28
**Reverses:** the P16 choice, recorded in `Get-FoundryCatalogue`, to list every account in the
subscription

## Context

P16 made option 3 list the model deployments of every Foundry account in the subscription. The
reasoning, written in the function's own comment, was that an organisation keeps Claude in one
account and everything else in another, so a picker limited to one account would make half the
subscription look empty.

The gateway cannot serve that split. `infra/main.bicep` takes one `foundryAccountName`, and both
routes — `/v1` and `/claude` — forward to that one account. A deployment in any other account
answers 404 however it is pinned. The picker knew this: picking one produced *"lives in '…', not
the gateway's account … Pin it anyway?"*.

An operator reported it on 2026-10-04, after choosing the subscription and the account: the
picker listed 54 deployments from four accounts, 25 of which the gateway could not reach. The
same run showed two more consequences of the subscription-wide list:

- Option 2 marked a pin `ok` when its deployment existed in *any* account, including ones the
  gateway cannot reach.
- With no account chosen yet, option 3 pinned against an empty account name.

## Options

**A — Keep the subscription-wide list and keep warning.** Every row the gateway cannot serve is
still offered, and the warning arrives after the operator has picked.

**B — Serve more than one account.** Separate backends per route, or per pin, would make the
P16 reasoning true. That changes the Bicep, the policies and the deployment plan, and nobody has
asked for it.

**C — List only the gateway's account.** The list then contains only deployments that can work.

## Decision

**Option C.** Once a Foundry account is chosen, options 2 and 3 list only its deployments. Option
3 with no account chosen asks for one first, through the same `Select-FoundryAccount` that option
1 uses. Option 2 with no account chosen still lists the whole subscription, because at that point
it is the way to decide which account to choose.

## Consequences

- The "Pin it anyway?" branch is gone. Nothing it guarded can be reached any more.
- Option 2 reports a pin as `MISSING in <account>` when its deployment is not in the gateway's
  account, which is the same check the deployment plan makes (P25). Option 3 marks such a pin
  in its list of current pins.
- Scoping makes the account's resource group matter: with the wrong one the account would look
  empty. Options 2 and 3 look the account up by name and use the resource group it is in;
  option 1 takes the resource-group default from the account rather than the previous one; an
  account that is not in the subscription is reported as not found, not as empty.
- Moving to a different account is a deliberate step in option 1, not a side effect of picking a
  row.
- If serving models from several accounts is ever wanted, it is option B: a change to the
  infrastructure and the policies, not to the picker.
- `tests/model-picker.test.mjs` drives the real `scripts/Models.ps1` functions with `az` replaced
  by a stub, so the behaviour is tested in the code the operator runs rather than in a copy.
