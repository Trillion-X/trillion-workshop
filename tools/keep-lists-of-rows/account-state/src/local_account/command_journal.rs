//! One native command's record in the account's own records (record store resource
//! `own-commands`, one record per permit id). A synchronous local command keeps
//! its capture in memory on its own IMMEDIATE transaction and writes its
//! committed record once at completion, in that same transaction, beside the
//! records its effect wrote. No working row is published before completion,
//! and there is no other command store, request ledger or result copy.
//!
//! Non-Negotiable Invariants:
//! - A command record is written once, committed, with its known result
//!   receipt; a retry reads it and never repeats the effect.
//! - A capture lives only inside the transaction that took it: a private
//!   savepoint is released at completion, so a capture that crossed a COMMIT or
//!   ROLLBACK refuses instead of writing.
//! - A permit id that names other work (identity, operation, context) is a
//!   conflict, never a fresh command.
//!
//! Security Considerations:
//! - The durable input is schema-redacted and the context whitelisted
//!   (`no_sensitive_context`) before capture; no secret enters the record.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use super::own_records::InCommand;
use crate::storage::record_store::settings::Limits;
use crate::storage::sqlite::Connection;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fmt,
    path::Path,
};
use zeroize::{Zeroize, Zeroizing};

const MAX_CONTEXT: usize = 256 * 1024;
const MAX_INPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Unknown(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::Unavailable(cause) => cause,
            Self::Changed(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::Unknown(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Invalid(_) => "original command input refused",
            Self::Bounds(_) => "original command metadata exceeds bounds",
            Self::Unavailable(_) => "original command source unavailable",
            Self::Changed(_) => "original command source changed",
            Self::Conflict(_) => "original command names different work",
            Self::Unknown(_) => "original command outcome remains unknown",
        }, self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

/// These exact original identities are supplied by the actual native command
/// owner. Their strings alone confer no authority; CurrentCommand is mandatory.
pub struct CommandBinding {
    pub permit_id: String,
    pub identity: String,
    pub owner: String,
    pub resource: String,
    pub generation: serde_json::Value,
    pub operation: String,
    pub request_key: String,
    pub input_identity: String,
}
impl fmt::Debug for CommandBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OriginalCommandBinding([redacted])")
    }
}
impl CommandBinding {
    fn valid(&self) -> bool {
        [
            &self.permit_id,
            &self.identity,
            &self.owner,
            &self.resource,
            &self.operation,
            &self.request_key,
            &self.input_identity,
        ]
        .into_iter()
        .all(|v| bounded(v, 4096))
            && match &self.generation {
                serde_json::Value::String(v) => bounded(v, 512),
                serde_json::Value::Number(v) => {
                    v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                }
                _ => false,
            }
    }
}
fn bounded(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

/// Already schema-redacted input and whitelisted original native context. The
/// original execution capture owner must have kept this execution_ref in the
/// same transaction; a made-up label or caller boolean cannot prove capture.
pub struct Capture<'a> {
    pub durable_input: &'a str,
    pub durable_context: &'a str,
    pub execution_ref: &'a str,
}

/// Implemented by the actual selected-account native command context. It owns
/// current selection/inode/generation, original parent/child identity, admission,
/// cancellation, and the caller-held transaction. No permissive default exists.
pub trait CurrentCommand {
    fn assert_current(&mut self, db: &Connection, binding: &CommandBinding) -> Result<()>;
    /// Physical file selected for this command. Most owners use the original
    /// RecordBook; a generation-checked native placement may name a fresh
    /// internal work resource while retaining the same external binding.
    fn physical_path(&self) -> Option<&Path> {
        None
    }
    fn assert_capture(
        &mut self,
        db: &Connection,
        binding: &CommandBinding,
        capture: &Capture<'_>,
    ) -> Result<()>;
    /// Verify actual protected result + execution finalization on this exact
    /// original source. This is custody of a known outcome, not public access:
    /// a late revocation must withhold disclosure without rewriting history.
    fn assert_completion(
        &mut self,
        db: &Connection,
        binding: &CommandBinding,
        receipt: &Completion,
    ) -> Result<()>;
}

