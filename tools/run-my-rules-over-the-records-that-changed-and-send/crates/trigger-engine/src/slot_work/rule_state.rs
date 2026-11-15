use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use slot_protocol::FactAddress;

use super::match_rules::{
    compile_match_condition, oversized_content_match_summary, project_change_bytes_for_match,
    CompiledMatchPredicate, MutationContext, RetainedContent,
};
use super::rule_record::TriggerRule;

const OBSERVED_MUTATION_REPLAY_LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct GapScanProgress {
    pub(super) cursor: u64,
    pub(super) baseline_existed: bool,
    pub(super) scanned_total: usize,
    /// Current rule identities were enumerated and reconciled before any
    /// recovered non-rule record may dispatch.
    pub(super) rules_validated: bool,
    pub(super) rule_cursor: u64,
    pub(super) rule_scanned_total: usize,
    pub(super) rule_validation_started: bool,
    /// Monotonic within one parked scan. Every re-park changes the durable
    /// wake bytes, including a retry of the exact same failed cursor.
    pub(super) wake_revision: u64,
}

pub(super) struct StoredTriggerRule {
    pub(super) rule: TriggerRule,
    pub(super) match_bindings: Vec<CompiledMatchPredicate>,
}

impl StoredTriggerRule {
    fn compile(rule: TriggerRule) -> Result<Self, String> {
        let match_bindings = compile_match_condition(&rule.match_condition)?;
        Ok(Self {
            rule,
            match_bindings,
        })
    }
}

#[derive(Default)]
pub(super) struct TriggerState {
    by_address: HashMap<FactAddress, Arc<StoredTriggerRule>>,
    observed_mutations: VecDeque<ReplayEntry>,
    /// Last-evaluated content fingerprint per address.
    ///
    /// The delivery-gap catch-up (delta-delivery-integrity Task E) scans
    /// current live state after the engine signals a lost interval and must
    /// re-evaluate ONLY entries whose content actually changed versus what
    /// this slot last saw — otherwise every gap would re-fire every rule
    /// against all of live state. Bounded by the live-address count.
    ///
    /// HARDEN-22: the value is a 128-bit FNV-1a fingerprint of the normalized
    /// content-hash string, NOT the string itself — a heap String per live
    /// address (~90 bytes each) made the O(live-state) map the memory
    /// pressure that trapped the wasm in `note_seen`'s memcmp on customer-sized
    /// live state. 16 inline bytes per entry, no heap, no string compare;
    /// 128-bit collision probability over any realistic address count is
    /// negligible (and the input is itself a cryptographic hash).
    last_seen: HashMap<FactAddress, u128>,
    /// Whether `last_seen` has a full-live-state baseline.
    ///
    /// The boot snapshot delivers ONLY this slot's bootstrap selector (trigger
    /// rules), so `last_seen` starts without general records. The FIRST gap
    /// therefore cannot distinguish "missed while I was subscribed" from
    /// "written before I ever looked" — evaluating everything would re-fire
    /// rules against all historical records. The first catch-up seeds the
    /// baseline WITHOUT evaluating (the gap is still recorded durably); every
    /// later gap catches up differentially.
    seen_baseline: bool,
    /// Merged interval of gaps whose catch-up scan is still owed.
    ///
    /// Gap-storm coalescing (HARDEN-21): back-to-back gap payloads each
    /// triggering a FULL live-state scan trapped the wasm under memory
    /// pressure. A storm now costs at most TWO scans: one immediate (first
    /// gap), one deferred (first gapless payload drains the merged residue).
    pending_gap: Option<(u64, u64)>,
    /// One durable wake is enough for the merged residue. Rewriting the same
    /// wake on every gap-only delivery feeds the write back into this slot's
    /// own subscription and can grow the log without bound.
    pending_gap_wake_issued: bool,
    /// At most one extra scan runs while gaps remain continuous. A wake that
    /// itself arrives with a gap must still drain the owed residue, but must
    /// not start another self-wake cycle.
    residue_scan_ran_this_storm: bool,
    /// True while a scan has already run for the current gap storm — further
    /// gaps merge into `pending_gap` instead of rescanning. Reset by the
    /// first gapless payload (which also drains the pending residue).
    gap_scan_ran_this_storm: bool,
    /// Resume cursor for an in-progress catch-up scan (HARDEN-22c).
    ///
    /// A `handle_query` invocation has a FUEL budget (1e9); a full live-state
    /// scan in one invocation exhausts it and traps at whatever instruction
    /// fuel hits zero (observed: base64 → hex chars → memcmp → __multi3 as
    /// each was optimized away). The scan therefore advances at most
    /// `GAP_CATCH_UP_PAGES_PER_STEP` pages per invocation and parks its
    /// cursor here; EVERY subsequent payload (gap or not) continues it.
    /// Work-per-invocation is O(pages-per-step), never O(live-state).
    /// Carries the cursor, baseline mode, and total rows scanned so a parked
    /// scan cannot reset its global safety ceiling on each fresh invocation.
    scan_resume: Option<GapScanProgress>,
    /// Monotonic wake content revision across every scan owned by this
    /// persistent instance. A later scan that parks at the same cursor must
    /// not recreate an older current-item payload and get deduplicated.
    wake_revision: u64,
    /// Addresses that existed before this scan and have not appeared in its
    /// current-state pages. Snapshotting candidates at scan start prevents a
    /// concurrently delivered NEW address from being mistaken for a missed
    /// retraction when the scan completes.
    scan_missing_candidates: HashSet<FactAddress>,
    /// Cached rules not yet observed in the current bounded rule-validation
    /// pass. Only the final validation page may evict the remainder.
    rule_validation_missing_candidates: HashSet<FactAddress>,
    /// Rules learned from a non-snapshot recovery scan must prove their exact
    /// current content immediately before every effect. Ordinary delivered
    /// rule assertions clear this bit because they are causally ordered with
    /// the mutation feed; a parked current-state scan is not.
    rules_requiring_current_verification: HashSet<FactAddress>,
}

