// Purpose: Resolve canonical stored record values and erasable fields through
// explicit current stored/key supplies. Reuse ECMAScript value model and RustCrypto
// envelope owner; no alternate store, SQL, root key, authority or serializer.
// Source: record-log-store.mjs::resolve/readShared/openFields/read and
// erasable.mjs::isSealed/keyIdOf/open. No long-lived plaintext or key cache.
// Invariants: fresh rights before/after every supply and before return; missing
// shared record is null, cycles/bounds/source failures refuse, erased or invalid
// sealed field is null. Caller still owns final current witness/disclosure.
pub mod account_routes;
pub mod erasure_owner;
pub mod history;
pub mod list;
pub mod query_witness;
pub mod reference;
pub mod references;
pub mod search;
use crate::{
    ecma_json::{self, JsString, Object, Value},
    legacy_kept::LegacyKept,
    legacy_records::{LegacyRecords, StoredRecord},
    record_sealed::{self, SecretFieldKey},
    record_source::BoundedRecordSql,
};
use std::{
    collections::HashSet,
    fmt,
    time::{Duration, Instant},
};

pub const SHARED_MARK: &str = "\0shared";
#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    SharedCycle(crate::refusal_cause::Cause),
    InvalidStored(crate::refusal_cause::Cause),
    OpaqueField(crate::refusal_cause::Cause),
    /// A filter that no declared order narrows asked to read a kind with more rows than the account routes' `where_scan_most`.
    Scan(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::Source(cause) => cause,
            Self::SharedCycle(cause) => cause,
            Self::InvalidStored(cause) => cause,
            Self::OpaqueField(cause) => cause,
            Self::Scan(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "logical record input refused",
            Self::Bounds(_) => "logical record exceeds bounds",
            Self::Source(_) => "current logical record supply unavailable",
            Self::SharedCycle(_) => "logical shared record contains itself",
            Self::InvalidStored(_) => "stored logical record representation refused",
            Self::OpaqueField(_) => "sealed logical field lacks its declared opening path",
            Self::Scan(_) => "a filter would read every row of a large kind",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;
/// Missing and erased are proved current states. Unknown transport/rights/schema
/// is Err(Source), never a fabricated missing/erased state.
pub enum KeyState {
    Present(SecretFieldKey),
    Missing,
    Erased,
}
impl fmt::Debug for KeyState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CurrentRecordKey([redacted])")
    }
}
/// The real selected key owner checks fresh generation, tombstones and erasure.
/// It must never recreate a key, use the native-root purpose key, accept an
/// expired credential, or fall back from an unavailable source to historical key.
pub trait CurrentKeys {
    fn assert_current(&mut self) -> Result<()>;
    fn key(&mut self, owner_id: &str) -> Result<KeyState>;
}
/// Stored record supply and key authority remain distinct even when one current
/// resource owner implements both. No serialized StoredRecord is a logical read.
pub trait Supply: CurrentKeys {
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>>;
    /// Full logical history already checked by the supplying admission owner.
    /// Request JSON is compared with this value; it cannot select another
    /// history by itself. The original account namespace is represented by None.
    fn record_domain(&self) -> Option<serde_json::Value> { None }
    /// Generation observed in the same snapshot as the answer. This is a
    /// reference for a later explicit create, never caller authority.
    fn record_generation(&self) -> Result<Option<i64>> { Ok(None) }
    /// Qualify a current root witness with the admitted history before output
    /// serialization or byte paging. Single-namespace supplies keep their token.
    fn qualify_root_identity(&self, _id: &str, _kind: &str, stamp: &str) -> Result<String> {
        Ok(stamp.to_owned())
    }
}
/// Live ids of one record type, newest id first, strictly before `before`:
/// one page and the cursor past it (none at the end). The account's own-records
/// store answers it beside `Supply`, on the same admitted read.
pub trait CurrentIds {
    fn ids_of_type(
        &mut self,
        record_type: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<String>, Option<String>)>;
}
/// Concrete composition with the SAME canonical read/tail decoder. The key
/// owner remains supplied by the native current-resource composition, not by
/// a receipt, path, protected_key_present flag or old immutable source.
pub struct CanonicalValues<'a, S: BoundedRecordSql, K: CurrentKeys> {
    pub records: &'a mut LegacyRecords<S>,
    pub kept: &'a LegacyKept,
    pub keys: &'a mut K,
}
impl<S: BoundedRecordSql, K: CurrentKeys> CurrentKeys for CanonicalValues<'_, S, K> {
    fn assert_current(&mut self) -> Result<()> {
        self.keys.assert_current()
    }
    fn key(&mut self, id: &str) -> Result<KeyState> {
        self.keys.key(id)
    }
}
impl<S: BoundedRecordSql, K: CurrentKeys> Supply for CanonicalValues<'_, S, K> {
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>> {
        self.records
            .read_stored(id, self.kept)
            .map_err(|error| match error {
                crate::legacy_records::Error::Bounds(cause) => Error::Bounds(cause),
                crate::legacy_records::Error::Invalid(cause) => Error::Invalid(cause),
                _ => Error::Source(error.cause()),
            })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub expansion_bytes: usize,
    pub nodes: usize,
    pub depth: usize,
    pub shared_reads: usize,
    pub key_reads: usize,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 8 * 1024 * 1024,
            expansion_bytes: 16 * 1024 * 1024,
            nodes: 100_000,
            depth: 128,
            shared_reads: 128,
            key_reads: 128,
            elapsed: Duration::from_secs(5),
        }
    }
}
impl Limits {
    fn valid(self) -> Result<()> {
        if self.input_bytes == 0
            || self.input_bytes > ecma_json::HARD_BYTES
            || self.expansion_bytes == 0
            || self.expansion_bytes > ecma_json::HARD_BYTES
            || self.nodes == 0
            || self.nodes > ecma_json::HARD_NODES
            || self.depth == 0
            || self.depth > ecma_json::HARD_DEPTH
            || self.shared_reads > 4096
            || self.key_reads > 4096
            || self.elapsed.is_zero()
            || self.elapsed > Duration::from_secs(30)
        {
            Err(crate::cause!(Error::Invalid))
        } else {
            Ok(())
        }
    }
}
/// Model DATA's existing nested erasable paths across kinds. Top-level sealed
/// fields are always opened. No hardcoded message/type/field list belongs here.
#[derive(Clone)]
pub struct OpenPolicy {
    nested: Vec<Vec<JsString>>,
}
impl OpenPolicy {
    pub fn new(nested: Vec<Vec<JsString>>) -> Result<Self> {
        if nested.len() > 4096 {
            return Err(crate::cause!(Error::Bounds));
        }
        let mut units = 0usize;
        let mut seen = HashSet::new();
        let mut unique = Vec::new();
        for path in nested {
            if path.len() < 2 || path.len() > 128 {
                return Err(crate::cause!(Error::Invalid));
            }
            for part in &path {
                units = units.checked_add(part.len()).ok_or(crate::cause!(Error::Bounds))?;
            }
            if units > 1024 * 1024 {
                return Err(crate::cause!(Error::Bounds));
            }
            if seen.insert(path.clone()) {
                unique.push(path)
            }
        }
        Ok(Self { nested: unique })
    }
}
impl Default for OpenPolicy {
    fn default() -> Self {
        Self { nested: Vec::new() }
    }
}
#[derive(Default, Clone, Copy, Debug)]
pub struct Work {
    pub stored_reads: usize,
    pub key_reads: usize,
    pub sealed_fields_opened: usize,
    pub parsed_bytes: usize,
    pub expanded_bytes: usize,
    pub nodes: usize,
}
/// Intentionally not Serialize: only the actual caller's current-authority
/// disclosure path may turn a logical value into transport bytes.
pub struct LogicalRecord {
    id: String,
    kind: String,
    sequence: String,
    /// Current root field/floor stamp. Sequence is its creation/order identity and does not change on an edit.
    root_identity: Option<String>,
    value: Value,
    pub work: Work,
}
impl fmt::Debug for LogicalRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LogicalRecord([redacted])")
    }
}
impl LogicalRecord {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn record_type(&self) -> &str {
        &self.kind
    }
    pub fn sequence(&self) -> &str {
        &self.sequence
    }
    /// Opaque current-root witness from the SAME stored form opened by this read, before shared/derived values.
    /// A pre-stamp root starts at its creation identity; its first normal write installs a current field stamp.
    pub fn root_identity(&self) -> Option<&str> {
        self.root_identity.as_deref()
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn into_value(self) -> Value {
        self.value
    }
}
struct Reader<'a, S> {
    supply: &'a mut S,
    limits: Limits,
    work: Work,
    deadline: Instant,
    opening: HashSet<String>,
}
pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control)
}