/// The admitted command owner around a supplier-neutral held session. Source
/// custody is checked independently by the journal; these callbacks must check
/// the actual admission, original capture and protected-result owners.
pub(crate) trait CurrentStorageCommand {
    fn assert_current(&mut self, source: &dyn crate::storage::Storage, binding: &CommandBinding) -> Result<()>;
    fn assert_capture(&mut self, source: &dyn crate::storage::Storage, binding: &CommandBinding, capture: &Capture<'_>) -> Result<()>;
    fn assert_completion(&mut self, source: &dyn crate::storage::Storage, binding: &CommandBinding, receipt: &Completion) -> Result<()>;
}

#[derive(Debug)]
pub enum Load {
    /// No record: this invocation took the capture and may run its effect (`begin_local_atomic` only).
    Fresh,
    /// No committed record: the outcome is not known to this reader.
    Unknown,
    /// The committed record: a retry returns its protected result.
    Committed,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub result_identity: String,
    pub native_nonretaining: bool,
}

/// Validate one command-journal value already read by the owning read-only
/// record snapshot. No database handle or store capability crosses this
/// boundary; the caller must check its live admission before and after the
/// same snapshot and keep the accompanying version custody through delivery.
pub(crate) fn read_original_record(
    binding: &CommandBinding,
    capture: &Capture<'_>,
    held: Option<serde_json::Value>,
) -> Result<Option<Completion>> {
    if !binding.valid()
        || capture.durable_input.len() > MAX_INPUT
        || capture.durable_context.len() > MAX_CONTEXT
        || !bounded(capture.execution_ref, 4096)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let input: &serde_json::value::RawValue =
        serde_json::from_str(capture.durable_input).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !input.get().trim_start().starts_with('{') {
        return Err(crate::cause!(Error::Invalid));
    }
    validate_context(binding, capture.durable_context)?;
    no_sensitive_context(capture.durable_context)?;
    let Some(held) = held else { return Ok(None) };
    let record: Record = serde_json::from_value(held).map_err(|error| crate::carry_cause!(Error::Unknown, error))?;
    if record.identity != binding.identity || record.operation != binding.operation {
        return Err(crate::cause!(Error::Conflict));
    }
    if record.input != capture.durable_input
        || record.context != capture.durable_context
        || record.execution_ref != capture.execution_ref
    {
        return Err(crate::cause!(Error::Conflict));
    }
    if record.state != "committed" {
        return Err(crate::cause!(Error::Unknown));
    }
    if record.result.result_ref != binding.permit_id
        || !original_result_identity(&record.result.result_identity)
        || record.result.native_nonretaining
    {
        return Err(crate::cause!(Error::Unknown));
    }
    Ok(Some(Completion {
        result_identity: record.result.result_identity.clone(),
        native_nonretaining: false,
    }))
}

/// The committed result receipt a command record keeps.
#[derive(serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    result_ref: String,
    result_identity: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    native_nonretaining: bool,
}
/// One command record as record store keeps it. Input and context are the exact durable
/// texts the capture admitted.
#[derive(serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    identity: String,
    operation: String,
    input: String,
    context: String,
    state: String,
    result: Receipt,
    execution_ref: String,
}
impl Drop for Record {
    fn drop(&mut self) {
        self.input.zeroize();
        self.context.zeroize();
    }
}
struct AtomicCapture {
    input: Zeroizing<String>,
    context: Zeroizing<String>,
    execution_ref: String,
    checkpoint: crate::storage::Checkpoint,
}