impl TriggerState {
    pub(super) fn upsert(
        &mut self,
        address: FactAddress,
        rule: TriggerRule,
    ) -> Result<Option<(FactAddress, Arc<StoredTriggerRule>)>, String> {
        let changed = self
            .by_address
            .get(&address)
            .map(|existing| existing.rule != rule)
            .unwrap_or(true);
        let stored = Arc::new(StoredTriggerRule::compile(rule)?);
        self.by_address.insert(address.clone(), Arc::clone(&stored));
        if changed && stored.rule.is_active && stored.rule.is_delta_driven() {
            Ok(Some((address, stored)))
        } else {
            Ok(None)
        }
    }

    pub(super) fn remove(&mut self, address: &FactAddress) {
        self.by_address.remove(address);
        self.rules_requiring_current_verification.remove(address);
    }

    /// Record the last-evaluated content hash for an address (normalized
    /// `code:hex`). Returns `true` when the hash CHANGED versus what was
    /// remembered (i.e. this content has not been evaluated yet).
    pub(super) fn note_seen(&mut self, address: FactAddress, content_hash: &str) -> bool {
        // A verified delivered assert is also authoritative evidence that the
        // address still exists while a scan is in flight. Without this, an
        // assert delivered after begin_scan could be synthesized as a
        // retraction when the final page arrives.
        self.scan_missing_candidates.remove(&address);
        let fingerprint = content_fingerprint(content_hash);
        match self.last_seen.get(&address) {
            Some(existing) if *existing == fingerprint => false,
            _ => {
                self.last_seen.insert(address, fingerprint);
                true
            }
        }
    }

    /// Compare without advancing. Gap recovery must not suppress a retry when
    /// the hash-verified direct read fails after the current-state scan.
    pub(super) fn content_changed(&self, address: &FactAddress, content_hash: &str) -> bool {
        self.last_seen.get(address).copied() != Some(content_fingerprint(content_hash))
    }

    /// Forget the last-seen hash for a retracted address so a later re-assert
    /// of identical content still evaluates.
    pub(super) fn forget_seen(&mut self, address: &FactAddress) {
        self.last_seen.remove(address);
        // The live retraction has already been delivered and evaluated. Do
        // not emit the same retraction again when an in-flight scan completes.
        self.scan_missing_candidates.remove(address);
    }

    /// Begin one whole current-state scan. Baseline completion is intentionally
    /// deferred until the FINAL page; a partial first scan is still seeding.
    pub(super) fn begin_scan(&mut self) -> bool {
        // The first scan establishes what "currently present" means. It may
        // seed fingerprints, but it cannot infer a missed retraction from
        // pre-baseline delivery state without replaying historical absence.
        // Once the baseline exists, every remembered current address is an
        // exact absence candidate for the next whole scan.
        self.scan_missing_candidates = if self.seen_baseline {
            self.last_seen.keys().cloned().collect()
        } else {
            HashSet::new()
        };
        self.seen_baseline
    }

    /// Mark an address present in this scan. This is separate from its content
    /// hash: presence is known before a direct read succeeds.
    pub(super) fn note_scan_presence(&mut self, address: &FactAddress) {
        self.scan_missing_candidates.remove(address);
    }

