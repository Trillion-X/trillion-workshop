//! Actual selected native caller for the existing LocalAccount transaction.
//! The retained installed Selection is rechecked inside every producer boundary,
//! rather than inferred from account labels or only checked before forwarding.
use super::SelectedAccount;
use crate::{
    local_account::record_writer::{
        self,
        native_command_context::{NativeCommandCall, NativeCommandResult, NativeTransaction},
    },
    record_log::LogIds,
};

impl SelectedAccount {
    /// Internal selected-owner capability. The actual operation owner supplies
    /// its original parent/input/schema contract; no public route is invented.
    /// Its result contract is the fixed source-free count/boolean batch receipt.
    pub fn native_setting_batch<F>(
        &mut self,
        call: &NativeCommandCall<'_>,
        ids: &mut dyn LogIds,
        effect: F,
    ) -> record_writer::Result<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> record_writer::Result<()>,
    {
        let selection = &self.selection;
        self.owner.execute_native_setting_batch_checked(
            call,
            ids,
            &|| {
                selection
                    .assert_current()
                    .map_err(|error| crate::carry_cause!(record_writer::Error::Source, error))
            },
            effect,
        )
    }
}
