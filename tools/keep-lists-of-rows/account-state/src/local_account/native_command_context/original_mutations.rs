//! Canonical original-record writes on the retained native transaction. Logical
//! observations, live model checks and current key custody precede the existing
//! ordered planner and the record store write; neither raw input nor a boolean is write admission.
use super::*;
use crate::{
    account::person_present,
    record_value::{self},
    record_write_model::{self, write_command, Model},
};

/// One record as it is now on the held transaction (it was `catch_up::Record` until the catch-up copy left the engine).
#[derive(Clone, PartialEq)]
pub(crate) struct Record {
    pub kind: Option<JsString>,
    pub value: Value,
    /// Opaque current identity from the source owner, never constructed here.
    pub identity: JsString,
}
impl std::fmt::Debug for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Record([redacted])")
    }
}
/// One ordered change of a record write: a value, or None to remove.
#[derive(Clone)]
pub(crate) struct Write {
    pub id: JsString,
    pub kind: JsString,
    pub value: Option<Value>,
}
use std::collections::BTreeMap;

struct Prepared {
    id: String,
    kind: String,
    value: Option<Value>,
}
struct Guard<'a> {
    scope: &'a Scope,
    request: &'a Request,
    before: &'a BTreeMap<String, Option<Projected>>,
    records: &'a [Prepared],
    check: RefCell<&'a mut dyn FnMut() -> bool>,
}
impl Admission for Guard<'_> {
    fn assert_current(&self, scope: &Scope, request: &Request, _: &str) -> bool {
        scope == self.scope
            && request.key == self.request.key
            && request.sent_at_ms == self.request.sent_at_ms
            && self.check.try_borrow_mut().is_ok_and(|mut check| check())
    }
    fn validate_prepared(
        &self,
        scope: &Scope,
        records: &[RecordInput],
        before: &BTreeMap<String, Option<Projected>>,
    ) -> bool {
        // The canonical ordered owner admits each emitted transition with its
        // own exact before map, not the entire outer batch at every event.
        if scope != self.scope || records.len() != 1 || before.len() != 1 {
            return false;
        }
        records.iter().all(|raw| {
            let mut matching = self.records.iter().filter(|prepared| prepared.id == raw.id);
            let Some(prepared) = matching.next() else {
                return false;
            };
            if matching.next().is_some()
                || before.get(&raw.id) != self.before.get(&raw.id)
                || raw.record_type != prepared.kind
            {
                return false;
            }
            match (&raw.value, &prepared.value) {
                (None, None) => true,
                (Some(raw), Some(Value::Object(value))) => {
                    raw.len() == value.len()
                        && value.property_entries().into_iter().all(|(key, value)| {
                            key.to_rust_string()
                                .ok()
                                .and_then(|key| raw.get(&key))
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|actual| {
                                    encode(value).is_ok_and(|expected| expected == actual)
                                })
                        })
                }
                _ => false,
            }
        })
    }
}
fn member<'a>(value: &'a Value, path: &[JsString]) -> Option<&'a Value> {
    let mut current = value;
    for part in path {
        let Value::Object(o) = current else {
            return None;
        };
        current = o.get(part)?;
    }
    Some(current)
}
fn replace(value: &mut Value, path: &[JsString], desired: Value) -> Result<()> {
    let Some((head, tail)) = path.split_first() else {
        return Err(crate::cause!(Error::Invalid));
    };
    let Value::Object(object) = value else {
        return Err(crate::cause!(Error::Invalid));
    };
    let Some(current) = object.get(head).cloned() else {
        return Ok(());
    };
    if tail.is_empty() {
        object.insert(head.clone(), desired);
    } else {
        let mut next = current;
        replace(&mut next, tail, desired)?;
        object.insert(head.clone(), next);
    }
    Ok(())
}
fn field_name(path: &[JsString]) -> JsString {
    let mut units = Vec::new();
    for (i, part) in path.iter().enumerate() {
        if i > 0 {
            units.push(b'.' as u16)
        }
        units.extend_from_slice(part.units());
    }
    JsString::from_units(units)
}
fn logical(
    values: &mut impl record_value::Supply,
    id: &str,
    policy: &record_value::OpenPolicy,
) -> Result<Option<Record>> {
    record_value::read(id, values, policy, Default::default())
        .map_err(|error| crate::carry_cause!(Error::Source, error))
        .map(|row| {
            row.map(|row| Record {
                kind: Some(row.record_type().into()),
                identity: row.root_identity().unwrap_or_default().into(),
                value: row.into_value(),
            })
        })
}
/// The kind the write expected and the field names that differ from the stored record: names only, never a value.
fn conflict_fields(expected: &write_command::Expected, observed: Option<&Record>) -> String {
    let (kind, value) = match expected {
        write_command::Expected::Present { kind, value } | write_command::Expected::PresentIdentity { kind, value, .. } => (kind, value),
        _ => return "expected=absent-or-identity".to_string(),
    };
    let kind = kind.to_rust_string().unwrap_or_default();
    let Some(record) = observed else { return format!("kind={kind} stored=absent") };
    let (Value::Object(want), Value::Object(have)) = (value, &record.value) else { return format!("kind={kind} stored=not-an-object") };
    let mut names = Vec::new();
    for (key, want_value) in want.insertion_entries() {
        if have.get(key).map_or(true, |have_value| have_value != want_value) {
            names.push(key.to_rust_string().unwrap_or_default());
        }
    }
    for (key, _) in have.insertion_entries() {
        if want.get(key).is_none() {
            names.push(key.to_rust_string().unwrap_or_default());
        }
    }
    format!("kind={kind} fields={}", names.join(","))
}

