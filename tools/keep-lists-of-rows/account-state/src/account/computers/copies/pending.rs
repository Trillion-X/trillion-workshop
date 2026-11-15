//! Durable local commands beside the existing settle log, before their writer commits them.
//!
//! Ports old trillion `src/workspace/quiet-writes.ts` at b8b022848c:334-375
//! (keep and read back), 601-613 (keep before sending), 682-693 (resume after
//! relaunch), and 798-816 (a known refusal ends the pending attempt). The old
//! browser storage and fixed hosted leader are dropped: the selected history's
//! Storage and the account's existing copies/settle owner supply those parts.
//!
//! A submission is not a committed record. Its input and provisional records
//! live together in one sealed settle row; canonical record versions and their
//! writer term are untouched. The writer must admit the retained credential
//! through its normal command producer. Only that producer's known success or
//! refusal becomes a receipt. A lost delivery or answer leaves this row pending.
//! This module opens no connection and creates no second delivery worker.

use super::super::sealed::{self, At, Part, SecretsKeys};
use crate::storage::{
    record_store::{
        digest,
        record_log::RecordLog,
        record_sync::{Actor, SettleStore, SyncError},
    },
    record_store_resources::domains::Identity,
    Intent, Scope, Storage,
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroize;

/// The visible local image prepared by the record command owner, never by the
/// transport. None is a provisional removal. A successful receipt keeps this
/// image available until the normal copy has materialized the writer's result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub id: String,
    pub kind: String,
    pub value: Option<Value>,
}

/// The complete first accepted call. A sign-in label is identity only; bearer
/// must still pass the writer's current-rights checks when this is delivered.
/// Debug deliberately prints no input, request, provisional value or credential.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub owner: String,
    pub sign_in: String,
    pub resource: String,
    pub operation: String,
    pub request_key: String,
    pub input: Value,
    pub scope: Option<Identity>,
    /// The native source generation at first acceptance, including unscoped
    /// records. A request key cannot be rebound after the local source changes.
    #[serde(default)]
    pub source_generation: i64,
    pub request: Value,
    pub bearer: String,
    pub accepted_at_ms: i64,
    #[serde(default)]
    pub person_present: Option<Value>,
    /// Source-derived kinds whose local privacy rule must still permit this
    /// retained call when delivery resumes. A retry never replaces the first
    /// accepted metadata merely because its source-derived view changed.
    #[serde(default)]
    pub checked_kinds: Vec<String>,
    pub projection: Vec<Projection>,
}
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Command").finish_non_exhaustive()
    }
}
impl Drop for Command {
    fn drop(&mut self) {
        self.bearer.zeroize();
    }
}
impl Command {
    fn same_input(left: &Value, right: &Value) -> bool {
        if left == right {
            return true;
        }
        // The native record producer canonicalizes ECMAScript values. serde's
        // numeric variants are not that identity (for example 1 versus 1.0).
        // Reuse the same owner and code-unit comparator on the uncommon path;
        // the first accepted raw input remains the retained command body.
        let identity = |value: &Value| -> Option<String> {
            let bytes = zeroize::Zeroizing::new(serde_json::to_vec(value).ok()?);
            let parsed = crate::ecma_json::parse(&bytes, Default::default()).ok()?;
            crate::record_canonical::identity(
                &parsed,
                Default::default(),
                &mut |left: &crate::ecma_json::JsString, right: &crate::ecma_json::JsString| {
                    Ok::<_, ()>(left.units().cmp(right.units()))
                },
            )
            .ok()
        };
        match (identity(left), identity(right)) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    }
    /// Retries carry the same semantic command. The JSON-RPC id, bearer
    /// rotation and acceptance time do not replace its first durable context.
    fn same_request(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.sign_in == other.sign_in
            && self.resource == other.resource
            && self.operation == other.operation
            && self.request_key == other.request_key
            && Self::same_input(&self.input, &other.input)
            && self.scope == other.scope
            && self.source_generation == other.source_generation
            && self.person_present == other.person_present
    }
}

/// Opaque command payload carried by the existing settle owner. It is sealed
/// for this account, queue resource, request identity and Value part.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub id: String,
    pub payload: Value,
}

/// Only a known native result is terminal. The writer callback owns the
/// classification: transport loss and outcome-unknown must never construct it.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Terminal {
    /// A terminal refusal keeps its writer origin through the sealed receipt.
    #[serde(default = "historical_terminal_cause")]
    pub cause: crate::refusal_cause::Cause,
    pub status: u16,
    pub body: Value,
    pub refused: bool,
}
fn historical_terminal_cause() -> crate::refusal_cause::Cause {
    crate::cause!(historical_origin_unrecorded pending_terminal)
}
impl Terminal {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        if self.refused {
            if let Some(cause) = self.body.pointer("/result/structuredContent/cause")
                .or_else(|| self.body.get("cause")).and_then(Value::as_str)
                .and_then(crate::refusal_cause::Cause::from_wire)
            { return cause; }
        }
        self.cause.clone()
    }
}
crate::impl_caused!(Terminal);

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal")
            .field("status", &self.status)
            .field("refused", &self.refused)
            .field("cause", &self.cause())
            .finish_non_exhaustive()
    }
}

/// The writer's result, sealed under the separate Receipts associated part.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub command: Command,
    pub terminal: Option<Terminal>,
    /// Durable local acceptance order. Wall clocks can repeat or go backwards;
    /// neither clock order nor hash/bucket order selects the latest local view.
    pub order: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub entries: usize,
    pub bytes: usize,
    /// How long a pruned command's tombstone answers its duplicates: past the longest client retry window.
    pub tombstone_ms: i64,
}
#[derive(Debug)]
pub struct Page {
    pub entries: Vec<(String, Entry)>,
    pub next: Option<String>,
}

/// The prune pass's resume point: the last command id it finished, kept in the outbox's own positions.
const PRUNE_CURSOR: &str = "local-prune-cursor";

/// What a pruned command keeps: its sealed writer receipt, its acceptance order, a digest of the command it answered, and
/// when its duplicates stop being answered. The command's input, bearer and projection are gone with its row.
#[derive(Serialize, Deserialize)]
struct Tombstone {
    receipt: Value,
    order: u64,
    command: String,
    expires_ms: i64,
}

