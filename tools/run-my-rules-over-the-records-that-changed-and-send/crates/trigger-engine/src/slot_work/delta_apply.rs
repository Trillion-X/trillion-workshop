use std::sync::{Mutex, OnceLock};

use bytes::Bytes;
use serde_json::{json, Value};
use slot_protocol::{DeltaPayload, Envelope, FactAddress, PartitionKey, PathSegment, WriteEntry};

use super::dispatch_output::{
    dispatch_match, match_with_optional_evaluator, normalize_content_hash, resolve_direct_read,
    DispatchResult, TalkToOtherSlots,
};
use super::match_rules::{
    envelope_value, match_change_paths, match_compiled_rule_locally,
    resolve_template_value_for_mutation, MutationContext,
};
use super::rule_record::{parse_trigger_rule_record, TriggerRule};
use super::rule_state::{
    GapScanProgress, ObservedMutation, ReplayEntry, StoredTriggerRule, TriggerState,
};

/// Live-state page size for delivery-gap catch-up (hash-only rows). Native can
/// cheaply absorb a larger page; WASM also pays for every changed row's verified
/// direct read inside the invocation fuel budget, so its bite stays deliberately
/// small.
#[cfg(not(target_arch = "wasm32"))]
const GAP_CATCH_UP_PAGE_LIMIT: u32 = 512;
#[cfg(target_arch = "wasm32")]
const GAP_CATCH_UP_PAGE_LIMIT: u32 = 16;
/// Rule identity preflight is always kept to one small page per invocation;
/// each changed rule can require a verified direct read and recompilation.
const RULE_VALIDATION_PAGE_LIMIT: u32 = 16;
/// Hard bound on entries a single catch-up scans. Live state beyond this is
/// reported as a truncated catch-up (durable), never silently skipped.
const GAP_CATCH_UP_SCAN_CAP: usize = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuleValidationStep {
    More {
        next_cursor: u64,
        scanned_total: usize,
    },
    Complete {
        scanned_total: usize,
    },
    Truncated {
        scanned_total: usize,
    },
}
/// Pages advanced per handler INVOCATION (HARDEN-22c). Each `handle_query`
/// runs under a fuel budget — a full live-state scan in one invocation
/// exhausts it and traps mid-loop (base64/hex/memcmp/__multi3/Vec::drop
/// backtraces were all fuel exhaustion at whatever instruction ran out).
/// ONE page per invocation: the invocation also pays for its own payload's
/// asserts AND the changed entries' direct reads (multi-MB payloads), so the
/// scan takes the smallest possible bite and parks; every subsequent payload
/// continues it.
const GAP_CATCH_UP_PAGES_PER_STEP: usize = 1;

pub struct TriggerHandler<I: TalkToOtherSlots> {
    state: Mutex<TriggerState>,
    talk_to_other_slots: I,
}

/// A handled delta: the JSON response bytes plus the durable
/// durable failure and correlated dispatch-outcome writes derived from a delta.
pub struct HandleOutcome {
    pub response: Vec<u8>,
    pub failure_writes: Vec<WriteEntry>,
    pub outcome_writes: Vec<WriteEntry>,
}

impl<I: TalkToOtherSlots> TriggerHandler<I> {
    pub fn new(talk_to_other_slots: I) -> Self {
        Self {
            state: Mutex::new(TriggerState::default()),
            talk_to_other_slots,
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn handle(&self, envelope: &Envelope) -> Result<Vec<u8>, String> {
        Ok(self.handle_with_writes(envelope)?.response)
    }

    /// The primary handler: response bytes + durable dispatch-failure writes.
    /// Every dispatch failure the response reports is ALSO shipped as a
    /// `workflow-dispatch-failure` current-item write so silence is impossible
    /// (the response-only era cost hours of live discriminator experiments per
    /// silent kill). One deterministic address per discriminator = last failure
    /// per definition/rule, self-bounding.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn handle_with_writes(&self, envelope: &Envelope) -> Result<HandleOutcome, String> {
        let delta: DeltaPayload = serde_json::from_slice(
            envelope
                .payload
                .as_ref()
                .ok_or_else(|| "trigger-engine: envelope.payload is required".to_string())?,
        )
        .map_err(|e| format!("trigger-engine: payload parse failed: {e}"))?;
        if !delta.is_delta() {
            return Err("trigger-engine: expected delta payload".to_string());
        }
        let (dispatch_failures, dispatch_outcomes) =
            self.process_delta(&envelope.partition_key, delta)?;
        let needs_continuation = dispatch_failures
            .iter()
            .any(|effect| effect.get("kind").and_then(Value::as_str) == Some("catch-up-pending"));
        let failure_writes = dispatch_failure_writes(&envelope.partition_key, &dispatch_failures);
        let outcome_writes = dispatch_outcome_writes(&envelope.partition_key, &dispatch_outcomes);
        let response = serde_json::to_vec(&json!({
            "status": "ok",
            "dispatch_failures": dispatch_failures,
            "subscription_continuation": needs_continuation.then(|| json!({"type":"delta","asserts":[],"retracts":[]})),
        }))
        .map_err(|e| format!("trigger-engine: response serialize failed: {e}"))?;
        Ok(HandleOutcome {
            response,
            failure_writes,
            outcome_writes,
        })
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn handle(&self, envelope: &Envelope) -> Result<Vec<u8>, String> {
        Ok(self.handle_with_writes(envelope).await?.response)
    }

    /// The primary handler: response bytes + durable dispatch-failure writes
    /// (see the native twin's doc).
    #[cfg(target_arch = "wasm32")]
    pub async fn handle_with_writes(&self, envelope: &Envelope) -> Result<HandleOutcome, String> {
        let delta: DeltaPayload = serde_json::from_slice(
            envelope
                .payload
                .as_ref()
                .ok_or_else(|| "trigger-engine: envelope.payload is required".to_string())?,
        )
        .map_err(|e| format!("trigger-engine: payload parse failed: {e}"))?;
        if !delta.is_delta() {
            return Err("trigger-engine: expected delta payload".to_string());
        }
        let (dispatch_failures, dispatch_outcomes) =
            self.process_delta(&envelope.partition_key, delta).await?;
        let needs_continuation = dispatch_failures
            .iter()
            .any(|effect| effect.get("kind").and_then(Value::as_str) == Some("catch-up-pending"));
        let failure_writes = dispatch_failure_writes(&envelope.partition_key, &dispatch_failures);
        let outcome_writes = dispatch_outcome_writes(&envelope.partition_key, &dispatch_outcomes);
        let response = serde_json::to_vec(&json!({
            "status": "ok",
            "dispatch_failures": dispatch_failures,
            "subscription_continuation": needs_continuation.then(|| json!({"type":"delta","asserts":[],"retracts":[]})),
        }))
        .map_err(|e| format!("trigger-engine: response serialize failed: {e}"))?;
        Ok(HandleOutcome {
            response,
            failure_writes,
            outcome_writes,
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn process_delta(
        &self,
        partition: &PartitionKey,
        delta: DeltaPayload,
    ) -> Result<(Vec<Value>, Vec<Value>), String> {
        let mut rule_updates = Vec::new();
        let mut pending_assertions = Vec::new();
        let mut dispatch_failures = Vec::new();
        let mut dispatch_outcomes = Vec::new();
        // Delivery-gap sentinel (delta-delivery-integrity Task E): captured
        // up-front (Copy) — catch-up runs AFTER this payload's own
        // asserts/retracts so ordering stays causal.
        let gap = delta.gap;
        // An empty delivery is not evidence that the feed has become quiet.
        // The hosted forwarder emits empty continuations between gap-only
        // deliveries; resetting the storm on each one restarts the full scan.
        let is_internal_wake = delta.retracts.is_empty()
            && (delta.asserts.is_empty()
                && self
                    .state
                    .lock()
                    .map(|state| state.empty_delivery_continues_recovery())
                    .unwrap_or(false)
                || !delta.asserts.is_empty() && delta.asserts.iter().all(is_failure_record_assert));

        for assert in delta.asserts {
            let address = decode_address(&assert.address)?;
            // Recursion guard (category-wide): our own durable failure /
            // continuation records come back around the delta feed. They are
            // NEVER rule-evaluated — recording a failure ABOUT a failure
            // record would chain unbounded distinct addresses, and a
            // `catch-up-pending` wake's only job is ARRIVING (the
            // resume_parked_scan call below runs on every payload). The
            // assert's PATH is self-describing (same mechanism as
            // is_trigger_rule_assert), so this holds for inline AND
            // hash-only content modes.
            if is_failure_record_assert(&assert) {
                continue;
            }
            let bytes = match assert.content_bytes() {
                Ok(Some(bytes)) => bytes,
                Ok(None) => {
                    match resolve_direct_read(
                        &self.talk_to_other_slots,
                        partition,
                        &address,
                        &assert.content_hash,
                    ) {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            // Task B (delta-delivery-integrity): a failed or
                            // hash-mismatched direct read must never silently
                            // drop the assert — record it durably so the loss
                            // is one query away, then skip evaluation (we have
                            // no trustworthy bytes to evaluate).
                            push_content_resolution_failure(
                                &mut dispatch_failures,
                                &address,
                                &assert.content_hash,
                                error,
                            );
                            continue;
                        }
                    }
                }
                Err(e) => return Err(format!("trigger-engine: invalid inline delta content: {e}")),
            };

            if is_trigger_rule_assert(&assert) {
                // One malformed rule record must never abort the whole delta —
                // that turns a single bad DATA row into delivered=0 for every
                // other assert in the batch (observed: boot snapshot delivery
                // died on one invalid record, silencing ALL trigger dispatch).
                // Same durable-failure shape as content-resolution failures:
                // record it (one query away), skip it, keep the batch alive.
                match parse_trigger_rule_record(&bytes)? {
                    Some(rule) => rule_updates.push((
                        address,
                        normalize_content_hash(&assert.content_hash),
                        rule,
                    )),
                    None => push_content_resolution_failure(
                        &mut dispatch_failures,
                        &address,
                        &assert.content_hash,
                        "trigger-rule record is invalid (parse failed)".to_string(),
                    ),
                }
                continue;
            }

            pending_assertions.push((address, assert.content_hash, bytes));
        }

        let (changed_rules, replay_observations) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            let mut changed_rules = Vec::new();
            for (address, content_hash, rule) in rule_updates {
                // Rule records participate in the same current-address
                // accounting as ordinary records. Otherwise a rule delivered
                // after one scan can disappear before the next scan without
                // ever becoming a missing-address candidate.
                let changed_rule = state.upsert(address.clone(), rule)?;
                state.note_seen(address.clone(), &content_hash);
                state.clear_current_verification(&address);
                if let Some(changed_rule) = changed_rule {
                    changed_rules.push(changed_rule);
                }
            }
            let replay_observations = if changed_rules.is_empty() {
                Vec::new()
            } else {
                state.observed_mutations()
            };
            (changed_rules, replay_observations)
        };

        self.dispatch_observations_to_rules(
            partition,
            replay_observations,
            changed_rules,
            &mut dispatch_failures,
            &mut dispatch_outcomes,
        );

        let mut pending_retractions = Vec::new();
        for retract_hex in delta.retracts {
            let address = decode_address(&retract_hex)?;
            {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                state.remove(&address);
                state.forget_seen(&address);
            }

            let envelope = envelope_value(partition, &address, None, true);
            pending_retractions.push(ReplayEntry::retracted(address, envelope));
        }

        // Task E bookkeeping: remember what content this slot evaluated so a
        // later gap catch-up re-evaluates ONLY genuinely-unseen content.
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (address, content_hash, _) in &pending_assertions {
                state.note_seen(address.clone(), &normalize_content_hash(content_hash));
            }
        }

        let active_rules = self.active_delta_rules()?;
        let required_change_paths = required_change_paths_for_rules(&active_rules);

        // The live dispatch keeps the just-delivered bytes (no re-read); the
        // replay ring remembers identity only — bytes re-resolve from the
        // durable owner if a late rule ever replays this mutation.
        let pending_assertions = pending_assertions
            .into_iter()
            .map(|(address, content_hash, bytes)| {
                let envelope = envelope_value(partition, &address, Some(&content_hash), false);
                let entry = ReplayEntry::asserted(
                    address,
                    normalize_content_hash(&content_hash),
                    envelope.clone(),
                );
                (entry, ObservedMutation::asserted(bytes, envelope))
            })
            .collect::<Vec<_>>();

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (entry, _) in pending_assertions.iter() {
                state.remember_observation(entry.clone());
            }
            for entry in pending_retractions.iter() {
                state.remember_observation(entry.clone());
            }
        }

        for (_, observation) in pending_assertions {
            let mutation = observation.to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                &mut dispatch_failures,
                &mut dispatch_outcomes,
            );
        }

        for entry in pending_retractions {
            let mutation = entry
                .retraction_observation()
                .to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                &mut dispatch_failures,
                &mut dispatch_outcomes,
            );
        }

        // Task E: the engine told us we MISSED deltas — reconcile against
        // current live state. Runs after this payload's own asserts/retracts
        // so ordering stays causal. Gap-storm coalescing (HARDEN-21): a storm
        // of gap payloads costs at most TWO scans — one immediate (first gap),
        // one deferred residue drain on the first gapless payload (each scan
        // refreshes last_seen, so the residue diff stays cheap). Every gap is
        // still returned observably, scanned-now or coalesced.
        // HARDEN-22c: a parked (fuel-budgeted) scan advances on EVERY payload
        // — before storm logic so progress is monotonic even mid-storm.
        let resumed_scan = self.resume_parked_scan(partition, &mut dispatch_failures);
        if resumed_scan {
            if let Some(gap) = gap {
                if let Ok(mut state) = self.state.lock() {
                    let _ = state.register_gap(gap.from_cursor, gap.to_cursor);
                }
                dispatch_failures.push(json!({
                    "kind": "delivery-gap",
                    "phase": "delta-delivery",
                    "from_cursor": gap.from_cursor,
                    "to_cursor": gap.to_cursor,
                    "coalesced": true,
                }));
            } else if !is_internal_wake {
                if let Ok(mut state) = self.state.lock() {
                    state.note_gapless_payload_while_resuming_scan();
                }
            }
            let wake_revision = self
                .state
                .lock()
                .ok()
                .and_then(|mut state| state.pending_gap_wake_revision());
            if let Some(wake_revision) = wake_revision {
                dispatch_failures.push(json!({
                    "kind": "catch-up-pending",
                    "cursor": 0,
                    "reason": "pending-gap-after-scan-step",
                    "wake_revision": wake_revision,
                }));
            }
        } else {
            match gap {
                Some(gap) => {
                    let scan_now = match self.state.lock() {
                        Ok(mut state) => state.register_gap(gap.from_cursor, gap.to_cursor),
                        Err(_) => None,
                    };
                    if let Some((from_cursor, to_cursor)) = scan_now {
                        self.catch_up_after_gap(
                            partition,
                            slot_protocol::WireDeltaGap {
                                from_cursor,
                                to_cursor,
                            },
                            &mut dispatch_failures,
                        );
                    } else {
                        let residue = self
                            .state
                            .lock()
                            .ok()
                            .and_then(|mut state| state.take_pending_gap_after_wake());
                        if let Some((from_cursor, to_cursor)) = residue {
                            self.catch_up_after_gap(
                                partition,
                                slot_protocol::WireDeltaGap {
                                    from_cursor,
                                    to_cursor,
                                },
                                &mut dispatch_failures,
                            );
                        }
                        dispatch_failures.push(json!({
                            "kind": "delivery-gap",
                            "phase": "delta-delivery",
                            "from_cursor": gap.from_cursor,
                            "to_cursor": gap.to_cursor,
                            "coalesced": true,
                        }));
                    }
                }
                None => {
                    let residue = match self.state.lock() {
                        Ok(mut state) if !is_internal_wake => state.take_pending_gap(),
                        Ok(mut state) => state.take_pending_gap_after_empty_delivery(),
                        Err(_) => None,
                    };
                    if let Some((from_cursor, to_cursor)) = residue {
                        self.catch_up_after_gap(
                            partition,
                            slot_protocol::WireDeltaGap {
                                from_cursor,
                                to_cursor,
                            },
                            &mut dispatch_failures,
                        );
                    }
                }
            }
        }