fn expected_matches(expected: &write_command::Expected, observed: Option<&Record>) -> bool {
    // Own-record reads cross a JSON connection that can reorder object properties.
    // Compare logical properties, not the insertion positions retained for storage
    // serialization. Arrays and scalar values keep their exact existing meaning.
    fn same_properties(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.insertion_entries().all(|(key, value)| {
                        b.get(key)
                            .is_some_and(|other| same_properties(value, other))
                    })
            }
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_properties(a, b))
            }
            _ => left == right,
        }
    }
    match expected {
        write_command::Expected::Unconditional => true,
        write_command::Expected::Absent => observed.is_none(),
        write_command::Expected::Identity { kind, identity } => observed.is_some_and(|record| {
            record.kind.as_ref() == Some(kind) && &record.identity == identity
        }),
        write_command::Expected::Present { kind, value }
        | write_command::Expected::PresentIdentity { kind, value, .. } => {
            observed.is_some_and(|record| {
                record.kind.as_ref() == Some(kind)
                    && same_properties(&record.value, value)
                    && match expected {
                        write_command::Expected::PresentIdentity { identity, .. } => {
                            identity == &record.identity
                        }
                        _ => true,
                    }
            })
        }
    }
}
impl<'db, 's, 'c> NativeTransaction<'db, 's, 'c> {
    fn write_model(
        &mut self,
        writes: &[Write],
        observed: &BTreeMap<String, Option<Record>>,
    ) -> Result<Model> {
        // The installed tools' model, whose list rule's field kinds (`field_kinds`) are joined in it too.
        let installed = crate::record_model_policy::installed(self.state.owner.state_root())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let mut model = Model::from_product_data(installed.data(), installed.data())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let dynamic = writes
            .iter()
            .map(|w| &w.kind)
            .chain(
                observed
                    .values()
                    .filter_map(|r| r.as_ref().and_then(|r| r.kind.as_ref())),
            )
            .any(|kind| {
                model.declares(kind)
                    || model
                        .declared_prefixes()
                        .any(|p| kind.units().starts_with(p.units()))
            });
        if !dynamic {
            return Ok(model);
        }
        let types = model.declaring_types().cloned().collect::<Vec<_>>();
        let policy = crate::record_model_policy::open_policy(self.state.owner.state_root())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let mut remaining = 4096usize;
        for kind in types {
            self.current()?;
            let kind_text = kind.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            // Every declaring record, page by page within the store's page
            // bound; more than `remaining` declarations in all is refused.
            let mut ids = Vec::new();
            let mut after = None::<String>;
            loop {
                let page = self
                    .state
                    .external
                    .records(self.db)?
                    .ids_of_type(
                        &kind_text,
                        after.as_deref(),
                        (remaining + 1).min(crate::records::MAX_PAGE_ITEMS),
                    )
                    .map_err(|error| crate::carry_cause!(Error::Source, error))?;
                if page.ids.len() > remaining {
                    return Err(crate::cause!(Error::Bounds));
                }
                remaining -= page.ids.len();
                ids.extend(page.ids.into_iter().map(JsString::from));
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            // Original loadDeclared consumes key ranges in ascending UTF-16 ID
            // order, after original declared_by insertion order.
            ids.sort();
            for id in ids {
                let text = id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                let row = self
                    .with_current_values(|values| logical(values, &text, &policy))?
                    .ok_or(crate::cause!(Error::Conflict))?;
                if row.kind.as_ref() != Some(&kind) {
                    return Err(crate::cause!(Error::Conflict));
                }
                model
                    .declare(&kind, &id, &row.value)
                    .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            }
        }
        Ok(model)
    }
    /// The account's own record write (`own-record-writes.json`): each named
    /// record's current logical value is read on this held transaction, a
    /// removal without a kind removes whatever kind the record holds at that
    /// point of the batch, and removing an absent record changes nothing. The
    /// shared ordered write below checks the live record model and seals.
    /// `within` (a tool run's capability) refuses the whole write when a record
    /// it names, or the record it would replace or remove at that point of the
    /// batch, is of a kind outside it.
    ///
    /// This is the one records-write authority every records:write passes through (the person's browser, the
    /// personal key at the local door, an app's grant through the public door, a tool run's capability), so
    /// it is where a write that needs the person present is refused (`write_observed`, `account::person_present`).
    pub(super) fn write_records(
        &mut self,
        writes: &[write_command::Write],
        within: Option<&dyn Fn(&str) -> bool>,
        person_present: Option<&serde_json::Value>,
    ) -> Result<()> {
        self.current()?;
        let command = write_command::Command::shipped().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if self.binding.operation != command.operation() {
            return Err(crate::cause!(Error::Refused));
        }
        if writes.len() > record_log::MAX_BATCH_RECORDS {
            return Err(crate::cause!(Error::Bounds));
        }
        let policy = crate::record_model_policy::open_policy(self.state.owner.state_root())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let mut observed = BTreeMap::<String, Option<Record>>::new();
        let mut kinds = BTreeMap::<String, Option<JsString>>::new();
        let mut planned = Vec::with_capacity(writes.len());
        for write in writes {
            let id = write.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            if !observed.contains_key(&id) {
                let current = self.with_current_values(|values| logical(values, &id, &policy))?;
                kinds.insert(
                    id.clone(),
                    current.as_ref().and_then(|record| record.kind.clone()),
                );
                observed.insert(id.clone(), current);
            }
            if let Some(within) = within {
                let granted = |kind: Option<&JsString>| {
                    kind.and_then(|kind| kind.to_rust_string().ok())
                        .is_some_and(|kind| within(&kind))
                };
                let held = kinds.get(&id).cloned().flatten();
                if !granted(write.kind.as_ref()) || (held.is_some() && !granted(held.as_ref())) {
                    return Err(crate::cause!(Error::Refused));
                }
            }
            // Conditions all witness the one logical snapshot captured before
            // the batch is planned. Repeated identities never observe an
            // earlier item in this same input.
            if !expected_matches(&write.expected, observed.get(&id).and_then(Option::as_ref)) {
                // The log names the kind and the fields that differ, never the record's id or any value (the person's words).
                crate::quiet_eprintln!("record-write event=conflict {}", conflict_fields(&write.expected, observed.get(&id).and_then(Option::as_ref)));
                return Err(crate::cause!(Error::Conflict));
            }
            let Some(kind) = write
                .kind
                .clone()
                .or_else(|| kinds.get(&id).cloned().flatten())
            else {
                continue;
            };
            kinds.insert(id, write.value.is_some().then(|| kind.clone()));
            planned.push(Write {
                id: write.id.clone(),
                kind,
                value: write.value.clone(),
            });
        }
        if planned.is_empty() {
            return self.current();
        }
        self.write_observed(&observed, &planned, Some(person_present))?;
        // The account's rules over what this write changed, and the workflow runs they and the person started
        // (src/rule_bindings/rules_and_runs/on_write.rs), on this same held transaction.
        self.run_rules_after_write(&planned)
    }
    /// One ordered original write of `writes` over `observed`: the logical
    /// before-state of every written id, read on this same held transaction.
    /// `person_present` is Some for a records:write (holding what its request carried, if anything): after the live
    /// model admits every value, a write that newly sets a value its declaring record marks as needing the person
    /// present, or that removes such a mark, is refused (`Error::NeedsPersonPresent`, naming the record, field and
    /// value) unless the door marked the caller's own pass fresh (`account::person_present`). One write is confirmed by one
    /// confirmation; a write that needs more is refused naming the first, consuming nothing.
    pub(super) fn write_observed(
        &mut self,
        observed: &BTreeMap<String, Option<Record>>,
        writes: &[Write],
        person_present: Option<Option<&serde_json::Value>>,
    ) -> Result<()> {
        let mut before = BTreeMap::new();
        let mut protected_before = BTreeMap::new();
        let mut state = BTreeMap::new();
        for write in writes {
            let id = write.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            if !observed.contains_key(&id) {
                return Err(crate::cause!(Error::Refused));
            }
            if !before.contains_key(&id) {
                let (projected, protected) = self.state.external.projection(self.db, &id)?;
                before.insert(id.clone(), projected);
                protected_before.insert(id.clone(), protected);
                state.insert(id.clone(), observed[&id].clone());
            }
            if write
                .value
                .as_ref()
                .is_some_and(|v| !matches!(v, Value::Object(_)))
            {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        let declared = self.write_model(writes, observed)?;
        // Derive effective logical transitions first: a no-op declaration does
        // not change which original declaration currently wins.
        let mut effective = Vec::new();
        let mut prior = Vec::new();
        for write in writes {
            let id = write.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            let old = state.get(&id).cloned().flatten();
            let changed = match (&old, &write.value) {
                (None, None) => false,
                (Some(old), Some(value)) => {
                    old.kind.as_ref() != Some(&write.kind) || encode(&old.value)? != encode(value)?
                }
                _ => true,
            };
            prior.push(old.clone());
            effective.push(changed);
            state.insert(
                id,
                write.value.clone().map(|value| Record {
                    kind: Some(write.kind.clone()),
                    value,
                    identity: JsString::default(),
                }),
            );
        }
        let model = declared
            .effective_for_final_writes(writes.iter().zip(&effective).map(|(w, e)| {
                record_write_model::FinalWrite {
                    id: &w.id,
                    kind: Some(&w.kind),
                    value: w.value.as_ref(),
                    effective: *e,
                }
            }))
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        for (write, old) in writes.iter().zip(&prior) {
            if let Some(value) = &write.value {
                if let Some(refusal) = model
                    .check_write(
                        &write.kind,
                        value,
                        old.as_ref()
                            .and_then(|r| r.kind.as_ref().map(|kind| (kind, &r.value))),
                    )
                    .map_err(|error| Error::Source(error.cause()))?
                {
                    let cause = refusal.cause();
                    // A value outside a field's declared choices names the field and the value to the caller; a move its
                    // declared moves do not list names the value it changes from too.
                    let Some(outside) = refusal.outside else {
                        return Err(Error::Invalid(cause));
                    };
                    let from = refusal
                        .from
                        .map(|from| from.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error)))
                        .transpose()?;
                    let refused = if from.is_some() {
                        Error::MoveNotDeclared(cause)
                    } else {
                        Error::OutsideChoices(cause)
                    };
                    self.state.external.outside =
                        Some(super::super::Named::Outside(super::super::Outside {
                            kind: refusal.kind.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
                            field: refusal
                                .property
                                .to_rust_string()
                                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
                            value: outside.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
                            from,
                        }));
                    return Err(refused);
                }
            }
        }
        // Only the door sets `person_present` (a caller whose own pass is fresh, src/native_boot/mcp_local.rs `invoke_as`);
        // a records:write without it that needs the person present is refused, naming the first confirmation it needs.
        if let Some(None) = person_present {
            let mut needed = Vec::<person_present::Requirement>::new();
            for (write, old) in writes.iter().zip(&prior) {
                let held = old
                    .as_ref()
                    .and_then(|r| r.kind.as_ref().map(|kind| (kind, &r.value)));
                for requirement in person_present::required(
                    &declared,
                    &model,
                    &write.id,
                    &write.kind,
                    write.value.as_ref(),
                    held,
                )
                .map_err(|error| Error::Invalid(error.cause()))?
                {
                    if !needed.contains(&requirement) {
                        needed.push(requirement);
                    }
                }
            }
            if let Some(first) = needed.first() {
                self.state.external.outside = Some(super::super::Named::NeedsPersonPresent(
                    super::super::NeedsPersonPresent {
                        requirement: first.clone(),
                        marked_changes: needed.len(),
                    },
                ));
                return Err(crate::cause!(Error::NeedsPersonPresent));
            }
        }
        let mut prepared = Vec::new();
        let mut keys = BTreeMap::<String, OriginalKey>::new();
        for write in writes {
            let id = write.id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            let kind = write.kind.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            let mut desired = write.value.clone();
            if let Some(value) = desired.as_mut() {
                let owner = model
                    .key_owner(&write.kind, &write.id, value)
                    .to_rust_string()
                    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                for path in model.erasable_fields(&write.kind) {
                    let Some(plain) = member(value, path).cloned() else {
                        continue;
                    };
                    if matches!(plain, Value::Null) {
                        continue;
                    }
                    // Plan input is logical. Never accept a caller-injected
                    // opaque wrapper as proof that its private field is sealed.
                    if matches!(&plain,Value::Object(o) if crate::record_sealed::is_sealed(o)) {
                        return Err(crate::cause!(Error::Refused));
                    }
                    let field = field_name(path);
                    let sealed = if let Some(key) = keys.get(&owner) {
                        key.seal_under(&id, &field, &plain, &owner)
                            .map_err(record_error)?
                    } else {
                        match self.state.external.key_state(self.db, &owner)? {
                            KeyState::Present(key) => Value::Object(
                                crate::record_sealed::prepare::seal(
                                    &key,
                                    &id,
                                    &field,
                                    &plain,
                                    Some(&owner),
                                    Default::default(),
                                )
                                .map_err(|error| crate::carry_cause!(Error::Source, error))?,
                            ),
                            KeyState::Erased => return Err(crate::cause!(Error::Refused)),
                            KeyState::Missing => {
                                if owner != id {
                                    return Err(crate::cause!(Error::Refused));
                                }
                                let mut bytes = Zeroizing::new([0u8; 32]);
                                SystemRandom::new()
                                    .fill(bytes.as_mut())
                                    .map_err(|error| crate::carry_cause!(Error::Source, error))?;
                                let key = OriginalKey::from_bytes(bytes);
                                let sealed = key.seal(&id, &field, &plain).map_err(record_error)?;
                                keys.insert(owner.clone(), key);
                                sealed
                            }
                        }
                    };
                    replace(value, path, sealed)?;
                }
            }
            prepared.push(Prepared {
                id,
                kind,
                value: desired,
            });
        }
        self.current()?;
        let mut check = || self.state.assert_current(self.db, self.binding).is_ok();
        let guard = Guard {
            scope: self.scope,
            request: self.request,
            before: &before,
            records: &prepared,
            check: RefCell::new(&mut check),
        };
        let rows = prepared
            .iter()
            .map(|r| OriginalRecord {
                id: &r.id,
                record_type: &r.kind,
                value: r.value.as_ref(),
            })
            .collect::<Vec<_>>();
        let mut plan = original_setting::plan_original_records(
            self.scope,
            &rows,
            &before,
            self.request,
            self.context,
            &guard,
            self.ids,
        )
        .map_err(record_error)?;
        if !keys.is_empty() {
            let attached = keys
                .iter()
                .map(|(id, key)| (id.as_str(), key))
                .collect::<Vec<_>>();
            plan.attach_admitted_original_keys(&attached)
                .map_err(record_error)?;
        }
        self.write_plan(&plan, &protected_before)?;
        let receipt = plan.receipt();
        self.writes += receipt.written.len();
        self.changed |= !receipt.written.is_empty();
        self.current()
    }
}

#[cfg(test)]
mod expected_tests {
    use super::*;

