//! Concrete ordinary-browser command capture and protected completion.
//! One original parent owns one command record and one execution, even when its
//! synchronous local work writes several settings. Every change is planned
//! after the earlier changes on the SAME selected IMMEDIATE transaction and
//! written to the account's own records (record store, `own_records::InCommand`) in
//! that transaction: record store is the only store a command writes. External
//! handoffs/providers are not executed under this local transaction.
use super::super::own_records::InCommand;
use super::*;
use crate::{
    ecma_json::{self, Object},
    record_log::original_setting::{self, OriginalKey, OriginalRecord},
    record_value::KeyState,
    storage::record_store::settings::Limits,
    workspace_domain::{DomainCommand, DomainContext},
};
use content_crypto::advanced::blake3;
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;
use crate::storage::record_store_resources::{domains as command_domain, StateResources};

#[path = "native_command_context/execution_metadata.rs"]
pub mod execution_metadata;
#[path = "../record_log/host_observations.rs"]
pub(crate) mod host_observations;
#[path = "native_command_context/internal_batch.rs"]
mod internal_batch;
#[path = "native_command_context/privacy.rs"]
pub mod privacy;
#[path = "native_command_context/source_values.rs"]
mod source_values;
#[path = "native_command_context/workspace_write.rs"]
mod workspace_write;
pub(crate) use workspace_write::workspace_value_identity;
pub(crate) use workspace_write::OPERATION as WORKSPACE_WRITE;
#[path = "native_command_context/original_mutations.rs"]
mod original_mutations;
#[path = "native_command_context/workspace_generation.rs"]
pub(crate) mod workspace_generation;
#[path = "native_command_context/workspace_write_join.rs"]
mod workspace_write_join;
#[path = "native_command_context/workspace_write_output.rs"]
mod workspace_write_output;
#[path = "native_command_context/workspace_write_readback.rs"]
mod workspace_write_readback;
#[path = "native_command_context/workspace_write_sql.rs"]
mod workspace_write_sql;
// The account's rules and workflow runs after a records:write: the running-tools job's code (capabilities.json), kept
// with the rule bindings, on this transaction.
#[path = "../rule_bindings/rules_and_runs/on_write.rs"]
mod rules_and_runs_on_write;
enum EffectResult {
    Counts { removals: Vec<i64> },
}

/// How long the read that delivers a committed command's answer may take, and wait for another connection of the file.
const DELIVERY_BOUND: std::time::Duration = std::time::Duration::from_millis(250);

/// Undo work for which this owner has not requested COMMIT. Old trillion's
/// record-log-store.mjs:3524-3527 preserves the original work failure through
/// cleanup; this native owner also checks SQLite's actual transaction state.
/// An interrupted write can already have rolled back the entire transaction:
/// autocommit proves that outcome, so a second ROLLBACK must not invent an
/// unknown outcome. If it is still open, its exhausted effect budget cannot
/// interrupt the cleanup that removes it. No effect or commit runs afterward.
fn rollback_precommit(tx: crate::storage::sqlite::Transaction<'_>) -> Result<()> {
    tx.progress_handler(0, None::<fn() -> bool>);
    if tx.is_autocommit() {
        return Ok(());
    }
    tx.rollback().map_err(|error| {
        let refusal = crate::carry_cause!(Error::OutcomeUnknown, error);
        crate::quiet_eprintln!("record-writer event=unknown reason=rollback code={:?} cause={}", error.sqlite_error_code(), refusal.cause());
        refusal
    })
}

/// A test's step run right after a command on the record book at its path commits and before its answer is delivered.
#[cfg(test)]
pub(crate) static AFTER_COMMIT: std::sync::Mutex<Vec<(PathBuf, Box<dyn FnOnce() + Send>)>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(test)]
fn after_commit_hook(book: &std::path::Path) {
    let hook = {
        let mut hooks = AFTER_COMMIT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        hooks
            .iter()
            .position(|(path, _)| path == book)
            .map(|at| hooks.remove(at).1)
    };
    if let Some(hook) = hook {
        hook();
    }
}

#[path = "native_command_context/selected_workspace_command.rs"]
mod selected_workspace_command;
pub(crate) use selected_workspace_command::{
    OriginalWorkspaceOutputCustody, SelectedOwnRecordsRecoveryCall, SelectedWorkspaceWriteCall,
};

/// In-memory custody for a protected original command result. It retains only
/// the journal/result versions and exact key-read witnesses from the same
/// read-only record snapshot as the value.
pub(crate) struct OriginalRecordsResultReadProof {
    binding: CommandBinding,
    path: PathBuf,
    // Retain the original file so an unlinked inode cannot be reused while
    // this answer remains in custody.
    _file: std::fs::File,
    inode: super::super::Inode,
    result_id: String,
    command_version: i64,
    result_version: i64,
    routes: Option<crate::local_account::own_records::OwnReadRoutes>,
    key_reads: crate::local_account::own_records::KeyReads,
    domain: Option<command_domain::Bound>,
    base: Option<(PathBuf, super::super::Inode, std::fs::File, Option<crate::local_account::own_records::OwnReadRoutes>)>,
}
impl OriginalRecordsResultReadProof {
    pub(crate) fn unchanged(
        &self,
        readers: &crate::storage::record_store_resources::Readers,
        owner_id: &str,
        routes: Option<&crate::local_account::own_records::OwnReadRoutes>,
    ) -> std::result::Result<bool, crate::records::Error> {
        if let Some((path, inode, _file, expected_routes)) = &self.base {
            if readers.path() != path || inode.check(path).is_err() || check_sqlite_sidecars(path).is_err()
                || !match (expected_routes, routes) {
                    (None,None) => true,
                    (Some(expected),Some(now)) => expected.same_context(now),
                    _ => false,
                }
                || !readers.read(|store| crate::local_account::own_records::original_command_source_matches(
                    &store, owner_id, self.binding.generation.as_i64().ok_or(crate::cause!(crate::records::Error::Unavailable))?))? {
                return Ok(false);
            }
        }
        let selected_readers = self.domain.as_ref().map(|domain| domain.readers()).transpose()?;
        let readers = selected_readers.as_deref().unwrap_or(readers);
        let routes = if self.domain.is_some() { None } else { routes };
        if owner_id != self.binding.owner
            || readers.path() != self.path
            || self.inode.check(&self.path).is_err()
            || check_sqlite_sidecars(&self.path).is_err()
            || !match (&self.routes, routes) {
                (None, None) => true,
                (Some(expected), Some(current)) => expected.same_context(current),
                _ => false,
            }
        {
            return Ok(false);
        }
        readers
            .read(|mut store| {
                let model = crate::record_model_policy::own_model()
                    .map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
                store.set_referrer_model(
                    model.referrer_parts().to_vec(),
                    Some(vec!["stored".into()]),
                )?;
                if !crate::local_account::own_records::original_generation_matches(
                    &store,
                    owner_id,
                    self.binding
                        .generation
                        .as_i64()
                        .ok_or(crate::cause!(crate::records::Error::Unavailable))?,
                )? {
                    return Ok(false);
                }
                if let Some(domain) = &self.domain {
                    let (_, header) = store.held_record_with_version(owner_id,
                        crate::local_account::own_records::IDENTITY, "command-domain")?;
                    let expected = serde_json::to_value(domain.selection().identity()).map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
                    if header.is_none_or(|header| header.value != expected) { return Ok(false); }
                }
                let command_version = store
                    .held_record_with_version(
                        owner_id,
                        crate::local_account::own_records::COMMANDS,
                        &self.binding.permit_id,
                    )?
                    .0;
                let result_version = store
                    .held_record_with_version(
                        owner_id,
                        crate::local_account::own_records::RESOURCE,
                        &self.result_id,
                    )?
                    .0;
                if command_version != self.command_version || result_version != self.result_version
                {
                    return Ok(false);
                }
                for ((resource, id), expected) in &self.key_reads {
                    if resource != crate::local_account::own_records::RESOURCE {
                        return Ok(false);
                    }
                    if crate::local_account::own_records::observed_key_in(&store, owner_id, id)?
                        != *expected
                    {
                        return Ok(false);
                    }
                }
                Ok(true)
            })
            .and_then(|unchanged| {
                Ok(unchanged
                    && self.inode.check(&self.path).is_ok()
                    && check_sqlite_sidecars(&self.path).is_ok()
                    && self.base.as_ref().is_none_or(|(path,inode,_,_)|
                        inode.check(path).is_ok() && check_sqlite_sidecars(path).is_ok()))
            })
    }
}