        let mut failures = Vec::new();
        for effect in dispatch_failures {
            if effect.get("kind").and_then(Value::as_str) == Some("trigger-dispatch-outcome") {
                dispatch_outcomes.push(effect);
            } else {
                failures.push(effect);
            }
        }
        Ok((failures, dispatch_outcomes))
    }

    /// Delivery-gap catch-up (delta-delivery-integrity Task E, native).
    ///
    /// The engine signaled a lost interval. Correctness contract: this is
    /// CURRENT-STATE RECONCILIATION — entries whose live content differs from
    /// what this slot last evaluated are re-evaluated as synthetic asserts.
    /// Missed TRANSIENT states (written and overwritten inside the gap) are
    /// not reconstructible from live state; the response-level `delivery-gap`
    /// notice preserves that loss for the caller without appending CAS exhaust.
    /// Mechanics:
    /// 1. Return the gap notice (never persist it).
    /// 2. Hash-only scan of live state (cheap; no payload bytes).
    /// 3. For entries with a CHANGED hash vs `last_seen`: hash-verified direct
    ///    read (Task B path) → trigger-rule entries re-upsert rule residency;
    ///    other entries evaluate against active rules as synthetic asserts.
    /// 4. First-ever gap only SEEDS the baseline (the boot snapshot covers
    ///    only the rule selector, so "unseen" ≠ "missed" until a baseline
    ///    exists) — the durable record still lands.
    #[cfg(not(target_arch = "wasm32"))]
    fn catch_up_after_gap(
        &self,
        partition: &PartitionKey,
        gap: slot_protocol::WireDeltaGap,
        dispatch_failures: &mut Vec<Value>,
    ) {
        dispatch_failures.push(json!({
            "kind": "delivery-gap",
            "phase": "delta-delivery",
            "from_cursor": gap.from_cursor,
            "to_cursor": gap.to_cursor,
        }));

        let baseline_existed = match self.state.lock() {
            Ok(mut state) => state.begin_scan(),
            Err(_) => return,
        };
        self.scan_live_state_step(
            partition,
            GapScanProgress {
                cursor: 0,
                baseline_existed,
                scanned_total: 0,
                rules_validated: false,
                rule_cursor: 0,
                rule_scanned_total: 0,
                rule_validation_started: false,
                wake_revision: 0,
            },
            dispatch_failures,
        );
    }

    /// One bounded step of the catch-up scan (HARDEN-22c): at most
    /// `GAP_CATCH_UP_PAGES_PER_STEP` pages per handler invocation — fuel-safe.
    /// Parks the cursor when the budget runs out; `resume_parked_scan`
    /// continues on the next payload.
    #[cfg(not(target_arch = "wasm32"))]
    fn scan_live_state_step(
        &self,
        partition: &PartitionKey,
        mut progress: GapScanProgress,
        dispatch_failures: &mut Vec<Value>,
    ) {
        // HARDEN-22: STREAMING per-page diff — each page's changed entries
        // are resolved and dispatched BEFORE the next page is fetched, and
        // the reply drops at loop-bottom. Memory ceiling is O(page), never
        // O(live-state).
        let mut pages_this_step = 0usize;
        let mut changed_page: Vec<(FactAddress, String, bool)> = Vec::new();
        if !progress.rules_validated {
            match self.validate_current_rules_before_recovery_dispatch(
                partition,
                progress.rule_cursor,
                progress.rule_scanned_total,
                progress.rule_validation_started,
                dispatch_failures,
            ) {
                Ok(RuleValidationStep::More {
                    next_cursor,
                    scanned_total,
                }) => {
                    progress.rule_cursor = next_cursor;
                    progress.rule_scanned_total = scanned_total;
                    progress.rule_validation_started = true;
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "rules_validated": false,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
                Ok(RuleValidationStep::Complete { scanned_total }) => {
                    progress.rules_validated = true;
                    progress.rule_cursor = 0;
                    progress.rule_scanned_total = scanned_total;
                    progress.rule_validation_started = false;
                }
                Ok(RuleValidationStep::Truncated { scanned_total }) => {
                    if let Ok(mut state) = self.state.lock() {
                        // Rows beyond the hard ceiling are unknowable in this
                        // recovery. Disable every cached rule not proven
                        // current in the bounded prefix before abandoning.
                        state.complete_rule_validation();
                        state.abandon_scan();
                    }
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-rule-validation-truncated",
                        "scanned": scanned_total,
                    }));
                    return;
                }
                Err(error) => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-rule-validation",
                        "error": error,
                    }));
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "rules_validated": false,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
            }
        }
        loop {
            let request = slot_protocol::ListLiveStateRequest {
                addresses: vec![],
                path_prefix: vec![],
                field_eq: vec![],
                cursor: progress.cursor,
                offset: 0,
                limit: Some(GAP_CATCH_UP_PAGE_LIMIT),
                content: slot_protocol::SubscriptionContentMode::HashOnly,
            };
            let reply = match self.list_live_state_page(partition, &request) {
                Ok(reply) => reply,
                Err(error) => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-scan",
                        "error": error,
                    }));
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
            };
            let remaining_capacity = GAP_CATCH_UP_SCAN_CAP.saturating_sub(progress.scanned_total);
            let page_exceeded_cap = reply.entries.len() > remaining_capacity;
            let entries_to_process = reply.entries.len().min(remaining_capacity);
            progress.scanned_total += entries_to_process;
            changed_page.clear();
            for entry in reply.entries.iter().take(entries_to_process) {
                let Ok(mh) = content_crypto::Multihash::decode(&entry.address) else {
                    continue;
                };
                let address = FactAddress::from_multihash(mh);
                // Byte-level path checks: the storm scan runs over ALL of live
                // state — a String allocation per segment (hex::encode) was
                // the exact allocation pressure that trapped the wasm
                // (hex::BytesToHexChars backtrace, HARDEN-21).
                let is_rule = entry
                    .path
                    .iter()
                    .any(|segment| segment.as_slice() == trigger_rule_path_segment_bytes());
                let is_failure_record = entry
                    .path
                    .iter()
                    .any(|segment| is_failure_record_path_segment_bytes(segment));
                if is_failure_record {
                    continue;
                }
                if let Ok(mut state) = self.state.lock() {
                    state.note_scan_presence(&address);
                } else {
                    return;
                }
                // HOT PATH: no normalize — the live-state reply's
                // content_hash is ALREADY code:hex (engine SSOT), and the
                // fingerprint case-folds, so raw bytes fingerprint identically
                // to the normalized form. normalize_content_hash's per-entry
                // String allocations were the residual trap site (HARDEN-22).
                let hash_changed = match self.state.lock() {
                    Ok(mut state) if !progress.baseline_existed => {
                        state.note_seen(address.clone(), &entry.content_hash);
                        false
                    }
                    Ok(state) => state.content_changed(&address, &entry.content_hash),
                    Err(_) => return,
                };
                if hash_changed {
                    // Normalize only for CHANGED entries (few) — the direct
                    // read's verify compares normalized forms.
                    changed_page.push((
                        address,
                        normalize_content_hash(&entry.content_hash),
                        is_rule,
                    ));
                }
            }
            let next_cursor = reply.next_cursor;
            drop(reply);
            if next_cursor.is_none() {
                // The final page proves every still-missing resident rule was
                // retracted during the gap. Remove those rules before changed
                // records from this same page can evaluate against stale rule
                // state.
                if let Ok(mut state) = self.state.lock() {
                    state.remove_missing_rules_before_dispatch();
                } else {
                    return;
                }
            }
            self.resolve_and_dispatch_changed_page(partition, &mut changed_page, dispatch_failures);
            pages_this_step += 1;
            if page_exceeded_cap
                || (progress.scanned_total == GAP_CATCH_UP_SCAN_CAP && next_cursor.is_some())
            {
                if let Ok(mut state) = self.state.lock() {
                    state.abandon_scan();
                }
                dispatch_failures.push(json!({
                    "kind": "delivery-gap",
                    "phase": "catch-up-truncated",
                    "scanned": progress.scanned_total,
                }));
                break;
            }
            match next_cursor {
                Some(next) if pages_this_step >= GAP_CATCH_UP_PAGES_PER_STEP => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(GapScanProgress {
                            cursor: next,
                            ..progress
                        }),
                        Err(_) => return,
                    };
                    // Fuel-budget park (HARDEN-22c): continue on the next
                    // payload's invocation, never in this one.
                    // HARDEN-23 continuation (Codex-converged, option ii —
                    // durable-record-delta): a parked scan only advances when
                    // ANOTHER payload arrives, so a quiet stream would stall
                    // it forever. Emitting a durable `catch-up-pending` write
                    // guarantees that payload: the record's own delta comes
                    // back around the feed as a FRESH invocation (fresh fuel
                    // — host refuels persistent instances per query) and
                    // `resume_parked_scan` continues from the parked cursor.
                    // The cursor lives IN the content so the engine's
                    // same-content dedup can never suppress the wake. NOT
                    // self-dispatch: a self-dispatch deadlocks on the
                    // persistent instance's state mutex.
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": next,
                        "baseline_existed": progress.baseline_existed,
                        "scanned_total": progress.scanned_total,
                        "rules_validated": parked.rules_validated,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "wake_revision": parked.wake_revision,
                    }));
                    break;
                }
                Some(next) => progress.cursor = next,
                None => {
                    let missing = match self.state.lock() {
                        Ok(mut state) => state.complete_scan(),
                        Err(_) => return,
                    };
                    self.dispatch_missing_retractions(partition, missing, dispatch_failures);
                    break;
                }
            }
        }
    }

    /// Continue a parked catch-up scan, if any (called on EVERY payload).
    #[cfg(not(target_arch = "wasm32"))]
    fn resume_parked_scan(
        &self,
        partition: &PartitionKey,
        dispatch_failures: &mut Vec<Value>,
    ) -> bool {
        let parked = match self.state.lock() {
            Ok(mut state) => state.take_parked_scan(),
            Err(_) => None,
        };
        if let Some(progress) = parked {
            self.scan_live_state_step(partition, progress, dispatch_failures);
            true
        } else {
            false
        }
    }

    /// Resolve + evaluate ONE page's changed entries (hash-verified — Task B
    /// path). Drains `changed_page` so the buffer is reusable across pages.
    #[cfg(not(target_arch = "wasm32"))]
    fn resolve_and_dispatch_changed_page(
        &self,
        partition: &PartitionKey,
        changed_page: &mut Vec<(FactAddress, String, bool)>,
        dispatch_failures: &mut Vec<Value>,
    ) {
        if changed_page.is_empty() {
            return;
        }
        let mut rule_updates = Vec::new();
        let mut synthetic_assertions = Vec::new();
        for (address, content_hash, is_rule) in changed_page.drain(..) {
            let bytes = match resolve_direct_read(
                &self.talk_to_other_slots,
                partition,
                &address,
                &content_hash,
            ) {
                Ok(bytes) => bytes,
                Err(error) => {
                    push_content_resolution_failure(
                        dispatch_failures,
                        &address,
                        &content_hash,
                        error,
                    );
                    continue;
                }
            };
            if is_rule {
                if let Ok(Some(rule)) = parse_trigger_rule_record(&bytes) {
                    if let Ok(mut state) = self.state.lock() {
                        state.note_seen(address.clone(), &content_hash);
                    }
                    rule_updates.push((address, rule));
                }
                continue;
            }
            if let Ok(mut state) = self.state.lock() {
                state.note_seen(address.clone(), &content_hash);
            }
            synthetic_assertions.push((address, content_hash, bytes));
        }

        if let Ok(mut state) = self.state.lock() {
            for (address, rule) in rule_updates {
                let _ = state.upsert(address.clone(), rule);
                state.require_current_verification(&address);
            }
        }

        let Ok(active_rules) = self.active_delta_rules() else {
            return;
        };
        let required_change_paths = required_change_paths_for_rules(&active_rules);
        let mut dispatch_outcomes = Vec::new();
        for (address, content_hash, bytes) in synthetic_assertions {
            let envelope = envelope_value(partition, &address, Some(&content_hash), false);
            if let Ok(mut state) = self.state.lock() {
                state.remember_observation(ReplayEntry::asserted(
                    address.clone(),
                    normalize_content_hash(&content_hash),
                    envelope.clone(),
                ));
            }
            let mutation =
                ObservedMutation::asserted(bytes, envelope).to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                dispatch_failures,
                &mut dispatch_outcomes,
            );
        }
        // Catch-up is driven by the same delta transaction; fold its generic
        // outcomes into the caller's effects so process_delta separates and
        // persists them with ordinary live-dispatch outcomes.
        dispatch_failures.extend(dispatch_outcomes);
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn dispatch_missing_retractions(
        &self,
        partition: &PartitionKey,
        missing: Vec<FactAddress>,
        dispatch_failures: &mut Vec<Value>,
    ) {
        if missing.is_empty() {
            return;
        }
        let Ok(active_rules) = self.active_delta_rules() else {
            return;
        };
        let required_change_paths = required_change_paths_for_rules(&active_rules);
        let mut dispatch_outcomes = Vec::new();
        for address in missing {
            let envelope = envelope_value(partition, &address, None, true);
            let entry = ReplayEntry::retracted(address, envelope);
            if let Ok(mut state) = self.state.lock() {
                state.remember_observation(entry.clone());
            }
            self.dispatch_mutation_to_rules(
                partition,
                entry
                    .retraction_observation()
                    .to_context(&required_change_paths),
                active_rules.clone(),
                dispatch_failures,
                &mut dispatch_outcomes,
            );
        }
        dispatch_failures.extend(dispatch_outcomes);
    }

    /// Establish the complete current rule set before any recovered record
    /// dispatches. Rule rows can occur after changed data in the all-state
    /// pagination order, so page-local eviction is insufficient.
    #[cfg(not(target_arch = "wasm32"))]
    fn validate_current_rules_before_recovery_dispatch(
        &self,
        partition: &PartitionKey,
        cursor: u64,
        scanned_total: usize,
        started: bool,
        dispatch_failures: &mut Vec<Value>,
    ) -> Result<RuleValidationStep, String> {
        if !started {
            self.state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?
                .begin_rule_validation();
        }
        let request = slot_protocol::ListLiveStateRequest {
            addresses: vec![],
            // A trigger-rule marker may occur anywhere in an authored path
            // (for example current-item/published-record/trigger-rule). The
            // live-state API's path_prefix is true starts-with, so validation
            // must scan current state and apply membership locally.
            path_prefix: vec![],
            field_eq: vec![],
            cursor,
            offset: 0,
            limit: Some(RULE_VALIDATION_PAGE_LIMIT),
            content: slot_protocol::SubscriptionContentMode::HashOnly,
        };
        let reply = self.list_live_state_page(partition, &request)?;
        let remaining_capacity = GAP_CATCH_UP_SCAN_CAP.saturating_sub(scanned_total);
        let page_exceeded_cap = reply.entries.len() > remaining_capacity;
        let entries_to_process = reply.entries.len().min(remaining_capacity);
        let next_scanned_total = scanned_total.saturating_add(entries_to_process);
        let mut rows = Vec::new();
        for entry in reply.entries.iter().take(entries_to_process) {
            if !entry
                .path
                .iter()
                .any(|segment| segment.as_slice() == trigger_rule_path_segment_bytes())
            {
                continue;
            }
            let Ok(mh) = content_crypto::Multihash::decode(&entry.address) else {
                continue;
            };
            let address = FactAddress::from_multihash(mh);
            rows.push((address, normalize_content_hash(&entry.content_hash)));
        }

        let mut changed = Vec::new();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (address, content_hash) in rows {
                state.note_rule_validation_presence(&address);
                if state.content_changed(&address, &content_hash) {
                    // Fail closed while the current bytes are verified.
                    state.remove(&address);
                    changed.push((address, content_hash));
                } else {
                    state.note_seen(address.clone(), &content_hash);
                }
            }
        }

        for (address, content_hash) in changed {
            let bytes = match resolve_direct_read(
                &self.talk_to_other_slots,
                partition,
                &address,
                &content_hash,
            ) {
                Ok(bytes) => bytes,
                Err(error) => {
                    push_content_resolution_failure(
                        dispatch_failures,
                        &address,
                        &content_hash,
                        error,
                    );
                    continue;
                }
            };
            match parse_trigger_rule_record(&bytes) {
                Ok(Some(rule)) => {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                    state.upsert(address.clone(), rule)?;
                    state.note_seen(address.clone(), &content_hash);
                    state.require_current_verification(&address);
                }
                Ok(None) | Err(_) => push_content_resolution_failure(
                    dispatch_failures,
                    &address,
                    &content_hash,
                    "trigger-rule record is invalid during recovery validation".to_string(),
                ),
            }
        }
        if page_exceeded_cap
            || (next_scanned_total == GAP_CATCH_UP_SCAN_CAP && reply.next_cursor.is_some())
        {
            return Ok(RuleValidationStep::Truncated {
                scanned_total: next_scanned_total,
            });
        }
        match reply.next_cursor {
            None => {
                self.state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?
                    .complete_rule_validation();
                Ok(RuleValidationStep::Complete {
                    scanned_total: next_scanned_total,
                })
            }
            Some(next_cursor) => Ok(RuleValidationStep::More {
                next_cursor,
                scanned_total: next_scanned_total,
            }),
        }
    }

    /// One page of the engine's current live state over the
    /// talk-to-other-slots boundary (`runtime::live_state`).
    #[cfg(not(target_arch = "wasm32"))]
    fn list_live_state_page(
        &self,
        partition: &PartitionKey,
        request: &slot_protocol::ListLiveStateRequest,
    ) -> Result<slot_protocol::ListLiveStateReply, String> {
        let request_bytes = slot_protocol::encode_list_live_state_request(request)
            .map_err(|e| format!("trigger-engine: live state request encode failed: {e}"))?;
        let envelope = Envelope::dispatch(
            partition.clone(),
            FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS),
            Some(Bytes::from(request_bytes)),
        );
        let reply_bytes = self
            .talk_to_other_slots
            .dispatch(&envelope, slot_protocol::ReplyDelivery::Inline)?;
        slot_protocol::decode_list_live_state_reply(&reply_bytes)
            .map_err(|e| format!("trigger-engine: live state reply decode failed: {e}"))
    }

    /// WASM gap recovery mirrors the native bounded scanner, but every owner
    /// call is awaited. One invocation consumes at most one hash-only page;
    /// continuation is woken by the existing `catch-up-pending` write rather
    /// than looping over live state inside the delta hot path.
    #[cfg(target_arch = "wasm32")]
    async fn catch_up_after_gap_async(
        &self,
        partition: &PartitionKey,
        gap: slot_protocol::WireDeltaGap,
        dispatch_failures: &mut Vec<Value>,
    ) {
        dispatch_failures.push(json!({
            "kind": "delivery-gap",
            "phase": "delta-delivery",
            "from_cursor": gap.from_cursor,
            "to_cursor": gap.to_cursor,
        }));

        let baseline_existed = match self.state.lock() {
            Ok(mut state) => state.begin_scan(),
            Err(_) => return,
        };
        self.scan_live_state_step_async(
            partition,
            GapScanProgress {
                cursor: 0,
                baseline_existed,
                scanned_total: 0,
                rules_validated: false,
                rule_cursor: 0,
                rule_scanned_total: 0,
                rule_validation_started: false,
                wake_revision: 0,
            },
            dispatch_failures,
        )
        .await;
    }

    #[cfg(target_arch = "wasm32")]
    async fn resume_parked_scan_async(
        &self,
        partition: &PartitionKey,
        dispatch_failures: &mut Vec<Value>,
    ) -> bool {
        let parked = match self.state.lock() {
            Ok(mut state) => state.take_parked_scan(),
            Err(_) => None,
        };
        if let Some(progress) = parked {
            self.scan_live_state_step_async(partition, progress, dispatch_failures)
                .await;
            true
        } else {
            false
        }
    }

    #[cfg(target_arch = "wasm32")]
    async fn scan_live_state_step_async(
        &self,
        partition: &PartitionKey,
        mut progress: GapScanProgress,
        dispatch_failures: &mut Vec<Value>,
    ) {
        let mut pages_this_step = 0usize;
        let mut changed_page: Vec<(FactAddress, String, bool)> = Vec::new();
        if !progress.rules_validated {
            match self
                .validate_current_rules_before_recovery_dispatch_async(
                    partition,
                    progress.rule_cursor,
                    progress.rule_scanned_total,
                    progress.rule_validation_started,
                    dispatch_failures,
                )
                .await
            {
                Ok(RuleValidationStep::More {
                    next_cursor,
                    scanned_total,
                }) => {
                    progress.rule_cursor = next_cursor;
                    progress.rule_scanned_total = scanned_total;
                    progress.rule_validation_started = true;
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "rules_validated": false,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
                Ok(RuleValidationStep::Complete { scanned_total }) => {
                    progress.rules_validated = true;
                    progress.rule_cursor = 0;
                    progress.rule_scanned_total = scanned_total;
                    progress.rule_validation_started = false;
                }
                Ok(RuleValidationStep::Truncated { scanned_total }) => {
                    if let Ok(mut state) = self.state.lock() {
                        state.complete_rule_validation();
                        state.abandon_scan();
                    }
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-rule-validation-truncated",
                        "scanned": scanned_total,
                    }));
                    return;
                }
                Err(error) => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-rule-validation",
                        "error": error,
                    }));
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "rules_validated": false,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
            }
        }
        loop {
            let request = slot_protocol::ListLiveStateRequest {
                addresses: vec![],
                path_prefix: vec![],
                field_eq: vec![],
                cursor: progress.cursor,
                offset: 0,
                limit: Some(GAP_CATCH_UP_PAGE_LIMIT),
                content: slot_protocol::SubscriptionContentMode::HashOnly,
            };
            let reply = match self.list_live_state_page_async(partition, &request).await {
                Ok(reply) => reply,
                Err(error) => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(progress),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "delivery-gap",
                        "phase": "catch-up-scan",
                        "error": error,
                    }));
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": parked.cursor,
                        "baseline_existed": parked.baseline_existed,
                        "scanned_total": parked.scanned_total,
                        "wake_revision": parked.wake_revision,
                    }));
                    return;
                }
            };
            let remaining_capacity = GAP_CATCH_UP_SCAN_CAP.saturating_sub(progress.scanned_total);
            let page_exceeded_cap = reply.entries.len() > remaining_capacity;
            let entries_to_process = reply.entries.len().min(remaining_capacity);
            progress.scanned_total += entries_to_process;
            changed_page.clear();
            for entry in reply.entries.iter().take(entries_to_process) {
                let Ok(mh) = content_crypto::Multihash::decode(&entry.address) else {
                    continue;
                };
                let address = FactAddress::from_multihash(mh);
                let is_rule = entry
                    .path
                    .iter()
                    .any(|segment| segment.as_slice() == trigger_rule_path_segment_bytes());
                let is_failure_record = entry
                    .path
                    .iter()
                    .any(|segment| is_failure_record_path_segment_bytes(segment));
                if is_failure_record {
                    continue;
                }
                if let Ok(mut state) = self.state.lock() {
                    state.note_scan_presence(&address);
                } else {
                    return;
                }
                let hash_changed = match self.state.lock() {
                    Ok(mut state) if !progress.baseline_existed => {
                        state.note_seen(address.clone(), &entry.content_hash);
                        false
                    }
                    Ok(state) => state.content_changed(&address, &entry.content_hash),
                    Err(_) => return,
                };
                if hash_changed {
                    changed_page.push((
                        address,
                        normalize_content_hash(&entry.content_hash),
                        is_rule,
                    ));
                }
            }
            let next_cursor = reply.next_cursor;
            drop(reply);
            if next_cursor.is_none() {
                if let Ok(mut state) = self.state.lock() {
                    state.remove_missing_rules_before_dispatch();
                } else {
                    return;
                }
            }
            self.resolve_and_dispatch_changed_page_async(
                partition,
                &mut changed_page,
                dispatch_failures,
            )
            .await;
            pages_this_step += 1;
            if page_exceeded_cap
                || (progress.scanned_total == GAP_CATCH_UP_SCAN_CAP && next_cursor.is_some())
            {
                if let Ok(mut state) = self.state.lock() {
                    state.abandon_scan();
                }
                dispatch_failures.push(json!({
                    "kind": "delivery-gap",
                    "phase": "catch-up-truncated",
                    "scanned": progress.scanned_total,
                }));
                break;
            }
            match next_cursor {
                Some(next) if pages_this_step >= GAP_CATCH_UP_PAGES_PER_STEP => {
                    let parked = match self.state.lock() {
                        Ok(mut state) => state.park_scan_for_wake(GapScanProgress {
                            cursor: next,
                            ..progress
                        }),
                        Err(_) => return,
                    };
                    dispatch_failures.push(json!({
                        "kind": "catch-up-pending",
                        "cursor": next,
                        "baseline_existed": progress.baseline_existed,
                        "scanned_total": progress.scanned_total,
                        "rules_validated": parked.rules_validated,
                        "rule_cursor": parked.rule_cursor,
                        "rule_scanned_total": parked.rule_scanned_total,
                        "wake_revision": parked.wake_revision,
                    }));
                    break;
                }
                Some(next) => progress.cursor = next,
                None => {
                    let missing = match self.state.lock() {
                        Ok(mut state) => state.complete_scan(),
                        Err(_) => return,
                    };
                    self.dispatch_missing_retractions_async(partition, missing, dispatch_failures)
                        .await;
                    break;
                }
            }
        }
    }

    #[cfg(target_arch = "wasm32")]
    async fn resolve_and_dispatch_changed_page_async(
        &self,
        partition: &PartitionKey,
        changed_page: &mut Vec<(FactAddress, String, bool)>,
        dispatch_failures: &mut Vec<Value>,
    ) {
        if changed_page.is_empty() {
            return;
        }
        let mut rule_updates = Vec::new();
        let mut synthetic_assertions = Vec::new();
        for (address, content_hash, is_rule) in changed_page.drain(..) {
            let bytes = match resolve_direct_read(
                &self.talk_to_other_slots,
                partition,
                &address,
                &content_hash,
            )
            .await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    push_content_resolution_failure(
                        dispatch_failures,
                        &address,
                        &content_hash,
                        error,
                    );
                    continue;
                }
            };
            if is_rule {
                if let Ok(Some(rule)) = parse_trigger_rule_record(&bytes) {
                    if let Ok(mut state) = self.state.lock() {
                        state.note_seen(address.clone(), &content_hash);
                    }
                    rule_updates.push((address, rule));
                }
                continue;
            }
            if let Ok(mut state) = self.state.lock() {
                state.note_seen(address.clone(), &content_hash);
            }
            synthetic_assertions.push((address, content_hash, bytes));
        }

        if let Ok(mut state) = self.state.lock() {
            for (address, rule) in rule_updates {
                let _ = state.upsert(address.clone(), rule);
                state.require_current_verification(&address);
            }
        }

        let Ok(active_rules) = self.active_delta_rules() else {
            return;
        };
        let required_change_paths = required_change_paths_for_rules(&active_rules);
        let mut dispatch_outcomes = Vec::new();
        for (address, content_hash, bytes) in synthetic_assertions {
            let envelope = envelope_value(partition, &address, Some(&content_hash), false);
            if let Ok(mut state) = self.state.lock() {
                state.remember_observation(ReplayEntry::asserted(
                    address.clone(),
                    normalize_content_hash(&content_hash),
                    envelope.clone(),
                ));
            }
            let mutation =
                ObservedMutation::asserted(bytes, envelope).to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                dispatch_failures,
                &mut dispatch_outcomes,
            )
            .await;
        }
        dispatch_failures.extend(dispatch_outcomes);
    }

    #[cfg(target_arch = "wasm32")]
    async fn dispatch_missing_retractions_async(
        &self,
        partition: &PartitionKey,
        missing: Vec<FactAddress>,
        dispatch_failures: &mut Vec<Value>,
    ) {
        if missing.is_empty() {
            return;
        }
        let Ok(active_rules) = self.active_delta_rules() else {
            return;
        };
        let required_change_paths = required_change_paths_for_rules(&active_rules);
        let mut dispatch_outcomes = Vec::new();
        for address in missing {
            let envelope = envelope_value(partition, &address, None, true);
            let entry = ReplayEntry::retracted(address, envelope);
            if let Ok(mut state) = self.state.lock() {
                state.remember_observation(entry.clone());
            }
            self.dispatch_mutation_to_rules(
                partition,
                entry
                    .retraction_observation()
                    .to_context(&required_change_paths),
                active_rules.clone(),
                dispatch_failures,
                &mut dispatch_outcomes,
            )
            .await;
        }
        dispatch_failures.extend(dispatch_outcomes);
    }

    #[cfg(target_arch = "wasm32")]
    async fn validate_current_rules_before_recovery_dispatch_async(
        &self,
        partition: &PartitionKey,
        cursor: u64,
        scanned_total: usize,
        started: bool,
        dispatch_failures: &mut Vec<Value>,
    ) -> Result<RuleValidationStep, String> {
        if !started {
            self.state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?
                .begin_rule_validation();
        }
        let request = slot_protocol::ListLiveStateRequest {
            addresses: vec![],
            path_prefix: vec![],
            field_eq: vec![],
            cursor,
            offset: 0,
            limit: Some(RULE_VALIDATION_PAGE_LIMIT),
            content: slot_protocol::SubscriptionContentMode::HashOnly,
        };
        let reply = self.list_live_state_page_async(partition, &request).await?;
        let remaining_capacity = GAP_CATCH_UP_SCAN_CAP.saturating_sub(scanned_total);
        let page_exceeded_cap = reply.entries.len() > remaining_capacity;
        let entries_to_process = reply.entries.len().min(remaining_capacity);
        let next_scanned_total = scanned_total.saturating_add(entries_to_process);
        let mut rows = Vec::new();
        for entry in reply.entries.iter().take(entries_to_process) {
            if !entry
                .path
                .iter()
                .any(|segment| segment.as_slice() == trigger_rule_path_segment_bytes())
            {
                continue;
            }
            let Ok(mh) = content_crypto::Multihash::decode(&entry.address) else {
                continue;
            };
            let address = FactAddress::from_multihash(mh);
            rows.push((address, normalize_content_hash(&entry.content_hash)));
        }

        let mut changed = Vec::new();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (address, content_hash) in rows {
                state.note_rule_validation_presence(&address);
                if state.content_changed(&address, &content_hash) {
                    state.remove(&address);
                    changed.push((address, content_hash));
                } else {
                    state.note_seen(address, &content_hash);
                }
            }
        }

        for (address, content_hash) in changed {
            let bytes = match resolve_direct_read(
                &self.talk_to_other_slots,
                partition,
                &address,
                &content_hash,
            )
            .await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    push_content_resolution_failure(
                        dispatch_failures,
                        &address,
                        &content_hash,
                        error,
                    );
                    continue;
                }
            };
            match parse_trigger_rule_record(&bytes) {
                Ok(Some(rule)) => {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                    state.upsert(address.clone(), rule)?;
                    state.note_seen(address.clone(), &content_hash);
                    state.require_current_verification(&address);
                }
                Ok(None) | Err(_) => push_content_resolution_failure(
                    dispatch_failures,
                    &address,
                    &content_hash,
                    "trigger-rule record is invalid during recovery validation".to_string(),
                ),
            }
        }
        if page_exceeded_cap
            || (next_scanned_total == GAP_CATCH_UP_SCAN_CAP && reply.next_cursor.is_some())
        {
            return Ok(RuleValidationStep::Truncated {
                scanned_total: next_scanned_total,
            });
        }
        match reply.next_cursor {
            None => {
                self.state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?
                    .complete_rule_validation();
                Ok(RuleValidationStep::Complete {
                    scanned_total: next_scanned_total,
                })
            }
            Some(next_cursor) => Ok(RuleValidationStep::More {
                next_cursor,
                scanned_total: next_scanned_total,
            }),
        }
    }

    #[cfg(target_arch = "wasm32")]
    async fn list_live_state_page_async(
        &self,
        partition: &PartitionKey,
        request: &slot_protocol::ListLiveStateRequest,
    ) -> Result<slot_protocol::ListLiveStateReply, String> {
        let request_bytes = slot_protocol::encode_list_live_state_request(request)
            .map_err(|e| format!("trigger-engine: live state request encode failed: {e}"))?;
        let envelope = Envelope::dispatch(
            partition.clone(),
            FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS),
            Some(Bytes::from(request_bytes)),
        );
        let reply_bytes = self
            .talk_to_other_slots
            .dispatch(&envelope, slot_protocol::ReplyDelivery::Inline)
            .await?;
        slot_protocol::decode_list_live_state_reply(&reply_bytes)
            .map_err(|e| format!("trigger-engine: live state reply decode failed: {e}"))
    }

    #[cfg(target_arch = "wasm32")]
    async fn process_delta(
        &self,
        partition: &PartitionKey,
        delta: DeltaPayload,
    ) -> Result<(Vec<Value>, Vec<Value>), String> {
        let mut rule_updates = Vec::new();
        let mut pending_assertions = Vec::new();
        let mut dispatch_failures = Vec::new();
        let mut dispatch_outcomes = Vec::new();
        // Delivery-gap sentinel (delta-delivery-integrity Task E): captured
        // up-front (Copy) — catch-up runs AFTER this payload's own
        // asserts/retracts so ordering stays causal.
        let gap = delta.gap;
        // Keep native and portable recovery identical: an empty continuation
        // cannot prove the gap storm ended.
        let is_internal_wake = delta.retracts.is_empty()
            && (delta.asserts.is_empty()
                && self
                    .state
                    .lock()
                    .map(|state| state.empty_delivery_continues_recovery())
                    .unwrap_or(false)
                || !delta.asserts.is_empty() && delta.asserts.iter().all(is_failure_record_assert));

        for assert in delta.asserts {
            let address = decode_address(&assert.address)?;
            // Recursion guard (category-wide, wasm twin — see the native
            // doc): our own durable failure / continuation records are never
            // rule-evaluated; a `catch-up-pending` wake's only job is
            // arriving.
            if is_failure_record_assert(&assert) {
                continue;
            }
            let bytes = match assert.content_bytes() {
                Ok(Some(bytes)) => bytes,
                Ok(None) => {
                    match resolve_direct_read(
                        &self.talk_to_other_slots,
                        partition,
                        &address,
                        &assert.content_hash,
                    )
                    .await
                    {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            // Task B (delta-delivery-integrity): a failed or
                            // hash-mismatched direct read must never silently
                            // drop the assert — record it durably so the loss
                            // is one query away, then skip evaluation (we have
                            // no trustworthy bytes to evaluate).
                            push_content_resolution_failure(
                                &mut dispatch_failures,
                                &address,
                                &assert.content_hash,
                                error,
                            );
                            continue;
                        }
                    }
                }
                Err(e) => return Err(format!("trigger-engine: invalid inline delta content: {e}")),
            };

            if is_trigger_rule_assert(&assert) {
                // One malformed rule record must never abort the whole delta —
                // that turns a single bad DATA row into delivered=0 for every
                // other assert in the batch (observed: boot snapshot delivery
                // died on one invalid record, silencing ALL trigger dispatch).
                // Same durable-failure shape as content-resolution failures:
                // record it (one query away), skip it, keep the batch alive.
                match parse_trigger_rule_record(&bytes)? {
                    Some(rule) => rule_updates.push((
                        address,
                        normalize_content_hash(&assert.content_hash),
                        rule,
                    )),
                    None => push_content_resolution_failure(
                        &mut dispatch_failures,
                        &address,
                        &assert.content_hash,
                        "trigger-rule record is invalid (parse failed)".to_string(),
                    ),
                }
                continue;
            }

            pending_assertions.push((address, assert.content_hash, bytes));
        }

        let (changed_rules, replay_observations) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            let mut changed_rules = Vec::new();
            for (address, content_hash, rule) in rule_updates {
                let changed_rule = state.upsert(address.clone(), rule)?;
                state.note_seen(address.clone(), &content_hash);
                state.clear_current_verification(&address);
                if let Some(changed_rule) = changed_rule {
                    changed_rules.push(changed_rule);
                }
            }
            let replay_observations = if changed_rules.is_empty() {
                Vec::new()
            } else {
                state.observed_mutations()
            };
            (changed_rules, replay_observations)
        };

        self.dispatch_observations_to_rules(
            partition,
            replay_observations,
            changed_rules,
            &mut dispatch_failures,
            &mut dispatch_outcomes,
        )
        .await;

        let mut pending_retractions = Vec::new();
        for retract_hex in delta.retracts {
            let address = decode_address(&retract_hex)?;
            {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                state.remove(&address);
                state.forget_seen(&address);
            }

            let envelope = envelope_value(partition, &address, None, true);
            pending_retractions.push(ReplayEntry::retracted(address, envelope));
        }

        // Task E bookkeeping: remember what content this slot evaluated so a
        // later gap catch-up re-evaluates ONLY genuinely-unseen content.
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (address, content_hash, _) in &pending_assertions {
                state.note_seen(address.clone(), &normalize_content_hash(content_hash));
            }
        }

        let active_rules = self.active_delta_rules()?;
        let required_change_paths = required_change_paths_for_rules(&active_rules);

        // The live dispatch keeps the just-delivered bytes (no re-read); the
        // replay ring remembers identity only — bytes re-resolve from the
        // durable owner if a late rule ever replays this mutation.
        let pending_assertions = pending_assertions
            .into_iter()
            .map(|(address, content_hash, bytes)| {
                let envelope = envelope_value(partition, &address, Some(&content_hash), false);
                let entry = ReplayEntry::asserted(
                    address,
                    normalize_content_hash(&content_hash),
                    envelope.clone(),
                );
                (entry, ObservedMutation::asserted(bytes, envelope))
            })
            .collect::<Vec<_>>();

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            for (entry, _) in pending_assertions.iter() {
                state.remember_observation(entry.clone());
            }
            for entry in pending_retractions.iter() {
                state.remember_observation(entry.clone());
            }
        }

        for (_, observation) in pending_assertions {
            let mutation = observation.to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                &mut dispatch_failures,
                &mut dispatch_outcomes,
            )
            .await;
        }

        for entry in pending_retractions {
            let mutation = entry
                .retraction_observation()
                .to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                &mut dispatch_failures,
                &mut dispatch_outcomes,
            )
            .await;
        }

        // Task E, WASM: the delivered mutation above commits before recovery
        // work is selected. Gap recovery is bounded to ONE hash-only page per
        // fresh invocation, parks its opaque cursor, and emits the existing
        // `catch-up-pending` current record to wake another fresh invocation.
        // The first-ever gap only seeds the live-state fingerprint baseline;
        // historical records are never mistaken for records missed after the
        // subscriber became current.
        let resumed_scan = self
            .resume_parked_scan_async(partition, &mut dispatch_failures)
            .await;
        if resumed_scan {
            if let Some(gap) = gap {
                if let Ok(mut state) = self.state.lock() {
                    let _ = state.register_gap(gap.from_cursor, gap.to_cursor);
                }
                dispatch_failures.push(json!({
                    "kind": "delivery-gap",
                    "phase": "delta-delivery",
                    "from_cursor": gap.from_cursor,
                    "to_cursor": gap.to_cursor,
                    "coalesced": true,
                }));
            } else if !is_internal_wake {
                if let Ok(mut state) = self.state.lock() {
                    state.note_gapless_payload_while_resuming_scan();
                }
            }
            let wake_revision = self
                .state
                .lock()
                .ok()
                .and_then(|mut state| state.pending_gap_wake_revision());
            if let Some(wake_revision) = wake_revision {
                dispatch_failures.push(json!({
                    "kind": "catch-up-pending",
                    "cursor": 0,
                    "reason": "pending-gap-after-scan-step",
                    "wake_revision": wake_revision,
                }));
            }
        } else {
            match gap {
                Some(gap) => {
                    let scan_now = match self.state.lock() {
                        Ok(mut state) => state.register_gap(gap.from_cursor, gap.to_cursor),
                        Err(_) => None,
                    };
                    if let Some((from_cursor, to_cursor)) = scan_now {
                        self.catch_up_after_gap_async(
                            partition,
                            slot_protocol::WireDeltaGap {
                                from_cursor,
                                to_cursor,
                            },
                            &mut dispatch_failures,
                        )
                        .await;
                    } else {
                        let residue = self
                            .state
                            .lock()
                            .ok()
                            .and_then(|mut state| state.take_pending_gap_after_wake());
                        if let Some((from_cursor, to_cursor)) = residue {
                            self.catch_up_after_gap_async(
                                partition,
                                slot_protocol::WireDeltaGap {
                                    from_cursor,
                                    to_cursor,
                                },
                                &mut dispatch_failures,
                            )
                            .await;
                        }
                        dispatch_failures.push(json!({
                            "kind": "delivery-gap",
                            "phase": "delta-delivery",
                            "from_cursor": gap.from_cursor,
                            "to_cursor": gap.to_cursor,
                            "coalesced": true,
                        }));
                    }
                }
                None => {
                    let residue = match self.state.lock() {
                        Ok(mut state) if !is_internal_wake => state.take_pending_gap(),
                        Ok(mut state) => state.take_pending_gap_after_empty_delivery(),
                        Err(_) => None,
                    };
                    if let Some((from_cursor, to_cursor)) = residue {
                        self.catch_up_after_gap_async(
                            partition,
                            slot_protocol::WireDeltaGap {
                                from_cursor,
                                to_cursor,
                            },
                            &mut dispatch_failures,
                        )
                        .await;
                    }
                }
            }
        }

        let mut failures = Vec::new();
        for effect in dispatch_failures {
            if effect.get("kind").and_then(Value::as_str) == Some("trigger-dispatch-outcome") {
                dispatch_outcomes.push(effect);
            } else {
                failures.push(effect);
            }
        }
        Ok((failures, dispatch_outcomes))
    }

    // Late-rule replay: ring entries carry identity only, so an asserted
    // entry's bytes re-resolve here from the durable owner (the same
    // `resolve_direct_read` seam hash-only deliveries use). Content that was
    // superseded/retracted since observation fails its hash check and is
    // skipped as a content-resolution failure — replaying a stale version
    // would be WRONG, not merely wasteful; the current version arrived (or
    // will arrive) as its own delta. Retractions replay content-free.
    #[cfg(not(target_arch = "wasm32"))]
    fn dispatch_observations_to_rules(
        &self,
        partition: &PartitionKey,
        observations: Vec<ReplayEntry>,
        active_rules: Vec<(FactAddress, std::sync::Arc<StoredTriggerRule>)>,
        dispatch_failures: &mut Vec<Value>,
        dispatch_outcomes: &mut Vec<Value>,
    ) {
        if observations.is_empty() || active_rules.is_empty() {
            return;
        }

        let required_change_paths = required_change_paths_for_rules(&active_rules);
        for entry in observations {
            let observation = match &entry.content_hash {
                None => entry.retraction_observation(),
                Some(content_hash) => {
                    match resolve_direct_read(
                        &self.talk_to_other_slots,
                        partition,
                        &entry.address,
                        content_hash,
                    ) {
                        Ok(bytes) => entry.observation_with_bytes(bytes),
                        Err(error) => {
                            push_content_resolution_failure(
                                dispatch_failures,
                                &entry.address,
                                content_hash,
                                error,
                            );
                            continue;
                        }
                    }
                }
            };
            let mutation = observation.to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                dispatch_failures,
                dispatch_outcomes,
            );
        }
    }

    #[cfg(target_arch = "wasm32")]
    async fn dispatch_observations_to_rules(
        &self,
        partition: &PartitionKey,
        observations: Vec<ReplayEntry>,
        active_rules: Vec<(FactAddress, std::sync::Arc<StoredTriggerRule>)>,
        dispatch_failures: &mut Vec<Value>,
        dispatch_outcomes: &mut Vec<Value>,
    ) {
        if observations.is_empty() || active_rules.is_empty() {
            return;
        }

        let required_change_paths = required_change_paths_for_rules(&active_rules);
        for entry in observations {
            let observation = match &entry.content_hash {
                None => entry.retraction_observation(),
                Some(content_hash) => {
                    match resolve_direct_read(
                        &self.talk_to_other_slots,
                        partition,
                        &entry.address,
                        content_hash,
                    )
                    .await
                    {
                        Ok(bytes) => entry.observation_with_bytes(bytes),
                        Err(error) => {
                            push_content_resolution_failure(
                                dispatch_failures,
                                &entry.address,
                                content_hash,
                                error,
                            );
                            continue;
                        }
                    }
                }
            };
            let mutation = observation.to_context(&required_change_paths);
            self.dispatch_mutation_to_rules(
                partition,
                mutation,
                active_rules.clone(),
                dispatch_failures,
                dispatch_outcomes,
            )
            .await;
        }
    }

    fn active_delta_rules(
        &self,
    ) -> Result<Vec<(FactAddress, std::sync::Arc<StoredTriggerRule>)>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "trigger-engine: state poisoned".to_string())?;
        Ok(state.active_delta_rules())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn verify_recovered_rule_is_current(
        &self,
        partition: &PartitionKey,
        address: &FactAddress,
        stored: &std::sync::Arc<StoredTriggerRule>,
    ) -> Result<(), String> {
        let required = {
            let state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            if !state.is_registered_rule(address, stored) {
                return Err(format!(
                    "trigger-engine: rule snapshot is no longer registered at {address}"
                ));
            }
            state.requires_current_verification(address)
        };
        if !required {
            return Ok(());
        }
        let envelope = Envelope::dispatch(partition.clone(), address.clone(), None);
        let result = self
            .talk_to_other_slots
            .dispatch(&envelope, slot_protocol::ReplyDelivery::Inline)
            .and_then(|bytes| {
                crate::talk_to_other_slots::read_reply_bytes_from_other_slots::read_reply_from_other_slots(
                    &bytes,
                )
            })
            .and_then(|reply| {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                if !state.is_registered_rule(address, stored)
                    || state.content_changed(address, &reply.content_hash)
                {
                    return Err(format!(
                        "trigger-engine: recovered rule is no longer current at {address}"
                    ));
                }
                Ok(())
            });
        if result.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.remove_if_registered(address, stored);
            }
        }
        result
    }

    #[cfg(target_arch = "wasm32")]
    async fn verify_recovered_rule_is_current(
        &self,
        partition: &PartitionKey,
        address: &FactAddress,
        stored: &std::sync::Arc<StoredTriggerRule>,
    ) -> Result<(), String> {
        let required = {
            let state = self
                .state
                .lock()
                .map_err(|_| "trigger-engine: state poisoned".to_string())?;
            if !state.is_registered_rule(address, stored) {
                return Err(format!(
                    "trigger-engine: rule snapshot is no longer registered at {address}"
                ));
            }
            state.requires_current_verification(address)
        };
        if !required {
            return Ok(());
        }
        let envelope = Envelope::dispatch(partition.clone(), address.clone(), None);
        let result = self
            .talk_to_other_slots
            .dispatch(&envelope, slot_protocol::ReplyDelivery::Inline)
            .await
            .and_then(|bytes| {
                crate::talk_to_other_slots::read_reply_bytes_from_other_slots::read_reply_from_other_slots(
                    &bytes,
                )
            })
            .and_then(|reply| {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| "trigger-engine: state poisoned".to_string())?;
                if !state.is_registered_rule(address, stored)
                    || state.content_changed(address, &reply.content_hash)
                {
                    return Err(format!(
                        "trigger-engine: recovered rule is no longer current at {address}"
                    ));
                }
                Ok(())
            });
        if result.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.remove_if_registered(address, stored);
            }
        }
        result
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn dispatch_mutation_to_rules(
        &self,
        partition: &PartitionKey,
        mutation: MutationContext,
        active_rules: Vec<(FactAddress, std::sync::Arc<StoredTriggerRule>)>,
        dispatch_failures: &mut Vec<Value>,
        dispatch_outcomes: &mut Vec<Value>,
    ) {
        for (address, stored) in active_rules {
            let rule = &stored.rule;
            let matched_locally =
                match match_compiled_rule_locally(&stored.match_bindings, &mutation) {
                    Ok(matched) => matched,
                    Err(e) => {
                        push_dispatch_failure(
                            dispatch_failures,
                            "local_match",
                            &address,
                            rule,
                            &mutation,
                            e,
                        );
                        continue;
                    }
                };

            let matched = if matched_locally {
                if let Err(e) = self.verify_recovered_rule_is_current(partition, &address, &stored)
                {
                    push_dispatch_failure(
                        dispatch_failures,
                        "rule_current_verification",
                        &address,
                        rule,
                        &mutation,
                        e,
                    );
                    continue;
                }
                match match_with_optional_evaluator(
                    &self.talk_to_other_slots,
                    partition,
                    rule,
                    &mutation,
                ) {
                    Ok(matched) => matched,
                    Err(e) => {
                        push_dispatch_failure(
                            dispatch_failures,
                            "evaluator",
                            &address,
                            rule,
                            &mutation,
                            e,
                        );
                        continue;
                    }
                }
            } else {
                false
            };

            if matched {
                let max_attempts = rule.dispatch.attempt_limit();
                for attempt in 1..=max_attempts {
                    if let Err(error) =
                        self.verify_recovered_rule_is_current(partition, &address, &stored)
                    {
                        push_dispatch_failure_at_attempt(
                            dispatch_failures,
                            "rule_current_verification",
                            attempt,
                            &address,
                            rule,
                            &mutation,
                            error,
                        );
                        break;
                    }
                    match dispatch_match(&self.talk_to_other_slots, partition, rule, &mutation) {
                        Ok(output) => {
                            push_dispatch_outcome(
                                dispatch_outcomes,
                                rule.dispatch.accepted_status(),
                                attempt,
                                &address,
                                rule,
                                &mutation,
                                Some(output),
                                None,
                            );
                            break;
                        }
                        Err(error) => {
                            if attempt == max_attempts {
                                push_dispatch_failure_at_attempt(
                                    dispatch_failures,
                                    "dispatch",
                                    attempt,
                                    &address,
                                    rule,
                                    &mutation,
                                    error,
                                );
                            } else {
                                push_dispatch_outcome(
                                    dispatch_outcomes,
                                    "failed",
                                    attempt,
                                    &address,
                                    rule,
                                    &mutation,
                                    None,
                                    Some(json!({ "phase": "dispatch", "error": error })),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_arch = "wasm32")]
    async fn dispatch_mutation_to_rules(
        &self,
        partition: &PartitionKey,
        mutation: MutationContext,
        active_rules: Vec<(FactAddress, std::sync::Arc<StoredTriggerRule>)>,
        dispatch_failures: &mut Vec<Value>,
        dispatch_outcomes: &mut Vec<Value>,
    ) {
        // Local (pure) matching runs first and synchronously; only rules that
        // locally match proceed to the awaited evaluator/dispatch stage.
        let mut awaiting = Vec::new();
        for (address, stored) in active_rules {
            match match_compiled_rule_locally(&stored.match_bindings, &mutation) {
                Ok(true) => awaiting.push((address, stored)),
                Ok(false) => {}
                Err(e) => {
                    push_dispatch_failure(
                        dispatch_failures,
                        "local_match",
                        &address,
                        &stored.rule,
                        &mutation,
                        e,
                    );
                }
            }
        }

        // CONCURRENT evaluator + dispatch (concurrent_rule_dispatch): the former
        // sequential loop awaited each matched rule's target workflow to
        // COMPLETION while the single persistent instance's mutex was held —
        // N matched rules × a multi-second target = the whole invocation's
        // latency, and the delta queue backed up behind it until ticks dropped.
        // The host's talk-to-other-slots import is explicitly concurrent
        // ("multiple guest send-request-bytes() calls in-flight simultaneously",
        // wasmtime_runtime_impl.rs HostWithStore), so in-flight rule dispatches
        // overlap: wall-clock = the SLOWEST target, not the sum. Failures are
        // collected per-rule and recorded after the join — same durable
        // dispatch-failure contract as before, nothing is silently dropped.
        let results = futures::future::join_all(awaiting.into_iter().map(|(address, stored)| {
            let mutation_ref = &mutation;
            async move {
                let rule = &stored.rule;
                if let Err(e) = self
                    .verify_recovered_rule_is_current(partition, &address, &stored)
                    .await
                {
                    return vec![(
                        address,
                        stored.clone(),
                        "rule_current_verification",
                        1,
                        None,
                        Some(e),
                    )];
                }
                let matched = match match_with_optional_evaluator(
                    &self.talk_to_other_slots,
                    partition,
                    rule,
                    mutation_ref,
                )
                .await
                {
                    Ok(matched) => matched,
                    Err(e) => {
                        return vec![(address, stored.clone(), "evaluator", 1, None, Some(e))];
                    }
                };
                if !matched {
                    return Vec::new();
                }
                let max_attempts = rule.dispatch.attempt_limit();
                let mut attempts = Vec::new();
                for attempt in 1..=max_attempts {
                    if let Err(error) = self
                        .verify_recovered_rule_is_current(partition, &address, &stored)
                        .await
                    {
                        attempts.push((
                            address.clone(),
                            stored.clone(),
                            "rule_current_verification",
                            attempt,
                            None,
                            Some(error),
                        ));
                        break;
                    }
                    match dispatch_match(&self.talk_to_other_slots, partition, rule, mutation_ref)
                        .await
                    {
                        Ok(output) => {
                            attempts.push((
                                address.clone(),
                                stored.clone(),
                                stored.rule.dispatch.accepted_status(),
                                attempt,
                                Some(output),
                                None,
                            ));
                            break;
                        }
                        Err(error) => attempts.push((
                            address.clone(),
                            stored.clone(),
                            "dispatch",
                            attempt,
                            None,
                            Some(error),
                        )),
                    }
                }
                attempts
            }
        }))
        .await;

        for attempt in results.into_iter().flatten() {
            let (address, stored, phase, attempt_number, output, error) = attempt;
            if phase == "succeeded" || phase == "accepted" {
                push_dispatch_outcome(
                    dispatch_outcomes,
                    stored.rule.dispatch.accepted_status(),
                    attempt_number,
                    &address,
                    &stored.rule,
                    &mutation,
                    output,
                    None,
                );
            } else {
                let error = error
                    .unwrap_or_else(|| "target dispatch failed without error text".to_string());
                if phase == "dispatch" && attempt_number < stored.rule.dispatch.attempt_limit() {
                    push_dispatch_outcome(
                        dispatch_outcomes,
                        "failed",
                        attempt_number,
                        &address,
                        &stored.rule,
                        &mutation,
                        None,
                        Some(json!({ "phase": phase, "error": error })),
                    );
                } else {
                    push_dispatch_failure_at_attempt(
                        dispatch_failures,
                        phase,
                        attempt_number,
                        &address,
                        &stored.rule,
                        &mutation,
                        error,
                    );
                }
            }
        }
    }
}

fn required_change_paths_for_rules(
    rules: &[(FactAddress, std::sync::Arc<StoredTriggerRule>)],
) -> Vec<String> {
    let mut required_change_paths = rules
        .iter()
        .flat_map(|(_, stored)| match_change_paths(&stored.match_bindings))
        .collect::<Vec<_>>();
    required_change_paths.sort();
    required_change_paths.dedup();
    required_change_paths
}

/// Task B (delta-delivery-integrity): a delta assert whose content could not be
/// trustworthily resolved (direct-read failure, decode failure, or asserted-vs-
/// current hash mismatch) becomes a durable record instead of a silent skip.
/// Same self-bounding shape as dispatch failures: last failure per ADDRESS —
/// diagnosis is one query (`find-current-items in:'content-resolution-failure'`).
fn push_content_resolution_failure(
    failures: &mut Vec<Value>,
    address: &FactAddress,
    asserted_content_hash: &str,
    error: String,
) {
    failures.push(json!({
        "kind": "content-resolution-failure",
        "phase": "content-resolution",
        "address": address.to_string(),
        "asserted_content_hash": asserted_content_hash,
        "error": error,
    }));
}

fn push_dispatch_failure(
    failures: &mut Vec<Value>,
    phase: &str,
    address: &FactAddress,
    rule: &TriggerRule,
    mutation: &MutationContext,
    error: String,
) {
    push_dispatch_failure_at_attempt(failures, phase, 1, address, rule, mutation, error);
}

fn push_dispatch_failure_at_attempt(
    failures: &mut Vec<Value>,
    phase: &str,
    attempt: u8,
    address: &FactAddress,
    rule: &TriggerRule,
    mutation: &MutationContext,
    error: String,
) {
    let mut outcome = Vec::new();
    push_dispatch_outcome(
        &mut outcome,
        "failed",
        attempt,
        address,
        rule,
        mutation,
        None,
        Some(json!({ "phase": phase, "error": error })),
    );
    // Failed attempts need a durable outcome too. Preserve it as a tagged
    // failure record until the caller splits generic outcomes from diagnostics.
    failures.extend(outcome);
    let mut failure = json!({
        "kind": "workflow-dispatch-failure",
        "phase": phase,
        "rule_address": address.to_string(),
        "rule_id": rule.id,
        "target": rule.dispatch.target,
        "envelope": mutation.envelope.clone(),
        "error": error,
    });
    // Carry the triggering change's own kind so the write conversion can
    // refuse to record a failure ABOUT a failure record (recursion guard —
    // the failure write's address is a blake3 hash, so the envelope alone
    // cannot identify it when its delta comes back around). change_for_match
    // holds only rule-projected paths, so probe the retained raw bytes: a
    // failure record payload is small by construction, and oversized/absent
    // content cannot be a failure record anyway.
    if let Some(change_kind) = mutation.retained_change_kind() {
        failure["change_kind"] = json!(change_kind);
    }
    // When the rule dispatches a workflow definition, name it — the exact
    // discriminator the poisoned-registration hunts always needed.
    if let Some(definition_id) = rule
        .dispatch
        .output_template
        .get("definition_id")
        .and_then(Value::as_str)
    {
        failure["definition_id"] = json!(definition_id);
    }
    failures.push(failure);
}

/// One generic, durable observation for every rule dispatch attempt. The
/// correlation value remains opaque DATA supplied by the rule; this package
/// only preserves it alongside the triggering envelope and rendered request.
#[allow(clippy::too_many_arguments)]
fn push_dispatch_outcome(
    outcomes: &mut Vec<Value>,
    status: &str,
    attempt: u8,
    address: &FactAddress,
    rule: &TriggerRule,
    mutation: &MutationContext,
    dispatch: Option<DispatchResult>,
    failure: Option<Value>,
) {
    let correlation = rule
        .dispatch
        .outcome_correlation_template
        .as_ref()
        .and_then(|template| resolve_template_value_for_mutation(template, mutation, None).ok());
    outcomes.push(json!({
        "kind": "trigger-dispatch-outcome",
        "status": status,
        "attempt": attempt,
        "attempt_ref": mutation.envelope.get("content_hash").cloned().unwrap_or(Value::Null),
        "rule_address": address.to_string(),
        "rule_id": rule.id,
        "target": rule.dispatch.target,
        "correlation": correlation,
        "envelope": mutation.envelope.clone(),
        "dispatch": dispatch.as_ref().map(|result| &result.input),
        "delivery_receipt": dispatch.as_ref().and_then(|result| result.receipt.as_ref()),
        "failure": failure,
    }));
}

/// Convert reported dispatch failures into durable current-item writes.
///
/// Address grammar: one deterministic address per (definition id | rule id)
/// discriminator — `trigger-engine.dispatch-failure::<discriminator>` at path
/// `['current-item','workflow-dispatch-failure']`. Current-item semantics make
/// this last-failure-per-discriminator: bounded by the number of defs/rules,
/// never by failure volume. Recursion guard: an envelope whose own address is
/// already a dispatch-failure record produces NO write (a failure writing a
/// failure would loop through the delta feed).
fn dispatch_failure_writes(partition: &PartitionKey, failures: &[Value]) -> Vec<WriteEntry> {
    let mut writes = Vec::new();
    for failure in failures {
        // Delivery gaps remain response-level observability only. Current-state
        // reconciliation—not a receipt—is the correctness mechanism, and every
        // distinct gap payload appended another immutable CAS version at the
        // same current-item address. Do not publish operational loss notices
        // into the store whose loss they describe.
        if failure.get("kind").and_then(Value::as_str) == Some("delivery-gap") {
            continue;
        }
        // A parked scan asks the subscription caller for a fresh invocation
        // through `subscription_continuation` in its response. Persisting a
        // wake into the subscribed store fed that write back as a delivery
        // gap and restarted the entire scan forever.
        if failure.get("kind").and_then(Value::as_str) == Some("catch-up-pending") {
            continue;
        }
        // Task B: content-resolution failures are their own record family —
        // keyed by ADDRESS (there is no rule/def yet; resolution failed before
        // evaluation). Same last-failure-per-discriminator self-bounding.
        if failure.get("kind").and_then(Value::as_str) == Some("content-resolution-failure") {
            let address_text = failure
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            // Recursion guard note: `address` here is the fact address's
            // code:hex multihash (opaque), so string-prefix checks cannot
            // identify our own failure records. The real guard is path-based
            // (`is_failure_record_assert`) at the resolution call sites,
            // BEFORE the failure is ever pushed.
            let Ok(payload) = serde_json::to_vec(failure) else {
                continue; // a failure we cannot serialize must not kill the batch
            };
            writes.push(WriteEntry {
                partition: partition.clone(),
                address: FactAddress::hash_from(&format!(
                    "trigger-engine.content-resolution-failure::{address_text}"
                )),
                payload: Some(payload),
                path: vec![
                    PathSegment::hash_from("current-item"),
                    PathSegment::hash_from("content-resolution-failure"),
                ],
                expected_current: None,
            });
            continue;
        }
        let envelope_address_text = failure
            .get("envelope")
            .and_then(|envelope| envelope.get("address_text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let change_kind = failure
            .get("change_kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        if envelope_address_text.starts_with("trigger-engine.dispatch-failure::")
            || change_kind == "workflow-dispatch-failure"
        {
            continue; // recursion guard: never record a failure about a failure
        }
        let discriminator = failure
            .get("definition_id")
            .and_then(Value::as_str)
            .or_else(|| failure.get("rule_id").and_then(Value::as_str))
            .unwrap_or("unknown");
        let Ok(payload) = serde_json::to_vec(failure) else {
            continue; // a failure we cannot serialize must not kill the batch
        };
        writes.push(WriteEntry {
            partition: partition.clone(),
            address: FactAddress::hash_from(&format!(
                "trigger-engine.dispatch-failure::{discriminator}"
            )),
            payload: Some(payload),
            path: vec![
                PathSegment::hash_from("current-item"),
                PathSegment::hash_from("workflow-dispatch-failure"),
            ],
            expected_current: None,
        });
    }
    writes
}

/// Durable, generic terminal evidence for a dispatch attempt. One address per
/// rule/mutation/status makes re-delivery idempotent while preserving both the
/// successful and failed facts; consumers correlate only through their rule
/// DATA, never through package-specific fields in this owner.
fn dispatch_outcome_writes(partition: &PartitionKey, outcomes: &[Value]) -> Vec<WriteEntry> {
    outcomes
        .iter()
        .filter_map(|outcome| {
            let rule = outcome.get("rule_id").and_then(Value::as_str)?;
            let attempt = outcome.get("attempt_ref").and_then(Value::as_str)?;
            let status = outcome.get("status").and_then(Value::as_str)?;
            let attempt_number = outcome.get("attempt").and_then(Value::as_u64)?;
            let payload = serde_json::to_vec(outcome).ok()?;
            Some(WriteEntry {
                partition: partition.clone(),
                address: FactAddress::hash_from(&format!(
                    "trigger-engine.dispatch-outcome::{rule}::{attempt}::{attempt_number}::{status}"
                )),
                payload: Some(payload),
                path: vec![
                    PathSegment::hash_from("current-item"),
                    PathSegment::hash_from("trigger-dispatch-outcome"),
                ],
                expected_current: None,
            })
        })
        .collect()
}

fn decode_address(hex_str: &str) -> Result<FactAddress, String> {
    let bytes =
        hex::decode(hex_str).map_err(|e| format!("trigger-engine: address not hex: {e}"))?;
    let mh = content_crypto::Multihash::decode(&bytes)
        .map_err(|e| format!("trigger-engine: invalid multihash: {e}"))?;
    Ok(FactAddress::from_multihash(mh))
}

fn is_trigger_rule_assert(assert: &slot_protocol::WireAssert) -> bool {
    assert
        .path
        .iter()
        .any(|segment| segment == trigger_rule_path_segment_wire_hex())
}

/// True when the assert IS one of our own durable failure records.
///
/// Recognition is by PATH segment — the same self-describing mechanism as
/// `is_trigger_rule_assert`. The write side stamps failure records at
/// `['current-item','workflow-dispatch-failure']` /
/// `['current-item','content-resolution-failure']` /
/// `['current-item','delivery-gap']` /
/// `['current-item','catch-up-pending']`, and their addresses are blake3
/// hashes, so the payload/path is the only trustworthy identity when the
/// delta comes back around the feed. Note: a `catch-up-pending` delta is not
/// EVALUATED (it is our own record), but its ARRIVAL is exactly the wake the
/// continuation needs — `resume_parked_scan` runs on every payload before
/// this guard is consulted.
fn is_failure_record_assert(assert: &slot_protocol::WireAssert) -> bool {
    assert
        .path
        .iter()
        .any(|segment| is_failure_record_path_segment_wire_hex(segment))
}

/// True when a wire-hex path segment marks one of our durable failure-record
/// families (shared by the delta recursion guard AND the gap catch-up scan).
fn is_failure_record_path_segment_wire_hex(segment_wire_hex: &str) -> bool {
    segment_wire_hex == workflow_dispatch_failure_path_segment_wire_hex()
        || segment_wire_hex == content_resolution_failure_path_segment_wire_hex()
        || segment_wire_hex == delivery_gap_path_segment_wire_hex()
        || segment_wire_hex == catch_up_pending_path_segment_wire_hex()
        || segment_wire_hex == trigger_dispatch_outcome_path_segment_wire_hex()
}

fn trigger_dispatch_outcome_path_segment_wire_hex() -> &'static str {
    static SEGMENT: OnceLock<String> = OnceLock::new();
    SEGMENT
        .get_or_init(|| PathSegment::hash_from("trigger-dispatch-outcome").to_wire_hex())
        .as_str()
}

fn workflow_dispatch_failure_path_segment_wire_hex() -> &'static str {
    static SEGMENT: OnceLock<String> = OnceLock::new();
    SEGMENT
        .get_or_init(|| PathSegment::hash_from("workflow-dispatch-failure").to_wire_hex())
        .as_str()
}

fn content_resolution_failure_path_segment_wire_hex() -> &'static str {
    static SEGMENT: OnceLock<String> = OnceLock::new();
    SEGMENT
        .get_or_init(|| PathSegment::hash_from("content-resolution-failure").to_wire_hex())
        .as_str()
}

fn delivery_gap_path_segment_wire_hex() -> &'static str {
    static SEGMENT: OnceLock<String> = OnceLock::new();
    SEGMENT
        .get_or_init(|| PathSegment::hash_from("delivery-gap").to_wire_hex())
        .as_str()
}

fn catch_up_pending_path_segment_wire_hex() -> &'static str {
    static SEGMENT: OnceLock<String> = OnceLock::new();
    SEGMENT
        .get_or_init(|| PathSegment::hash_from("catch-up-pending").to_wire_hex())
        .as_str()
}

/// Raw wire BYTES of the trigger-rule path segment — the gap catch-up scan
/// compares live-state path segments without allocating per entry.
fn trigger_rule_path_segment_bytes() -> &'static [u8] {
    static SEGMENT: OnceLock<Vec<u8>> = OnceLock::new();
    SEGMENT
        .get_or_init(|| {
            PathSegment::hash_from("trigger-rule")
                .as_multihash()
                .encode()
        })
        .as_slice()
}

/// Byte-level twin of `is_failure_record_path_segment_wire_hex` for the
/// allocation-free scan path.
fn is_failure_record_path_segment_bytes(segment: &[u8]) -> bool {
    fn stamp(name: &'static str, cell: &'static OnceLock<Vec<u8>>) -> &'static [u8] {
        cell.get_or_init(|| PathSegment::hash_from(name).as_multihash().encode())
            .as_slice()
    }
    static WORKFLOW: OnceLock<Vec<u8>> = OnceLock::new();
    static CONTENT: OnceLock<Vec<u8>> = OnceLock::new();
    static GAP: OnceLock<Vec<u8>> = OnceLock::new();
    static PENDING: OnceLock<Vec<u8>> = OnceLock::new();
    static OUTCOME: OnceLock<Vec<u8>> = OnceLock::new();
    segment == stamp("workflow-dispatch-failure", &WORKFLOW)
        || segment == stamp("content-resolution-failure", &CONTENT)
        || segment == stamp("delivery-gap", &GAP)
        || segment == stamp("catch-up-pending", &PENDING)
        || segment == stamp("trigger-dispatch-outcome", &OUTCOME)
}

fn trigger_rule_path_segment_wire_hex() -> &'static str {
    static TRIGGER_RULE_PATH_SEGMENT_WIRE_HEX: OnceLock<String> = OnceLock::new();
    TRIGGER_RULE_PATH_SEGMENT_WIRE_HEX
        .get_or_init(|| PathSegment::hash_from("trigger-rule").to_wire_hex())
        .as_str()
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex as StdMutex};

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use bytes::Bytes;
    use serde_json::{json, Value};
    use slot_protocol::ReplyDelivery;
    use slot_protocol::{encode_direct_read_reply, DirectReadReply};

    use super::super::rule_record::RuleDispatchDelivery;
    use super::*;
    use crate::slot_work::match_rules::envelope_value;

    /// Replies served in order for one address.
    type DispatchSequence = std::collections::VecDeque<Result<Vec<u8>, String>>;
    /// A current rule: content hash, wire-hex path, payload bytes.
    type CurrentRule = (String, Vec<String>, Vec<u8>);

    #[derive(Default)]
    struct MockTalkToOtherSlots {
        responses: StdMutex<HashMap<FactAddress, Vec<u8>>>,
        /// Raw pre-encoded reply bytes served in order per address (e.g. the
        /// live-state scan replies for gap catch-up tests). Checked FIRST.
        raw_sequences: StdMutex<HashMap<FactAddress, std::collections::VecDeque<Vec<u8>>>>,
        dispatch_sequences: StdMutex<HashMap<FactAddress, DispatchSequence>>,
        current_rules: StdMutex<HashMap<FactAddress, CurrentRule>>,
        remove_rule_after_direct_read: StdMutex<HashSet<FactAddress>>,
        sent: StdMutex<Vec<(FactAddress, Value)>>,
        queried: StdMutex<Vec<FactAddress>>,
        deliveries: StdMutex<Vec<(FactAddress, ReplyDelivery)>>,
    }

    impl MockTalkToOtherSlots {
        fn insert_response(&self, address: &str, payload: Value) {
            self.responses.lock().unwrap().insert(
                FactAddress::hash_from(address),
                serde_json::to_vec(&payload).unwrap(),
            );
        }

        fn insert_response_at(&self, address: FactAddress, payload: Value) {
            self.responses
                .lock()
                .unwrap()
                .insert(address, serde_json::to_vec(&payload).unwrap());
        }

        fn insert_raw_sequence(&self, address: FactAddress, replies: Vec<Vec<u8>>) {
            self.raw_sequences
                .lock()
                .unwrap()
                .insert(address, replies.into());
        }

        fn insert_dispatch_sequence(&self, address: &str, replies: Vec<Result<Value, String>>) {
            self.dispatch_sequences.lock().unwrap().insert(
                FactAddress::hash_from(address),
                replies
                    .into_iter()
                    .map(|reply| {
                        reply
                            .and_then(|value| serde_json::to_vec(&value).map_err(|e| e.to_string()))
                    })
                    .collect(),
            );
        }

        fn remove_current_rule(&self, address: &FactAddress) {
            self.current_rules.lock().unwrap().remove(address);
        }

        fn remove_current_rule_after_next_read(&self, address: FactAddress) {
            self.remove_rule_after_direct_read
                .lock()
                .unwrap()
                .insert(address);
        }

        fn rule_validation_reply(&self, envelope: &Envelope) -> Option<Result<Vec<u8>, String>> {
            if envelope.address != FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS) {
                return None;
            }
            let request = envelope
                .payload
                .as_deref()
                .and_then(|bytes| slot_protocol::decode_list_live_state_request(bytes).ok())?;
            // Native recovery data pages use 512 rows; the separate bounded
            // rule-validation phase scans all current rows 16 at a time and
            // filters trigger-rule membership locally.
            if !request.path_prefix.is_empty() || request.limit != Some(RULE_VALIDATION_PAGE_LIMIT)
            {
                return None;
            }
            let current_rules = self.current_rules.lock().unwrap();
            let mut all = current_rules
                .iter()
                .map(|(address, (hash, path, _))| (address.clone(), hash.clone(), path.clone()))
                .collect::<Vec<_>>();
            drop(current_rules);
            all.sort_by_key(|(address, _, _)| address.to_string());
            let start = usize::try_from(request.cursor)
                .unwrap_or(usize::MAX)
                .min(all.len());
            let limit = request.limit.unwrap_or(u32::MAX) as usize;
            let end = start.saturating_add(limit).min(all.len());
            let entries = all[start..end]
                .iter()
                .map(|(address, hash, path)| (address.clone(), hash.as_str(), path.clone()))
                .collect();
            let next = (end < all.len()).then_some(end as u64);
            let reply = live_state_reply(entries, next);
            Some(Ok(reply))
        }
    }

    impl TalkToOtherSlots for MockTalkToOtherSlots {
        fn dispatch(
            &self,
            envelope: &Envelope,
            delivery: ReplyDelivery,
        ) -> Result<Vec<u8>, String> {
            if let Some(reply) = self.rule_validation_reply(envelope) {
                return reply;
            }
            self.queried.lock().unwrap().push(envelope.address.clone());
            self.deliveries
                .lock()
                .unwrap()
                .push((envelope.address.clone(), delivery));
            if let Some(payload) = &envelope.payload {
                if let Ok(value) = serde_json::from_slice::<Value>(payload) {
                    self.sent
                        .lock()
                        .unwrap()
                        .push((envelope.address.clone(), value));
                }
            }

            if let Some(sequence) = self
                .raw_sequences
                .lock()
                .unwrap()
                .get_mut(&envelope.address)
            {
                if let Some(reply) = sequence.pop_front() {
                    return Ok(reply);
                }
            }

            if envelope.payload.is_some() {
                if let Some(sequence) = self
                    .dispatch_sequences
                    .lock()
                    .unwrap()
                    .get_mut(&envelope.address)
                {
                    if let Some(reply) = sequence.pop_front() {
                        return reply;
                    }
                }
            }

            if envelope.payload.is_none() {
                let current_rule = self
                    .current_rules
                    .lock()
                    .unwrap()
                    .get(&envelope.address)
                    .cloned();
                if let Some((content_hash, _, payload)) = current_rule {
                    let reply = encode_direct_read_reply(&DirectReadReply {
                        content_hash,
                        payload,
                    })
                    .map_err(|e| e.to_string())?;
                    if self
                        .remove_rule_after_direct_read
                        .lock()
                        .unwrap()
                        .remove(&envelope.address)
                    {
                        self.current_rules.lock().unwrap().remove(&envelope.address);
                    }
                    return Ok(reply);
                }
            }

            let response = self
                .responses
                .lock()
                .unwrap()
                .get(&envelope.address)
                .cloned()
                .ok_or_else(|| "address not found".to_string())?;

            if envelope.payload.is_none() {
                return encode_direct_read_reply(&DirectReadReply {
                    content_hash: "test-content-hash".to_string(),
                    payload: response,
                })
                .map_err(|e| e.to_string());
            }

            Ok(response)
        }
    }

    impl TalkToOtherSlots for Arc<MockTalkToOtherSlots> {
        fn dispatch(
            &self,
            envelope: &Envelope,
            delivery: ReplyDelivery,
        ) -> Result<Vec<u8>, String> {
            if let Some(reply) = self.rule_validation_reply(envelope) {
                return reply;
            }
            self.queried.lock().unwrap().push(envelope.address.clone());
            self.deliveries
                .lock()
                .unwrap()
                .push((envelope.address.clone(), delivery));
            if let Some(payload) = &envelope.payload {
                if let Ok(value) = serde_json::from_slice::<Value>(payload) {
                    self.sent
                        .lock()
                        .unwrap()
                        .push((envelope.address.clone(), value));
                }
            }

            if let Some(sequence) = self
                .raw_sequences
                .lock()
                .unwrap()
                .get_mut(&envelope.address)
            {
                if let Some(reply) = sequence.pop_front() {
                    return Ok(reply);
                }
            }

            if envelope.payload.is_some() {
                if let Some(sequence) = self
                    .dispatch_sequences
                    .lock()
                    .unwrap()
                    .get_mut(&envelope.address)
                {
                    if let Some(reply) = sequence.pop_front() {
                        return reply;
                    }
                }
            }

            if envelope.payload.is_none() {
                let current_rule = self
                    .current_rules
                    .lock()
                    .unwrap()
                    .get(&envelope.address)
                    .cloned();
                if let Some((content_hash, _, payload)) = current_rule {
                    let reply = encode_direct_read_reply(&DirectReadReply {
                        content_hash,
                        payload,
                    })
                    .map_err(|e| e.to_string())?;
                    if self
                        .remove_rule_after_direct_read
                        .lock()
                        .unwrap()
                        .remove(&envelope.address)
                    {
                        self.current_rules.lock().unwrap().remove(&envelope.address);
                    }
                    return Ok(reply);
                }
            }

            let response = self
                .responses
                .lock()
                .unwrap()
                .get(&envelope.address)
                .cloned()
                .ok_or_else(|| "address not found".to_string())?;

            if envelope.payload.is_none() {
                return encode_direct_read_reply(&DirectReadReply {
                    content_hash: "test-content-hash".to_string(),
                    payload: response,
                })
                .map_err(|e| e.to_string());
            }

            Ok(response)
        }
    }

    fn delta_for(address: &FactAddress, content: &Value) -> DeltaPayload {
        DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![slot_protocol::WireAssert {
                address: hex::encode(address.as_multihash().encode()),
                content_hash: "hash:test".to_string(),
                path: Vec::new(),
                content: Some(STANDARD.encode(serde_json::to_vec(content).unwrap())),
            }],
            retracts: vec![],
            gap: None,
        }
    }

    fn rule_assert(address: &FactAddress, rule: &TriggerRule) -> slot_protocol::WireAssert {
        slot_protocol::WireAssert {
            address: hex::encode(address.as_multihash().encode()),
            content_hash: "hash:rule".to_string(),
            path: trigger_rule_path(),
            content: Some(STANDARD.encode(serde_json::to_vec(rule).unwrap())),
        }
    }

    fn hash_only_assert(address: &FactAddress, content_hash: &str) -> slot_protocol::WireAssert {
        slot_protocol::WireAssert {
            address: hex::encode(address.as_multihash().encode()),
            content_hash: content_hash.to_string(),
            path: Vec::new(),
            content: None,
        }
    }

    fn hash_only_rule_assert(
        address: &FactAddress,
        content_hash: &str,
    ) -> slot_protocol::WireAssert {
        slot_protocol::WireAssert {
            address: hex::encode(address.as_multihash().encode()),
            content_hash: content_hash.to_string(),
            path: trigger_rule_path(),
            content: None,
        }
    }

    fn runtime_loaded_rule(id: &str, target: &str, payload_id: &str) -> TriggerRule {
        serde_json::from_value(json!({
            "id": id,
            "topic": "runtime_loaded",
            "match_condition": {
                "conditions": [{
                    "$bind": {
                        "select": { "from": "change", "path": "properties.event_type" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "runtime_loaded" } }]
                    }
                }]
            },
            "dispatch": {
                "target": target,
                "output_template": {
                    "operation": "sample-operation",
                    "payload_id": payload_id
                }
            }
        }))
        .unwrap()
    }

    fn runtime_loaded_delta(address: &FactAddress) -> DeltaPayload {
        delta_for(
            address,
            &json!({
                "properties": {
                    "event_type": "runtime_loaded"
                }
            }),
        )
    }

    fn trigger_rule_path() -> Vec<String> {
        vec![
            PathSegment::hash_from("current-item").to_wire_hex(),
            PathSegment::hash_from("published-record").to_wire_hex(),
            trigger_rule_path_segment_wire_hex().to_string(),
        ]
    }

    #[test]
    fn boot_loads_direct_rule_records_and_dispatches_template() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "rule:copy-field",
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "change", "path": "sample_kind" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "selected-kind" } }]
            },
            "dispatch": {
                "target": "slot::target-alpha",
                "output_template": {
                    "copied_value": {
                        "$kind": "binding",
                        "select": { "from": "change", "path": "sample_value" }
                    }
                }
            }
        }))
        .unwrap();
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));

        let sample_address = FactAddress::hash_from("sample-record-alpha");
        let mut delta = delta_for(
            &sample_address,
            &json!({
                "sample_kind": "selected-kind",
                "sample_value": "selected-output"
            }),
        );
        delta.asserts.insert(
            0,
            rule_assert(&FactAddress::hash_from("rule:copy-field"), &rule),
        );
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        handler
            .handle(&envelope)
            .expect("trigger handling should succeed");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent.iter().any(|(address, payload)| {
            *address == FactAddress::hash_from("slot::target-alpha")
                && payload.get("copied_value") == Some(&json!("selected-output"))
        }));
    }

    #[test]
    fn evaluator_and_dispatch_addresses_are_data_driven() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:complex",
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "change", "path": "kind" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "candidate" } }]
            },
            "evaluator": {
                "address": "slot::math-evaluator",
                "request_template": {
                    "binding": {
                        "$kind": "binding",
                        "select": { "from": "change", "path": "value" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": 42 } }]
                    },
                    "context": {
                        "value": {
                            "$kind": "binding",
                            "select": { "from": "change", "path": "value" }
                        }
                    }
                },
                "matched_path": "result"
            },
            "dispatch": {
                "target": "slot::target-beta",
                "output_template": { "kind": "fired" }
            }
        }))
        .unwrap();
        talk_to_other_slots.insert_response("slot::math-evaluator", json!({"result": true}));
        talk_to_other_slots.insert_response("slot::target-beta", json!({"status":"ok"}));

        let sample_address = FactAddress::hash_from("sample-record-beta");
        let mut delta = delta_for(
            &sample_address,
            &json!({
                "kind": "candidate",
                "value": 42
            }),
        );
        delta.asserts.insert(
            0,
            rule_assert(&FactAddress::hash_from("trigger:complex"), &rule),
        );
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        handler
            .handle(&envelope)
            .expect("trigger handling should succeed");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent
            .iter()
            .any(|(address, _)| *address == FactAddress::hash_from("slot::math-evaluator")));
        assert!(sent.iter().any(|(address, payload)| {
            *address == FactAddress::hash_from("slot::target-beta")
                && payload.get("kind") == Some(&json!("fired"))
        }));
    }

    #[test]
    fn hash_only_delta_resolves_rule_and_change_bytes_via_talk_to_other_slots() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule_address = FactAddress::hash_from("rule:copy-field");
        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "rule:copy-field",
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "change", "path": "sample_kind" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "selected-kind" } }]
            },
            "dispatch": {
                "target": "slot::target-alpha",
                "output_template": {
                    "copied_value": {
                        "$kind": "binding",
                        "select": { "from": "change", "path": "sample_value" }
                    }
                }
            }
        }))
        .unwrap();
        talk_to_other_slots
            .insert_response_at(rule_address.clone(), serde_json::to_value(&rule).unwrap());

        let sample_address = FactAddress::hash_from("sample-record-alpha");
        talk_to_other_slots.insert_response_at(
            sample_address.clone(),
            json!({
                "sample_kind": "selected-kind",
                "sample_value": "selected-output"
            }),
        );
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));

        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![
                hash_only_rule_assert(&rule_address, "test-content-hash"),
                hash_only_assert(&sample_address, "test-content-hash"),
            ],
            retracts: vec![],
            gap: None,
        };
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        handler
            .handle(&envelope)
            .expect("trigger handling should succeed");

        let queried = talk_to_other_slots.queried.lock().unwrap();
        assert!(queried.contains(&rule_address));
        assert!(queried.contains(&sample_address));
        drop(queried);

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent.iter().any(|(address, payload)| {
            *address == FactAddress::hash_from("slot::target-alpha")
                && payload.get("copied_value") == Some(&json!("selected-output"))
        }));
    }

    #[test]
    fn hash_only_rule_matches_later_hash_only_change_with_envelope_predicate() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule_address = FactAddress::hash_from("trigger:refresh-on-marker");
        let marker_address = FactAddress::hash_from("source-marker:alpha");
        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:refresh-on-marker",
            "topic": "source_marker_alpha",
            "trigger_type": "delta",
            "is_active": true,
            "match_condition": {
                "conditions": [
                    {
                        "$bind": {
                            "select": { "from": "change", "path": "kind" },
                            "transform": [{ "op": "op:core.equals", "args": { "value": "source-marker-alpha" } }]
                        }
                    },
                    {
                        "$bind": {
                            "select": { "from": "envelope", "path": "is_retraction" },
                            "transform": [{ "op": "op:core.equals", "args": { "value": false } }]
                        }
                    }
                ]
            },
            "dispatch": {
                "target": "slot::target-beta",
                "output_template": {
                    "operation": "execute_definition",
                    "definition_id": "definition:sample-refresh",
                    "include_steps": false,
                    "include_output": false,
                    "input": {
                        "change": {
                            "$kind": "binding",
                            "select": { "from": "change", "path": "" }
                        },
                        "envelope": {
                            "$kind": "binding",
                            "select": { "from": "envelope", "path": "" }
                        }
                    }
                }
            }
        }))
        .unwrap();
        talk_to_other_slots
            .insert_response_at(rule_address.clone(), serde_json::to_value(&rule).unwrap());
        talk_to_other_slots.insert_response_at(
            marker_address.clone(),
            json!({
                "kind": "source-marker-alpha",
                "event_ref": "event:proof"
            }),
        );
        talk_to_other_slots.insert_response("slot::target-beta", json!({"status": "completed"}));

        let boot_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_rule_assert(&rule_address, "test-content-hash")],
            retracts: vec![],
            gap: None,
        };
        let boot_envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&boot_delta).unwrap())),
        );
        handler
            .handle(&boot_envelope)
            .expect("hash-only trigger rule hydration should succeed");

        let marker_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_assert(&marker_address, "test-content-hash")],
            retracts: vec![],
            gap: None,
        };
        let marker_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&marker_delta).unwrap())),
        );
        handler
            .handle(&marker_envelope)
            .expect("later hash-only marker should dispatch the hydrated rule");

        let queried = talk_to_other_slots.queried.lock().unwrap();
        assert!(queried.contains(&rule_address));
        assert!(queried.contains(&marker_address));
        drop(queried);

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent.iter().any(|(address, payload)| {
            *address == FactAddress::hash_from("slot::target-beta")
                && payload.get("definition_id") == Some(&json!("definition:sample-refresh"))
                && payload.pointer("/input/change/event_ref") == Some(&json!("event:proof"))
                && payload.pointer("/input/envelope/is_retraction") == Some(&json!(false))
        }));
    }

    #[test]
    fn trigger_rule_shaped_payload_without_trigger_rule_path_is_plain_mutation() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule_shaped_payload: TriggerRule = serde_json::from_value(json!({
            "id": "rule:copy-field",
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "change", "path": "sample_kind" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "selected-kind" } }]
            },
            "dispatch": {
                "target": "slot::target-alpha",
                "output_template": { "copied": true }
            }
        }))
        .unwrap();
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));

        let fake_rule_address = FactAddress::hash_from("not-a-rule-record");
        let sample_address = FactAddress::hash_from("sample-record-alpha");
        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                slot_protocol::WireAssert {
                    address: hex::encode(fake_rule_address.as_multihash().encode()),
                    content_hash: "hash:not-a-rule".to_string(),
                    path: Vec::new(),
                    content: Some(
                        STANDARD.encode(serde_json::to_vec(&rule_shaped_payload).unwrap()),
                    ),
                },
                slot_protocol::WireAssert {
                    address: hex::encode(sample_address.as_multihash().encode()),
                    content_hash: "hash:sample-record".to_string(),
                    path: Vec::new(),
                    content: Some(STANDARD.encode(
                        serde_json::to_vec(&json!({"sample_kind": "selected-kind"})).unwrap(),
                    )),
                },
            ],
            retracts: vec![],
        };
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        handler
            .handle(&envelope)
            .expect("non-rule-path payload must not hydrate rule state");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent
            .iter()
            .all(|(address, _)| *address != FactAddress::hash_from("slot::target-alpha")));
    }

    #[test]
    fn trigger_rule_path_requires_valid_trigger_rule_payload() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(talk_to_other_slots);

        let rule_address = FactAddress::hash_from("rule:invalid");
        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![slot_protocol::WireAssert {
                address: hex::encode(rule_address.as_multihash().encode()),
                content_hash: "hash:invalid-rule".to_string(),
                path: trigger_rule_path(),
                content: Some(STANDARD.encode(b"{\"not\":\"a trigger rule\"}")),
            }],
            retracts: vec![],
            gap: None,
        };
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        // An invalid rule record must NOT abort the whole delta (that silences
        // every other assert in the batch — observed as delivered=0 at boot).
        // It becomes a durable content-resolution-failure write instead.
        let outcome = handler
            .handle_with_writes(&envelope)
            .expect("delta handling must survive one invalid rule record");
        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert_eq!(reply_json["status"], json!("ok"));
        let failure = &reply_json["dispatch_failures"][0];
        assert_eq!(failure["kind"], json!("content-resolution-failure"));
        assert_eq!(failure["address"], json!(rule_address.to_string()));
        let error = failure["error"].as_str().unwrap();
        assert!(error.contains("trigger-rule record is invalid"), "{error}");
    }

    #[test]
    fn envelope_exposes_generic_address_text_not_row_shape() {
        let partition = PartitionKey::hash_from("partition:test");
        let address = FactAddress::from_digest(0x1F, b"sample|partition:test|thing:one".to_vec());
        let envelope = envelope_value(&partition, &address, Some("hash:test"), false);
        assert_eq!(
            envelope.get("address_text"),
            Some(&json!("sample|partition:test|thing:one"))
        );
        assert!(envelope.get("row").is_none());
    }

    #[test]
    fn rule_hydration_does_not_dispatch_runtime_loaded_rules() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule(
            "trigger:on-runtime-loaded",
            "slot::target-gamma",
            "sample-payload",
        );
        talk_to_other_slots.insert_response("slot::target-gamma", json!({"status":"ok"}));

        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(
                &FactAddress::hash_from("trigger:on-runtime-loaded"),
                &rule,
            )],
            retracts: vec![],
            gap: None,
        };
        let envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        handler
            .handle(&envelope)
            .expect("initial rule hydrate should succeed");
        handler
            .handle(&envelope)
            .expect("subsequent rule writes should also only hydrate state");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(sent
            .iter()
            .all(|(address, _)| *address != FactAddress::hash_from("slot::target-gamma")));
    }

    #[test]
    fn runtime_loaded_rules_dispatch_from_runtime_delta_after_hydration() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule_a =
            runtime_loaded_rule("trigger:on-runtime-loaded-a", "slot::target-alpha", "alpha");
        let rule_b =
            runtime_loaded_rule("trigger:on-runtime-loaded-b", "slot::target-beta", "beta");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        talk_to_other_slots.insert_response("slot::target-beta", json!({"status":"ok"}));

        let delta_a = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(
                &FactAddress::hash_from("trigger:on-runtime-loaded-a"),
                &rule_a,
            )],
            retracts: vec![],
            gap: None,
        };
        let delta_b = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(
                &FactAddress::hash_from("trigger:on-runtime-loaded-b"),
                &rule_b,
            )],
            retracts: vec![],
            gap: None,
        };
        let envelope_a = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta_a).unwrap())),
        );
        let envelope_b = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta_b).unwrap())),
        );

        handler
            .handle(&envelope_a)
            .expect("first boot chunk should hydrate its rule");
        handler
            .handle(&envelope_b)
            .expect("later boot chunk should hydrate its rule");

        assert!(talk_to_other_slots.sent.lock().unwrap().is_empty());

        let event_delta = runtime_loaded_delta(&FactAddress::hash_from("runtime:event"));
        let event_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&event_delta).unwrap())),
        );
        handler
            .handle(&event_envelope)
            .expect("runtime event delta should dispatch hydrated rules");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        let alpha_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::target-alpha")
                    && payload.get("payload_id") == Some(&json!("alpha"))
            })
            .count();
        let beta_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::target-beta")
                    && payload.get("payload_id") == Some(&json!("beta"))
            })
            .count();
        assert_eq!(alpha_dispatches, 1);
        assert_eq!(beta_dispatches, 1);
    }

    #[test]
    fn late_rule_hydration_replays_previously_observed_runtime_delta_once() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let event_address = FactAddress::hash_from("runtime:event");
        talk_to_other_slots.insert_response_at(
            event_address.clone(),
            json!({ "properties": { "event_type": "runtime_loaded" } }),
        );
        talk_to_other_slots.insert_response("slot::target-gamma", json!({"status":"ok"}));

        let event_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_assert(&event_address, "test-content-hash")],
            retracts: vec![],
            gap: None,
        };
        let event_envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&event_delta).unwrap())),
        );
        handler
            .handle(&event_envelope)
            .expect("runtime event should be observed even before matching rules exist");

        assert!(talk_to_other_slots
            .sent
            .lock()
            .unwrap()
            .iter()
            .all(|(address, _)| *address != FactAddress::hash_from("slot::target-gamma")));

        let rule = runtime_loaded_rule(
            "trigger:on-runtime-loaded",
            "slot::target-gamma",
            "sample-payload",
        );
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(
                &FactAddress::hash_from("trigger:on-runtime-loaded"),
                &rule,
            )],
            retracts: vec![],
            gap: None,
        };
        let rule_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&rule_delta).unwrap())),
        );

        handler
            .handle(&rule_envelope)
            .expect("late rule hydrate should replay the observed runtime event");
        handler
            .handle(&rule_envelope)
            .expect("unchanged rule hydrate must not replay again");

        let sent = talk_to_other_slots.sent.lock().unwrap();
        let lifecycle_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::target-gamma")
                    && payload.get("payload_id") == Some(&json!("sample-payload"))
            })
            .count();
        assert_eq!(lifecycle_dispatches, 1);
    }

    #[test]
    fn hash_only_rule_hydration_dispatches_after_matching_runtime_delta() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule_address = FactAddress::hash_from("trigger:on-runtime-loaded");
        let event_address = FactAddress::hash_from("runtime:event");
        let rule = runtime_loaded_rule(
            "trigger:on-runtime-loaded",
            "slot::target-gamma",
            "sample-payload",
        );
        talk_to_other_slots
            .insert_response_at(rule_address.clone(), serde_json::to_value(&rule).unwrap());
        talk_to_other_slots.insert_response_at(
            event_address.clone(),
            json!({ "properties": { "event_type": "runtime_loaded" } }),
        );
        talk_to_other_slots.insert_response("slot::target-gamma", json!({"status":"ok"}));

        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_rule_assert(&rule_address, "test-content-hash")],
            retracts: vec![],
            gap: None,
        };
        let rule_envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&rule_delta).unwrap())),
        );

        handler
            .handle(&rule_envelope)
            .expect("hash-only initial rule hydrate should succeed");

        assert!(talk_to_other_slots.sent.lock().unwrap().is_empty());

        let event_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_assert(&event_address, "test-content-hash")],
            retracts: vec![],
            gap: None,
        };
        let event_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&event_delta).unwrap())),
        );
        handler
            .handle(&event_envelope)
            .expect("hash-only runtime event should dispatch hydrated rule");

        let queried = talk_to_other_slots.queried.lock().unwrap();
        assert!(queried.contains(&rule_address));
        assert!(queried.contains(&event_address));
        drop(queried);

        let sent = talk_to_other_slots.sent.lock().unwrap();
        let lifecycle_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::target-gamma")
                    && payload.get("payload_id") == Some(&json!("sample-payload"))
            })
            .count();
        assert_eq!(lifecycle_dispatches, 1);
    }

    #[test]
    fn runtime_delta_dispatch_failures_do_not_abort_other_rules() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let missing_target_rule = runtime_loaded_rule(
            "trigger:on-runtime-loaded-missing-target",
            "slot::missing-target",
            "missing-target-payload",
        );
        let surviving_rule = runtime_loaded_rule(
            "trigger:on-runtime-loaded-survives",
            "slot::surviving-target",
            "surviving-payload",
        );
        talk_to_other_slots.insert_response("slot::surviving-target", json!({"status":"ok"}));

        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(
                    &FactAddress::hash_from("trigger:on-runtime-loaded-missing-target"),
                    &missing_target_rule,
                ),
                rule_assert(
                    &FactAddress::hash_from("trigger:on-runtime-loaded-survives"),
                    &surviving_rule,
                ),
            ],
            retracts: vec![],
            gap: None,
        };
        let rule_envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&rule_delta).unwrap())),
        );

        handler
            .handle(&rule_envelope)
            .expect("rule hydration should not dispatch runtime rules");

        let event_delta = runtime_loaded_delta(&FactAddress::hash_from("runtime:event"));
        let event_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&event_delta).unwrap())),
        );
        let reply = handler
            .handle(&event_envelope)
            .expect("missing runtime dispatch target should not fail delta processing");
        let reply_json: Value = serde_json::from_slice(&reply).unwrap();

        assert_eq!(reply_json["status"], json!("ok"));
        assert_eq!(
            reply_json["dispatch_failures"][0]["rule_id"],
            json!("trigger:on-runtime-loaded-missing-target")
        );
        assert_eq!(
            reply_json["dispatch_failures"][0]["phase"],
            json!("dispatch")
        );
        assert!(reply_json["dispatch_failures"][0]["error"]
            .as_str()
            .unwrap()
            .contains("address not found"));

        let sent = talk_to_other_slots.sent.lock().unwrap();
        let surviving_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::surviving-target")
                    && payload.get("payload_id") == Some(&json!("surviving-payload"))
            })
            .count();
        assert_eq!(surviving_dispatches, 1);
    }

    #[test]
    fn mutation_dispatch_failures_do_not_abort_other_delta_rules() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let missing_target_rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:on-change-missing-target",
            "match_condition": {
                "conditions": [
                    {
                        "$bind": {
                            "select": { "from": "change", "path": "kind" },
                            "transform": [{ "op": "op:core.equals", "args": { "value": "sample" } }]
                        }
                    }
                ]
            },
            "dispatch": {
                "target": "slot::missing-target",
                "output_template": {
                    "operation": "sample-operation",
                    "payload_id": "missing-target-payload"
                }
            }
        }))
        .unwrap();
        let surviving_rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:on-change-survives",
            "match_condition": {
                "conditions": [
                    {
                        "$bind": {
                            "select": { "from": "change", "path": "kind" },
                            "transform": [{ "op": "op:core.equals", "args": { "value": "sample" } }]
                        }
                    }
                ]
            },
            "dispatch": {
                "target": "slot::surviving-target",
                "output_template": {
                    "operation": "sample-operation",
                    "payload_id": "surviving-payload"
                }
            }
        }))
        .unwrap();
        talk_to_other_slots.insert_response("slot::surviving-target", json!({"status":"ok"}));

        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(
                    &FactAddress::hash_from("trigger:on-change-missing-target"),
                    &missing_target_rule,
                ),
                rule_assert(
                    &FactAddress::hash_from("trigger:on-change-survives"),
                    &surviving_rule,
                ),
            ],
            retracts: vec![],
            gap: None,
        };
        let rule_envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&rule_delta).unwrap())),
        );
        handler
            .handle(&rule_envelope)
            .expect("rule hydration should succeed");

        let change_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![slot_protocol::WireAssert {
                address: hex::encode(
                    FactAddress::hash_from("record:sample")
                        .as_multihash()
                        .encode(),
                ),
                content_hash: "hash:sample".to_string(),
                path: Vec::new(),
                content: Some(
                    STANDARD.encode(serde_json::to_vec(&json!({"kind":"sample"})).unwrap()),
                ),
            }],
            retracts: vec![],
            gap: None,
        };
        let change_envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&change_delta).unwrap())),
        );

        let reply = handler
            .handle(&change_envelope)
            .expect("missing mutation dispatch target should not fail delta processing");
        let reply_json: Value = serde_json::from_slice(&reply).unwrap();

        assert_eq!(
            reply_json["dispatch_failures"][0]["rule_id"],
            json!("trigger:on-change-missing-target")
        );
        let sent = talk_to_other_slots.sent.lock().unwrap();
        let surviving_dispatches = sent
            .iter()
            .filter(|(address, payload)| {
                *address == FactAddress::hash_from("slot::surviving-target")
                    && payload.get("payload_id") == Some(&json!("surviving-payload"))
            })
            .count();
        assert_eq!(surviving_dispatches, 1);
    }

    #[test]
    fn oversized_full_change_dispatch_is_typed_failure_not_callback_trap() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:oversized-full-change-proof",
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "envelope", "path": "is_retraction" },
                "transform": [{ "op": "op:core.equals", "args": { "value": false } }]
            },
            "dispatch": {
                "target": "slot::target-oversized",
                "output_template": {
                    "change": {
                        "$kind": "binding",
                        "select": { "from": "change", "path": "" }
                    }
                }
            }
        }))
        .unwrap();

        let oversized_change = vec![b'x'; (2 * 1024 * 1024) + 1];
        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(
                    &FactAddress::hash_from("trigger:oversized-full-change-proof"),
                    &rule,
                ),
                slot_protocol::WireAssert {
                    address: hex::encode(
                        FactAddress::hash_from("record:oversized-change")
                            .as_multihash()
                            .encode(),
                    ),
                    content_hash: "hash:oversized".to_string(),
                    path: Vec::new(),
                    content: Some(STANDARD.encode(oversized_change)),
                },
            ],
            retracts: vec![],
        };
        let envelope = Envelope::minimal(
            partition,
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        let reply = handler
            .handle(&envelope)
            .expect("oversized dispatch materialization must not abort delta processing");
        let reply_json: Value = serde_json::from_slice(&reply).unwrap();

        assert_eq!(reply_json["status"], json!("ok"));
        assert_eq!(
            reply_json["dispatch_failures"][0]["phase"],
            json!("dispatch")
        );
        assert_eq!(
            reply_json["dispatch_failures"][0]["rule_id"],
            json!("trigger:oversized-full-change-proof")
        );
        assert!(reply_json["dispatch_failures"][0]["error"]
            .as_str()
            .unwrap()
            .contains("callback-safe JSON bound"));
        assert!(talk_to_other_slots.sent.lock().unwrap().is_empty());
    }

    // ---- HARDEN-9: durable dispatch-failure writes ----

    /// A failing dispatch produces BOTH the response failure AND a durable
    /// workflow-dispatch-failure write at the deterministic per-discriminator
    /// address, carrying definition_id when the rule dispatches a workflow.
    #[test]
    fn failing_workflow_dispatch_produces_durable_failure_write() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // Rule dispatching a workflow def via execute_definition; the mock has
        // NO response for slot::workflow, so dispatch fails.
        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:test-fail",
            "topic": "runtime_loaded",
            "match_condition": {
                "conditions": [{
                    "$bind": {
                        "select": { "from": "change", "path": "properties.event_type" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "runtime_loaded" } }]
                    }
                }]
            },
            "dispatch": {
                "target": "slot::workflow",
                "output_template": {
                    "operation": "execute_definition",
                    "definition_id": "action:test.some-def",
                    "input": {}
                }
            }
        }))
        .unwrap();

        let rule_address = FactAddress::hash_from("trigger:test-fail");
        let event_address = FactAddress::hash_from("record:event-1");
        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(&rule_address, &rule),
                slot_protocol::WireAssert {
                    address: hex::encode(event_address.as_multihash().encode()),
                    content_hash: "hash:event".to_string(),
                    path: Vec::new(),
                    content: Some(
                        STANDARD.encode(
                            serde_json::to_vec(&json!({
                                "properties": { "event_type": "runtime_loaded" }
                            }))
                            .unwrap(),
                        ),
                    ),
                },
            ],
            retracts: vec![],
        };
        let envelope = Envelope::minimal(
            partition.clone(),
            FactAddress::hash_from("slot::trigger-engine"),
            Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
        );

        let outcome = handler
            .handle_with_writes(&envelope)
            .expect("delta handling should succeed");
        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert_eq!(reply_json["status"], json!("ok"));
        let failure = &reply_json["dispatch_failures"][0];
        assert_eq!(failure["kind"], json!("workflow-dispatch-failure"));
        assert_eq!(failure["definition_id"], json!("action:test.some-def"));
        assert_eq!(failure["target"], json!("slot::workflow"));
        assert_eq!(failure["rule_id"], json!("trigger:test-fail"));
        assert!(failure["envelope"]["address"].is_string());

        // The durable write: deterministic per-definition address, correct path.
        assert_eq!(outcome.failure_writes.len(), 1);
        let write = &outcome.failure_writes[0];
        assert_eq!(write.partition, partition);
        assert_eq!(
            write.address,
            FactAddress::hash_from("trigger-engine.dispatch-failure::action:test.some-def")
        );
        assert_eq!(
            write.path,
            vec![
                PathSegment::hash_from("current-item"),
                PathSegment::hash_from("workflow-dispatch-failure"),
            ]
        );
        let payload: Value = serde_json::from_slice(write.payload.as_ref().unwrap()).unwrap();
        assert_eq!(payload["kind"], json!("workflow-dispatch-failure"));
        assert_eq!(payload["definition_id"], json!("action:test.some-def"));

        // A SECOND failure for the same def overwrites (same address) — bounded.
        let outcome2 = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(
                    serde_json::to_vec(&DeltaPayload {
                        gap: None,
                        kind: "delta".to_string(),
                        asserts: vec![slot_protocol::WireAssert {
                            address: hex::encode(
                                FactAddress::hash_from("record:event-2")
                                    .as_multihash()
                                    .encode(),
                            ),
                            content_hash: "hash:event2".to_string(),
                            path: Vec::new(),
                            content: Some(
                                STANDARD.encode(
                                    serde_json::to_vec(&json!({
                                        "properties": { "event_type": "runtime_loaded" }
                                    }))
                                    .unwrap(),
                                ),
                            ),
                        }],
                        retracts: vec![],
                    })
                    .unwrap(),
                )),
            ))
            .expect("second delta handling should succeed");
        assert_eq!(outcome2.failure_writes.len(), 1);
        assert_eq!(outcome2.failure_writes[0].address, write.address);
    }

    /// A rule without a workflow definition falls back to the rule id as the
    /// failure-write discriminator.
    #[test]
    fn non_workflow_dispatch_failure_uses_rule_id_discriminator() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule("trigger:plain", "slot::target-missing", "p1");
        let rule_address = FactAddress::hash_from("trigger:plain");
        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(&rule_address, &rule),
                slot_protocol::WireAssert {
                    address: hex::encode(
                        FactAddress::hash_from("record:event-3")
                            .as_multihash()
                            .encode(),
                    ),
                    content_hash: "hash:event3".to_string(),
                    path: Vec::new(),
                    content: Some(
                        STANDARD.encode(
                            serde_json::to_vec(&json!({
                                "properties": { "event_type": "runtime_loaded" }
                            }))
                            .unwrap(),
                        ),
                    ),
                },
            ],
            retracts: vec![],
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");
        assert_eq!(outcome.failure_writes.len(), 1);
        assert_eq!(
            outcome.failure_writes[0].address,
            FactAddress::hash_from("trigger-engine.dispatch-failure::trigger:plain")
        );
    }

    /// Recursion guard: a change whose own payload IS a
    /// workflow-dispatch-failure record produces failures in the RESPONSE but
    /// NO durable write (a failure about a failure must never loop).
    #[test]
    fn failure_record_change_never_produces_a_failure_write() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // A rule that matches ANY change carrying kind=workflow-dispatch-failure
        // and dispatches to a missing target -> guaranteed failure ABOUT a
        // failure record.
        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:failure-watcher",
            "topic": "any",
            "match_condition": {
                "conditions": [{
                    "$bind": {
                        "select": { "from": "change", "path": "kind" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "workflow-dispatch-failure" } }]
                    }
                }]
            },
            "dispatch": {
                "target": "slot::missing",
                "output_template": { "operation": "noop" }
            }
        }))
        .unwrap();

        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(&FactAddress::hash_from("trigger:failure-watcher"), &rule),
                slot_protocol::WireAssert {
                    address: hex::encode(
                        FactAddress::hash_from(
                            "trigger-engine.dispatch-failure::action:test.some-def",
                        )
                        .as_multihash()
                        .encode(),
                    ),
                    content_hash: "hash:failrec".to_string(),
                    path: Vec::new(),
                    content: Some(
                        STANDARD.encode(
                            serde_json::to_vec(&json!({
                                "kind": "workflow-dispatch-failure",
                                "definition_id": "action:test.some-def",
                                "error": "original error"
                            }))
                            .unwrap(),
                        ),
                    ),
                },
            ],
            retracts: vec![],
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");
        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        // The response still reports the failure (observability preserved)...
        assert!(!reply_json["dispatch_failures"]
            .as_array()
            .unwrap()
            .is_empty());
        // ...but NO durable write is produced (recursion structurally impossible).
        assert!(outcome.failure_writes.is_empty());
    }

    /// A clean delta (no failures) produces zero writes — the hot path pays
    /// nothing.
    #[test]
    fn successful_dispatch_produces_no_failure_writes() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule("trigger:ok", "slot::target-alpha", "p1");
        let delta = DeltaPayload {
            gap: None,
            kind: "delta".to_string(),
            asserts: vec![
                rule_assert(&FactAddress::hash_from("trigger:ok"), &rule),
                slot_protocol::WireAssert {
                    address: hex::encode(
                        FactAddress::hash_from("record:event-ok")
                            .as_multihash()
                            .encode(),
                    ),
                    content_hash: "hash:ok".to_string(),
                    path: Vec::new(),
                    content: Some(
                        STANDARD.encode(
                            serde_json::to_vec(&json!({
                                "properties": { "event_type": "runtime_loaded" }
                            }))
                            .unwrap(),
                        ),
                    ),
                },
            ],
            retracts: vec![],
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");
        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert!(reply_json["dispatch_failures"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(outcome.failure_writes.is_empty());
    }

    /// Task B: a hash_only assert whose asserted content_hash differs from the
    /// direct-read reply's engine-computed hash (the mock always replies
    /// "test-content-hash") is a substitution race — it must produce a durable
    /// content-resolution-failure write, never silent substitution or skip.
    #[test]
    fn hash_mismatched_direct_read_produces_content_resolution_failure_write() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let sample_address = FactAddress::hash_from("sample-record-stale");
        // The address IS readable — but its CURRENT bytes hash to
        // "test-content-hash", not the asserted "hash:stale".
        talk_to_other_slots
            .insert_response_at(sample_address.clone(), json!({"sample_kind":"whatever"}));

        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_assert(&sample_address, "hash:stale")],
            retracts: vec![],
            gap: None,
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition.clone(),
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");

        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert_eq!(reply_json["status"], json!("ok"));
        let failure = &reply_json["dispatch_failures"][0];
        assert_eq!(failure["kind"], json!("content-resolution-failure"));
        assert_eq!(failure["phase"], json!("content-resolution"));
        assert_eq!(failure["asserted_content_hash"], json!("hash:stale"));
        assert_eq!(failure["address"], json!(sample_address.to_string()));
        let error = failure["error"].as_str().unwrap();
        assert!(error.contains("direct-read content mismatch"), "{error}");
        assert!(error.contains("asserted=hash:stale"), "{error}");
        assert!(error.contains("current=test-content-hash"), "{error}");

        // The durable write: deterministic per-address discriminator, correct path.
        assert_eq!(outcome.failure_writes.len(), 1);
        let write = &outcome.failure_writes[0];
        assert_eq!(write.partition, partition);
        assert_eq!(
            write.address,
            FactAddress::hash_from(&format!(
                "trigger-engine.content-resolution-failure::{}",
                sample_address
            ))
        );
        assert_eq!(
            write.path,
            vec![
                PathSegment::hash_from("current-item"),
                PathSegment::hash_from("content-resolution-failure"),
            ]
        );
        let payload: Value = serde_json::from_slice(write.payload.as_ref().unwrap()).unwrap();
        assert_eq!(payload["kind"], json!("content-resolution-failure"));
    }

    /// Task B: a hash_only assert whose direct read FAILS outright (address
    /// unreadable) produces the same durable record family — the loss is one
    /// query away instead of invisible.
    #[test]
    fn failed_direct_read_produces_content_resolution_failure_write() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // NO mock response registered for this address → dispatch errors.
        let unreadable_address = FactAddress::hash_from("sample-record-unreadable");
        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![hash_only_assert(&unreadable_address, "hash:gone")],
            retracts: vec![],
            gap: None,
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");

        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        let failure = &reply_json["dispatch_failures"][0];
        assert_eq!(failure["kind"], json!("content-resolution-failure"));
        assert_eq!(failure["asserted_content_hash"], json!("hash:gone"));

        assert_eq!(outcome.failure_writes.len(), 1);
        assert_eq!(
            outcome.failure_writes[0].address,
            FactAddress::hash_from(&format!(
                "trigger-engine.content-resolution-failure::{}",
                unreadable_address
            ))
        );
    }

    /// Task B recursion guard: an unresolvable assert whose PATH marks it as
    /// one of our own failure records (workflow-dispatch-failure or
    /// content-resolution-failure) produces NO failure — neither in the reply
    /// nor as a durable write. A failure about a failure would chain unbounded
    /// distinct addresses through the delta feed.
    #[test]
    fn failure_record_assert_never_produces_content_resolution_failure_write() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // Our own emitted record path stamps, all unreadable (no mock
        // response) — the exact shape a failure record's own delta has when
        // its content is dropped from the feed.
        let make_failure_assert = |address: &str, family: &str| slot_protocol::WireAssert {
            address: hex::encode(FactAddress::hash_from(address).as_multihash().encode()),
            content_hash: "hash:failure-record".to_string(),
            path: vec![
                PathSegment::hash_from("current-item").to_wire_hex(),
                PathSegment::hash_from(family).to_wire_hex(),
            ],
            content: None,
        };
        let delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![
                make_failure_assert("failure-record-1", "workflow-dispatch-failure"),
                make_failure_assert("failure-record-2", "content-resolution-failure"),
                make_failure_assert("outcome-record", "trigger-dispatch-outcome"),
            ],
            retracts: vec![],
            gap: None,
        };
        let outcome = handler
            .handle_with_writes(&Envelope::minimal(
                partition,
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(&delta).unwrap())),
            ))
            .expect("delta handling should succeed");

        let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert!(reply_json["dispatch_failures"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(outcome.failure_writes.is_empty());
    }

    // ========================================================================
    // Delivery-gap catch-up (delta-delivery-integrity Task E)
    // ========================================================================

    /// Encode a live-state scan reply for the mock.
    fn live_state_reply(
        entries: Vec<(FactAddress, &str, Vec<String>)>,
        next_cursor: Option<u64>,
    ) -> Vec<u8> {
        let reply = slot_protocol::ListLiveStateReply {
            entries: entries
                .into_iter()
                .map(
                    |(address, content_hash, path_hex)| slot_protocol::LiveStateEntryReply {
                        address: address.as_multihash().encode(),
                        content_hash: content_hash.to_string(),
                        path: path_hex
                            .into_iter()
                            .map(|segment| hex::decode(segment).unwrap())
                            .collect(),
                        payload: None,
                    },
                )
                .collect(),
            next_cursor,
        };
        slot_protocol::encode_list_live_state_reply(&reply).unwrap()
    }

    fn gap_delta(from_cursor: u64, to_cursor: u64) -> DeltaPayload {
        DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: Some(slot_protocol::WireDeltaGap {
                from_cursor,
                to_cursor,
            }),
        }
    }

    fn assert_continuation_without_wake(outcome: &HandleOutcome) {
        let response: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert_eq!(
            response["subscription_continuation"],
            json!({"type":"delta","asserts":[],"retracts":[]})
        );
        assert!(outcome.failure_writes.iter().all(|write| {
            write.address != FactAddress::hash_from("trigger-engine.catch-up-pending")
        }));
    }

    fn handle_delta(
        handler: &TriggerHandler<Arc<MockTalkToOtherSlots>>,
        partition: &PartitionKey,
        delta: &DeltaPayload,
    ) -> HandleOutcome {
        // Mirror delivered rule deltas into the mock's authoritative current
        // rule selector. Recovery validation reads this independently from the
        // handler cache, just as production reads runtime::live_state.
        for assert in &delta.asserts {
            if !is_trigger_rule_assert(assert) {
                continue;
            }
            let address = decode_address(&assert.address).unwrap();
            let bytes = assert
                .content_bytes()
                .unwrap()
                .or_else(|| {
                    handler
                        .talk_to_other_slots
                        .responses
                        .lock()
                        .unwrap()
                        .get(&address)
                        .cloned()
                })
                .expect("mock rule bytes");
            handler
                .talk_to_other_slots
                .current_rules
                .lock()
                .unwrap()
                .insert(
                    address,
                    (assert.content_hash.clone(), assert.path.clone(), bytes),
                );
        }
        for retract in &delta.retracts {
            if let Ok(address) = decode_address(retract) {
                handler
                    .talk_to_other_slots
                    .current_rules
                    .lock()
                    .unwrap()
                    .remove(&address);
            }
        }
        handler
            .handle_with_writes(&Envelope::minimal(
                partition.clone(),
                FactAddress::hash_from("slot::trigger-engine"),
                Some(Bytes::from(serde_json::to_vec(delta).unwrap())),
            ))
            .expect("delta handling should succeed")
    }

    /// A gap payload stays out of durable storage, and the FIRST gap only
    /// seeds the last-seen baseline (no rule fires for records that predate
    /// this slot's view).
    #[test]
    fn first_gap_returns_loss_and_seeds_baseline_without_firing() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // A rule is resident (delivered as a normal delta first).
        let rule = runtime_loaded_rule("trigger:gap-probe", "slot::target-alpha", "p1");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(
                &FactAddress::hash_from("trigger:gap-probe"),
                &rule,
            )],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &rule_delta);

        // Live state contains a record that WOULD match the rule.
        let record_address = FactAddress::hash_from("record:preexisting");
        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![(record_address.clone(), "1f:aa", vec![])],
                None,
            )],
        );

        let outcome = handle_delta(&handler, &partition, &gap_delta(10, 20));

        // Operational exhaust boundary: the loss remains observable in the
        // response but never appends a CAS version.
        let gap_writes: Vec<_> = outcome
            .failure_writes
            .iter()
            .filter(|w| {
                w.address == FactAddress::hash_from("trigger-engine.delivery-gap::delta-delivery")
            })
            .collect();
        assert!(
            gap_writes.is_empty(),
            "delivery gaps are not durable writes"
        );
        let response: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert_eq!(
            response["dispatch_failures"][0]["kind"],
            json!("delivery-gap")
        );
        assert_eq!(response["dispatch_failures"][0]["from_cursor"], json!(10));
        assert_eq!(response["dispatch_failures"][0]["to_cursor"], json!(20));

        // First gap: baseline seeding only — the pre-existing record did NOT fire.
        let sent = talk_to_other_slots.sent.lock().unwrap();
        assert!(
            !sent
                .iter()
                .any(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha")),
            "first gap must not fire rules against pre-baseline records"
        );
    }

    /// After a baseline exists, a gap catch-up re-evaluates ONLY entries whose
    /// live content hash changed — the missed record fires its rule.
    #[test]
    fn second_gap_fires_rules_for_changed_content_only() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule("trigger:gap-probe", "slot::target-alpha", "p1");
        let rule_address = FactAddress::hash_from("trigger:gap-probe");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(&rule_address, &rule)],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &rule_delta);

        let unchanged_address = FactAddress::hash_from("record:unchanged");
        let missed_address = FactAddress::hash_from("record:missed");
        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);

        // Gap 1: seeds baseline with the unchanged record at hash 1f:aa.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![
                    (
                        rule_address.clone(),
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (unchanged_address.clone(), "1f:aa", vec![]),
                ],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 5));

        // Between gaps a write was LOST: live state now also has record:missed.
        // The direct read for it must hash-verify — the mock replies with
        // "test-content-hash", so the scan must report that same hash.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![
                    (
                        rule_address,
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (unchanged_address.clone(), "1f:aa", vec![]),
                    (missed_address.clone(), "test-content-hash", vec![]),
                ],
                None,
            )],
        );
        talk_to_other_slots.insert_response_at(
            missed_address.clone(),
            json!({ "properties": { "event_type": "runtime_loaded" } }),
        );

        {
            let mut sent = talk_to_other_slots.sent.lock().unwrap();
            sent.clear();
        }
        // A gapless payload ends the first storm (HARDEN-21 coalescing) so
        // the next gap scans immediately.
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);
        handle_delta(&handler, &partition, &gap_delta(5, 9));

        let sent = talk_to_other_slots.sent.lock().unwrap();
        let fired: Vec<_> = sent
            .iter()
            .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
            .collect();
        assert_eq!(
            fired.len(),
            1,
            "exactly the missed record fires — unchanged content does not re-fire"
        );
        assert_eq!(fired[0].1["payload_id"], json!("p1"));
    }

    /// HARDEN-21: a gap storm costs at most TWO scans — the first gap scans
    /// immediately, further gaps coalesce (durable record marked coalesced,
    /// NO scan), and the first gapless payload drains the merged residue with
    /// one deferred scan.
    #[test]
    fn gap_storm_coalesces_to_two_scans() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let record_address = FactAddress::hash_from("record:storm");
        // Two scan replies queued: storm-opening scan + deferred residue scan.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![
                live_state_reply(vec![(record_address.clone(), "1f:aa", vec![])], None),
                live_state_reply(vec![(record_address.clone(), "1f:aa", vec![])], None),
            ],
        );

        // Storm: three consecutive gap payloads.
        let first = handle_delta(&handler, &partition, &gap_delta(0, 2));
        let second = handle_delta(&handler, &partition, &gap_delta(2, 4));
        let third = handle_delta(&handler, &partition, &gap_delta(4, 6));

        let scans_after_storm = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(
            scans_after_storm, 1,
            "storm runs exactly ONE immediate scan"
        );

        // Coalesced gaps stay response-level only (marked coalesced).
        for outcome in [&second, &third] {
            let reply_json: Value = serde_json::from_slice(&outcome.response).unwrap();
            let failure = &reply_json["dispatch_failures"][0];
            assert_eq!(failure["kind"], json!("delivery-gap"));
            assert_eq!(failure["coalesced"], json!(true));
            assert!(outcome.failure_writes.is_empty());
        }
        let first_json: Value = serde_json::from_slice(&first.response).unwrap();
        assert!(first_json["dispatch_failures"][0]["coalesced"].is_null());

        // First gapless payload drains the residue with ONE deferred scan
        // covering the merged interval [2,6).
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        let drain = handle_delta(&handler, &partition, &quiet);
        let scans_after_drain = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(scans_after_drain, 2, "residue drains with ONE more scan");
        let drain_json: Value = serde_json::from_slice(&drain.response).unwrap();
        let drained = &drain_json["dispatch_failures"][0];
        assert_eq!(drained["kind"], json!("delivery-gap"));
        assert_eq!(drained["from_cursor"], json!(2));
        assert_eq!(drained["to_cursor"], json!(6));

        // And a second quiet payload owes nothing.
        let idle = handle_delta(&handler, &partition, &quiet);
        let idle_json: Value = serde_json::from_slice(&idle.response).unwrap();
        assert!(idle_json["dispatch_failures"]
            .as_array()
            .unwrap()
            .is_empty());
        let scans_after_idle = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(scans_after_idle, 2, "no scan without an owed gap");
    }

    /// HARDEN-22: the catch-up scan streams — a multi-page scan dispatches
    /// page 1's changed entries BEFORE fetching page 2 (memory ceiling is
    /// O(page), never O(live-state)).
    #[test]
    fn gap_catch_up_streams_pages_dispatching_before_next_fetch() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // Resident rule that fires on runtime_loaded records.
        let rule = runtime_loaded_rule("trigger:stream-probe", "slot::target-alpha", "p1");
        let rule_address = FactAddress::hash_from("trigger:stream-probe");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(&rule_address, &rule)],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &rule_delta);

        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let page1_record = FactAddress::hash_from("record:page1");
        let page2_record = FactAddress::hash_from("record:page2");

        // Gap 1 seeds the baseline over an empty snapshot.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![(
                    rule_address.clone(),
                    "hash:rule",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                )],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);

        // Gap 2 scans TWO pages, one new matching record on each.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![
                live_state_reply(
                    vec![(page1_record.clone(), "test-content-hash", vec![])],
                    Some(1),
                ),
                live_state_reply(
                    vec![
                        (
                            rule_address,
                            "hash:rule",
                            vec![trigger_rule_path_segment_wire_hex().to_string()],
                        ),
                        (page2_record.clone(), "test-content-hash", vec![]),
                    ],
                    None,
                ),
            ],
        );
        let event = json!({ "properties": { "event_type": "runtime_loaded" } });
        talk_to_other_slots.insert_response_at(page1_record.clone(), event.clone());
        talk_to_other_slots.insert_response_at(page2_record.clone(), event);

        handle_delta(&handler, &partition, &gap_delta(1, 3));
        // Budget=1 page/invocation (HARDEN-22c): page2 parks — the next
        // payload resumes it.
        handle_delta(&handler, &partition, &quiet);

        // STREAMING PROOF: query order interleaves — page1 fetch, page1's
        // direct read + dispatch, THEN page2 fetch. An accumulate-then-resolve
        // implementation would show both live-state fetches before any read.
        let queried = talk_to_other_slots.queried.lock().unwrap();
        let positions: Vec<usize> = queried
            .iter()
            .enumerate()
            .filter(|(_, address)| **address == live_state_address)
            .map(|(index, _)| index)
            .collect();
        assert_eq!(positions.len(), 3, "baseline scan + two pages");
        let page1_read_position = queried
            .iter()
            .position(|address| *address == page1_record)
            .expect("page1 direct read happened");
        assert!(
            page1_read_position < positions[2],
            "page1 resolves BEFORE page2 is fetched (streaming, not accumulate)"
        );
        drop(queried);

        // Both missed records fired the rule.
        let sent = talk_to_other_slots.sent.lock().unwrap();
        let fired = sent
            .iter()
            .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
            .count();
        assert_eq!(fired, 2, "both pages' missed records fire");
    }

    /// HARDEN-22c: a scan spanning more pages than the per-invocation budget
    /// PARKS its cursor and continues on the NEXT payload — no single
    /// invocation ever exceeds GAP_CATCH_UP_PAGES_PER_STEP pages (fuel-safe).
    #[test]
    fn gap_scan_parks_at_page_budget_and_resumes_on_next_payload() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule("trigger:park-probe", "slot::target-alpha", "p1");
        let rule_address = FactAddress::hash_from("trigger:park-probe");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(&rule_address, &rule)],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &rule_delta);

        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };

        // Seed the baseline (empty snapshot), end the storm.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![(
                    rule_address.clone(),
                    "hash:rule",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                )],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(&handler, &partition, &quiet);

        // Build GAP_CATCH_UP_PAGES_PER_STEP + 1 pages, one new record each.
        let total_pages = GAP_CATCH_UP_PAGES_PER_STEP + 1;
        let records: Vec<FactAddress> = (0..total_pages)
            .map(|index| FactAddress::hash_from(&format!("record:park-{index}")))
            .collect();
        let event = json!({ "properties": { "event_type": "runtime_loaded" } });
        let mut pages = Vec::new();
        for (index, record) in records.iter().enumerate() {
            let next = if index + 1 < total_pages {
                Some((index + 1) as u64)
            } else {
                None
            };
            let mut page_entries = vec![(record.clone(), "test-content-hash", vec![])];
            if next.is_none() {
                page_entries.push((
                    rule_address.clone(),
                    "hash:rule",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                ));
            }
            pages.push(live_state_reply(page_entries, next));
            talk_to_other_slots.insert_response_at(record.clone(), event.clone());
        }
        talk_to_other_slots.insert_raw_sequence(live_state_address.clone(), pages);

        // The gap payload: exactly the budgeted pages scan, then PARK.
        let park_outcome = handle_delta(&handler, &partition, &gap_delta(1, 3));
        assert_continuation_without_wake(&park_outcome);
        let scans_after_gap = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(
            scans_after_gap,
            1 + GAP_CATCH_UP_PAGES_PER_STEP,
            "baseline scan + exactly the per-invocation page budget"
        );
        let fired_so_far = talk_to_other_slots
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
            .count();
        assert_eq!(
            fired_so_far, GAP_CATCH_UP_PAGES_PER_STEP,
            "budgeted pages' records fired within the first invocation"
        );

        // The NEXT payload resumes the parked scan and finishes the tail page.
        handle_delta(&handler, &partition, &quiet);
        let scans_after_resume = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(
            scans_after_resume,
            1 + total_pages,
            "resume fetches the remaining page"
        );
        let fired_total = talk_to_other_slots
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
            .count();
        assert_eq!(fired_total, total_pages, "no record lost across the park");
    }

    /// HARDEN-23: on a QUIET stream (no further organic payloads), the parked
    /// scan is resumed by the catch-up-pending record's OWN delta coming back
    /// around the feed — the durable wake, not luck, drives the continuation.
    /// The wake delta itself is a failure-family record: recognized, never
    /// evaluated against rules, and it never emits a content-resolution
    /// failure (recursion guard).
    #[test]
    fn parked_scan_resumes_on_its_own_catch_up_pending_delta() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        let rule = runtime_loaded_rule("trigger:wake-probe", "slot::target-alpha", "p1");
        let rule_address = FactAddress::hash_from("trigger:wake-probe");
        talk_to_other_slots.insert_response("slot::target-alpha", json!({"status":"ok"}));
        let rule_delta = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![rule_assert(&rule_address, &rule)],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &rule_delta);

        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };

        // Seed the baseline (empty snapshot), end the storm.
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(
                vec![(
                    rule_address.clone(),
                    "hash:rule",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                )],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(&handler, &partition, &quiet);

        // Two pages of one new record each → the budgeted step parks after
        // page 1 and emits the catch-up-pending wake.
        let total_pages = GAP_CATCH_UP_PAGES_PER_STEP + 1;
        let records: Vec<FactAddress> = (0..total_pages)
            .map(|index| FactAddress::hash_from(&format!("record:wake-{index}")))
            .collect();
        let event = json!({ "properties": { "event_type": "runtime_loaded" } });
        let mut pages = Vec::new();
        for (index, record) in records.iter().enumerate() {
            let next = if index + 1 < total_pages {
                Some((index + 1) as u64)
            } else {
                None
            };
            let mut page_entries = vec![(record.clone(), "test-content-hash", vec![])];
            if next.is_none() {
                page_entries.push((
                    rule_address.clone(),
                    "hash:rule",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                ));
            }
            pages.push(live_state_reply(page_entries, next));
            talk_to_other_slots.insert_response_at(record.clone(), event.clone());
        }
        talk_to_other_slots.insert_raw_sequence(live_state_address.clone(), pages);

        let park_outcome = handle_delta(&handler, &partition, &gap_delta(1, 3));
        assert_continuation_without_wake(&park_outcome);
        let wake_outcome = handle_delta(&handler, &partition, &quiet);

        // The wake resumed the parked scan → the tail page's record fired.
        let fired_total = talk_to_other_slots
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
            .count();
        assert_eq!(
            fired_total, total_pages,
            "the wake delta drove the scan to completion"
        );
        assert!(wake_outcome.failure_writes.is_empty());
    }

    #[test]
    fn partial_first_scan_stays_seed_only_until_its_final_page() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let rule = runtime_loaded_rule("trigger:baseline", "slot::target-alpha", "p1");
        talk.insert_response("slot::target-alpha", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(
                    &FactAddress::hash_from("trigger:baseline"),
                    &rule,
                )],
                retracts: vec![],
                gap: None,
            },
        );

        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let historical_a = FactAddress::hash_from("record:historical-a");
        let historical_b = FactAddress::hash_from("record:historical-b");
        talk.insert_raw_sequence(
            live,
            vec![
                live_state_reply(vec![(historical_a, "1f:aa", vec![])], Some(1)),
                live_state_reply(vec![(historical_b, "1f:bb", vec![])], None),
            ],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );

        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
                .count(),
            0,
            "neither historical page fires while the first baseline is incomplete"
        );
    }

    #[test]
    fn resumed_scan_defers_a_new_gap_to_a_fresh_invocation() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![
                live_state_reply(
                    vec![(FactAddress::hash_from("record:first"), "1f:aa", vec![])],
                    Some(1),
                ),
                live_state_reply(
                    vec![(FactAddress::hash_from("record:tail"), "1f:bb", vec![])],
                    None,
                ),
                live_state_reply(vec![], None),
            ],
        );

        handle_delta(&handler, &partition, &gap_delta(0, 2));
        let resume_with_gap = handle_delta(&handler, &partition, &gap_delta(2, 4));
        assert_continuation_without_wake(&resume_with_gap);
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            2,
            "resume does not restart and overwrite its cursor in the same invocation"
        );

        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            3,
            "the deferred gap starts on the following invocation"
        );
    }

    #[test]
    fn gap_only_delivery_after_park_does_not_keep_writing_residue_wakes() {
        let partition = PartitionKey::hash_from("partition:gap-only-wake");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![
                live_state_reply(
                    vec![(FactAddress::hash_from("record:first"), "1f:first", vec![])],
                    Some(1),
                ),
                live_state_reply(
                    vec![(FactAddress::hash_from("record:last"), "1f:last", vec![])],
                    None,
                ),
                live_state_reply(vec![], None),
            ],
        );

        let wake_address = FactAddress::hash_from("trigger-engine.catch-up-pending");
        let first = handle_delta(&handler, &partition, &gap_delta(1, 2));
        assert_continuation_without_wake(&first);
        let resumed = handle_delta(&handler, &partition, &gap_delta(2, 3));
        assert_continuation_without_wake(&resumed);
        for cursor in 3..100 {
            let outcome = handle_delta(&handler, &partition, &gap_delta(cursor, cursor + 1));
            assert!(
                outcome
                    .failure_writes
                    .iter()
                    .all(|write| write.address != wake_address),
                "continuous gaps must not make the trigger write another wake"
            );
        }
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            3,
            "one extra scan drains the residue even when its wake arrives with a gap"
        );
    }

    #[test]
    fn interleaved_gapless_continuation_does_not_restart_the_full_scan() {
        let partition = PartitionKey::hash_from("partition:interleaved-continuation");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![
                live_state_reply(
                    vec![(FactAddress::hash_from("record:first"), "1f:first", vec![])],
                    Some(1),
                ),
                live_state_reply(
                    vec![(FactAddress::hash_from("record:last"), "1f:last", vec![])],
                    None,
                ),
                live_state_reply(vec![], None),
            ],
        );
        let wake_address = FactAddress::hash_from("trigger-engine.catch-up-pending");
        let gapless_continuation = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![slot_protocol::WireAssert {
                address: hex::encode(wake_address.as_multihash().encode()),
                content_hash: "1f:wake".to_string(),
                path: vec![catch_up_pending_path_segment_wire_hex().to_string()],
                content: Some(STANDARD.encode(b"{}")),
            }],
            retracts: vec![],
            gap: None,
        };
        let first = handle_delta(&handler, &partition, &gap_delta(1, 2));
        let second = handle_delta(&handler, &partition, &gap_delta(2, 3));
        assert_continuation_without_wake(&first);
        assert_continuation_without_wake(&second);
        let residue = handle_delta(&handler, &partition, &gapless_continuation);
        assert!(residue
            .failure_writes
            .iter()
            .all(|write| write.address != wake_address));

        for cursor in 3..30 {
            let gap = handle_delta(&handler, &partition, &gap_delta(cursor, cursor + 1));
            let continuation = handle_delta(&handler, &partition, &gapless_continuation);
            assert!(gap
                .failure_writes
                .iter()
                .all(|write| write.address != wake_address));
            assert!(continuation
                .failure_writes
                .iter()
                .all(|write| write.address != wake_address));
        }
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            3,
            "internal gapless continuations must not begin another whole-store pass"
        );
    }

    #[test]
    fn empty_continuations_between_gap_only_deliveries_do_not_restart_scan() {
        let partition = PartitionKey::hash_from("partition:empty-continuation");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![
                live_state_reply(
                    vec![(FactAddress::hash_from("record:first"), "1f:first", vec![])],
                    Some(1),
                ),
                live_state_reply(
                    vec![(FactAddress::hash_from("record:last"), "1f:last", vec![])],
                    None,
                ),
                live_state_reply(vec![], None),
            ],
        );
        let empty = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        handle_delta(&handler, &partition, &gap_delta(2, 3));
        handle_delta(&handler, &partition, &empty);
        for cursor in 3..30 {
            handle_delta(&handler, &partition, &gap_delta(cursor, cursor + 1));
            handle_delta(&handler, &partition, &empty);
        }
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            3,
            "empty continuations must not make each gap start a new full scan"
        );
    }

    #[test]
    fn failed_changed_read_does_not_advance_hash_and_same_hash_retries() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let rule = runtime_loaded_rule("trigger:retry-read", "slot::target-alpha", "p1");
        let rule_address = FactAddress::hash_from("trigger:retry-read");
        talk.insert_response("slot::target-alpha", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(&rule_address, &rule)],
                retracts: vec![],
                gap: None,
            },
        );
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let record = FactAddress::hash_from("record:retry-read");
        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![(record.clone(), "old-content-hash", vec![])],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);

        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![
                    (
                        rule_address.clone(),
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (record.clone(), "test-content-hash", vec![]),
                ],
                None,
            )],
        );
        let failed = handle_delta(&handler, &partition, &gap_delta(1, 2));
        assert!(failed.failure_writes.iter().any(|write| {
            write
                .address
                .to_string()
                .contains("content-resolution-failure")
                || write
                    .path
                    .iter()
                    .any(|segment| segment == &PathSegment::hash_from("content-resolution-failure"))
        }));
        handle_delta(&handler, &partition, &quiet);

        talk.insert_raw_sequence(
            live,
            vec![live_state_reply(
                vec![
                    (
                        rule_address,
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (record.clone(), "test-content-hash", vec![]),
                ],
                None,
            )],
        );
        talk.insert_response_at(
            record,
            json!({"properties":{"event_type":"runtime_loaded"}}),
        );
        handle_delta(&handler, &partition, &gap_delta(2, 3));
        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
                .count(),
            1,
            "unchanged scanned hash retries after the earlier direct-read failure"
        );
    }

    #[test]
    fn missed_rule_retraction_removes_the_rule_after_full_scan() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let rule_address = FactAddress::hash_from("trigger:removed-in-gap");
        let rule = runtime_loaded_rule("trigger:removed-in-gap", "slot::target-alpha", "p1");
        talk.insert_response("slot::target-alpha", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(&rule_address, &rule)],
                retracts: vec![],
                gap: None,
            },
        );
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![(
                    rule_address.clone(),
                    "test-content-hash",
                    vec![trigger_rule_path_segment_wire_hex().to_string()],
                )],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);

        talk.remove_current_rule(&rule_address);
        talk.insert_raw_sequence(live, vec![live_state_reply(vec![], None)]);
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        let event = json!({"properties":{"event_type":"runtime_loaded"}});
        handle_delta(
            &handler,
            &partition,
            &delta_for(&FactAddress::hash_from("record:after-remove"), &event),
        );
        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
                .count(),
            0,
            "a rule absent from the completed current scan is no longer active"
        );
    }

    #[test]
    fn missing_rule_is_validated_before_an_earlier_page_changed_record_dispatches() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let rule_address = FactAddress::hash_from("trigger:removed-before-final-dispatch");
        let record_address = FactAddress::hash_from("record:changed-on-final-page");
        let rule = runtime_loaded_rule(
            "trigger:removed-before-final-dispatch",
            "slot::target-alpha",
            "p1",
        );
        talk.insert_response("slot::target-alpha", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(&rule_address, &rule)],
                retracts: vec![],
                gap: None,
            },
        );

        // Baseline: both the rule and record are current.
        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![
                    (
                        rule_address.clone(),
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (record_address.clone(), "1f:old", vec![]),
                ],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );

        // During the gap, the rule is retracted and X changes. X is on page 1;
        // only the empty final page proves R absent from the whole data scan.
        // The separate current-rule validation must evict R before page 1.
        talk.remove_current_rule(&rule_address);
        talk.insert_raw_sequence(
            live,
            vec![
                live_state_reply(
                    vec![(record_address.clone(), "test-content-hash", vec![])],
                    Some(1),
                ),
                live_state_reply(vec![], None),
            ],
        );
        talk.insert_response_at(
            record_address,
            json!({"properties":{"event_type":"runtime_loaded"}}),
        );
        talk.sent.lock().unwrap().clear();
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );

        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
                .count(),
            0,
            "a rule absent from current rule state cannot dispatch a changed record from an earlier data page"
        );
    }

    #[test]
    fn nested_rule_membership_validation_parks_before_any_data_scan() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);

        for index in 0..17 {
            let address = FactAddress::hash_from(&format!("trigger:paged-validation-{index}"));
            let rule = runtime_loaded_rule(
                &format!("trigger:paged-validation-{index}"),
                "slot::target-alpha",
                "p1",
            );
            handle_delta(
                &handler,
                &partition,
                &DeltaPayload {
                    kind: "delta".to_string(),
                    asserts: vec![rule_assert(&address, &rule)],
                    retracts: vec![],
                    gap: None,
                },
            );
        }

        talk.insert_raw_sequence(live.clone(), vec![live_state_reply(vec![], None)]);
        let first = handle_delta(&handler, &partition, &gap_delta(10, 11));
        let first_response: Value = serde_json::from_slice(&first.response).unwrap();
        assert!(first_response["dispatch_failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["kind"] == json!("catch-up-pending")
                    && failure["rule_cursor"] == json!(16)
                    && failure["rule_scanned_total"] == json!(16)
            }));
        assert_eq!(
            talk.raw_sequences
                .lock()
                .unwrap()
                .get(&live)
                .map(|replies| replies.len()),
            Some(1),
            "the data scan must remain parked until the complete current-rule snapshot is validated"
        );

        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );
        assert_eq!(
            talk.raw_sequences
                .lock()
                .unwrap()
                .get(&live)
                .map(|replies| replies.len()),
            Some(0),
            "the data scan starts only after the nested-path rule validation finishes"
        );
    }

    #[test]
    fn rule_deleted_between_validation_pages_is_refused_at_effect() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let mut rules = Vec::new();

        for index in 0..17 {
            let address = FactAddress::hash_from(&format!("trigger:validation-race-{index}"));
            let target = format!("slot::validation-race-target-{index}");
            let rule =
                runtime_loaded_rule(&format!("trigger:validation-race-{index}"), &target, "p1");
            talk.insert_response(&target, json!({"status":"ok"}));
            handle_delta(
                &handler,
                &partition,
                &DeltaPayload {
                    kind: "delta".to_string(),
                    asserts: vec![rule_assert(&address, &rule)],
                    retracts: vec![],
                    gap: None,
                },
            );
            rules.push((address, target));
        }
        rules.sort_by_key(|(address, _)| address.to_string());
        let (deleted_rule, deleted_target) = rules[0].clone();

        // Seed an empty baseline after the two-page rule discovery pass.
        talk.insert_raw_sequence(live.clone(), vec![live_state_reply(vec![], None)]);
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);
        handle_delta(&handler, &partition, &quiet);

        // The next validation page 1 observes R and parks. R disappears before
        // page 2, whose non-snapshot cursor cannot revisit the earlier slot.
        let record = FactAddress::hash_from("record:validation-race-change-a");
        let second_record = FactAddress::hash_from("record:validation-race-change-b");
        talk.insert_raw_sequence(
            live,
            vec![live_state_reply(
                vec![
                    (record.clone(), "test-content-hash", vec![]),
                    (second_record.clone(), "test-content-hash", vec![]),
                ],
                None,
            )],
        );
        talk.insert_response_at(
            record,
            json!({"properties":{"event_type":"runtime_loaded"}}),
        );
        talk.insert_response_at(
            second_record,
            json!({"properties":{"event_type":"runtime_loaded"}}),
        );
        talk.sent.lock().unwrap().clear();
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        talk.remove_current_rule(&deleted_rule);
        handle_delta(&handler, &partition, &quiet);

        let sent = talk.sent.lock().unwrap();
        assert!(
            !sent.iter()
                .any(|(address, _)| *address == FactAddress::hash_from(&deleted_target)),
            "a deleted rule must fail both the first current check and the same page's later stale clone"
        );
        assert!(
            sent.iter().any(|(address, _)| {
                rules
                    .iter()
                    .skip(1)
                    .any(|(_, target)| *address == FactAddress::hash_from(target))
            }),
            "the changed record still reaches rules that remain current"
        );
    }

    #[test]
    fn newly_rehydrated_recovery_rule_must_still_be_current_at_effect() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let rule_address = FactAddress::hash_from("trigger:rehydrated-then-removed");
        let old_rule =
            runtime_loaded_rule("trigger:rehydrated-then-removed", "slot::old-target", "p1");
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(&rule_address, &old_rule)],
                retracts: vec![],
                gap: None,
            },
        );

        talk.insert_raw_sequence(live.clone(), vec![live_state_reply(vec![], None)]);
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);

        let new_target = "slot::new-target";
        let new_rule = runtime_loaded_rule("trigger:rehydrated-then-removed", new_target, "p1");
        talk.insert_response(new_target, json!({"status":"ok"}));
        talk.current_rules.lock().unwrap().insert(
            rule_address.clone(),
            (
                "hash:new-rule".to_string(),
                trigger_rule_path(),
                serde_json::to_vec(&new_rule).unwrap(),
            ),
        );
        // The validation direct read returns the new bytes, then the mock
        // removes the authoritative rule before the changed record effects.
        talk.remove_current_rule_after_next_read(rule_address.clone());
        let record = FactAddress::hash_from("record:after-rehydrated-rule-removal");
        talk.insert_raw_sequence(
            live,
            vec![live_state_reply(
                vec![(record.clone(), "test-content-hash", vec![])],
                None,
            )],
        );
        talk.insert_response_at(
            record,
            json!({"properties":{"event_type":"runtime_loaded"}}),
        );
        talk.sent.lock().unwrap().clear();
        handle_delta(&handler, &partition, &gap_delta(1, 2));

        assert!(
            !talk
                .sent
                .lock()
                .unwrap()
                .iter()
                .any(|(address, _)| *address == FactAddress::hash_from(new_target)),
            "a newly hydrated rule that disappears before effect must remain verification-required and refuse"
        );
        assert!(handler
            .state
            .lock()
            .unwrap()
            .active_delta_rules()
            .is_empty());
    }

    #[test]
    fn rule_added_after_baseline_becomes_a_missing_retraction_candidate() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };

        // Establish the empty baseline first, then admit a rule through the
        // ordinary delivered-delta path (not through catch-up).
        talk.insert_raw_sequence(live.clone(), vec![live_state_reply(vec![], None)]);
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(&handler, &partition, &quiet);

        let rule_address = FactAddress::hash_from("trigger:added-after-baseline");
        let rule = runtime_loaded_rule("trigger:added-after-baseline", "slot::target-alpha", "p1");
        talk.insert_response("slot::target-alpha", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![rule_assert(&rule_address, &rule)],
                retracts: vec![],
                gap: None,
            },
        );

        // The rule vanished during the missed interval. A complete empty scan
        // must remove it even though it was added after the original baseline.
        talk.remove_current_rule(&rule_address);
        talk.insert_raw_sequence(live, vec![live_state_reply(vec![], None)]);
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        handle_delta(
            &handler,
            &partition,
            &runtime_loaded_delta(&FactAddress::hash_from("record:after-rule-vanished")),
        );

        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-alpha"))
                .count(),
            0,
            "a post-baseline rule must be removed when the next complete scan no longer sees it"
        );
    }

    #[test]
    fn delivered_retraction_during_scan_is_not_synthesized_again_at_completion() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        let rule_address = FactAddress::hash_from("trigger:retraction-once");
        let record_address = FactAddress::hash_from("record:retracted-during-scan");
        let rule: TriggerRule = serde_json::from_value(json!({
            "id": "trigger:retraction-once",
            "topic": "retraction",
            "trigger_type": "delta",
            "is_active": true,
            "match_condition": {
                "$kind": "binding",
                "select": { "from": "envelope", "path": "is_retraction" },
                "transform": [{ "op": "op:core.equals", "args": { "value": true } }]
            },
            "dispatch": {
                "target": "slot::target-retraction",
                "output_template": { "operation": "record-retraction" }
            }
        }))
        .unwrap();
        talk.insert_response("slot::target-retraction", json!({"status":"ok"}));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![
                    rule_assert(&rule_address, &rule),
                    delta_for(&record_address, &json!({"kind":"record"})).asserts[0].clone(),
                ],
                retracts: vec![],
                gap: None,
            },
        );

        // Seed a complete baseline containing both current addresses.
        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![
                    (
                        rule_address.clone(),
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    ),
                    (record_address.clone(), "hash:test", vec![]),
                ],
                None,
            )],
        );
        handle_delta(&handler, &partition, &gap_delta(0, 1));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );

        // A later scan parks while both addresses are still candidates. The
        // real retraction arrives before the final page, which still contains
        // the rule but not the record.
        talk.insert_raw_sequence(
            live,
            vec![
                live_state_reply(vec![], Some(1)),
                live_state_reply(
                    vec![(
                        rule_address,
                        "hash:rule",
                        vec![trigger_rule_path_segment_wire_hex().to_string()],
                    )],
                    None,
                ),
            ],
        );
        handle_delta(&handler, &partition, &gap_delta(1, 2));
        handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![hex::encode(record_address.as_multihash().encode())],
                gap: None,
            },
        );

        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| {
                    *address == FactAddress::hash_from("slot::target-retraction")
                })
                .count(),
            1,
            "the delivered retraction fires once; scan completion must not synthesize it again"
        );
    }

    #[test]
    fn scan_cap_counts_rows_across_resumed_invocations() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        {
            let mut state = handler.state.lock().unwrap();
            let baseline_existed = state.begin_scan();
            state.park_scan(GapScanProgress {
                cursor: 9,
                baseline_existed,
                scanned_total: GAP_CATCH_UP_SCAN_CAP - 1,
                rules_validated: true,
                rule_cursor: 0,
                rule_scanned_total: 0,
                rule_validation_started: false,
                wake_revision: 0,
            });
        }
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(
            live.clone(),
            vec![live_state_reply(
                vec![
                    (FactAddress::hash_from("record:cap-a"), "1f:aa", vec![]),
                    (FactAddress::hash_from("record:cap-b"), "1f:bb", vec![]),
                ],
                Some(10),
            )],
        );
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        let capped = handle_delta(&handler, &partition, &quiet);
        let response: Value = serde_json::from_slice(&capped.response).unwrap();
        assert!(response["dispatch_failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["phase"] == json!("catch-up-truncated")
                    && failure["scanned"] == json!(GAP_CATCH_UP_SCAN_CAP)
            }));
        handle_delta(&handler, &partition, &quiet);
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            1,
            "the total cap abandons continuation instead of resetting per invocation"
        );
    }

    #[test]
    fn rule_validation_cap_abandons_without_dispatch_and_disables_unproven_rules() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        for index in 0..2 {
            let address = FactAddress::hash_from(&format!("trigger:validation-cap-{index}"));
            let rule = runtime_loaded_rule(
                &format!("trigger:validation-cap-{index}"),
                "slot::target-alpha",
                "p1",
            );
            handle_delta(
                &handler,
                &partition,
                &DeltaPayload {
                    kind: "delta".to_string(),
                    asserts: vec![rule_assert(&address, &rule)],
                    retracts: vec![],
                    gap: None,
                },
            );
        }
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk.insert_raw_sequence(live.clone(), vec![live_state_reply(vec![], None)]);
        {
            let mut state = handler.state.lock().unwrap();
            let baseline_existed = state.begin_scan();
            state.park_scan(GapScanProgress {
                cursor: 0,
                baseline_existed,
                scanned_total: 0,
                rules_validated: false,
                rule_cursor: 0,
                rule_scanned_total: GAP_CATCH_UP_SCAN_CAP - 1,
                rule_validation_started: false,
                wake_revision: 0,
            });
        }

        let outcome = handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                asserts: vec![],
                retracts: vec![],
                gap: None,
            },
        );
        let response: Value = serde_json::from_slice(&outcome.response).unwrap();
        assert!(response["dispatch_failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["phase"] == json!("catch-up-rule-validation-truncated")
                    && failure["scanned"] == json!(GAP_CATCH_UP_SCAN_CAP)
            }));
        assert!(outcome.failure_writes.iter().all(|write| {
            write.address != FactAddress::hash_from("trigger-engine.catch-up-pending")
        }));
        assert_eq!(
            talk.raw_sequences
                .lock()
                .unwrap()
                .get(&live)
                .map(|replies| replies.len()),
            Some(1),
            "truncated rule validation must not enter the recovered data scan"
        );
        assert_eq!(
            handler.state.lock().unwrap().active_delta_rules().len(),
            1,
            "a cached rule beyond the validated bound is disabled rather than left stale"
        );
    }

    /// A failed live-state scan is returned and reparks the SAME cursor with a
    /// durable wake, rather than consuming the cursor and suppressing retry.
    #[test]
    fn gap_catch_up_scan_failure_is_returned_without_durable_exhaust() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk_to_other_slots = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk_to_other_slots));

        // NO live-state response registered → the scan dispatch fails.
        let outcome = handle_delta(&handler, &partition, &gap_delta(3, 7));

        assert_continuation_without_wake(&outcome);
        let response: Value = serde_json::from_slice(&outcome.response).unwrap();
        let failures = response["dispatch_failures"].as_array().unwrap();
        assert!(failures
            .iter()
            .any(|failure| failure["phase"] == json!("delta-delivery")));
        assert!(failures
            .iter()
            .any(|failure| failure["phase"] == json!("catch-up-scan")));

        // The next payload retries cursor 0 and can complete the first baseline.
        let live_state_address = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        talk_to_other_slots.insert_raw_sequence(
            live_state_address.clone(),
            vec![live_state_reply(vec![], None)],
        );
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        handle_delta(&handler, &partition, &quiet);
        let queries = talk_to_other_slots
            .queried
            .lock()
            .unwrap()
            .iter()
            .filter(|address| **address == live_state_address)
            .count();
        assert_eq!(queries, 2, "failed cursor is retried, not consumed");
    }

    #[test]
    fn failed_scan_retries_in_memory_without_writing_to_the_feed() {
        let partition = PartitionKey::hash_from("partition:test");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));

        // No live-state response: initial catch-up fails and asks its caller
        // for a fresh invocation, without mutating the subscribed log.
        let first = handle_delta(&handler, &partition, &gap_delta(8, 9));
        assert_continuation_without_wake(&first);
        let quiet = DeltaPayload {
            kind: "delta".to_string(),
            asserts: vec![],
            retracts: vec![],
            gap: None,
        };
        let retry = handle_delta(&handler, &partition, &quiet);
        assert_continuation_without_wake(&retry);
        let live = FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS);
        assert_eq!(
            talk.queried
                .lock()
                .unwrap()
                .iter()
                .filter(|address| **address == live)
                .count(),
            2,
            "the failed cursor was retried in a fresh invocation"
        );
    }

    #[test]
    fn correlated_dispatch_outcomes_are_durable_and_fail_closed() {
        let partition = PartitionKey::hash_from("partition:test");
        let outcomes = vec![
            json!({
                "kind": "trigger-dispatch-outcome",
                "status": "succeeded",
                "rule_id": "trigger:any",
                "attempt_ref": "hash:attempt-a",
                "attempt": 1,
                "correlation": { "request_id": "request:one" },
                "dispatch": { "operation": "any" },
                "failure": null,
            }),
            json!({
                "kind": "trigger-dispatch-outcome",
                "status": "failed",
                "rule_id": "trigger:any",
                "attempt_ref": "hash:attempt-b",
                "attempt": 2,
                "correlation": { "request_id": "request:two" },
                "dispatch": null,
                "failure": { "phase": "dispatch", "error": "target unavailable" },
            }),
            // Missing correlation is allowed (it is optional rule DATA), but
            // missing identity is not: an outcome without stable rule/attempt
            // identity must never become an unaddressable durable fact.
            json!({ "kind": "trigger-dispatch-outcome", "status": "failed" }),
        ];

        let writes = dispatch_outcome_writes(&partition, &outcomes);
        assert_eq!(writes.len(), 2, "identity-less outcome fails closed");
        let payloads = writes
            .iter()
            .map(|write| serde_json::from_slice::<Value>(write.payload.as_ref().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert!(payloads.iter().any(|payload| {
            payload["status"] == "succeeded"
                && payload["correlation"]["request_id"] == "request:one"
                && payload["dispatch"]["operation"] == "any"
        }));
        assert!(payloads.iter().any(|payload| {
            payload["status"] == "failed"
                && payload["correlation"]["request_id"] == "request:two"
                && payload["failure"]["phase"] == "dispatch"
        }));
        assert!(writes.iter().all(|write| {
            write.path
                == vec![
                    PathSegment::hash_from("current-item"),
                    PathSegment::hash_from("trigger-dispatch-outcome"),
                ]
        }));
        let replay_writes = dispatch_outcome_writes(&partition, &outcomes);
        assert_eq!(
            writes
                .iter()
                .map(|write| write.address.clone())
                .collect::<Vec<_>>(),
            replay_writes
                .iter()
                .map(|write| write.address.clone())
                .collect::<Vec<_>>(),
            "replaying an identical outcome overwrites the same current-item fact"
        );
    }

    #[test]
    fn bounded_retry_stops_on_success_and_replay_is_idempotent() {
        let partition = PartitionKey::hash_from("partition:retry");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        talk.insert_dispatch_sequence(
            "slot::target-retry",
            vec![
                Err("transient".to_string()),
                Ok(json!({ "accepted": true })),
            ],
        );
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let mut rule = runtime_loaded_rule("trigger:retry", "slot::target-retry", "retry-payload");
        rule.dispatch.max_attempts = Some(2);
        rule.dispatch.outcome_correlation_template = Some(json!({
            "request_id": { "$kind": "binding", "select": { "from": "change", "path": "request_id" } }
        }));
        let rule_address = FactAddress::hash_from("trigger:retry");
        let _ = handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                gap: None,
                retracts: vec![],
                asserts: vec![rule_assert(&rule_address, &rule)],
            },
        );
        let event = delta_for(
            &FactAddress::hash_from("record:retry"),
            &json!({
                "properties": { "event_type": "runtime_loaded" }, "request_id": "request:retry"
            }),
        );
        let first = handle_delta(&handler, &partition, &event);
        assert!(
            first.failure_writes.is_empty(),
            "recovered retry has no terminal diagnostic: {:?}",
            String::from_utf8_lossy(&first.response)
        );
        assert_eq!(
            first.outcome_writes.len(),
            2,
            "one failed attempt then one success"
        );
        let attempts = first
            .outcome_writes
            .iter()
            .map(|write| serde_json::from_slice::<Value>(write.payload.as_ref().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert!(attempts
            .iter()
            .any(|value| value["status"] == "failed" && value["attempt"] == 1));
        assert!(attempts
            .iter()
            .any(|value| value["status"] == "succeeded" && value["attempt"] == 2));
        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == FactAddress::hash_from("slot::target-retry"))
                .count(),
            2
        );
    }

    #[test]
    fn bounded_retry_records_only_terminal_failure_at_max_attempt() {
        let partition = PartitionKey::hash_from("partition:retry-max");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let mut rule =
            runtime_loaded_rule("trigger:retry-max", "slot::missing-retry", "retry-payload");
        rule.dispatch.max_attempts = Some(2);
        let rule_address = FactAddress::hash_from("trigger:retry-max");
        let _ = handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                gap: None,
                retracts: vec![],
                asserts: vec![rule_assert(&rule_address, &rule)],
            },
        );
        let outcome = handle_delta(
            &handler,
            &partition,
            &runtime_loaded_delta(&FactAddress::hash_from("record:retry-max")),
        );
        assert_eq!(outcome.outcome_writes.len(), 2);
        assert_eq!(
            outcome.failure_writes.len(),
            1,
            "only exhausted retry produces legacy terminal diagnostic"
        );
        let terminal: Value =
            serde_json::from_slice(outcome.outcome_writes[1].payload.as_ref().unwrap()).unwrap();
        assert_eq!(terminal["status"], "failed");
        assert_eq!(terminal["attempt"], 2);
    }

    #[test]
    fn dispatch_delivery_defaults_to_inline_and_parses_generic_later_mode() {
        let inherited = runtime_loaded_rule("trigger:inline", "slot::target", "inline");
        assert_eq!(
            inherited.dispatch.delivery,
            RuleDispatchDelivery::Inline,
            "existing rule DATA must remain inline without an opt-in field"
        );
        assert_eq!(inherited.dispatch.attempt_limit(), 1);
        assert_eq!(inherited.dispatch.accepted_status(), "succeeded");

        let later = serde_json::from_value::<TriggerRule>(json!({
            "id": "trigger:send-later",
            "match_condition": {
                "conditions": [{
                    "$bind": {
                        "select": { "from": "change", "path": "properties.event_type" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "runtime_loaded" } }]
                    }
                }]
            },
            "dispatch": {
                "target": "slot::slow-target",
                "output_template": { "operation": "sample-operation" },
                "delivery": "later_with_durable_outcome",
                "max_attempts": 3
            }
        }))
        .expect("generic delivery DATA should parse");
        assert_eq!(
            later.dispatch.delivery,
            RuleDispatchDelivery::LaterWithDurableOutcome
        );
        assert_eq!(
            later.dispatch.attempt_limit(),
            1,
            "a durable request identity must not be synchronously retried"
        );
        assert_eq!(later.dispatch.accepted_status(), "accepted");
    }

    #[test]
    fn send_later_dispatch_accepts_once_and_does_not_synchronously_retry() {
        let partition = PartitionKey::hash_from("partition:send-later");
        let talk = Arc::new(MockTalkToOtherSlots::default());
        talk.insert_dispatch_sequence(
            "slot::send-later-target",
            vec![
                Ok(json!({ "kind": "send-later-request", "request_hash": "1f:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
                Ok(json!({ "kind": "send-later-request", "request_hash": "must-not-run" })),
            ],
        );
        let handler = TriggerHandler::new(Arc::clone(&talk));
        let mut rule = runtime_loaded_rule(
            "trigger:send-later",
            "slot::send-later-target",
            "send-later-payload",
        );
        rule.dispatch.delivery = RuleDispatchDelivery::LaterWithDurableOutcome;
        rule.dispatch.max_attempts = Some(3);
        let rule_address = FactAddress::hash_from("trigger:send-later");
        let _ = handle_delta(
            &handler,
            &partition,
            &DeltaPayload {
                kind: "delta".to_string(),
                gap: None,
                retracts: vec![],
                asserts: vec![rule_assert(&rule_address, &rule)],
            },
        );

        let outcome = handle_delta(
            &handler,
            &partition,
            &runtime_loaded_delta(&FactAddress::hash_from("record:send-later")),
        );
        assert!(
            outcome.failure_writes.is_empty(),
            "accepted send-later submission is not a synchronous dispatch failure: {:?}",
            String::from_utf8_lossy(&outcome.response)
        );
        assert_eq!(outcome.outcome_writes.len(), 1);
        let durable: Value =
            serde_json::from_slice(outcome.outcome_writes[0].payload.as_ref().unwrap()).unwrap();
        assert_eq!(durable["status"], json!("accepted"));
        assert_eq!(durable["attempt"], json!(1));
        assert_eq!(
            durable["delivery_receipt"]["request_hash"],
            json!("1f:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            durable["dispatch"],
            json!({"operation":"sample-operation", "payload_id":"send-later-payload"})
        );

        let target = FactAddress::hash_from("slot::send-later-target");
        assert_eq!(
            talk.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == target)
                .count(),
            1,
            "one durable request identity suppresses all synchronous retries"
        );
        assert_eq!(
            talk.deliveries
                .lock()
                .unwrap()
                .iter()
                .filter(|(address, _)| *address == target)
                .map(|(_, delivery)| *delivery)
                .collect::<Vec<_>>(),
            vec![ReplyDelivery::LaterWithDurableOutcome]
        );
    }
}