    fn value(raw: &str) -> Value {
        crate::ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
    }

    #[test]
    fn every_expected_condition_uses_the_same_batch_start_record() {
        let initial = Record {
            kind: Some(JsString::from("note")),
            value: value(r#"{"text":"before"}"#),
            identity: JsString::from("old"),
        };
        let after_first = Record {
            kind: Some(JsString::from("note")),
            value: value(r#"{"text":"after first write"}"#),
            identity: JsString::from("new"),
        };
        let expected = write_command::Expected::Present {
            kind: JsString::from("note"),
            value: value(r#"{"text":"before"}"#),
        };
        // A later item for the same id is still checked against `initial`,
        // even though ordered planning has already computed `after_first`.
        assert!(expected_matches(&expected, Some(&initial)));
        assert!(!expected_matches(&expected, Some(&after_first)));
        assert!(expected_matches(&write_command::Expected::Absent, None));
        assert!(!expected_matches(
            &write_command::Expected::Absent,
            Some(&initial)
        ));
    }

    #[test]
    fn expected_properties_survive_json_connection_order_but_changes_still_conflict() {
        let held = Record {
            kind: Some(JsString::from("list")),
            value: value(
                r#"{"label":"Library","fields":[{"label":"Name","id":"name"}],"extra":{"z":1,"a":true}}"#,
            ),
            identity: JsString::from("held"),
        };
        let matches = |raw| {
            expected_matches(
                &write_command::Expected::Present {
                    kind: JsString::from("list"),
                    value: value(raw),
                },
                Some(&held),
            )
        };
        assert!(matches(
            r#"{"extra":{"a":true,"z":1},"fields":[{"id":"name","label":"Name"}],"label":"Library"}"#
        ));
        assert!(!matches(
            r#"{"extra":{"a":true,"z":2},"fields":[{"id":"name","label":"Name"}],"label":"Library"}"#
        ));
        assert!(!matches(
            r#"{"extra":{"a":true,"z":1},"fields":[{"id":"name"}],"label":"Library"}"#
        ));
        assert!(!matches(
            r#"{"extra":{"a":true,"z":"1"},"fields":[{"id":"name","label":"Name"}],"label":"Library"}"#
        ));
        assert!(!matches(
            r#"{"extra":{"a":true,"z":1},"fields":[{"id":"name","label":"Name"},{"id":"other"}],"label":"Library"}"#
        ));
        assert!(!matches(
            r#"{"extra":{"a":true,"z":1},"fields":[{"id":"name","label":"Name"}],"label":"Library","added":null}"#
        ));
        let wrong_kind = write_command::Expected::Present {
            kind: JsString::from("note"),
            value: held.value.clone(),
        };
        assert!(!expected_matches(&wrong_kind, Some(&held)));
        let ordered = Record {
            kind: Some(JsString::from("list")),
            value: value(r#"{"items":[1,2]}"#),
            identity: JsString::from("ordered"),
        };
        let reversed = write_command::Expected::Present {
            kind: JsString::from("list"),
            value: value(r#"{"items":[2,1]}"#),
        };
        assert!(!expected_matches(&reversed, Some(&ordered)));
        let nullable = Record {
            kind: Some(JsString::from("list")),
            value: value(r#"{"present":null,"zero":-0.0}"#),
            identity: JsString::from("nullable"),
        };
        let null_missing = write_command::Expected::Present {
            kind: JsString::from("list"),
            value: value(r#"{"zero":0}"#),
        };
        assert!(!expected_matches(&null_missing, Some(&nullable)));
        let same_zero = write_command::Expected::Present {
            kind: JsString::from("list"),
            value: value(r#"{"zero":0.0,"present":null}"#),
        };
        assert!(expected_matches(&same_zero, Some(&nullable)));
    }

    #[test]
    fn compact_identity_compares_the_batch_start_root_kind_and_stamp() {
        for kind in ["sample-a", "sample-b"] {
            let mut held = Record {
                kind: Some(kind.into()),
                value: value(r#"{"computed":"display only"}"#),
                identity: "90071992547409931234567890".into(),
            };
            let expected = write_command::Expected::Identity {
                kind: held.kind.clone().unwrap(),
                identity: held.identity.clone(),
            };
            assert!(expected_matches(&expected, Some(&held)));
            let snapshot = write_command::Expected::PresentIdentity {
                kind: kind.into(),
                value: held.value.clone(),
                identity: held.identity.clone(),
            };
            assert!(expected_matches(&snapshot, Some(&held)));
            held.value = value(r#"{"changed":true}"#);
            assert!(
                !expected_matches(&snapshot, Some(&held)),
                "metadata never discards a supplied whole-value condition"
            );
            assert!(!expected_matches(&expected, None));
            held.kind = Some(format!("{kind}-other").into());
            assert!(!expected_matches(&expected, Some(&held)));
            held.kind = Some(kind.into());
            held.identity = "90071992547409931234567891".into();
            assert!(!expected_matches(&expected, Some(&held)));
        }
    }
}
