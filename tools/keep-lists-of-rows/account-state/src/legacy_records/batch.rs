//! Exact selected stored records over one already admitted original snapshot.
//! Checkpoint point transport and canonical tail replay are each shared across
//! the bounded requested IDs; original per-record projection and answer rules
//! still own the returned records.

use super::*;
use std::collections::{BTreeMap, VecDeque};

struct PendingEntries(VecDeque<Entry>);
impl Drop for PendingEntries {
    fn drop(&mut self) {
        for entry in &mut self.0 {
            if let Entry::Json(value) = entry {
                value.zeroize();
            }
        }
    }
}
struct Prepared(Vec<Option<StoredRecord>>);
impl Drop for Prepared {
    fn drop(&mut self) {
        for record in self.0.iter_mut().flatten() {
            record.id.zeroize();
            record.record_type.zeroize();
            record.sequence.zeroize();
            record.value_json.zeroize();
            if let Some(meta) = &mut record.meta_json {
                meta.zeroize();
            }
        }
    }
}

impl<S: BoundedRecordSql> LegacyRecords<S> {
    /// Batch only the exact checkpoint keys. Every ID still uses the canonical
    /// checkpoint decoder, projection state machine and answer bounds. One
    /// canonical transaction reader validates and replays the shared tail.
    /// The supplied source enforces the physical operation-wide SQL allowance.
    pub fn read_stored_batch(
        &mut self,
        ids: &[String],
        kept: &LegacyKept,
    ) -> Result<Vec<Option<StoredRecord>>> {
        if ids.len() > 256 || ids.iter().any(|id| !valid_id(id)) {
            return Err(crate::cause!(Error::Invalid));
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.last_diagnostic = None;
        self.last_timing = ReadTiming::default();
        let mut meter = Meter::new(&self.bounds);
        let collected = (|| {
            if detect(&mut self.original, &mut meter)? != Engine::RecordLog {
                return Err(crate::cause!(Error::WrongEngine));
            }
            // The check is one property of the retained snapshot, not of an
            // individual record. Read it once for the whole selected batch;
            // each record still runs canonical checkpoint decoding, replay,
            // answer validation and the final source check below.
            let frontier = projection_frontier(&mut self.original, &mut meter)?;
            let keys = ids.iter().map(|id| format!("i\0{id}")).collect::<Vec<_>>();
            let points = kept
                .points_with_budget(&mut self.original, &keys, meter.remaining_point_budget())
                .map_err(|error| meter.kept_failure(&error))?;
            meter.last_kept_work = Some(points.work.clone());
            meter.timing.point(&points.work);
            meter.rows = meter
                .rows
                .saturating_add(points.work.rows_returned as usize);
            meter.bytes = meter
                .bytes
                .saturating_add(points.work.source_bytes as usize);
            meter.statements = meter
                .statements
                .saturating_add(points.work.sql_statements as usize);
            meter.check_at("kept-batch-budget")?;
            Ok((frontier, points))
        })();
        let (frontier, mut points) = match collected {
            Ok(points) => points,
            Err(error) => {
                meter.timing.elapsed_us =
                    meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                self.last_timing = meter.timing;
                self.last_diagnostic = meter.diagnostic;
                return Err(error);
            }
        };
        let prepared = (|| {
            if points.entries.len() != ids.len() {
                return Err(crate::cause!(Error::Corrupt));
            }
            let mut pending = PendingEntries(points.entries.drain(..).collect());
            // Compact pointers keep the record payload under a second exact
            // checkpoint key. Resolve those keys from already-validated root
            // pointers, then batch their value reads instead of issuing one
            // checkpoint point query from each canonical decode.
            let mut value_keys = Vec::new();
            let mut value_key_slots = vec![None; ids.len()];
            for (index, (id, entry)) in ids.iter().zip(&pending.0).enumerate() {
                if let Some(key) = checkpoint_external_value_key(id, entry)? {
                    value_key_slots[index] = Some(value_keys.len());
                    value_keys.push(key);
                }
            }
            let pending_values = if value_keys.is_empty() {
                PendingEntries(VecDeque::new())
            } else {
                let mut value_points = kept
                    .points_with_budget(
                        &mut self.original,
                        &value_keys,
                        meter.remaining_point_budget(),
                    )
                    .map_err(|error| meter.kept_failure(&error))?;
                meter.last_kept_work = Some(value_points.work.clone());
                meter.timing.point(&value_points.work);
                meter.rows = meter
                    .rows
                    .saturating_add(value_points.work.rows_returned as usize);
                meter.bytes = meter
                    .bytes
                    .saturating_add(value_points.work.source_bytes as usize);
                meter.statements = meter
                    .statements
                    .saturating_add(value_points.work.sql_statements as usize);
                meter.check_at("kept-batch-values-budget")?;
                if value_points.entries.len() != value_keys.len() {
                    return Err(crate::cause!(Error::Corrupt));
                }
                PendingEntries(value_points.entries.drain(..).collect())
            };
            let mut projections = Vec::with_capacity(ids.len());
            let mut positions = BTreeMap::<&str, Vec<usize>>::new();
            for (index, id) in ids.iter().enumerate() {
                let entry = pending.0.pop_front().ok_or(crate::cause!(Error::Corrupt))?;
                let prefetched_value = value_key_slots[index]
                    .map(|slot| {
                        Ok((
                            value_keys.get(slot).cloned().ok_or(crate::cause!(Error::Corrupt))?,
                            pending_values.0.get(slot).cloned().ok_or(crate::cause!(Error::Corrupt))?,
                        ))
                    })
                    .transpose()?;
                projections.push(checkpoint_entry_with_prefetched_value(
                    &mut self.original,
                    &mut meter,
                    id,
                    kept,
                    entry,
                    prefetched_value,
                )?);
                positions.entry(id.as_str()).or_default().push(index);
            }
            if !pending.0.is_empty() {
                return Err(crate::cause!(Error::Corrupt));
            }
            let (covered, last, has_keys) = frontier;
            if last > covered {
                let selected_ids = ids.iter().map(String::as_str).collect::<Vec<_>>();
                ids::replay_transactions_for_ids(
                    &mut self.original,
                    &self.source_limits,
                    &mut meter,
                    Some(&selected_ids),
                    covered,
                    last,
                    has_keys,
                    |_, meter, row_id, envelopes, key_present| {
                        for id in key_present {
                            if let Some(indices) = positions.get(id.as_str()) {
                                for index in indices {
                                    projections[*index].protected = true;
                                }
                            }
                        }
                        for (part, envelope) in envelopes.iter().enumerate() {
                            meter.check_at("record-dirty-replay-budget")?;
                            let object = raw_object(envelope.get())?;
                            let id = raw_text(&object, "id")?.ok_or(crate::cause!(Error::Corrupt))?;
                            if !valid_id(&id) {
                                return Err(crate::cause!(Error::Corrupt));
                            }
                            if let Some(indices) = positions.get(id.as_str()) {
                                for index in indices {
                                    projections[*index].apply_selected(
                                        &id,
                                        row_id,
                                        part,
                                        &object,
                                    )?;
                                }
                            }
                        }
                        Ok(())
                    },
                )?;
            }
            let mut prepared = Prepared(Vec::with_capacity(ids.len()));
            let mut bytes = 0usize;
            for (index, id) in ids.iter().enumerate() {
                let projection = projections.get_mut(index).ok_or(crate::cause!(Error::Corrupt))?;
                let result = std::mem::take(projection)
                    .answer(id, &self.bounds)
                    .map_err(|error| {
                        if matches!(error, Error::Bounds(_)) {
                            meter.bounds_failure(
                                "record-answer-budget",
                                "original record answer materialization exceeded bounds",
                            )
                        } else {
                            error
                        }
                    })?;
                if let Some(record) = &result {
                    let size = record
                        .id
                        .len()
                        .saturating_add(record.record_type.len())
                        .saturating_add(record.sequence.len())
                        .saturating_add(record.value_json.len())
                        .saturating_add(record.meta_json.as_ref().map_or(0, String::len));
                    bytes = bytes.checked_add(size).ok_or(crate::cause!(Error::Bounds))?;
                    if bytes > self.bounds.bytes {
                        return Err(crate::cause!(Error::Bounds));
                    }
                }
                meter.check_at("record-complete-budget")?;
                prepared.0.push(result);
            }
            Ok(prepared)
        })();
        meter.timing.elapsed_us = meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.last_timing = meter.timing;
        self.last_diagnostic = meter.diagnostic;
        let mut prepared = prepared?;
        // The batch entered through one detected, retained snapshot. A single
        // final supplier query verifies that source after every root is decoded;
        // checking it again for each ID repeats the same database work.
        let mut postcheck = Meter::new(&self.bounds);
        let checked = postcheck.query(&mut self.original, "SELECT 1", &[]);
        postcheck.timing.elapsed_us = postcheck.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.last_timing = postcheck.timing;
        self.last_diagnostic = postcheck.diagnostic;
        checked?;
        Ok(std::mem::take(&mut prepared.0))
    }
}
