//! Selected personal-key consumer of the original workspace command owner.
//! The producer retains PersonalPolicyWitness and its exact call while this
//! method runs. No browser session, command table, grant or result store is
//! created. Existing journal, record append, keys and output witnesses own all
//! durable effects. The Native parent supplies the original locale comparator.

use super::super::StateAuthority;
use super::*;
use crate::account::{AccountResult, NativeAccountOwner};
use std::cmp::Ordering as CompareOrder;

#[cfg(test)]
mod controls {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/drafts/selected_workspace_command.rs"
    ));
    mod original_records_result {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/drafts/selected_own_records_result.rs"
        ));
    }
}

pub(crate) struct SelectedWorkspaceWriteCall<'a> {
    pub(crate) binding: &'a CommandBinding,
    pub(crate) sign_in: &'a str,
    pub(crate) input: &'a Value,
    pub(crate) request: &'a Request,
    pub(crate) context: &'a Context,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
}

/// The original own-record write tuple carried to its read-only result
/// reconciliation. `request` is the original write's request key; the
/// public reconciliation delivery has its own separate key and never enters
/// this binding.
pub(crate) struct SelectedOwnRecordsRecoveryCall<'a> {
    pub(crate) binding: &'a CommandBinding,
    pub(crate) sign_in: &'a str,
    pub(crate) command: &'a DomainCommand,
    pub(crate) request: &'a Request,
    pub(crate) context: &'a Context,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
    /// The still-current run's original write-kind scope, when this recovery
    /// is a tool call. Its exact ids are narrowed by the route before entry.
    pub(crate) within: Option<&'a dyn Fn(&str) -> bool>,
}

// The SAME original protected-result owner and IMMEDIATE delivery reservation.
// The message/connection owns this value until physical write/flush finishes. No
// other result opener, projection copy, donor key or second writer is added.
pub(crate) struct OriginalWorkspaceOutputCustody {
    _source: crate::storage::record_store_resources::LentWriter,
    _saved: super::workspace_write_readback::ProtectedWorkspaceResult,
    _permit: super::workspace_write_output::FinalOutputPermit,
}