/// Supplied by the actual admitted operation/schema owner. Original identity
/// is the existing command binding, not a cloud permit or registered agent card.
/// Input gets an independent exact ECMA digest below; reuse with changed input
/// cannot be hidden behind a caller's repeated original identity.
pub struct NativeCommandCall<'a> {
    pub session: &'a WorkspaceSession,
    pub cancel: Arc<AtomicBool>,
    pub command: &'a DomainCommand,
    pub input_schema: &'a Value,
    pub permit_id: &'a str,
    pub original_identity: &'a str,
    pub request: &'a Request,
    pub log_context: &'a Context,
    pub deadline: Instant,
}
impl<'a> NativeCommandCall<'a> {
    /// Preserve the actual browser request lifetime and original parent input.
    pub fn from_domain(
        context: &'a DomainContext,
        command: &'a DomainCommand,
        input_schema: &'a Value,
        permit_id: &'a str,
        original_identity: &'a str,
        request: &'a Request,
        log_context: &'a Context,
        deadline: Instant,
    ) -> Self {
        Self {
            session: &context.session,
            cancel: context.permit.cancellation_flag(),
            command,
            input_schema,
            permit_id,
            original_identity,
            request,
            log_context,
            deadline,
        }
    }
}
impl fmt::Debug for NativeCommandCall<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeCommandCall([redacted])")
    }
}
impl<'a> NativeCommandCall<'a> {
    fn admitted_by_browser<'c>(&self) -> CommandCall<'a, 'c> {
        CommandCall {
            admitter: Admitter::Browser(self.session),
            cancel: self.cancel.clone(),
            command: self.command,
            input_schema: self.input_schema,
            permit_id: self.permit_id,
            original_identity: self.original_identity,
            request: self.request,
            log_context: self.log_context,
            deadline: self.deadline,
        }
    }
}
/// Who admitted one command, rechecked at every step of its transaction: an
/// ordinary browser session, or the selected personal key's retained
/// current-rights check (its writer road comes from the authenticated sign-in).
enum Admitter<'a, 'c> {
    Browser(&'a WorkspaceSession),
    Personal {
        sign_in: &'a str,
        current: &'c mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>,
    },
}
/// One native command as its transaction owner runs it, whoever admitted it.
struct CommandCall<'a, 'c> {
    admitter: Admitter<'a, 'c>,
    cancel: Arc<AtomicBool>,
    command: &'a DomainCommand,
    input_schema: &'a Value,
    permit_id: &'a str,
    original_identity: &'a str,
    request: &'a Request,
    log_context: &'a Context,
    deadline: Instant,
}
/// The account's own record write admitted by the selected personal key: the
/// retained original binding (permit, identity, resource generation) and the
/// accepted request. The command's operation and schema come from product DATA.
pub(crate) struct SelectedRecordsWriteCall<'a> {
    pub(crate) binding: &'a CommandBinding,
    pub(crate) sign_in: &'a str,
    pub(crate) command: &'a DomainCommand,
    pub(crate) request: &'a Request,
    pub(crate) context: &'a Context,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
    /// The kinds a tool run's capability may write (`account_rights::run_capability`): every record the
    /// write names, and every record it would replace or remove, must be of one of them. None for the person's own key.
    pub(crate) within: Option<&'a dyn Fn(&str) -> bool>,
    pub(crate) cause: Option<&'a str>,
    /// What the request carried beside its request_key to confirm the person present
    /// (`account::person_present::REQUEST_FIELD`), none when it carried nothing.
    pub(crate) person_present: Option<&'a serde_json::Value>,
}
/// The shipped record write, when `command` names it under its declared schema.
fn records_write(
    command: &DomainCommand,
    input_schema: &Value,
) -> Result<Vec<crate::record_write_model::write_command::Write>> {
    use crate::record_write_model::write_command::{Command, Error as Refusal};
    let shipped = Command::shipped().map_err(|error| Error::Source(error.cause()))?;
    if command.operation != shipped.operation() || input_schema != shipped.input_schema() {
        return Err(crate::cause!(Error::Refused));
    }
    shipped
        .parse_json(&command.input)
        .map_err(|error| match error {
            Refusal::Data(_) => crate::cause!(Error::Source),
            Refusal::Invalid(_) | Refusal::Receipt(_) => crate::cause!(Error::Invalid),
        })
}
pub struct NativeCommandResult {
    pub value: Value,
    pub duplicate: bool,
    pub work: record_log::Work,
    /// Only removals made inside this command's transaction; a concurrent command never enters this set.
    pub(crate) removals: Vec<i64>,
}
impl fmt::Debug for NativeCommandResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeCommandResult([redacted])")
    }
}
fn encode(v: &Value) -> Result<String> {
    ecma_json::stringify(v, Default::default()).map_err(|error| Error::Bounds(error.cause()))
}
fn parse(v: &str) -> Result<Value> {
    ecma_json::parse(v.as_bytes(), Default::default()).map_err(|error| Error::Source(error.cause()))
}
fn field<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) => o.get(&name.into()),
        _ => None,
    }
}
fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut o = Object::new();
    for (k, v) in fields {
        o.insert(k.into(), v);
    }
    Value::Object(o)
}
fn digest(v: &Value) -> Result<String> {
    Ok(blake3::hash(encode(v)?.as_bytes()).to_hex().to_string())
}
fn same(a: &CommandBinding, b: &CommandBinding) -> bool {
    a.permit_id == b.permit_id
        && a.identity == b.identity
        && a.owner == b.owner
        && a.resource == b.resource
        && a.generation == b.generation
        && a.operation == b.operation
        && a.request_key == b.request_key
        && a.input_identity == b.input_identity
}
/// The main schema's version on the command's own transaction. A command writes record store tables whose shape it does
/// not change: DDL on the same handle between the effect and completion refuses the whole command, so no write
/// made under another schema commits.
fn schema_version(db: &Connection) -> Result<i64> {
    crate::storage::sqlite::schema_version(db).map_err(|error| Error::Source(error.cause()))
}
fn source_free_result(value: &Value) -> bool {
    let Value::Object(o) = value else {
        return false;
    };
    o.len() == 2
        && matches!(o.get(&"changed".into()), Some(Value::Bool(_)))
        && matches!(o.get(&"write_count".into()),Some(Value::Number(n)) if n.is_finite() && *n>=0.0 && *n<=crate::record_write_model::write_command::MOST_RECORDS as f64 && n.fract()==0.0)
}
fn result_identity(value: &Value) -> Result<String> {
    if !source_free_result(value) {
        return Err(crate::cause!(Error::Refused));
    }
    // For these two fixed ASCII keys and scalar values, this exact order is
    // the original localeCompare canonical order. No general serializer claim.
    let value = object([
        ("changed", field(value, "changed").unwrap().clone()),
        ("write_count", field(value, "write_count").unwrap().clone()),
    ]);
    Ok(format!("1f:{}", digest(&value)?))
}
struct CommandCapture {
    scope: Scope,
    binding: CommandBinding,
    durable_input: Zeroizing<String>,
    persisted: Zeroizing<String>,
    initial: execution_metadata::RecordDraft,
    execution_ref: String,
    context: Context,
}
fn command_capture(
    call: &CommandCall<'_, '_>,
    owner_id: &str,
    reader: &str,
    generation: serde_json::Value,
) -> Result<CommandCapture> {
    let input =
        Zeroizing::new(serde_json::to_string(&call.command.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
    let live_input = parse(&input)?;
    let private_input = if call.command.operation == workspace_write::OPERATION {
        workspace_write::private_persistence_value(&live_input).map_err(|error| crate::carry_cause!(Error::Refused, error))?
    } else {
        privacy::operation_private_value(&live_input, call.input_schema)
            .map_err(|error| crate::carry_cause!(Error::Refused, error))?
    };
    let durable_input = Zeroizing::new(encode(&private_input)?);
    let input_identity = digest(&object([
        (
            "operation",
            Value::String(call.command.operation.as_str().into()),
        ),
        ("input", live_input),
        (
            "request_key",
            Value::String(call.request.key.as_str().into()),
        ),
    ]))?;
    let scope = Scope {
        account: owner_id.to_owned(),
        resource: "@own-records".into(),
    };
    let binding = CommandBinding {
        permit_id: call.permit_id.to_owned(),
        identity: call.original_identity.to_owned(),
        owner: scope.account.clone(),
        resource: scope.resource.clone(),
        generation,
        operation: call.command.operation.clone(),
        request_key: call.request.key.clone(),
        input_identity,
    };
    let schema_identity = digest(call.input_schema)?;
    let persisted=Zeroizing::new(serde_json::to_string(&serde_json::json!({"permit_id":binding.permit_id,"owner":binding.owner,"resource":binding.resource,"generation":binding.generation,"operation":binding.operation,"request_key":binding.request_key,"input_identity":binding.input_identity,"recorder":{"reader":reader,"basis":"authenticated","app_basis":"unknown"},"commitment":{"input_schema_identity":schema_identity,"local_result_contract":"native-setting-batch-receipt/v1"}})).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
    let initial = execution_metadata::begin(
        &execution_metadata::ManagedBrowser {
            call_id: &call.permit_id.into(),
            request_id: &call.request.key.as_str().into(),
            operation: &call.command.operation.as_str().into(),
            reader: &reader.into(),
            app: None,
            app_basis: execution_metadata::AppBasis::Unknown,
            origin: execution_metadata::Origin::Real,
        },
        call.log_context.accepted_at_ms,
    )
    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let execution_ref = initial.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let context = Context {
        actor: serde_json::json!({"reader":reader,"basis":"authenticated","actor":{"basis":"unknown"}}),
        application_time: call.log_context.application_time.clone(),
        system_time: call.log_context.system_time.clone(),
        accepted_at_ms: call.log_context.accepted_at_ms,
    };
    Ok(CommandCapture {
        scope,
        binding,
        durable_input,
        persisted,
        initial,
        execution_ref,
        context,
    })
}

fn clone_binding(b: &CommandBinding) -> CommandBinding {
    CommandBinding {
        permit_id: b.permit_id.clone(),
        identity: b.identity.clone(),
        owner: b.owner.clone(),
        resource: b.resource.clone(),
        generation: b.generation.clone(),
        operation: b.operation.clone(),
        request_key: b.request_key.clone(),
        input_identity: b.input_identity.clone(),
    }
}

/// Private witness constructed only after LocalAccount's fresh browser check.
/// Every public operation is still wrapped in State's actual current selection,
/// inode, account, addressed browser generation, cancellation and source checks.
struct NativeContext<'selection> {
    selection_check: &'selection dyn Fn() -> Result<()>,
    /// Physical RecordBook selected by the current generation-checked affinity.
    /// The external binding remains `@own-records`; this path owns the whole
    /// command transaction and its retry receipt.
    physical_path: PathBuf,
    /// A scoped writer still belongs to the current base account generation.
    /// Refresh that authority at transaction boundaries, without borrowing its writer.
    base_readers: Option<Arc<crate::storage::record_store_resources::Readers>>,
    record_domain: Option<command_domain::Identity>,
    /// The complete outer command's adoption capture, shared by every lend.
    adoption: Option<std::rc::Rc<crate::storage::record_store_resources::carry::live_adopt::CommandCapture>>,
    workspace_generation: Option<workspace_generation::Guard>,
    writer_road: &'static str,
    binding: CommandBinding,
    durable_input: Zeroizing<String>,
    durable_context: Zeroizing<String>,
    execution_ref: String,
    pending_local_execution: Option<Zeroizing<String>>,
    reader: String,
    handle: usize,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    /// The account store's limits, sized once for this command (`InCommand::limits`).
    limits: Limits,
    /// Schema/layout facts shared only by this command's lent stores.
    command_memory: Option<Arc<crate::storage::record_store_resources::CommandMemory>>,
    /// The selected account's current installed model, shared by every store lent in this command.
    model: Arc<crate::record_model_policy::Installed>,
    /// What a write refused for a value outside its field's choices, or for want of the person present, names.
    outside: Option<super::Named>,
    /// The record store search memory this command's stores share (`InCommand::lend_carrying`), kept on the record book
    /// handle only after the command commits (`LentWriter::keep_search`).
    search: std::rc::Rc<crate::storage::record_store::SharedSearchMemory>,
    /// The account's state folder resources, where its placed lists keep their rows (`InCommand::bind_list_homes`); None
    /// for a command on another own-work store, which writes that store alone.
    list_resources: Option<Arc<StateResources>>,
}
/// The full witness of a command, at the boundaries of its held transaction
/// (right after it begins, right before COMMIT, the delivery read after it):
/// the selection, then the state lock, record book and the admitter's current rights
/// (`State::current`), then this command's own checks.
impl State<'_, '_, NativeContext<'_>> {
    fn witness(&mut self, db: &Connection, binding: &CommandBinding) -> journal::Result<()> {
        self.witnesses += 1;
        (self.external.selection_check)().map_err(|error| { crate::quiet_eprintln!("command-witness event=refused stage=selection cause={}", error.cause()); journal::Error::Changed(error.cause()) })?;
        self.current(db).map_err(|error| { crate::quiet_eprintln!("command-witness event=refused stage=current cause={}", error.cause()); journal::Error::Changed(error.cause()) })?;
        if let Some(base) = &self.external.base_readers {
            if !base.read(|store| crate::local_account::own_records::original_command_source_matches(
                &store, &binding.owner, binding.generation.as_i64().ok_or(crate::cause!(crate::records::Error::Unavailable))?))
                .map_err(|error| journal::Error::Changed(error.cause()))? {
                return Err(crate::cause!(journal::Error::Changed));
            }
        }
        self.external.check(db, binding).map_err(|error| { crate::quiet_eprintln!("command-witness event=refused stage=binding cause={}", error.cause()); error })
    }
}
impl NativeContext<'_> {
    fn check(&self, db: &Connection, b: &CommandBinding) -> journal::Result<()> {
        if !same(&self.binding, b)
            || unsafe { db.handle() } as usize != self.handle
            || db.is_autocommit()
            || self.cancel.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
        {
            return Err(crate::cause!(journal::Error::Changed));
        }
        if let Some(guard) = &self.workspace_generation {
            guard
                .assert_current(db, b)
                .map_err(|error| journal::Error::Changed(error.cause()))?;
        }
        Ok(())
    }
    /// The account's own records (record store) on this command's held transaction.
    fn records<'a>(&self, db: &'a Connection) -> Result<InCommand<'a>> {
        // The installed model is read once per command (`self.model`); its orders are the writer's, as the readers' are.
        let settings = crate::storage::record_store::settings::with_joined_orders(&self.model.orders())
            .map_err(|error| Error::Source(error.cause()))?;
        let mut records =
            InCommand::lend_carrying_memo(db, &self.binding.owner, self.limits, &self.search, self.command_memory.clone(), settings)
                .map_err(|error| Error::Source(error.cause()))?;
        records.set_model(&self.model).map_err(|error| Error::Source(error.cause()))?;
        records.bind_list_homes(self.list_resources.clone().map(|resources| crate::local_account::own_records::ListHomes {
            resources, model: self.model.clone(), settings, cancel: self.cancel.clone(), deadline: self.deadline,
        }));
        records.bind_domain(self.record_domain.clone());
        records.bind_adoption(self.adoption.clone());
        Ok(records)
    }
    /// One record's current projection and whether its key is present.
    fn projection(&self, db: &Connection, id: &str) -> Result<(Option<Projected>, bool)> {
        let Some(stored) = self.records(db)?.stored(id).map_err(|error| Error::Source(error.cause()))? else {
            return Ok((None, false));
        };
        let projected = original_setting::projection(&stored).map_err(record_error)?;
        Ok((Some(projected), stored.protected_key_present))
    }
    /// Whether `id` never held a record and holds no key: an identity a producer may mint.
    fn fresh(&self, db: &Connection, id: &str) -> Result<bool> {
        let records = self.records(db)?;
        Ok(!records.ever_held(id).map_err(|error| Error::Source(error.cause()))?
            && matches!(
                records.key(id).map_err(|error| Error::Source(error.cause()))?,
                KeyState::Missing
            ))
    }
    fn record(&self, db: &Connection, id: &str) -> Result<Option<(String, Value)>> {
        self.records(db)?
            .stored(id)
            .map_err(|error| Error::Source(error.cause()))?
            .map(|r| Ok((r.record_type, parse(&r.value_json)?)))
            .transpose()
    }
    fn execution(&self, db: &Connection) -> Result<Value> {
        let (kind, v) = match &self.pending_local_execution {
            Some(captured) => ("execution".to_owned(), parse(captured)?),
            None => self
                .record(db, &self.execution_ref)?
                .ok_or(crate::cause!(Error::OutcomeUnknown))?,
        };
        if kind != "execution"
            || field(&v, "execution_ref")
                != Some(&Value::String(self.execution_ref.as_str().into()))
            || field(&v, "call_id") != Some(&Value::String(self.binding.permit_id.as_str().into()))
            || field(&v, "operation")
                != Some(&Value::String(self.binding.operation.as_str().into()))
            || field(&v, "request_id")
                != Some(&Value::String(self.binding.request_key.as_str().into()))
            || field(&v, "recorder").and_then(|r| field(r, "reader"))
                != Some(&Value::String(self.reader.as_str().into()))
            || field(&v, "recorder").and_then(|r| field(r, "basis"))
                != Some(&Value::String("authenticated".into()))
            || field(&v, "actor").and_then(|r| field(r, "basis"))
                != Some(&Value::String("unknown".into()))
        {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        Ok(v)
    }
    fn key_state(&self, db: &Connection, id: &str) -> Result<KeyState> {
        self.records(db)?.key(id).map_err(|error| Error::Source(error.cause()))
    }
    fn open_own_result(&self, db: &Connection) -> Result<Value> {
        let id = format!("resource-command-result:{}", self.binding.permit_id);
        let (kind, value) = self.record(db, &id)?.ok_or(crate::cause!(Error::OutcomeUnknown))?;
        if kind != "resource-command-result" || field(&value, "source_record").is_some() {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        let Some(Value::Object(sealed)) = field(&value, "value") else {
            return Err(crate::cause!(Error::OutcomeUnknown));
        };
        if !crate::record_sealed::is_sealed(sealed) || sealed.get(&"k".into()).is_some() {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        let KeyState::Present(key) = self.key_state(db, &id)? else {
            return Err(crate::cause!(Error::OutcomeUnknown));
        };
        let (opened, _) =
            crate::record_sealed::open(&key, &id, &"value".into(), sealed, Default::default())
                .map_err(|error| Error::OutcomeUnknown(error.cause()))?
                .ok_or(crate::cause!(Error::OutcomeUnknown))?;
        Ok(opened)
    }
    fn protected_result(&self, db: &Connection) -> Result<Value> {
        let opened = self.open_own_result(db)?;
        let result = field(&opened, "result")
            .cloned()
            .ok_or(crate::cause!(Error::OutcomeUnknown))?;
        if !source_free_result(&result) {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        Ok(result)
    }
}
impl CurrentCommand for NativeContext<'_> {
    fn physical_path(&self) -> Option<&std::path::Path> {
        Some(&self.physical_path)
    }
    fn assert_current(&mut self, db: &Connection, b: &CommandBinding) -> journal::Result<()> {
        self.check(db, b)
    }
    fn assert_capture(
        &mut self,
        db: &Connection,
        b: &CommandBinding,
        c: &Capture<'_>,
    ) -> journal::Result<()> {
        self.check(db, b)?;
        if c.execution_ref != self.execution_ref
            || c.durable_input != self.durable_input.as_str()
            || c.durable_context != self.durable_context.as_str()
        {
            return Err(crate::cause!(journal::Error::Conflict));
        }
        // The journal compares a retry's capture with its committed record.
        self.execution(db).map_err(|error| journal::Error::Unknown(error.cause()))?;
        Ok(())
    }
    fn assert_completion(
        &mut self,
        db: &Connection,
        b: &CommandBinding,
        r: &journal::Completion,
    ) -> journal::Result<()> {
        self.check(db, b)?;
        if r.native_nonretaining {
            return Err(crate::cause!(journal::Error::Invalid));
        }
        if b.operation == workspace_write::OPERATION {
            let saved = self
                .protected_workspace_result(db)
                .map_err(|error| journal::Error::Unknown(error.cause()))?;
            let execution = self.execution(db).map_err(|error| journal::Error::Unknown(error.cause()))?;
            if saved.identity() != r.result_identity
                || field(&execution, "phase") != Some(&Value::String("returned".into()))
            {
                return Err(crate::cause!(journal::Error::Conflict));
            }
            return Ok(());
        }
        let result = self
            .protected_result(db)
            .map_err(|error| journal::Error::Unknown(error.cause()))?;
        let execution = self.execution(db).map_err(|error| journal::Error::Unknown(error.cause()))?;
        if result_identity(&result).map_err(|error| journal::Error::Unavailable(error.cause()))? != r.result_identity
            || field(&execution, "phase") != Some(&Value::String("returned".into()))
        {
            return Err(crate::cause!(journal::Error::Conflict));
        }
        Ok(())
    }
}

/// Exact model admission for only this producer's two record shapes, from the own model part (the command journal's
/// results are kinds trillion-local writes itself). Execution links/references are empty; no source
/// entitlement can be invented.
fn model_accepts(kind: &str, value: &Value) -> bool {
    let Ok(model) = crate::record_model_policy::own_model() else {
        return false;
    };
    let Some(Value::Array(kinds)) = field(model.data(), "kinds") else {
        return false;
    };
    let Some(spec) = kinds
        .iter()
        .find(|s| field(s, "type") == Some(&Value::String(kind.into())))
    else {
        return false;
    };
    if field(spec, "table") == Some(&Value::Bool(true)) {
        return false;
    }
    let (Some(Value::Object(guards)), Value::Object(value)) =
        (field(spec, "guard_properties"), value)
    else {
        return false;
    };
    if value
        .insertion_entries()
        .any(|(name, v)| match guards.get(name) {
            Some(Value::String(t)) if t == &JsString::from("text") => {
                !matches!(v, Value::String(_))
            }
            Some(Value::String(t)) if t == &JsString::from("object") => {
                !matches!(v, Value::Object(_))
            }
            _ => true,
        })
    {
        return false;
    }
    match kind {
        "execution" => {
            field(spec, "erasable").is_none()
                && field(spec, "erasable_key").is_none()
                && field(&Value::Object(value.clone()), "references").is_none()
                && matches!(value.get(&"links".into()),Some(Value::Object(o)) if o.is_empty())
        }
        "resource-command-result" => {
            field(spec, "erasable") == Some(&Value::Array(vec![Value::String("value".into())]))
                && field(spec, "erasable_key")
                    == Some(&Value::Array(vec![Value::String("source_record".into())]))
                && value.len() == 1
                && matches!(value.get(&"value".into()),Some(Value::Object(o)) if crate::record_sealed::is_sealed(o) && o.get(&"k".into()).is_none())
        }
        _ => false,
    }
}
/// Synchronous local effects under the already captured original parent.
/// This gives no connection escape or external dispatch permission.
pub struct NativeTransaction<'a, 's, 'c> {
    db: &'a Connection,
    state: &'a mut State<'s, 'c, NativeContext<'s>>,
    scope: &'a Scope,
    binding: &'a CommandBinding,
    request: &'a Request,
    context: &'a Context,
    ids: &'a mut dyn LogIds,
    /// The actual original capture's declared kind, never a caller's record kind.
    captured_record_kind: &'static str,
    writes: usize,
    changed: bool,
    poisoned: bool,
    /// record store record and key changes this command wrote.
    envelopes: usize,
}
impl NativeTransaction<'_, '_, '_> {
    fn current(&mut self) -> Result<()> {
        if self.poisoned {
            return Err(crate::cause!(Error::Refused));
        }
        self.state
            .assert_current(self.db, self.binding)
            .map_err(journal_error)
    }
    /// Write one plan to the account's own records (record store) on this command's held
    /// transaction: each written record's final stored form and each attached
    /// key, one record store change apiece, with the command's current-rights check
    /// inside every write. Later reads in the same command see them.
    /// `protected_before` comes from the same before-state read as the plan.
    fn write_plan(
        &mut self,
        plan: &original_setting::Plan,
        protected_before: &BTreeMap<String, bool>,
    ) -> Result<()> {
        if plan.unchanged() {
            return Ok(());
        }
        let forms = plan.final_stored(protected_before).map_err(record_error)?;
        let keys = plan
            .keys()
            .map(|(id, key)| (id, key.bytes()))
            .collect::<Vec<_>>();
        let log_id = plan.receipt().log_id.ok_or(crate::cause!(Error::Source))?;
        self.current()?;
        let mut records = self.state.external.records(self.db)?;
        let (state, db, binding) = (&mut *self.state, self.db, self.binding);
        let written = records
            .write(&forms, &keys, &log_id, || {
                state
                    .assert_current(db, binding)
                    .map_err(|error| crate::records::Error::Unavailable(error.cause()))
            })
            .map_err(|error| {
                let cause = error.cause();
                match error {
                    crate::records::Error::OutcomeUnknown(_) => Error::OutcomeUnknown(cause),
                    crate::records::Error::Conflict(_) => Error::Conflict(cause),
                    _ => Error::Source(cause),
                }
            })?;
        self.envelopes += written;
        self.current()
    }
    /// Reuses the original plain-setting model/CAS/history owner. Each call
    /// reads current state AFTER the preceding writes of this same command.
    pub fn compare_and_set_setting(
        &mut self,
        name: &JsString,
        expected: Option<&Value>,
        desired: &Value,
    ) -> Result<record_log::Receipt> {
        let answer = self.compare_and_set_setting_inner(name, expected, desired);
        if answer.is_err() {
            self.poisoned = true;
        }
        answer
    }
    fn compare_and_set_setting_inner(
        &mut self,
        name: &JsString,
        expected: Option<&Value>,
        desired: &Value,
    ) -> Result<record_log::Receipt> {
        self.current()?;
        self.writes += 1;
        if self.writes > crate::record_write_model::write_command::MOST_RECORDS {
            return Err(crate::cause!(Error::Bounds));
        }
        let name = name.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let record_id = original_setting::setting_id(&name).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let (before, protected) = self.state.external.projection(self.db, &record_id)?;
        if protected {
            return Err(crate::cause!(Error::Refused));
        }
        let plan = original_setting::plan_original_setting(
            self.scope,
            before,
            &name,
            expected,
            desired,
            self.request,
            self.context,
            self.ids,
        )
        .map_err(record_error)?;
        self.write_plan(&plan, &BTreeMap::from([(record_id, protected)]))?;
        let receipt = plan.receipt();
        self.changed |= !receipt.written.is_empty();
        self.current()?;
        Ok(receipt)
    }
}