/// One local-only resource in the selected history's existing record storage.
/// Its sealed rows must not be advertised as canonical copied record versions.
pub struct Queue<S: Storage> {
    storage: S,
    owner: String,
    resource: String,
    roots: SecretsKeys,
    bounds: Bounds,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionHead {
    command: String,
    #[serde(default)]
    observed: Option<Projection>,
    /// The record's committed version when its command was accepted; None for a scoped or older head, which answers as before.
    #[serde(default)]
    base: Option<i64>,
}
type ProjectionLinks = std::collections::BTreeMap<String, Option<ProjectionHead>>;

fn invalid(cause: crate::refusal_cause::Cause) -> SyncError {
    SyncError::new(400, "The pending command is invalid.", cause)
}
fn conflict(cause: crate::refusal_cause::Cause) -> SyncError {
    SyncError::new(
        409,
        "The pending request key already names another command or result.",
     cause)
}
fn at<'a>(owner: &'a str, resource: &'a str, id: &'a str, part: Part) -> At<'a> {
    // These identify this wire format, not a canonical record version/stamp.
    At {
        owner,
        resource,
        id,
        version: 1,
        from: 0,
        part,
    }
}
/// serde Values do not zeroize strings when dropped. Keep the only credential
/// field in a guard while a command is encoded/decoded, including error paths.
struct PlainCommand(Value);
impl Drop for PlainCommand {
    fn drop(&mut self) {
        if let Some(Value::String(bearer)) = self.0.get_mut("bearer") {
            bearer.zeroize();
        }
    }
}
fn id_valid(id: &str) -> bool {
    id.len() == blake3::OUT_LEN * 2
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// The original retry owner: account, sign-in, addressed resource and request
/// key. Operation and input are checked on collision rather than making a new
/// address, so changing them cannot execute a second command under one key.
pub fn command_id(command: &Command) -> Result<String, SyncError> {
    request_id(&command.owner, &command.sign_in, &command.resource, &command.request_key)
}

/// Address a retained request without rebuilding its first accepted command.
/// The same address must be consulted when a returning computer holds a turn.
pub fn request_id(owner: &str, sign_in: &str, resource: &str, request_key: &str) -> Result<String, SyncError> {
    let bytes = serde_json::to_vec(&(
        "pending-command/v1", owner, sign_in, resource, request_key,
    ))
    .map_err(|error| crate::carry_cause!(invalid, error))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

/// Seal one read or write for the existing settle transport without retaining
/// it in a queue. The local ingress supplies admission and transport bounds;
/// the receiving writer still admits the retained bearer itself.
pub fn seal_submission(
    owner: &str,
    resource: &str,
    roots: &SecretsKeys,
    command: &Command,
) -> Result<Submission, SyncError> {
    if command.owner != owner {
        return Err(conflict(crate::cause!(pending conflict)));
    }
    if command.source_generation <= 0 {
        return Err(invalid(crate::cause!(pending invalid)));
    }
    let id = command_id(command)?;
    let value = PlainCommand(serde_json::to_value(command).map_err(|error| crate::carry_cause!(invalid, error))?);
    let payload = sealed::seal_value(roots, &at(owner, resource, &id, Part::Value), &value.0)
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    Ok(Submission { id, payload })
}

pub fn open_submission(
    owner: &str,
    resource: &str,
    roots: &SecretsKeys,
    submission: &Submission,
) -> Result<Command, SyncError> {
    if !id_valid(&submission.id) {
        return Err(invalid(crate::cause!(pending invalid)));
    }
    let mut value = sealed::open_value(
        roots,
        &at(owner, resource, &submission.id, Part::Value),
        &submission.payload,
    )
    .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    // Move the credential out before parsing the remaining fields: a malformed
    // command is allowed to fail without leaving an unguarded credential copy.
    let mut bearer = match value.get_mut("bearer") {
        Some(Value::String(text)) => zeroize::Zeroizing::new(std::mem::take(text)),
        _ => return Err(invalid(crate::cause!(pending invalid))),
    };
    let mut command = serde_json::from_value::<Command>(value).map_err(|error| crate::carry_cause!(invalid, error))?;
    command.bearer = std::mem::take(&mut *bearer);
    if command.source_generation <= 0 {
        return Err(invalid(crate::cause!(pending invalid)));
    }
    if command.owner != owner || command_id(&command)? != submission.id {
        return Err(conflict(crate::cause!(pending conflict)));
    }
    Ok(command)
}

pub fn seal_receipt(
    owner: &str,
    resource: &str,
    roots: &SecretsKeys,
    id: &str,
    terminal: &Terminal,
) -> Result<Receipt, SyncError> {
    if !id_valid(id) || !(100..=599).contains(&terminal.status) {
        return Err(invalid(crate::cause!(pending invalid)));
    }
    let value = serde_json::to_value(terminal).map_err(|error| crate::carry_cause!(invalid, error))?;
    let payload = sealed::seal_value(roots, &at(owner, resource, id, Part::Receipts), &value)
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    Ok(Receipt {
        id: id.to_owned(),
        payload,
    })
}

/// A computer removed from remote answering does not receive a new root. The
/// writer can still open its pending call with an older root from its keyring;
/// seal this answer under exactly that authenticated submission root, without
/// handing the removed computer the writer's newer key.
pub fn seal_reply_to_submission(
    owner: &str,
    resource: &str,
    roots: &SecretsKeys,
    submission: &Submission,
    terminal: &Terminal,
) -> Result<Receipt, SyncError> {
    // Authenticate the envelope before trusting which held root it names.
    drop(open_submission(owner, resource, roots, submission)?);
    let identity = submission
        .payload
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
    let mut reply_roots = roots.clone();
    reply_roots
        .make_current(identity)
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    seal_receipt(owner, resource, &reply_roots, &submission.id, terminal)
}
pub fn open_receipt(
    owner: &str,
    resource: &str,
    roots: &SecretsKeys,
    receipt: &Receipt,
) -> Result<Terminal, SyncError> {
    if !id_valid(&receipt.id) {
        return Err(invalid(crate::cause!(pending invalid)));
    }
    let value = sealed::open_value(
        roots,
        &at(owner, resource, &receipt.id, Part::Receipts),
        &receipt.payload,
    )
    .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    serde_json::from_value(value).map_err(|error| crate::carry_cause!(invalid, error))
}

/// Whether an image kept at version `base` is still the latest version of its record, given the version `now` the copy holds.
fn latest(base: Option<i64>, now: Option<i64>) -> bool {
    base.zip(now).map_or(true, |(base, now)| now <= base)
}

impl<S: Storage> Queue<S> {
    pub fn new(
        storage: S,
        owner: &str,
        resource: &str,
        roots: SecretsKeys,
        bounds: Bounds,
    ) -> Self {
        Self {
            storage,
            owner: owner.to_owned(),
            resource: resource.to_owned(),
            roots,
            bounds,
        }
    }
    fn log(&self) -> RecordLog<&S> {
        RecordLog::new(&self.storage, &self.owner, &self.resource)
    }
    fn projection_resource(&self) -> String {
        format!("{}:projections", self.resource)
    }
    fn projection_key(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
    ) -> Result<String, SyncError> {
        let bytes = serde_json::to_vec(&("pending-projection/v1", &self.owner, sign_in, scope, id))
            .map_err(|error| crate::carry_cause!(invalid, error))?;
        Ok(blake3::hash(&bytes).to_hex().to_string())
    }
    fn projection_head(&self, key: &str) -> Result<Option<ProjectionHead>, SyncError> {
        let resource = self.projection_resource();
        let Some(fields) = RecordLog::new(&self.storage, &self.owner, &resource).read(key)? else {
            return Ok(None);
        };
        let payload = fields.get("head").ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        let value = sealed::open_value(
            &self.roots,
            &at(&self.owner, &resource, key, Part::Value),
            payload,
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let head: ProjectionHead = serde_json::from_value(value).map_err(|error| crate::carry_cause!(invalid, error))?;
        if !id_valid(&head.command) {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        Ok(Some(head))
    }
    fn put_projection_head(
        &self,
        key: &str,
        head: Option<&ProjectionHead>,
    ) -> Result<(), SyncError> {
        let resource = self.projection_resource();
        let fields = head
            .map(|head| -> Result<_, SyncError> {
                let value = serde_json::to_value(head).map_err(|error| crate::carry_cause!(invalid, error))?;
                let payload = sealed::seal_value(
                    &self.roots,
                    &at(&self.owner, &resource, key, Part::Value),
                    &value,
                )
                .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
                Ok(Map::from_iter([("head".to_owned(), payload)]))
            })
            .transpose()?;
        RecordLog::new(&self.storage, &self.owner, &resource).write(
            &[(key, "pending-projection", fields)],
            Actor::by("local-pending"),
        )?;
        Ok(())
    }
    fn projection_links(
        &self,
        id: &str,
        fields: &Map<String, Value>,
    ) -> Result<ProjectionLinks, SyncError> {
        let payload = fields.get("previous").ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        let associated_id = format!("{id}:previous");
        let value = sealed::open_value(
            &self.roots,
            &at(&self.owner, &self.resource, &associated_id, Part::Value),
            payload,
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let links: ProjectionLinks = serde_json::from_value(value).map_err(|error| crate::carry_cause!(invalid, error))?;
        if links.iter().any(|(slot, previous)| {
            !id_valid(slot)
                || previous
                    .as_ref()
                    .is_some_and(|head| !id_valid(&head.command))
        }) {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        Ok(links)
    }
    fn projected(
        entry: &Entry,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
    ) -> Result<Projection, SyncError> {
        if entry.command.sign_in != sign_in || entry.command.scope.as_ref() != scope {
            return Err(conflict(crate::cause!(pending conflict)));
        }
        entry
            .command
            .projection
            .iter()
            .find(|row| row.id == id)
            .cloned()
            .ok_or_else(|| conflict(crate::cause!(pending conflict)))
    }
    /// Two point reads under one snapshot: this record's sealed head and its
    /// original accepted command. Retained receipt history is never scanned.
    /// A first refusal repairs its head in the same transaction as the receipt.
    pub fn projection(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
    ) -> Result<Option<Projection>, SyncError> {
        Ok(self
            .projection_state(sign_in, id, scope)?
            .map(|(_, _, projection)| projection))
    }
    /// Return the exact indexed command with its current local image. The
    /// original input and receipt remain immutable when a later authorized
    /// writer read refreshes the observed image in this separate index.
    pub fn projection_state(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
    ) -> Result<Option<(String, Entry, Projection)>, SyncError> {
        self.projection_state_at_generation(sign_in, id, scope, None)
    }
    /// A source replacement never exposes the prior source's local image as
    /// a record in the new source. The original command and receipt stay kept.
    pub fn projection_state_at_generation(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
        generation: Option<i64>,
    ) -> Result<Option<(String, Entry, Projection)>, SyncError> {
        self.projection_state_with_store(sign_in, id, scope, generation, None)
    }
    /// The head as `projection_state_at_generation`, but a record `store` (its committed version and value) that is newer than the
    /// head's base answers instead: a write committed after the head was accepted is the later state.
    pub(crate) fn projection_state_with_store(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
        generation: Option<i64>,
        store: Option<(i64, Value)>,
    ) -> Result<Option<(String, Entry, Projection)>, SyncError> {
        let read = if self.storage.scoped() {
            None
        } else {
            Some(Scope::begin(&self.storage, Intent::Read).map_err(|error| crate::carry_cause!(SyncError::storage, error))?)
        };
        let key = self.projection_key(sign_in, id, scope)?;
        let result = match self.projection_head(&key)? {
            None => None,
            Some(head) => {
                let entry = self.get(&head.command)?.ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
                if generation.is_some_and(|generation| entry.command.source_generation != generation) {
                    if let Some(read) = read { read.rollback().map_err(|error| crate::carry_cause!(SyncError::storage, error))?; }
                    return Ok(None);
                }
                if entry
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.refused)
                {
                    return Err(conflict(crate::cause!(pending conflict)));
                }
                let original = Self::projected(&entry, sign_in, id, scope)?;
                // Order of versions: a head kept before bases existed, once its command completed, has base 0.
                let kept_base = head.base.or(entry.terminal.is_some().then_some(0));
                let projection = head.observed.unwrap_or(original);
                if projection.id != id || (projection.kind.is_empty() && projection.value.is_some())
                {
                    return Err(conflict(crate::cause!(pending conflict)));
                }
                latest(kept_base, store.map(|(version, _)| version)).then_some((head.command, entry, projection))
            }
        };
        if let Some(read) = read {
            read.rollback().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        }
        Ok(result)
    }
    /// Cache one authorized writer read only while its exact completed head
    /// still holds. A later local acceptance wins this CAS; a pending local
    /// image cannot be replaced by the writer's earlier canonical record.
    pub fn refresh_projection(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&Identity>,
        expected_head: &str,
        projection: &Projection,
    ) -> Result<bool, SyncError> {
        if !id_valid(expected_head)
            || projection.id != id
            || (projection.kind.is_empty() && projection.value.is_some())
        {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        let write = Scope::begin(
            &self.storage,
            if self.storage.scoped() {
                Intent::Nested
            } else {
                Intent::Write
            },
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let key = self.projection_key(sign_in, id, scope)?;
        let Some(mut head) = self
            .projection_head(&key)?
            .filter(|head| head.command == expected_head)
        else {
            write.rollback().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
            return Ok(false);
        };
        let entry = self.get(expected_head)?.ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
        Self::projected(&entry, sign_in, id, scope)?;
        if !entry
            .terminal
            .as_ref()
            .is_some_and(|terminal| !terminal.refused)
        {
            write.rollback().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
            return Ok(false);
        }
        if head.observed.as_ref() != Some(projection) {
            head.observed = Some(projection.clone());
            self.put_projection_head(&key, Some(&head))?;
        }
        write.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        Ok(true)
    }
    fn number(&self, key: &str) -> Result<u64, SyncError> {
        self.log()
            .position(key)?
            .map(|value| value.parse::<u64>().map_err(|error| crate::carry_cause!(invalid, error)))
            .transpose()
            .map(|value| value.unwrap_or_default())
    }
    /// A held writer may use its ordinary local command path only when no
    /// accepted work precedes it and this exact key has no retained context.
    pub fn requires_queue(&self, sign_in: &str, resource: &str, request_key: &str) -> Result<bool, SyncError> {
        let read = if self.storage.scoped() { None } else {
            Some(Scope::begin(&self.storage, Intent::Read).map_err(|error| crate::carry_cause!(SyncError::storage, error))?)
        };
        let id = request_id(&self.owner, sign_in, resource, request_key)?;
        let required = self.pending_count()? > 0 || self.log().read(&id)?.is_some() || self.tombstone(&id)?.is_some();
        if let Some(read) = read { read.rollback().map_err(|error| crate::carry_cause!(SyncError::storage, error))?; }
        Ok(required)
    }

    /// One metadata read, with no original-record read and no queue inventory.
    /// The count changes in the same durable scope as first acceptance or the
    /// first terminal receipt, so startup can owe a drain before its boot reads.
    pub fn pending_count(&self) -> Result<u64, SyncError> {
        self.number("local-pending-count")
    }
    fn decode(&self, id: &str, fields: &Map<String, Value>) -> Result<Entry, SyncError> {
        let submission = Submission {
            id: id.to_owned(),
            payload: fields.get("submission").cloned().ok_or_else(|| invalid(crate::cause!(pending invalid)))?,
        };
        let command = open_submission(&self.owner, &self.resource, &self.roots, &submission)?;
        let terminal = fields
            .get("receipt")
            .map(|payload| {
                open_receipt(
                    &self.owner,
                    &self.resource,
                    &self.roots,
                    &Receipt {
                        id: id.to_owned(),
                        payload: payload.clone(),
                    },
                )
            })
            .transpose()?;
        let order = fields
            .get("order")
            .and_then(Value::as_u64)
            .filter(|order| *order > 0)
            .ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        Ok(Entry {
            command,
            terminal,
            order,
        })
    }
    pub fn get(&self, id: &str) -> Result<Option<Entry>, SyncError> {
        if !id_valid(id) {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        self.log()
            .read(id)?
            .as_ref()
            .map(|fields| self.decode(id, fields))
            .transpose()
    }
    pub fn submission(&self, id: &str) -> Result<Option<Submission>, SyncError> {
        if !id_valid(id) {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        self.log()
            .read(id)?
            .map(|fields| {
                Ok(Submission {
                    id: id.to_owned(),
                    payload: fields.get("submission").cloned().ok_or_else(|| invalid(crate::cause!(pending invalid)))?,
                })
            })
            .transpose()
    }
    fn tombstone_key(id: &str) -> String {
        format!("local-tomb:{id}")
    }
    fn tombstone(&self, id: &str) -> Result<Option<Tombstone>, SyncError> {
        let Some(text) = self.log().position(&Self::tombstone_key(id))? else {
            return Ok(None);
        };
        serde_json::from_str(&text).map(Some).map_err(|error| crate::carry_cause!(invalid, error))
    }
    /// The retained writer answer of a command: its row while the row is kept, else its tombstone's sealed receipt.
    pub fn terminal(&self, id: &str) -> Result<Option<Terminal>, SyncError> {
        if let Some(entry) = self.get(id)? {
            return Ok(entry.terminal);
        }
        let Some(tombstone) = self.tombstone(id)? else {
            return Ok(None);
        };
        open_receipt(&self.owner, &self.resource, &self.roots, &Receipt { id: id.to_owned(), payload: tombstone.receipt }).map(Some)
    }
    /// Input and every provisional record become durable in the same scope.
    /// Returning an already-held key performs no write and retains first input,
    /// bearer, JSON-RPC request id, projection and accepted time exactly.
    pub fn enqueue(&self, command: &Command) -> Result<Submission, SyncError> {
        self.enqueue_based(command, &std::collections::BTreeMap::new())
    }
    /// `enqueue`, with each projected record's committed version at acceptance (`bases`, by record id) kept on its head.
    pub fn enqueue_based(&self, command: &Command, bases: &std::collections::BTreeMap<String, i64>) -> Result<Submission, SyncError> {
        if self.bounds.entries == 0
            || self.bounds.bytes == 0
            || command.owner != self.owner
            || [
                &command.owner,
                &command.sign_in,
                &command.resource,
                &command.operation,
                &command.request_key,
                &command.bearer,
            ]
            .iter()
            .any(|text| text.is_empty())
            || !command.input.is_object()
            || !command.request.is_object()
            || command.accepted_at_ms < 0
            || command.source_generation <= 0
            || command
                .projection
                .iter()
                .any(|row| row.id.is_empty() || (row.kind.is_empty() && row.value.is_some()))
            || command
                .projection
                .iter()
                .map(|row| row.id.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len()
                != command.projection.len()
        {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(command).map_err(|error| crate::carry_cause!(invalid, error))?);
        if bytes.len() > self.bounds.bytes {
            return Err(SyncError::new(
                413,
                "The pending command exceeds its byte bound.",
             crate::cause!()));
        }
        let id = command_id(command)?;
        let scope = Scope::begin(
            &self.storage,
            if self.storage.scoped() {
                Intent::Nested
            } else {
                Intent::Write
            },
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let mut log = self.log();
        if let Some(fields) = log.read(&id)? {
            let held = self.decode(&id, &fields)?;
            if !held.command.same_request(command) {
                return Err(conflict(crate::cause!(pending conflict)));
            }
            let payload = fields.get("submission").cloned().ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
            scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
            return Ok(Submission { id, payload });
        }
        if let Some(tombstone) = self.tombstone(&id)? {
            if tombstone.command != blake3::hash(&serde_json::to_vec(command).map_err(|error| crate::carry_cause!(invalid, error))?).to_hex().to_string() {
                return Err(conflict(crate::cause!(pending conflict)));
            }
            scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
            return Ok(Submission { id, payload: Value::Null });
        }
        let value = PlainCommand(serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(invalid, error))?);
        let payload = sealed::seal_value(
            &self.roots,
            &at(&self.owner, &self.resource, &id, Part::Value),
            &value.0,
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let order = self
            .number("local-accepted-order")?
            .checked_add(1)
            .ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        let pending_count = self.pending_count()?.checked_add(1).ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        let mut previous = ProjectionLinks::new();
        for row in &command.projection {
            let key = self.projection_key(&command.sign_in, &row.id, command.scope.as_ref())?;
            let prior = self.projection_head(&key)?;
            previous.insert(key, prior);
        }
        let previous_value = serde_json::to_value(&previous).map_err(|error| crate::carry_cause!(invalid, error))?;
        let previous_id = format!("{id}:previous");
        let previous_payload = sealed::seal_value(
            &self.roots,
            &at(&self.owner, &self.resource, &previous_id, Part::Value),
            &previous_value,
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let fields = Map::from_iter([
            ("submission".to_owned(), payload.clone()),
            ("order".to_owned(), Value::from(order)),
            ("previous".to_owned(), previous_payload),
        ]);
        log.write(
            &[(&id, "pending-command", Some(fields))],
            Actor::by("local-pending"),
        )?;
        for row in &command.projection {
            let key = self.projection_key(&command.sign_in, &row.id, command.scope.as_ref())?;
            self.put_projection_head(
                &key,
                Some(&ProjectionHead {
                    command: id.clone(),
                    observed: None,
                    base: bases.get(&row.id).copied(),
                }),
            )?;
        }
        log.move_position(
            "local-accepted-order",
            Some(&order.to_string()),
            &command.accepted_at_ms.to_string(),
        )?;
        log.move_position(
            &format!("local-accepted:{order}"),
            Some(&id),
            &command.accepted_at_ms.to_string(),
        )?;
        log.move_position(
            "local-pending-count",
            Some(&pending_count.to_string()),
            &command.accepted_at_ms.to_string(),
        )?;
        scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        Ok(Submission { id, payload })
    }
    /// The next owed call, in durable acceptance order. An indexed point read
    /// finds each order; only newly contiguous terminal receipts advance the
    /// durable frontier. Completed history is never walked again, and a later
    /// out-of-order receipt cannot move this frontier past an earlier call.
    pub fn next_pending(&self) -> Result<Option<(String, Entry)>, SyncError> {
        let write = Scope::begin(
            &self.storage,
            if self.storage.scoped() {
                Intent::Nested
            } else {
                Intent::Write
            },
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let mut log = self.log();
        let highest = self.number("local-accepted-order")?;
        let original = self.number("local-delivered-order")?;
        if original > highest {
            return Err(conflict(crate::cause!(pending conflict)));
        }
        let mut through = original;
        let mut next = None;
        while through < highest {
            let order = through.checked_add(1).ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
            let id = log
                .position(&format!("local-accepted:{order}"))?
                .ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
            if !id_valid(&id) {
                return Err(invalid(crate::cause!(pending invalid)));
            }
            let Some(entry) = self.get(&id)? else {
                if self.tombstone(&id)?.is_none_or(|tombstone| tombstone.order != order) {
                    return Err(conflict(crate::cause!(pending conflict)));
                }
                through = order;
                continue;
            };
            if entry.order != order {
                return Err(conflict(crate::cause!(pending conflict)));
            }
            if entry.terminal.is_none() {
                next = Some((id, entry));
                break;
            }
            through = order;
        }
        if through != original {
            log.move_position("local-delivered-order", Some(&through.to_string()), "")?;
        }
        write.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        Ok(next)
    }
    /// One bounded page of durable work; it requires no source-record read or
    /// in-memory startup inventory. The caller resumes at next on a later step.
    pub fn page(&self, after: Option<&str>) -> Result<Page, SyncError> {
        if self.bounds.entries == 0 || self.bounds.bytes == 0 {
            return Err(invalid(crate::cause!(pending invalid)));
        }
        let buckets: Vec<usize> = (0..digest::BUCKETS).collect();
        let (rows, next) = self.log().records_in_buckets_page(
            &buckets,
            after,
            self.bounds.entries,
            self.bounds.bytes,
        )?;
        let entries = rows
            .into_iter()
            .filter_map(|row| row.value.map(|fields| (row.id, fields)))
            .map(|(id, fields)| self.decode(&id, &fields).map(|entry| (id, entry)))
            .collect::<Result<_, _>>()?;
        Ok(Page { entries, next })
    }
    /// Remove what no reader needs, one bounded pass that resumes where the last one stopped. A completed, non-refused row
    /// goes once no projection head still reads it. A head that still holds the row without an applied image gets one
    /// writer read (`refresh`), and only an image that read applied (`observed`) lets the row go, so nothing is removed
    /// before the writer has applied it. Superseded rows go at once. Each removed row leaves a tombstone holding its sealed
    /// receipt, so a duplicate answers without running again; tombstones past their window go. The pass ends when `due`
    /// answers true (the timer period is up), and the cursor keeps the rest for the next tick.
    pub fn prune(
        &self,
        now_ms: i64,
        due: &dyn Fn() -> bool,
        refresh: &mut dyn FnMut(&str, &str, Option<&Identity>),
    ) -> Result<usize, SyncError> {
        let mut removed = 0;
        let mut after: Option<String> = self.log().position(PRUNE_CURSOR)?;
        let mut finished = true;
        'pages: loop {
            let page = self.page(after.as_deref())?;
            for (id, entry) in &page.entries {
                if due() {
                    finished = false;
                    break 'pages;
                }
                if !entry.terminal.as_ref().is_some_and(|terminal| !terminal.refused) {
                    after = Some(id.clone());
                    continue;
                }
                let mut ready = true;
                for row in &entry.command.projection {
                    let key = self.projection_key(&entry.command.sign_in, &row.id, entry.command.scope.as_ref())?;
                    if let Some(head) = self.projection_head(&key)? {
                        if head.command == *id && head.observed.is_none() {
                            refresh(&entry.command.sign_in, &row.id, entry.command.scope.as_ref());
                            if self.projection_head(&key)?.is_some_and(|head| head.command == *id && head.observed.is_none()) {
                                ready = false;
                            }
                        }
                    }
                }
                after = Some(id.clone());
                if !ready {
                    continue;
                }
                removed += self.remove_completed(id, entry, now_ms)?;
            }
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        let mut log = self.log();
        match after.filter(|_| !finished) {
            Some(cursor) => log.move_position(PRUNE_CURSOR, Some(&cursor), &now_ms.to_string())?,
            None => log.forget_position(PRUNE_CURSOR)?,
        };
        for (copy, took_through, _) in log.positions()? {
            let Some(text) = took_through.filter(|_| copy.starts_with("local-tomb:")) else {
                continue;
            };
            let tombstone: Tombstone = serde_json::from_str(&text).map_err(|error| crate::carry_cause!(invalid, error))?;
            if tombstone.expires_ms < now_ms {
                log.forget_position(&copy)?;
            }
        }
        Ok(removed)
    }
    /// Remove one completed row: its applied heads clear, its receipt moves to a tombstone, in one scope.
    fn remove_completed(&self, id: &str, entry: &Entry, now_ms: i64) -> Result<usize, SyncError> {
        let scope = Scope::begin(&self.storage, if self.storage.scoped() { Intent::Nested } else { Intent::Write })
            .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        for row in &entry.command.projection {
            let key = self.projection_key(&entry.command.sign_in, &row.id, entry.command.scope.as_ref())?;
            if self.projection_head(&key)?.is_some_and(|head| head.command == *id) {
                self.put_projection_head(&key, None)?;
            }
        }
        let mut log = self.log();
        let fields = log.read(id)?.ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
        let receipt = fields.get("receipt").cloned().ok_or_else(|| invalid(crate::cause!(pending invalid)))?;
        let command = blake3::hash(&serde_json::to_vec(&entry.command).map_err(|error| crate::carry_cause!(invalid, error))?).to_hex().to_string();
        let tombstone = Tombstone {
            receipt,
            order: entry.order,
            command,
            expires_ms: entry.command.accepted_at_ms.saturating_add(self.bounds.tombstone_ms),
        };
        let text = serde_json::to_string(&tombstone).map_err(|error| crate::carry_cause!(invalid, error))?;
        log.write(&[(id, "pending-command", None)], Actor::by("local-pending"))?;
        log.move_position(&Self::tombstone_key(id), Some(&text), &now_ms.to_string())?;
        scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        Ok(1)
    }
    /// Retain a known writer result before exposing it to the caller. Duplicate
    /// delivery returns the same result; a changed terminal result is refused.
    pub fn complete(&self, receipt: &Receipt) -> Result<Terminal, SyncError> {
        let terminal = open_receipt(&self.owner, &self.resource, &self.roots, receipt)?;
        let scope = Scope::begin(
            &self.storage,
            if self.storage.scoped() {
                Intent::Nested
            } else {
                Intent::Write
            },
        )
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        let mut log = self.log();
        let mut fields = log.read(&receipt.id)?.ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
        let entry = self.decode(&receipt.id, &fields)?;
        if let Some(held) = entry.terminal {
            if held != terminal {
                return Err(conflict(crate::cause!(pending conflict)));
            }
            scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
            return Ok(held);
        }
        let pending_count = self.pending_count()?.checked_sub(1).ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
        if terminal.refused {
            let links = self.projection_links(&receipt.id, &fields)?;
            for row in &entry.command.projection {
                let key = self.projection_key(
                    &entry.command.sign_in,
                    &row.id,
                    entry.command.scope.as_ref(),
                )?;
                if self
                    .projection_head(&key)?
                    .is_none_or(|head| head.command != receipt.id)
                {
                    continue;
                }
                let mut prior = links.get(&key).cloned().ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
                let mut seen = std::collections::HashSet::from([receipt.id.clone()]);
                while let Some(head) = prior.as_ref() {
                    let id = head.command.clone();
                    if !seen.insert(id.clone()) {
                        return Err(conflict(crate::cause!(pending conflict)));
                    }
                    let Some(previous_fields) = log.read(&id)? else {
                        if self.tombstone(&id)?.is_none() {
                            return Err(conflict(crate::cause!(pending conflict)));
                        }
                        prior = None;
                        break;
                    };
                    let previous_entry = self.decode(&id, &previous_fields)?;
                    Self::projected(
                        &previous_entry,
                        &entry.command.sign_in,
                        &row.id,
                        entry.command.scope.as_ref(),
                    )?;
                    if !previous_entry
                        .terminal
                        .as_ref()
                        .is_some_and(|terminal| terminal.refused)
                    {
                        break;
                    }
                    prior = self
                        .projection_links(&id, &previous_fields)?
                        .get(&key)
                        .cloned()
                        .ok_or_else(|| conflict(crate::cause!(pending conflict)))?;
                }
                self.put_projection_head(&key, prior.as_ref())?;
            }
        }
        fields.insert("receipt".to_owned(), receipt.payload.clone());
        log.write(
            &[(&receipt.id, "pending-command", Some(fields))],
            Actor::by("local-pending"),
        )?;
        log.move_position("local-pending-count", Some(&pending_count.to_string()), "")?;
        scope.commit().map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        Ok(terminal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{memory::Memory, record_store::SCHEMA};
    use serde_json::json;

    fn roots() -> SecretsKeys {
        SecretsKeys::of(&crate::secrets::secrets_key::generate().unwrap()).unwrap()
    }
    fn command() -> Command {
        Command {
            owner: "owner".into(),
            sign_in: "key:test".into(),
            resource: "@own-records".into(),
            operation: "records:write".into(),
            request_key: "first-key".into(),
            input: json!({"records":[{"id":"note","type":"note","value":{"words":"private local value"}}]}),
            scope: None,
            source_generation: 1,
            request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            bearer: "PRIVATE_SYNTHETIC_BEARER".into(),
            accepted_at_ms: 1,
            person_present: None,
            checked_kinds: vec!["note".into()],
            projection: vec![Projection {
                id: "note".into(),
                kind: "note".into(),
                value: Some(json!({"words":"private local value"})),
            }],
        }
    }
    fn bounds() -> Bounds {
        Bounds {
            entries: 2,
            bytes: 16384,
            tombstone_ms: 1_000,
        }
    }
    fn success_terminal() -> Terminal {
        Terminal {
            cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        }
    }
    fn note_image() -> Projection {
        Projection {
            id: "note".into(),
            kind: "note".into(),
            value: Some(json!({"words":"private local value"})),
        }
    }
    #[test]
    fn terminal_refusal_cause_survives_sealed_receipt_and_queue_reopen() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let sent = queue.enqueue(&command()).unwrap();
        let original = crate::cause!(pending writer_refusal);
        let terminal = Terminal {
            cause: original.clone(), status: 409, refused: true,
            body: json!({"code":"current_workspace_rights_refused"}),
        };
        let receipt = seal_receipt("owner", "local-pending", &roots, &sent.id, &terminal).unwrap();
        queue.complete(&receipt).unwrap();
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots, bounds());
        let saved = queue.get(&sent.id).unwrap().unwrap().terminal.unwrap();
        assert!(saved.refused);
        assert_eq!(saved.body["code"], "current_workspace_rights_refused");
        assert_eq!(saved.cause(), original);
        let mut legacy = serde_json::to_value(terminal).unwrap();
        legacy.as_object_mut().unwrap().remove("cause");
        let legacy: Terminal = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.cause().condition(), "historical_origin_unrecorded pending_terminal");
        assert_ne!(legacy.cause(), original);
    }

    #[test]
    fn first_command_and_projection_survive_reopen_without_boot_reads_and_are_sealed() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(queue.pending_count().unwrap(), 0);
        let first = command();
        let sent = queue.enqueue(&first).unwrap();
        assert_eq!(queue.pending_count().unwrap(), 1);
        assert!(!sent
            .payload
            .to_string()
            .contains("PRIVATE_SYNTHETIC_BEARER"));
        assert!(!sent.payload.to_string().contains("private local value"));
        assert!(!format!("{first:?}").contains("PRIVATE_SYNTHETIC_BEARER"));
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots, bounds());
        assert_eq!(
            queue.pending_count().unwrap(),
            1,
            "startup owes a drain before reading any original record"
        );
        let page = queue.page(None).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert!(page.next.is_none());
        assert_eq!(page.entries[0].1.command, first);
        assert!(page.entries[0].1.terminal.is_none());
        assert_eq!(queue.submission(&sent.id).unwrap(), Some(sent));
    }
    #[test]
    fn original_key_retains_first_context_and_rejects_changed_semantics() {
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots(),
            bounds(),
        );
        let first = command();
        let sent = queue.enqueue(&first).unwrap();
        let mut retry = first.clone();
        retry.accepted_at_ms = 2;
        retry.request["id"] = json!(2);
        retry.bearer = "ROTATED_SYNTHETIC_BEARER".into();
        retry.projection.clear();
        assert_eq!(queue.enqueue(&retry).unwrap(), sent);
        assert_eq!(
            queue.pending_count().unwrap(),
            1,
            "a retry adds no pending work"
        );
        assert_eq!(queue.get(&sent.id).unwrap().unwrap().command, first);
        retry.input["records"][0]["value"]["words"] = json!("another input");
        assert_eq!(queue.enqueue(&retry).unwrap_err().status, 409);
        retry = first.clone();
        retry.operation = "records:delete".into();
        assert_eq!(queue.enqueue(&retry).unwrap_err().status, 409);
        retry = first.clone();
        retry.person_present = Some(json!({"claim":"changed"}));
        assert_eq!(queue.enqueue(&retry).unwrap_err().status, 409);
        retry = first.clone();
        retry.source_generation = 2;
        assert_eq!(
            command_id(&retry).unwrap(),
            sent.id,
            "a new generation cannot acquire another address under the old unscoped request key"
        );
        assert_eq!(queue.enqueue(&retry).unwrap_err().status, 409);
    }
    #[test]
    fn held_writer_routing_keeps_pending_order_and_retained_receipts() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let command = command();
        assert!(!queue.requires_queue(&command.sign_in, &command.resource, &command.request_key).unwrap());
        let first = queue.enqueue(&command).unwrap();
        assert_eq!(request_id(&command.owner, &command.sign_in, &command.resource, &command.request_key).unwrap(), first.id);
        assert!(queue.requires_queue(&command.sign_in, &command.resource, "later-command").unwrap(), "an earlier pending command cannot be overtaken when a writer turn returns");
        let refusal = Terminal { cause: crate::cause!(pending terminal), status:200, body:json!({"result":{"isError":true,"structuredContent":{"code":"conflict","outcome":"not_started"}}}), refused:true };
        queue.complete(&seal_receipt("owner", "local-pending", &roots, &first.id, &refusal).unwrap()).unwrap();
        assert!(!queue.requires_queue(&command.sign_in, &command.resource, "later-command").unwrap());
        assert!(queue.requires_queue(&command.sign_in, &command.resource, &command.request_key).unwrap(), "a held writer must replay the first known refusal instead of executing the key afresh");
    }

    #[test]
    fn a_projection_never_crosses_its_accepted_source_generation() {
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots(), bounds());
        let command = command();
        let first = queue.enqueue(&command).unwrap();
        assert!(queue.projection_state_at_generation(&command.sign_in, "note", None, Some(1)).unwrap().is_some());
        assert!(queue.projection_state_at_generation(&command.sign_in, "note", None, Some(2)).unwrap().is_none());
        assert_eq!(queue.get(&first.id).unwrap().unwrap().command, command, "hiding a prior source image never erases its durable command");
        assert_eq!(queue.pending_count().unwrap(), 1);
    }

    #[test]
    fn numeric_equivalent_retry_uses_the_native_identity_and_keeps_first_raw_input() {
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots(),
            bounds(),
        );
        let mut first = command();
        first.input["records"][0]["value"]["count"] = json!(1);
        first.projection[0].value.as_mut().unwrap()["count"] = json!(1);
        let accepted = queue.enqueue(&first).unwrap();
        let mut retry = first.clone();
        retry.input["records"][0]["value"]["count"] = json!(1.0);
        assert_ne!(
            first.input, retry.input,
            "the fixture uses distinct serde number variants"
        );
        assert_eq!(
            queue.enqueue(&retry).unwrap(),
            accepted,
            "native ECMAScript canonical identity treats 1 and 1.0 as one input"
        );
        assert_eq!(
            queue.get(&accepted.id).unwrap().unwrap().command.input,
            first.input,
            "the raw first accepted input is retained exactly"
        );
        assert_eq!(queue.pending_count().unwrap(), 1);
        retry.input["records"][0]["value"]["count"] = json!(2.0);
        assert_eq!(
            queue.enqueue(&retry).unwrap_err().status,
            409,
            "an actually changed number still conflicts under the original key"
        );
    }

    #[test]
    fn known_refusal_is_durable_and_replayed_as_refusal_after_reopen() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let sent = queue.enqueue(&command()).unwrap();
        let refusal = Terminal { cause: crate::cause!(pending terminal),
            status: 403,
            body: json!({"state":"refused","code":"current_rights_refused"}),
            refused: true,
        };
        let receipt = seal_receipt("owner", "local-pending", &roots, &sent.id, &refusal).unwrap();
        assert_eq!(queue.complete(&receipt).unwrap(), refusal);
        assert_eq!(queue.complete(&receipt).unwrap(), refusal);
        assert_eq!(
            queue.pending_count().unwrap(),
            0,
            "a known refusal clears once, never twice"
        );
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(
            queue.pending_count().unwrap(),
            0,
            "the clear and known refusal survived relaunch together"
        );
        assert_eq!(
            queue.get(&sent.id).unwrap().unwrap().terminal,
            Some(refusal.clone())
        );
        let changed = seal_receipt(
            "owner",
            "local-pending",
            &roots,
            &sent.id,
            &Terminal { cause: crate::cause!(pending terminal),
                status: 200,
                body: json!({"saved":true}),
                refused: false,
            },
        )
        .unwrap();
        assert_eq!(queue.complete(&changed).unwrap_err().status, 409);
        let mut misplaced = receipt;
        misplaced.id = "0".repeat(blake3::OUT_LEN * 2);
        assert!(queue.complete(&misplaced).is_err());
    }
    #[test]
    fn recovery_pages_are_bounded_and_different_request_keys_do_not_alias() {
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots(),
            Bounds {
                entries: 1,
                ..bounds()
            },
        );
        let mut first = command();
        let one = queue.enqueue(&first).unwrap();
        first.request_key = "second-key".into();
        let two = queue.enqueue(&first).unwrap();
        assert_ne!(one.id, two.id);
        let page = queue.page(None).unwrap();
        assert_eq!(page.entries.len(), 1);
        let next = queue.page(page.next.as_deref()).unwrap();
        assert_eq!(next.entries.len(), 1);
        assert!(next.next.is_none());
        assert_ne!(page.entries[0].0, next.entries[0].0);
    }

    #[test]
    fn delivery_uses_acceptance_order_for_key_zero_and_key_three_despite_reversed_buckets() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let mut first = command();
        first.request_key = "key-0".into();
        first.projection[0].value = Some(json!({"words":"A"}));
        let one = queue.enqueue(&first).unwrap();
        let mut second = first.clone();
        second.request_key = "key-3".into();
        second.projection[0].value = Some(json!({"words":"B"}));
        let two = queue.enqueue(&second).unwrap();
        assert!(
            digest::bucket_of(&two.id) < digest::bucket_of(&one.id),
            "the reported pair reproduces reversed bucket order"
        );
        assert_eq!(
            queue.page(None).unwrap().entries[0].0,
            two.id,
            "a bucket page alone would deliver B first"
        );
        assert_eq!(
            queue.next_pending().unwrap().unwrap().0,
            one.id,
            "A was accepted first and must reach its writer first"
        );
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(
            queue.next_pending().unwrap().unwrap().0,
            one.id,
            "relaunch cannot overtake the first owed command"
        );
        let success = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &one.id, &success).unwrap())
            .unwrap();
        assert_eq!(queue.next_pending().unwrap().unwrap().0, two.id);
        let reopened = queue.storage.reopen();
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(
            queue.next_pending().unwrap().unwrap().0,
            two.id,
            "the contiguous completed frontier is durable too"
        );
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &two.id, &success).unwrap())
            .unwrap();
        assert!(queue.next_pending().unwrap().is_none());
        assert_eq!(queue.pending_count().unwrap(), 0);
        assert_eq!(
            queue.get(&one.id).unwrap().unwrap().terminal,
            Some(success),
            "delivery cursors never remove retained retry answers"
        );
    }

    #[test]
    fn an_out_of_order_completion_cannot_drop_earlier_pending_work() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let mut first = command();
        first.request_key = "key-0".into();
        let one = queue.enqueue(&first).unwrap();
        let mut second = first.clone();
        second.request_key = "key-3".into();
        let two = queue.enqueue(&second).unwrap();
        let mut third = first.clone();
        third.request_key = "third".into();
        let three = queue.enqueue(&third).unwrap();
        let success = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        let receipt =
            |id: &str| seal_receipt("owner", "local-pending", &roots, id, &success).unwrap();
        queue.complete(&receipt(&two.id)).unwrap();
        assert_eq!(queue.pending_count().unwrap(), 2);
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(
            queue.next_pending().unwrap().unwrap().0,
            one.id,
            "B's known receipt cannot advance across unfinished A"
        );
        queue.complete(&receipt(&one.id)).unwrap();
        assert_eq!(
            queue.next_pending().unwrap().unwrap().0,
            three.id,
            "the cursor skips B only once A is known terminal"
        );
        assert_eq!(queue.pending_count().unwrap(), 1);
    }

    #[test]
    fn terminal_receipts_do_not_hide_later_pending_pages() {
        let roots = roots();
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots.clone(),
            Bounds {
                entries: 1,
                ..bounds()
            },
        );
        for n in 0..5 {
            let mut command = command();
            command.request_key = format!("key-{n}");
            queue.enqueue(&command).unwrap();
        }
        assert_eq!(queue.pending_count().unwrap(), 5);
        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let page = queue.page(cursor.as_deref()).unwrap();
            assert!(page.entries.len() <= 1);
            ids.extend(page.entries.into_iter().map(|(id, _)| id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let terminal = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        for id in &ids[..4] {
            let receipt = seal_receipt("owner", "local-pending", &roots, id, &terminal).unwrap();
            queue.complete(&receipt).unwrap();
        }
        assert_eq!(
            queue.pending_count().unwrap(),
            1,
            "completed receipt history does not count as pending capacity"
        );
        let mut cursor = None;
        let mut pending = Vec::new();
        loop {
            let page = queue.page(cursor.as_deref()).unwrap();
            assert!(page.entries.len() <= 1);
            pending.extend(
                page.entries
                    .into_iter()
                    .filter(|(_, entry)| entry.terminal.is_none())
                    .map(|(id, _)| id),
            );
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(pending, ids[4..]);
    }

    #[test]
    fn acceptance_order_is_durable_when_the_clock_repeats_or_goes_backwards() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let mut next = first.clone();
        next.request_key = "second".into();
        let two = queue.enqueue(&next).unwrap();
        let order_one = queue.get(&one.id).unwrap().unwrap().order;
        let order_two = queue.get(&two.id).unwrap().unwrap().order;
        assert!(
            order_two > order_one,
            "same-millisecond commands retain their local order"
        );
        assert_eq!(queue.enqueue(&first).unwrap(), one);
        assert_eq!(
            queue.get(&one.id).unwrap().unwrap().order,
            order_one,
            "retry does not become a later write"
        );
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots, bounds());
        next.request_key = "third".into();
        next.accepted_at_ms = 0;
        let three = queue.enqueue(&next).unwrap();
        assert!(
            queue.get(&three.id).unwrap().unwrap().order > order_two,
            "relaunch and a backwards clock do not reorder writes"
        );
    }

    #[test]
    fn an_unsealable_command_leaves_no_half_kept_projection_or_request() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let queue = Queue::new(
            storage,
            "owner",
            "local-pending",
            SecretsKeys::default(),
            bounds(),
        );
        assert!(queue.enqueue(&command()).is_err());
        assert_eq!(
            queue.pending_count().unwrap(),
            0,
            "a rolled back input has no pending count"
        );
        assert!(queue.page(None).unwrap().entries.is_empty());
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots(), bounds());
        let sent = queue.enqueue(&command()).unwrap();
        assert!(queue.get(&sent.id).unwrap().is_some());
    }

    #[test]
    fn a_writer_success_keeps_the_local_image_and_a_receipt_cannot_cross_accounts_or_parts() {
        let roots = roots();
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots.clone(),
            bounds(),
        );
        let first = command();
        let sent = queue.enqueue(&first).unwrap();
        let result = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"result":{"structuredContent":{"write_count":1}}}),
            refused: false,
        };
        let receipt = seal_receipt("owner", "local-pending", &roots, &sent.id, &result).unwrap();
        assert!(open_receipt("another-owner", "local-pending", &roots, &receipt).is_err());
        assert!(open_receipt("owner", "another-resource", &roots, &receipt).is_err());
        assert!(open_receipt(
            "owner",
            "local-pending",
            &roots,
            &Receipt {
                id: sent.id.clone(),
                payload: sent.payload
            }
        )
        .is_err());
        assert_eq!(queue.complete(&receipt).unwrap(), result);
        assert_eq!(
            queue.pending_count().unwrap(),
            0,
            "success clears its pending count atomically"
        );
        let entry = queue.get(&sent.id).unwrap().unwrap();
        assert_eq!(entry.command.projection, first.projection);
        assert_eq!(entry.terminal, Some(result));
    }

    #[test]
    fn a_completed_head_kept_before_bases_existed_steps_aside_once_the_copy_holds_a_version() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let sent = queue.enqueue(&first).unwrap();
        let held = |version| Some((version, json!({"words":"later"})));
        let state = |store| queue.projection_state_with_store(&first.sign_in, "note", None, None, store).unwrap();
        assert!(state(held(1)).is_some(), "a head whose command is pending answers whatever the copy holds");
        queue.complete(&seal_receipt("owner", "local-pending", &roots, &sent.id, &success_terminal()).unwrap()).unwrap();
        assert!(state(None).is_some(), "a copy that holds no version leaves the head's image");
        assert!(state(held(1)).is_none(), "a completed head kept before bases existed is older than every committed version");
    }

    #[test]
    fn direct_projection_lookup_keeps_acceptance_order_when_the_clock_repeats() {
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots(),
            bounds(),
        );
        let first = command();
        let first_submission = queue.enqueue(&first).unwrap();
        let mut next = first.clone();
        next.request_key = "second".into();
        next.input["records"][0]["value"]["words"] = json!("newer local value");
        next.projection[0].value = Some(json!({"words":"newer local value"}));
        queue.enqueue(&next).unwrap();
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(next.projection[0].clone())
        );
        assert_eq!(queue.enqueue(&first).unwrap(), first_submission);
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(next.projection[0].clone()),
            "retry does not replace the later accepted image"
        );
        assert!(queue
            .projection("key:another", "note", None)
            .unwrap()
            .is_none());
        let other_scope = Identity {
            id: "other-history".into(),
            incarnation: "one".into(),
            generation: 1,
        };
        assert!(queue
            .projection(&first.sign_in, "note", Some(&other_scope))
            .unwrap()
            .is_none());
        assert!(queue
            .projection(&first.sign_in, "another-record", None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_newer_refusal_falls_back_over_older_refusals_without_scanning_receipt_history() {
        let roots = roots();
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let mut second = first.clone();
        second.request_key = "second".into();
        second.projection[0].value = Some(json!({"words":"second"}));
        let two = queue.enqueue(&second).unwrap();
        let mut third = second.clone();
        third.request_key = "third".into();
        third.projection[0].value = Some(json!({"words":"third"}));
        let three = queue.enqueue(&third).unwrap();
        let refused = Terminal { cause: crate::cause!(pending terminal),
            status: 403,
            body: json!({"state":"refused"}),
            refused: true,
        };
        let receipt =
            |id: &str| seal_receipt("owner", "local-pending", &roots, id, &refused).unwrap();
        queue.complete(&receipt(&two.id)).unwrap();
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(third.projection[0].clone()),
            "an older refusal cannot displace the newest pending image"
        );
        queue.complete(&receipt(&three.id)).unwrap();
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(first.projection[0].clone()),
            "the head skips the refused middle command"
        );
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots.clone(), bounds());
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(first.projection[0].clone()),
            "the repaired head survives relaunch"
        );
        queue.complete(&receipt(&one.id)).unwrap();
        assert!(
            queue
                .projection(&first.sign_in, "note", None)
                .unwrap()
                .is_none(),
            "when every attempted image was refused no provisional value remains"
        );
        assert_eq!(queue.pending_count().unwrap(), 0);
    }

    #[test]
    fn a_provisional_removal_is_a_directly_indexed_local_image() {
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots(),
            bounds(),
        );
        let mut removal = command();
        removal.projection[0].value = None;
        removal.projection[0].kind.clear();
        queue.enqueue(&removal).unwrap();
        assert_eq!(
            queue.projection(&removal.sign_in, "note", None).unwrap(),
            Some(removal.projection[0].clone())
        );
    }

    #[test]
    fn a_writer_observation_cannot_overwrite_a_raced_newer_local_head() {
        let roots = roots();
        let queue = Queue::new(
            Memory::open(SCHEMA).unwrap(),
            "owner",
            "local-pending",
            roots.clone(),
            bounds(),
        );
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let observed = Projection {
            id: "note".into(),
            kind: "note".into(),
            value: Some(json!({"words":"later at writer"})),
        };
        assert!(
            !queue
                .refresh_projection(&first.sign_in, "note", None, &one.id, &observed)
                .unwrap(),
            "an unfinished command keeps its provisional image"
        );
        let success = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &one.id, &success).unwrap())
            .unwrap();
        let (read_head, _, _) = queue
            .projection_state(&first.sign_in, "note", None)
            .unwrap()
            .unwrap();
        let mut newer = first.clone();
        newer.request_key = "newer-key".into();
        newer.projection[0].value = Some(json!({"words":"newer on this computer"}));
        let two = queue.enqueue(&newer).unwrap();
        assert!(
            !queue
                .refresh_projection(&first.sign_in, "note", None, &read_head, &observed)
                .unwrap(),
            "the writer read began before a newer local acceptance"
        );
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(newer.projection[0].clone())
        );
        assert!(
            !queue
                .refresh_projection(&first.sign_in, "note", None, &two.id, &observed)
                .unwrap(),
            "the new pending image cannot refresh yet either"
        );
        let mut other_record = observed.clone();
        other_record.id = "other".into();
        assert!(queue
            .refresh_projection(&first.sign_in, "note", None, &two.id, &other_record)
            .is_err());
    }

    #[test]
    fn an_observed_earlier_image_survives_a_refused_newer_head_and_relaunch() {
        let storage = Memory::open(SCHEMA).unwrap();
        let reopened = storage.reopen();
        let roots = roots();
        let queue = Queue::new(storage, "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let success = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &one.id, &success).unwrap())
            .unwrap();
        let observed = Projection {
            id: "note".into(),
            kind: "note".into(),
            value: Some(json!({"words":"changed later by another writer call"})),
        };
        assert!(queue
            .refresh_projection(&first.sign_in, "note", None, &one.id, &observed)
            .unwrap());
        let mut newer = first.clone();
        newer.request_key = "newer-refused".into();
        newer.projection[0].value = Some(json!({"words":"not allowed"}));
        let two = queue.enqueue(&newer).unwrap();
        let refused = Terminal { cause: crate::cause!(pending terminal),
            status: 403,
            body: json!({"state":"refused"}),
            refused: true,
        };
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &two.id, &refused).unwrap())
            .unwrap();
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(observed.clone())
        );
        drop(queue);
        let queue = Queue::new(reopened, "owner", "local-pending", roots, bounds());
        let (head, entry, image) = queue
            .projection_state(&first.sign_in, "note", None)
            .unwrap()
            .unwrap();
        assert_eq!(head, one.id);
        assert_eq!(entry.command, first);
        assert_eq!(entry.terminal, Some(success));
        assert_eq!(image, observed);
    }

    #[test]
    fn a_writer_observation_survives_an_actual_store_close_without_rewriting_the_command() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".local")
            .join(format!(
                "pending-observed-reopen-{}",
                crate::storage::record_store::record_log::uuidv7(0)
            ));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("records.sqlite");
        let roots = roots();
        let open = || {
            crate::storage::sqlite::open_owned(
                &path,
                SCHEMA,
                crate::storage::record_store_resources::bounds(),
            )
            .unwrap()
        };
        let queue = Queue::new(open(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let success = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        queue
            .complete(&seal_receipt("owner", "local-pending", &roots, &one.id, &success).unwrap())
            .unwrap();
        let observed = Projection {
            id: "note".into(),
            kind: "note".into(),
            value: Some(json!({"words":"writer read after another edit"})),
        };
        assert!(queue
            .refresh_projection(&first.sign_in, "note", None, &one.id, &observed)
            .unwrap());
        drop(queue);
        let queue = Queue::new(open(), "owner", "local-pending", roots, bounds());
        let (head, entry, image) = queue
            .projection_state(&first.sign_in, "note", None)
            .unwrap()
            .unwrap();
        assert_eq!(head, one.id);
        assert_eq!(entry.command, first);
        assert_eq!(entry.terminal, Some(success));
        assert_eq!(image, observed);
        assert_eq!(queue.pending_count().unwrap(), 0);
        drop(queue);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_rekeyed_writer_answers_under_the_submission_root_without_giving_away_its_new_root() {
        let old = crate::secrets::secrets_key::generate().unwrap();
        let sender = SecretsKeys::of(&old).unwrap();
        let mut writer = sender.clone();
        let fresh = crate::secrets::secrets_key::generate().unwrap();
        let fresh_identity = writer.add(&fresh).unwrap();
        writer.make_current(&fresh_identity).unwrap();
        let submitted = seal_submission("owner", "local-pending", &sender, &command()).unwrap();
        assert_eq!(
            open_submission("owner", "local-pending", &writer, &submitted).unwrap(),
            command()
        );
        let result = Terminal { cause: crate::cause!(pending terminal),
            status: 200,
            body: json!({"saved":true}),
            refused: false,
        };
        let wrong =
            seal_receipt("owner", "local-pending", &writer, &submitted.id, &result).unwrap();
        assert!(
            open_receipt("owner", "local-pending", &sender, &wrong).is_err(),
            "the removed sender has no new root"
        );
        let reply =
            seal_reply_to_submission("owner", "local-pending", &writer, &submitted, &result)
                .unwrap();
        assert_eq!(reply.payload["key"], submitted.payload["key"]);
        assert_ne!(reply.payload["key"], Value::String(fresh_identity.clone()));
        assert_eq!(
            open_receipt("owner", "local-pending", &sender, &reply).unwrap(),
            result
        );
        assert_eq!(
            writer.current(),
            Some(fresh_identity.as_str()),
            "choosing a reply key never changes the writer's root"
        );
        let mut forged = submitted;
        forged.payload["key"] = Value::String(fresh_identity);
        assert!(
            seal_reply_to_submission("owner", "local-pending", &writer, &forged, &result).is_err(),
            "an unauthenticated key label grants no choice of root"
        );
    }

    #[test]
    fn a_pending_command_is_read_back_from_the_closed_durable_store() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".local")
            .join(format!(
                "pending-command-reopen-{}",
                crate::storage::record_store::record_log::uuidv7(0)
            ));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("records.sqlite");
        let roots = roots();
        let open = || {
            crate::storage::sqlite::open_owned(
                &path,
                SCHEMA,
                crate::storage::record_store_resources::bounds(),
            )
            .unwrap()
        };
        let queue = Queue::new(open(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let sent = queue.enqueue(&first).unwrap();
        drop(queue);
        let queue = Queue::new(open(), "owner", "local-pending", roots, bounds());
        assert_eq!(queue.get(&sent.id).unwrap().unwrap().command, first);
        assert_eq!(
            queue.projection(&first.sign_in, "note", None).unwrap(),
            Some(first.projection[0].clone()),
            "the direct local index survives an actual store close/reopen"
        );
        drop(queue);
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes
            .windows(first.bearer.len())
            .any(|part| part == first.bearer.as_bytes()));
        assert!(!bytes
            .windows("private local value".len())
            .any(|part| part == b"private local value"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// Incident 25, durable-lanes (D50): a command whose committed writer receipt is retained stays in the outbox store
    /// after it is acknowledged. The row goes once its projection head has applied the writer's image, and a tombstone keeps
    /// the receipt for duplicates.
    fn acknowledged_row_body() -> Result<(), String> {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let submitted = queue.enqueue(&first).map_err(|error| format!("enqueue: {error:?}"))?;
        let receipt = seal_receipt("owner", "local-pending", &roots, &submitted.id, &success_terminal())
            .map_err(|error| format!("receipt: {error:?}"))?;
        queue.complete(&receipt).map_err(|error| format!("complete: {error:?}"))?;
        queue.prune(2, &|| false, &mut |_, _, _| {}).map_err(|error| format!("prune: {error:?}"))?;
        if queue.get(&submitted.id).map_err(|error| format!("get: {error:?}"))?.is_none() {
            return Err("a completed head is pruned before the local copy applied its image".into());
        }
        queue
            .refresh_projection(&first.sign_in, "note", None, &submitted.id, &note_image())
            .map_err(|error| format!("refresh: {error:?}"))?;
        queue.prune(3, &|| false, &mut |_, _, _| {}).map_err(|error| format!("prune: {error:?}"))?;
        match queue.get(&submitted.id).map_err(|error| format!("get: {error:?}"))? {
            None => {}
            Some(_) => return Err("the acknowledged outbox row is kept after its image applied".into()),
        }
        if queue.terminal(&submitted.id).map_err(|error| format!("terminal: {error:?}"))? != Some(success_terminal()) {
            return Err("the tombstone no longer answers the committed receipt".into());
        }
        Ok(())
    }
    #[test]
    fn duplicate_of_a_pruned_command_answers_without_running_again() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let submitted = queue.enqueue(&first).unwrap();
        let receipt = seal_receipt("owner", "local-pending", &roots, &submitted.id, &success_terminal()).unwrap();
        queue.complete(&receipt).unwrap();
        queue.refresh_projection(&first.sign_in, "note", None, &submitted.id, &note_image()).unwrap();
        assert_eq!(queue.prune(2, &|| false, &mut |_, _, _| {}).unwrap(), 1);
        assert!(queue.get(&submitted.id).unwrap().is_none());
        let again = queue.enqueue(&first).unwrap();
        assert_eq!(again.id, submitted.id, "the duplicate answers under its original key");
        assert_eq!(queue.terminal(&submitted.id).unwrap(), Some(success_terminal()));
        assert!(queue.requires_queue(&first.sign_in, &first.resource, &first.request_key).unwrap());
        assert!(queue.next_pending().unwrap().is_none(), "a pruned command is never delivered again");
        assert_eq!(queue.pending_count().unwrap(), 0);
        let mut changed = first.clone();
        changed.input = json!({"records":[{"id":"note","type":"note","value":{"words":"other"}}]});
        assert!(queue.enqueue(&changed).is_err(), "a changed command under a pruned key is refused");
    }
    #[test]
    fn tombstone_is_forgotten_past_its_window() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let submitted = queue.enqueue(&first).unwrap();
        let receipt = seal_receipt("owner", "local-pending", &roots, &submitted.id, &success_terminal()).unwrap();
        queue.complete(&receipt).unwrap();
        queue.refresh_projection(&first.sign_in, "note", None, &submitted.id, &note_image()).unwrap();
        queue.prune(2, &|| false, &mut |_, _, _| {}).unwrap();
        queue.prune(500, &|| false, &mut |_, _, _| {}).unwrap();
        assert!(queue.terminal(&submitted.id).unwrap().is_some(), "inside the window the answer is kept");
        queue.prune(first.accepted_at_ms + 1_001, &|| false, &mut |_, _, _| {}).unwrap();
        assert!(queue.terminal(&submitted.id).unwrap().is_none(), "past the window nothing answers");
        assert!(!queue.requires_queue(&first.sign_in, &first.resource, &first.request_key).unwrap());
    }

    #[test]
    fn head_blocked_row_is_pruned_only_after_its_writer_read() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let submitted = queue.enqueue(&first).unwrap();
        let receipt = seal_receipt("owner", "local-pending", &roots, &submitted.id, &success_terminal()).unwrap();
        queue.complete(&receipt).unwrap();
        assert_eq!(queue.prune(2, &|| false, &mut |_, _, _| {}).unwrap(), 0, "the head has no applied image, so nothing goes");
        assert!(queue.get(&submitted.id).unwrap().is_some());
        let mut reads = 0;
        let removed = queue
            .prune(3, &|| false, &mut |sign_in, id, scope| {
                reads += 1;
                queue.refresh_projection(sign_in, id, scope, &submitted.id, &note_image()).unwrap();
            })
            .unwrap();
        assert_eq!(reads, 1, "the blocked head gets one writer read");
        assert_eq!(removed, 1, "the row goes once the read applied its image");
        assert!(queue.get(&submitted.id).unwrap().is_none());
        assert_eq!(queue.terminal(&submitted.id).unwrap(), Some(success_terminal()));
    }
    #[test]
    fn prune_pass_stops_at_its_deadline_and_resumes_at_the_cursor() {
        let roots = roots();
        let queue = Queue::new(Memory::open(SCHEMA).unwrap(), "owner", "local-pending", roots.clone(), bounds());
        let first = command();
        let one = queue.enqueue(&first).unwrap();
        let mut next = first.clone();
        next.request_key = "second".into();
        let two = queue.enqueue(&next).unwrap();
        for id in [&one.id, &two.id] {
            let receipt = seal_receipt("owner", "local-pending", &roots, id, &success_terminal()).unwrap();
            queue.complete(&receipt).unwrap();
        }
        let calls = std::cell::Cell::new(0);
        let due = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        let stopped = queue.prune(3, &due, &mut |_, _, _| {}).unwrap();
        assert!(stopped <= 1, "the first pass stops when the tick is due, before the second row");
        queue.refresh_projection(&first.sign_in, "note", None, &two.id, &note_image()).unwrap();
        queue.prune(4, &|| false, &mut |_, _, _| {}).unwrap();
        assert!(queue.get(&one.id).unwrap().is_none(), "the superseded row is gone");
        assert!(queue.get(&two.id).unwrap().is_none(), "the next pass resumes and removes the rest");
    }
    #[test]
    fn acknowledged_outbox_row_is_pruned_after_every_copy_acks() {
        crate::simulation::verdict("acknowledged-outbox-row-is-pruned-after-every-copy-acks", acknowledged_row_body);
    }
}