/// The workspace labels a `workspace:write` input names (`writes[].address_label`).
fn written_labels(input: &Value) -> Vec<String> {
    let field = |value: &Value, key: &str| match value {
        Value::Object(o) => o.get(&JsString::from(key)).cloned(),
        _ => None,
    };
    match field(input, "writes") {
        Some(Value::Array(writes)) => writes
            .iter()
            .filter_map(|write| match field(write, "address_label") {
                Some(Value::String(label)) => label.to_rust_string().ok(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Original write-via derives provenance from authenticated sign-in,
/// never from workspace JSON or from a person seeming to be there.
pub(super) fn writer_road(sign_in: &str) -> Result<&'static str> {
    Ok(match sign_in.split_once(':') {
        // A sign-in pass (src/account/signed_in.rs): `jwt:<subject>`, whichever party signed in.
        Some(("jwt", suffix)) if !suffix.is_empty() => "jwt",
        Some(("key", suffix)) if !suffix.is_empty() => "key",
        Some(("session", suffix)) if !suffix.is_empty() => "session",
        Some(("grant", suffix)) if !suffix.is_empty() => "grant",
        _ => return Err(crate::cause!(Error::Refused)),
    })
}

pub(super) fn database_identity(value: &Value) -> Result<String> {
    crate::record_canonical::identity(
        value,
        Default::default(),
        &mut |a: &JsString, b: &JsString| Ok::<_, ()>(a.units().cmp(b.units())),
    )
    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?
    .strip_prefix("1f:")
    .map(str::to_owned)
    .ok_or(crate::cause!(Error::Invalid))
}

impl LocalAccount {
    /// Reopen one committed own-record command through the existing command
    /// journal and result key. The call contains only the original write
    /// identity; no flag or caller choice can turn it into an effect dispatch.
    pub(crate) fn recover_selected_own_records_result_checked(
        &mut self,
        call: &SelectedOwnRecordsRecoveryCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
    ) -> Result<NativeCommandResult> {
        self.recover_selected_own_records_result_with_proof_checked(
            call,
            ids,
            selection_check,
            current,
        )
        .map(|(result, _)| result)
    }

    /// Retain the same-snapshot result/key custody for the admitted consumer's
    /// last disclosure check, after all of its current-rights callbacks.
    pub(crate) fn recover_selected_own_records_result_with_proof_checked(
        &mut self,
        call: &SelectedOwnRecordsRecoveryCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
    ) -> Result<(NativeCommandResult, OriginalRecordsResultReadProof)> {
        let write = SelectedRecordsWriteCall {
            binding: call.binding,
            sign_in: call.sign_in,
            command: call.command,
            request: call.request,
            context: call.context,
            cancel: call.cancel.clone(),
            deadline: call.deadline,
            within: call.within,
            cause: None,
            person_present: None,
        };
        self.recover_selected_records_write_with_proof_checked(
            &write,
            ids,
            selection_check,
            current,
        )
    }

    /// Only the retained selected-key producer calls this entry. `current`
    /// rechecks that SAME owner/key/call/gate at every actual append and commit.
    /// A caller-supplied label or copied permit string cannot replace it.
    pub(crate) fn execute_selected_workspace_write_checked<F>(
        &mut self,
        call: &SelectedWorkspaceWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        compare: &mut F,
    ) -> Result<NativeCommandResult>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<CompareOrder, ()>,
    {
        let result = self
            .selected_workspace_write_mode_checked(
                call,
                ids,
                selection_check,
                current,
                compare,
                false,
                false,
            )
            .map(|(result, _)| result)?;
        // The write is durable: the operator publishes the service records it changed (local_account/service_records.rs).
        // A refused publication never fails the write; the next write or start tries again.
        let written = written_labels(call.input);
        if !written.is_empty() {
            let _ = self.publish_own_service_records(Some(&written), call.cancel.clone());
        }
        Ok(result)
    }

    /// Only recover an existing committed original binding; never dispatch a
    /// missing, erased, working or unknown command while releasing an HTTP body.
    pub(crate) fn recover_selected_workspace_write_checked<F>(
        &mut self,
        call: &SelectedWorkspaceWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        compare: &mut F,
    ) -> Result<NativeCommandResult>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<CompareOrder, ()>,
    {
        self.selected_workspace_write_mode_checked(
            call,
            ids,
            selection_check,
            current,
            compare,
            true,
            false,
        )
        .map(|(result, _)| result)
    }

    pub(crate) fn recover_selected_workspace_write_custody_checked<F>(
        &mut self,
        call: &SelectedWorkspaceWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        compare: &mut F,
    ) -> Result<(NativeCommandResult, OriginalWorkspaceOutputCustody)>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<CompareOrder, ()>,
    {
        let (result, custody) = self.selected_workspace_write_mode_checked(
            call,
            ids,
            selection_check,
            current,
            compare,
            true,
            true,
        )?;
        Ok((result, custody.ok_or(crate::cause!(Error::ProtectedResultUnavailable))?))
    }

    fn selected_workspace_write_mode_checked<F>(
        &mut self,
        call: &SelectedWorkspaceWriteCall<'_>,
        ids: &mut dyn LogIds,
        selection_check: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        compare: &mut F,
        recover_only: bool,
        retain_output: bool,
    ) -> Result<(NativeCommandResult, Option<OriginalWorkspaceOutputCustody>)>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<CompareOrder, ()>,
    {
        selection_check()?;
        current(self).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        let road = writer_road(call.sign_in)?;
        let account = self.account();
        let binding = call.binding;
        let deadline = call
            .deadline
            .min(Instant::now() + crate::legacy_records::Bounds::default().elapsed);
        if call.cancel.load(Ordering::Acquire)
            || Instant::now() >= deadline
            || binding.owner != account.owner_id
            || binding.resource != "@own-records"
            || binding.operation != workspace_write::OPERATION
            || binding.request_key != call.request.key
            || call.sign_in.is_empty()
            || call.request.key.is_empty()
            || call.request.key.encode_utf16().count() > 512
        {
            return Err(crate::cause!(Error::Refused));
        }
        workspace_write::parse_input(call.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let permit_parts = Value::Array(
            [
                account.owner_id.as_str(),
                call.sign_in,
                "@own-records",
                &call.request.key,
            ]
            .into_iter()
            .map(|v| Value::String(v.into()))
            .collect(),
        );
        if binding.permit_id != format!("resource-command:{}", database_identity(&permit_parts)?)
            || binding.input_identity != database_identity(call.input)?
        {
            return Err(crate::cause!(Error::Conflict));
        }
        let identity = crate::record_canonical::identity(
            &Value::Array(vec![
                Value::String(workspace_write::OPERATION.into()),
                call.input.clone(),
                Value::String(call.request.key.as_str().into()),
            ]),
            Default::default(),
            compare,
        )
        .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if binding.identity != identity {
            return Err(crate::cause!(Error::Conflict));
        }
        let durable_input = Zeroizing::new(encode(
            &workspace_write::private_persistence_value(call.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
        )?);
        let reader = account.user_id;
        let schema = ecma_json::parse(workspace_write::INPUT_SCHEMA.as_bytes(), Default::default())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let schema_identity = digest(&schema)?;
        let persisted = Zeroizing::new(serde_json::to_string(&serde_json::json!({
            "permit_id":binding.permit_id,"owner":binding.owner,"resource":binding.resource,
            "generation":binding.generation,"operation":binding.operation,
            "request_key":binding.request_key,"input_identity":binding.input_identity,
            "recorder":{"reader":reader,"basis":"authenticated","app_basis":"unknown"},
            "commitment":{"input_schema_identity":schema_identity,"local_result_contract":"native-workspace-write/v1"}
        })).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
        // This existing managed-capture value has no browser-session field.
        // Authentication is the retained personal-key checker, independently.
        let initial = execution_metadata::begin(
            &execution_metadata::ManagedBrowser {
                call_id: &binding.permit_id.as_str().into(),
                request_id: &call.request.key.as_str().into(),
                operation: &workspace_write::OPERATION.into(),
                reader: &reader.as_str().into(),
                app: None,
                app_basis: execution_metadata::AppBasis::Unknown,
                origin: execution_metadata::Origin::Real,
            },
            call.context.accepted_at_ms,
        )
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let execution_ref = initial.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let context = Context {
            actor: serde_json::json!({"reader":reader,"basis":"authenticated","actor":{"basis":"unknown"}}),
            application_time: call.context.application_time.clone(),
            system_time: call.context.system_time.clone(),
            accepted_at_ms: call.context.accepted_at_ms,
        };
        let scope = Scope {
            account: binding.owner.clone(),
            resource: binding.resource.clone(),
        };
        // The same account turn as every native records command, before opening its physical transaction. A
        // protected original-result read performs no effect and must not acquire or move the writer turn.
        if !recover_only {
            crate::account::computers::copies::before_write(&binding.owner).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        }
        let path = self.source.record_book_path.clone().ok_or(crate::cause!(Error::Source))?;
        let (_file, inode) = open_regular(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        check_sqlite_sidecars(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        // The account's kept writer (`record_store_resources::Writer`); a retained output reservation keeps it past this
        // call and gives it back when it ends, and a command meanwhile opens its own.
        let writer = self.own_writer().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if writer.path() != path {
            return Err(crate::cause!(Error::Source));
        }
        let source = writer
            .lend(call.cancel.clone(), deadline)
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let db = source.connection();
        let handle = source.handle();
        let limits = InCommand::limits(db, &path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let model = crate::record_model_policy::installed(&self.source.selected.root)
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let mut native = NativeContext {
            selection_check,
            physical_path: path.clone(),
            base_readers: None,
            adoption: None,
            workspace_generation: Some(workspace_generation::Guard::new(
                binding.generation.as_i64().ok_or(crate::cause!(Error::Refused))?,
            )),
            writer_road: road,
            binding: clone_binding(binding),
            durable_input,
            durable_context: persisted,
            execution_ref: execution_ref.clone(),
            pending_local_execution: None,
            record_domain: None,
            reader: reader.clone(),
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
            list_resources: Some(self.shared_domain_resources()?),
        };
        let tx = source
            .begin_waiting(TransactionBehavior::Immediate, deadline)
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        // The account's records this command writes are notified (`records::changes`) only once it commits.
        let held = crate::records::changes::HeldChanges::begin();
        let changed_before = tx.total_changes();
        let settings = crate::local_account::own_records::installed_settings(&self.source.selected.root)
            .map_err(|error| Error::Source(error.cause()))?;
        let mut state = State {
            owner: self,
            external: &mut native,
            authority: StateAuthority::Personal(current),
            cancel: call.cancel.clone(),
            path,
            inode,
            handle,
            deadline,
            witnesses: 0,
        };
        let mut already_committed = false;
        let answer = (|| {
            state.witness(&tx, binding).map_err(journal_error)?;
            // A command runs only on the account's migrated own records (record store).
            if !state
                .external
                .records(&tx)?
                .ready()
                .map_err(|error| crate::carry_cause!(Error::Source, error))?
            {
                return Err(crate::cause!(Error::Source));
            }
            let mut journal = CommandJournal::open(&tx, &mut state, clone_binding(binding), limits, settings)
                .map_err(journal_error)?;
            let exists = journal.exists(&mut state).map_err(journal_error)?;
            let mut transaction = NativeTransaction {
                db: &tx,
                state: &mut state,
                scope: &scope,
                binding,
                request: call.request,
                context: &context,
                ids,
                captured_record_kind: initial.record_type,
                writes: 0,
                changed: false,
                poisoned: false,
                envelopes: 0,
            };
            if recover_only && !exists {
                return Err(crate::cause!(Error::ProtectedResultUnavailable));
            }
            if !exists {
                transaction.stage_internal_execution(&initial.value)?;
            }
            transaction.state.external.execution(&tx)?;
            let input = Zeroizing::new(transaction.state.external.durable_input.to_string());
            let context = Zeroizing::new(transaction.state.external.durable_context.to_string());
            match journal
                .begin_local_atomic(
                    Capture {
                        durable_input: &input,
                        durable_context: &context,
                        execution_ref: &execution_ref,
                    },
                    transaction.state,
                )
                .map_err(journal_error)?
            {
                Load::Committed => {
                    already_committed = true;
                    let saved = transaction.state.external.protected_workspace_result(&tx)?;
                    journal
                        .complete(
                            &journal::Completion {
                                result_identity: saved.identity().to_owned(),
                                native_nonretaining: false,
                            },
                            transaction.state,
                        )
                        .map_err(journal_error)?;
                    return Ok(NativeCommandResult {
                        value: saved.result().clone(),
                        duplicate: true,
                        work: Default::default(),
                        removals: Vec::new(),
                    });
                }
                Load::Fresh if !recover_only => {}
                _ => return Err(crate::cause!(Error::OutcomeUnknown)),
            }
            let now_ms = call.context.accepted_at_ms;
            let origin = workspace_write_sql::WriteOrigin {
                author: Some(&reader),
                road: Some(road),
                permit_id: Some(binding.permit_id.as_str()),
            };
            let pending = transaction.workspace_write_effect(
                &mut journal,
                call.input,
                now_ms,
                &call.context.application_time,
                &origin,
            )?;
            // Prepare the installed model's known index families before the unchanged-schema witness. Output
            // schema DDL belongs to the effect above; from this witness through completion the schema stays as it is.
            transaction
                .state
                .external
                .records(&tx)?
                .prepare_referrers()
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let schema = schema_version(&tx)?;
            let prepared = transaction.prepare_workspace_write_result(&pending, compare)?;
            let result_identity = prepared.identity.clone();
            let prior = transaction.state.external.execution(&tx)?;
            let terminal = execution_metadata::finish(
                &prior,
                &execution_ref.as_str().into(),
                execution_metadata::Phase::Returned,
                None,
                now_ms,
            )
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            transaction.publish_internal_completion(
                &prepared.id,
                &prepared.record,
                &prepared.key,
                &terminal.record.value,
            )?;
            if schema_version(&tx)? != schema {
                return Err(crate::cause!(Error::Source));
            }
            transaction.complete_workspace_write(
                &mut journal,
                &pending,
                &journal::Completion {
                    result_identity: result_identity.clone(),
                    native_nonretaining: false,
                },
                &result_identity,
            )?;
            let mut work = record_log::Work::default();
            work.business_envelopes_appended = transaction.envelopes;
            work.sqlite_user_rows_changed = tx.total_changes().saturating_sub(changed_before);
            Ok(NativeCommandResult {
                value: pending.result().clone(),
                duplicate: false,
                work,
                removals: Vec::new(),
            })
        })();
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                return match rollback_precommit(tx) {
                    Ok(()) if already_committed && !matches!(error, Error::ProtectedResultUnavailable(_)) => {
                        Err(crate::cause!(Error::OutcomeUnknown))
                    }
                    Ok(()) => Err(error),
                    Err(_) => Err(crate::cause!(Error::OutcomeUnknown)),
                }
            }
        };
        if let Err(error) = state.witness(&tx, binding).map_err(journal_error) {
            return match rollback_precommit(tx) {
                Ok(()) if !already_committed => Err(error),
                _ => Err(crate::cause!(Error::OutcomeUnknown)),
            };
        }
        tx.commit().map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
        held.published();
        if let Some(guard) = &state.external.workspace_generation {
            guard.reset_transaction();
        }
        // Never return the pre-commit value. Read its original sealed owner in
        // a fresh snapshot, under current key rights and the final output gate.
        // The original protected reader requires a caller-held IMMEDIATE
        // transaction. This fresh transaction performs no effect; it retains
        // the source lock through the last output check.
        let delivery = source
            .begin_waiting(TransactionBehavior::Immediate, deadline)
            .map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
        let released = (|| {
            state
                .witness(&delivery, binding)
                .map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
            let saved = state.external.protected_workspace_result(&delivery)?;
            let permit = state
                .external
                .workspace_final_output_permit(&delivery, &saved)?;
            state
                .witness(&delivery, binding)
                .map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
            permit
                .assert_current(&delivery, saved.result())
                .map_err(|error| crate::carry_cause!(Error::ProtectedResultUnavailable, error))?;
            Ok((saved, permit))
        })();
        let (saved, permit) = released.map_err(|error| match error {
            Error::ProtectedResultUnavailable(_) => error,
            _ => crate::cause!(Error::OutcomeUnknown),
        })?;
        let value = saved.result().clone();
        if retain_output {
            // Transfer this already-open transaction to its owned connection;
            // its Drop performs the rollback. No fallible step follows the
            // ownership transfer, and no account/source read follows the last
            // output permit above.
            std::mem::forget(delivery);
            source.clear_progress();
            return Ok((
                NativeCommandResult {
                    value,
                    duplicate: answer.duplicate,
                    work: answer.work,
                    removals: Vec::new(),
                },
                Some(OriginalWorkspaceOutputCustody {
                    _source: source,
                    _saved: saved,
                    _permit: permit,
                }),
            ));
        }
        delivery.rollback().map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
        #[cfg(test)]
        if let Some(guard) = &state.external.workspace_generation {
            crate::quiet_eprintln!(
                "selected writer original-header lookups={}",
                guard.lookups()
            );
        }
        Ok((
            NativeCommandResult {
                value,
                duplicate: answer.duplicate,
                work: answer.work,
                removals: Vec::new(),
            },
            None,
        ))
    }
}
