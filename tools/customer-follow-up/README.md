# tools/customer-follow-up/

A customer's steps (outreach, a reply, a booked call, a purchase, onboarding, a follow-up, feedback) and each product's progress toward its customer target, read from `customer-contact`, `customer-product-target` and `customer-step` records. Ported from bitfield-packages `customer-follow-up`: its readers unchanged, its step builder without the request that sent the step to the old runtime's workflow slot (the caller keeps the returned record). The two Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/customer-follow-up-types.ts` | The three record shapes and the views built from them. |
| `read-data/read-customer-follow-up.ts` | Sorts rows into contacts, targets and steps, then builds each customer's timeline and each product's progress. |
| `do-work/record-customer-step.ts` | Builds one `customer-step` record: a fresh id, trimmed text, each reference once, a plain default label per kind. |
| `do-work/see-where-each-customer-is.mjs` | `tool:see-where-each-customer-is`: the views, from records in the input or a JSON file from the person's files. |
| `do-work/record-a-customer-step.mjs` | `tool:record-a-customer-step`: the step record to keep. |
| `part.json` | The readers and the step builder are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:see-where-each-customer-is`, `tool:record-a-customer-step`, `tool:add-a-customer`, `tool:set-a-customer-target`. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CustomerContactRecord` | `{kind: 'customer-contact', contactId, displayName, channelLabel?, ownerLabel?, sourceLabel?}` | One customer. |
| `CustomerProductTargetRecord` | `{kind: 'customer-product-target', targetId, productId, productLabel, targetCount, active?}` | How many customers a product aims for. |
| `CustomerStepRecord` | `{kind: 'customer-step', stepId, contactId, productId, stepKind, label, outcome?, evidenceRefs, ownerRefs, createdAt}` | One step with one customer. |
| `readCustomerFollowUpState` | `(rows) -> {contacts, targets, steps}` | Rows (bare or `{payload}`) sorted by kind. |
| `customerFollowUpViews` | `(state, selectedContactId?) -> {contacts, products, selectedContact}` | Timelines newest first; a purchase step counts a customer once per product. |
| `buildRecordCustomerStepInput` | `(draft) -> {step_id, step_record}` | The record for one step. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), Trillion's `test/crm-tools.test.mjs`.