    /// On the final page, evict rules proven absent before any changed record
    /// from that page is evaluated. Other missing addresses stay queued for
    /// synthetic retractions after the page's verified reads complete.
    pub(super) fn remove_missing_rules_before_dispatch(&mut self) {
        for address in &self.scan_missing_candidates {
            self.by_address.remove(address);
            self.rules_requiring_current_verification.remove(address);
        }
    }

    pub(super) fn begin_rule_validation(&mut self) {
        self.rule_validation_missing_candidates = self.by_address.keys().cloned().collect();
        self.rules_requiring_current_verification
            .extend(self.by_address.keys().cloned());
    }

    pub(super) fn note_rule_validation_presence(&mut self, address: &FactAddress) {
        self.rule_validation_missing_candidates.remove(address);
        self.rules_requiring_current_verification
            .insert(address.clone());
    }

    pub(super) fn clear_current_verification(&mut self, address: &FactAddress) {
        self.rules_requiring_current_verification.remove(address);
    }

    pub(super) fn require_current_verification(&mut self, address: &FactAddress) {
        self.rules_requiring_current_verification
            .insert(address.clone());
    }

    pub(super) fn requires_current_verification(&self, address: &FactAddress) -> bool {
        self.rules_requiring_current_verification.contains(address)
    }

    pub(super) fn is_registered_rule(
        &self,
        address: &FactAddress,
        stored: &Arc<StoredTriggerRule>,
    ) -> bool {
        self.by_address
            .get(address)
            .is_some_and(|current| Arc::ptr_eq(current, stored))
    }

    pub(super) fn remove_if_registered(
        &mut self,
        address: &FactAddress,
        stored: &Arc<StoredTriggerRule>,
    ) {
        if self.is_registered_rule(address, stored) {
            self.remove(address);
        }
    }

    pub(super) fn complete_rule_validation(&mut self) {
        let missing = self
            .rule_validation_missing_candidates
            .drain()
            .collect::<Vec<_>>();
        for address in missing {
            self.remove(&address);
        }
    }

    /// Complete the full scan, making a first baseline authoritative and
    /// returning only PRE-SCAN addresses absent from every page. Missing rules
    /// are removed here before synthetic retractions evaluate against the
    /// remaining active rule set.
    pub(super) fn complete_scan(&mut self) -> Vec<FactAddress> {
        let missing = self.scan_missing_candidates.drain().collect::<Vec<_>>();
        for address in &missing {
            self.last_seen.remove(address);
            self.by_address.remove(address);
            self.rules_requiring_current_verification.remove(address);
        }
        self.seen_baseline = true;
        missing
    }

    /// A truncated scan is not a baseline. Discard only its absence candidates;
    /// successfully verified hashes already recorded remain safe resume input.
    pub(super) fn abandon_scan(&mut self) {
        self.scan_missing_candidates.clear();
        self.rule_validation_missing_candidates.clear();
        self.scan_resume = None;
    }

    /// Register an incoming gap. Returns `Some(merged interval)` when a scan
    /// should run NOW (first gap of a storm), `None` when the gap merged into
    /// the pending residue (a scan already ran this storm — the residue drains
    /// on the next gapless payload).
    pub(super) fn register_gap(&mut self, from_cursor: u64, to_cursor: u64) -> Option<(u64, u64)> {
        let merged = match self.pending_gap {
            Some((existing_from, existing_to)) => {
                (existing_from.min(from_cursor), existing_to.max(to_cursor))
            }
            None => (from_cursor, to_cursor),
        };
        if self.gap_scan_ran_this_storm {
            self.pending_gap = Some(merged);
            return None;
        }
        self.gap_scan_ran_this_storm = true;
        self.pending_gap = None;
        self.pending_gap_wake_issued = false;
        self.residue_scan_ran_this_storm = false;
        Some(merged)
    }

    /// Called on a gapless payload: ends the storm. Returns a pending merged
    /// interval whose deferred scan is now due (the stream is quiet enough
    /// that one more scan is safe), or `None` when nothing is owed.
    pub(super) fn take_pending_gap(&mut self) -> Option<(u64, u64)> {
        self.gap_scan_ran_this_storm = false;
        self.pending_gap_wake_issued = false;
        self.residue_scan_ran_this_storm = false;
        self.pending_gap.take()
    }

    /// Drain the merged residue when our own durable wake arrives, with or
    /// without a delivery-gap marker. Keep the storm state through that wake:
    /// treating each gapless continuation as a fresh quiet stream restarted
    /// the whole current-state scan once per completed pass.
    pub(super) fn take_pending_gap_after_wake(&mut self) -> Option<(u64, u64)> {
        if !self.pending_gap_wake_issued || self.residue_scan_ran_this_storm {
            return None;
        }
        self.residue_scan_ran_this_storm = true;
        self.pending_gap.take()
    }

