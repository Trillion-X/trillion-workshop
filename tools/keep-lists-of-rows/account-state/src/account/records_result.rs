//! Read-only reconciliation of an original own-record command. The existing
//! command journal, protected result and selected command owner retain custody;
//! this producer cannot dispatch an effect or substitute the delivery key.
use super::workspace_write::owned_records_binding_using_generation;
use crate::{
    ecma_json,
    local_account::record_writer::{
        self,
        native_command_context::{OriginalRecordsResultReadProof, SelectedOwnRecordsRecoveryCall},
    },
    local_account::LocalAccount,
    native_boot::SelectedAccount,
    record_log::LogIds,
    workspace_domain::DomainCommand,
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

impl SelectedAccount {
    pub(crate) fn door_records_result(
        &mut self,
        caller: &crate::account::account_routes::Caller,
        original: &crate::mcp::Operation,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        ids: &mut dyn LogIds,
        within: Option<&dyn Fn(&str) -> bool>,
    ) -> record_writer::Result<(serde_json::Value, OriginalRecordsResultReadProof)> {
        use record_writer::Error;
        if !crate::record_write_model::write_command::Command::is_shipped(&original.operation) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.with_door_command(
            caller,
            original,
            cancel,
            |owner, current, selection, sign_in, request, context, cancel| {
                let binding = owned_records_binding_using_generation(
                    owner,
                    original,
                    sign_in,
                    request,
                    LocalAccount::original_records_read_generation,
                )?;
                let command = DomainCommand {
                    operation: original.operation.clone(),
                    input: original.input.clone(),
                    request_key: original.request_key.clone(),
                    key_carried: true,
                };
                let selected = || selection.assert_current().map_err(|error| crate::carry_cause!(Error::Source, error));
                let (result, proof) = owner
                    .recover_selected_own_records_result_with_proof_checked(
                        &SelectedOwnRecordsRecoveryCall {
                            binding: &binding,
                            sign_in,
                            command: &command,
                            request,
                            context,
                            cancel,
                            deadline,
                            within,
                        },
                        ids,
                        &selected,
                        current,
                    )?;
                if !result.duplicate {
                    return Err(crate::cause!(Error::OutcomeUnknown));
                }
                let encoded = ecma_json::stringify(&result.value, Default::default())
                    .map_err(|error| crate::carry_cause!(Error::ProtectedResultUnavailable, error))?;
                let value = serde_json::from_str(&encoded)
                    .map_err(|error| crate::carry_cause!(Error::ProtectedResultUnavailable, error))?;
                Ok((value, proof))
            },
        )
    }
}
