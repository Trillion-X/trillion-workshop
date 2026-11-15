//! Internal events for a synchronous local command share its held transaction.
//! No external dispatch occurs between capture and publication. The private
//! capture is never available to the workspace/external command constructors.
use super::*;

struct SequenceGuard<'a> {
    scope: &'a Scope,
    request: &'a Request,
    records: &'a [OriginalRecord<'a>],
    current: RefCell<&'a mut dyn FnMut() -> bool>,
}
impl Admission for SequenceGuard<'_> {
    fn assert_current(&self, scope: &Scope, request: &Request, _: &str) -> bool {
        scope == self.scope
            && request.key == self.request.key
            && request.sent_at_ms == self.request.sent_at_ms
            && self.current.try_borrow_mut().is_ok_and(|mut f| f())
    }
    fn validate_prepared(
        &self,
        scope: &Scope,
        records: &[RecordInput],
        before: &BTreeMap<String, Option<Projected>>,
    ) -> bool {
        if scope != self.scope || records.len() != 1 || before.len() != 1 {
            return false;
        }
        let actual = &records[0];
        self.records.iter().any(|expected| {
            let Some(value) = expected.value else {
                return false;
            };
            if !before.contains_key(expected.id) || !model_accepts(expected.record_type, value) {
                return false;
            }
            let (Value::Object(value), Some(fields)) = (value, &actual.value) else {
                return false;
            };
            actual.id == expected.id
                && actual.record_type == expected.record_type
                && fields.len() == value.len()
                && value.insertion_entries().all(|(name, v)| {
                    name.to_rust_string()
                        .ok()
                        .and_then(|name| fields.get(&name))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|raw| encode(v).is_ok_and(|encoded| encoded == raw))
                })
        })
    }
}
impl NativeTransaction<'_, '_, '_> {
    pub(super) fn stage_internal_execution(&mut self, initial: &Value) -> Result<()> {
        self.current()?;
        if self.state.external.pending_local_execution.is_some() {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        let id = &self.state.external.execution_ref;
        if !self.state.external.fresh(self.db, id)? || !model_accepts("execution", initial) {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        self.state.external.pending_local_execution = Some(Zeroizing::new(encode(initial)?));
        self.current()
    }
    pub(super) fn publish_internal_completion(
        &mut self,
        result_id: &str,
        sealed_result: &Value,
        result_key: &OriginalKey,
        terminal: &Value,
    ) -> Result<()> {
        self.current()?;
        // Take before writing: completion must read the persisted canonical
        // values. An error here is covered by the enclosing transaction rollback.
        // The terminal state was made from this capture (`NativeContext::execution`).
        self.state.external.pending_local_execution.take().ok_or(crate::cause!(Error::OutcomeUnknown))?;
        let execution_id = self.state.external.execution_ref.clone();
        let mut before = BTreeMap::new();
        for id in [execution_id.as_str(), result_id] {
            if !self.state.external.fresh(self.db, id)? {
                return Err(crate::cause!(Error::OutcomeUnknown));
            }
            before.insert(id.to_owned(), None);
        }
        // The initial execution state was never visible outside this transaction (`begin_local_atomic`), so only its
        // terminal state is written: one version, not a create and a replace in the same commit.
        let records = [
            OriginalRecord {
                id: result_id,
                record_type: "resource-command-result",
                value: Some(sealed_result),
            },
            OriginalRecord {
                id: &execution_id,
                record_type: "execution",
                value: Some(terminal),
            },
        ];
        let mut check = || self.state.assert_current(self.db, self.binding).is_ok();
        let guard = SequenceGuard {
            scope: self.scope,
            request: self.request,
            records: &records,
            current: RefCell::new(&mut check),
        };
        let mut plan = original_setting::plan_original_records(
            self.scope,
            &records,
            &before,
            self.request,
            self.context,
            &guard,
            self.ids,
        )
        .map_err(record_error)?;
        plan.attach_original_keys(&[(result_id, result_key)])
            .map_err(record_error)?;
        self.write_plan(&plan, &BTreeMap::from([
            (execution_id.clone(), false), (result_id.to_owned(), false),
        ]))
    }
}
