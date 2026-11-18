//! The existing hook door's protected source producer. Its journal checks keep
//! the selected account, original sign-in and exact source occurrence current.
use super::*;
use crate::{
    account::NativeAccountOwner,
    local_account::{
        command_journal::CommandBinding,
        record_writer::{self, native_command_context::host_observations},
    },
    record_log::{Context, LogIds, Request},
    workspace_domain::DomainCommand,
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};
impl SelectedAccount {
    pub(crate) fn door_hook_receipts(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        operation: &Operation,
        proofs: &[crate::account::hooks::executions::Verified],
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        ids: &mut dyn LogIds,
    ) -> record_writer::Result<()> {
        use record_writer::Error;
        let hooks = crate::account::hooks::HookRoutes::shipped().map_err(|error| Error::Source(error.cause()))?;
        if !hooks.answers(&operation.resource, &operation.operation)
            || operation.request_key.is_empty()
            || operation.request_key.encode_utf16().count() > 512
        {
            return Err(crate::cause!(Error::Invalid));
        }
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
        let sign_in = &caller.principal.sign_in;
        let original = original_command_ids_at_resource(
            &caller.principal.account_id,
            sign_in,
            &operation.resource,
            operation,
        )
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let input = ecma_json::parse(
            &serde_json::to_vec(&operation.input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            Default::default(),
        )
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let binding = CommandBinding {
            permit_id: original.permit_id,
            identity: own_record_write_identity(&operation.operation, &input, &request.key)
                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            owner: caller.principal.account_id.clone(),
            resource: operation.resource.clone(),
            generation: serde_json::json!(self.owner.original_workspace_generation()?),
            operation: operation.operation.clone(),
            request_key: request.key.clone(),
            input_identity: original.input_identity,
        };
        let command = DomainCommand {
            operation: operation.operation.clone(),
            input: operation.input.clone(),
            request_key: operation.request_key.clone(),
            key_carried: true,
        };
        let selection = &self.selection;
        let selected = || selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error));
        let mut current = |_: &mut crate::local_account::LocalAccount| {
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            if !caller.stands() {
                return Err(crate::cause!(AccountError::RightsRefused));
            }
            Ok(())
        };
        self.owner.keep_verified_host_observations(
            &host_observations::Call {
                binding: &binding,
                sign_in,
                command: &command,
                request: &request,
                context: &context,
                cancel,
                deadline,
            },
            proofs,
            ids,
            &selected,
            &mut current,
        )?;
        Ok(())
    }
}
