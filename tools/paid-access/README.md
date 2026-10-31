# tools/paid-access/

A person who sells access (a class, a membership, a book, a course video) can have their AI work out which paid access one buyer holds right now, check whether a buyer may open one gated thing, and sell a file so that only a buyer who holds its access gets it. Ported from four old packages: `signed-event-effects` (payment events through rule data into effects), `capability-effect-lifecycle` (effects into purchase episodes and held capabilities), `product-access` (grants with windows and revocations, and the check on a gated scope) and `material-delivery` (the decision, the lease, the link token and the cipher for a paid private file).

## One answer to "what does this buyer hold?"

`read-data/who-holds-access.mjs` is the only place that answers it, and every gate in this folder asks it again at the moment of the request, so a refund or an ended subscription closes the very next open.

1. The buyer's **payment events** (`payment-event` records, the shape `tools/take-payments` keeps, checked before it keeps them) go through the person's **effect rules** (`access-effect-rule` records) into effects. A rule says which event kind it reads, which attributes must be present, what the effect is called and where its subject and object come from.
2. The **lifecycle** (an `effect-lifecycle` record: which attribute names an episode, which effect kinds start, keep or end it) folds the effects into purchase episodes. A purchase starts one, a renewal keeps it, a cancellation or refund ends it, in any order of arrival. The `commercial-offer` rows say which `access_refs` an active episode gives; an offer that asks for no money is held by everyone.
3. **Grants** the person wrote by hand (`access-grant` records: `{ kind: "license_access", subject, object: <access ref>, material: { grant_ref, valid_from_ms?, expires_at_ms? } }`, and `{ kind: "revoke", subject, material: { revokes_grant_ref } }` to end one) add access with an optional window. A window is inclusive at its start and ends exactly at its end; a window with a missing, invalid or inverted time is never held.