    /// An empty gapless delivery may finish the already-owed residue scan,
    /// but it cannot prove that the gap storm ended. Keep the one-scan guard.
    pub(super) fn take_pending_gap_after_empty_delivery(&mut self) -> Option<(u64, u64)> {
        if self.residue_scan_ran_this_storm {
            return None;
        }
        let pending = self.pending_gap.take()?;
        self.residue_scan_ran_this_storm = true;
        Some(pending)
    }

    pub(super) fn empty_delivery_continues_recovery(&self) -> bool {
        self.scan_resume.is_some()
            || self.pending_gap.is_some()
            || self.pending_gap_wake_issued
            || self.residue_scan_ran_this_storm
    }

    pub(super) fn note_gapless_payload_while_resuming_scan(&mut self) {
        // A real mutation can arrive while the residue pass is still paging.
        // It must not make that same storm eligible for another residue pass.
        // Only a first pass may need a fresh wake after its parked page ends.
        if !self.residue_scan_ran_this_storm {
            self.pending_gap_wake_issued = false;
        }
    }

    /// Park an in-progress scan's resume point (page budget exhausted).
    #[cfg(test)]
    pub(super) fn park_scan(&mut self, progress: GapScanProgress) {
        self.scan_resume = Some(progress);
    }

    /// Park and assign bytes-distinguishing identity to the durable self-wake.
    pub(super) fn park_scan_for_wake(&mut self, mut progress: GapScanProgress) -> GapScanProgress {
        // Rule discovery is one bounded pass per recovery. It is not a
        // snapshot, so recovered effects independently verify each matching
        // rule's exact current address/hash. Re-running the whole all-state
        // pass before every 16-row data page would be quadratic.
        self.wake_revision = self
            .wake_revision
            .max(progress.wake_revision)
            .saturating_add(1);
        progress.wake_revision = self.wake_revision;
        self.scan_resume = Some(progress);
        progress
    }

    /// Take the parked scan resume point to continue it this invocation.
    pub(super) fn take_parked_scan(&mut self) -> Option<GapScanProgress> {
        self.scan_resume.take()
    }

    pub(super) fn needs_pending_gap_wake(&self) -> bool {
        self.scan_resume.is_none()
            && self.pending_gap.is_some()
            && !self.pending_gap_wake_issued
            && !self.residue_scan_ran_this_storm
    }

    /// Allocate identity for a wake that drains a deferred gap after the
    /// current scan finishes. This shares the same sequence as parked-scan
    /// wakes so every write to the singleton current address changes bytes.
    pub(super) fn pending_gap_wake_revision(&mut self) -> Option<u64> {
        if !self.needs_pending_gap_wake() {
            return None;
        }
        self.pending_gap_wake_issued = true;
        self.wake_revision = self.wake_revision.saturating_add(1);
        Some(self.wake_revision)
    }

    pub(super) fn remember_observation(&mut self, entry: ReplayEntry) {
        if self.observed_mutations.len() == OBSERVED_MUTATION_REPLAY_LIMIT {
            self.observed_mutations.pop_front();
        }
        self.observed_mutations.push_back(entry);
    }

    pub(super) fn observed_mutations(&self) -> Vec<ReplayEntry> {
        self.observed_mutations.iter().cloned().collect()
    }

    pub(super) fn active_delta_rules(&self) -> Vec<(FactAddress, Arc<StoredTriggerRule>)> {
        self.by_address
            .iter()
            .filter(|(_, stored)| stored.rule.is_active && stored.rule.is_delta_driven())
            .map(|(address, stored)| (address.clone(), Arc::clone(stored)))
            .collect()
    }
}

