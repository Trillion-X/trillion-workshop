//! Selected-command join of the `workspace:write` effect: the effect and its
//! output source check run on the workspace store lent from this command's
//! own transaction.
use super::{
    journal, journal_error, object, workspace_write as contract, workspace_write_output as output,
    workspace_write_sql as sql, CommandJournal, NativeTransaction,
};
use crate::{
    ecma_json::{JsString, Value},
    storage::sqlite::Access,
    workspace_store::Workspace,
    record_canonical,
    record_log::original_setting::OriginalKey,
    record_value::KeyState,
};
use ring::rand::{SecureRandom, SystemRandom};
use std::cmp::Ordering;
use zeroize::Zeroizing;

/// Provisional effect with its output witness: a count reply keeps its receipt,
/// a conflict/address reply is withheld once the workspace store moves.
pub(crate) struct PendingWorkspaceWrite {
    effect: sql::Effect,
    witness: output::Witness,
    action: contract::Action,
}
impl PendingWorkspaceWrite {
    pub(crate) fn result(&self) -> &Value {
        &self.effect.result
    }
    pub(crate) fn witness_value(&self) -> Value {
        self.witness.value()
    }
}

/// Provisional sealed original result; only the same local transaction may
/// publish it with its execution transitions. The key remains owned/zeroizing.
pub(crate) struct PreparedWorkspaceResult {
    pub(crate) identity: String,
    pub(crate) id: String,
    pub(crate) record: Value,
    pub(crate) key: OriginalKey,
}

impl<'db, 's, 'c> NativeTransaction<'db, 's, 'c> {
    /// Only a journal Fresh dispatch may call this method. The parent still
    /// captures the exact returned result, finalizes execution and completes
    /// the existing command on this same handle before committing.
    pub(crate) fn workspace_write_effect(
        &mut self,
        journal: &mut CommandJournal<'db>,
        original_input: &Value,
        now_ms: i64,
        at: &str,
        origin: &sql::WriteOrigin<'_>,
    ) -> super::Result<PendingWorkspaceWrite> {
        let answer = (|| {
            self.current()?;
            if self.binding.operation != contract::OPERATION {
                return Err(crate::cause!(super::Error::Refused));
            }
            if origin.permit_id != Some(self.binding.permit_id.as_str())
                || origin.road != Some(self.state.external.writer_road)
                || origin.author != Some(self.state.external.reader.as_str())
            {
                return Err(crate::cause!(super::Error::Refused));
            }
            journal.assert_local_fresh(self.state).map_err(journal_error)?;
            let action =
                contract::parse_input(original_input).map_err(|error| crate::carry_cause!(super::Error::Invalid, error))?;
            self.current()?;
            // The workspace store on this same IMMEDIATE transaction: each
            // change commits or rolls back with the command.
            let mut workspace = Workspace::lend(self.db, &self.binding.owner, Access::Write)
                .map_err(|error| super::Error::Source(error.cause()))?;
            let answer = sql::execute_with_origin(
                &mut sql::Target::new(&mut workspace, &self.binding.permit_id),
                &action,
                now_ms,
                at,
            )
            .map_err(|error| match error {
                    sql::Error::Invalid(cause) => super::Error::Invalid(cause),
                    sql::Error::Bounds(cause) => super::Error::Bounds(cause),
                    sql::Error::Changed(cause) => super::Error::Conflict(cause),
                    sql::Error::Source(cause) => super::Error::Source(cause),
                })?;
            drop(workspace);
            if !contract::result_matches(&action, &answer.result) {
                return Err(crate::cause!(super::Error::Source));
            }
            self.current()?;
            let witness = output::capture(self.db, &self.binding.owner, &action, &answer.result)
                .map_err(|error| crate::carry_cause!(super::Error::Source, error))?;
            self.current()?;
            journal.assert_local_fresh(self.state).map_err(journal_error)?;
            Ok(PendingWorkspaceWrite {
                effect: answer,
                witness,
                action,
            })
        })();
        if answer.is_err() {
            self.poisoned = true;
        }
        answer
    }

