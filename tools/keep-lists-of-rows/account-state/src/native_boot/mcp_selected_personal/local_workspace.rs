//! Same-process MCP writes, admitted by the door's own sign-in on every check.
//! They require no connection registration, fabricated route or signer.
use crate::{
    account::{AccountError, AccountResult, NativeAccountOwner},
    local_account::{
        record_writer::{self, native_command_context::WORKSPACE_WRITE},
        LocalAccount,
    },
    mcp::Operation,
    native_boot::SelectedAccount,
    record_log::{Context, Request},
    record_write_model::write_command,
};
use std::sync::{atomic::AtomicBool, Arc};

#[cfg(test)]
use super::workspace_write::execute_owned_workspace_write;
#[cfg(test)]
use crate::{
    local_account::record_writer::native_command_context::NativeCommandResult, record_log::LogIds,
};
#[cfg(test)]
use std::time::Instant;

impl SelectedAccount {
    #[cfg(test)]
    pub(crate) fn execute_personal_local_workspace_write(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &Operation,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        ids: &mut dyn LogIds,
    ) -> record_writer::Result<NativeCommandResult> {
        self.with_door_write(
            caller,
            operation,
            cancel,
            |owner, current, selection, sign_in, locale, request, context, cancel| {
                execute_owned_workspace_write(
                    owner, current, selection, operation, sign_in, locale, request, context,
                    cancel, deadline, ids,
                )
            },
        )
    }

    /// The workspace write (`workspace:write`) at the door for `caller`: its original result identity is the
    /// locale-ordered canonical, so it runs only with the selection's qualified tool-label locale, and a selection
    /// without one refuses it. The caller is admitted first (`with_door_command`), so an unadmitted caller is refused
    /// before the locale is read.
    pub(super) fn with_door_write<T>(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &Operation,
        cancel: Arc<AtomicBool>,
        perform: impl FnOnce(
            &mut LocalAccount,
            &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
            &crate::native_boot::Chosen,
            &str,
            &Arc<crate::tool_label_locale::QualifiedLocale>,
            &Request,
            &Context,
            Arc<AtomicBool>,
        ) -> record_writer::Result<T>,
    ) -> record_writer::Result<T> {
        use record_writer::Error;
        if operation.operation != WORKSPACE_WRITE {
            return Err(crate::cause!(Error::Invalid));
        }
        self.with_door_command(
            caller,
            operation,
            cancel,
            |owner, current, selection, sign_in, request, context, cancel| {
                let locale = selection
                    .selected_tool_label_locale()
                    .map_err(|error| crate::carry_cause!(Error::Source, error))?
                    .ok_or(crate::cause!(Error::Source))?;
                perform(
                    owner, current, selection, sign_in, &locale, request, context, cancel,
                )
            },
        )
    }

    /// One own-record command at the door for `caller` (`workspace:write` or the account's own record write,
    /// `own-record-writes.json`), admitted by the door's own sign-in (`account::account_routes::Caller`): the call is checked,
    /// the caller's admission is checked before the command, at every effect and commit check the writer keeps
    /// (`current`) and nowhere else consulted. `perform` runs under one hold of the account. Nothing here reads the
    /// tool-label locale: the generic record write binds its request without one (`own_record_write_identity`), and
    /// the workspace write takes it first (`with_door_write`).
    pub(super) fn with_door_command<T>(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &Operation,
        cancel: Arc<AtomicBool>,
        perform: impl FnOnce(
            &mut LocalAccount,
            &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
            &crate::native_boot::Chosen,
            &str,
            &Request,
            &Context,
            Arc<AtomicBool>,
        ) -> record_writer::Result<T>,
    ) -> record_writer::Result<T> {
        use record_writer::Error;
        if operation.resource != "@own-records"
            || (operation.operation != WORKSPACE_WRITE
                && !write_command::Command::is_shipped(&operation.operation))
            || operation.request_key.is_empty()
            || operation.request_key.encode_utf16().count() > 512
        {
            return Err(crate::cause!(Error::Invalid));
        }
        // One request under one hold of the account: the account witness is checked in full once and carried; the
        // command's transaction boundaries still check it in full (`LocalAccount::carry_witness`).
        let _carried = self.owner.carry_witness();
        if self.owner.account().owner_id != caller.principal.account_id || !caller.stands() {
            return Err(crate::cause!(Error::Refused));
        }
        let now =
            i64::try_from(self.now_ms().map_err(|error| crate::carry_cause!(Error::Source, error))?).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
            .ok_or(crate::cause!(Error::Source))?
            .to_rfc3339();
        let request = Request {
            key: operation.request_key.clone(),
            sent_at_ms: now,
        };
        let context = Context {
            actor: serde_json::Value::Null,
            application_time: at.clone(),
            system_time: at,
            accepted_at_ms: now,
        };
        let selection = &self.selection;
        let sign_in = caller.principal.sign_in.clone();
        let mut current = |_: &mut LocalAccount| {
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            if !caller.stands() {
                return Err(crate::cause!(AccountError::RightsRefused));
            }
            Ok(())
        };
        current(&mut self.owner).map_err(|error| crate::carry_cause!(Error::Refused, error))?;
        perform(
            &mut self.owner,
            &mut current,
            selection,
            &sign_in,
            &request,
            &context,
            cancel,
        )
    }
}