/// One invocation on the native command's own held transaction. Reopening this
/// adapter never recreates a capture.
/// The existing native adapter retains the original concrete admission and
/// disclosure callbacks. Its journal algorithm is the same supplier-neutral
/// owner used by other admitted command producers; this adapter grants no new
/// authority and never replaces those callbacks with cached booleans.
pub struct CommandJournal<'a> {
    db: &'a Connection,
    core: StorageCommandJournal<'a>,
}
struct NativeCurrent<'a> { db: &'a Connection, current: &'a mut dyn CurrentCommand }
impl CurrentStorageCommand for NativeCurrent<'_> {
    fn assert_current(&mut self, _: &dyn crate::storage::Storage, binding: &CommandBinding) -> Result<()> {
        self.current.assert_current(self.db, binding)
    }
    fn assert_capture(&mut self, _: &dyn crate::storage::Storage, binding: &CommandBinding, capture: &Capture<'_>) -> Result<()> {
        self.current.assert_capture(self.db, binding, capture)
    }
    fn assert_completion(&mut self, _: &dyn crate::storage::Storage, binding: &CommandBinding, receipt: &Completion) -> Result<()> {
        self.current.assert_completion(self.db, binding, receipt)
    }
}
impl fmt::Debug for CommandJournal<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("CommandJournal([redacted])") }
}
impl<'a> CommandJournal<'a> {
    /// `settings` are the record store settings the account's writer opens with (`own_records::installed_settings`).
    pub fn open(db: &'a Connection, current: &mut dyn CurrentCommand, binding: CommandBinding, limits: Limits, settings: &'static crate::storage::record_store::settings::Settings) -> Result<Self> {
        let supply = crate::storage::record_store_resources::command_storage(db, None).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let core = StorageCommandJournal::open_boxed(supply, &mut NativeCurrent { db, current }, binding, limits, settings)?;
        Ok(Self { db, core })
    }
    pub(crate) fn bind_adoption(&mut self, capture: Option<std::rc::Rc<crate::storage::record_store_resources::carry::live_adopt::CommandCapture>>) {
        self.core.bind_adoption(capture);
    }
    pub(crate) fn begin_local_atomic(&mut self, capture: Capture<'_>, current: &mut dyn CurrentCommand) -> Result<Load> {
        self.core.begin_local_atomic(capture, &mut NativeCurrent { db: self.db, current })
    }
    pub(crate) fn exists(&mut self, current: &mut dyn CurrentCommand) -> Result<bool> {
        self.core.exists(&mut NativeCurrent { db: self.db, current })
    }
    pub fn load(&mut self, current: &mut dyn CurrentCommand) -> Result<Load> {
        self.core.load(&mut NativeCurrent { db: self.db, current })
    }
    pub(crate) fn assert_local_fresh(&mut self, current: &mut dyn CurrentCommand) -> Result<()> {
        self.core.assert_local_fresh(&mut NativeCurrent { db: self.db, current })
    }
    pub fn complete(&mut self, receipt: &Completion, current: &mut dyn CurrentCommand) -> Result<()> {
        self.core.complete(receipt, &mut NativeCurrent { db: self.db, current })
    }
}

struct PendingCheckpoint<'a> {
    source: &'a dyn crate::storage::Storage,
    checkpoint: Option<crate::storage::Checkpoint>,
}
impl PendingCheckpoint<'_> {
    fn commit(mut self) -> crate::storage::Result<()> {
        self.source.close_checkpoint(self.checkpoint.take().ok_or(crate::cause!(crate::storage::Error::Invalid))?, true)
    }
}
impl Drop for PendingCheckpoint<'_> {
    fn drop(&mut self) {
        if let Some(checkpoint) = self.checkpoint.take() { let _ = self.source.close_checkpoint(checkpoint, false); }
    }
}
impl Drop for StorageCommandJournal<'_> {
    fn drop(&mut self) {
        if let Some(capture) = self.atomic.take() {
            let _ = self.storage.close_checkpoint(capture.checkpoint, false);
        }
    }
}

