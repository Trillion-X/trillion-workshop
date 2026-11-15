//! The door's producers for the installed own-record commands: the workspace
//! write and the account's own record write. The door's sign-in admission
//! (`account::account_routes::Caller`) is checked at every check; the existing
//! LocalAccount writer owns effects, journal and protected output.

use crate::{
    account::NativeAccountOwner,
    ecma_json,
    local_account::{
        command_journal::CommandBinding,
        own_records,
        record_writer::{
            self,
            native_command_context::{
                SelectedRecordsWriteCall, SelectedWorkspaceWriteCall, WORKSPACE_WRITE,
            },
        },
        LocalAccount,
    },
    native_boot::{
        mcp_workspace_write::original_binding, tool_screens::ToolLabelLocale, SelectedAccount,
    },
    record_log::{Context, LogIds, Request},
    record_write_model::write_command,
    tool_label_locale::QualifiedLocale,
    workspace_domain::DomainCommand,
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

#[cfg(all(test, feature = "exact-native-locale"))]
mod controls {
    mod carried_selection {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/carried_selection.rs"
        ));
    }
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/drafts/selected_workspace_write.rs"
    ));
    mod browser_controls {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/drafts/browser_workspace_write.rs"
        ));
        mod outbox_wire {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/drafts/browser_outbox_wire.rs"
            ));
        }
        mod same_data_followthrough {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/drafts/workspace_same_data_followthrough.rs"
            ));
        }
    }
}

#[cfg(test)]
use crate::{
    account::AccountResult,
    local_account::record_writer::native_command_context::NativeCommandResult,
};

/// Shared concrete consumer of an admitted workspace write. The current checker
/// is the door's sign-in admission, never a caller label.
#[cfg(test)]
pub(super) fn execute_owned_workspace_write(
    owner: &mut LocalAccount,
    current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
    selection: &crate::native_boot::Chosen,
    operation: &crate::mcp::Operation,
    sign_in: &str,
    locale: &QualifiedLocale,
    request: &Request,
    context: &Context,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    ids: &mut dyn LogIds,
) -> record_writer::Result<NativeCommandResult> {
    use record_writer::Error;
    current(owner).map_err(|error| crate::carry_cause!(record_writer::Error::Refused, error))?;
    let prepared =
        prepare_owned_workspace_write(owner, operation, sign_in, locale, request, context)?;
    let selected = || {
        selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        locale.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))
    };
    owner.execute_selected_workspace_write_checked(
        &prepared.call(sign_in, cancel, deadline),
        ids,
        &selected,
        current,
        &mut |left, right| locale.compare(left, right).map_err(|_| ()),
    )
}

