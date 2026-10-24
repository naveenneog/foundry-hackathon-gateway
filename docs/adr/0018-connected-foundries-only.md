# ADR-0018: Foundry & models lists only the Foundries connected to this API Management

- **Status:** Accepted. Amends ADR-0017 decision 8 (the UI) and its consequence that unattached
  accounts can be browsed on the page. Discovery, attachment, routing, isolation and
  authorisation in ADR-0017 are unchanged.
- **Date:** 2026-10-24
- **Packet:** P58 (amendment)
- **Deciders:** owner's request of 2026-10-24

## Context

The owner, on 2026-10-24:

> "we only want the foundries which are connected to the Selected APIM to be part of shown
> foundry accounts as long lived or product keys are part of apim feature"

Foundry & models listed every AIServices and Azure OpenAI account in the subscription (16 live),
each marked attached or not, with Attach on the unattached ones. Short-lived and product keys
exist only for accounts that this API Management routes to: the default connection and each
attached account. Discovery (`GET /api/foundries`) already marks those accounts `connected`; an
attached account is marked only after its APIM provisioning succeeded and its connection record
was stored (ADR-0017 decision 3).

A modal `<dialog>` makes the rest of the document inert, including the docked setup guide (U50).

## Options considered

1. **Drop unconnected accounts from the UI.** The page would describe only connected Foundries,
   but an administrator could no longer attach another account.
2. **A "show all accounts" filter on the same list.** One list, but the page would still mix
   connected accounts with accounts no key can use.
3. **Connected accounts on the page; the others in a separate "Connect another Foundry" dialog.**
   The page describes what keys can use; attaching remains one action away.

## Decision

Option 3.

1. The account list on Foundry & models shows only accounts that discovery marks `connected`.
   Its lede and count describe connected Foundries, not the subscription.
2. **Connect another Foundry** opens a modal dialog (focus trapped, focus returned on close)
   that lists every other discovered account, unreadable ones with their error, with search.
   The chosen account shows Attach, or why it cannot be attached; the operator setup command;
   the optional private-network command; and **How attaching works**, which closes the dialog
   and opens the guide at its Attach step.
3. A successful attach closes the dialog, re-reads discovery and selects the account in the
   connected list. A failed attach keeps the dialog open with the error.
4. With nothing connected, the page shows an empty state with Connect another Foundry.
5. The issue forms' Foundry choice offers connected accounts only, as before. It no longer
   counts unconnected accounts; its empty state says no Foundry is connected and links to
   Foundry & models.
6. The guide's Attach step highlights Connect another Foundry on the page.
7. The browser filters discovery's `connected` flag. Server APIs, attach, pin, test and issue
   validation and per-account authorisation are unchanged.

## Consequences

- The page and the issue forms describe the same set of Foundries.
- An unattached account's deployments are no longer browsable in the UI before it is attached;
  the dialog shows its deployment count. `GET /api/models?foundryId=` still returns them.
- One more browser module, `foundry-connect.js`, is served from the static allow-list.
- The local demo seeds one attached account and several unconnected ones.

## How we'd know this was wrong

- Administrators need to compare deployments across unattached accounts before attaching: the
  dialog would then need a deployment preview.
- An account stays marked connected after its APIM APIs were removed outside the dashboard: the
  `connected` flag would then need a check against API Management, not only the stored
  connection record.