fn native_adoption_limits() -> Result<crate::storage::record_store_resources::carry::live_adopt::Limits> {
    crate::storage::record_store::settings::shipped().map(|settings| settings.live_adoption).ok_or(crate::cause!(Error::Source))
}

/// A trusted native source owner keeps this while copying one COMPLETE command
/// domain. It is not a new public operation, placement resolver or list policy.
/// Every step rechecks the original caller and selection; the external fence
/// also covers concurrent native commits. Restart must obtain that fence afresh.
/// An owned reopening of the actual sealed source, never caller-supplied seal
/// text. It holds no authority lease, so canonical draining can complete.
pub(crate) struct SealedSourceProof {
    source: Arc<crate::storage::record_store_resources::Writer>,
    plan: crate::storage::record_store_resources::carry::live_adopt::Plan,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl SealedSourceProof {
    pub(crate) fn assert_sealed(&self) -> crate::storage::Result<()> {
        if self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline { return Err(crate::cause!(crate::storage::Error::Interrupted)); }
        let held = self.source.lend(self.cancel.clone(), self.deadline).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        let store = crate::storage::sqlite::lend(held.connection(), crate::local_account::own_records::SCHEMA,
            crate::storage::sqlite::Access::Read)?;
        crate::storage::record_store_resources::carry::live_adopt::assert_sealed(&store, &self.plan)
    }
    pub(crate) fn assert_matches(&self, account: &str,
        history: &command_domain::Identity, move_id: &str, source: &str,
        target: &str) -> crate::storage::Result<()> {
        let history = serde_json::to_value(history).map_err(|error| crate::carry_cause!(crate::storage::Error::Invalid, error))?;
        let slot = crate::storage::record_store_resources::carry::live_adopt::command_slot(account, &history)?;
        if self.plan.slot != slot || self.plan.move_id != move_id
            || self.plan.source_incarnation != source || self.plan.target_incarnation != target {
            return Err(crate::cause!(crate::storage::Error::Moved));
        }
        self.assert_sealed()
    }
}

/// A source selected by the real native account owner. Its plan is generated
/// from the physical full domain, never from a caller's key list or path.
/// Every use receives fresh original admission and canonical authority.
pub(crate) struct NativeRemoteDomainSource {
    account:String,
    pub(crate) writer:Arc<crate::storage::record_store_resources::Writer>,
    pub(crate) plan:crate::storage::record_store_resources::carry::live_adopt::Plan,
    history:command_domain::Identity,
}
impl NativeRemoteDomainSource {
    pub(crate) fn prepare(&mut self,authority:&crate::local_account::NativeDomainAuthority,cancel:Arc<AtomicBool>,deadline:Instant)->Result<()> {
        use crate::storage::record_store_resources::carry::live_adopt as adoption;
        let held=self.writer.lend(cancel,deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let store=held.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let limits=crate::storage::record_store_resources::computer_limits(&store,self.writer.path()).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let records=crate::storage::record_store::RecordStore::new(&store,Box::new(crate::storage::record_store::RealClock),limits).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let physical=crate::local_account::own_records::domain_authority(&records,&self.account,&self.history).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        if physical!=self.plan.source_incarnation || !crate::local_account::own_records::command_closure_for_transfer(&records,&self.account,&self.history).map_err(|error| crate::carry_cause!(Error::Conflict, error))? {return Err(crate::cause!(Error::Conflict));}
        self.plan=adoption::complete_domain_plan(&store,self.plan.slot.clone(),self.plan.move_id.clone(),self.plan.source_incarnation.clone(),self.plan.target_incarnation.clone());
        adoption::prepare(&store,&self.plan,true,native_adoption_limits()?,authority).map_err(|error| crate::carry_cause!(Error::Conflict, error))
    }
    pub(crate) fn seal_proof(&self,cancel:Arc<AtomicBool>,deadline:Instant)->crate::storage::Result<SealedSourceProof> {
        let proof=SealedSourceProof {source:self.writer.clone(),plan:self.plan.clone(),cancel,deadline};proof.assert_sealed()?;Ok(proof)
    }
    pub(crate) fn activate_canonical(&self,owner:&mut LocalAccount,cancel:Arc<AtomicBool>,deadline:Instant,
        current:&mut dyn FnMut(&mut LocalAccount)->crate::account::AccountResult<()>,control:crate::local_account::NativeDomainControl<'_>)->Result<()> {
        let proof=self.seal_proof(cancel.clone(),deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let authority=owner.native_domain_authority(&self.history,cancel.clone(),deadline,current).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let stage=authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Refused))?;
        if stage.move_id!=self.plan.move_id || stage.source_incarnation!=self.plan.source_incarnation || stage.target_incarnation!=self.plan.target_incarnation {return Err(crate::cause!(Error::Conflict));}
        if !stage.activated {
            owner.change_native_domain_authority_drained(&self.history,&crate::account_rights::resource_connection::NativeChange::Activate {
                request_key:crate::storage::record_store_resources::carry::live_adopt::command_slot(&self.plan.slot,&serde_json::json!(["activate",self.plan.move_id])).map_err(|error| crate::carry_cause!(Error::Source, error))?,
                expected_revision:authority.registration().revision,move_id:self.plan.move_id.clone(),
            },cancel,deadline,current,Some(&proof),control).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        }else{control.publish_unchanged().map_err(|error| crate::carry_cause!(Error::Refused, error))?;}
        Ok(())
    }
}

pub(crate) struct NativeDomainAdoption {
    account: String,
    history: command_domain::Identity,
    canonical: bool,
    source: Arc<crate::storage::record_store_resources::Writer>,
    target: Arc<crate::storage::record_store_resources::Writer>,
    /// The source account's record store settings (its installed tools' orders): the moved rows keep the orders the account's
    /// readers expect, so the target's writer opens with the same settings.
    settings: &'static crate::storage::record_store::settings::Settings,
    plan: crate::storage::record_store_resources::carry::live_adopt::Plan,
    fence: Arc<crate::storage::record_store_resources::carry::live_adopt::CurrentFence>,
    _registration: crate::storage::record_store_resources::carry::live_adopt::FenceRegistration,
}
impl NativeDomainAdoption {
    pub(crate) fn plan(&self) -> &crate::storage::record_store_resources::carry::live_adopt::Plan { &self.plan }
    pub(crate) fn sealed_source_proof(&self, cancel: Arc<AtomicBool>, deadline: Instant) -> crate::storage::Result<SealedSourceProof> {
        let proof = SealedSourceProof { source: self.source.clone(), plan: self.plan.clone(), cancel, deadline };
        proof.assert_sealed()?;
        Ok(proof)
    }