// Retain the original binding, input and accepted request/context for final
// journal recovery; no caller may replace them at the response-chunk boundary.
pub(super) struct PreparedOwnedWorkspaceWrite {
    binding: CommandBinding,
    input: ecma_json::Value,
    request: Request,
    context: Context,
}
impl PreparedOwnedWorkspaceWrite {
    pub(super) fn call<'a>(
        &'a self,
        sign_in: &'a str,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> SelectedWorkspaceWriteCall<'a> {
        SelectedWorkspaceWriteCall {
            binding: &self.binding,
            sign_in,
            input: &self.input,
            request: &self.request,
            context: &self.context,
            cancel,
            deadline,
        }
    }
}
pub(super) fn prepare_owned_workspace_write(
    owner: &mut LocalAccount,
    operation: &crate::mcp::Operation,
    sign_in: &str,
    locale: &QualifiedLocale,
    request: &Request,
    context: &Context,
) -> record_writer::Result<PreparedOwnedWorkspaceWrite> {
    if operation.operation != WORKSPACE_WRITE {
        return Err(crate::cause!(record_writer::Error::Invalid));
    }
    let (binding, input) = owned_command_binding(owner, operation, sign_in, locale, request)?;
    Ok(PreparedOwnedWorkspaceWrite {
        binding,
        input,
        request: request.clone(),
        context: context.clone(),
    })
}
/// The original journal binding of one selected own-record command: its permit
/// (owner, sign-in, resource, request key), its locale-ordered identity and the
/// resource generation it runs under.
pub(super) fn owned_command_binding(
    owner: &mut LocalAccount,
    operation: &crate::mcp::Operation,
    sign_in: &str,
    locale: &QualifiedLocale,
    request: &Request,
) -> record_writer::Result<(CommandBinding, ecma_json::Value)> {
    use record_writer::Error;
    if operation.resource != "@own-records" || operation.request_key != request.key {
        return Err(crate::cause!(Error::Invalid));
    }
    locale.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
    let account_id = owner.account().owner_id;
    let original = super::original_command_ids_at_resource(
        &account_id,
        sign_in,
        &operation.resource,
        operation,
    )
    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let bytes = serde_json::to_vec(&operation.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let input = ecma_json::parse(&bytes, Default::default()).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let identity = original_binding(
        &operation.operation,
        input.clone(),
        &request.key,
        &mut |left, right| locale.compare(left, right),
    )
    .map_err(|error| crate::carry_cause!(Error::Source, error))?;
    let generation = owner.original_workspace_generation()?;
    let binding = CommandBinding {
        permit_id: original.permit_id,
        identity,
        owner: account_id,
        resource: operation.resource.clone(),
        generation: serde_json::Value::from(generation),
        operation: operation.operation.clone(),
        request_key: request.key.clone(),
        input_identity: original.input_identity,
    };
    Ok((binding, input))
}

/// The original journal binding of one account's own record write (`own-record-writes.json`): the same permit and
/// resource generation as `owned_command_binding`, with the locale-free request identity the original own-record
/// command declared (`own_record_write_identity`). The generic record write never waits on the tool-label locale.
pub(super) fn owned_records_binding(
    owner: &mut LocalAccount,
    operation: &crate::mcp::Operation,
    sign_in: &str,
    request: &Request,
) -> record_writer::Result<CommandBinding> {
    owned_records_binding_using_generation(
        owner,
        operation,
        sign_in,
        request,
        LocalAccount::original_workspace_generation,
    )
}

/// The same original identities and construction order, with the generation
/// supplied by the producer's trusted native read or write owner.
pub(super) fn owned_records_binding_using_generation(
    owner: &mut LocalAccount,
    operation: &crate::mcp::Operation,
    sign_in: &str,
    request: &Request,
    read_generation: fn(&mut LocalAccount) -> record_writer::Result<i64>,
) -> record_writer::Result<CommandBinding> {
    use record_writer::Error;
    if operation.resource != "@own-records"
        || operation.request_key != request.key
        || !write_command::Command::is_shipped(&operation.operation)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let account_id = owner.account().owner_id;
    let original = super::original_command_ids_at_resource(
        &account_id,
        sign_in,
        &operation.resource,
        operation,
    )
    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let bytes = serde_json::to_vec(&operation.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let input = ecma_json::parse(&bytes, Default::default()).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let identity = super::own_record_write_identity(&operation.operation, &input, &request.key)
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let generation = read_generation(owner)?;
    Ok(CommandBinding {
        permit_id: original.permit_id,
        identity,
        owner: account_id,
        resource: operation.resource.clone(),
        generation: serde_json::Value::from(generation),
        operation: operation.operation.clone(),
        request_key: request.key.clone(),
        input_identity: original.input_identity,
    })
}

/// Name only the removals this exact committed command made. The native transaction captured them under its
/// physical write reservation; a whole-account before/after feed would also capture concurrent callers' removals.
pub(super) fn name_removals(owner: &mut LocalAccount, cause: &str, removed: &[i64]) {
    if removed.is_empty() {
        return;
    }
    let Ok(waker) = crate::wake::Waker::shipped() else {
        return;
    };
    let Ok(mut held) = owner.take_own_records() else {
        return;
    };
    {
        let (store, account) = held.store_mut();
        let account = account.to_owned();
        for &sequence in removed {
            let _ = waker.own_change(&account, store, cause, own_records::RESOURCE, sequence);
        }
    }
    owner.put_own_records(held);
}

impl SelectedAccount {
    /// A local pending command is bound by the very same source-qualified
    /// history resolver as its eventual native command. This grants no rights
    /// and creates no history; the writer repeats it before invoking the door.
    pub(crate) fn pending_records_scope(&mut self, input: &serde_json::Value, expected_owner: &str)
        -> record_writer::Result<Option<crate::storage::record_store_resources::domains::Identity>> {
        self.pending_records_source(input,expected_owner).map(|(_,scope)|scope)
    }
    pub(crate) fn pending_records_source(&mut self,input:&serde_json::Value,expected_owner:&str)
        -> record_writer::Result<(i64,Option<crate::storage::record_store_resources::domains::Identity>)> {
        use record_writer::Error;
        self.assert_source_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if self.owner.account().owner_id!=expected_owner {return Err(crate::cause!(Error::Refused));}
        let generation=self.owner.original_records_read_generation()?;
        let selected=self.owner.selected_command_domain(input,expected_owner,generation)?;
        self.assert_source_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        Ok((generation,selected.map(|domain|domain.selection().identity())))
    }
    /// Read only the existing logical kinds a provisional local command could
    /// replace or remove. The source, history header and kind observations use
    /// the ordinary own-record reader's one snapshot. No value, field key or
    /// canonical read response leaves this helper, and it grants no rights.
    pub(crate) fn pending_existing_kinds(
        &mut self,
        input: &serde_json::Value,
        ids: &[String],
    ) -> record_writer::Result<std::collections::BTreeMap<String, String>> {
        use record_writer::Error;
        if ids.len() > write_command::MOST_RECORDS || ids.iter().any(String::is_empty) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.assert_source_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let account = self.owner.account().owner_id;
        let generation = self.owner.original_records_read_generation()?;
        let selected = self.owner.selected_command_domain(input, &account, generation)?;
        let (readers, routes, identity) = match selected {
            Some(domain) => (
                domain.readers().map_err(|error| crate::carry_cause!(Error::Source, error))?,
                None,
                Some(domain.selection().identity()),
            ),
            None => {
                let (readers, routes) = self.owner.own_read_context().map_err(|error| crate::carry_cause!(Error::Source, error))?;
                (readers, routes, None)
            }
        };
        let book = self.owner.record_file_check(readers.path().to_owned())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let model = crate::record_model_policy::installed(self.owner.state_root())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        book.assert_same_file().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let (kinds, _) = own_records::read_bound_with_keys(
            &readers,
            &account,
            routes,
            identity.as_ref(),
            &model,
            |view| {
                let mut kinds = std::collections::BTreeMap::new();
                for id in ids {
                    if let Some(stored) = view.stored(id)? {
                        kinds.insert(id.clone(), stored.record_type);
                    }
                }
                Ok::<_, crate::records::Error>(kinds)
            },
        ).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        book.assert_same_file().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if self.owner.original_records_read_generation()? != generation {
            return Err(crate::cause!(Error::Source));
        }
        self.assert_source_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        Ok(kinds)
    }
    /// The account's own record write (`own-record-writes.json`) for a caller the door admitted
    /// (`account::account_routes::Caller`): the same one write the browser's POST /records reaches. Its answer is the
    /// source-free `{changed, write_count}` receipt; a retry with the same request key returns the saved receipt
    /// without a second write. For a run wake started (`cause`), every record the write removes is named to wake right
    /// after it commits (`name_removals`), using only this command's removal sequences. A narrowed tool call keeps its
    /// live run (`run_current`) at the writer's effect and commit checks too.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn door_records_write(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &crate::mcp::Operation,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        ids: &mut dyn LogIds,
        within: Option<&dyn Fn(&str) -> bool>,
        cause: Option<&str>,
        run_current: &dyn Fn() -> bool,
    ) -> record_writer::Result<serde_json::Value> {
        self.door_records_write_at_generation(caller,operation,cancel,deadline,ids,within,cause,run_current,None)
    }
    /// A settled command retains the source generation accepted on its device.
    /// The existing native generation guard carries this same binding through
    /// effects and commit; the HTTP adapter cannot fresh-bind a changed source.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn door_records_write_at_generation(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &crate::mcp::Operation,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        ids: &mut dyn LogIds,
        within: Option<&dyn Fn(&str) -> bool>,
        cause: Option<&str>,
        run_current: &dyn Fn() -> bool,
        expected_generation: Option<i64>,
    ) -> record_writer::Result<serde_json::Value> {
        use record_writer::Error;
        if !write_command::Command::is_shipped(&operation.operation) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.with_door_command(
            caller,
            operation,
            cancel,
            |owner, current, selection, sign_in, request, context, cancel| {
                let binding = owned_records_binding(owner, operation, sign_in, request)?;
                if expected_generation.is_some_and(|expected|binding.generation.as_i64()!=Some(expected)) {return Err(crate::cause!(Error::Conflict));}
                let command = DomainCommand {
                    operation: operation.operation.clone(),
                    input: operation.input.clone(),
                    request_key: operation.request_key.clone(),
                    key_carried: true,
                };
                // The selection stays current through the command; the record write reads no locale.
                let selected = || selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error));
                let mut current = |owner: &mut LocalAccount| {
                    if !run_current() {
                        return Err(crate::cause!(crate::account::AccountError::RightsRefused));
                    }
                    current(owner)?;
                    if !run_current() {
                        return Err(crate::cause!(crate::account::AccountError::RightsRefused));
                    }
                    Ok(())
                };
                let result = owner.execute_selected_records_write_checked(
                    &SelectedRecordsWriteCall {
                        binding: &binding,
                        sign_in,
                        command: &command,
                        request,
                        context,
                        cancel,
                        deadline,
                        within,
                        cause,
                        person_present: operation.person_present.as_ref(),
                    },
                    ids,
                    &selected,
                    &mut current,
                )?;
                if let Some(cause) = cause {
                    name_removals(owner, cause, &result.removals);
                }
                let encoded = ecma_json::stringify(&result.value, Default::default())
                    .map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
                serde_json::from_str(&encoded).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))
            },
        )
    }
}

#[cfg(test)]
mod records_write_controls {
    mod carried_selection {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/carried_selection.rs"
        ));
    }
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mcp_selected_records_write/controls.rs"
    ));
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mcp_selected_records_write/history.rs"
    ));
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mcp_selected_records_write/hook_ingestion.rs"
    ));
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mcp_selected_records_write/concurrent.rs"
    ));
    mod reads_beside_a_writer {
        use super::*;
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/mcp_selected_records_write/reads_beside_a_writer.rs"
        ));
    }
    mod records_result {
        use super::*;
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/mcp_selected_records_write/records_result.rs"
        ));
    }
}
