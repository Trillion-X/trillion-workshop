//! Forward-only carry state for relocating one closed record store invariant group.
//!
//! A `Carry` is a value owned by the source placement owner. That owner must
//! persist each returned value together with its stop of writes or route update
//! in the owner's existing transaction. This module has no database handle,
//! opener, or alternate writer: a caller cannot turn a state transition into a
//! second commit domain by using this API.
//!
//! The protocol separates bounded copying from publication. A restart reads
//! the last source-owned `Carry`, retries the same operation identity, and
//! continues forward. An uncertain publish is resolved by reading the source
//! owner's saved state; it is never permission to dispatch an effect at the
//! other placement.

use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};

/// One logical placement and generation in the closed group.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Placement {
    pub resource: String,
    pub generation: String,
}

/// Source-attested contents that must move as one invariant group.
///
/// `members` are canonical resource names, sorted and unique. The source owner
/// derives the list from its live invariants; callers must not accept a list
/// supplied by a request as proof of closure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Manifest {
    pub owner: String,
    pub group: String,
    pub source: Placement,
    pub destination: Placement,
    pub members: Vec<String>,
    pub source_revision: String,
}

impl Manifest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.owner.is_empty()
            || self.group.is_empty()
            || self.source.resource.is_empty()
            || self.source.generation.is_empty()
            || self.destination.resource.is_empty()
            || self.destination.generation.is_empty()
            || self.source.resource == self.destination.resource
            || self.source_revision.is_empty()
            || self.members.is_empty()
            || self.members.iter().any(String::is_empty)
            || self.members.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(())
    }

    /// BLAKE3 identity over an unambiguous, versioned, length-prefixed form.
    pub fn identity(&self) -> Result<String, Error> {
        self.validate()?;
        let mut hash = blake3::Hasher::new();
        fn part(hash: &mut blake3::Hasher, value: &[u8]) {
            hash.update(&(value.len() as u64).to_le_bytes());
            hash.update(value);
        }
        part(&mut hash, b"s2h-invariant-carry/v1");
        for value in [
            self.owner.as_str(),
            self.group.as_str(),
            self.source.resource.as_str(),
            self.source.generation.as_str(),
            self.destination.resource.as_str(),
            self.destination.generation.as_str(),
            self.source_revision.as_str(),
        ] {
            part(&mut hash, value.as_bytes());
        }
        part(&mut hash, &(self.members.len() as u64).to_le_bytes());
        for member in &self.members {
            part(&mut hash, member.as_bytes());
        }
        Ok(hash.finalize().to_hex().to_string())
    }
}

/// Independent destination readback supplied by the destination owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Proof {
    pub manifest_identity: String,
    pub source_revision: String,
    pub destination_generation: String,
    pub rows: u64,
    pub digest: String,
    pub independent_readback: bool,
    pub no_extra_rows: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Phase {
    Prepared,
    #[serde(rename = "Frozen")] WritesStopped,
    Copying,
    Proved,
    Published,
}

/// Durable value the source owner saves alongside its route or its stop of writes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Carry {
    pub manifest: Manifest,
    pub manifest_identity: String,
    pub phase: Phase,
    pub route_generation: String,
    #[serde(rename = "fence_operation")] pub stop_writes_operation: Option<String>,
    #[serde(rename = "fence_identity")] pub stop_writes_identity: Option<String>,
    pub cursor: Option<String>,
    pub rows_copied: u64,
    pub rolling_digest: String,
    pub last_page: Option<PageReceipt>,
    pub proof: Option<Proof>,
    pub publish_operation: Option<String>,
}

/// Receipt for the last page only. This keeps recovery metadata bounded; an
/// older page retry is refused and cannot overwrite newer destination state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageReceipt {
    pub operation: String,
    pub from: Option<String>,
    pub through: String,
    pub rows: u32,
    pub digest: String,
}

#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Incomplete(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Changed(cause) => cause.clone(),
            Self::Conflict(cause) => cause.clone(),
            Self::Incomplete(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);


impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Invalid(_),Self::Invalid(_)) => true,
            (Self::Changed(_),Self::Changed(_)) => true,
            (Self::Conflict(_),Self::Conflict(_)) => true,
            (Self::Incomplete(_),Self::Incomplete(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Error {}


impl Carry {
    /// Start from a source-derived manifest and the route generation observed
    /// under the source owner's current transaction.
    pub fn prepare(manifest: Manifest, route_generation: String) -> Result<Self, Error> {
        manifest.validate()?;
        if route_generation.is_empty() {
            return Err(crate::cause!(Error::Invalid));
        }
        let manifest_identity = manifest.identity()?;
        Ok(Self {
            manifest,
            manifest_identity,
            phase: Phase::Prepared,
            route_generation,
            stop_writes_operation: None,
            stop_writes_identity: None,
            cursor: None,
            rows_copied: 0,
            rolling_digest: String::new(),
            last_page: None,
            proof: None,
            publish_operation: None,
        })
    }

    /// Stop writes at the old source inside its commit owner. Reusing the operation is
    /// safe only for the same manifest and stop-writes generation.
    pub fn stop_writes(&self, operation: &str, stop_writes_identity: &str) -> Result<Self, Error> {
        self.check_saved()?;
        if operation.is_empty() || stop_writes_identity.is_empty() {
            return Err(crate::cause!(Error::Invalid));
        }
        if self.phase != Phase::Prepared {
            return match (&self.stop_writes_operation, &self.stop_writes_identity) {
                (Some(held_op), Some(held_stop_writes))
                    if held_op == operation && held_stop_writes == stop_writes_identity =>
                {
                    Ok(self.clone())
                }
                _ => Err(crate::cause!(Error::Conflict)),
            };
        }
        let mut next = self.clone();
        next.phase = Phase::WritesStopped;
        next.stop_writes_operation = Some(operation.to_owned());
        next.stop_writes_identity = Some(stop_writes_identity.to_owned());
        Ok(next)
    }

    /// Record one successfully imported destination page. The caller persists
    /// the destination import receipt before committing this source progress;
    /// after a crash, the same page operation is safe to retry at either side.
    pub fn page(&self, receipt: PageReceipt, max_rows: u32) -> Result<Self, Error> {
        self.check_saved()?;
        if !matches!(self.phase, Phase::WritesStopped | Phase::Copying)
            || receipt.operation.is_empty()
            || receipt.through.is_empty()
            || receipt.rows == 0
            || receipt.rows > max_rows
            || receipt.digest.is_empty()
        {
            return Err(crate::cause!(Error::Invalid));
        }
        if self.last_page.as_ref() == Some(&receipt) {
            return Ok(self.clone());
        }
        if self
            .last_page
            .as_ref()
            .is_some_and(|held| held.operation == receipt.operation)
        {
            return Err(crate::cause!(Error::Conflict));
        }
        if receipt.from != self.cursor {
            return Err(crate::cause!(Error::Changed));
        }
        if receipt.through == receipt.from.as_deref().unwrap_or("") {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut next = self.clone();
        next.phase = Phase::Copying;
        next.cursor = Some(receipt.through.clone());
        next.rows_copied = next
            .rows_copied
            .checked_add(receipt.rows as u64)
            .ok_or(crate::cause!(Error::Invalid))?;
        next.rolling_digest = chain_digest(&next.rolling_digest, &receipt.digest);
        next.last_page = Some(receipt);
        next.proof = None;
        Ok(next)
    }

    /// Accept the destination's complete independent readback proof. A mere
    /// page count or self-read from the source does not qualify.
    pub fn prove(
        &self,
        proof: Proof,
        expected_rows: u64,
        expected_digest: &str,
    ) -> Result<Self, Error> {
        self.check_saved()?;
        if !matches!(self.phase, Phase::Copying | Phase::WritesStopped)
            || proof.manifest_identity != self.manifest_identity
            || proof.source_revision != self.manifest.source_revision
            || proof.destination_generation != self.manifest.destination.generation
            || proof.rows != expected_rows
            || expected_rows != self.rows_copied
            || proof.digest != expected_digest
            || expected_digest != self.rolling_digest
            || !proof.independent_readback
            || !proof.no_extra_rows
        {
            return Err(crate::cause!(Error::Incomplete));
        }
        let mut next = self.clone();
        next.phase = Phase::Proved;
        next.proof = Some(proof);
        Ok(next)
    }

    /// Publish one route generation at the source owner after proof. The
    /// caller performs this state change and its route pointer update in one
    /// source-owner commit. A retry must carry the identical operation id.
    pub fn publish(&self, operation: &str, expected_route_generation: &str) -> Result<Self, Error> {
        self.check_saved()?;
        if operation.is_empty() || expected_route_generation != self.route_generation {
            return Err(crate::cause!(Error::Changed));
        }
        if self.phase == Phase::Published {
            return if self.publish_operation.as_deref() == Some(operation) {
                Ok(self.clone())
            } else {
                Err(crate::cause!(Error::Conflict))
            };
        }
        if self.phase != Phase::Proved || self.proof.is_none() {
            return Err(crate::cause!(Error::Incomplete));
        }
        let mut next = self.clone();
        next.phase = Phase::Published;
        next.publish_operation = Some(operation.to_owned());
        Ok(next)
    }

    /// Validate a recovered value before using it as the source of the next
    /// transition. Corrupt or stale durable state fails closed.
    pub fn check_saved(&self) -> Result<(), Error> {
        self.manifest.validate()?;
        if self.manifest.identity()? != self.manifest_identity || self.route_generation.is_empty() {
            return Err(crate::cause!(Error::Changed));
        }
        let writes_stopped = self.stop_writes_operation.is_some() == self.stop_writes_identity.is_some();
        if !writes_stopped {
            return Err(crate::cause!(Error::Changed));
        }
        match self.phase {
            Phase::Prepared
                if self.stop_writes_operation.is_some()
                    || self.proof.is_some()
                    || self.publish_operation.is_some() =>
            {
                Err(crate::cause!(Error::Changed))
            }
            Phase::WritesStopped
                if self.stop_writes_operation.is_none()
                    || self.proof.is_some()
                    || self.publish_operation.is_some() =>
            {
                Err(crate::cause!(Error::Changed))
            }
            Phase::Copying
                if self.stop_writes_operation.is_none()
                    || self.cursor.is_none()
                    || self.last_page.is_none()
                    || self.proof.is_some() =>
            {
                Err(crate::cause!(Error::Changed))
            }
            Phase::Proved
                if self.stop_writes_operation.is_none()
                    || self.proof.is_none()
                    || self.publish_operation.is_some() =>
            {
                Err(crate::cause!(Error::Changed))
            }
            Phase::Published
                if self.stop_writes_operation.is_none()
                    || self.proof.is_none()
                    || self.publish_operation.is_none() =>
            {
                Err(crate::cause!(Error::Changed))
            }
            _ => Ok(()),
        }
    }
}

fn chain_digest(previous: &str, page: &str) -> String {
    let mut hash = blake3::Hasher::new();
    for bytes in [previous.as_bytes(), page.as_bytes()] {
        hash.update(&(bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            owner: "acct".into(),
            group: "records:alpha".into(),
            source: Placement {
                resource: "record-book".into(),
                generation: "7".into(),
            },
            destination: Placement {
                resource: "records-alpha".into(),
                generation: "1".into(),
            },
            members: vec!["alpha".into(), "alpha-key".into()],
            source_revision: "revision-10".into(),
        }
    }

    fn writes_stopped() -> Carry {
        Carry::prepare(manifest(), "route-3".into())
            .unwrap()
            .stop_writes("stop-writes-1", "fence-11")
            .unwrap()
    }

    #[test]
    fn carries_forward_and_publishes_only_after_independent_complete_proof() {
        let started = writes_stopped();
        let page = PageReceipt {
            operation: "page-1".into(),
            from: None,
            through: "m".into(),
            rows: 2,
            digest: "d1".into(),
        };
        let copying = started.page(page.clone(), 100).unwrap();
        assert_eq!(
            copying.page(page, 100).unwrap(),
            copying,
            "last page retry is idempotent"
        );
        assert_eq!(
            copying.publish("publish-1", "route-3"),
            Err(crate::cause!(Error::Incomplete))
        );
        let proof = Proof {
            manifest_identity: copying.manifest_identity.clone(),
            source_revision: copying.manifest.source_revision.clone(),
            destination_generation: copying.manifest.destination.generation.clone(),
            rows: 2,
            digest: copying.rolling_digest.clone(),
            independent_readback: true,
            no_extra_rows: true,
        };
        let proved = copying.prove(proof, 2, &copying.rolling_digest).unwrap();
        let published = proved.publish("publish-1", "route-3").unwrap();
        assert_eq!(published.phase, Phase::Published);
        assert_eq!(
            published.publish("publish-1", "route-3").unwrap(),
            published
        );
        assert_eq!(
            published.publish("other-op", "route-3"),
            Err(crate::cause!(Error::Conflict))
        );
    }

    #[test]
    fn stale_cursor_manifest_or_route_generation_refuses() {
        let started = writes_stopped();
        let page = PageReceipt {
            operation: "page-1".into(),
            from: Some("stale".into()),
            through: "m".into(),
            rows: 2,
            digest: "d1".into(),
        };
        assert_eq!(started.page(page, 100), Err(crate::cause!(Error::Changed)));
        let mut corrupt = started.clone();
        corrupt.manifest.source_revision.push('x');
        assert_eq!(corrupt.check_saved(), Err(crate::cause!(Error::Changed)));
        assert_eq!(started.publish("publish-1", "route-4"), Err(crate::cause!(Error::Changed)));
    }

    #[test]
    fn a_recovered_page_replays_its_last_receipt_without_advancing_twice() {
        let started = writes_stopped();
        let page = PageReceipt {
            operation: "page-1".into(),
            from: None,
            through: "m".into(),
            rows: 2,
            digest: "d1".into(),
        };
        let committed = started.page(page.clone(), 100).unwrap();
        // The source owner's durable row is represented by its serialized form;
        // a fresh owner reconstructs and validates it before retrying.
        let bytes = serde_json::to_vec(&committed).unwrap();
        let recovered: Carry = serde_json::from_slice(&bytes).unwrap();
        recovered.check_saved().unwrap();
        assert_eq!(recovered.page(page, 100).unwrap(), committed);
        assert_eq!(
            recovered.rows_copied, 2,
            "a recovered retry does not double count"
        );
    }

    #[test]
    fn manifest_members_must_be_sorted_unique_and_nonempty() {
        let mut bad = manifest();
        bad.members.swap(0, 1);
        assert_eq!(bad.validate(), Err(crate::cause!(Error::Invalid)));
        let mut duplicate = manifest();
        duplicate.members[1] = duplicate.members[0].clone();
        assert_eq!(duplicate.validate(), Err(crate::cause!(Error::Invalid)));
    }
}

/// Captured bounded copy and fenced activation over generic Storage.
#[path = "live_adopt.rs"]
pub mod live_adopt;

/// Durable complete-command frames shared by adoption and replication. The
/// source appends inside the original effect/key/index/receipt transaction;
/// the receiver applies a complete frame and its frontier in one scope.
/// Retention never silently loses an unconsumed frame. The authority owner
/// supplies a proved safe consumer floor before bounded trimming.
pub mod commit_log {
    use super::live_adopt::{self, Effect, Limits};
    use crate::storage::{Bound, Error, Intent, Range, Read, Result, Scope, Storage, Value, When};
    use serde::{Deserialize, Serialize};
    const STATE: &str = "command_commit_state";
    const LOG: &str = "command_commits";

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct CapturedCommit { pub sequence: i64, pub identity: String, pub effects: Vec<Effect> }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Receipt { sequence: i64, digest: String }
    #[derive(Default, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Stream { floor: i64, through: i64, bytes: u64, #[serde(default)] last_digest:Option<String> }
    /// A durable, unpublished command. The original source is retained so a
    /// later writer can resolve an uncertain local close without redispatch.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct Pending {pub source:String,pub term:u64,pub sequence:i64,pub digest:String,pub base:i64}
    pub(crate) fn pending(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<Pending>> {
        valid(stream,limits)?;
        let value=get::<Pending>(store,&key("pending",stream,"")?,limits.commit_bytes)?;
        if value.as_ref().is_some_and(|value|value.source.is_empty()||value.term==0||value.base<0||value.sequence!=value.base.saturating_add(1)||value.digest.len()!=64) {return Err(crate::cause!(Error::Invalid));}
        Ok(value)
    }
    pub(crate) fn prepare(store:&dyn Storage,stream:&str,value:&Pending,limits:Limits)->Result<()> {
        if !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Invalid));}
        if pending(store,stream,limits)?.is_some_and(|old|old!=*value) {return Err(crate::cause!(Error::Conflict));}
        save(store,&key("pending",stream,"")?,value)
    }
    pub(crate) fn clear_pending(store:&dyn Storage,stream:&str,sequence:i64,digest:&str,limits:Limits)->Result<()> {
        if !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Invalid));}
        if let Some(held)=pending(store,stream,limits)? {
            if held.sequence!=sequence || held.digest!=digest {return Err(crate::cause!(Error::Conflict));}
            let slot=key("pending",stream,"")?;let mut range=Range::all();range.from=Bound::Included(vec![slot.into()]);range.to=range.from.clone();store.erase(STATE,&range)?;
        }
        Ok(())
    }
    pub(crate) fn notice(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<(i64,String)>> {
        Ok(get::<Receipt>(store,&key("notice",stream,"")?,limits.commit_bytes)?.map(|held|(held.sequence,held.digest)))
    }
    pub(crate) fn mark_notice(store:&dyn Storage,stream:&str,sequence:i64,digest:&str)->Result<()> {
        if !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Invalid));}
        save(store,&key("notice",stream,"")?,&Receipt {sequence,digest:digest.into()})
    }
    pub(crate) fn clear_notice(store:&dyn Storage,stream:&str,sequence:i64,digest:&str,limits:Limits)->Result<()> {
        if !store.scoped() || !store.writing()? || notice(store,stream,limits)?.as_ref()!=Some(&(sequence,digest.into())) {return Err(crate::cause!(Error::Conflict));}
        let slot=key("notice",stream,"")?;let mut range=Range::all();range.from=Bound::Included(vec![slot.into()]);range.to=range.from.clone();store.erase(STATE,&range)?;Ok(())
    }
    pub(crate) fn committed_through(store:&dyn Storage,stream:&str,limits:Limits)->Result<i64> {
        if let Some(held)=pending(store,stream,limits)? {return Ok(held.base);}
        Ok(load(store,stream,limits)?.through.max(opaque_map::map_info(store,stream,limits)?.map_or(0,|map|map.through)))
    }
    pub(crate) fn align_opaque_base(store:&dyn Storage,stream:&str,base:i64,limits:Limits)->Result<()> {
        if !store.scoped() || !store.writing()? || committed_through(store,stream,limits)?<base {return Err(crate::cause!(Error::Conflict));}
        let state=opaque_state(store,stream,limits)?;
        if state.through>=base {return Ok(());}
        trim_opaque_through(store,stream,state.through,limits)?;
        let state=opaque_state(store,stream,limits)?;if state.bytes!=0 {return Err(crate::cause!(Error::Busy));}
        save(store,&key("opaque state",stream,"")?,&Stream {floor:base,through:base,bytes:0,last_digest:last_digest(store,stream,limits)?})
    }
    pub(crate) fn physical_commit(store:&dyn Storage,stream:&str,sequence:i64,limits:Limits)->Result<Option<CapturedCommit>> {frame(store,stream,sequence,limits)}
    pub(crate) fn opaque_commit(store:&dyn Storage,stream:&str,sequence:i64,limits:Limits)->Result<Option<OpaqueCommit>> {opaque_frame(store,stream,sequence,limits)}
    /// Only the original source's ordered physical absence proof permits this
    /// rollback. No plaintext/map effect was applied by a preparation.
    pub(crate) fn abort_prepared(store:&dyn Storage,stream:&str,expected:&Pending,limits:Limits)->Result<()> {
        if !store.scoped() || !store.writing()? || pending(store,stream,limits)?.as_ref()!=Some(expected) {return Err(crate::cause!(Error::Conflict));}
        let mut state=opaque_state(store,stream,limits)?;
        if state.through>expected.sequence || load(store,stream,limits)?.through>expected.base {return Err(crate::cause!(Error::Conflict));}
        if let Some(held)=opaque_frame(store,stream,expected.sequence,limits)? {
            if held.digest!=expected.digest {return Err(crate::cause!(Error::Conflict));}
            let size=opaque_bytes(&held,limits)?.len() as u64;let slot=key("opaque frames",stream,"")?;
            let mut range=Range::all();range.from=Bound::Included(vec![slot.into(),expected.sequence.into()]);range.to=range.from.clone();store.erase(LOG,&range)?;
            state.bytes=state.bytes.checked_sub(size).ok_or(crate::cause!(Error::Invalid))?;
        }
        state.through=expected.base;state.floor=state.floor.min(expected.base);
        save(store,&key("opaque state",stream,"")?,&state)?;
        if expected.base==0 {opaque_map::discard_empty_preparation(store,stream,limits)?;}
        clear_pending(store,stream,expected.sequence,&expected.digest,limits)
    }
    pub struct Page {
        pub commits: Vec<CapturedCommit>,
        pub through: i64,
        pub retained_from: i64,
        pub further: bool,
    }
    /// Original command identity and every physical key/index/value stay in
    /// authenticated ciphertext. The crypto owner binds stream, sequence and
    /// digest; this owner never treats opaque retention as materialized data.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct OpaqueCommit { pub sequence: i64, pub digest: String, #[serde(with = "opaque_payload")] pub payload: Vec<u8> }
    pub struct OpaquePage { pub commits: Vec<OpaqueCommit>, pub through: i64, pub retained_from: i64, pub further: bool }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Frontiers { pub stored: i64, pub materialized: i64, pub retained_from: i64 }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct StreamBinding { kind: String, pub stream: String, pub binding: Vec<u8> }
    pub struct BindingPage { pub bindings: Vec<StreamBinding>, pub next: Option<String> }
    fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> { serde_json::to_vec(value).map_err(|error| crate::carry_cause!(Error::Invalid, error)) }
    fn decoded<T: for<'a> Deserialize<'a>>(bytes: &[u8]) -> Result<T> { serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error)) }
    mod opaque_payload {
        use base64::Engine;
        use serde::{Deserialize, Deserializer, Serializer};
        pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> std::result::Result<S::Ok, S::Error> {
            serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<u8>, D::Error> {
            let text = String::deserialize(deserializer)?;
            base64::engine::general_purpose::STANDARD.decode(text).map_err(serde::de::Error::custom)
        }
    }
    fn key(kind: &str, stream: &str, identity: &str) -> Result<String> {
        let bytes = encoded(&("complete-command-stream/v1", kind, stream, identity))?;
        Ok(content_crypto::advanced::blake3::hash(&bytes).to_hex().to_string())
    }
    fn get<T: for<'a> Deserialize<'a>>(store: &dyn Storage, slot: &str, bound: usize) -> Result<Option<T>> {
        match store.get(STATE, &[slot.into()], &[Read::at_most("body", bound)])? {
            None => Ok(None),
            Some(row) => match &row.0[0] { Value::Blob(bytes) => decoded(bytes).map(Some), _ => Err(crate::cause!(Error::TooBig)) },
        }
    }
    fn save<T: Serialize>(store: &dyn Storage, slot: &str, value: &T) -> Result<()> {
        store.put(STATE, &[("slot", slot.into()), ("body", Value::Blob(encoded(value)?))], When::Always)?;
        Ok(())
    }
    fn valid(stream: &str, limits: Limits) -> Result<()> {
        if stream.is_empty() || stream.len() > limits.commit_bytes || limits.page_rows == 0 || limits.page_bytes == 0
            || limits.commit_bytes == 0 || limits.capture_bytes < limits.commit_bytes { return Err(crate::cause!(Error::Invalid)); }
        Ok(())
    }
    fn load(store: &dyn Storage, stream: &str, limits: Limits) -> Result<Stream> {
        valid(stream, limits)?;
        let state = get::<Stream>(store, &key("state", stream, "")?, limits.commit_bytes)?.unwrap_or_default();
        if state.floor < 0 || state.through < state.floor || state.bytes > limits.capture_bytes as u64 { return Err(crate::cause!(Error::Invalid)); }
        Ok(state)
    }
    fn frame(store: &dyn Storage, stream: &str, sequence: i64, limits: Limits) -> Result<Option<CapturedCommit>> {
        let slot = key("frames", stream, "")?;
        match store.get(LOG, &[slot.into(), sequence.into()], &[Read::at_most("body", limits.commit_bytes)])? {
            None => Ok(None),
            Some(row) => match &row.0[0] { Value::Blob(bytes) => decoded(bytes).map(Some), _ => Err(crate::cause!(Error::TooBig)) },
        }
    }
    fn opaque_state(store: &dyn Storage, stream: &str, limits: Limits) -> Result<Stream> {
        valid(stream, limits)?;
        let state = get::<Stream>(store, &key("opaque state", stream, "")?, limits.commit_bytes)?.unwrap_or_default();
        if state.floor < 0 || state.through < state.floor || state.bytes > limits.capture_bytes as u64 { return Err(crate::cause!(Error::Invalid)); }
        Ok(state)
    }
    fn opaque_frame(store: &dyn Storage, stream: &str, sequence: i64, limits: Limits) -> Result<Option<OpaqueCommit>> {
        match store.get(LOG, &[key("opaque frames", stream, "")?.into(), sequence.into()], &[Read::at_most("body", limits.capture_bytes)])? {
            None => Ok(None),
            Some(row) => match &row.0[0] { Value::Blob(bytes) => decoded(bytes).map(Some), _ => Err(crate::cause!(Error::TooBig)) },
        }
    }
    fn opaque_bytes(commit: &OpaqueCommit, limits: Limits) -> Result<Vec<u8>> {
        // BLAKE3 is exactly 32 bytes/64 lowercase hex, a format boundary.
        if commit.sequence <= 0 || commit.digest.len() != 64 || !commit.digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || commit.payload.is_empty() { return Err(crate::cause!(Error::Invalid)); }
        let bytes = encoded(commit)?;
        // Encrypted framing includes authenticated-envelope and base64 bytes.
        // The plaintext frame limit is not an encrypted retention byte limit.
        if bytes.len() > limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
        Ok(bytes)
    }
    fn digest(commit: &CapturedCommit, limits: Limits) -> Result<(Vec<u8>, String)> {
        if commit.sequence <= 0 || commit.identity.is_empty() || commit.effects.is_empty() { return Err(crate::cause!(Error::Invalid)); }
        let bytes = encoded(commit)?;
        if bytes.len() > limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        let digest = content_crypto::advanced::blake3::hash(&bytes).to_hex().to_string();
        Ok((bytes, digest))
    }
    /// Canonical complete-frame digest, shared by sender codec, receiver and
    /// retained opaque materialization. No transport copies this derivation.
    pub fn digest_of(commit: &CapturedCommit, limits: Limits) -> Result<String> { digest(commit, limits).map(|(_, hash)| hash) }

    /// Immutable routing facts supplied by the authenticated native owner.
    /// This contains full history addressing only, never a user's record value,
    /// key, native input digest or grant. Ordinary routing still carries scope.
    pub fn bind_stream(store: &dyn Storage, stream: &str, binding: &[u8], limits: Limits) -> Result<()> {
        valid(stream, limits)?;
        if binding.is_empty() || binding.len() > limits.commit_bytes { return Err(crate::cause!(Error::Invalid)); }
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let slot = key("binding", stream, "")?;
        let wanted = StreamBinding { kind: "stream-binding/v1".into(), stream: stream.into(), binding: binding.to_vec() };
        if encoded(&wanted)?.len() > limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        match get::<StreamBinding>(store, &slot, limits.commit_bytes)? {
            Some(held) if held != wanted => return Err(crate::cause!(Error::Conflict)),
            Some(_) => {},
            None => save(store, &slot, &wanted)?,
        }
        scope.commit()
    }
    pub fn stream_binding(store: &dyn Storage, stream: &str, limits: Limits) -> Result<Option<Vec<u8>>> {
        valid(stream, limits)?;
        let held = get::<StreamBinding>(store, &key("binding", stream, "")?, limits.commit_bytes)?;
        held.map(|held| {
            if held.kind != "stream-binding/v1" || held.stream != stream { return Err(crate::cause!(Error::Invalid)); }
            Ok(held.binding)
        }).transpose()
    }
    /// Bounded startup discovery. The cursor is the physical metadata key,
    /// not the last matching row, so sparse bindings still make finite progress.
    /// Unreadable/unknown metadata never counts as an absence of bindings.
    pub fn bindings_after(store: &dyn Storage, after: Option<&str>, limits: Limits) -> Result<BindingPage> {
        valid("startup", limits)?;
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Read })?;
        let mut range = Range::all().limit(limits.page_rows);
        if let Some(after) = after { range.from = Bound::Excluded(vec![after.into()]); }
        let rows = store.scan(STATE, &range, &[Read::at_most("slot", limits.commit_bytes), Read::at_most("body", limits.commit_bytes)])?;
        let mut bindings = Vec::new(); let mut last = None;
        let more = rows.len() == limits.page_rows;
        for row in rows {
            let (Value::Text(slot), Value::Blob(body)) = (&row.0[0], &row.0[1]) else { return Err(crate::cause!(Error::TooBig)); };
            last = Some(slot.clone());
            if let Ok(binding) = decoded::<StreamBinding>(body) {
                if binding.kind != "stream-binding/v1" || key("binding", &binding.stream, "")? != *slot { return Err(crate::cause!(Error::Invalid)); }
                bindings.push(binding);
            } else if decoded::<Stream>(body).is_err() && decoded::<Receipt>(body).is_err() { return Err(crate::cause!(Error::Invalid)); }
        }
        scope.commit()?;
        Ok(BindingPage { bindings, next: if more { last } else { None } })
    }
    fn keep(store: &dyn Storage, stream: &str, state: &mut Stream, commit: &CapturedCommit, limits: Limits) -> Result<()> {
        let (bytes, hash) = digest(commit, limits)?;
        state.bytes = state.bytes.checked_add(bytes.len() as u64).ok_or(crate::cause!(Error::TooBig))?;
        if state.bytes > limits.capture_bytes as u64 { return Err(crate::cause!(Error::TooBig)); }
        state.through = commit.sequence;
        state.last_digest=Some(hash.clone());
        store.put(LOG, &[("slot", key("frames", stream, "")?.into()), ("sequence", commit.sequence.into()),
            ("body", Value::Blob(bytes))], When::New)?;
        save(store, &key("identity", stream, &commit.identity)?, &Receipt { sequence: commit.sequence, digest: hash })?;
        save(store, &key("state", stream, "")?, state)
    }

    /// The head digest belongs to the same snapshot as its complete command
    /// position. Retained metadata keeps it available after tail compaction.
    pub(crate) fn last_digest(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<String>> {
        let state=load(store,stream,limits)?;
        if state.through==0 {return Ok(None);}
        let digest=match state.last_digest {Some(digest)=>digest,None=>digest_of(&frame(store,stream,state.through,limits)?.ok_or(crate::cause!(Error::Moved))?,limits)?};
        if digest.len()!=64 || !digest.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte)) {return Err(crate::cause!(Error::Invalid));}
        Ok(Some(digest))
    }

    pub(crate) use opaque_map::MaterializedBaselineCursor;

    /// Append after the ORIGINAL native receipt is complete, inside its held
    /// write transaction. Original command admission owns request lifetime;
    /// this index gives exact retry identity while the frame is retained.
    pub fn append_commit(store: &dyn Storage, stream: &str, command_identity: &str,
        effects: &[Effect], limits: Limits) -> Result<CapturedCommit> {
        if !store.scoped() || !store.writing()? { return Err(crate::cause!(Error::Invalid)); }
        let scope = Scope::begin(store, Intent::Nested)?;
        let mut state = load(store, stream, limits)?;
        if opaque_state(store, stream, limits)?.through > state.through { return Err(crate::cause!(Error::Moved)); }
        if let Some(held) = get::<Receipt>(store, &key("identity", stream, command_identity)?, limits.commit_bytes)? {
            let commit = CapturedCommit { sequence: held.sequence, identity: command_identity.into(), effects: effects.to_vec() };
            if digest(&commit, limits)?.1 != held.digest { return Err(crate::cause!(Error::Conflict)); }
            scope.commit()?;
            return Ok(commit);
        }
        let commit = CapturedCommit { sequence: state.through.checked_add(1).ok_or(crate::cause!(Error::TooBig))?,
            identity: command_identity.into(), effects: effects.to_vec() };
        keep(store, stream, &mut state, &commit, limits)?;
        scope.commit()?;
        Ok(commit)
    }

    /// One bounded page of WHOLE source commands. A floor miss refuses and
    /// requires qualified complete-domain bootstrap; pages never split a command.
    pub fn commits_after(store: &dyn Storage, stream: &str, after: i64, limits: Limits) -> Result<Page> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Read })?;
        let state = load(store, stream, limits)?;
        if opaque_state(store, stream, limits)?.through > state.through { return Err(crate::cause!(Error::Moved)); }
        if after < state.floor { return Err(crate::cause!(Error::Moved)); }
        if after > state.through { return Err(crate::cause!(Error::Conflict)); }
        let mut commits = Vec::new();
        let mut bytes = 0usize;
        let mut at = after;
        while at < state.through && commits.len() < limits.page_rows {
            let next = at.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
            let commit = frame(store, stream, next, limits)?.ok_or(crate::cause!(Error::Moved))?;
            let size = digest(&commit, limits)?.0.len();
            if commit.sequence != next { return Err(crate::cause!(Error::Invalid)); }
            if !commits.is_empty() && bytes.saturating_add(size) > limits.page_bytes { break; }
            bytes = bytes.checked_add(size).ok_or(crate::cause!(Error::TooBig))?;
            commits.push(commit);
            at = next;
        }
        scope.commit()?;
        Ok(Page { commits, through: state.through, retained_from: state.floor.checked_add(1).ok_or(crate::cause!(Error::TooBig))?, further: at < state.through })
    }

    /// One complete frame, row changes and receiving frontier published
    /// atomically. Same retained sequence/digest is a no-op; gaps and a changed
    /// original identity refuse without touching a row.
    pub fn apply_commit(store: &dyn Storage, stream: &str, commit: &CapturedCommit, limits: Limits) -> Result<i64> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let mut state = load(store, stream, limits)?;
        let (_, hash) = digest(commit, limits)?;
        if opaque_frame(store, stream, commit.sequence, limits)?.is_some_and(|held| held.digest != hash) { return Err(crate::cause!(Error::Conflict)); }
        if let Some(held) = get::<Receipt>(store, &key("identity", stream, &commit.identity)?, limits.commit_bytes)? {
            if held.sequence != commit.sequence || held.digest != hash { return Err(crate::cause!(Error::Conflict)); }
            scope.commit()?;
            return Ok(state.through);
        }
        if commit.sequence <= state.floor { return Err(crate::cause!(Error::Moved)); }
        if commit.sequence != state.through.checked_add(1).ok_or(crate::cause!(Error::TooBig))? { return Err(crate::cause!(Error::Conflict)); }
        live_adopt::apply_complete(store, &commit.effects)?;
        keep(store, stream, &mut state, commit, limits)?;
        scope.commit()?;
        Ok(state.through)
    }

    /// Persist one encrypted complete frame on a copy-only receiver. Its
    /// current authenticated sender/term and ciphertext/AAD checks are the
    /// calling crypto/authority owner's job. This grants no root or read right.
    pub fn retain_opaque(store: &dyn Storage, stream: &str, commit: &OpaqueCommit, limits: Limits) -> Result<Frontiers> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let mut state = opaque_state(store, stream, limits)?;
        let bytes = opaque_bytes(commit, limits)?;
        if commit.sequence <= state.floor { return Err(crate::cause!(Error::Moved)); }
        if let Some(held) = opaque_frame(store, stream, commit.sequence, limits)? {
            if held.digest != commit.digest { return Err(crate::cause!(Error::Conflict)); }
            // A retry can carry a fresh authenticated seal of the same frame.
            // Keep the exact just-delivered bytes, repairing a damaged old
            // envelope rather than acknowledging a digest while retaining it.
            state.bytes = state.bytes.checked_sub(opaque_bytes(&held, limits)?.len() as u64)
                .and_then(|total| total.checked_add(bytes.len() as u64)).ok_or(crate::cause!(Error::TooBig))?;
            if state.bytes > limits.capture_bytes as u64 { return Err(crate::cause!(Error::TooBig)); }
            store.put(LOG, &[("slot", key("opaque frames", stream, "")?.into()), ("sequence", commit.sequence.into()),
                ("body", Value::Blob(bytes))], When::Always)?;
            save(store, &key("opaque state", stream, "")?, &state)?;
            scope.commit()?;
            return frontiers(store, stream, limits);
        }
        if commit.sequence != state.through.checked_add(1).ok_or(crate::cause!(Error::TooBig))? { return Err(crate::cause!(Error::Conflict)); }
        state.bytes = state.bytes.checked_add(bytes.len() as u64).ok_or(crate::cause!(Error::TooBig))?;
        if state.bytes > limits.capture_bytes as u64 { return Err(crate::cause!(Error::TooBig)); }
        state.through = commit.sequence;
        store.put(LOG, &[("slot", key("opaque frames", stream, "")?.into()), ("sequence", commit.sequence.into()),
            ("body", Value::Blob(bytes))], When::New)?;
        save(store, &key("opaque state", stream, "")?, &state)?;
        scope.commit()?;
        frontiers(store, stream, limits)
    }

    pub fn frontiers(store: &dyn Storage, stream: &str, limits: Limits) -> Result<Frontiers> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Read })?;
        let plain = load(store, stream, limits)?;
        let opaque = opaque_state(store, stream, limits)?;
        let map = opaque_map::map_info(store, stream, limits)?;
        // -1 is no qualifying plaintext generation. It keeps even a complete
        // encrypted snapshot at cut zero distinct from an empty ready store.
        let materialized = match &map { Some(map) if !map.materialized => -1, _ => pending(store,stream,limits)?.map_or(plain.through,|pending|plain.through.min(pending.base)) };
        scope.commit()?;
        Ok(Frontiers { stored: plain.through.max(opaque.through).max(map.as_ref().map_or(0, |map| map.through)), materialized,
            retained_from: if opaque.through > plain.through { opaque.floor } else { plain.floor }.checked_add(1).ok_or(crate::cause!(Error::TooBig))? })
    }

    /// New root authority decrypts and authenticates outside this owner, then
    /// this check binds the exact plaintext to its retained encrypted digest.
    /// Every ordinary reader must wait until materialized == stored.
    pub fn materialize_opaque(store: &dyn Storage, stream: &str, commit: &CapturedCommit, limits: Limits) -> Result<Frontiers> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let held = opaque_frame(store, stream, commit.sequence, limits)?.ok_or(crate::cause!(Error::Moved))?;
        if held.digest != digest(commit, limits)?.1 { return Err(crate::cause!(Error::Conflict)); }
        apply_commit(store, stream, commit, limits)?;
        scope.commit()?;
        frontiers(store, stream, limits)
    }

    pub fn opaque_after(store: &dyn Storage, stream: &str, after: i64, limits: Limits) -> Result<OpaquePage> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Read })?;
        let state = opaque_state(store, stream, limits)?;
        if after < state.floor { return Err(crate::cause!(Error::Moved)); }
        if after > state.through { return Err(crate::cause!(Error::Conflict)); }
        let mut commits = Vec::new(); let mut bytes = 0usize; let mut at = after;
        while at < state.through && commits.len() < limits.page_rows {
            let next = at.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
            let commit = opaque_frame(store, stream, next, limits)?.ok_or(crate::cause!(Error::Moved))?;
            let size = opaque_bytes(&commit, limits)?.len();
            if commit.sequence != next { return Err(crate::cause!(Error::Invalid)); }
            if !commits.is_empty() && bytes.saturating_add(size) > limits.page_bytes { break; }
            bytes = bytes.checked_add(size).ok_or(crate::cause!(Error::TooBig))?; commits.push(commit); at = next;
        }
        scope.commit()?;
        Ok(OpaquePage { commits, through: state.through, retained_from: state.floor.checked_add(1).ok_or(crate::cause!(Error::TooBig))?, further: at < state.through })
    }

    /// Unmaterialized encrypted frames cannot be thrown away. A permanently
    /// copy-only voter needs qualified encrypted-state compaction/bootstrap;
    /// until then its explicit retained-byte bound backpressures new work.
    pub fn trim_opaque_through(store: &dyn Storage, stream: &str, safe_through: i64, limits: Limits) -> Result<i64> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let mut state = opaque_state(store, stream, limits)?;
        let compacted = opaque_map::map_info(store, stream, limits)?.map_or(0, |map| map.through);
        if safe_through < state.floor || safe_through > state.through || safe_through > load(store, stream, limits)?.through.max(compacted) { return Err(crate::cause!(Error::Conflict)); }
        let slot = key("opaque frames", stream, "")?;
        for _ in 0..limits.page_rows {
            if state.floor == safe_through { break; }
            let sequence = state.floor.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
            let commit = opaque_frame(store, stream, sequence, limits)?.ok_or(crate::cause!(Error::Moved))?;
            let size = opaque_bytes(&commit, limits)?.len() as u64;
            let mut exact = Range::all(); exact.from = Bound::Included(vec![slot.as_str().into(), sequence.into()]); exact.to = exact.from.clone();
            store.erase(LOG, &exact)?;
            state.bytes = state.bytes.checked_sub(size).ok_or(crate::cause!(Error::Invalid))?; state.floor = sequence;
        }
        save(store, &key("opaque state", stream, "")?, &state)?;
        scope.commit()?;
        Ok(state.floor)
    }

    /// Delete one bounded turn through the authority owner's PROVED safe
    /// frontier: every current consumer holds it, or a complete current-domain
    /// snapshot remains available to consumers before the retained floor.
    /// Such older cursors refuse and must finish authenticated bootstrap.
    /// This API makes no policy choice about who may acknowledge a frame.
    pub fn trim_through(store: &dyn Storage, stream: &str, safe_through: i64, limits: Limits) -> Result<i64> {
        let scope = Scope::begin(store, if store.scoped() { Intent::Nested } else { Intent::Write })?;
        let mut state = load(store, stream, limits)?;
        if safe_through < state.floor || safe_through > state.through { return Err(crate::cause!(Error::Conflict)); }
        let slot = key("frames", stream, "")?;
        for _ in 0..limits.page_rows {
            if state.floor == safe_through { break; }
            let sequence = state.floor.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
            let commit = frame(store, stream, sequence, limits)?.ok_or(crate::cause!(Error::Moved))?;
            let size = digest(&commit, limits)?.0.len() as u64;
            let mut exact = Range::all(); exact.from = Bound::Included(vec![slot.as_str().into(), sequence.into()]); exact.to = exact.from.clone();
            store.erase(LOG, &exact)?;
            let mut receipt = Range::all(); receipt.from = Bound::Included(vec![key("identity", stream, &commit.identity)?.into()]); receipt.to = receipt.from.clone();
            store.erase(STATE, &receipt)?;
            state.bytes = state.bytes.checked_sub(size).ok_or(crate::cause!(Error::Invalid))?;
            state.floor = sequence;
        }
        save(store, &key("state", stream, "")?, &state)?;
        scope.commit()?;
        Ok(state.floor)
    }


    /// Incremental encrypted current state, separate from the bounded commit
    /// tail. Ports placed-lists.mjs:10-41's complete selected-home copy. The
    /// crypto owner derives stable keyed tokens and authenticates row envelopes;
    /// this owner never sees or derives a physical key from an opaque token.
    /// A pinned source snapshot supplies one cut. A receiver builds a distinct
    /// generation, proves every page and the final seal, then publishes metadata
    /// once. No receiver can mistake that ciphertext for materialized records.
    pub mod opaque_map {
        use super::*;
        use super::live_adopt::{Cell, Effect};
        const META: &str = "command_map_state";
        const ROWS: &str = "command_map_rows";

        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct WrappedKey {pub identity:String,pub envelope:serde_json::Value}
        pub(crate) fn wrapped_key(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<WrappedKey>> {
            valid(stream,limits)?;metadata(store,&key("opaque token key",stream,"")?,limits)
        }
        pub(crate) fn bind_wrapped_key(store:&dyn Storage,stream:&str,wrapped:&WrappedKey,limits:Limits)->Result<()> {
            valid(stream,limits)?;
            if !hash_text(&wrapped.identity) || !wrapped.envelope.is_object() || encoded(wrapped)?.len()>limits.capture_bytes {return Err(crate::cause!(Error::Invalid));}
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            if wrapped_key(store,stream,limits)?.is_some_and(|old|old.identity!=wrapped.identity)
                || map_info(store,stream,limits)?.is_some_and(|active|active.token_key_identity!=wrapped.identity) {return Err(crate::cause!(Error::Conflict));}
            save_meta(store,&key("opaque token key",stream,"")?,wrapped,limits)?;scope.commit()
        }

        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct MapHead {
            pub snapshot: String,
            pub through: i64,
            pub token_key_identity: String,
            pub last_digest: Option<String>,
        }
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct OpaqueRow {
            pub token: String,
            /// The original row seal's AAD position, not the snapshot cut.
            pub sequence: i64,
            #[serde(with = "super::opaque_payload")]
            pub payload: Vec<u8>,
        }
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct OpaqueUpdate {
            pub token: String,
            #[serde(with = "optional_payload")]
            pub payload: Option<Vec<u8>>,
        }
        mod optional_payload {
            use base64::Engine;
            use serde::{Deserialize, Deserializer, Serializer};
            pub fn serialize<S: Serializer>(payload: &Option<Vec<u8>>, serializer: S) -> std::result::Result<S::Ok, S::Error> {
                match payload { Some(bytes) => serializer.serialize_some(&base64::engine::general_purpose::STANDARD.encode(bytes)), None => serializer.serialize_none() }
            }
            pub fn deserialize<'de,D: Deserializer<'de>>(deserializer:D) -> std::result::Result<Option<Vec<u8>>,D::Error> {
                Option::<String>::deserialize(deserializer)?.map(|text| base64::engine::general_purpose::STANDARD.decode(text).map_err(serde::de::Error::custom)).transpose()
            }
        }
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct MapDelta { pub sequence:i64, pub digest:String, pub updates:Vec<OpaqueUpdate> }
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct MapPage {
            pub head:MapHead,
            pub ordinal:u64,
            pub previous:String,
            pub rows:Vec<OpaqueRow>,
            pub done:bool,
            pub digest:String,
        }
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct MapSeal {
            pub head:MapHead,
            pub pages:u64,
            pub rows:u64,
            pub bytes:u64,
            pub digest:String,
        }
        #[derive(Clone, Debug, PartialEq, Eq)]
        pub struct MapInfo {
            pub through:i64,
            pub token_key_identity:String,
            pub rows:u64,
            pub bytes:u64,
            pub materialized:bool,
        }
        #[derive(Clone, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Generation {
            id:String, token_key_identity:String, through:i64, rows:u64, bytes:u64,
            last_delta:Option<(i64,String,Vec<(String,bool)>)>, seed:MapSeal, last_page:(u64,String),
            materialized:Option<i64>,
        }
        #[derive(Default, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Meta { active:Option<Generation>, retired:Option<String> }
        #[derive(Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Building {
            head:MapHead, generation:String, ordinal:u64, digest:String,
            rows:u64, bytes:u64, done:bool, last_page:Option<(u64,String)>,
        }

        fn text(value:&str, limits:Limits)->bool {
            !value.is_empty() && value.len() <= limits.commit_bytes && !value.chars().any(char::is_control)
        }
        fn hash_text(value:&str)->bool { value.len()==64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
        fn head_valid(head:&MapHead,limits:Limits)->Result<()> {
            if !text(&head.snapshot,limits) || !text(&head.token_key_identity,limits) || head.through<0
                || (head.through==0 && head.last_digest.is_some()) || (head.through>0 && head.last_digest.as_deref().is_none_or(|digest|!hash_text(digest))) { return Err(crate::cause!(Error::Invalid)); }
            Ok(())
        }
        fn row_size(row:&OpaqueRow,through:i64,limits:Limits)->Result<usize> {
            if !hash_text(&row.token) || row.sequence<0 || row.sequence>through || row.payload.is_empty() { return Err(crate::cause!(Error::Invalid)); }
            let size=encoded(row)?.len();
            if size>limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
            Ok(size)
        }
        fn map_slot(stream:&str)->Result<String> { key("opaque map",stream,"") }
        fn building_slot(stream:&str)->Result<String> { key("opaque map building",stream,"") }
        fn generation(stream:&str,snapshot:&str)->Result<String> { key("opaque map generation",stream,snapshot) }
        fn metadata<T:for<'de>Deserialize<'de>>(store:&dyn Storage,slot:&str,limits:Limits)->Result<Option<T>> {
            match store.get(META,&[slot.into()],&[Read::at_most("body",limits.capture_bytes)])? {
                None=>Ok(None),
                Some(row)=>match &row.0[0] { Value::Blob(bytes)=>decoded(bytes).map(Some),_=>Err(crate::cause!(Error::TooBig)) },
            }
        }
        fn save_meta<T:Serialize>(store:&dyn Storage,slot:&str,value:&T,limits:Limits)->Result<()> {
            let body=encoded(value)?;
            if body.len()>limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
            store.put(META,&[("slot",slot.into()),("body",Value::Blob(body))],When::Always)?;
            Ok(())
        }
        fn remove_exact(store:&dyn Storage,family:&str,key:Vec<Value>)->Result<()> {
            let mut range=Range::all();range.from=Bound::Included(key);range.to=range.from.clone();store.erase(family,&range)?;Ok(())
        }
        fn meta(store:&dyn Storage,stream:&str,limits:Limits)->Result<Meta> {
            valid(stream,limits)?;
            let value=metadata::<Meta>(store,&map_slot(stream)?,limits)?.unwrap_or_default();
            if let Some(active)=&value.active {
                if !hash_text(&active.id) || active.through<0 || !text(&active.token_key_identity,limits)
                    || active.materialized.is_some_and(|through|through<0 || through>active.through) { return Err(crate::cause!(Error::Invalid)); }
            }
            Ok(value)
        }
        fn row(store:&dyn Storage,slot:&str,token:&str,limits:Limits)->Result<Option<OpaqueRow>> {
            match store.get(ROWS,&[slot.into(),token.into()],&[Read::whole("sequence"),Read::at_most("body",limits.capture_bytes)])? {
                None=>Ok(None),Some(row)=>match (&row.0[0],&row.0[1]) {
                    (Value::Integer(sequence),Value::Blob(payload))=>Ok(Some(OpaqueRow { token:token.into(),sequence:*sequence,payload:payload.clone() })),_=>Err(crate::cause!(Error::TooBig))
                }
            }
        }
        fn put_row(store:&dyn Storage,slot:&str,row:&OpaqueRow)->Result<()> {
            store.put(ROWS,&[("slot",slot.into()),("token",row.token.as_str().into()),("sequence",row.sequence.into()),("body",Value::Blob(row.payload.clone()))],When::Always)?;Ok(())
        }
        fn row_range(slot:&str,after:Option<&str>,limit:usize)->Range<'static> {
            let mut range=Range::all().limit(limit);
            range.from=Bound::Included(vec![slot.into()]);range.to=range.from.clone();
            if let Some(after)=after { range.from=Bound::Excluded(vec![slot.into(),after.into()]); }
            range
        }
        fn map_rows(store:&dyn Storage,slot:&str,after:Option<&str>,through:i64,limits:Limits)->Result<Vec<OpaqueRow>> {
            let mut result=Vec::new();let mut bytes=0usize;let mut after=after.map(str::to_owned);
            while result.len()<limits.page_rows {
                let Some(value)=store.scan(ROWS,&row_range(slot,after.as_deref(),1),&[Read::at_most("token",limits.commit_bytes),Read::whole("sequence"),Read::at_most("body",limits.capture_bytes)])?.into_iter().next() else { break; };
                let (Value::Text(token),Value::Integer(sequence),Value::Blob(payload))=(&value.0[0],&value.0[1],&value.0[2]) else { return Err(crate::cause!(Error::TooBig)); };
                let row=OpaqueRow { token:token.clone(),sequence:*sequence,payload:payload.clone() };let size=row_size(&row,through,limits)?;
                if !result.is_empty() && bytes.saturating_add(size)>limits.page_bytes { break; }
                bytes=bytes.checked_add(size).ok_or(crate::cause!(Error::TooBig))?;after=Some(token.clone());result.push(row);
            }
            Ok(result)
        }
        fn first_digest(head:&MapHead)->Result<String> { Ok(content_crypto::advanced::blake3::hash(&encoded(&("opaque-current-map/v1",head))?).to_hex().to_string()) }
        fn page_digest(page:&MapPage)->Result<String> {
            Ok(content_crypto::advanced::blake3::hash(&encoded(&("opaque-current-map-page/v1",&page.head,page.ordinal,&page.previous,&page.rows,page.done))?).to_hex().to_string())
        }
        fn active_digest(active:&Generation)->Option<String> {active.last_delta.as_ref().map(|(_,digest,_)|digest.clone()).or_else(||active.seed.head.last_digest.clone())}
        fn info(active:&Generation)->MapInfo { MapInfo { through:active.through,token_key_identity:active.token_key_identity.clone(),rows:active.rows,bytes:active.bytes,materialized:active.materialized==Some(active.through) } }
        pub fn map_info(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<MapInfo>> {
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Read})?;
            let result=meta(store,stream,limits)?.active.as_ref().map(info);scope.commit()?;Ok(result)
        }

        pub(crate) fn map_head(store:&dyn Storage,stream:&str,limits:Limits)->Result<Option<MapHead>> {
            Ok(meta(store,stream,limits)?.active.map(|active|MapHead {snapshot:active.seed.head.snapshot.clone(),through:active.through,last_digest:active_digest(&active),token_key_identity:active.token_key_identity}))
        }

        /// Open an empty shadow generation, never an empty replacement for
        /// missing current state. Only a proved complete source snapshot seals
        /// this generation. Old active bytes remain selected until Finish.
        pub fn begin_map_bootstrap(store:&dyn Storage,stream:&str,head:&MapHead,limits:Limits)->Result<()> {
            valid(stream,limits)?;head_valid(head,limits)?;
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            let meta=meta(store,stream,limits)?;
            if meta.retired.is_some() { return Err(crate::cause!(Error::Busy)); }
            if let Some(active)=&meta.active {
                if active.seed.head==*head { scope.commit()?;return Ok(()); }
            }
            let slot=building_slot(stream)?;
            if let Some(held)=metadata::<Building>(store,&slot,limits)? {
                if held.head!=*head { return Err(crate::cause!(Error::Conflict)); }
            } else {
                let generation=generation(stream,&head.snapshot)?;
                if meta.active.as_ref().is_some_and(|active|active.id==generation) { return Err(crate::cause!(Error::Conflict)); }
                if !map_rows(store,&generation,None,head.through,limits)?.is_empty() { return Err(crate::cause!(Error::Conflict)); }
                save_meta(store,&slot,&Building { head:head.clone(),generation,ordinal:0,digest:first_digest(head)?,rows:0,bytes:0,done:false,last_page:None },limits)?;
            }
            scope.commit()
        }

        /// Persist exact authenticated page bytes and cursor together. A lost
        /// reply retries the last page; a changed page, gap or repeated token
        /// refuses and rolls back the whole page, including a late row fault.
        pub fn append_map_page(store:&dyn Storage,stream:&str,page:&MapPage,limits:Limits)->Result<()> {
            head_valid(&page.head,limits)?;
            if page.rows.len()>limits.page_rows || !hash_text(&page.digest) || page_digest(page)?!=page.digest
                || encoded(page)?.len()>limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            let slot=building_slot(stream)?;
            let Some(mut held)=metadata::<Building>(store,&slot,limits)? else {
                let active=meta(store,stream,limits)?.active.ok_or(crate::cause!(Error::Moved))?;
                if active.seed.head!=page.head || active.last_page!=(page.ordinal,page.digest.clone()) { return Err(crate::cause!(Error::Moved)); }
                scope.commit()?;return Ok(());
            };
            if held.head==page.head && held.last_page.as_ref()==Some(&(page.ordinal,page.digest.clone())) { scope.commit()?;return Ok(()); }
            if held.done || held.head!=page.head || held.ordinal!=page.ordinal || held.digest!=page.previous { return Err(crate::cause!(Error::Conflict)); }
            for entry in &page.rows {
                let size=row_size(entry,page.head.through,limits)?;
                if row(store,&held.generation,&entry.token,limits)?.is_some() { return Err(crate::cause!(Error::Conflict)); }
                put_row(store,&held.generation,entry)?;
                held.rows=held.rows.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
                held.bytes=held.bytes.checked_add(size as u64).ok_or(crate::cause!(Error::TooBig))?;
            }
            if page.rows.is_empty() && !page.done { return Err(crate::cause!(Error::Invalid)); }
            held.ordinal=held.ordinal.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;held.digest=page.digest.clone();held.done=page.done;held.last_page=Some((page.ordinal,page.digest.clone()));
            save_meta(store,&slot,&held,limits)?;scope.commit()
        }

        /// Proof is constructed only after every page and the final seal agree.
        /// It grants no root, caller right or permission to serve plaintext.
        pub struct MapProof { stream:String, generation:String, seal:MapSeal }
        impl MapProof { pub fn seal(&self)->&MapSeal { &self.seal } pub fn stream(&self)->&str { &self.stream } pub fn generation(&self)->&str { &self.generation } }
        pub fn finish_map_bootstrap(store:&dyn Storage,stream:&str,seal:&MapSeal,limits:Limits)->Result<MapProof> {
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            let mut meta=meta(store,stream,limits)?;
            if let Some(active)=&meta.active {
                if active.seed==*seal {
                    let proof=MapProof { stream:stream.into(),generation:active.id.clone(),seal:seal.clone() };scope.commit()?;return Ok(proof);
                }
            }
            if meta.retired.is_some() { return Err(crate::cause!(Error::Busy)); }
            let slot=building_slot(stream)?;let held=metadata::<Building>(store,&slot,limits)?.ok_or(crate::cause!(Error::Moved))?;
            if !held.done || held.head!=seal.head || held.ordinal!=seal.pages || held.rows!=seal.rows || held.bytes!=seal.bytes || held.digest!=seal.digest { return Err(crate::cause!(Error::Conflict)); }
            let generation=held.generation;
            meta.retired=meta.active.take().map(|active|active.id);
            meta.active=Some(Generation { id:generation.clone(),token_key_identity:held.head.token_key_identity,through:held.head.through,rows:held.rows,bytes:held.bytes,
                last_delta:None,seed:seal.clone(),last_page:held.last_page.ok_or(crate::cause!(Error::Invalid))?,materialized:None });
            save_meta(store,&map_slot(stream)?,&meta,limits)?;remove_exact(store,META,vec![slot.into()])?;scope.commit()?;
            Ok(MapProof { stream:stream.into(),generation,seal:seal.clone() })
        }

        fn install_empty_baseline(store:&dyn Storage,stream:&str,token_key_identity:&str,limits:Limits)->Result<()> {
            let head=MapHead { snapshot:key("empty opaque map baseline",stream,token_key_identity)?,through:0,last_digest:None,token_key_identity:token_key_identity.into() };
            begin_map_bootstrap(store,stream,&head,limits)?;
            let mut page=MapPage { head:head.clone(),ordinal:0,previous:first_digest(&head)?,rows:Vec::new(),done:true,digest:String::new() };
            page.digest=page_digest(&page)?;append_map_page(store,stream,&page,limits)?;
            let seal=MapSeal { head,pages:1,rows:0,bytes:0,digest:page.digest };
            finish_map_bootstrap(store,stream,&seal,limits)?;
            let mut value=meta(store,stream,limits)?;
            value.active.as_mut().ok_or(crate::cause!(Error::Moved))?.materialized=Some(0);
            save_meta(store,&map_slot(stream)?,&value,limits)
        }

        /// A copy-only receiver can prove its own genuinely empty physical
        /// domain without a decryption root. This is not inferred from a
        /// missing map, missing move record or a caller's create boolean.
        pub fn initialize_empty_opaque_map(store:&dyn Storage,stream:&str,token_key_identity:&str,limits:Limits)->Result<MapInfo> {
            if !store.scoped() || !store.writing()? || !text(token_key_identity,limits) { return Err(crate::cause!(Error::Invalid)); }
            let scope=Scope::begin(store,Intent::Nested)?;
            let current=meta(store,stream,limits)?;
            if let Some(active)=&current.active {
                if active.through==0 && active.rows==0 && active.token_key_identity==token_key_identity {
                    let result=info(active);scope.commit()?;return Ok(result);
                }
                return Err(crate::cause!(Error::Conflict));
            }
            if current.retired.is_some() || metadata::<Building>(store,&building_slot(stream)?,limits)?.is_some()
                || load(store,stream,limits)?.through!=0 || opaque_state(store,stream,limits)?.through!=0 { return Err(crate::cause!(Error::Moved)); }
            for family in &store.schema().families {
                if is_transport_family(&family.family) { continue; }
                let key=family.key.first().ok_or(crate::cause!(Error::Invalid))?;
                if !store.scan(&family.family,&Range::all().limit(1),&[Read::at_most(key,limits.commit_bytes)])?.is_empty() { return Err(crate::cause!(Error::Moved)); }
            }
            install_empty_baseline(store,stream,token_key_identity,limits)?;
            let result=meta(store,stream,limits)?.active.as_ref().map(info).ok_or(crate::cause!(Error::Moved))?;
            scope.commit()?;Ok(result)
        }

        /// A rolled-back first command can have lent a token key to empty
        /// receivers before that key existed in a committed source. Release
        /// only a proved empty preparation, so the exact retry may choose its
        /// new key. A real zero-cut snapshot, even one physical row, survives.
        pub(crate) fn discard_empty_preparation(store:&dyn Storage,stream:&str,limits:Limits)->Result<()> {
            if !store.scoped() || !store.writing()? || load(store,stream,limits)?.through!=0
                || opaque_state(store,stream,limits)?.through!=0 {return Err(crate::cause!(Error::Conflict));}
            let held=meta(store,stream,limits)?;let Some(active)=held.active.as_ref() else{return Ok(());};
            if active.through!=0 || active.rows!=0 || active.bytes!=0 || active.last_delta.is_some()
                || held.retired.is_some() || metadata::<Building>(store,&building_slot(stream)?,limits)?.is_some() {return Ok(());}
            if !map_rows(store,&active.id,None,0,Limits {page_rows:1,..limits})?.is_empty() {return Err(crate::cause!(Error::Invalid));}
            for family in &store.schema().families {
                if is_transport_family(&family.family) {continue;}
                let field=family.key.first().ok_or(crate::cause!(Error::Invalid))?;
                if !store.scan(&family.family,&Range::all().limit(1),&[Read::at_most(field,limits.commit_bytes)])?.is_empty() {return Ok(());}
            }
            remove_exact(store,META,vec![map_slot(stream)?.into()])?;
            remove_exact(store,META,vec![key("opaque token key",stream,"")?.into()])
        }

        /// The first already-effected source command can seed its map only
        /// when its exact captured postimages cover the ENTIRE current domain.
        /// Extra preexisting keys, missing indexes/receipts and changed actual
        /// rows refuse. Counting may perform physical work; it is not omitted
        /// from the invocation's normal supplier meter/budget.
        pub fn seed_first_opaque_map(store:&dyn Storage,stream:&str,token_key_identity:&str,commit:&CapturedCommit,delta:&MapDelta,limits:Limits)->Result<MapInfo> {
            if !store.scoped() || !store.writing()? || commit.sequence!=1 || delta.sequence!=1
                || digest(commit,limits)?.1!=delta.digest { return Err(crate::cause!(Error::Invalid)); }
            let scope=Scope::begin(store,Intent::Nested)?;
            if let Some(active)=meta(store,stream,limits)?.active {
                if active.token_key_identity!=token_key_identity { return Err(crate::cause!(Error::Conflict)); }
                let result=update_opaque_map(store,stream,token_key_identity,delta,limits)?;scope.commit()?;return Ok(result);
            }
            if load(store,stream,limits)?.through!=1 || opaque_state(store,stream,limits)?.through!=0
                || frame(store,stream,1,limits)?.as_ref()!=Some(commit)
                || metadata::<Building>(store,&building_slot(stream)?,limits)?.is_some() { return Err(crate::cause!(Error::Moved)); }
            let mut counts=std::collections::HashMap::<&str,u64>::new();
            let mut seen=std::collections::HashSet::<Vec<u8>>::new();let mut live=0usize;let mut deleted=0usize;
            for effect in &commit.effects {
                if is_transport_family(&effect.family) { continue; }
                if !seen.insert(encoded(&(&effect.family,&effect.key))?) { return Err(crate::cause!(Error::Invalid)); }
                let family=store.schema().family(&effect.family)?;
                let key=effect.key.iter().cloned().map(Value::from).collect::<Vec<_>>();
                let reads=family.fields.iter().map(|field|Read::at_most(field,limits.commit_bytes)).collect::<Vec<_>>();
                let actual=store.get(&effect.family,&key,&reads)?.map(|row|row.0.into_iter().map(Cell::try_from).collect::<Result<Vec<_>>>()).transpose()?;
                if actual!=effect.row { return Err(crate::cause!(Error::Conflict)); }
                if effect.row.is_some() { *counts.entry(&effect.family).or_default()+=1;live+=1; } else { deleted+=1; }
            }
            if delta.updates.iter().filter(|update|update.payload.is_some()).count()!=live
                || delta.updates.iter().filter(|update|update.payload.is_none()).count()!=deleted { return Err(crate::cause!(Error::Conflict)); }
            for family in &store.schema().families {
                if !is_transport_family(&family.family)
                    && store.count(&family.family,&Range::all())?!=counts.get(family.family.as_str()).copied().unwrap_or(0) { return Err(crate::cause!(Error::Moved)); }
            }
            install_empty_baseline(store,stream,token_key_identity,limits)?;
            let result=update_opaque_map(store,stream,token_key_identity,delta,limits)?;scope.commit()?;Ok(result)
        }

        /// One command updates only touched encrypted rows. The original
        /// receipt remains a row inside encrypted current state. Stable token
        /// key identity survives root rotations; missing/changed identity
        /// refuses rather than retaining an unreachable second copy of a row.
        pub fn update_opaque_map(store:&dyn Storage,stream:&str,token_key_identity:&str,delta:&MapDelta,limits:Limits)->Result<MapInfo> {
            if !store.scoped() || !store.writing()? || delta.sequence<=0 || !hash_text(&delta.digest) || delta.updates.is_empty()
                || encoded(delta)?.len()>limits.capture_bytes { return Err(crate::cause!(Error::Invalid)); }
            let scope=Scope::begin(store,Intent::Nested)?;
            let mut meta=meta(store,stream,limits)?;let active=meta.active.as_mut().ok_or(crate::cause!(Error::Moved))?;
            if active.token_key_identity!=token_key_identity { return Err(crate::cause!(Error::Conflict)); }
            let tokens=delta.updates.iter().map(|update|(update.token.clone(),update.payload.is_none())).collect::<Vec<_>>();
            let replay=active.last_delta.as_ref()==Some(&(delta.sequence,delta.digest.clone(),tokens.clone()));
            if !replay && delta.sequence!=active.through.checked_add(1).ok_or(crate::cause!(Error::TooBig))? { return Err(crate::cause!(Error::Conflict)); }
            let mut seen=std::collections::HashSet::new();
            for update in &delta.updates {
                if !hash_text(&update.token) || !seen.insert(&update.token) { return Err(crate::cause!(Error::Invalid)); }
                if let Some(old)=row(store,&active.id,&update.token,limits)? {
                    active.rows=active.rows.checked_sub(1).ok_or(crate::cause!(Error::Invalid))?;
                    active.bytes=active.bytes.checked_sub(row_size(&old,active.through,limits)? as u64).ok_or(crate::cause!(Error::Invalid))?;
                }
                match &update.payload {
                    Some(payload)=>{
                        let entry=OpaqueRow { token:update.token.clone(),sequence:delta.sequence,payload:payload.clone() };let size=row_size(&entry,delta.sequence,limits)?;
                        put_row(store,&active.id,&entry)?;active.rows=active.rows.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;active.bytes=active.bytes.checked_add(size as u64).ok_or(crate::cause!(Error::TooBig))?;
                    },
                    None=>remove_exact(store,ROWS,vec![active.id.as_str().into(),update.token.as_str().into()])?,
                }
            }
            if !replay && active.materialized==Some(active.through) && load(store,stream,limits)?.through==delta.sequence {
                let captured=frame(store,stream,delta.sequence,limits)?.ok_or(crate::cause!(Error::Moved))?;
                if digest(&captured,limits)?.1!=delta.digest { return Err(crate::cause!(Error::Conflict)); }
                active.materialized=Some(delta.sequence);
            }
            active.through=delta.sequence;active.last_delta=Some((delta.sequence,delta.digest.clone(),tokens));
            let result=info(active);save_meta(store,&map_slot(stream)?,&meta,limits)?;scope.commit()?;Ok(result)
        }

        /// A new source snapshot owns ONE read scope until its final page.
        /// Reopening after restart creates another snapshot id; persisted cursors
        /// never resume against freshly sampled rows or a different frontier.
        pub struct MapSnapshot<'a> { scope:Scope<'a>,cursor:MapCursor }
        impl<'a> MapSnapshot<'a> {
            pub fn begin(store:&'a dyn Storage,stream:&str,snapshot:&str,limits:Limits)->Result<Self> {
                let scope=Scope::current_read(store)?;let cursor=MapCursor::begin(&*scope,stream,snapshot,limits)?;Ok(Self {scope,cursor})
            }
            pub fn head(&self)->&MapHead {self.cursor.head()}
            pub fn page(&mut self)->Result<MapPage> {self.cursor.page(&*self.scope)}
            pub fn seal(&self)->Result<MapSeal> {self.cursor.seal(&*self.scope)}
        }

        pub(crate) struct MapCursor {
            owner:usize,head:MapHead,generation:String,after:Option<String>,ordinal:u64,digest:String,rows:u64,bytes:u64,expected_rows:u64,expected_bytes:u64,done:bool,limits:Limits,
        }
        impl MapCursor {
            fn same(&self,store:&dyn Storage)->Result<()> {
                if self.owner!=store as *const dyn Storage as *const () as usize || !store.scoped() || store.writing()? { return Err(crate::cause!(Error::Moved)); }
                store.custody()
            }
            pub(crate) fn begin(store:&dyn Storage,stream:&str,snapshot:&str,limits:Limits)->Result<Self> {
                if !store.scoped() || store.writing()? { return Err(crate::cause!(Error::Invalid)); }
                store.custody()?;
                let active=meta(store,stream,limits)?.active.ok_or(crate::cause!(Error::Moved))?;
                let head=MapHead { snapshot:snapshot.into(),through:active.through,last_digest:active_digest(&active),token_key_identity:active.token_key_identity };
                head_valid(&head,limits)?;let digest=first_digest(&head)?;
                Ok(Self { owner:store as *const dyn Storage as *const () as usize,head,generation:active.id,after:None,ordinal:0,digest,rows:0,bytes:0,expected_rows:active.rows,expected_bytes:active.bytes,done:false,limits })
            }
            pub fn head(&self)->&MapHead { &self.head }
            pub(crate) fn page(&mut self,store:&dyn Storage)->Result<MapPage> {
                if self.done { return Err(crate::cause!(Error::Moved)); }
                self.same(store)?;
                let rows=map_rows(store,&self.generation,self.after.as_deref(),self.head.through,self.limits)?;
                let after=rows.last().map(|row|row.token.clone()).or_else(||self.after.clone());
                let more=!map_rows(store,&self.generation,after.as_deref(),self.head.through,Limits{page_rows:1,..self.limits})?.is_empty();
                let mut page=MapPage { head:self.head.clone(),ordinal:self.ordinal,previous:self.digest.clone(),rows,done:!more,digest:String::new() };
                page.digest=page_digest(&page)?;
                if encoded(&page)?.len()>self.limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
                for row in &page.rows { self.rows=self.rows.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;self.bytes=self.bytes.checked_add(row_size(row,self.head.through,self.limits)? as u64).ok_or(crate::cause!(Error::TooBig))?; }
                self.after=after;self.ordinal=self.ordinal.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;self.digest=page.digest.clone();self.done=page.done;
                self.same(store)?;Ok(page)
            }
            pub(crate) fn seal(&self,store:&dyn Storage)->Result<MapSeal> {
                if !self.done || self.rows!=self.expected_rows || self.bytes!=self.expected_bytes { return Err(crate::cause!(Error::Moved)); }
                self.same(store)?;Ok(MapSeal { head:self.head.clone(),pages:self.ordinal,rows:self.rows,bytes:self.bytes,digest:self.digest.clone() })
            }
        }

        /// Families excluded from a logical full-domain image. These owners
        /// describe transport/copy progress, never a user's effect or receipt.
        pub fn is_transport_family(family:&str)->bool {
            matches!(family,"follow"|"adopt_state"|"adopt_changes"|"command_commit_state"|"command_commits"|META|ROWS)
        }

        /// Seed an older populated domain from its actual complete physical
        /// snapshot. This never assumes its first captured command is a baseline.
        /// The crypto callback seals each full postimage under its stable token.
        pub struct PhysicalSnapshot<'a> {scope:Scope<'a>,cursor:PhysicalCursor}
        impl<'a> PhysicalSnapshot<'a> {
            pub fn begin(store:&'a dyn Storage,stream:&str,key:&str,snapshot:&str,limits:Limits)->Result<Self> {
                let scope=Scope::current_read(store)?;let cursor=PhysicalCursor::begin(&*scope,stream,key,snapshot,limits)?;Ok(Self {scope,cursor})
            }
            pub fn head(&self)->&MapHead {self.cursor.head()}
            pub fn page(&mut self,seal:&mut dyn FnMut(&Effect,i64)->Result<OpaqueRow>)->Result<MapPage> {self.cursor.page(&*self.scope,seal)}
            pub fn seal(&self)->Result<MapSeal> {self.cursor.seal(&*self.scope)}
        }

        pub(crate) struct PhysicalCursor {
            owner:usize,head:MapHead,families:Vec<String>,family:usize,after:Option<Vec<Value>>,ordinal:u64,digest:String,rows:u64,bytes:u64,done:bool,limits:Limits,
        }
        impl PhysicalCursor {
            fn same(&self,store:&dyn Storage)->Result<()> {
                if self.owner!=store as *const dyn Storage as *const () as usize || !store.scoped() || store.writing()? { return Err(crate::cause!(Error::Moved)); }
                store.custody()
            }
            pub(crate) fn begin(store:&dyn Storage,stream:&str,token_key_identity:&str,snapshot:&str,limits:Limits)->Result<Self> {
                if !store.scoped() || store.writing()? { return Err(crate::cause!(Error::Invalid)); }
                store.custody()?;let frontier=super::frontiers(store,stream,limits)?;
                if frontier.stored!=frontier.materialized { return Err(crate::cause!(Error::Moved)); }
                let head=MapHead { snapshot:snapshot.into(),through:frontier.stored,token_key_identity:token_key_identity.into(),last_digest:super::last_digest(store,stream,limits)? };head_valid(&head,limits)?;
                let digest=first_digest(&head)?;
                let families=store.schema().families.iter().filter(|family|!is_transport_family(&family.family)).map(|family|family.family.clone()).collect();
                Ok(Self { owner:store as *const dyn Storage as *const () as usize,head,families,family:0,after:None,ordinal:0,digest,rows:0,bytes:0,done:false,limits })
            }
            pub fn head(&self)->&MapHead { &self.head }
            pub(crate) fn page(&mut self,store:&dyn Storage,seal:&mut dyn FnMut(&Effect,i64)->Result<OpaqueRow>)->Result<MapPage> {
                if self.done { return Err(crate::cause!(Error::Moved)); }self.same(store)?;
                let mut rows=Vec::new();let mut bytes=0usize;
                while rows.len()<self.limits.page_rows && self.family<self.families.len() {
                    let name=&self.families[self.family];let family=store.schema().family(name)?;
                    let read=family.fields.iter().map(|field|Read::at_most(field,self.limits.commit_bytes)).collect::<Vec<_>>();
                    let mut range=Range::all().limit(1);if let Some(after)=&self.after { range.from=Bound::Excluded(after.clone()); }
                    let Some(row)=store.scan(name,&range,&read)?.into_iter().next() else { self.family+=1;self.after=None;continue; };
                    let keys=family.key.iter().map(|key|Ok(row.0[family.fields.iter().position(|field|field==key).ok_or(crate::cause!(Error::Invalid))?].clone())).collect::<Result<Vec<_>>>()?;
                    let cells=row.0.into_iter().map(Cell::try_from).collect::<Result<Vec<_>>>()?;
                    let effect=Effect { family:name.clone(),key:keys.clone().into_iter().map(Cell::try_from).collect::<Result<Vec<_>>>()?,row:Some(cells) };
                    let opaque=seal(&effect,self.head.through)?;let size=row_size(&opaque,self.head.through,self.limits)?;
                    if !rows.is_empty() && bytes.saturating_add(size)>self.limits.page_bytes { break; }
                    bytes=bytes.checked_add(size).ok_or(crate::cause!(Error::TooBig))?;rows.push(opaque);self.after=Some(keys);
                }
                let mut page=MapPage { head:self.head.clone(),ordinal:self.ordinal,previous:self.digest.clone(),rows,done:self.family==self.families.len(),digest:String::new() };
                page.digest=page_digest(&page)?;if encoded(&page)?.len()>self.limits.capture_bytes { return Err(crate::cause!(Error::TooBig)); }
                for row in &page.rows { self.rows=self.rows.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;self.bytes=self.bytes.checked_add(row_size(row,self.head.through,self.limits)? as u64).ok_or(crate::cause!(Error::TooBig))?; }
                self.ordinal=self.ordinal.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;self.digest=page.digest.clone();self.done=page.done;self.same(store)?;Ok(page)
            }
            pub(crate) fn seal(&self,store:&dyn Storage)->Result<MapSeal> {
                if !self.done { return Err(crate::cause!(Error::Moved)); }self.same(store)?;
                Ok(MapSeal { head:self.head.clone(),pages:self.ordinal,rows:self.rows,bytes:self.bytes,digest:self.digest.clone() })
            }
        }

        /// Promotion uses one held write transaction. Bounded clearing and
        /// authentication steps remain invisible until Finish commits the new
        /// complete physical state and its exact map generation/frontier. A
        /// failed decoder, cancellation, dropped owner or lost process rolls
        /// this entire replacement back. A caller must not close an ancestor
        /// scope while this owner is alive.
        pub struct MapMaterializer<'a> {scope:Scope<'a>,cursor:MaterializationCursor}
        impl<'a> MapMaterializer<'a> {
            pub fn begin(store:&'a dyn Storage,stream:&str,limits:Limits)->Result<Self> {
                let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
                let cursor=MaterializationCursor::begin(&*scope,stream,limits)?;Ok(Self {scope,cursor})
            }
            pub fn step(&mut self,open:&mut dyn FnMut(&OpaqueRow)->Result<Effect>)->Result<bool> {self.cursor.step(&*self.scope,open)}
            pub fn finish(self)->Result<MapInfo> {let info=self.cursor.finish(&*self.scope)?;self.scope.commit()?;Ok(info)}
        }

        pub(crate) struct MaterializationCursor {
            owner:usize,stream:String,generation:String,through:i64,last_digest:Option<String>,
            families:Vec<String>,family:usize,clear_after:Option<Vec<Value>>,
            after:Option<String>,rows:u64,bytes:u64,expected_rows:u64,expected_bytes:u64,
            done:bool,limits:Limits,
        }
        impl MaterializationCursor {
            fn same(&self,store:&dyn Storage)->Result<()> {
                if self.owner!=store as *const dyn Storage as *const () as usize || !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Moved));}
                store.custody()
            }
            pub(crate) fn begin(store:&dyn Storage,stream:&str,limits:Limits)->Result<Self> {Self::begin_kind(store,stream,limits,false)}
            /// A fresh original canonical target witness must surround final
            /// publication. This additionally retires obsolete move transport
            /// after the complete replacement, never by pointer rollback.
            pub(crate) fn begin_retired(store:&dyn Storage,stream:&str,limits:Limits)->Result<Self> {Self::begin_kind(store,stream,limits,true)}
            fn begin_kind(store:&dyn Storage,stream:&str,limits:Limits,retired:bool)->Result<Self> {
                if !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Invalid));}
                store.custody()?;
                let mut metadata=meta(store,stream,limits)?;
                let active=metadata.active.as_mut().ok_or(crate::cause!(Error::Moved))?;
                active.materialized=None;
                let generation=active.id.clone();let through=active.through;let last_digest=active_digest(active);
                let expected_rows=active.rows;let expected_bytes=active.bytes;
                save_meta(store,&map_slot(stream)?,&metadata,limits)?;
                // Transport progress from an abandoned newer term must not
                // survive a complete replacement. Immutable routing bindings
                // are retained; all old command tails/identity receipts reset.
                let families=store.schema().families.iter().filter(|family|
                    !is_transport_family(&family.family) || family.family==STATE || family.family==LOG
                        || retired && matches!(family.family.as_str(),"adopt_state"|"adopt_changes"))
                    .map(|family|family.family.clone()).collect();
                Ok(Self { owner:store as *const dyn Storage as *const () as usize,stream:stream.into(),generation,through,last_digest,families,family:0,clear_after:None,
                    after:None,rows:0,bytes:0,expected_rows,expected_bytes,done:false,limits })
            }
            /// True only when the whole old physical image has been cleared
            /// and every opaque current row has been authenticated and applied.
            /// `open` must bind stream/full history, token, row position and
            /// key id using the actual crypto owner, then return its postimage.
            pub(crate) fn step(&mut self,store:&dyn Storage,open:&mut dyn FnMut(&OpaqueRow)->Result<Effect>)->Result<bool> {
                if self.done { return Ok(true); }self.same(store)?;
                let mut work=0usize;
                while self.family<self.families.len() && work<self.limits.page_rows {
                    work+=1;
                    let name=&self.families[self.family];let family=store.schema().family(name)?;
                    let bound=if name==LOG { self.limits.capture_bytes } else { self.limits.commit_bytes };
                    let reads=family.fields.iter().map(|field|Read::at_most(field,bound)).collect::<Vec<_>>();
                    let mut range=Range::all().limit(1);if let Some(after)=&self.clear_after { range.from=Bound::Excluded(after.clone()); }
                    let Some(row)=store.scan(name,&range,&reads)?.into_iter().next() else { self.family+=1;self.clear_after=None;continue; };
                    let keys=family.key.iter().map(|key|Ok(row.0[family.fields.iter().position(|field|field==key).ok_or(crate::cause!(Error::Invalid))?].clone())).collect::<Result<Vec<_>>>()?;
                    let keep=if name==STATE {
                        let at=family.fields.iter().position(|field|field=="body").ok_or(crate::cause!(Error::Invalid))?;
                        match &row.0[at] { Value::Blob(body)=>decoded::<StreamBinding>(body).is_ok_and(|binding|binding.kind=="stream-binding/v1"),_=>return Err(crate::cause!(Error::Invalid)) }
                    } else { false };
                    if !keep { remove_exact(store,name,keys.clone())?; }
                    self.clear_after=Some(keys);
                }
                if self.family<self.families.len() { self.same(store)?;return Ok(false); }
                let remaining=self.limits.page_rows.saturating_sub(work);
                if remaining==0 { return Ok(false); }
                let limits=Limits { page_rows:remaining,..self.limits };
                let rows=map_rows(store,&self.generation,self.after.as_deref(),self.through,limits)?;
                for row in &rows {
                    let effect=open(row)?;
                    if effect.row.is_none() || is_transport_family(&effect.family) { return Err(crate::cause!(Error::Invalid)); }
                    live_adopt::apply_complete(store,&[effect])?;
                    self.rows=self.rows.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
                    self.bytes=self.bytes.checked_add(row_size(row,self.through,self.limits)? as u64).ok_or(crate::cause!(Error::TooBig))?;
                    self.after=Some(row.token.clone());
                }
                self.done=map_rows(store,&self.generation,self.after.as_deref(),self.through,Limits { page_rows:1,..self.limits })?.is_empty();
                self.same(store)?;Ok(self.done)
            }
            pub(crate) fn finish(self,store:&dyn Storage)->Result<MapInfo> {
                self.same(store)?;
                if !self.done || self.rows!=self.expected_rows || self.bytes!=self.expected_bytes { return Err(crate::cause!(Error::Moved)); }
                let mut metadata=meta(store,&self.stream,self.limits)?;
                let active=metadata.active.as_mut().ok_or(crate::cause!(Error::Moved))?;
                if active.id!=self.generation || active.through!=self.through || active.rows!=self.rows || active.bytes!=self.bytes { return Err(crate::cause!(Error::Moved)); }
                active.materialized=Some(self.through);let info=info(active);
                let frontier=Stream { floor:self.through,through:self.through,bytes:0,last_digest:self.last_digest.clone() };
                save(store,&key("state",&self.stream,"")?,&frontier)?;
                save(store,&key("opaque state",&self.stream,"")?,&frontier)?;
                save_meta(store,&map_slot(&self.stream)?,&metadata,self.limits)?;
                self.same(store)?;Ok(info)
            }
        }

        /// A complete physical target has already passed the sealed-source
        /// comparison. Reset transport history in bounded turns while retaining
        /// ONE exact target write scope; publish this head in the SAME commit
        /// as native target activation. No content row is changed here.
        pub(crate) struct MaterializedBaselineCursor {
            owner:usize,stream:String,through:i64,digest:Option<String>,family:usize,after:Option<Vec<Value>>,done:bool,token_key:Option<WrappedKey>,limits:Limits,
        }
        impl MaterializedBaselineCursor {
            pub(crate) fn begin(store:&dyn Storage,stream:&str,through:i64,digest:Option<String>,limits:Limits)->Result<Self> {
                valid(stream,limits)?;
                if !store.scoped() || !store.writing()? || through<0 || (through==0 && digest.is_some())
                    || (through>0 && digest.as_deref().is_none_or(|digest|!hash_text(digest))) {return Err(crate::cause!(Error::Invalid));}
                store.custody()?;
                let token_key=wrapped_key(store,stream,limits)?;
                if token_key.as_ref().is_some_and(|key|!hash_text(&key.identity)||!key.envelope.is_object()) {return Err(crate::cause!(Error::Invalid));}
                Ok(Self {owner:store as *const dyn Storage as *const () as usize,stream:stream.into(),through,digest,family:0,after:None,done:false,token_key,limits})
            }
            fn same(&self,store:&dyn Storage)->Result<()> {
                if self.owner!=store as *const dyn Storage as *const () as usize || !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Moved));}store.custody()
            }
            pub(crate) fn step(&mut self,store:&dyn Storage)->Result<bool> {
                self.same(store)?;
                for _ in 0..self.limits.page_rows {
                    if self.family==4 {self.done=true;return Ok(true);}
                    let name=[LOG,STATE,ROWS,META][self.family];let family=store.schema().family(name)?;
                    let reads=family.fields.iter().map(|field|Read::at_most(field,self.limits.capture_bytes)).collect::<Vec<_>>();
                    let mut range=Range::all().limit(1);if let Some(after)=&self.after {range.from=Bound::Excluded(after.clone());}
                    let Some(row)=store.scan(name,&range,&reads)?.into_iter().next() else {self.family+=1;self.after=None;continue;};
                    let keys=family.key.iter().map(|key|Ok(row.0[family.fields.iter().position(|field|field==key).ok_or(crate::cause!(Error::Invalid))?].clone())).collect::<Result<Vec<_>>>()?;
                    let keep=if name==STATE {let at=family.fields.iter().position(|field|field=="body").ok_or(crate::cause!(Error::Invalid))?;
                        match &row.0[at] {Value::Blob(body)=>decoded::<StreamBinding>(body).is_ok_and(|binding|binding.kind=="stream-binding/v1"),_=>return Err(crate::cause!(Error::Invalid))}}
                        else {name==META && self.token_key.is_some() && keys==vec![key("opaque token key",&self.stream,"")?.into()]};
                    if !keep {remove_exact(store,name,keys.clone())?;}self.after=Some(keys);
                }
                self.same(store)?;Ok(false)
            }
            pub(crate) fn finish(self,store:&dyn Storage)->Result<()> {
                self.same(store)?;if !self.done || wrapped_key(store,&self.stream,self.limits)?!=self.token_key {return Err(crate::cause!(Error::Moved));}
                let frontier=Stream {floor:self.through,through:self.through,bytes:0,last_digest:self.digest};
                save(store,&key("state",&self.stream,"")?,&frontier)?;
                save(store,&key("opaque state",&self.stream,"")?,&frontier)
            }
        }

        /// Reset an obsolete transport tail in bounded steps under ONE held
        /// target write scope. Used by a copy-only install: no root or plaintext
        /// materialization is implied. Immutable stream bindings are preserved.
        pub(crate) struct OpaqueInstallCursor {
            owner:usize,stream:String,head:MapHead,family:usize,after:Option<Vec<Value>>,done:bool,limits:Limits,
        }
        impl OpaqueInstallCursor {
            pub(crate) fn begin(store:&dyn Storage,stream:&str,head:&MapHead,limits:Limits)->Result<Self> {
                if !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Invalid));}
                head_valid(head,limits)?;store.custody()?;
                let active=meta(store,stream,limits)?.active.ok_or(crate::cause!(Error::Moved))?;
                if active.through!=head.through || active_digest(&active)!=head.last_digest || active.materialized==Some(active.through) {return Err(crate::cause!(Error::Moved));}
                Ok(Self {owner:store as *const dyn Storage as *const () as usize,stream:stream.into(),head:head.clone(),family:0,after:None,done:false,limits})
            }
            fn same(&self,store:&dyn Storage)->Result<()> {
                if self.owner!=store as *const dyn Storage as *const () as usize || !store.scoped() || !store.writing()? {return Err(crate::cause!(Error::Moved));}store.custody()
            }
            pub(crate) fn step(&mut self,store:&dyn Storage)->Result<bool> {
                self.same(store)?;
                for _ in 0..self.limits.page_rows {
                    if self.family==2 {self.done=true;return Ok(true);}
                    let name=[LOG,STATE][self.family];let family=store.schema().family(name)?;
                    let reads=family.fields.iter().map(|field|Read::at_most(field,self.limits.capture_bytes)).collect::<Vec<_>>();
                    let mut range=Range::all().limit(1);if let Some(after)=&self.after {range.from=Bound::Excluded(after.clone());}
                    let Some(row)=store.scan(name,&range,&reads)?.into_iter().next() else {self.family+=1;self.after=None;continue;};
                    let keys=family.key.iter().map(|key|Ok(row.0[family.fields.iter().position(|field|field==key).ok_or(crate::cause!(Error::Invalid))?].clone())).collect::<Result<Vec<_>>>()?;
                    let keep=if name==STATE {let at=family.fields.iter().position(|field|field=="body").ok_or(crate::cause!(Error::Invalid))?;
                        match &row.0[at] {Value::Blob(body)=>decoded::<StreamBinding>(body).is_ok_and(|binding|binding.kind=="stream-binding/v1"),_=>return Err(crate::cause!(Error::Invalid))}}else{false};
                    if !keep {remove_exact(store,name,keys.clone())?;}self.after=Some(keys);
                }
                self.same(store)?;Ok(false)
            }
            pub(crate) fn finish(self,store:&dyn Storage)->Result<()> {
                self.same(store)?;if !self.done {return Err(crate::cause!(Error::Moved));}
                let active=meta(store,&self.stream,self.limits)?.active.ok_or(crate::cause!(Error::Moved))?;
                if active.through!=self.head.through || active_digest(&active)!=self.head.last_digest {return Err(crate::cause!(Error::Moved));}
                let frontier=Stream {floor:self.head.through,through:self.head.through,bytes:0,last_digest:self.head.last_digest};
                save(store,&key("opaque state",&self.stream,"")?,&frontier)
            }
        }

        /// Bounded disposal is required before another generation replaces the
        /// active one. An interrupted disposal remains discoverable metadata;
        /// it never leaves an orphan worker or unbounded generation list.
        pub fn retire_map_step(store:&dyn Storage,stream:&str,limits:Limits)->Result<bool> {
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            let mut meta=meta(store,stream,limits)?;let Some(retired)=meta.retired.as_ref() else { scope.commit()?;return Ok(true); };
            let rows=map_rows(store,retired,None,i64::MAX,limits)?;
            for row in &rows { remove_exact(store,ROWS,vec![retired.as_str().into(),row.token.as_str().into()])?; }
            let done=map_rows(store,retired,None,i64::MAX,Limits{page_rows:1,..limits})?.is_empty();
            if done { meta.retired=None;save_meta(store,&map_slot(stream)?,&meta,limits)?; }
            scope.commit()?;Ok(done)
        }
        pub fn discard_map_bootstrap_step(store:&dyn Storage,stream:&str,limits:Limits)->Result<bool> {
            let scope=Scope::begin(store,if store.scoped(){Intent::Nested}else{Intent::Write})?;
            let slot=building_slot(stream)?;let Some(building)=metadata::<Building>(store,&slot,limits)? else { scope.commit()?;return Ok(true); };
            let rows=map_rows(store,&building.generation,None,i64::MAX,limits)?;
            for row in &rows { remove_exact(store,ROWS,vec![building.generation.as_str().into(),row.token.as_str().into()])?; }
            let done=map_rows(store,&building.generation,None,i64::MAX,Limits{page_rows:1,..limits})?.is_empty();
            if done { remove_exact(store,META,vec![slot.into()])?; }scope.commit()?;Ok(done)
        }

        #[cfg(test)]
        mod bootstrap_tests {
            use super::*;
            use crate::storage::memory::Memory;
            fn limits()->Limits { Limits {page_rows:2,page_bytes:2048,commit_bytes:8192,capture_bytes:1<<20} }
            fn effect(id:&str,n:i64)->Effect {
                let row=vec![Cell::Text("synthetic".into()),Cell::Text("domain".into()),Cell::Text(id.into()),
                    Cell::Integer(i64::MAX),Cell::Integer(n),Cell::Integer(n),Cell::Integer(0),
                    Cell::Blob(vec![n as u8;40]),Cell::Text(format!("receipt-{id}-{n}")),Cell::Text("synthetic-kind".into())];
                Effect {family:"versions".into(),key:row[..4].to_vec(),row:Some(row)}
            }
            fn put(store:&dyn Storage,value:&Effect) { live_adopt::apply_complete(store,&[value.clone()]).unwrap(); }
            fn has(store:&dyn Storage,id:&str)->bool {
                store.get("versions",&["synthetic".into(),"domain".into(),id.into(),i64::MAX.into()],&[Read::whole("version")]).unwrap().is_some()
            }
            // Only the Storage protocol is tested by these callback fixtures.
            // Existing Copies crypto must separately qualify real ciphertext.
            fn opaque(effect:&Effect,sequence:i64)->Result<OpaqueRow> {
                Ok(OpaqueRow {token:content_crypto::advanced::blake3::hash(&encoded(&(&effect.family,&effect.key))?).to_hex().to_string(),sequence,payload:encoded(effect)?})
            }
            fn opened(row:&OpaqueRow)->Result<Effect> { decoded(&row.payload) }
            fn snapshot(source:&dyn Storage)->(Vec<MapPage>,MapSeal) {
                let mut snapshot=PhysicalSnapshot::begin(source,"history","key-id","snapshot-1",limits()).unwrap();
                let mut pages=Vec::new();loop { let page=snapshot.page(&mut opaque).unwrap();let done=page.done;assert!(page.rows.len()<=2);pages.push(page);if done {break;}assert!(pages.len()<100); }
                let seal=snapshot.seal().unwrap();(pages,seal)
            }
            fn prepared()->(Memory,Memory,Vec<MapPage>,MapSeal) {
                let source=Memory::open("record_store").unwrap();let target=Memory::open("record_store").unwrap();
                let effects=[effect("key",1),effect("original-receipt",1),effect("tombstone",1)];
                let transaction=Scope::begin(&source,Intent::Write).unwrap();
                for value in &effects {put(&source,value);}
                append_commit(&source,"history","original-request",&effects,limits()).unwrap();
                transaction.commit().unwrap();
                trim_through(&source,"history",1,limits()).unwrap();
                assert!(commits_after(&source,"history",0,limits()).is_err(),"old peer is genuinely behind retained history");
                put(&target,&effect("obsolete-extra-row",9));let(pages,seal)=snapshot(&source);(source,target,pages,seal)
            }
            fn receive(target:&dyn Storage,pages:&[MapPage],seal:&MapSeal) {
                begin_map_bootstrap(target,"history",&seal.head,limits()).unwrap();
                for page in pages {append_map_page(target,"history",page,limits()).unwrap();append_map_page(target,"history",page,limits()).unwrap();}
                finish_map_bootstrap(target,"history",seal,limits()).unwrap();
            }
            fn materialize(target:&dyn Storage) {
                let mut materializer=MapMaterializer::begin(target,"history",limits()).unwrap();
                let mut done=false;for _ in 0..200 {if materializer.step(&mut opened).unwrap(){done=true;break;}}
                assert!(done);assert!(materializer.finish().unwrap().materialized);
            }
            #[test]
            fn empty_preparation_cleanup_preserves_a_zero_cut_with_real_physical_data() {
                let target=Memory::open("record_store").unwrap();let key="a".repeat(64);
                let tx=Scope::begin(&target,Intent::Write).unwrap();
                initialize_empty_opaque_map(&target,"history",&key,limits()).unwrap();
                bind_wrapped_key(&target,"history",&WrappedKey {identity:key.clone(),envelope:serde_json::json!({"kept":"sealed"})},limits()).unwrap();
                put(&target,&effect("real-zero-cut-data",1));
                discard_empty_preparation(&target,"history",limits()).unwrap();
                assert!(has(&target,"real-zero-cut-data"));
                assert_eq!(wrapped_key(&target,"history",limits()).unwrap().unwrap().identity,key);
                assert!(map_info(&target,"history",limits()).unwrap().is_some());tx.commit().unwrap();
            }

            #[test]
            fn older_than_retained_history_uses_complete_bounded_shadow_and_atomic_materialization() {
                let(_source,target,pages,seal)=prepared();receive(&target,&pages,&seal);
                assert_eq!(frontiers(&target,"history",limits()).unwrap().materialized,-1);
                assert!(has(&target,"obsolete-extra-row"));assert!(!has(&target,"original-receipt"));
                materialize(&target);for id in ["key","original-receipt","tombstone"] {assert!(has(&target,id));}
                assert!(!has(&target,"obsolete-extra-row"));let front=frontiers(&target,"history",limits()).unwrap();assert_eq!((front.stored,front.materialized),(1,1));
                assert!(commits_after(&target,"history",0,limits()).is_err());
            }
            #[test]
            fn missing_page_changed_retry_and_premature_seal_cannot_publish_the_shadow() {
                let(_source,target,pages,seal)=prepared();assert!(pages.len()>1);
                begin_map_bootstrap(&target,"history",&seal.head,limits()).unwrap();
                assert!(append_map_page(&target,"history",&pages[1],limits()).is_err());
                append_map_page(&target,"history",&pages[0],limits()).unwrap();
                let mut changed=pages[0].clone();changed.rows[0].payload.push(0);
                assert!(append_map_page(&target,"history",&changed,limits()).is_err());
                assert!(finish_map_bootstrap(&target,"history",&seal,limits()).is_err());
                assert!(map_info(&target,"history",limits()).unwrap().is_none());assert!(has(&target,"obsolete-extra-row"));
                for page in &pages[1..]{append_map_page(&target,"history",page,limits()).unwrap();}
                finish_map_bootstrap(&target,"history",&seal,limits()).unwrap();materialize(&target);
                assert!(has(&target,"original-receipt"));
            }
            #[test]
            fn pinned_map_cursor_keeps_one_cut_while_another_handle_commits_and_refuses_handle_substitution() {
                let(_source,target,pages,seal)=prepared();receive(&target,&pages,&seal);materialize(&target);
                let read=Scope::current_read(&target).unwrap();let mut cursor=MapCursor::begin(&*read,"history","pinned",limits()).unwrap();
                let writer=target.reopen();let tx=Scope::begin(&writer,Intent::Write).unwrap();let added=effect("later",2);put(&writer,&added);
                let commit=append_commit(&writer,"history","next-command",&[added.clone()],limits()).unwrap();let row=opaque(&added,2).unwrap();
                update_opaque_map(&writer,"history","key-id",&MapDelta {sequence:2,digest:digest_of(&commit,limits()).unwrap(),updates:vec![OpaqueUpdate {token:row.token,payload:Some(row.payload)}]},limits()).unwrap();tx.commit().unwrap();
                assert!(matches!(cursor.page(&writer),Err(Error::Moved(_))));
                let mut count=0;loop {let page=cursor.page(&*read).unwrap();count+=page.rows.len();if page.done {break;}}
                assert_eq!(count,3);assert_eq!(cursor.seal(&*read).unwrap().head.through,1);
                read.commit().unwrap();assert!(has(&target,"later"));assert_eq!(map_info(&target,"history",limits()).unwrap().unwrap().through,2);
            }

            #[test]
            fn a_copy_only_map_cannot_reseal_a_missing_or_resized_ciphertext_row_as_complete() {
                for missing in [true,false] {
                    let(_source,target,pages,seal)=prepared();receive(&target,&pages,&seal);
                    let active=meta(&target,"history",limits()).unwrap().active.unwrap();
                    let row=map_rows(&target,&active.id,None,active.through,limits()).unwrap().into_iter().next().unwrap();
                    let tx=Scope::begin(&target,Intent::Write).unwrap();
                    if missing {
                        remove_exact(&target,ROWS,vec![active.id.as_str().into(),row.token.as_str().into()]).unwrap();
                    }else{
                        let mut changed=row;changed.payload.push(0);put_row(&target,&active.id,&changed).unwrap();
                    }
                    tx.commit().unwrap();
                    let mut snapshot=MapSnapshot::begin(&target,"history","damaged-relay",limits()).unwrap();
                    let mut done=false;for _ in 0..200 {if snapshot.page().unwrap().done {done=true;break;}}
                    assert!(done,"the physical enumeration itself reaches its end");
                    assert!(matches!(snapshot.seal(),Err(Error::Moved(_))),"a relay may not replace its authenticated complete-map counters with a smaller or resized image");
                }
            }

            #[test]
            fn materialized_baseline_retains_the_existing_wrapped_stream_token_key() {
                let target=Memory::open("record_store").unwrap();
                let wrapped=WrappedKey {identity:content_crypto::advanced::blake3::hash(b"stable stream token key").to_hex().to_string(),envelope:serde_json::json!({"opaque":"wrapped by crypto owner"})};
                bind_stream(&target,"history",b"full-scoped-binding",limits()).unwrap();
                bind_wrapped_key(&target,"history",&wrapped,limits()).unwrap();
                let tx=Scope::begin(&target,Intent::Write).unwrap();let value=effect("original-receipt",1);put(&target,&value);
                let commit=append_commit(&target,"history","original-request",&[value],limits()).unwrap();tx.commit().unwrap();
                let digest=digest_of(&commit,limits()).unwrap();
                let tx=Scope::begin(&target,Intent::Write).unwrap();
                let mut cursor=MaterializedBaselineCursor::begin(&target,"history",1,Some(digest),limits()).unwrap();
                let mut done=false;for _ in 0..200 {if cursor.step(&target).unwrap(){done=true;break;}}
                assert!(done);cursor.finish(&target).unwrap();tx.commit().unwrap();
                assert_eq!(wrapped_key(&target,"history",limits()).unwrap(),Some(wrapped),"transport cleanup must not remint a stream's stable token key from a later account root");
                assert!(has(&target,"original-receipt"));
            }

            #[test]
            fn materialized_baseline_cleanup_is_bounded_exact_handle_and_atomic_with_caller_commit() {
                let(_source,target,pages,seal)=prepared();receive(&target,&pages,&seal);materialize(&target);
                bind_stream(&target,"history",b"full-scoped-binding",limits()).unwrap();
                let digest=content_crypto::advanced::blake3::hash(b"sealed source frame").to_hex().to_string();
                let observer=target.reopen();
                {
                    let tx=Scope::begin(&target,Intent::Write).unwrap();
                    let mut cursor=MaterializedBaselineCursor::begin(&target,"history",9,Some(digest.clone()),limits()).unwrap();
                    assert!(matches!(cursor.step(&observer),Err(Error::Moved(_))));
                    assert!(!cursor.step(&target).unwrap(),"small work allowance requires another turn");
                    assert_eq!(frontiers(&observer,"history",limits()).unwrap().materialized,1,"uncommitted cleanup has no partial read visibility");
                    drop(cursor);drop(tx);
                }
                assert!(map_info(&target,"history",limits()).unwrap().is_some(),"dropping the actual writer rolls cleanup back");
                assert_eq!(frontiers(&target,"history",limits()).unwrap().materialized,1);
                let tx=Scope::begin(&target,Intent::Write).unwrap();
                let mut cursor=MaterializedBaselineCursor::begin(&target,"history",9,Some(digest.clone()),limits()).unwrap();
                let mut done=false;for _ in 0..200 {if cursor.step(&target).unwrap(){done=true;break;}}
                assert!(done);cursor.finish(&target).unwrap();
                assert_eq!(frontiers(&observer,"history",limits()).unwrap().materialized,1);
                tx.commit().unwrap();
                assert_eq!(frontiers(&target,"history",limits()).unwrap().materialized,9);
                assert_eq!(last_digest(&target,"history",limits()).unwrap(),Some(digest));
                assert!(map_info(&target,"history",limits()).unwrap().is_none());
                assert_eq!(stream_binding(&target,"history",limits()).unwrap().as_deref(),Some(b"full-scoped-binding".as_slice()));
                for id in ["key","original-receipt","tombstone"] {assert!(has(&target,id),"cleanup touches no content row");}
            }

            #[test]
            fn late_decoder_failure_rolls_back_clearing_and_every_applied_row_before_exact_retry() {
                let(_source,target,pages,seal)=prepared();receive(&target,&pages,&seal);
                {let mut materializer=MapMaterializer::begin(&target,"history",limits()).unwrap();let mut opened_rows=0;
                    let mut decoder=|row:&OpaqueRow|{opened_rows+=1;if opened_rows==2 {Err(crate::cause!(Error::Interrupted))}else {opened(row)}};
                    let mut refused=false;for _ in 0..200 {match materializer.step(&mut decoder){Err(Error::Interrupted(_))=>{refused=true;break;},Ok(false)=>{},other=>panic!("late fault not reached: {other:?}")}}
                    assert!(refused);assert_eq!(opened_rows,2);
                }
                assert!(has(&target,"obsolete-extra-row"));assert!(!has(&target,"original-receipt"));
                assert_eq!(frontiers(&target,"history",limits()).unwrap().materialized,-1);
                materialize(&target);assert!(!has(&target,"obsolete-extra-row"));assert!(has(&target,"original-receipt"));
            }
        }
    }
}