With no `access-effect-rule` and no `effect-lifecycle` record, it reads `read-data/take-payments-events.json`: the event kinds and attributes `tools/take-payments` writes, and no product, offer, price or person. The starter rules name the buyer by the email address on the payment event; a person who names buyers another way (an account id carried in the payment's metadata) writes their own rule, and every gate here then names the buyer that way.

## Rules the gates keep

- **The gate is the thing's own record.** A sold file is one `paid-file` record (id = the name buyers ask for it by) naming the access refs that open it. A request only names the file; it can never say which access the file needs.
- **One entitlement rule.** The buyer holds ANY of the required refs; a thing that requires none is open to any named buyer (`read-data/holds-any-required-access-ref.ts`).
- **Fail closed.** Records that cannot be read answer unavailable (never "holds nothing", never a grant); no subject answers denied; a scope that is not exactly the schema is not authorized.
- **The run's clock is the time.** A caller cannot choose it.
- **No key in a row, a record or an answer.** The `paid-file` record names its key (`enc_key_ref`); the key stays in the person's held values and reaches only the run that seals (descriptor 4, `paid-files-key`) and the door that decrypts.
- **`subject` is the account the door verified** from the buyer's own session. These tools trust their caller for that; a buyer never calls them directly.
- **Nothing here moves money or writes payments.** Only `tool:seal-a-paid-file` writes, and only the `paid-file` record.

## Files

| File | Purpose |
|------|---------|
| `read-data/payment-effects.mjs` | Payment events through rule data into effects (from `signed-event-effects`): `effectsFromPaymentEvents`. Effect ids are `<prefix>:<event id>:<fact id>`; an effect that cannot be read is a `problem`, not a refusal of the batch. |
| `read-data/effect-lifecycle.mjs` | Effects into episodes and capabilities (from `capability-effect-lifecycle`): `observedLifecycleFactSet`, `currentCapabilityState` (with `subject` to keep one buyer's episodes). |
| `read-data/read-granted-access-refs.ts` | Grants with windows, revokes, refunds and supersedes into held refs (from `product-access`, body unchanged). |
| `read-data/who-holds-access.mjs` | `heldAccess` (rows in, answer out) and `readHeldAccess` (the same over the records door). |
| `read-data/take-payments-events.json` | The starter rules and lifecycle for the event kinds `tools/take-payments` writes. |
| `read-data/addressed-scope.mjs` | The scope `{ schema, value_ref, instance_ref, required_access_refs }`, strictly decoded (from `product-access`). |
| `read-data/holds-any-required-access-ref.ts` | The one entitlement rule, copied unchanged from the package that owned it. |
| `read-data/private-object-lease.ts`, `delivery-token.ts`, `object-store-map.ts`, `material-delivery-config.ts` | The delivery decision and lease, the opaque link token, the `paid-file` record reader and the door's route settings (from `material-delivery`). |
| `read-data/resolve-private-delivery.ts`, `request-private-object.ts`, `authorize-private-object.ts` | The shared brain and the mint and open steps. Changed: access is worked out here, not handed in. |
| `read-data/encrypt-private-object.mjs`, `do-work/seal-a-paid-file.mjs` | AES-256-CTR sealing with the person's key and a fresh nonce per file, and the `seal-a-paid-file` command. |
| `do-work/paid-access.mjs` | The functions the two access rows run. |
| `tool-rows.json` | The five rows. |
| `part.json` | No public files. |
| `test/` | `payment-effects`, `effect-lifecycle` (the package's four cases and two new), `read-granted-access-refs` and `grant-instance-projection` (the package's 18 cases), `addressed-scope`, `who-holds-access`, `private-object-lease` (15), `private-object-delivery` (16), `encrypt-private-object` (5) and `paid-access-rows` (the rows run as the container runs them against a stand-in records door). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `heldAccess` | `({ subject, nowMs, paymentEvents, offers, rules?, lifecycle?, grants }) => { subject, held_access_refs, capabilities, granted_access_refs, limits, active_offers, episodes, membership_revision_input, problems }` | The one answer. `limits` maps a capability held only within an allowance to the allowance rows; `membership_revision_input` changes when the set of grants changes, even if the refs do not. |
| `effectsFromPaymentEvents` | `(paymentEvents, rules) => { effects, problems }` | Projection by rule data. |
| `decodeAddressedExpiringValueScope` | `(object or JSON text) => scope or null` | Exactly the schema, bounded. |
| `decidePrivateDelivery` | `(PrivateDeliveryInputs) => PrivateDeliveryDecision` | Pure fail-closed decision and lease. |
| `requestPrivateObject`, `authorizePrivateObject` | `(input, { door, nowMs?, holds? }) => ...` | The link and the check at every open. |
| `paid-file` record | `{ object_key, object_store_ref, cas_hash, enc_alg, enc_nonce, enc_key_ref, required_access_refs, mime?, ttl_seconds? }` | One sold file's gate and how its bytes are sealed. |

## Not carried, and why

- **Hosted targets and carrier plumbing.** `signed-event-effects/do-work/signed-event-effects-targets.js` asks a signed-event authority to verify each event and a workflow slot to store each effect (`slot::workflow`, `signed-event-authority.admit-event`, `@bitfield/runtime-kit`); the descriptor guards, the `.bitfield-entry-scope` entries, the built-bytes receipts and the manifest's trigger and workflow records go with it. The projection is carried; the verifier is `tools/take-payments` (it checks a webhook's age and signature before keeping the event) and effects are worked out each time, never stored.
- **`product-access`** `do-work/read-session-access.ts`, `read-account-granted-access-refs.ts` and `invoke-owner-action.ts` (an account session and the old authority's list, and owner-action dispatch), `read-data/access-control-projection.ts`, `access-control-records.ts`, `read-product-access.ts`, `show/*` and `show-ios-jscore/*` (records into screen rows and press payloads) belong to the screens.
- **`capability-effect-lifecycle`** and **`material-delivery`** manifests (`things-to-store-and-run.json`) and the delivery package's `tools/` command line: old-engine records; the cipher and the seal command are carried.
- **Serving the bytes** to a buyer is the door's job, not a tool's: a route that takes the buyer's session, verifies it into `subject`, calls `tool:open-a-paid-file-for-a-buyer`, takes the key named by `enc_key_ref` from the person's held values and streams the sealed copy decrypted (seekable, with Range). It needs a live public address, the buyer's session and the key, which no container tool holds. Signing a lease (`canonicalLeaseBytes`) is the door's too.

## Limits

The records door lists a kind and does not search a field, so each ask reads every `payment-event`, `commercial-offer` and `access-grant` record of the person. A seller with very many payments wants those records keyed so a buyer's can be listed by prefix; this folder does not change what `tools/take-payments` writes.

## Dependencies

**Depends on:** `tools/records-door` (packed), `tools/content-identity` and `@noble/hashes` (packed by the seal row), Node 24 (runs `.ts` by stripping types).

**Depended on by:** the door's paid-file route (to be built). Reads what `tools/take-payments` keeps (`payment-event` records, the shape `tools/revenue-ledger` also reads).
