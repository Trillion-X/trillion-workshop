//! Ordinary-browser producer for the SAME selected original workspace writer.
//! The window's admission comes only from account::current_browser (its sign-in
//! session row). No personal key, fabricated browser session, human attestation,
//! route grant or alternate store is used. The retained binding also owns final
//! HTTP recovery: it cannot be rebuilt once the window's session row is gone.
use super::{
    SelectedAccount, mcp_selected_personal::{original_command_ids_at_resource, own_record_write_identity},
    mcp_workspace_write::original_binding, tool_screens::ToolLabelLocale,
};
use crate::{
    account::{self, AccountError, BrowserAdmission, NativeAccountOwner},
    ecma_json,
    local_account::{
        LocalAccount,
        command_journal::CommandBinding,
        record_writer::{
            self,
            native_command_context::{NativeCommandCall, NativeCommandResult, SelectedWorkspaceWriteCall},
        },
    },
    mcp::Operation,
    record_log::{Context, LogIds, Request},
    record_write_model::write_command,
    tool_label_locale::QualifiedLocale,
    workspace::WorkspaceSession,
    workspace_domain::DomainCommand,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

/// Private source/admission witness; request JSON cannot construct this value.
pub(crate) struct BrowserWorkspaceWrite {
    session: Arc<WorkspaceSession>,
    admitted: BrowserAdmission,
    /// The window's sign-in name (`session:` and its session id), the one the window's own writes name.
    sign_in: String,
    binding: CommandBinding,
    input: ecma_json::Value,
    command: DomainCommand,
    request: Request,
    context: Context,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    /// The qualified tool-label locale a locale-ordered command (the workspace write) runs with; None for
    /// the account's own record write, whose request identity reads no locale (`own_record_write_identity`).
    locale: Option<Arc<QualifiedLocale>>,
    /// What the page's records write carried to confirm the person present (`workspace_domain::PERSON_PRESENT_HEADER`,
    /// `account::person_present`), none when it carried nothing. It is not part of the request's identity: the
    /// write the person confirmed is the same command as the one refused, under the same request key.
    person_present: Option<serde_json::Value>,
}
impl BrowserWorkspaceWrite {
    /// The locale this command was prepared with; a command prepared without one cannot run a locale-ordered effect.
    fn locale(&self) -> record_writer::Result<&Arc<QualifiedLocale>> {
        self.locale.as_ref().ok_or(crate::cause!(record_writer::Error::Source))
    }
}
impl BrowserWorkspaceWrite {
    pub(crate) fn expired(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline
    }
}
fn same_browser(
    admitted: &BrowserAdmission,
    session: &WorkspaceSession,
) -> Result<(), AccountError> {
    if admitted.account.user_id != session.account_id || !admitted.still() {
        return Err(crate::cause!(AccountError::BrowserInactive));
    }
    Ok(())
}
fn browser_sign_in(session_id: &str) -> String {
    format!("session:{session_id}")
}
impl SelectedAccount {
    pub(crate) fn prepare_browser_workspace_write(
        &mut self, session: Arc<WorkspaceSession>, command: &DomainCommand,
        cancel: Arc<AtomicBool>, deadline: Instant,
    ) -> record_writer::Result<BrowserWorkspaceWrite> {
        if command.operation != "workspace:write" { return Err(crate::cause!(record_writer::Error::Invalid)); }
        self.prepare_browser_original_command(session, command, cancel, deadline)
    }
    /// The account's own record write (POST /records { records }); its
    /// operation name and schema are product DATA (own-record-writes.json). `person_present` is what the page
    /// carried to confirm the person present (`workspace_domain::PERSON_PRESENT_HEADER`), none when nothing.
    pub(crate) fn prepare_browser_records_write(
        &mut self, session: Arc<WorkspaceSession>, command: &DomainCommand,
        cancel: Arc<AtomicBool>, deadline: Instant, person_present: Option<serde_json::Value>,
    ) -> record_writer::Result<BrowserWorkspaceWrite> {
        if !write_command::Command::is_shipped(&command.operation) { return Err(crate::cause!(record_writer::Error::Invalid)); }
        let mut prepared = self.prepare_browser_original_command(session, command, cancel, deadline)?;
        prepared.person_present = person_present;
        Ok(prepared)
    }

    /// What the last refused record write named to its caller (a value outside its field's choices, or what the
    /// person present must confirm), taken once (`LocalAccount::take_write_refusal`).
    pub(crate) fn take_browser_write_refusal(&mut self) -> Option<record_writer::Named> {
        self.owner.take_write_refusal()
    }

    fn prepare_browser_original_command(
        &mut self,
        session: Arc<WorkspaceSession>,
        command: &DomainCommand,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> record_writer::Result<BrowserWorkspaceWrite> {
        use record_writer::Error;
        if command.operation.is_empty()
            || command.request_key.is_empty()
            || command.request_key.encode_utf16().count() > 512
            || cancel.load(Ordering::Acquire)
            || Instant::now() >= deadline
        {
            return Err(crate::cause!(Error::Invalid));
        }
        self.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let admitted = account::current_browser(&mut self.owner, &session.session_id)
            .map_err(|error| {
                crate::quiet_eprintln!("record-writer event=refused reason=browser-prepare-admission cause={}", error.cause());
                crate::carry_cause!(Error::Refused, error)
            })?;
        same_browser(&admitted, &session).map_err(|error| {
            crate::quiet_eprintln!("record-writer event=refused reason=browser-prepare-current cause={}", error.cause());
            crate::carry_cause!(Error::Refused, error)
        })?;
        let sign_in = browser_sign_in(&session.session_id);
        // The account's own record write binds its request without the tool-label locale; every other command here
        // is locale-ordered and runs only with the selection's qualified locale.
        let records = write_command::Command::is_shipped(&command.operation);
        let locale = if records {
            None
        } else {
            let locale = self
                .selection
                .selected_tool_label_locale()
                .map_err(|error| crate::carry_cause!(Error::Source, error))?
                .ok_or(crate::cause!(Error::Source))?;
            locale.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            Some(locale)
        };
        let operation = Operation { person_present: None,
            resource: "@own-records".into(),
            operation: command.operation.clone(),
            input: command.input.clone(),
            request_key: command.request_key.clone(),
        };
        let original = original_command_ids_at_resource(
            &admitted.account.owner_id,
            &sign_in,
            "@own-records",
            &operation,
        )
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let bytes = serde_json::to_vec(&command.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let input = ecma_json::parse(&bytes, Default::default()).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let identity = match &locale {
            None => own_record_write_identity(&command.operation, &input, &command.request_key)
                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            Some(locale) => original_binding(&command.operation, input.clone(), &command.request_key, &mut |a, b| {
                locale.compare(a, b)
            })
            .map_err(|error| crate::carry_cause!(Error::Source, error))?,
        };
        let generation = self.owner.original_workspace_generation().map_err(|error| {
            crate::quiet_eprintln!("record-writer event=refused reason=browser-prepare-generation cause={}", error.cause());
            error
        })?;
        let now = i64::try_from(self.owner.now_ms().map_err(|error| crate::carry_cause!(Error::Source, error))?)
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
            .ok_or(crate::cause!(Error::Source))?
            .to_rfc3339();
        Ok(BrowserWorkspaceWrite {
            binding: CommandBinding {
                permit_id: original.permit_id,
                identity,
                owner: admitted.account.owner_id.clone(),
                resource: "@own-records".into(),
                generation: serde_json::Value::from(generation),
                operation: command.operation.clone(),
                request_key: command.request_key.clone(),
                input_identity: original.input_identity,
            },
            session,
            admitted,
            sign_in,
            input,
            command: command.clone(),
            request: Request {
                key: command.request_key.clone(),
                sent_at_ms: now,
            },
            context: Context {
                actor: serde_json::Value::Null,
                application_time: at.clone(),
                system_time: at,
                accepted_at_ms: now,
            },
            cancel,
            deadline,
            locale,
            person_present: None,
        })
    }

    /// `recover_only` must refuse a missing/noncommitted original command. It
    /// may never dispatch the effect after initial success or result erasure.
    pub(crate) fn execute_browser_workspace_write(
        &mut self,
        witness: &BrowserWorkspaceWrite,
        recover_only: bool,
        ids: &mut dyn LogIds,
    ) -> record_writer::Result<NativeCommandResult> {
        use record_writer::Error;
        if witness.expired() {
            return Err(crate::cause!(Error::Refused));
        }
        let selection = &self.selection;
        let selected = || {
            selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            match &witness.locale {
                Some(locale) => locale.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error)),
                None => Ok(()),
            }
        };
        let mut current = |owner: &mut LocalAccount| {
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            let admitted = account::current_browser_read_only(owner, &witness.session.session_id)?;
            same_browser(&admitted, &witness.session)?;
            if admitted.account != witness.admitted.account
                || !witness.admitted.still()
                || browser_sign_in(&witness.session.session_id) != witness.sign_in
            {
                return Err(crate::cause!(AccountError::RightsChanging));
            }
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
        };
        if write_command::Command::is_shipped(&witness.command.operation) {
            current(&mut self.owner).map_err(|error| {
                crate::quiet_eprintln!("record-writer event=refused reason=browser-command-current cause={}", error.cause());
                crate::carry_cause!(Error::Refused, error)
            })?;
            let shipped = write_command::Command::shipped().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let call = NativeCommandCall {
                session: &witness.session, cancel: witness.cancel.clone(), command: &witness.command,
                input_schema: shipped.input_schema(), permit_id: &witness.binding.permit_id,
                original_identity: &witness.binding.identity, request: &witness.request,
                log_context: &witness.context, deadline: witness.deadline,
            };
            let resource_generation = witness.binding.generation.as_i64().ok_or(crate::cause!(Error::Refused))?;
            // The page's POST /records carries its confirmation by the person present in PERSON_PRESENT_HEADER; the
            // one records-write authority checks it, and a write that needs one it does not confirm is refused there
            // naming what to confirm, as on every other door.
            return self.owner.execute_native_records_write_checked(&call, resource_generation, ids, &selected, recover_only,
                witness.person_present.as_ref());
        }
        let locale = witness.locale()?;
        let call = SelectedWorkspaceWriteCall {
            binding: &witness.binding,
            sign_in: &witness.sign_in,
            input: &witness.input,
            request: &witness.request,
            context: &witness.context,
            cancel: witness.cancel.clone(),
            deadline: witness.deadline,
        };
        if recover_only {
            self.owner.recover_selected_workspace_write_checked(
                &call,
                ids,
                &selected,
                &mut current,
                &mut |a, b| locale.compare(a, b).map_err(|_| ()),
            )
        } else {
            self.owner.execute_selected_workspace_write_checked(
                &call,
                ids,
                &selected,
                &mut current,
                &mut |a, b| locale.compare(a, b).map_err(|_| ()),
            )
        }
    }
}
