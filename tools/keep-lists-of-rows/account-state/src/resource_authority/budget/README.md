# Native finite resource admission

`budget.rs` keeps the existing credit/hold semantics without a provider or a
commercial billing engine. A trusted host supplies an immutable captured finite
grant, its protected declared record store state resource and a synchronous current-policy
witness. `Owner` reserves with compare-and-set and checks current authority inside
record store's actual write check. All handles sharing the same durable grant book compete
for `used + held + asked <= limit`. Overflow refuses admission.

`Reservation::New` alone carries a non-cloneable dispatch capability. Replays
return state, never another dispatch capability. `start` persists before dispatch
and refuses a second start. Measured terminal settlement replaces the hold with
actual integer units; exact receipt retries are idempotent and changed receipts
conflict. Unknown and partial outcomes retain the entire bound, with observed work
kept separately. Drop, timeout, cancellation and hold expiry never infer zero.
Only explicit unstarted release or host-attested reconciliation releases credit.
`CapturedGrant::restore` allows recovery after expiry/revocation while admission
stays closed. Each captured block is bounded to 1,024 immutable hold entries;
exhausting the block requires a new independently captured grant, never pruning a
retry identity or silently replenishing the old grant.

The exported `account_files::Chunks` adapter is the account files byte allowance's chunk
supply (`source_reads::Supply`). The allowance asks it for a chunk only from its own
thread, off every request path: each chunk is one hold, reserved and started before
its bytes become resident, and settled once (as wholly consumed) when it is used up or
its handle is dropped. A chunk never settled after a crash stays held, so it counts as
consumed, never as unused. Durability is one hold per chunk, never per read, so the
1,024-hold bound of a captured block is 1,024 chunks. The grant's unit must be
`namespace-file-bytes` (admitted bytes, read and written); these are not supplier
invoice units.

The host policy must attest the exact origin/basis, unit, account, payer, bound,
expiry and original funding effect, enforce funding uniqueness across grant IDs,
and protect one authoritative state home from customer edits, erasure or copies.
The state resource is host-selected and must already be declared by the storage
owner. The tests use an isolated temporary SQLite file and a declared internal
resource only as a fixture; this does not install budget state in a live grant
store. `own-records` is explicitly refused. No caller-editable balance, included
plan, migrated quota credit or physical journal constitutes funding. External/BYO
is a separately host-attested payer and still consumes finite resource units.
Client-rights signatures authorize access only. Tariffs, prices, hierarchical
markup and the default 30% stay with the Workshop DATA/product owner.

The host mount. Personal account files ingress in `src/native_boot/mcp_local.rs`, OAuth
ingress in `src/native_boot/mcp_selected_personal/oauth_dispatch.rs` and the person's own page
all call `AccountFilesDoor::call_while`, which lets a call's bytes in as DATA
`call_bytes` (`src/account_files/account-files-routes.json`) says. `counted` (shipped) lets them
in under one unmetered name, each byte counted as the account's usage; `refused` lets none in;
`funded` lets in only what the host's funded allowance for that account covers. At start
(`src/native_entry.rs` `run_selected`) a funded door gets `account_files::Funded`
(`Funded::from_settings`, DATA `funded`): on an account's first funded call it opens
`funding::Native` on that account's state folder with the issuers DATA trusts, picks the current
capture of unit `namespace-file-bytes` that expires last (`Native::current`), and composes
`Allowance::open(Arc::new(native.chunks(issuer, effect)?), chunk_bytes, low_water_bytes, ..)`.
No capture, an untrusted issuer, a revoked or an expired capture: no allowance, so those bytes are
refused before dispatch. A spent allowance is replaced only by another current capture.

Still not claimed: no real funding issuer key is listed in DATA (`funded.issuers` is empty), no
payment owner signs and applies captures (`Native::apply`), and the shipped door stays `counted`.
Those are the payment/treasury owner's to supply. `ClientGrant` in `src/signed_authority.rs` still
signs client scope and rights revision only, not spending.

`tests/resource_budget.rs` covers independent SQLite-handle races, exact retries,
revocation at the actual commit check, expiry, recovery, no implicit included-use
funding, external payer distinction, unknown/partial/no-dispatch observations,
journal failures and integer overflow. Four chunk-supply cases are normal Cargo tests in
`tests/resource_budget_account_files.rs`: a grant of another unit is refused, many reads
hold one hold per chunk and a used-up chunk settles whole off the path, a dropped
handle settles its remainder as consumed, and an unsettled chunk after a crash stays
held. Ten core cases are normal Cargo tests too.

The `ed07163` committed snapshot passed all 21 commit gates, including
`cargo check --all-targets`. Its ten core tests also passed through contained
Cargo against the gate's exact staged-tree snapshot. The shared dirty working
folder separately has unrelated SQLite `Borrow<Connection>` lending errors and
an invalid `Self` use in `account/oauth_store.rs`; those edits were not included.

A focused harness additionally compiled the current budget and adapter sources
plus the current observation trait definitions against the retained October 30
compiled production storage library: all 14 core/observer cases passed. This
narrower adapter result is not a current-tree integration, production mount,
migration or customer-billing proof. Recovery inspection has its own host-only
authority, so expired orphaned holds remain discoverable without restoring
dispatch. Argon advice was attempted and returned
`proxy_unavailable_or_invalid_reply`; source and behavior were checked locally.

## Protected signed funding owner

`funding::Native` now supplies the concrete protected host capture owner. Its
`open(root, account, trusted_issuers, clock, signature_domain)` selects the declared internal
`@resource-budget/funding` and `@resource-budget/leases` resources and refuses
different physical placements. Both use the same authoritative writer. Each
signed capture binds one issuer effect to an exact account, origin, integer
resource bound, expiry and real physical folder identity. Copies of the folder
do not inherit funding. A customer record, access signature or configured price
does not introduce an issuer trust key.

`apply(signed_instruction)` verifies Ed25519 under the host's independently
configured funding signature domain before capture, revocation or
terminal recovery. One immutable effect cannot create multiple grants. Exact
capture retries retain state after expiry and cannot clear a revoke. Revocation
before capture retains a tombstone, so reordered delivery cannot reactivate the
effect. Started/unknown holds keep their original obligation until measured
completion or independently signed terminal recovery. BYO remains an explicitly
attested external payer, separate from company funds.

The callable ingress composition is `native.chunks(issuer, effect)`; it
constructs the finite `account_files::Chunks` supply from that exact protected
capture. This API does not itself create money, choose tariffs, install trust,
or infer payment from a subscription. The service's real payment/treasury owner
must issue genuinely backed captures and install its independent issuer key
before personal/OAuth ingress can select them. Until then reads at those doors
refuse (no admission); no funding is invented. No production capture or monetary
mount is claimed.

Six Cargo tests in `tests/resource_funding.rs` pass (the sixth: the host's `Funded` opens an
allowance only over a current signed capture, admits two whole chunks of a 2,500-byte grant, and
opens none after revoke or for another account). The first five passed against the
current source and real native record store homes, covering wrong signature domains and
scope, effect deduplication, independent-handle overspend races, revocation,
expiry, signed recovery, BYO and reordered revoke/capture. Per-customer capacity
policy (request rate, bandwidth rate and concurrency) is still a distinct host
mount; a finite financial grant alone does not establish availability isolation.