impl<S: Supply> Reader<'_, S> {
    fn deadline(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(crate::cause!(Error::Bounds))
        } else {
            Ok(())
        }
    }
    fn check(&mut self) -> Result<()> {
        self.deadline()?;
        self.supply.assert_current()?;
        self.deadline()
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.work.nodes = self.work.nodes.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        self.work.expanded_bytes = self
            .work
            .expanded_bytes
            .checked_add(bytes)
            .ok_or(crate::cause!(Error::Bounds))?;
        if self.work.nodes > self.limits.nodes
            || self.work.expanded_bytes > self.limits.expansion_bytes
        {
            Err(crate::cause!(Error::Bounds))
        } else {
            Ok(())
        }
    }
    fn json_limits(&self) -> ecma_json::Limits {
        let bytes = self
            .limits
            .expansion_bytes
            .saturating_sub(self.work.expanded_bytes);
        let nodes = self.limits.nodes.saturating_sub(self.work.nodes);
        ecma_json::Limits {
            input_bytes: self
                .limits
                .input_bytes
                .saturating_sub(self.work.parsed_bytes),
            output_bytes: bytes,
            depth: self.limits.depth,
            nodes,
            string_units: bytes / 2,
            total_string_units: bytes / 2,
            container_entries: nodes,
            number_bytes: ecma_json::HARD_NUMBER_BYTES,
        }
    }
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>> {
        self.check()?;
        self.work.stored_reads = self.work.stored_reads.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        if self.work.stored_reads > self.limits.shared_reads.saturating_add(1) {
            return Err(crate::cause!(Error::Bounds));
        }
        let record = self.supply.stored(id)?;
        self.check()?;
        if let Some(record) = &record {
            if record.id != id {
                return Err(crate::cause!(Error::InvalidStored));
            }
        }
        Ok(record)
    }
    fn parse(&mut self, raw: &str) -> Result<Value> {
        let limits = self.json_limits();
        self.work.parsed_bytes = self
            .work
            .parsed_bytes
            .checked_add(raw.len())
            .ok_or(crate::cause!(Error::Bounds))?;
        if self.work.parsed_bytes > self.limits.input_bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        ecma_json::parse(raw.as_bytes(), limits).map_err(|error| {
            if matches!(error, ecma_json::Error::InvalidJson(_)) {
                Error::InvalidStored(error.cause())
            } else {
                Error::Bounds(error.cause())
            }
        })
    }
    fn resolve(&mut self, value: &Value, depth: usize) -> Result<Value> {
        self.deadline()?;
        if depth > self.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        match value {
            Value::Object(object) => {
                if let Some(Value::String(id)) = object.get(&JsString::from(SHARED_MARK)) {
                    let id = id.to_rust_string().map_err(|error| Error::InvalidStored(error.cause()))?;
                    if !valid_id(&id) {
                        return Err(crate::cause!(Error::InvalidStored));
                    }
                    if !self.opening.insert(id.clone()) {
                        return Err(crate::cause!(Error::SharedCycle));
                    }
                    let record = self.stored(&id)?;
                    let result = match record {
                        Some(record) => {
                            let value = self.parse(&record.value_json)?;
                            self.resolve(&value, depth + 1)?
                        }
                        None => {
                            self.charge(16)?;
                            Value::Null
                        }
                    };
                    self.opening.remove(&id);
                    return Ok(result);
                }
                let shell = object
                    .insertion_entries()
                    .try_fold(64usize, |n, (key, _)| {
                        n.checked_add(16 + key.len() * 2).ok_or(crate::cause!(Error::Bounds))
                    })?;
                self.charge(shell)?;
                let mut out = Object::new();
                for (key, item) in object.insertion_entries() {
                    out.insert(key.clone(), self.resolve(item, depth + 1)?);
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => {
                self.charge(32 + items.len() * 8)?;
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.resolve(item, depth + 1)?)
                }
                Ok(Value::Array(out))
            }
            Value::String(text) => {
                self.charge(16 + text.len() * 2)?;
                Ok(value.clone())
            }
            _ => {
                self.charge(16)?;
                Ok(value.clone())
            }
        }
    }
    fn open_field(&mut self, id: &str, field: &JsString, value: &Value) -> Result<Value> {
        let Value::Object(object) = value else {
            self.measure(value, 0)?;
            return Ok(value.clone());
        };
        if !record_sealed::is_sealed(object) {
            self.measure(value, 0)?;
            return Ok(value.clone());
        }
        let owner = record_sealed::key_owner(id, object).map_err(|error| Error::InvalidStored(error.cause()))?;
        if !valid_id(&owner) {
            return Err(crate::cause!(Error::InvalidStored));
        }
        self.check()?;
        if self.work.key_reads >= self.limits.key_reads {
            return Err(crate::cause!(Error::Bounds));
        }
        self.work.key_reads += 1;
        let key = self.supply.key(&owner)?;
        self.check()?;
        let opened = match key {
            KeyState::Missing | KeyState::Erased => None,
            KeyState::Present(key) => {
                record_sealed::open(&key, id, field, object, self.json_limits())
                    .map_err(|error| crate::carry_cause!(Error::Bounds, error))?
            }
        };
        let value = match opened {
            Some((value, bytes)) => {
                self.work.sealed_fields_opened = self
                    .work
                    .sealed_fields_opened
                    .checked_add(1)
                    .ok_or(crate::cause!(Error::Bounds))?;
                self.work.parsed_bytes = self
                    .work
                    .parsed_bytes
                    .checked_add(bytes)
                    .ok_or(crate::cause!(Error::Bounds))?;
                if self.work.parsed_bytes > self.limits.input_bytes {
                    return Err(crate::cause!(Error::Bounds));
                }
                value
            }
            None => Value::Null,
        };
        // Charge each opened graph as an additional independent materialization.
        self.measure(&value, 0)?;
        self.check()?;
        Ok(value)
    }
    fn measure(&mut self, value: &Value, depth: usize) -> Result<()> {
        self.deadline()?;
        if depth > self.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        match value {
            Value::Object(object) => {
                let shell = object
                    .insertion_entries()
                    .try_fold(64usize, |n, (key, _)| {
                        n.checked_add(16 + key.len() * 2).ok_or(crate::cause!(Error::Bounds))
                    })?;
                self.charge(shell)?;
                for (_, child) in object.insertion_entries() {
                    self.measure(child, depth + 1)?
                }
            }
            Value::Array(items) => {
                self.charge(32 + items.len() * 8)?;
                for child in items {
                    self.measure(child, depth + 1)?
                }
            }
            Value::String(text) => self.charge(16 + text.len() * 2)?,
            _ => self.charge(16)?,
        }
        Ok(())
    }
    fn open_path(
        &mut self,
        id: &str,
        value: &Value,
        path: &[JsString],
        field: &JsString,
    ) -> Result<Value> {
        self.deadline()?;
        let Value::Object(object) = value else {
            self.measure(value, 0)?;
            return Ok(value.clone());
        };
        let Some(item) = object.get(&path[0]) else {
            self.measure(value, 0)?;
            return Ok(value.clone());
        };
        let changed = if path.len() == 1 {
            self.open_field(id, field, item)?
        } else {
            self.open_path(id, item, &path[1..], field)?
        };
        self.measure(value, 0)?;
        let mut out = object.clone();
        out.insert(path[0].clone(), changed);
        Ok(Value::Object(out))
    }
}
fn unopened(value: &Value, depth: usize, most: usize) -> Result<()> {
    if depth > most {
        return Err(crate::cause!(Error::Bounds));
    }
    match value {
        Value::Object(object) => {
            if record_sealed::is_sealed(object) {
                return Err(crate::cause!(Error::OpaqueField));
            }
            for (_, value) in object.insertion_entries() {
                unopened(value, depth + 1, most)?
            }
        }
        Value::Array(items) => {
            for value in items {
                unopened(value, depth + 1, most)?
            }
        }
        _ => {}
    }
    Ok(())
}
/// Canonical supported logical read. Unknown nested sealed paths refuse rather
/// than passing ciphertext as plaintext. Shared expansion precedes field opening,
/// as in the original owner; copied fields keep the root's associated-data ID.
pub fn read(
    id: &str,
    supply: &mut impl Supply,
    policy: &OpenPolicy,
    limits: Limits,
) -> Result<Option<LogicalRecord>> {
    limits.valid()?;
    if !valid_id(id) {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut reader = Reader {
        supply,
        limits,
        work: Work::default(),
        deadline: Instant::now() + limits.elapsed,
        opening: HashSet::new(),
    };
    let Some(record) = reader.stored(id)? else {
        reader.check()?;
        return Ok(None);
    };
    let root_identity = match record.meta_json.as_deref() {
        Some(meta) => serde_json::from_str::<crate::record_stamps::Meta>(meta)
            .ok()
            .map(|meta| meta.at)
            .filter(|stamp| !stamp.is_empty()),
        None => Some(record.sequence.clone()).filter(|stamp| !stamp.is_empty()),
    };
    let root_identity = root_identity
        .map(|stamp| reader.supply.qualify_root_identity(id, &record.record_type, &stamp))
        .transpose()?;
    reader.opening.insert(id.into());
    let value = reader.parse(&record.value_json)?;
    let mut resolved = reader.resolve(&value, 0)?;
    reader.opening.remove(id);
    if let Value::Object(object) = &resolved {
        let mut out = Object::new();
        for (field, item) in object.insertion_entries() {
            out.insert(field.clone(), reader.open_field(id, field, item)?);
        }
        resolved = Value::Object(out);
        for path in &policy.nested {
            let mut field = Vec::new();
            for (at, part) in path.iter().enumerate() {
                if at > 0 {
                    field.push(b'.' as u16)
                }
                field.extend_from_slice(part.units())
            }
            resolved = reader.open_path(id, &resolved, path, &JsString::from_units(field))?;
        }
    }
    unopened(&resolved, 0, limits.depth)?;
    reader.check()?;
    Ok(Some(LogicalRecord {
        id: record.id,
        kind: record.record_type,
        sequence: record.sequence,
        root_identity,
        value: resolved,
        work: reader.work,
    }))
}
