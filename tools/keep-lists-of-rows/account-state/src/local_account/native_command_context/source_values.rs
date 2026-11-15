//! Canonical stored/key/value composition on the native parent's SAME source.
//! This extends NativeTransaction; no second source, decoder, key owner or
//! authority wrapper is introduced. The public result engine still must supply
//! exact installed recipes and preserve its complete output dependency graph.
use super::*;

impl<'db, 's, 'c> NativeTransaction<'db, 's, 'c> {
    /// Keep provisional source words inside one synchronous action, then
    /// require fresh actual browser/source checks before returning its answer.
    /// Records and keys both come from the account's own records (record store) on this
    /// command's held transaction, so this command's earlier writes are seen.
    pub(super) fn with_current_values<T>(
        &mut self,
        action: impl FnOnce(&mut InCommand<'db>) -> Result<T>,
    ) -> Result<T> {
        self.current()?;
        let mut records = self.state.external.records(self.db)?;
        let answer = action(&mut records);
        self.current()?;
        answer
    }
}
