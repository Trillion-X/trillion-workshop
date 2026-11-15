//! Existing SelectedAccount selection stays current around prepared projection
//! reads and the actual first-chunk check. The opaque witness owns its source.
use super::SelectedAccount;
use crate::{
    account::{AccountError, AccountResult},
    local_account::record_delivery::{Delivery, RecordDeliveryWitness, WorkspaceStoreAdmission},
    workspace::{WorkspacePermit, WorkspaceSession},
    workspace_store::{Failure, Kind, Snapshot},
};
use std::time::Instant;
impl SelectedAccount {
    /// Admit one read of the workspace store under the selected account: the selection is current and the owner's
    /// admission is taken (`LocalAccount::admit_workspace_store`). The read holds no owner.
    pub(crate) fn admit_workspace_store(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        deadline: Instant,
    ) -> Result<WorkspaceStoreAdmission, Failure> {
        self.selection.assert_current().map_err(|error| Failure::new(Kind::SourceChanged(error.cause()), Default::default()))?;
        self.owner.admit_workspace_store(session, permit, deadline)
    }
    /// The admission still stands after the read of `snapshot` (the owner's checks, and the selection is still
    /// current); the witness it returns is the delivery's.
    pub(crate) fn finish_workspace_store(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        admission: WorkspaceStoreAdmission,
        snapshot: Snapshot,
        deadline: Instant,
        delivery: Delivery,
    ) -> Result<(Snapshot, RecordDeliveryWitness), Failure> {
        let (snapshot, witness) = self
            .owner
            .finish_workspace_store(session, permit, admission, snapshot, deadline, delivery)?;
        self.selection.assert_current().map_err(|error| Failure::new(Kind::SourceChanged(error.cause()), snapshot.work.clone()))?;
        Ok((snapshot, witness))
    }
    pub(crate) fn workspace_store_delivery_current(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        witness: &RecordDeliveryWitness,
    ) -> AccountResult<()> {
        let selection = &self.selection;
        self.owner
            .workspace_store_delivery_current(session, permit, witness, &|| {
                selection
                    .assert_current()
                    .map_err(|error| AccountError::SourceChanged(error.cause()))
            })
    }
}