pub(crate) struct StorageCommandJournal<'a> {
    storage: Box<dyn crate::storage::Storage + 'a>,
    binding: CommandBinding,
    limits: Limits,
    settings: &'static crate::storage::record_store::settings::Settings,
    atomic: Option<AtomicCapture>,
    adoption: Option<std::rc::Rc<crate::storage::record_store_resources::carry::live_adopt::CommandCapture>>,
}
impl fmt::Debug for StorageCommandJournal<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StorageCommandJournal([redacted])")
    }
}
impl<'a> StorageCommandJournal<'a> {
    /// `limits` are the account store's limits the command sized once (`InCommand::limits`).
    pub fn open(
        storage: impl crate::storage::Storage + 'a,
        current: &mut dyn CurrentStorageCommand,
        binding: CommandBinding,
        limits: Limits,
        settings: &'static crate::storage::record_store::settings::Settings,
    ) -> Result<Self> {
        Self::open_boxed(Box::new(storage), current, binding, limits, settings)
    }
    fn open_boxed(storage: Box<dyn crate::storage::Storage + 'a>,
        current: &mut dyn CurrentStorageCommand, binding: CommandBinding, limits: Limits, settings: &'static crate::storage::record_store::settings::Settings) -> Result<Self> {
        if !binding.valid() {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut owner = Self {
            storage,
            binding,
            limits,
            settings,
            atomic: None,
            adoption: None,
        };
        owner.check(current, false)?;
        Ok(owner)
    }
    fn check(&mut self, current: &mut dyn CurrentStorageCommand, terminal: bool) -> Result<()> {
        self.storage.custody().map_err(|error| Error::Changed(error.cause()))?;
        if !self.storage.scoped() || (self.atomic.is_some()
            && !self.storage.writing().map_err(|error| Error::Changed(error.cause()))?) {
            return Err(crate::cause!(Error::Changed));
        }
        if !terminal {
            current.assert_current(&*self.storage, &self.binding)?;
        }
        Ok(())
    }
    fn writable(&mut self, current: &mut dyn CurrentStorageCommand) -> Result<()> {
        self.check(current, false)?;
        if self.storage.writing().map_err(|error| Error::Unavailable(error.cause()))? { Ok(()) } else { Err(crate::cause!(Error::Unavailable)) }
    }
    fn store(&self) -> Result<InCommand<'_>> {
        let store = InCommand::from_storage(&*self.storage, &self.binding.owner, self.limits, self.settings).map_err(|error| Error::Unavailable(error.cause()))?;
        store.bind_adoption(self.adoption.clone());
        Ok(store)
    }
    /// The original native transaction owns this capture, including the command
    /// journal's receipt write. It never commits a separate migration record.
    pub(crate) fn bind_adoption(&mut self, capture: Option<std::rc::Rc<crate::storage::record_store_resources::carry::live_adopt::CommandCapture>>) {
        self.adoption = capture;
    }
    /// This permit's record, checked against the binding. A record naming other work is a conflict.
    fn record(
        &mut self,
        current: &mut dyn CurrentStorageCommand,
        terminal: bool,
    ) -> Result<Option<Record>> {
        self.check(current, terminal)?;
        let (_, held) = self
            .store()?
            .command(&self.binding.permit_id)
            .map_err(|error| Error::Unavailable(error.cause()))?;
        let Some(held) = held else {
            self.check(current, terminal)?;
            return Ok(None);
        };
        let record: Record = serde_json::from_value(held).map_err(|error| crate::carry_cause!(Error::Unknown, error))?;
        if record.identity != self.binding.identity || record.operation != self.binding.operation {
            return Err(crate::cause!(Error::Conflict));
        }
        if record.context.len() > MAX_CONTEXT || record.input.len() > MAX_INPUT {
            return Err(crate::cause!(Error::Bounds));
        }
        self.context(&record.context)?;
        self.check(current, terminal)?;
        Ok(Some(record))
    }
    fn context(&self, raw: &str) -> Result<()> {
        validate_context(&self.binding, raw)
    }
    /// Only synchronous effects owned by this SAME held IMMEDIATE transaction
    /// may use this mode. No external dispatch or uncertain work is admitted.
    /// Rollback removes the effects and there is no working record for another
    /// connection to observe before the final atomic publication.
    pub(crate) fn begin_local_atomic(
        &mut self,
        capture: Capture<'_>,
        current: &mut dyn CurrentStorageCommand,
    ) -> Result<Load> {
        if self.atomic.is_some() {
            return Err(crate::cause!(Error::Changed));
        }
        self.writable(current)?;
        if capture.durable_input.len() > MAX_INPUT
            || capture.durable_context.len() > MAX_CONTEXT
            || !bounded(capture.execution_ref, 4096)
            || capture.execution_ref != format!("execution:{}", self.binding.permit_id)
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let input: &serde_json::value::RawValue =
            serde_json::from_str(capture.durable_input).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !input.get().trim_start().starts_with('{') {
            return Err(crate::cause!(Error::Invalid));
        }
        self.context(capture.durable_context)?;
        no_sensitive_context(capture.durable_context)?;
        current.assert_capture(&*self.storage, &self.binding, &capture)?;
        if let Some(record) = self.record(current, false)? {
            // A retry names the same capture its committed record kept.
            if record.input != capture.durable_input
                || record.context != capture.durable_context
                || record.execution_ref != capture.execution_ref
            {
                return Err(crate::cause!(Error::Conflict));
            }
            return self.load(current);
        }
        // The selected supplier owns continuity of this exact held session.
        // A full close/re-BEGIN must invalidate the single-use checkpoint;
        // a handle-local change mark or an open-scope boolean cannot prove it.
        let checkpoint = self.storage.checkpoint().map_err(|error| Error::Unavailable(error.cause()))?;
        self.atomic = Some(AtomicCapture {
            input: Zeroizing::new(capture.durable_input.to_owned()),
            context: Zeroizing::new(capture.durable_context.to_owned()),
            execution_ref: capture.execution_ref.to_owned(),
            checkpoint,
        });
        self.check(current, false)?;
        Ok(Load::Fresh)
    }
    /// Whether this permit already has its committed record (a retry), read on the held transaction.
    pub(crate) fn exists(&mut self, current: &mut dyn CurrentStorageCommand) -> Result<bool> {
        Ok(self.record(current, false)?.is_some())
    }
    pub fn load(&mut self, current: &mut dyn CurrentStorageCommand) -> Result<Load> {
        let answer = match self.record(current, false)? {
            // A private capture is not a public record: absence stays unknown.
            None => Load::Unknown,
            Some(record) if record.state == "committed" => Load::Committed,
            Some(_) => return Err(crate::cause!(Error::Unknown)),
        };
        self.check(current, false)?;
        Ok(answer)
    }
    /// A synchronous local effect proceeds from its private atomic capture
    /// without publishing a working record. The actual effect exposes no raw
    /// connection; final publication also proves the original savepoint survived.
    pub(crate) fn assert_local_fresh(&mut self, current: &mut dyn CurrentStorageCommand) -> Result<()> {
        if self.atomic.is_none() {
            return Err(crate::cause!(Error::Unknown));
        }
        self.writable(current)?;
        if self.record(current, false)?.is_some() {
            return Err(crate::cause!(Error::Unknown));
        }
        self.check(current, false)
    }
    /// Write the committed record with the ORIGINAL protected-result receipt
    /// only after the actual result/execution owner establishes a known outcome.
    /// This does not disclose, decode or duplicate the protected result. On a
    /// retry of a committed command it proves the same receipt instead.
    pub fn complete(
        &mut self,
        receipt: &Completion,
        current: &mut dyn CurrentStorageCommand,
    ) -> Result<()> {
        if !original_result_identity(&receipt.result_identity) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.check(current, true)?;
        current.assert_completion(&*self.storage, &self.binding, receipt)?;
        // Outcome custody is distinct from public access. The completion owner
        // attests the exact current source and known receipt here, including a
        // revoked public reader; no attempt result is returned by this method.
        let known = Receipt {
            result_ref: self.binding.permit_id.clone(),
            result_identity: receipt.result_identity.clone(),
            native_nonretaining: receipt.native_nonretaining,
        };
        let prior = self.record(current, true)?;
        if let Some(capture) = self.atomic.take() {
            let checkpoint = PendingCheckpoint { source: &*self.storage, checkpoint: Some(capture.checkpoint) };
            if prior.is_some() {
                return Err(crate::cause!(Error::Conflict));
            }
            checkpoint.commit().map_err(|error| Error::Changed(error.cause()))?;
            let record = Record {
                identity: self.binding.identity.clone(),
                operation: self.binding.operation.clone(),
                input: capture.input.to_string(),
                context: capture.context.to_string(),
                state: "committed".into(),
                result: known,
                execution_ref: capture.execution_ref.clone(),
            };
            let value = serde_json::to_value(&record).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            self.store()?
                .put_command(&self.binding.permit_id, 0, value, || Ok(()))
                .map_err(|error| {
                    let cause = error.cause();
                    match error {
                        crate::records::Error::Conflict(_) => Error::Changed(cause),
                        _ => Error::Unavailable(cause),
                    }
                })?;
            self.check(current, true)?;
            return current.assert_completion(&*self.storage, &self.binding, receipt);
        }
        let prior = prior.ok_or(crate::cause!(Error::Changed))?;
        if prior.state != "committed" {
            return Err(crate::cause!(Error::Unknown));
        }
        let matched = prior.result.result_ref == known.result_ref
            && prior.result.result_identity == known.result_identity
            && prior.result.native_nonretaining == known.native_nonretaining;
        self.check(current, true)?;
        current.assert_completion(&*self.storage, &self.binding, receipt)?;
        if matched {
            Ok(())
        } else {
            Err(crate::cause!(Error::Conflict))
        }
    }
}
fn original_result_identity(value: &str) -> bool {
    value.strip_prefix("1f:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn validate_context(binding: &CommandBinding, raw: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Context {
        permit_id: String,
        owner: String,
        resource: String,
        generation: serde_json::Value,
        operation: String,
        request_key: String,
        input_identity: String,
        #[serde(default)]
        native_nonretaining: bool,
    }
    impl Drop for Context {
        fn drop(&mut self) {
            for value in [
                &mut self.permit_id,
                &mut self.owner,
                &mut self.resource,
                &mut self.operation,
                &mut self.request_key,
                &mut self.input_identity,
            ] {
                value.zeroize();
            }
            if let serde_json::Value::String(value) = &mut self.generation {
                value.zeroize();
            }
        }
    }
    let context: Context = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if context.permit_id != binding.permit_id
        || context.owner != binding.owner
        || context.resource != binding.resource
        || context.generation != binding.generation
        || context.operation != binding.operation
        || context.request_key != binding.request_key
        || context.input_identity != binding.input_identity
    {
        return Err(crate::cause!(Error::Conflict));
    }
    if context.native_nonretaining {
        return Err(crate::cause!(Error::Unavailable));
    }
    Ok(())
}
fn no_sensitive_context(raw: &str) -> Result<()> {
    use serde_json::value::RawValue;
    fn walk(raw: &RawValue, depth: usize, nodes: &mut usize) -> Result<()> {
        *nodes += 1;
        if depth > 64 || *nodes > 16_384 {
            return Err(crate::cause!(Error::Bounds));
        }
        let text = raw.get().trim_start();
        if text.starts_with('{') {
            let object: BTreeMap<String, &RawValue> =
                serde_json::from_str(text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            for (key, value) in object {
                let lower = key.to_ascii_lowercase();
                if [
                    "secret",
                    "token",
                    "password",
                    "credential",
                    "signal",
                    "authorization",
                    "cookie",
                    "apikey",
                    "api_key",
                    "api-key",
                ]
                .iter()
                .any(|part| lower.contains(part))
                {
                    return Err(crate::cause!(Error::Invalid));
                }
                walk(value, depth + 1, nodes)?;
            }
        } else if text.starts_with('[') {
            for item in serde_json::from_str::<Vec<&RawValue>>(text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                walk(item, depth + 1, nodes)?;
            }
        }
        Ok(())
    }
    let raw: &RawValue = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    const FIELDS: &[&str] = &[
        "permit_id",
        "owner",
        "resource",
        "generation",
        "operation",
        "request_key",
        "input_identity",
        "original_work_affinity",
        "recorder",
        "claims",
        "commitment",
        "quota_purpose",
        "initialization_source",
        "quota_reservation",
        "private_reach",
        "source_raw",
        "source_signature",
        "result_input",
        "calendar_peer_request",
        "program_peer_request",
        "account_peer_request",
        "contract_stripe_wakeup",
        "managed_source",
        "native_nonretaining",
        "source_origin",
    ];
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_str(raw.get()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if fields.keys().any(|key| !FIELDS.contains(&key.as_str()))
        || !fields.get("recorder").is_some_and(|value| {
            let value = value.get().trim_start();
            value.starts_with('{') || value.starts_with('[')
        })
    {
        return Err(crate::cause!(Error::Invalid));
    }
    walk(raw, 0, &mut 0)
}

#[cfg(test)]
#[path = "../../tests/drafts/atomic_command_journal.rs"]
mod atomic_controls;
