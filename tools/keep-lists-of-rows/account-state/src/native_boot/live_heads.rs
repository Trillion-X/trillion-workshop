//! Keep the protected installed selection current through actual heads output.
//! This extends SelectedAccount; it creates no account, path or transport owner.

use super::SelectedAccount;
use crate::{
    local_account::DeliveryWitness,
    workspace::{WorkspacePermit, WorkspaceSession},
    workspace_heads::{Error, Result, Work},
};
use std::io::{self, Write};
use zeroize::Zeroizing;

pub(crate) struct PreparedHeads {
    pub(crate) bytes: Zeroizing<Vec<u8>>,
    pub(crate) witness: DeliveryWitness,
}
struct Buffer(Zeroizing<Vec<u8>>);
impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .0
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n > 65_536)
        {
            return crate::io_operation!(Err(io::ErrorKind::OutOfMemory.into()));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    // Private preparation only; this is not a physical network flush.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SelectedAccount {
    /// Use the same selected account as WorkspaceSessions. Selection is checked
    /// on every head read and every physical output write/flush, not just before
    /// acquiring the account. The actual WorkspacePermit remains held throughout.
    pub fn workspace_heads_to(
        &mut self,
        session: &WorkspaceSession,
        permit: WorkspacePermit,
        output: &mut impl Write,
    ) -> Result<Work> {
        let selected = &self.selection;
        self.owner
            .workspace_heads_to_checked(session, permit, output, &mut || {
                selected.assert_current().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))
            })
            .map(|(work, _)| work)
    }

    /// The live socket's id reads (native_entry/live.rs `catch_up`, `window`) for `session`: admitted like a read of
    /// the workspace store (the browser session, the account and its record book are current), then read under that
    /// admission. Ids and numbers only.
    pub(crate) fn live_ids<T>(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        deadline: std::time::Instant,
        read: impl FnOnce(&dyn crate::native_entry::live::LiveIds) -> T,
    ) -> std::result::Result<T, crate::workspace_store::Failure> {
        let admission = self.admit_workspace_store(session, permit, deadline)?;
        admission.with_live_ids(read)
    }

    pub(crate) fn prepare_workspace_heads(
        &mut self,
        session: &WorkspaceSession,
        permit: WorkspacePermit,
    ) -> Result<PreparedHeads> {
        let selected = &self.selection;
        let mut buffer = Buffer(Zeroizing::new(Vec::new()));
        let (_, witness) =
            self.owner
                .workspace_heads_to_checked(session, permit, &mut buffer, &mut || {
                    selected.assert_current().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))
                })?;
        Ok(PreparedHeads {
            bytes: buffer.0,
            witness,
        })
    }

    pub(crate) fn workspace_heads_delivery_current(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        witness: &DeliveryWitness,
    ) -> Result<()> {
        let selected = &self.selection;
        self.owner
            .workspace_heads_delivery_current_checked(session, permit, witness, &mut || {
                selected.assert_current().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))
            })
    }
}