/// 128-bit FNV-1a over the normalized content-hash string (HARDEN-22).
/// The input is already a cryptographic hash rendered as text; this only
/// compresses it to 16 inline bytes for the `last_seen` map.
fn content_fingerprint(content_hash: &str) -> u128 {
    const FNV_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut hash = FNV_OFFSET;
    for byte in content_hash.as_bytes() {
        // Case-fold so pre-normalized (code:hex) and normalized inputs
        // fingerprint identically without allocating a lowercase copy.
        hash ^= u128::from(byte.to_ascii_lowercase());
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[derive(Clone)]
pub(super) struct ObservedMutation {
    raw_bytes: RetainedContent,
    envelope: Value,
}

impl ObservedMutation {
    pub(super) fn asserted(raw_bytes: Vec<u8>, envelope: Value) -> Self {
        Self {
            raw_bytes: RetainedContent::from_bytes(raw_bytes),
            envelope,
        }
    }

    pub(super) fn retracted(envelope: Value) -> Self {
        Self {
            raw_bytes: RetainedContent::Absent,
            envelope,
        }
    }

    pub(super) fn to_context(&self, required_change_paths: &[String]) -> MutationContext {
        let change_for_match = match &self.raw_bytes {
            RetainedContent::Retained(bytes) => {
                project_change_bytes_for_match(bytes, required_change_paths)
            }
            RetainedContent::Oversized { len } => oversized_content_match_summary(*len),
            RetainedContent::Absent => Value::Null,
        };
        MutationContext {
            change_for_match,
            change_for_dispatch: OnceLock::new(),
            raw_bytes: self.raw_bytes.clone(),
            envelope: self.envelope.clone(),
        }
    }
}

/// One replay-ring entry: the mutation's identity, NOT its bytes.
///
/// The ring exists solely so a LATE-admitted rule can be evaluated against
/// recently observed mutations. Retaining raw payloads for that cold path
/// meant up to `OBSERVED_MUTATION_REPLAY_LIMIT * MAX_DISPATCH_CHANGE_BYTES`
/// (~512MiB) parked inside a persistent WASM instance whose linear memory
/// never shrinks — the dominant per-turn RSS ratchet (leak plan
/// 2026-07-11-process-engine-unbounded-session-history-leak, site 3; converged
/// Claude + Codex gpt-5.6-sol). Content already lives durably in the log/CAS;
/// replay re-resolves it BY HASH through the same `resolve_direct_read` seam
/// hash-only deliveries use. Entries are ~identity-sized (address + hash +
/// envelope metadata), so the ring's ceiling drops from ~512MiB to ~100KiB.
///
/// A retraction has no content to resolve; it replays as `Absent` directly.
#[derive(Clone)]
pub(super) struct ReplayEntry {
    pub(super) address: FactAddress,
    /// Normalized content hash for lazy resolution; `None` for retractions.
    pub(super) content_hash: Option<String>,
    pub(super) envelope: Value,
}

impl ReplayEntry {
    pub(super) fn asserted(address: FactAddress, content_hash: String, envelope: Value) -> Self {
        Self {
            address,
            content_hash: Some(content_hash),
            envelope,
        }
    }

    pub(super) fn retracted(address: FactAddress, envelope: Value) -> Self {
        Self {
            address,
            content_hash: None,
            envelope,
        }
    }

    /// A retraction's replay context — content-free by nature.
    pub(super) fn retraction_observation(&self) -> ObservedMutation {
        ObservedMutation::retracted(self.envelope.clone())
    }

    /// An assertion's replay context from freshly re-resolved bytes.
    pub(super) fn observation_with_bytes(&self, bytes: Vec<u8>) -> ObservedMutation {
        ObservedMutation::asserted(bytes, self.envelope.clone())
    }
}

#[cfg(test)]
mod gap_wake_tests {
    use super::TriggerState;

    #[test]
    fn continuous_gap_only_delivery_issues_one_residue_wake() {
        let mut state = TriggerState::default();
        assert_eq!(state.register_gap(1, 2), Some((1, 2)));
        assert_eq!(state.register_gap(2, 3), None);
        assert_eq!(state.pending_gap_wake_revision(), Some(1));
        for cursor in 3..100 {
            assert_eq!(state.register_gap(cursor, cursor + 1), None);
            assert_eq!(state.pending_gap_wake_revision(), None);
        }
        assert_eq!(state.take_pending_gap(), Some((2, 100)));
        assert_eq!(state.register_gap(100, 101), Some((100, 101)));
    }

    #[test]
    fn external_gapless_delivery_during_residue_does_not_rearm_self_wake() {
        let mut state = TriggerState::default();
        assert_eq!(state.register_gap(1, 2), Some((1, 2)));
        assert_eq!(state.register_gap(2, 3), None);
        assert_eq!(state.pending_gap_wake_revision(), Some(1));
        assert_eq!(state.take_pending_gap_after_wake(), Some((2, 3)));
        assert_eq!(state.register_gap(3, 4), None);

        // A genuine mutation can be delivered on the page that completes the
        // residue scan. It is not permission for our own wake to start a third
        // full scan from cursor zero.
        state.note_gapless_payload_while_resuming_scan();
        assert_eq!(state.pending_gap_wake_revision(), None);
        assert_eq!(state.take_pending_gap_after_wake(), None);
        assert_eq!(state.register_gap(4, 5), None);
    }
}
