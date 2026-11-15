// Purpose: Resume the original canonical policy pause/drain/mutate/publish
// protocol over its existing directory and gate registry, one bounded step.
// Invariants: persist the update before any host call; move a cursor only after
// an exact acknowledged original owner; unknown/offline is never completion.
// Security: PolicyHost is the authenticated gate/quota owner bridge, including
// actual Mac commit-lifetime fencing. This file creates no gate, transport,
// signing authority, database or replacement commitment outcome.

use super::{
    bounded, canonical_account, mutate_drained, physical, put, read, unavailable, validate_receipt,
    AccountIdentity, CanonicalPolicyOwner, Change, Error, Receipt, Result, MAX_JSON, MAX_SAFE,
    RECEIPT_VERSION,
};
use crate::storage::{Intent, Range, Read, Row, Scope, Storage, Value as Stored, When};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fmt;

const FINAL_VERSION: &str = "trillion.completed-policy-update/v1";

#[derive(Clone, PartialEq, Eq)]
pub struct Gate {
    pub name: String,
    pub sign_in: String,
    pub resource: String,
}
impl fmt::Debug for Gate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PolicyGate([redacted])")
    }
}
/// The three gate fields, each bounded like every policy value.
const GATE: [Read<'static>; 3] =
    [Read::at_most("name", MAX_JSON), Read::at_most("sign_in", MAX_JSON), Read::at_most("resource", MAX_JSON)];
impl Gate {
    fn from_row(mut row: Row) -> Result<Self> {
        let mut text = |at| match row.take(at) {
            Stored::Text(text) => Ok(text),
            _ => Err(crate::cause!(Error::Unavailable)),
        };
        Ok(Self { name: text(0)?, sign_in: text(1)?, resource: text(2)? })
    }
    pub fn for_resource(account: &AccountIdentity, sign_in: &str, resource: &str) -> Result<Self> {
        if account.owner_id.len() != 64
            || !account
                .owner_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !bounded(sign_in, 300)
            || !bounded(resource, 512)
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let name = format!(
            "gate:{}",
            serde_json::to_string(&[account.owner_id.as_str(), sign_in, resource])
                .map_err(|error| unavailable(error))?
        );
        Ok(Self {
            name,
            sign_in: sign_in.into(),
            resource: resource.into(),
        })
    }
    fn validate(&self, account: &AccountIdentity) -> Result<()> {
        if Self::for_resource(account, &self.sign_in, &self.resource)? != *self {
            return Err(crate::cause!(Error::NotCanonical));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckPhase {
    Pause,
    Publish,
}

/// Only an authenticated original gate/quota owner may return this. The
/// generation is its ACTUAL current registration/resource generation, not a
/// default supplied by the directory. Mac acknowledgements require a closed
/// admission gate and terminal outcomes for every earlier physical commit.
pub struct Acknowledgement {
    pub owner_id: String,
    pub gate_name: Option<String>,
    pub update: String,
    pub directory_revision: u64,
    pub generation: String,
    pub phase: AckPhase,
}
pub enum HostStatus {
    Pending,
    Acknowledged(Acknowledgement),
}

/// Concrete supply belongs to the existing admission/transport owner. All four
/// calls are idempotent by update and exact target. Offline, lost replies,
/// unproved original outcomes and unrestored revision/generation return Pending.
/// There is no timeout/TTL conversion to an acknowledgement. A quota that is
/// actually not installed may be acknowledged only by its current source owner.
pub trait PolicyHost {
    fn pause_quota(
        &mut self,
        account: &AccountIdentity,
        update: &str,
        revision: u64,
    ) -> Result<HostStatus>;
    fn pause_gate(
        &mut self,
        account: &AccountIdentity,
        gate: &Gate,
        update: &str,
        revision: u64,
    ) -> Result<HostStatus>;
    fn publish_gate(
        &mut self,
        account: &AccountIdentity,
        gate: &Gate,
        update: &str,
        revision: u64,
        snapshot: &Value,
    ) -> Result<HostStatus>;
    fn publish_quota(
        &mut self,
        account: &AccountIdentity,
        update: &str,
        revision: u64,
        source: &Value,
    ) -> Result<HostStatus>;
}

pub enum UpdateStep {
    Pending,
    Advanced,
    Completed { revision: u64, receipt: Receipt },
}
impl fmt::Debug for UpdateStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Pending => "PolicyUpdate(Pending)",
            Self::Advanced => "PolicyUpdate(Advanced)",
            Self::Completed { .. } => "PolicyUpdate(Completed,[redacted])",
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    expected_revision: u64,
    change_identity: String,
    change: Change,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Finalized {
    version: String,
    update: String,
    request: Request,
    revision: u64,
    receipt: Receipt,
}

fn revision(store: &dyn Storage) -> Result<u64> {
    let value = read(store, "revision")?;
    // Original AccountControl directory default, not a screen revision.
    if value.is_null() {
        return Ok(0);
    }
    value
        .as_u64()
        .filter(|n| *n <= MAX_SAFE)
        .ok_or(crate::cause!(Error::Unavailable))
}
fn no_erasure(store: &dyn Storage) -> Result<()> {
    if !read(store, "account-erasure")?.is_null()
        || !read(store, "account-erasure-continuation")?.is_null()
    {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    Ok(())
}
fn transaction<T>(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    update: &str,
    identity: &str,
    run: impl FnOnce(&dyn Storage) -> Result<T>,
) -> Result<T> {
    {
        owner.assert_current(account, store)?;
        owner.assert_management_admission(account, update, identity)?;
        physical(store)?;
        if store.scoped() {
            return Err(crate::cause!(Error::SourceChanged));
        }
        let tx = Scope::begin(store, Intent::Write).map_err(|error| unavailable(error))?;
        canonical_account(&*tx, account)?;
        no_erasure(&*tx)?;
        let answer = run(&*tx)?;
        owner.assert_management_admission(account, update, identity)?;
        owner.assert_current(account, &*tx)?;
        physical(&*tx)?;
        tx.commit().map_err(|error| unavailable(error))?;
        Ok(answer)
    }
}
fn request(store: &dyn Storage, update: &str) -> Result<(Request, Value)> {
    if read(store, "update")?.as_str() != Some(update) {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let progress = read(store, "update-progress")?;
    if progress["id"].as_str() != Some(update) {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let request: Request = serde_json::from_value(progress["rights_request"].clone())
        .map_err(|error| crate::carry_cause!(Error::UpdateChanged, error))?;
    if request.expected_revision >= MAX_SAFE
        || request.change.identity()? != request.change_identity
        || revision(store)? != request.expected_revision
    {
        return Err(crate::cause!(Error::SourceChanged));
    }
    Ok((request, progress))
}
fn final_result(store: &dyn Storage, update: &str) -> Result<Option<Finalized>> {
    let value = read(store, "last-rights-update")?;
    if value.is_null() {
        return Ok(None);
    }
    let done: Finalized = serde_json::from_value(value).map_err(|error| unavailable(error))?;
    if done.update != update {
        return Ok(None);
    }
    if done.version != FINAL_VERSION
        || done.request.expected_revision >= MAX_SAFE
        || done.request.change.identity()? != done.request.change_identity
        || done.revision != done.request.expected_revision + 1
        || revision(store)? != done.revision
        || done.receipt.change_identity != done.request.change_identity
        || done.receipt.version != RECEIPT_VERSION
    {
        return Err(crate::cause!(Error::SourceChanged));
    }
    validate_receipt(store, &done.request.change, &done.receipt)?;
    Ok(Some(done))
}

/// Begin only the exact currently admitted canonical change. A foreign or
/// pre-existing unknown original update is preserved, never adopted/restarted.
pub fn begin_update(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    update: &str,
    expected_revision: u64,
    change: &Change,
) -> Result<UpdateStep> {
    if !bounded(update, 200) || expected_revision >= MAX_SAFE {
        return Err(crate::cause!(Error::Invalid));
    }
    let identity = change.identity()?;
    transaction(store, owner, account, update, &identity, |tx| {
        let active = read(tx, "update")?;
        if active.is_null() {
            if let Some(done) = final_result(tx, update)? {
                if done.request.change_identity != identity
                    || done.request.expected_revision != expected_revision
                {
                    return Err(crate::cause!(Error::DifferentChange));
                }
                return Ok(UpdateStep::Completed {
                    revision: done.revision,
                    receipt: done.receipt,
                });
            }
            if revision(tx)? != expected_revision {
                return Err(crate::cause!(Error::SourceChanged));
            }
            if read(tx, "abandoned-policy-update")?.as_str() == Some(update) {
                return Err(crate::cause!(Error::UpdateChanged));
            }
            // Claim before contacting ANY quota or gate owner. Current proof
            // issuance/registration must refuse while this original flag is held.
            put(tx, "update", &json!(update))?;
            put(
                tx,
                "update-progress",
                &json!({"id":update,"phase":"fence","fence_cursor":"","publish_cursor":"",
                "rights_request":Request {expected_revision,change_identity:identity.clone(),change:change.clone()},
                "quota_fenced":false,"quota_published":false}),
            )?;
            return Ok(UpdateStep::Advanced);
        }
        let (held, _) = request(tx, update)?;
        if held.expected_revision != expected_revision || held.change_identity != identity {
            return Err(crate::cause!(Error::DifferentChange));
        }
        Ok(UpdateStep::Advanced)
    })
}

fn acknowledged(
    status: HostStatus,
    account: &AccountIdentity,
    gate: Option<&Gate>,
    update: &str,
    revision: u64,
    phase: AckPhase,
) -> Result<bool> {
    match status {
        HostStatus::Pending => Ok(false),
        HostStatus::Acknowledged(ack) => {
            if ack.owner_id != account.owner_id
                || ack.gate_name.as_deref() != gate.map(|g| g.name.as_str())
                || ack.update != update
                || ack.directory_revision != revision
                || ack.phase != phase
                || !bounded(&ack.generation, 512)
            {
                return Err(crate::cause!(Error::UpdateChanged));
            }
            Ok(true)
        }
    }
}
fn next_gate(
    store: &dyn Storage,
    account: &AccountIdentity,
    after: &str,
) -> Result<Option<Gate>> {
    let gate = store
        .scan("policy_gates", &Range::all().after(vec![Stored::from(after)]).limit(1), &GATE)
        .map_err(|error| unavailable(error))?
        .pop()
        .map(Gate::from_row)
        .transpose()?;
    if let Some(gate) = &gate {
        gate.validate(account)?;
    }
    Ok(gate)
}
fn snapshot(store: &dyn Storage, account: &AccountIdentity, sign_in: &str) -> Result<Value> {
    let part = canonical_account(store, account)?;
    let mut result = Map::new();
    for name in [
        "lifecycle",
        "plan_marks",
        "access",
        "shared_relay",
        "account_controls",
        "account_budgets",
    ] {
        if let Some(value) = part.get(name) {
            result.insert(name.into(), value.clone());
        }
    }
    let row = read(store, &format!("policy-source:sign-in:{sign_in}"))?;
    if !row.is_null() && !row.is_object() {
        return Err(crate::cause!(Error::Unavailable));
    }
    result.insert(
        "sign_ins".into(),
        json!({sign_in:if row.is_null(){json!({})}else{row}}),
    );
    Ok(Value::Object(result))
}

fn complete_cursor(
    store: &dyn Storage,
    account: &AccountIdentity,
    cursor: &Value,
) -> Result<bool> {
    let cursor = cursor.as_str().ok_or(crate::cause!(Error::Unavailable))?;
    let last = store
        .scan("policy_gates", &Range::all().reverse().limit(1), &GATE)
        .map_err(|error| unavailable(error))?
        .pop()
        .map(Gate::from_row)
        .transpose()?;
    match last {
        None => Ok(cursor.is_empty()),
        Some(last) => {
            last.validate(account)?;
            Ok(cursor == last.name)
        }
    }
}
fn save_progress(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    update: &str,
    expected: &Request,
    before: &Value,
    after: Value,
) -> Result<UpdateStep> {
    transaction(
        store,
        owner,
        account,
        update,
        &expected.change_identity,
        |tx| {
            let (actual, current) = request(tx, update)?;
            if actual.change_identity != expected.change_identity || current != *before {
                return Err(crate::cause!(Error::UpdateChanged));
            }
            put(tx, "update-progress", &after)?;
            Ok(UpdateStep::Advanced)
        },
    )
}

/// Advance at most one actual host acknowledgement. Returning Pending leaves
/// the original update, registration barrier and all achieved pauses durable.
/// The actual Mac gate bridge is mandatory; this function has no host fallback.
pub fn resume_update(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    update: &str,
    host: &mut impl PolicyHost,
) -> Result<UpdateStep> {
    if !bounded(update, 200) {
        return Err(crate::cause!(Error::Invalid));
    }
    {
        owner.assert_current(account, store)?;
        physical(store)?;
        canonical_account(store, account)?;
        no_erasure(store)?;
        if read(store, "update")?.is_null() {
            let done = final_result(store, update)?.ok_or(crate::cause!(Error::UpdateChanged))?;
            return transaction(
                store,
                owner,
                account,
                update,
                &done.request.change_identity,
                |tx| {
                    let done = final_result(tx, update)?.ok_or(crate::cause!(Error::UpdateChanged))?;
                    Ok(UpdateStep::Completed {
                        revision: done.revision,
                        receipt: done.receipt,
                    })
                },
            );
        }
        let (held, progress) = request(store, update)?;
        owner.assert_management_admission(account, update, &held.change_identity)?;
        if !progress["quota_fenced"].is_boolean() || !progress["quota_published"].is_boolean() {
            return Err(crate::cause!(Error::Unavailable));
        }
        if matches!(progress["phase"].as_str(), Some("drained" | "published"))
            && (progress["quota_fenced"] != true
                || !complete_cursor(store, account, &progress["fence_cursor"])?)
        {
            return Err(crate::cause!(Error::NotDrained));
        }
        if progress["phase"] == "published"
            && !complete_cursor(store, account, &progress["publish_cursor"])?
        {
            return Err(crate::cause!(Error::NotDrained));
        }
        let mut after = progress.clone();
        match progress["phase"].as_str() {
            Some("fence") => {
                if progress["quota_fenced"] != true {
                    if !acknowledged(
                        host.pause_quota(account, update, held.expected_revision)?,
                        account,
                        None,
                        update,
                        held.expected_revision,
                        AckPhase::Pause,
                    )? {
                        return Ok(UpdateStep::Pending);
                    }
                    after["quota_fenced"] = json!(true);
                } else {
                    let cursor = progress["fence_cursor"]
                        .as_str()
                        .ok_or(crate::cause!(Error::Unavailable))?;
                    if let Some(gate) = next_gate(store, account, cursor)? {
                        if !acknowledged(
                            host.pause_gate(account, &gate, update, held.expected_revision)?,
                            account,
                            Some(&gate),
                            update,
                            held.expected_revision,
                            AckPhase::Pause,
                        )? {
                            return Ok(UpdateStep::Pending);
                        }
                        after["fence_cursor"] = json!(gate.name);
                    } else {
                        after["phase"] = json!("drained");
                    }
                }
                save_progress(store, owner, account, update, &held, &progress, after)
            }
            Some("drained") => {
                // Crash between mutation and cursor advance reuses its atomic
                // receipt; the accepted clock/generation are never recomputed.
                let receipt = mutate_drained(store, owner, account, update, &held.change)?;
                let (_, progress) = request(store, update)?;
                if receipt.change_identity != held.change_identity {
                    return Err(crate::cause!(Error::DifferentChange));
                }
                if receipt.version != RECEIPT_VERSION {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                let mut after = progress.clone();
                let cursor = progress["publish_cursor"]
                    .as_str()
                    .ok_or(crate::cause!(Error::Unavailable))?;
                if let Some(gate) = next_gate(store, account, cursor)? {
                    let source = snapshot(store, account, &gate.sign_in)?;
                    if !acknowledged(
                        host.publish_gate(
                            account,
                            &gate,
                            update,
                            held.expected_revision + 1,
                            &source,
                        )?,
                        account,
                        Some(&gate),
                        update,
                        held.expected_revision + 1,
                        AckPhase::Publish,
                    )? {
                        return Ok(UpdateStep::Pending);
                    }
                    after["publish_cursor"] = json!(gate.name);
                } else {
                    after["phase"] = json!("published");
                }
                save_progress(store, owner, account, update, &held, &progress, after)
            }
            Some("published") => {
                if progress["quota_published"] != true {
                    let source = read(store, "policy-source:quota")?;
                    if !source.is_object() {
                        return Err(crate::cause!(Error::NotCanonical));
                    }
                    if !acknowledged(
                        host.publish_quota(account, update, held.expected_revision + 1, &source)?,
                        account,
                        None,
                        update,
                        held.expected_revision + 1,
                        AckPhase::Publish,
                    )? {
                        return Ok(UpdateStep::Pending);
                    }
                    after["quota_published"] = json!(true);
                    return save_progress(
                        store, owner, account, update, &held, &progress, after,
                    );
                }
                transaction(
                    store,
                    owner,
                    account,
                    update,
                    &held.change_identity,
                    |tx| {
                        let (actual, current) = request(tx, update)?;
                        if actual.change_identity != held.change_identity
                            || current != progress
                            || current["quota_published"] != true
                        {
                            return Err(crate::cause!(Error::UpdateChanged));
                        }
                        let receipt: Receipt =
                            serde_json::from_value(current["rights_change"].clone())
                                .map_err(|error| unavailable(error))?;
                        if receipt.change_identity != held.change_identity {
                            return Err(crate::cause!(Error::DifferentChange));
                        }
                        if receipt.version != RECEIPT_VERSION {
                            return Err(crate::cause!(Error::SourceChanged));
                        }
                        validate_receipt(tx, &held.change, &receipt)?;
                        let next = held.expected_revision + 1;
                        put(
                            tx,
                            "last-rights-update",
                            &serde_json::to_value(Finalized {
                                version: FINAL_VERSION.into(),
                                update: update.into(),
                                request: held.clone(),
                                revision: next,
                                receipt: receipt.clone(),
                            })
                            .map_err(|error| unavailable(error))?,
                        )?;
                        tx.erase("policy_directory", &Range::prefix("source-snapshot:"))
                            .map_err(|error| unavailable(error))?;
                        put(tx, "revision", &json!(next))?;
                        for name in ["update", "update-progress", "update-recovery"] {
                            put(tx, name, &Value::Null)?;
                        }
                        Ok(UpdateStep::Completed {
                            revision: next,
                            receipt,
                        })
                    },
                )
            }
            _ => Err(crate::cause!(Error::NotDrained)),
        }
    }
}

pub trait GateRegistrationOwner: CanonicalPolicyOwner {
    /// Validate the actual admitted resource/generation registration, not fields
    /// supplied by a client. Registration alone does not make its transport ready.
    fn assert_gate_registration(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
        gate: &Gate,
        revision: u64,
    ) -> Result<()>;
}
#[derive(Debug, PartialEq, Eq)]
pub enum Registration {
    Pending,
    Recorded { revision: u64 },
}

/// Existing policy_gates bookkeeping, before an actual gate can admit effects.
/// New registrations cannot enter behind a pause cursor during an update.
/// The transport owner still restores/verifies current revision AND generation
/// before it advertises readiness; this function issues no client/device proof.
pub fn register_gate(
    store: &dyn Storage,
    owner: &mut impl GateRegistrationOwner,
    account: &AccountIdentity,
    gate: &Gate,
    expected_revision: u64,
) -> Result<Registration> {
    gate.validate(account)?;
    {
        owner.assert_current(account, store)?;
        owner.assert_gate_registration(account, store, gate, expected_revision)?;
        physical(store)?;
        if store.scoped() {
            return Err(crate::cause!(Error::SourceChanged));
        }
        let tx = Scope::begin(store, Intent::Write).map_err(|error| unavailable(error))?;
        canonical_account(&*tx, account)?;
        no_erasure(&*tx)?;
        let result = if !read(&*tx, "update")?.is_null() {
            Registration::Pending
        } else {
            if revision(&*tx)? != expected_revision {
                return Err(crate::cause!(Error::SourceChanged));
            }
            let prior = tx
                .get("policy_gates", &[Stored::from(gate.name.as_str())], &GATE)
                .map_err(|error| unavailable(error))?
                .map(Gate::from_row)
                .transpose()?;
            if prior.is_some_and(|prior| prior.sign_in != gate.sign_in || prior.resource != gate.resource) {
                return Err(crate::cause!(Error::NotCanonical));
            }
            let row = [
                ("name", Stored::from(gate.name.as_str())),
                ("sign_in", Stored::from(gate.sign_in.as_str())),
                ("resource", Stored::from(gate.resource.as_str())),
            ];
            tx.put("policy_gates", &row, When::Absent).map_err(|error| unavailable(error))?;
            Registration::Recorded {
                revision: expected_revision,
            }
        };
        owner.assert_gate_registration(account, &*tx, gate, expected_revision)?;
        owner.assert_current(account, &*tx)?;
        physical(&*tx)?;
        tx.commit().map_err(|error| unavailable(error))?;
        Ok(result)
    }
}

#[cfg(test)]
mod old_permission_snapshot_tests {
    //! Ported from old trillion test/permission-snapshot-no-relay-write.test.mjs (tag old-trillion-before-worker-retire,
    //! b6ae0ebf81), deleted by Trillion-X/trillion #243. The old PersonStore.resourceAdmissionSnapshot is this file's
    //! `snapshot`, the policy part a gate is given, read from the account's canonical policy directory (`account_policy`
    //! schema, here in memory); the old record log's last id is the directory's change count. The old
    //! "account-policy-fence-required" refusal of a protected write outside a policy change is `mutate_drained`'s
    //! refusal of a change made outside the update it names (`UpdateChanged`). The old `resourceAdmissionEnabled` flag has
    //! no owner: there is no admission switch here.
    use super::*;
    use crate::storage::{memory::Memory, Storage};

    const OWNER: &str = "abababababababababababababababababababababababababababababababab";

    fn directory(relay: Option<&str>) -> (Memory, AccountIdentity) {
        let store = Memory::open("account_policy").unwrap();
        let account = AccountIdentity { user_id: "permission-snapshot-relay".into(), owner_id: OWNER.into() };
        put(&store, "policy-source", &json!({"from": "born", "missing": []})).unwrap();
        let mut part = json!({"lifecycle": {}, "access": {}, "plan_marks": {}, "account_controls": {"owner_user_id": account.user_id}});
        if let Some(relay) = relay {
            part["shared_relay"] = json!(relay);
        }
        put(&store, "policy-source:account", &part).unwrap();
        (store, account)
    }

    struct Owner;
    impl CanonicalPolicyOwner for Owner {
        fn assert_current(&mut self, _: &AccountIdentity, _: &dyn Storage) -> Result<()> {
            Ok(())
        }
        fn assert_management_admission(&mut self, _: &AccountIdentity, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
    }

    /// "blank permission discovery returns the actual absent shared identity without creating a protected relay record".
    #[test]
    fn old_permission_snapshot_no_relay_write_a_blank_discovery_answers_no_relay_and_writes_nothing() {
        let (store, account) = directory(None);
        assert_eq!(read(&store, "policy-source:account").unwrap().get("shared_relay"), None);
        let before = store.changes();
        let answered = snapshot(&store, &account, "session:permission-fixture").unwrap();
        assert_eq!(answered.get("shared_relay"), None, "the absent shared identity is answered absent");
        assert_eq!(read(&store, "policy-source:account").unwrap().get("shared_relay"), None, "and no relay is made");
        assert_eq!(store.changes(), before, "permission discovery writes no account record");
    }

    /// "permission discovery preserves the genuine existing relay and still refuses uncovered protected writes".
    #[test]
    fn old_permission_snapshot_no_relay_write_an_existing_relay_is_kept_and_a_change_outside_its_update_is_refused() {
        let relay = format!("relay_{}", "a".repeat(32));
        let (store, account) = directory(Some(&relay));
        let before = store.changes();
        let answered = snapshot(&store, &account, "session:permission-fixture").unwrap();
        assert_eq!(answered["shared_relay"], relay.as_str());
        assert_eq!(store.changes(), before);
        let refused = mutate_drained(&store, &mut Owner, &account, "update-not-begun", &Change::Disconnect { at_ms: 1_800_000_000_000 });
        assert!(matches!(refused, Err(Error::UpdateChanged(_))), "a protected change outside a policy update is refused");
        assert_eq!(read(&store, "policy-source:account").unwrap()["shared_relay"], relay.as_str(), "the prior identity is kept");
        assert_eq!(read(&store, "policy-source:account").unwrap()["lifecycle"].get("disconnected_at"), None, "and nothing changed");
    }

    /// Ported from old trillion test/case-decision-publication-fence.test.mjs (tag old-trillion-before-worker-retire,
    /// b6ae0ebf81), deleted by Trillion-X/trillion #243: "any other protected setting written outside a policy change is
    /// still refused". A rights change named under an update that was never begun is refused and changes nothing. The
    /// old file's two sharing tests (a case decision's sharing and its removal each under a change of its own) belong to
    /// trillion-workshop tools/decide-with-a-method (share-a-decision.mjs) and are not ported here.
    #[test]
    fn old_case_decision_publication_fence_a_protected_change_outside_a_policy_change_is_refused() {
        let (store, account) = directory(None);
        let before = store.changes();
        let refused = mutate_drained(&store, &mut Owner, &account, "no-change-held", &Change::EndSignIn { sign_in: "key:writer".into(), at_ms: 1_800_000_000_000 });
        assert!(matches!(refused, Err(Error::UpdateChanged(_))), "the write must hold a policy change first");
        assert!(read(&store, "policy-source:sign-in:key:writer").unwrap().is_null(), "nothing was written");
        assert_eq!(store.changes(), before);
    }
}