    /// One bounded turn; a lost reply resumes from the target's committed
    /// cursor/frontier under the same move. Only a proved sealed frontier can
    /// activate. No source data is removed or copied as a new user event.
    pub(crate) fn advance(&self, owner: &mut LocalAccount, cancel: Arc<AtomicBool>, deadline: Instant,
        selection: &dyn Fn() -> Result<()>, current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>)
        -> Result<crate::storage::record_store_resources::carry::live_adopt::Progress> {
        use crate::storage::record_store_resources::carry::live_adopt::{self as adoption, Progress};
        selection()?;
        owner.assert_owned().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        current(owner).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline { return Err(crate::cause!(Error::Refused)); }
        let source_held = self.source.lend(cancel.clone(), deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let target_held = self.target.lend(cancel.clone(), deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let source = source_held.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let target = target_held.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let limits = native_adoption_limits()?;
        let before = adoption::recover(&target, &self.plan, &*self.fence).map_err(|error| Error::Source(error.cause()))?;
        if self.canonical && matches!(before, Progress::Ready { .. }) {
            // The proof and canonical drain reopen the real source. Release
            // both physical lends and all maintenance holds before entering
            // that control transaction, then reopen for atomic activation.
            drop(source); drop(target); drop(source_held); drop(target_held);
            let proof = self.sealed_source_proof(cancel.clone(), deadline).map_err(|error| Error::Source(error.cause()))?;
            let authority = owner.native_domain_authority(&self.history, cancel.clone(), deadline, current).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
            let staged = authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Refused))?;
            if staged.move_id != self.plan.move_id || staged.source_incarnation != self.plan.source_incarnation
                || staged.target_incarnation != self.plan.target_incarnation { return Err(crate::cause!(Error::Refused)); }
            if !staged.activated { owner.change_native_domain_authority(&self.history,
                &crate::account_rights::resource_connection::NativeChange::Activate {
                    request_key: adoption::command_slot(&self.account, &serde_json::json!(["activate", self.plan.slot, self.plan.move_id]))
                        .map_err(|error| Error::Source(error.cause()))?, expected_revision: authority.registration().revision,
                    move_id: self.plan.move_id.clone(),
                }, cancel.clone(), deadline, current, Some(&proof)).map_err(|error| crate::carry_cause!(Error::Refused, error))?; }
            let source_held = self.source.lend(cancel.clone(), deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let target_held = self.target.lend(cancel, deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let source = source_held.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let target = target_held.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            adoption::activate_with(&source, &target, &self.plan, limits, &*self.fence, |_| {
                let sized = crate::local_account::own_records::InCommand::limits(target_held.connection(), self.target.path())
                    .map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
                let mut records = crate::local_account::own_records::InCommand::lend_with(target_held.connection(), &self.account, sized, self.settings)
                    .map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
                records.replace_command_authority(&self.plan.source_incarnation, &self.plan.target_incarnation, &self.plan.move_id)
                    .map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))
            }).map_err(|error| Error::Source(error.cause()))?;
            selection()?; current(owner).map_err(|error| Error::Refused(error.cause()))?;
            return adoption::recover(&target, &self.plan, &*self.fence).map_err(|error| Error::Source(error.cause()));
        }
        match before {
            Progress::Copying => { adoption::copy_step(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))?; }
            Progress::CatchingUp { .. } => {
                if !adoption::replay_step(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))? {
                    // The source write reservation orders its last captured
                    // command before this durable seal. Replay then catches
                    // any command that won the race before the seal.
                    adoption::seal(&source, &self.plan, &*self.fence).map_err(|error| Error::Source(error.cause()))?;
                    if !adoption::replay_step(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))? {
                        adoption::verify_step(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))?;
                    }
                }
            }
            Progress::Verifying { .. } => { adoption::verify_step(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))?; }
            Progress::Ready { .. } => { adoption::activate(&source, &target, &self.plan, limits, &*self.fence).map_err(|error| Error::Source(error.cause()))?; }
            Progress::Active { .. } => {}
        }
        selection()?;
        current(owner).map_err(|error| Error::Refused(error.cause()))?;
        adoption::recover(&target, &self.plan, &*self.fence).map_err(|error| Error::Source(error.cause()))
    }
}

