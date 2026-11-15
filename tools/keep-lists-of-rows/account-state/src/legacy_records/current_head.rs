//! Derived-head codec in the canonical record decoder. Field stamps, replay,
//! lexical JSON, removal floors and shared/sealed wrappers keep their existing
//! owners. This contains no key bytes and is never a decrypted/public value model.
use super::*;
use crate::record_log::Projected;
use serde::{Deserialize, Serialize};

pub struct CanonicalHead {
    id: String,
    projection: Projection,
}
impl fmt::Debug for CanonicalHead {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CanonicalRawHead([redacted])")
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Original {
    record_type: String,
    sequence: String,
    value_json: String,
    meta_json: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    version: u8,
    id: String,
    projected: Option<Projected>,
    original: Option<Original>,
    dirty: bool,
    protected: bool,
}
impl CanonicalHead {
    /// Only the canonical parent decoder may turn its own Projection into a
    /// raw derived head; callers cannot substitute a stored/public value.
    pub(super) fn from_projection(id: String, projection: Projection) -> Self {
        Self { id, projection }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn protected(&self) -> bool {
        self.projection.protected
    }
    pub(crate) fn mark_protected(&mut self) {
        self.projection.protected = true;
    }
    pub fn projected(&self) -> Option<Projected> {
        self.projection.held.as_ref().map(|kept| Projected {
            sequence: self.projection.sequence.clone(),
            kept: kept.clone(),
        })
    }
    pub fn into_stored(self, bounds: &Bounds) -> Result<Option<StoredRecord>> {
        let value = self.projection.answer(&self.id, bounds)?;
        if value.as_ref().is_some_and(|v| {
            v.value_json
                .len()
                .saturating_add(v.meta_json.as_ref().map_or(0, String::len))
                > bounds.bytes
        }) {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(value)
    }
    /// Outer serde only transports already-decoded raw JSON strings and the
    /// existing Projected/Kept stamp value model. It never normalizes field values.
    pub fn encode(&self, max_bytes: usize) -> Result<Zeroizing<String>> {
        let original = if self.projection.dirty {
            None
        } else {
            self.projection.original.as_ref().map(|v| Original {
                record_type: v.record_type.clone(),
                sequence: v.sequence.clone(),
                value_json: v.value_json.clone(),
                meta_json: v.meta_json.clone(),
            })
        };
        let raw = Zeroizing::new(
            serde_json::to_string(&Wire {
                version: 1,
                id: self.id.clone(),
                projected: self.projected(),
                original,
                dirty: self.projection.dirty,
                protected: self.projection.protected,
            })
            .map_err(|error| crate::carry_cause!(Error::Corrupt, error))?,
        );
        if raw.len() > max_bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(raw)
    }
    pub fn decode(id: &str, raw: &str, max_bytes: usize) -> Result<Self> {
        if !valid_id(id) || raw.len() > max_bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        let wire: Wire = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        if wire.version != 1 || wire.id != id || wire.dirty && wire.original.is_some() {
            return Err(crate::cause!(Error::Corrupt));
        }
        if let Some(state) = &wire.projected {
            if state
                .kept
                .record_type
                .as_deref()
                .is_some_and(|kind| !valid_id(kind))
                || state.sequence.as_deref().is_some_and(|seq| !valid_id(seq))
            {
                return Err(crate::cause!(Error::Corrupt));
            }
            if state.kept.record_type.is_some()
                && (state.sequence.is_none() || state.kept.value.is_none())
            {
                return Err(crate::cause!(Error::Corrupt));
            }
            if let Some(fields) = &state.kept.value {
                for (_, value) in fields.iter() {
                    let raw = value.as_str().ok_or(crate::cause!(Error::Corrupt))?;
                    let _: &RawValue = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
                }
            }
        }
        let original = wire
            .original
            .map(|old| -> Result<StoredRecord> {
                let projected = wire.projected.as_ref().ok_or(crate::cause!(Error::Corrupt))?;
                let meta = old
                    .meta_json
                    .as_deref()
                    .map(|raw| {
                        serde_json::from_str::<stamps::Meta>(raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))
                    })
                    .transpose()?;
                if projected.kept.record_type.as_deref() != Some(old.record_type.as_str())
                    || projected.sequence.as_deref() != Some(old.sequence.as_str())
                    || projected.kept.value.as_ref() != Some(&raw_fields(&old.value_json)?)
                    || projected.kept.meta != meta
                {
                    return Err(crate::cause!(Error::Corrupt));
                }
                Ok(StoredRecord {
                    id: id.into(),
                    record_type: old.record_type,
                    sequence: old.sequence,
                    value_json: old.value_json,
                    meta_json: old.meta_json,
                    protected_key_present: wire.protected,
                })
            })
            .transpose()?;
        if !wire.dirty
            && wire
                .projected
                .as_ref()
                .is_some_and(|p| p.kept.record_type.is_some())
            && original.is_none()
        {
            return Err(crate::cause!(Error::Corrupt));
        }
        Ok(Self {
            id: id.into(),
            projection: Projection {
                held: wire.projected.as_ref().map(|p| p.kept.clone()),
                sequence: wire.projected.and_then(|p| p.sequence),
                original,
                dirty: wire.dirty,
                protected: wire.protected,
            },
        })
    }
    /// Apply the exact complete original append body using Projection::apply.
    /// The mutation/index owner must prove this body is the actually appended
    /// transaction on its retained SQLite connection before publishing coverage.
    pub fn apply_original_body(&mut self, log_id: &str, body: &str) -> Result<()> {
        let envelopes: Vec<&RawValue> = serde_json::from_str(body).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        if envelopes.len() > crate::record_log::MAX_BATCH_RECORDS {
            return Err(crate::cause!(Error::Bounds));
        }
        for (index, envelope) in envelopes.into_iter().enumerate() {
            let object = raw_object(envelope.get())?;
            if raw_text(&object, "id")?.as_deref() == Some(&self.id) {
                self.projection.apply(&self.id, envelope, log_id, index)?;
            }
        }
        // Original keys remain with the separate key owner. No field key is
        // copied from log.keys, and a marker is never used as key authority.
        Ok(())
    }
    pub fn affected_ids(body: &str) -> Result<BTreeSet<String>> {
        let envelopes: Vec<&RawValue> = serde_json::from_str(body).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        if envelopes.len() > crate::record_log::MAX_BATCH_RECORDS {
            return Err(crate::cause!(Error::Bounds));
        }
        envelopes
            .into_iter()
            .map(|envelope| {
                let object = raw_object(envelope.get())?;
                let id = raw_text(&object, "id")?.ok_or(crate::cause!(Error::Corrupt))?;
                if !valid_id(&id) {
                    return Err(crate::cause!(Error::Corrupt));
                }
                Ok(id)
            })
            .collect()
    }
}
impl<S: BoundedRecordSql> LegacyRecords<S> {
    /// Defer engine discovery until the original fallback is actually used.
    /// This does not select an engine: read_stored/read_current_head retain
    /// their same existing detect/frontier/replay checks on an index miss.
    pub fn open_for_current_head(source: S, bounds: Bounds) -> Result<Self> {
        let limits = source.read_limits().ok_or(crate::cause!(Error::Source))?.clone();
        Self::open_with_detection(source, bounds, limits, false)
    }
    pub fn read_current_head(&mut self, id: &str, kept: &LegacyKept) -> Result<CanonicalHead> {
        self.read_selected(id, kept, |projection, _| {
            Ok(CanonicalHead {
                id: id.into(),
                projection,
            })
        })
    }
}