    /// The protected completion must use decision-store's canonical identity,
    /// never the workspace value identity. The supplied comparator must be the
    /// current original locale owner; no lexical fallback is admitted.
    pub(crate) fn workspace_write_result_identity<F, E>(
        &mut self,
        result: &Value,
        compare: &mut F,
    ) -> super::Result<String>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
    {
        self.current()?;
        let identity = record_canonical::identity(result, Default::default(), compare)
            .map_err(|error| crate::carry_cause!(super::Error::Source, error))?;
        self.current()?;
        Ok(identity)
    }

    /// Keep the exact result, source witness and canonical identity under the
    /// existing original protected-result key. No plaintext result column,
    /// synthetic donor, second receipt or key remint is admitted.
    pub(crate) fn prepare_workspace_write_result<F, E>(
        &mut self,
        pending: &PendingWorkspaceWrite,
        compare: &mut F,
    ) -> super::Result<PreparedWorkspaceResult>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
    {
        let answer = self.prepare_workspace_write_result_inner(pending, compare);
        if answer.is_err() {
            self.poisoned = true;
        }
        answer
    }
    fn prepare_workspace_write_result_inner<F, E>(
        &mut self,
        pending: &PendingWorkspaceWrite,
        compare: &mut F,
    ) -> super::Result<PreparedWorkspaceResult>
    where
        F: FnMut(&JsString, &JsString) -> std::result::Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
    {
        self.current()?;
        output::verify(self.db, &self.binding.owner, &pending.action, pending.result(), &pending.witness)
            .map_err(|error| crate::carry_cause!(super::Error::Refused, error))?;
        let id = format!("resource-command-result:{}", self.binding.permit_id);
        if self.state.external.projection(self.db, &id)?.0.is_some()
            || !matches!(
                self.state.external.key_state(self.db, &id)?,
                KeyState::Missing
            )
        {
            return Err(crate::cause!(super::Error::OutcomeUnknown));
        }
        let identity = self.workspace_write_result_identity(pending.result(), compare)?;
        let mut bytes = Zeroizing::new([0u8; 32]);
        SystemRandom::new()
            .fill(bytes.as_mut())
            .map_err(|error| crate::carry_cause!(super::Error::Source, error))?;
        let key = OriginalKey::from_bytes(bytes);
        let opened = object([
            ("result", pending.result().clone()),
            ("workspace_output", pending.witness_value()),
            ("result_identity", Value::String(identity.as_str().into())),
        ]);
        let sealed = key
            .seal(&id, &JsString::from("value"), &opened)
            .map_err(super::record_error)?;
        self.current()?;
        output::verify(self.db, &self.binding.owner, &pending.action, pending.result(), &pending.witness)
            .map_err(|error| crate::carry_cause!(super::Error::Refused, error))?;
        Ok(PreparedWorkspaceResult {
            identity,
            id,
            record: object([("value", sealed)]),
            key,
        })
    }

    /// Completes only through the existing protected-result verifier. The
    /// native parent must first append the exact sealed result, witness and
    /// original identity; the current fixed-result parent refuses until then.
    pub(crate) fn complete_workspace_write(
        &mut self,
        journal: &mut CommandJournal<'db>,
        pending: &PendingWorkspaceWrite,
        receipt: &journal::Completion,
        expected_identity: &str,
    ) -> super::Result<()> {
        let answer =
            self.complete_workspace_write_inner(journal, pending, receipt, expected_identity);
        if answer.is_err() {
            self.poisoned = true;
        }
        answer
    }
    fn complete_workspace_write_inner(
        &mut self,
        journal: &mut CommandJournal<'db>,
        pending: &PendingWorkspaceWrite,
        receipt: &journal::Completion,
        expected_identity: &str,
    ) -> super::Result<()> {
        self.current()?;
        if self.binding.operation != contract::OPERATION
            || receipt.result_identity != expected_identity
        {
            return Err(crate::cause!(super::Error::Conflict));
        }
        output::verify(self.db, &self.binding.owner, &pending.action, pending.result(), &pending.witness)
            .map_err(|error| crate::carry_cause!(super::Error::Refused, error))?;
        journal
            .complete(receipt, self.state)
            .map_err(journal_error)?;
        self.current()
    }
}