impl LocalAccount {
    /// Begin/resume source capture under current management admission. The
    /// requested move identity already binds target and complete caller input.
    pub(crate) fn prepare_remote_domain_source(&mut self,history:&command_domain::Identity,move_id:&str,request_key:&str,
        expected_revision:u64,cancel:Arc<AtomicBool>,deadline:Instant,
        current:&mut dyn FnMut(&mut LocalAccount)->crate::account::AccountResult<()>,control:Option<crate::local_account::NativeDomainControl<'_>>)
        ->Result<(NativeRemoteDomainSource,crate::local_account::NativeDomainAuthority)> {
        use crate::storage::record_store_resources::carry::live_adopt as adoption;
        current(self).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let authority=self.native_domain_authority(history,cancel.clone(),deadline,current).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let authority=if authority.registration().staged.as_ref().is_some_and(|stage|stage.move_id==move_id) {
                if let Some(control)=control {control.publish_unchanged().map_err(|error| crate::carry_cause!(Error::Refused, error))?;}
                authority
            }else {
                if authority.registration().revision!=expected_revision {return Err(crate::cause!(Error::Conflict));}
                self.change_native_domain_authority_drained(history,&crate::account_rights::resource_connection::NativeChange::Prepare {
                    request_key:request_key.into(),expected_revision,source_incarnation:authority.current_incarnation().into(),move_id:move_id.into(),
                },cancel.clone(),deadline,current,None,control.ok_or(crate::cause!(Error::Refused))?).map_err(|error| crate::carry_cause!(Error::Refused, error))?
            };
        let stage=authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Refused))?;
        if stage.move_id!=move_id {return Err(crate::cause!(Error::Conflict));}
        let account=crate::account::NativeAccountOwner::account(self).owner_id;
        let domain=self.selected_command_domain(&serde_json::json!({"scope":history}),&account,history.generation)?.ok_or(crate::cause!(Error::Invalid))?;
        let writer=domain.writer().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let slot=adoption::command_slot(&account,&serde_json::to_value(history).map_err(|error| crate::carry_cause!(Error::Source, error))?).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let plan=adoption::Plan {slot,move_id:move_id.into(),source_incarnation:stage.source_incarnation.clone(),target_incarnation:stage.target_incarnation.clone(),selections:Vec::new()};
        current(self).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        Ok((NativeRemoteDomainSource {account,writer,plan,history:history.clone()},authority))
    }

    /// The trusted maintenance caller supplies selected physical handles and
    /// its retained original admission. Canonical control generates both
    /// physical tokens; callers cannot claim a token from saved local data.
    pub(crate) fn begin_admitted_command_domain_adoption(&mut self,
        source: &command_domain::Selection, target: &command_domain::Bound,
        request_key: &str, move_id: &str, cancel: Arc<AtomicBool>, deadline: Instant,
        selection: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>) -> Result<NativeDomainAdoption> {
        selection()?;
        let admitted = self.native_domain_authority(&source.identity(), cancel.clone(), deadline, current).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let observed_source = admitted.current_incarnation().to_owned();
        let source_domain = self.selected_command_domain(&serde_json::json!({"scope":source}),
            &crate::account::NativeAccountOwner::account(self).owner_id, source.generation)?.ok_or(crate::cause!(Error::Invalid))?;
        let account = crate::account::NativeAccountOwner::account(self).owner_id;
        let (source_token, target_token, prepared) = if let Some(staged) = &admitted.registration().staged {
            if staged.move_id != move_id { return Err(crate::cause!(Error::Conflict)); }
            (staged.source_incarnation.clone(), staged.target_incarnation.clone(), admitted)
        } else {
            let permit = admitted.hold_native(&observed_source).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
            let token = source_domain.readers().map_err(|error| Error::Source(error.cause()))?.read(|store|
                crate::local_account::own_records::domain_authority(&store, &account, &source.identity()))
                .map_err(|error| Error::Conflict(error.cause()))?;
            if token != observed_source { return Err(crate::cause!(Error::Refused)); }
            drop(permit);
            let prepared = self.change_native_domain_authority(&source.identity(),
            &crate::account_rights::resource_connection::NativeChange::Prepare {
                request_key: request_key.into(), expected_revision: admitted.registration().revision,
                source_incarnation: observed_source.clone(), move_id: move_id.into(),
            }, cancel.clone(), deadline, current, None).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
            let target_token = prepared.staged_incarnation().ok_or(crate::cause!(Error::Refused))?.to_owned();
            (observed_source, target_token, prepared)
        };
        let token = source_domain.readers().map_err(|error| Error::Source(error.cause()))?.read(|store|
            crate::local_account::own_records::domain_authority(&store, &account, &source.identity()))
            .map_err(|error| Error::Conflict(error.cause()))?;
        if token != source_token { return Err(crate::cause!(Error::Refused)); }
        let mut mover = self.begin_command_domain_adoption(source, target, move_id, &source_token, &target_token,
            Arc::new(prepared), cancel, deadline, selection, current)?;
        mover.canonical = true;
        Ok(mover)
    }

    /// Start/resume an explicitly admitted whole-domain transfer. Logical
    /// history stays the same; the two external writer incarnations differ.
    /// An arbitrary record-id subset is deliberately not accepted as closure.
    #[allow(clippy::too_many_arguments)]
    fn begin_command_domain_adoption(&mut self, source_selection: &command_domain::Selection,
        target: &command_domain::Bound, move_id: &str, source_incarnation: &str, target_incarnation: &str,
        fence: Arc<crate::storage::record_store_resources::carry::live_adopt::CurrentFence>,
        cancel: Arc<AtomicBool>, deadline: Instant, selection: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>) -> Result<NativeDomainAdoption> {
        use crate::storage::record_store_resources::carry::live_adopt::{self as adoption, FenceRegistration};
        selection()?;
        self.assert_owned().map_err(|error| Error::Source(error.cause()))?;
        current(self).map_err(|error| Error::Refused(error.cause()))?;
        if source_selection.create || source_selection.identity() != target.selection().identity()
            || !target.selection().create || move_id.trim().is_empty() { return Err(crate::cause!(Error::Invalid)); }
        if self.original_records_read_generation()? != source_selection.generation { return Err(crate::cause!(Error::Refused)); }
        let account = crate::account::NativeAccountOwner::account(self);
        let selected = self.selected_command_domain(&serde_json::json!({"scope":source_selection}), &account.owner_id, source_selection.generation)?
            .ok_or(crate::cause!(Error::Invalid))?;
        let source_writer = selected.writer().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let target_writer = target.writer().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if source_writer.path() == target_writer.path() { return Err(crate::cause!(Error::Invalid)); }
        let source = source_writer.lend(cancel.clone(), deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let target = target_writer.lend(cancel, deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let source_store = source.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let target_store = target.storage().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let history = serde_json::to_value(source_selection.identity()).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let slot = adoption::command_slot(&account.owner_id, &history).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let plan = adoption::complete_domain_plan(&source_store, slot, move_id.into(), source_incarnation.into(), target_incarnation.into());
        let limits = native_adoption_limits()?;
        // Validate actual source ownership/header before creating either state.
        let source_readers = selected.readers().map_err(|error| Error::Source(error.cause()))?;
        source_readers.read::<_, crate::records::Error>(|store| {
            let header = store.current_record(&account.owner_id, crate::local_account::own_records::IDENTITY, "command-domain")?
                .ok_or(crate::cause!(crate::records::Error::Conflict))?;
            if header.value != history {
                #[cfg(test)] crate::quiet_eprintln!("native-adoption stage=source-header refused=identity");
                return Err(crate::cause!(crate::records::Error::Conflict));
            }
            if !crate::local_account::own_records::command_closure_for_transfer(&store, &account.owner_id,
                &source_selection.identity())? { return Err(crate::cause!(crate::records::Error::Conflict)); }
            Ok(())
        }).map_err(|error| Error::Conflict(error.cause()))?;
        let registration = FenceRegistration::bind(&plan, fence.clone()).map_err(|error| Error::Refused(error.cause()))?;
        adoption::prepare(&target_store, &plan, false, limits, &*fence).map_err(|error| {
            #[cfg(test)] crate::quiet_eprintln!("native-adoption stage=target-prepare cause={}", error.cause());
            crate::cause!(Error::Conflict)
        })?;
        adoption::prepare(&source_store, &plan, true, limits, &*fence).map_err(|error| {
            #[cfg(test)] crate::quiet_eprintln!("native-adoption stage=source-prepare cause={}", error.cause());
            crate::cause!(Error::Conflict)
        })?;
        selection()?;
        current(self).map_err(|error| Error::Refused(error.cause()))?;
        drop(source_store); drop(target_store); drop(source); drop(target);
        let settings = crate::local_account::own_records::installed_settings(&self.source.selected.root).map_err(|error| Error::Source(error.cause()))?;
        Ok(NativeDomainAdoption { account: account.owner_id, history: source_selection.identity(), canonical: false,
            source: source_writer, target: target_writer, settings, plan, fence, _registration: registration })
    }

    pub(crate) fn shared_domain_resources(&self) -> Result<Arc<StateResources>> {
        if let Some(resources) = self.domain_resources.get() { return Ok(resources.clone()); }
        let resources = Arc::new(StateResources::new(&self.source.selected.root, self.source.sql_work.clone())
            .map_err(|error| Error::Source(error.cause()))?);
        match self.domain_resources.set(resources.clone()) {
            Ok(()) => Ok(resources),
            Err(_) => self.domain_resources.get().cloned().ok_or(crate::cause!(Error::Source)),
        }
    }
    pub(crate) fn selected_command_domain(&self, input: &serde_json::Value, owner: &str, generation: i64) -> Result<Option<command_domain::Bound>> {
        command_domain::Selection::from_input(input).map_err(|error| Error::Invalid(error.cause()))?
            .map(|selection| {
                let resources = self.shared_domain_resources()?;
                command_domain::Bound::new(resources, owner, selection, generation).map_err(|error| Error::Conflict(error.cause()))
            }).transpose()
    }
    /// Explicit bounded discovery for recovery/upkeep only. Ordinary record
    /// selection computes its address without consulting this inventory.
    pub(crate) fn domain_inventory(&mut self) -> Result<command_domain::Inventory> {
        let generation = self.original_records_read_generation()?;
        let account = crate::account::NativeAccountOwner::account(self).owner_id;
        command_domain::Inventory::new(self.shared_domain_resources()?, account, generation)
            .map_err(|error| Error::Source(error.cause()))
    }
    /// What the last refused record write named (`Error::OutsideChoices`, `Error::NeedsPersonPresent`), once.
    pub(crate) fn take_write_refusal(&mut self) -> Option<super::Named> {
        self.write_refusal.take()
    }
    /// Explicit synthetic-fixture SQL template capture. The caller must own
    /// every attached handle and keep them idle while enabling it. Templates
    /// remain in volatile memory and this method is absent from normal builds.
    #[cfg(feature = "sql-statement-attribution")]
    pub unsafe fn enable_native_fixture_statements(
        &self,
        capacity: usize,
    ) -> std::result::Result<(), crate::sqlite_work::Error> {
        unsafe {
            self.source
                .sql_work
                .enable_fixture_statement_attribution(capacity)
        }
    }

    #[cfg(feature = "sql-statement-attribution")]
    pub fn native_fixture_statement_snapshot(
        &self,
    ) -> std::result::Result<crate::sqlite_work::StatementSnapshot, crate::sqlite_work::Error> {
        self.source.sql_work.fixture_statement_snapshot()
    }

    /// Capture one actual parent, perform bounded synchronous local work, keep
    /// its protected result, finalize execution and complete its existing row.
    /// The caller is the admitted operation/schema owner; it must not provide a
    /// schema guessed from input or claim this local capability dispatches an
    /// external handoff. Full browser admission is rechecked by the real owner.
    pub fn execute_native_setting_batch<F>(
        &mut self,
        call: &NativeCommandCall<'_>,
        ids: &mut dyn LogIds,
        effect: F,
    ) -> Result<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> Result<()>,
    {
        self.execute_native_setting_batch_checked(call, ids, &|| Ok(()), effect)
    }

    pub(crate) fn execute_native_setting_batch_checked<F>(
        &mut self,
        call: &NativeCommandCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        effect: F,
    ) -> Result<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> Result<()>,
    {
        self.execute_native_effect_batch_checked(
            call,
            ids,
            selection_check,
            None,
            false,
            |transaction| {
                effect(transaction)?;
                Ok(EffectResult::Counts { removals: Vec::new() })
            },
        )
    }
    /// The account's own record write (`own-record-writes.json`) under a
    /// browser session: one command per request key; a retry with the same key
    /// returns the saved `{changed, write_count}` without a second write.
    pub fn execute_native_records_write(
        &mut self,
        call: &NativeCommandCall<'_>,
        resource_generation: i64,
        ids: &mut dyn LogIds,
    ) -> Result<NativeCommandResult> {
        self.execute_native_records_write_checked(
            call,
            resource_generation,
            ids,
            &|| Ok(()),
            false,
            None,
        )
    }
    /// `recover_only` reads one committed command back and never writes.
    pub(crate) fn execute_native_records_write_checked(
        &mut self,
        call: &NativeCommandCall<'_>,
        resource_generation: i64,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        recover_only: bool,
        person_present: Option<&serde_json::Value>,
    ) -> Result<NativeCommandResult> {
        let writes = records_write(call.command, call.input_schema)?;
        self.execute_command_effect_checked(
            call.admitted_by_browser(),
            ids,
            selection_check,
            Some(resource_generation),
            recover_only,
            |transaction| {
                transaction.write_records(&writes, None, person_present)?;
                Ok(EffectResult::Counts { removals: Vec::new() })
            },
        )
    }
    /// The same record write admitted by the selected personal key. `current`
    /// rechecks that key's rights at every write and at commit.
    pub(crate) fn execute_selected_records_write_checked(
        &mut self,
        call: &SelectedRecordsWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>,
    ) -> Result<NativeCommandResult> {
        let shipped = crate::record_write_model::write_command::Command::shipped()
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let writes = records_write(call.command, shipped.input_schema())?;
        let resource_generation = call.binding.generation.as_i64().ok_or(crate::cause!(Error::Refused))?;
        if call.binding.operation != call.command.operation
            || call.binding.request_key != call.request.key
            || call.binding.resource != "@own-records"
        {
            return Err(crate::cause!(Error::Refused));
        }
        let command = CommandCall {
            admitter: Admitter::Personal {
                sign_in: call.sign_in,
                current,
            },
            cancel: call.cancel.clone(),
            command: call.command,
            input_schema: shipped.input_schema(),
            permit_id: &call.binding.permit_id,
            original_identity: &call.binding.identity,
            request: call.request,
            log_context: call.context,
            deadline: call.deadline,
        };
        self.execute_command_effect_checked(
            command,
            ids,
            selection_check,
            Some(resource_generation),
            false,
            |transaction| {
                let before = call.cause.map(|_| {
                    transaction.state.external.records(transaction.db)?
                        .change_cursor().map_err(|error| Error::Source(error.cause()))
                }).transpose()?;
                transaction.write_records(&writes, call.within, call.person_present)?;
                let removals = before.map(|before| {
                    transaction.state.external.records(transaction.db)?
                        .removals_after(before).map_err(|error| Error::Source(error.cause()))
                }).transpose()?.unwrap_or_default();
                Ok(EffectResult::Counts { removals })
            },
        )
    }
    /// The original resource generation for a result-only producer. Unlike
    /// the write admission's header read, this never borrows a writer.
    pub(crate) fn original_records_read_generation(&mut self) -> Result<i64> {
        self.assert_owned_now().map_err(|error| Error::Source(error.cause()))?;
        let path = self.source.record_book_path.clone().ok_or(crate::cause!(Error::Source))?;
        let (_file, inode) = open_regular(&path).map_err(|error| Error::Source(error.cause()))?;
        check_sqlite_sidecars(&path).map_err(|error| Error::Source(error.cause()))?;
        let owner = crate::account::NativeAccountOwner::account(self).owner_id;
        let (readers, _) = self.own_read_context().map_err(|error| Error::Source(error.cause()))?;
        if readers.path() != path {
            return Err(crate::cause!(Error::Source));
        }
        let generation = readers
            .read(|store| crate::local_account::own_records::original_generation(&store, &owner))
            .map_err(|error| Error::Source(error.cause()))?
            .ok_or(crate::cause!(Error::OutcomeUnknown))?;
        inode.check(&path).map_err(|error| Error::Source(error.cause()))?;
        check_sqlite_sidecars(&path).map_err(|error| Error::Source(error.cause()))?;
        self.assert_owned_now().map_err(|error| Error::Source(error.cause()))?;
        Ok(generation)
    }

    /// Read one existing command through physical read-only handles. This entry
    /// cannot dispatch an effect or acquire a writer reservation.
    pub(crate) fn recover_selected_records_write_checked(
        &mut self,
        call: &SelectedRecordsWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>,
    ) -> Result<NativeCommandResult> {
        self.recover_selected_records_write_with_proof_checked(call, ids, selection_check, current)
            .map(|(result, _)| result)
    }
    pub(crate) fn recover_selected_records_write_with_proof_checked(
        &mut self,
        call: &SelectedRecordsWriteCall<'_>,
        _ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>,
    ) -> Result<(NativeCommandResult, OriginalRecordsResultReadProof)> {
        let shipped = crate::record_write_model::write_command::Command::shipped()
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let writes = records_write(call.command, shipped.input_schema())?;
        let resource_generation = call.binding.generation.as_i64().ok_or(crate::cause!(Error::Refused))?;
        if call.binding.operation != shipped.operation()
            || call.binding.operation != call.command.operation
            || call.binding.request_key != call.request.key
            || call.binding.resource != "@own-records"
        {
            return Err(crate::cause!(Error::Refused));
        }
        // A run's current write scope must still cover every named target. The
        // route also narrows the reconstructed original Operation, which checks
        // exact ids; this kind check preserves the native writer's own guard.
        if let Some(within) = call.within {
            if writes.iter().any(|write| {
                write
                    .kind
                    .as_ref()
                    .and_then(|kind| kind.to_rust_string().ok())
                    .is_none_or(|kind| !within(&kind))
            }) {
                return Err(crate::cause!(Error::Refused));
            }
        }
        if resource_generation < 1
            || resource_generation > 9_007_199_254_740_991
            || call.cancel.load(Ordering::Acquire)
            || Instant::now() >= call.deadline
            || call.command.request_key != call.request.key
        {
            return Err(crate::cause!(Error::Refused));
        }
        selection_check()?;
        self.assert_owned_now().map_err(|error| Error::Source(error.cause()))?;
        selected_workspace_command::writer_road(call.sign_in)?;
        current(self).map_err(|error| Error::Refused(error.cause()))?;
        let account = crate::account::NativeAccountOwner::account(self);
        let captured = command_capture(
            &CommandCall {
                admitter: Admitter::Personal {
                    sign_in: call.sign_in,
                    current,
                },
                cancel: call.cancel.clone(),
                command: call.command,
                input_schema: shipped.input_schema(),
                permit_id: &call.binding.permit_id,
                original_identity: &call.binding.identity,
                request: call.request,
                log_context: call.context,
                deadline: call.deadline,
            },
            &account.owner_id,
            &account.user_id,
            call.binding.generation.clone(),
        )?;
        // The selected account, exact live input and current generation must
        // reconstruct the original binding, rather than trust caller strings.
        let original_input =
            Zeroizing::new(serde_json::to_string(&call.command.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
        if captured.binding.owner != call.binding.owner
            || selected_workspace_command::database_identity(&parse(&original_input)?)?
                != call.binding.input_identity
        {
            return Err(crate::cause!(Error::Conflict));
        }
        let domain = self.selected_command_domain(&call.command.input, &account.owner_id, resource_generation)?;
        let path = match &domain {
            Some(domain) => domain.readers().map_err(|error| Error::Source(error.cause()))?.path().to_path_buf(),
            None => self.source.record_book_path.clone().ok_or(crate::cause!(Error::Source))?,
        };
        let (file, inode) = open_regular(&path).map_err(|error| Error::Source(error.cause()))?;
        check_sqlite_sidecars(&path).map_err(|error| Error::Source(error.cause()))?;
        let (readers, routes) = match &domain {
            Some(domain) => (domain.readers().map_err(|error| Error::Source(error.cause()))?, None),
            None => self.own_read_context().map_err(|error| Error::Source(error.cause()))?,
        };
        if readers.path() != path {
            return Err(crate::cause!(Error::Source));
        }
        let descriptor = shipped.result_record();
        let result_id = format!("{}:{}", descriptor.kind, captured.binding.permit_id);
        let snapshot = crate::local_account::own_records::read_original_command_result(
            &readers,
            &account.owner_id,
            &captured.binding.permit_id,
            &result_id,
            &captured.binding,
            &Capture {
                durable_input: &captured.durable_input,
                durable_context: &captured.persisted,
                execution_ref: &captured.execution_ref,
            },
            descriptor,
        )
        .map_err(journal_error)?
        .ok_or(crate::cause!(Error::OutcomeUnknown))?;
        let value = field(&snapshot.result_value, &descriptor.field)
            .and_then(|opened| field(opened, &descriptor.result_field))
            .cloned()
            .ok_or(crate::cause!(Error::ProtectedResultUnavailable))?;
        if snapshot.result_kind != descriptor.kind
            || result_identity(&value)? != snapshot.receipt.result_identity
        {
            return Err(crate::cause!(Error::ProtectedResultUnavailable));
        }
        let base = if domain.is_some() {
            let (base_readers, base_routes) = self.own_read_context().map_err(|error| Error::Source(error.cause()))?;
            let base_path = base_readers.path().to_path_buf();
            let (base_file, base_inode) = open_regular(&base_path).map_err(|error| Error::Source(error.cause()))?;
            Some((base_path, base_inode, base_file, base_routes))
        } else { None };
        let proof = OriginalRecordsResultReadProof {
            binding: captured.binding,
            path,
            _file: file,
            inode,
            result_id,
            command_version: snapshot.command_version,
            result_version: snapshot.result_version,
            key_reads: snapshot.key_reads,
            routes,
            domain,
            base,
        };
        selection_check()?;
        current(self).map_err(|error| Error::Refused(error.cause()))?;
        self.assert_owned_now().map_err(|error| Error::Source(error.cause()))?;
        let now = crate::account::NativeAccountOwner::account(self);
        if now.owner_id != proof.binding.owner || now.user_id != account.user_id {
            return Err(crate::cause!(Error::Refused));
        }
        let (readers, routes) = self.own_read_context().map_err(|error| Error::Source(error.cause()))?;
        if call.cancel.load(Ordering::Acquire)
            || Instant::now() >= call.deadline
            || !proof
                .unchanged(&readers, &proof.binding.owner, routes.as_ref())
                .map_err(|error| Error::ProtectedResultUnavailable(error.cause()))?
        {
            return Err(crate::cause!(Error::ProtectedResultUnavailable));
        }
        Ok((
            NativeCommandResult {
                value,
                duplicate: true,
                work: Default::default(),
                removals: Vec::new(),
            },
            proof,
        ))
    }
    fn execute_native_effect_batch_checked<F>(
        &mut self,
        call: &NativeCommandCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        resource_generation: Option<i64>,
        recover_only: bool,
        effect: F,
    ) -> Result<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> Result<EffectResult>,
    {
        self.execute_command_effect_checked(
            call.admitted_by_browser(),
            ids,
            selection_check,
            resource_generation,
            recover_only,
            effect,
        )
    }
    fn execute_command_effect_checked<F>(
        &mut self,
        mut call: CommandCall<'_, '_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        resource_generation: Option<i64>,
        recover_only: bool,
        effect: F,
    ) -> Result<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> Result<EffectResult>,
    {
        selection_check()?;
        if resource_generation.is_some_and(|g| g < 1 || g > 9_007_199_254_740_991) {
            return Err(crate::cause!(Error::Refused));
        }
        let deadline = call
            .deadline
            .min(Instant::now() + crate::legacy_records::Bounds::default().elapsed);
        if call.cancel.load(Ordering::Acquire)
            || Instant::now() >= deadline
            || call.command.request_key != call.request.key
            || call.command.operation.is_empty()
            || !call.command.input.is_object()
            || !matches!(call.input_schema, Value::Object(_))
        {
            return Err(crate::cause!(Error::Refused));
        }
        // A records:write whose input says `check_only` runs every check and refusal, then rolls back and commits nothing.
        let check_only = call.command.operation == crate::record_write_model::write_command::Command::shipped()
            .map_err(|error| crate::carry_cause!(Error::Source, error))?.operation()
            && crate::record_write_model::write_command::Command::check_only(&call.command.input)
                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        if check_only && recover_only {
            return Err(crate::cause!(Error::Refused));
        }
        self.assert_owned().map_err(|error| Error::Source(error.cause()))?;
        // The admitter's first check; State::current repeats it at every step.
        let (owner_id, reader, browser, writer_road) = match &mut call.admitter {
            Admitter::Browser(session) => {
                let admitted = account::current_browser(self, &session.session_id)
                    .map_err(|error| Error::Refused(error.cause()))?;
                let (owner, reader) = (
                    admitted.account.owner_id.clone(),
                    admitted.account.user_id.clone(),
                );
                (owner, reader, Some(admitted), "session")
            }
            Admitter::Personal { sign_in, current } => {
                let road = selected_workspace_command::writer_road(sign_in)?;
                current(self).map_err(|error| Error::Refused(error.cause()))?;
                let account = crate::account::NativeAccountOwner::account(self);
                (account.owner_id, account.user_id, None, road)
            }
        };
        let generation = match (resource_generation, &call.admitter) {
            (Some(generation), _) => serde_json::Value::from(generation),
            (None, Admitter::Browser(session)) => {
                serde_json::Value::String(session.session_id.clone())
            }
            (None, Admitter::Personal { .. }) => return Err(crate::cause!(Error::Refused)),
        };
        let CommandCapture {
            scope,
            binding,
            durable_input,
            persisted,
            initial,
            execution_ref,
            context,
        } = command_capture(&call, &owner_id, &reader, generation)?;
        // Production reads still use this canonical owner. Activate growth
        // routing only with its coupled read, retry and carry consumers.
        let domain = resource_generation.map(|generation| self.selected_command_domain(&call.command.input, &owner_id, generation)).transpose()?.flatten();
        // The current caller was admitted above. Acquire the same account writer turn before Enroll can change
        // canonical policy: account upkeep restores changes made while this computer holds no writer. This still
        // grants no caller/domain right; canonical admission and every later current/source/commit fence remain.
        // Original-result recovery performs no effect and never acquires or moves the writer turn.
        if !recover_only {
            crate::account::computers::copies::before_write(&owner_id).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        }
        // Canonical admission lives independently of the physical supply.
        // Enroll only through this command's genuine current caller, before
        // waiting for its domain writer. The held permit fences old backups
        // even when they predate any local adoption metadata.
        let domain_authority = if let Some(domain) = &domain {
            let mut current = |owner: &mut LocalAccount| match &mut call.admitter {
                Admitter::Browser(session) => account::current_browser(owner, &session.session_id).map(|_| ()),
                Admitter::Personal { current, .. } => current(owner),
            };
            let authority = match self.native_domain_authority(&domain.selection().identity(), call.cancel.clone(), deadline, &mut current) {
                Err(crate::account_rights::Error::NotCanonical(_)) if domain.selection().create =>
                    self.change_native_domain_authority(&domain.selection().identity(),
                        &crate::account_rights::resource_connection::NativeChange::Enroll { request_key: binding.permit_id.clone() },
                        call.cancel.clone(), deadline, &mut current, None),
                found => found,
            }.map_err(|error| {
                // A physical policy read/write failure does not withdraw the caller's rights. Keep canonical and
                // current-admission denials distinct, and let the unchanged original command recover its source.
                match error {
                    crate::account_rights::Error::Unavailable(_) => crate::carry_cause!(Error::Source, error),
                    _ => crate::carry_cause!(Error::Refused, error),
                }
            })?;
            Some(authority)
        } else { None };
        let domain_incarnation = domain_authority.as_ref().map(|authority| authority.current_incarnation().to_owned());
        let native_permit = domain_authority.as_ref().zip(domain_incarnation.as_deref())
            .map(|(authority, incarnation)| authority.hold_native(incarnation)).transpose().map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let writer = match &domain {
            Some(domain) => domain.writer().map_err(|error| Error::Source(error.cause()))?,
            None => self.own_writer().map_err(|error| Error::Source(error.cause()))?,
        };
        let path = writer.path().to_path_buf();
        let (_file, inode) = open_regular(&path).map_err(|error| Error::Source(error.cause()))?;
        check_sqlite_sidecars(&path).map_err(|error| Error::Source(error.cause()))?;
        // One retained record store writer owns the selected physical command group.
        if writer.path() != path {
            return Err(crate::cause!(Error::Source));
        }
        let source = writer
            .lend(call.cancel.clone(), deadline)
            .map_err(|error| Error::Source(error.cause()))?;
        let db = source.connection();
        if let Some(domain)=&domain {
            crate::account::computers::copies::recover_domain_pending(&owner_id,db,domain).map_err(|error| {
                let refusal = crate::carry_cause!(Error::OutcomeUnknown, error);
                crate::quiet_eprintln!("record-writer event=unknown reason=domain-recovery cause={}", refusal.cause());
                refusal
            })?;
        }
        let handle = source.handle();
        let limits = InCommand::limits(db, &path).map_err(|error| Error::Source(error.cause()))?;
        let model = crate::record_model_policy::installed(&self.source.selected.root)
            .map_err(|error| Error::Source(error.cause()))?;
        let base_readers = if domain.is_some() {
            Some(self.own_read_context().map_err(|error| Error::Source(error.cause()))?.0)
        } else { None };
        let mut native = NativeContext {
            selection_check,
            physical_path: path.clone(),
            base_readers,
            adoption: None,
            workspace_generation: resource_generation.map(workspace_generation::Guard::new),
            writer_road,
            binding: clone_binding(&binding),
            durable_input,
            durable_context: persisted,
            execution_ref: execution_ref.clone(),
            pending_local_execution: None,
            record_domain: domain.as_ref().map(|domain| domain.selection().identity()),
            reader,
            handle,
            cancel: call.cancel.clone(),
            deadline,
            limits,
            command_memory: None,
            model,
            outside: None,
            search: std::rc::Rc::new(crate::storage::record_store::SharedSearchMemory::new(
                source.take_search(),
            )),
            list_resources: if domain.is_none() { Some(self.shared_domain_resources()?) } else { None },
        };
        let authority = match (call.admitter, browser) {
            (Admitter::Browser(session), Some(admitted)) => {
                StateAuthority::Browser { session, admitted }
            }
            (Admitter::Personal { current, .. }, None) => StateAuthority::Personal(current),
            _ => return Err(crate::cause!(Error::Source)),
        };
        let tx = source
            .begin_waiting(TransactionBehavior::Immediate, deadline)
            .map_err(|error| Error::Source(error.cause()))?;
        native.command_memory = Some(source.command_memory());
        // A move's local state is a commit fence, not a placement directory.
        // The held writer transaction orders capture and sealing; a fresh
        // external incarnation guard remains held through the real COMMIT.
        let adoption_history = domain.as_ref().map(|domain| serde_json::to_value(domain.selection().identity()))
            .transpose().map_err(|error| crate::carry_cause!(Error::Source, error))?.unwrap_or(serde_json::Value::Null);
        let adoption_slot = crate::storage::record_store_resources::carry::live_adopt::command_slot(&owner_id, &adoption_history)
            .map_err(|error| Error::Source(error.cause()))?;
        let adoption_limits = native_adoption_limits()?;
        native.adoption = crate::storage::record_store_resources::carry::live_adopt::CommandCapture::begin_admitted(
            &crate::storage::record_store_resources::command_storage(&tx, None).map_err(|error| crate::carry_cause!(Error::Source, error))?,
            &adoption_slot, adoption_limits,domain_authority.as_ref().map(|authority|Arc::new(authority.clone()) as Arc<crate::storage::record_store_resources::carry::live_adopt::CurrentFence>)).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let adoption_authority = native.adoption.as_ref().map(|capture| capture.native_fence()).transpose().map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let adoption_incarnation = native.adoption.as_ref().map(|capture| capture.source_incarnation().map(str::to_owned)).transpose().map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let _adoption_guard = match (&adoption_authority, &adoption_incarnation) {
            (Some(authority), Some(incarnation)) => Some(authority.hold(incarnation).map_err(|error| Error::Refused(error.cause()))?),
            _ => None,
        };
        let capture_replica = domain.is_some() && crate::account::computers::copies::capture_required(&owner_id);
        if capture_replica {
            match &native.adoption {
                Some(capture) => capture.enable_replication(),
                None => native.adoption = Some(crate::storage::record_store_resources::carry::live_adopt::CommandCapture::unbound(
                    &crate::storage::sqlite::lend(&tx, crate::local_account::own_records::SCHEMA, crate::storage::sqlite::Access::Write)
                        .map_err(|error| Error::Source(error.cause()))?, adoption_limits)),
            }
        }
        // The account's records this command writes are notified (`records::changes`) only once it commits.
        let notice_scope = domain.as_ref().map(|bound| serde_json::to_value(bound.selection().identity()))
            .transpose().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let held = crate::records::changes::HeldChanges::begin_in_scope(notice_scope);
        let changed_before = tx.total_changes();
        let settings = crate::local_account::own_records::installed_settings(&self.source.selected.root)
            .map_err(|error| Error::Source(error.cause()))?;
        let mut state = State {
            owner: self,
            external: &mut native,
            authority,
            cancel: call.cancel.clone(),
            path,
            inode,
            handle,
            deadline,
            witnesses: 0,
        };
        let answer = (|| {
            if let Some(domain) = &domain {
                state.external.records(&tx)?.command_domain_with_authority(domain.selection(),
                    domain_incarnation.as_deref().ok_or(crate::cause!(Error::Refused))?).map_err(|error| Error::Conflict(error.cause()))?;
            }
            state.witness(&tx, &binding).map_err(journal_error)?;
            // A command runs only on the account's migrated own records (record store).
            if !state
                .external
                .records(&tx)?
                .ready()
                .map_err(|error| Error::Source(error.cause()))?
            {
                return Err(crate::cause!(Error::NotMigrated));
            }
            let mut journal =
                CommandJournal::open(&tx, &mut state, clone_binding(&binding), limits, settings)
                    .map_err(journal_error)?;
            journal.bind_adoption(state.external.adoption.clone());
            let exists = journal.exists(&mut state).map_err(journal_error)?;
            // Recovery is a read of one committed original identity. A
            // missing record must never begin/capture an otherwise fresh command.
            if recover_only && !exists {
                return Err(crate::cause!(Error::OutcomeUnknown));
            }
            let mut transaction = NativeTransaction {
                db: &tx,
                state: &mut state,
                scope: &scope,
                binding: &binding,
                request: call.request,
                context: &context,
                ids,
                captured_record_kind: initial.record_type,
                writes: 0,
                changed: false,
                poisoned: false,
                envelopes: 0,
            };
            if !exists {
                // A committed retry only recovers its original result. It must
                // not activate a later model revision under that old request.
                if let Some(domain) = &domain {
                    transaction.state.external.records(&tx)?.activate_command_closure(&domain.selection().identity(),
                        &transaction.state.external.model).map_err(|error| Error::Conflict(error.cause()))?;
                }
                transaction.stage_internal_execution(&initial.value)?;
            }
            // A fresh synchronous local command retains its producer capture in
            // zeroizing memory. Existing retries read the persisted execution.
            transaction.state.external.execution(&tx)?;
            let durable_input =
                Zeroizing::new(transaction.state.external.durable_input.to_string());
            let durable_context =
                Zeroizing::new(transaction.state.external.durable_context.to_string());
            let load = journal
                .begin_local_atomic(
                    Capture {
                        durable_input: &durable_input,
                        durable_context: &durable_context,
                        execution_ref: &execution_ref,
                    },
                    transaction.state,
                )
                .map_err(journal_error)?;
            match load {
                Load::Committed => {
                    let value = transaction
                        .state
                        .external
                        .protected_result(&tx)
                        .map_err(|error| Error::ProtectedResultUnavailable(error.cause()))?;
                    let identity = result_identity(&value)?;
                    let receipt = journal::Completion {
                        result_identity: identity,
                        native_nonretaining: false,
                    };
                    journal
                        .complete(&receipt, transaction.state)
                        .map_err(journal_error)?;
                    return Ok(NativeCommandResult {
                        value,
                        duplicate: true,
                        work: Default::default(),
                        removals: Vec::new(),
                    });
                }
                Load::Fresh if recover_only => return Err(crate::cause!(Error::OutcomeUnknown)),
                Load::Fresh => {}
                // A command without its committed record and without this
                // invocation's capture never redispatches a closure.
                Load::Unknown => return Err(crate::cause!(Error::OutcomeUnknown)),
            }

            let result_id = format!("resource-command-result:{}", binding.permit_id);
            // Refuse an existing, removed or keyed result owner before local
            // work is invoked, then repeat this check before key creation.
            if !transaction.state.external.fresh(&tx, &result_id)? {
                return Err(crate::cause!(Error::OutcomeUnknown));
            }
            transaction
                .state
                .external
                .records(&tx)?
                .prepare_referrers()
                .map_err(|error| Error::Source(error.cause()))?;
            let schema = schema_version(&tx)?;
            let outcome = effect(&mut transaction)?;
            if check_only {
                // Every write's check has run on this transaction: nothing is sealed, journaled, copied or committed, and the
                // caller's answer says what the write would have counted.
                transaction.current()?;
                let value = object([
                    ("changed", Value::Bool(transaction.changed)),
                    ("write_count", Value::Number(transaction.writes as f64)),
                    ("check_only", Value::Bool(true)),
                ]);
                return Ok(NativeCommandResult { value, duplicate: false, work: record_log::Work::default(), removals: Vec::new() });
            }
            let (value, identity, payload, removals) = match outcome {
                EffectResult::Counts { removals } => {
                    let value = object([
                        ("changed", Value::Bool(transaction.changed)),
                        ("write_count", Value::Number(transaction.writes as f64)),
                    ]);
                    let identity = result_identity(&value)?;
                    let payload = object([("result", value.clone())]);
                    (value, identity, payload, removals)
                }
            };
            encode(&value)?;
            transaction.current()?;
            // No type, tombstone, stale key or erased key can be reminted.
            if !transaction.state.external.fresh(&tx, &result_id)? {
                return Err(crate::cause!(Error::OutcomeUnknown));
            }
            let mut bytes = Zeroizing::new([0u8; 32]);
            SystemRandom::new()
                .fill(bytes.as_mut())
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let key = OriginalKey::from_bytes(bytes);
            let sealed = key
                .seal(&result_id, &"value".into(), &payload)
                .map_err(record_error)?;
            let sealed_result = object([("value", sealed)]);
            let prior = transaction.state.external.execution(&tx)?;
            let terminal = execution_metadata::finish(
                &prior,
                &execution_ref.as_str().into(),
                execution_metadata::Phase::Returned,
                None,
                call.log_context.accepted_at_ms,
            )
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            transaction.publish_internal_completion(
                &result_id,
                &sealed_result,
                &key,
                &terminal.record.value,
            )?;
            if schema_version(&tx)? != schema {
                #[cfg(test)]
                crate::quiet_eprintln!("native-command-stage stage=schema-witness outcome=changed");
                return Err(crate::cause!(Error::Source));
            }
            let receipt = journal::Completion {
                result_identity: identity,
                native_nonretaining: false,
            };
            journal
                .complete(&receipt, transaction.state)
                .map_err(journal_error)?;
            let mut work = record_log::Work::default();
            work.business_envelopes_appended = transaction.envelopes;
            work.sqlite_user_rows_changed = tx.total_changes().saturating_sub(changed_before);
            Ok(NativeCommandResult {
                value,
                duplicate: false,
                work,
                removals,
            })
        })();
        match answer {
            Ok(out) if check_only => rollback_precommit(tx).map(|()| out),
            Ok(out) => {
                // Scoped peers retain preparation without useful disclosure;
                // finalization follows this actual source transaction commit.
                let mut prepared_frame=None;
                let precommit = (|| -> Result<()> {
                state.witness(&tx, &binding).map_err(journal_error)?;
                // An account whose records have copies on other computers commits a write only once a second copy holds
                // it (`account/computers/copies.rs`); otherwise the write rolls back here and nothing of it is visible.
                let captured = if capture_replica {
                    let capture = state.external.adoption.as_ref().ok_or(crate::cause!(Error::Source))?;
                    let raw = crate::storage::sqlite::lend(&tx, crate::local_account::own_records::SCHEMA,
                        crate::storage::sqlite::Access::Write).map_err(|error| Error::Source(error.cause()))?;
                    let effects = capture.final_effects(&raw).map_err(|error| Error::Source(error.cause()))?;
                    if effects.is_empty() { None } else {
                        // This frame follows the original receipt in the same
                        // transaction. The adapter executes transport metadata
                        // without recapturing it as ordinary user effects.
                        let recorded = crate::storage::record_store_resources::carry::live_adopt::Recording::new(raw);
                        recorded.bind(Some(capture.clone()));
                        Some(crate::storage::record_store_resources::carry::commit_log::append_commit(
                            &recorded, &adoption_slot, &binding.permit_id, &effects, adoption_limits)
                            .map_err(|error| Error::Source(error.cause()))?)
                    }
                } else { None };
                let acknowledged = if let Some(domain) = &domain {
                    prepared_frame=captured.clone();
                    crate::account::computers::copies::before_domain_commit(&owner_id, &tx, domain, captured.as_ref())
                } else {
                    crate::account::computers::copies::before_commit(&owner_id, &tx)
                };
                if let Err(cause)=acknowledged {
                    crate::quiet_eprintln!("record-writer event=refused reason=commit-acknowledgement code={cause:?}");
                    return Err(crate::cause!(Error::Refused));
                }
                // Scoped replication may wait; repeat its current rights and
                // generation witness immediately before commit. The unscoped
                // copy protocol retains its original acknowledgement order.
                if domain.is_some() {
                    if let Err(error) = state.witness(&tx, &binding) {
                        return Err(journal_error(error));
                    }
                }
                if let Some(capture) = &state.external.adoption {
                    capture.flush(&crate::storage::record_store_resources::command_storage(&tx, None)
                        .map_err(|error| crate::carry_cause!(Error::Source, error))?).map_err(|error| crate::carry_cause!(Error::Source, error))?;
                }
                Ok(())
                })();
                if let Err(error) = precommit {
                    if let Err(unknown) = rollback_precommit(tx) {
                        if let Some(permit) = &native_permit { permit.mark_outcome_unknown(); }
                        return Err(unknown);
                    }
                    if let (Some(domain),Some(frame))=(&domain,&prepared_frame) {
                        // The physical rollback is confirmed. Peers hold only
                        // unpublished preparation; absence recovery also works
                        // if this best-effort abort response is lost.
                        let _=crate::account::computers::copies::after_domain_rollback(&owner_id,source.connection(),domain,frame);
                    }
                    return Err(error);
                }
                tx.commit().map_err(|error| {
                    let refusal = crate::carry_cause!(Error::OutcomeUnknown, error);
                    crate::quiet_eprintln!("record-writer event=unknown reason=commit code={:?} cause={}", error.sqlite_error_code(), refusal.cause());
                    if let Some(permit) = &native_permit { permit.mark_outcome_unknown(); }
                    refusal
                })?;
                if let Some(domain)=&domain {
                    // This retained writer is now in autocommit. Finalization
                    // samples a new actual source snapshot, then waits for the
                    // finalized-copy quorum before useful result disclosure.
                    crate::account::computers::copies::after_domain_commit(&owner_id,source.connection(),domain)
                        .map_err(|error| {
                            let refusal = crate::carry_cause!(Error::OutcomeUnknown, error);
                            crate::quiet_eprintln!("record-writer event=unknown reason=domain-finalize cause={}", refusal.cause());
                            refusal
                        })?;
                }
                if prepared_frame.is_some() {drop(held);}else{held.published();}
                // Committed: the search memory its stores share stands for the next command on this handle.
                if let Some(memory) = state.external.search.committed() {
                    source.keep_search(memory);
                }
                // From here the command is committed: its outcome is known, and nothing below answers "unknown".
                #[cfg(test)]
                after_commit_hook(&state.path);
                // Repeat selection and caller authority before the bounded local read. A caller check may
                // consult its original remote parent; that time is not physical snapshot work. The final
                // journal/result/key read uses the existing genuine Readers owner, with no callback afterward.
                if let Some(guard) = &state.external.workspace_generation {
                    guard.committed();
                }
                let delivered = (|| {
                    if call.cancel.load(Ordering::Acquire) {
                        return Err(crate::cause!(Error::Refused));
                    }
                    (state.external.selection_check)()?;
                    state.admission_current()?;
                    let until = Instant::now() + DELIVERY_BOUND;
                    state.deadline = until;
                    state.external.deadline = until;
                    state.witnesses += 1;
                    state.source(source.connection())?;
                    let readers = match &domain {
                        Some(domain) => domain.readers().map_err(|error| Error::Source(error.cause()))?,
                        None => state.owner.own_read_context().map_err(|error| Error::Source(error.cause()))?.0,
                    };
                    if readers.path() != state.path {
                        return Err(crate::cause!(Error::Source));
                    }
                    let shipped = crate::record_write_model::write_command::Command::shipped()
                        .map_err(|error| crate::carry_cause!(Error::Source, error))?;
                    let descriptor = shipped.result_record();
                    let result_id = format!("{}:{}", descriptor.kind, binding.permit_id);
                    let snapshot = crate::local_account::own_records::read_original_command_result_bounded(
                        &readers, &owner_id, &binding.permit_id, &result_id, &binding,
                        &Capture {
                            durable_input: &state.external.durable_input,
                            durable_context: &state.external.durable_context,
                            execution_ref: &state.external.execution_ref,
                        }, descriptor, resource_generation, call.cancel.clone(), until,
                    ).map_err(|error| Error::ProtectedResultUnavailable(error.cause()))?
                        .ok_or(crate::cause!(Error::ProtectedResultUnavailable))?;
                    let value = field(&snapshot.result_value, &descriptor.field)
                        .and_then(|opened| field(opened, &descriptor.result_field))
                        .ok_or(crate::cause!(Error::ProtectedResultUnavailable))?;
                    if snapshot.result_kind != descriptor.kind
                        || !source_free_result(value)
                        || result_identity(value)? != snapshot.receipt.result_identity
                        || result_identity(&out.value)? != snapshot.receipt.result_identity
                    {
                        return Err(crate::cause!(Error::ProtectedResultUnavailable));
                    }
                    // After exact result/key custody only local source/time/cancel checks run.
                    state.source(source.connection())?;
                    if call.cancel.load(Ordering::Acquire) || Instant::now() >= until {
                        return Err(crate::cause!(Error::Source));
                    }
                    Ok(())
                })();
                match delivered {
                    Ok(()) => {
                        let mut out = out;
                        out.work.source_witnesses = state.witnesses;
                        Ok(out)
                    }
                    Err(Error::ProtectedResultUnavailable(cause)) => Err(Error::ProtectedResultUnavailable(cause)),
                    Err(error) => { crate::quiet_eprintln!("command-delivery event=withheld cause={}", error.cause()); Err(Error::CommittedAnswerWithheld(error.cause())) },
                }
            }
            Err(error) => match rollback_precommit(tx) {
                // A value outside a field's choices names the field and value to the caller, who takes them from
                // the account (`LocalAccount::take_write_refusal`).
                Ok(()) => {
                    if let Some(outside) = state.external.outside.take() {
                        state.owner.write_refusal = Some(outside);
                    }
                    Err(error)
                }
                Err(_) => {
                    if let Some(permit) = &native_permit { permit.mark_outcome_unknown(); }
                    Err(crate::cause!(Error::OutcomeUnknown))
                },
            },
        }
    }
}

#[cfg(test)]
mod precommit_rollback_controls {
    use super::*;
    use crate::storage::sqlite::{Connection, TransactionBehavior};

    #[test]
    fn interrupted_write_automatic_rollback_is_a_known_precommit_failure() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE probe(id INTEGER PRIMARY KEY)")
            .unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("INSERT INTO probe VALUES(0)", []).unwrap();
        let steps = std::sync::atomic::AtomicUsize::new(0);
        tx.progress_handler(
            1,
            Some(move || steps.fetch_add(1, Ordering::Relaxed) >= 100),
        );
        let stopped = tx
            .execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) \
             INSERT INTO probe SELECT i FROM n",
            )
            .unwrap_err();
        assert_eq!(
            stopped.sqlite_error_code(),
            Some(rusqlite::ErrorCode::OperationInterrupted)
        );
        assert!(
            tx.is_autocommit(),
            "SQLite rolled back the entire interrupted write transaction"
        );
        rollback_precommit(tx).expect("the aborted transaction is already proved rolled back");
        let rows: i64 = db
            .query_row("SELECT count(*) FROM probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            rows, 0,
            "neither the earlier row nor the interrupted write survived"
        );
        let retry = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        retry.execute("INSERT INTO probe VALUES(0)", []).unwrap();
        retry.commit().unwrap();
    }

    #[test]
    fn exhausted_progress_budget_does_not_prevent_precommit_rollback() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE probe(id INTEGER PRIMARY KEY)")
            .unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("INSERT INTO probe VALUES(0)", []).unwrap();
        tx.progress_handler(1, Some(|| true));
        rollback_precommit(tx)
            .expect("cleanup rolls back with the exhausted effect budget disarmed");
        let rows: i64 = db
            .query_row("SELECT count(*) FROM probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
}

#[cfg(test)]
#[path = "../../tests/drafts/unknown_outcome_causes.rs"]
mod refusal_cause_tests;
