//! Original record changes planned over the account's current stored forms.
//! This is the record model's field-stamp join (record-log-store.mjs
//! envelopes, stampAfter, joins): each change is an envelope stamped from one
//! canonical log id, joined into the record's current state, and turned
//! back into the stored form the account's own records keep (record store,
//! `local_account::own_records`). Planning reads and writes nothing; the
//! native command's one transaction writes the planned stored forms and keys.
//!
//! Non-Negotiable Invariants:
//! - Every event is admitted on its own exact before-state, including a repeated
//!   identity inside one ordered sequence (an execution's start, result and
//!   return). A no-op envelope allocates no log id and writes nothing.
//! - A key attaches only to a record this plan writes; a public producer may
//!   attach one only to a record that did not exist. Key bytes never enter a
//!   stored form, a receipt or an identity.
//! - A record proved protected before the change stays protected; only an
//!   attached key makes a record newly protected.
//!
//! Security Considerations:
//! - Keys are zeroized owned bytes; this module seals with them and hands them
//!   to the store, nothing else.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use super::*;
use content_crypto::advanced::blake3;
use crate::{
    ecma_json::{self, JsString, Object, Value as Ecma},
    legacy_records::StoredRecord,
};
use zeroize::Zeroizing;
mod keys;
pub use keys::OriginalKey;

/// The native producer supplies its actual prepared record value; this
/// container grants no model, key or account authority.
pub struct OriginalRecord<'a> {
    pub id: &'a str,
    pub record_type: &'a str,
    pub value: Option<&'a Ecma>,
}

/// A planned change. All caller-visible work is provisional until the native
/// command's transaction commits and current disclosure is rechecked.
pub struct Plan {
    request_key: String,
    log_id: Option<String>,
    written: Vec<String>,
    final_projected: BTreeMap<String, Option<Projected>>,
    previous_types: BTreeMap<String, Option<String>>,
    keys: Vec<(String, OriginalKey)>,
    input_identity: String,
}
impl fmt::Debug for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OriginalRecordPlan([redacted])")
    }
}
impl Plan {
    pub fn input_identity(&self) -> &str {
        &self.input_identity
    }
    pub fn unchanged(&self) -> bool {
        self.written.is_empty()
    }
    pub fn receipt(&self) -> Receipt {
        Receipt {
            transaction_id: self.request_key.clone(),
            written: self.written.clone(),
            previous_types: self.previous_types.clone(),
            log_id: self.log_id.clone(),
        }
    }

    /// The exact post-event record states this plan computed. An empty map means
    /// the plan emitted no record envelope.
    pub fn final_projected(&self) -> &BTreeMap<String, Option<Projected>> {
        &self.final_projected
    }

    /// The keys attached to records this plan writes, for the store to keep.
    pub fn keys(&self) -> impl Iterator<Item = (&str, &OriginalKey)> {
        self.keys.iter().map(|(id, key)| (id.as_str(), key))
    }

    /// Attach keys to records this plan creates. No key may be attached to a
    /// no-op or to a record absent from this exact plan or existing before it.
    pub fn attach_original_keys(&mut self, keys: &[(&str, &OriginalKey)]) -> Result<()> {
        self.attach_keys(keys, true)
    }
    /// The retained native producer has proved every own key Missing (never
    /// Erased) on this same transaction before minting it. Existing unkeyed
    /// records may receive their first key when an erasable field is first set.
    pub(crate) fn attach_admitted_original_keys(&mut self, keys: &[(&str, &OriginalKey)]) -> Result<()> {
        self.attach_keys(keys, false)
    }
    fn attach_keys(&mut self, keys: &[(&str, &OriginalKey)], new_record_only: bool) -> Result<()> {
        if keys.is_empty() || keys.len() > MAX_BATCH_RECORDS || !self.keys.is_empty() || self.log_id.is_none() {
            return Err(Error::Invalid("original key batch refused", crate::cause!()));
        }
        let mut seen = BTreeSet::new();
        for (id, _) in keys {
            validate_id(id)?;
            if !self.written.iter().any(|written| written.as_str() == *id)
                || new_record_only && self.previous_types.get(*id) != Some(&None)
                || !seen.insert(*id)
            {
                return Err(crate::cause!(Error::Refused));
            }
        }
        self.keys = keys.iter().map(|(id, key)| ((*id).to_owned(), (*key).clone())).collect();
        Ok(())
    }

    /// Each written record's final stored form (None when removed), the
    /// representation the account's own records keep. `protected_before` must
    /// come from the same admitted before-state read as the plan. Projected
    /// field stamps do not carry key existence; missing proof must never turn an
    /// existing protected record into an unprotected one.
    pub fn final_stored(&self, protected_before: &BTreeMap<String, bool>) -> Result<BTreeMap<String, Option<StoredRecord>>> {
        let mut out = BTreeMap::new();
        for (id, projection) in &self.final_projected {
            let protected = *protected_before.get(id).ok_or(crate::cause!(Error::Refused))?
                || self.keys.iter().any(|(keyed, _)| keyed == id);
            out.insert(id.clone(), stored(id, projection.as_ref(), protected)?);
        }
        Ok(out)
    }
}

/// One record's stored form from its current state; None for no record or a removal.
fn stored(id: &str, projection: Option<&Projected>, protected: bool) -> Result<Option<StoredRecord>> {
    let Some(projected) = projection else { return Ok(None) };
    let Some(kind) = projected.kept.record_type.as_ref() else { return Ok(None) };
    let fields = projected.kept.value.as_ref().ok_or(crate::cause!(Error::Corrupt))?;
    let value_json = text(&fields_json(fields)?)?;
    let meta_json = projected.kept.meta.as_ref().map(|meta| serde_json::to_string(meta).map_err(Error::from)).transpose()?;
    if value_json.len().saturating_add(meta_json.as_ref().map_or(0, String::len)) > crate::legacy_records::Bounds::default().bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(Some(StoredRecord {
        id: id.to_owned(),
        record_type: kind.clone(),
        sequence: projected.sequence.clone().ok_or(crate::cause!(Error::Corrupt))?,
        value_json,
        meta_json,
        protected_key_present: protected,
    }))
}

/// The current state a stored form holds: its kind, field values (exact JSON text
/// of each top-level field, in the value's own field order), field stamps and
/// sequence. The inverse of `Plan::final_stored`.
pub fn projection(record: &StoredRecord) -> Result<Projected> {
    let value = parsed(&record.value_json)?;
    let Ecma::Object(object) = value else { return Err(crate::cause!(Error::Corrupt)) };
    let mut fields = Fields::new();
    for (name, value) in object.property_entries() {
        let name = name.to_rust_string().map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        fields.insert(name, Value::String(text(value)?));
    }
    let meta = record.meta_json.as_deref().map(|meta| serde_json::from_str::<Meta>(meta).map_err(|error| crate::carry_cause!(Error::Corrupt, error))).transpose()?;
    Ok(Projected {
        sequence: Some(record.sequence.clone()),
        kept: Kept { record_type: Some(record.record_type.clone()), value: Some(fields), meta },
    })
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn text(value: &Ecma) -> Result<String> {
    ecma_json::stringify(value, Default::default()).map_err(|error| Error::Bounds(error.cause()))
}
fn parsed(raw: &str) -> Result<Ecma> {
    ecma_json::parse(raw.as_bytes(), Default::default()).map_err(|error| Error::Corrupt(error.cause()))
}
fn field<'a>(v: &'a Ecma, name: &str) -> Option<&'a Ecma> {
    match v {
        Ecma::Object(o) => o.get(&name.into()),
        _ => None,
    }
}
fn nonnull(value: Option<&Ecma>) -> Option<&Ecma> {
    value.filter(|v| !matches!(v, Ecma::Null))
}
fn opaque(value: &Ecma, depth: usize) -> Result<()> {
    if depth > 128 {
        return Err(crate::cause!(Error::Bounds));
    }
    match value {
        Ecma::Object(o) => {
            // Actual shared/sealed wrapper resolution and key creation belong
            // to their canonical owners. This plain setting change must never
            // silently copy an opened secret or turn a shared root into data.
            if o.get(&"\0shared".into()).is_some() || o.get(&"\0sealed".into()).is_some() {
                return Err(crate::cause!(Error::Refused));
            }
            for (_, v) in o.insertion_entries() {
                opaque(v, depth + 1)?;
            }
        }
        Ecma::Array(items) => {
            for item in items {
                opaque(item, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Verify the own model part (a plain setting is a kind trillion-local writes itself), including the
/// declaring-prefix boundary. No hardcoded JSON schema or "all settings are plain" assertion replaces DATA.
fn plain_setting_model() -> Result<()> {
    let model = crate::record_model_policy::own_model().map_err(|error| Error::Refused(error.cause()))?;
    let model = model.data();
    let Some(Ecma::Array(kinds)) = field(model, "kinds") else {
        return Err(crate::cause!(Error::Refused));
    };
    let setting = kinds
        .iter()
        .find(|k| field(k, "type") == Some(&Ecma::String("setting".into())))
        .ok_or(crate::cause!(Error::Refused))?;
    if matches!(field(setting, "table"), Some(Ecma::Bool(true)))
        || matches!(field(setting,"parts"),Some(Ecma::Array(p)) if !p.is_empty())
        || matches!(field(setting,"erasable"),Some(Ecma::Array(p)) if !p.is_empty())
        || field(setting, "erasable_key").is_some()
    {
        return Err(crate::cause!(Error::Refused));
    }
    let Some(Ecma::String(kind)) =
        field(setting, "guard_properties").and_then(|g| field(g, "value"))
    else {
        return Err(crate::cause!(Error::Refused));
    };
    let definition = field(model, "value_kinds")
        .and_then(|k| match k {
            Ecma::Object(o) => o.get(kind),
            _ => None,
        })
        .ok_or(crate::cause!(Error::Refused))?;
    if field(definition, "is").is_some() || field(definition, "list_of").is_some() {
        return Err(crate::cause!(Error::Refused));
    }
    if let Some(Ecma::Array(rules)) = field(model, "declared_by") {
        for rule in rules {
            let prefix = field(rule, "kind").and_then(|k| field(k, "prefix"));
            let prefix = match prefix {
                Some(Ecma::String(v)) => v.to_rust_string().map_err(|error| crate::carry_cause!(Error::Refused, error))?,
                None => String::new(),
                _ => return Err(crate::cause!(Error::Refused)),
            };
            if "setting".starts_with(&prefix) {
                return Err(crate::cause!(Error::Refused));
            }
        }
    }
    Ok(())
}

struct OriginalText;
impl ValueText for OriginalText {
    fn encode(&self, value: &Value) -> Result<String> {
        text(&parsed(value.as_str().ok_or(crate::cause!(Error::Corrupt))?)?)
    }
}
fn fields_json(fields: &Fields) -> Result<Ecma> {
    let mut out = Object::new();
    for (name, value) in fields.object_entries() {
        out.insert(
            JsString::from(name),
            parsed(value.as_str().ok_or(crate::cause!(Error::Corrupt))?)?,
        );
    }
    Ok(Ecma::Object(out))
}

/// The record inputs of producer records: each top-level field as its exact JSON text.
fn inputs(records: &[OriginalRecord<'_>]) -> Result<Vec<RecordInput>> {
    records
        .iter()
        .map(|record| {
            validate_id(record.id)?;
            if record.record_type.is_empty()
                || record.record_type.len() > 4096
                || record.record_type.contains('\0')
            {
                return Err(Error::Invalid("original record kind refused", crate::cause!()));
            }
            let value = record
                .value
                .map(|value| {
                    let Ecma::Object(object) = value else {
                        return Err(Error::Invalid("original whole record must be an object", crate::cause!()));
                    };
                    object
                        .property_entries()
                        .into_iter()
                        .map(|(name, value)| {
                            let name = name.to_rust_string().map_err(|_| {
                                Error::Invalid("original top-level field name unsupported", crate::cause!())
                            })?;
                            Ok((name, Value::String(text(value)?)))
                        })
                        .collect::<Result<Fields>>()
                })
                .transpose()?;
            Ok(RecordInput {
                id: record.id.into(),
                record_type: record.record_type.into(),
                value,
            })
        })
        .collect::<Result<Vec<_>>>()
}

/// Stamp one envelope from the log id and join it into the record's current state (source stampAfter: a stamp behind
/// the held one continues it, so a record's stamps only grow).
fn next_state(mut envelope: Envelope, held: Option<&Projected>, log_id: &str, index: usize) -> Result<Option<Projected>> {
    let stamp = sequence(log_id, index)?;
    let previous = held.and_then(|p| p.kept.meta.as_ref()).map(|m| m.at.as_str()).unwrap_or("");
    let moved = stamps::stamp_after(&stamp, previous).map_err(|error| Error::Corrupt(error.cause()))?;
    if moved != stamp {
        envelope.at = Some(moved);
    }
    apply_envelope(held, &envelope, &stamp, &OriginalText)
}

/// Plan an ordered sequence of record events. Each event is admitted on its
/// own exact before-state (`admit`): the record's state before the plan for its
/// first event, the state the previous event left for a repeated identity.
/// Written ids count emitted events in order, repeated ids included;
/// previous_types keeps each identity's type before the plan.
fn plan(
    scope: &Scope,
    records: &[RecordInput],
    before: &BTreeMap<String, Option<Projected>>,
    request: &Request,
    context: &Context,
    identity: String,
    admit: &dyn Fn(&RecordInput, &BTreeMap<String, Option<Projected>>) -> bool,
    ids: &mut dyn LogIds,
) -> Result<Plan> {
    validate_scope(scope)?;
    validate_request(request)?;
    validate_context(context)?;
    validate_batch(records)?;
    let mut plan = Plan {
        request_key: request.key.clone(),
        log_id: None,
        written: Vec::new(),
        final_projected: BTreeMap::new(),
        previous_types: BTreeMap::new(),
        keys: Vec::new(),
        input_identity: identity,
    };
    let mut current = BTreeMap::<String, Option<Projected>>::new();
    for record in records {
        if !current.contains_key(&record.id) {
            let held = before.get(&record.id).ok_or(Error::Invalid("current original before-state is required", crate::cause!()))?;
            current.insert(record.id.clone(), held.clone());
        }
        let held = current.get(&record.id).ok_or(crate::cause!(Error::Corrupt))?.as_ref();
        let event_before = BTreeMap::from([(record.id.clone(), held.cloned())]);
        if !admit(record, &event_before) {
            return Err(crate::cause!(Error::Refused));
        }
        let Some(envelope) = envelope_for(record, held, &OriginalText)? else {
            continue;
        };
        if plan.log_id.is_none() {
            let id = ids.next_log_id().ok_or(Error::Invalid("canonical log identity unavailable", crate::cause!()))?;
            validate_log_id(&id)?;
            plan.log_id = Some(id);
        }
        let log_id = plan.log_id.as_deref().ok_or(crate::cause!(Error::Corrupt))?;
        let next = next_state(envelope, held, log_id, plan.written.len())?;
        plan.previous_types
            .entry(record.id.clone())
            .or_insert_with(|| held.and_then(|p| p.kept.record_type.clone()));
        plan.written.push(record.id.clone());
        plan.final_projected.insert(record.id.clone(), next.clone());
        current.insert(record.id.clone(), next);
    }
    Ok(plan)
}

/// Identity of this exact setting CAS input, independent of a new log ID.
/// The record id of the setting `name`, validated: the one spot a setting's id is spelled.
pub fn setting_id(name: &str) -> Result<String> {
    let id = format!("setting:{name}");
    validate_id(&id)?;
    Ok(id)
}

pub fn original_setting_identity(
    scope: &Scope,
    name: &str,
    expected: Option<&Ecma>,
    desired: &Ecma,
    request: &Request,
) -> Result<String> {
    validate_scope(scope)?;
    validate_request(request)?;
    if name.is_empty() || name.len() > 4096 || name.chars().any(char::is_control) {
        return Err(Error::Invalid("setting name refused", crate::cause!()));
    }
    let id = setting_id(name)?;
    let expected = text(expected.unwrap_or(&Ecma::Null))?;
    let wanted = if matches!(desired, Ecma::Null) {
        None
    } else {
        Some(text(desired)?)
    };
    if expected.len() > MAX_BATCH_BYTES
        || wanted.as_ref().map_or(0, String::len) > MAX_BATCH_BYTES
    {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(hash(&serde_json::to_vec(&(
        scope,
        id,
        expected,
        wanted,
        &request.key,
        request.sent_at_ms,
    ))?))
}

/// Plan a plain setting compare-and-set against the canonical current state
/// the native command read inside its own IMMEDIATE transaction. The compiled
/// plain-setting model and the compare are this change's whole admission; the
/// command rechecks its current rights around the write.
pub fn plan_original_setting(
    scope: &Scope,
    before: Option<Projected>,
    name: &str,
    expected: Option<&Ecma>,
    desired: &Ecma,
    request: &Request,
    context: &Context,
    ids: &mut dyn LogIds,
) -> Result<Plan> {
    plain_setting_model()?;
    let identity = original_setting_identity(scope, name, expected, desired, request)?;
    let record_id = setting_id(name)?;
    let mut current = None;
    if let Some(row) = before.as_ref() {
        if row.kept.record_type.as_deref().is_some_and(|kind| kind != "setting") {
            return Err(crate::cause!(Error::Refused));
        }
        if let Some(fields) = &row.kept.value {
            let value = fields_json(fields)?;
            opaque(&value, 0)?;
            current = nonnull(field(&value, "value")).cloned();
        } else if row.kept.record_type.is_some() {
            return Err(crate::cause!(Error::Corrupt));
        }
    }
    opaque(desired, 0)?;
    let actual = text(current.as_ref().unwrap_or(&Ecma::Null))?;
    let expected_text = text(expected.unwrap_or(&Ecma::Null))?;
    if actual != expected_text {
        return Err(crate::cause!(Error::Conflict));
    }
    let wanted = if matches!(desired, Ecma::Null) {
        None
    } else {
        Some(text(desired)?)
    };
    let input = RecordInput {
        id: record_id.clone(),
        record_type: "setting".into(),
        value: wanted.map(|raw| Fields::from_iter([("value".to_owned(), Value::String(raw))])),
    };
    plan(scope, &[input], &BTreeMap::from([(record_id, before)]), request, context, identity, &|_, _| true, ids)
}

/// Plan producer records as one ordered sequence (repeated identities allowed:
/// each event applies to the state the previous one left). Every before entry
/// is the same current state the producer read, absences included. The
/// admission's current check runs before and after planning, and its prepared
/// check admits every event on its own before-state.
pub fn plan_original_records(
    scope: &Scope,
    records: &[OriginalRecord<'_>],
    before: &BTreeMap<String, Option<Projected>>,
    request: &Request,
    context: &Context,
    admission: &dyn Admission,
    ids: &mut dyn LogIds,
) -> Result<Plan> {
    let records = inputs(records)?;
    let identity = hash(&serde_json::to_vec(&(
        "original-record-sequence-v1",
        scope,
        &records,
        &request.key,
        request.sent_at_ms,
    ))?);
    require(admission, scope, request, &identity)?;
    let admit = |record: &RecordInput, before: &BTreeMap<String, Option<Projected>>| {
        admission.validate_prepared(scope, std::slice::from_ref(record), before)
    };
    let plan = plan(scope, &records, before, request, context, identity, &admit, ids)?;
    require(admission, scope, request, plan.input_identity())?;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record_stamps::Meta;
    use std::cell::Cell;

    struct Ids(usize);
    impl LogIds for Ids {
        fn next_log_id(&mut self) -> Option<String> {
            self.0 += 1;
            Some(format!("{:08x}-89ab-7001-8f01-0123456789ab", self.0))
        }
    }
    /// Admits every event and counts them; the third event must see the execution the first one started.
    struct Guard {
        seen: Cell<usize>,
        refuse: Option<usize>,
    }
    impl Guard {
        fn new() -> Self {
            Self { seen: Cell::new(0), refuse: None }
        }
    }
    impl Admission for Guard {
        fn assert_current(&self, s: &Scope, r: &Request, _: &str) -> bool {
            s.account == "fixture" && r.key == "fixture"
        }
        fn validate_prepared(&self, _: &Scope, records: &[RecordInput], before: &BTreeMap<String, Option<Projected>>) -> bool {
            let n = self.seen.get();
            self.seen.set(n + 1);
            if self.refuse == Some(n) || records.len() != 1 || before.len() != 1 {
                return false;
            }
            if n == 2 && records[0].id == "fixture-execution" {
                return before
                    .get(&records[0].id)
                    .and_then(Option::as_ref)
                    .and_then(|p| p.kept.value.as_ref())
                    .and_then(|f| f.get("state"))
                    .and_then(Value::as_str)
                    == Some("\"started\"");
            }
            true
        }
    }
    fn scope() -> Scope {
        Scope { account: "fixture".into(), resource: "@own-records".into() }
    }
    fn request() -> Request {
        Request { key: "fixture".into(), sent_at_ms: 1 }
    }
    fn context() -> Context {
        Context { actor: serde_json::json!({}), application_time: "now".into(), system_time: "now".into(), accepted_at_ms: 1 }
    }
    fn ecma(text: &str) -> Ecma {
        ecma_json::parse(text.as_bytes(), Default::default()).unwrap()
    }

    #[test]
    fn an_ordered_sequence_admits_each_event_on_the_state_the_previous_one_left() {
        let (started, returned, result) = (ecma(r#"{"state":"started"}"#), ecma(r#"{"state":"returned"}"#), ecma(r#"{"value":1}"#));
        let records = [
            OriginalRecord { id: "fixture-execution", record_type: "execution", value: Some(&started) },
            OriginalRecord { id: "fixture-result", record_type: "result", value: Some(&result) },
            OriginalRecord { id: "fixture-execution", record_type: "execution", value: Some(&returned) },
        ];
        let before = BTreeMap::from([("fixture-execution".to_owned(), None), ("fixture-result".to_owned(), None)]);
        let guard = Guard::new();
        let mut ids = Ids(0);
        let plan = plan_original_records(&scope(), &records, &before, &request(), &context(), &guard, &mut ids).unwrap();
        assert_eq!(guard.seen.get(), 3, "the third event saw the started execution");
        assert_eq!(ids.0, 1, "one log id for the whole sequence");
        let receipt = plan.receipt();
        assert_eq!(receipt.written, ["fixture-execution", "fixture-result", "fixture-execution"]);
        assert_eq!(receipt.previous_types["fixture-execution"], None);
        let protected = BTreeMap::from([("fixture-execution".to_owned(), false), ("fixture-result".to_owned(), false)]);
        let stored = plan.final_stored(&protected).unwrap();
        let execution = stored["fixture-execution"].as_ref().unwrap();
        assert_eq!(execution.value_json, r#"{"state":"returned"}"#);
        assert_eq!(execution.record_type, "execution");
        assert!(!execution.protected_key_present);
    }

    #[test]
    fn a_missing_before_state_or_a_refused_event_refuses_the_whole_plan() {
        let value = ecma(r#"{"a":1}"#);
        let records = [OriginalRecord { id: "one", record_type: "kind", value: Some(&value) }];
        let guard = Guard::new();
        assert!(matches!(
            plan_original_records(&scope(), &records, &BTreeMap::new(), &request(), &context(), &guard, &mut Ids(0)),
            Err(Error::Invalid(_, _))
        ));
        let mut guard = Guard::new();
        guard.refuse = Some(0);
        assert!(matches!(
            plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &guard, &mut Ids(0)),
            Err(Error::Refused(_))
        ));
    }

    #[test]
    fn a_no_op_allocates_no_log_id_and_writes_nothing() {
        let value = ecma(r#"{"a":1}"#);
        let records = [OriginalRecord { id: "one", record_type: "kind", value: Some(&value) }];
        let mut ids = Ids(0);
        let first = plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &Guard::new(), &mut ids).unwrap();
        let held = first.final_projected()["one"].clone();
        let mut again = Ids(0);
        let second = plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), held)]), &request(), &context(), &Guard::new(), &mut again).unwrap();
        assert!(second.unchanged());
        assert_eq!(again.0, 0);
        assert_eq!(second.receipt().log_id, None);
    }

    #[test]
    fn a_stored_form_round_trips_through_its_projection() {
        let value = ecma(r#"{"b":2,"a":"x","nested":{"z":[1,2]}}"#);
        let records = [OriginalRecord { id: "one", record_type: "kind", value: Some(&value) }];
        let plan = plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &Guard::new(), &mut Ids(0)).unwrap();
        let stored = plan.final_stored(&BTreeMap::from([("one".to_owned(), false)])).unwrap().remove("one").unwrap().unwrap();
        let projected = projection(&stored).unwrap();
        assert_eq!(&projected, plan.final_projected()["one"].as_ref().unwrap());
        let again = super::stored("one", Some(&projected), false).unwrap().unwrap();
        assert_eq!((again.value_json, again.meta_json, again.sequence), (stored.value_json, stored.meta_json, stored.sequence));
    }

    #[test]
    fn a_removal_then_recreation_gets_a_new_sequence() {
        let value = ecma(r#"{"a":1}"#);
        let mut ids = Ids(0);
        let put = [OriginalRecord { id: "one", record_type: "kind", value: Some(&value) }];
        let created = plan_original_records(&scope(), &put, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &Guard::new(), &mut ids).unwrap();
        let held = created.final_projected()["one"].clone();
        let first_sequence = held.as_ref().unwrap().sequence.clone();
        let remove = [OriginalRecord { id: "one", record_type: "kind", value: None }];
        let removed = plan_original_records(&scope(), &remove, &BTreeMap::from([("one".to_owned(), held)]), &request(), &context(), &Guard::new(), &mut ids).unwrap();
        assert!(removed.final_stored(&BTreeMap::from([("one".to_owned(), false)])).unwrap()["one"].is_none());
        let recreated = plan_original_records(&scope(), &put, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &Guard::new(), &mut ids).unwrap();
        assert_ne!(recreated.final_projected()["one"].as_ref().unwrap().sequence, first_sequence);
    }

    #[test]
    fn a_public_key_attaches_only_to_a_created_record_and_marks_it_protected() {
        let value = ecma(r#"{"a":1}"#);
        let records = [OriginalRecord { id: "one", record_type: "kind", value: Some(&value) }];
        let key = OriginalKey::from_bytes(Zeroizing::new([7; 32]));
        let mut created = plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), None)]), &request(), &context(), &Guard::new(), &mut Ids(0)).unwrap();
        assert!(matches!(created.attach_original_keys(&[("other", &key)]), Err(Error::Refused(_))));
        created.attach_original_keys(&[("one", &key)]).unwrap();
        assert!(created.final_stored(&BTreeMap::from([("one".to_owned(), false)])).unwrap()["one"].as_ref().unwrap().protected_key_present);
        assert_eq!(created.keys().count(), 1);

        let held = created.final_projected()["one"].clone();
        let changed = ecma(r#"{"a":2}"#);
        let update = [OriginalRecord { id: "one", record_type: "kind", value: Some(&changed) }];
        let mut existing = plan_original_records(&scope(), &update, &BTreeMap::from([("one".to_owned(), held)]), &request(), &context(), &Guard::new(), &mut Ids(9)).unwrap();
        assert!(matches!(existing.attach_original_keys(&[("one", &key)]), Err(Error::Refused(_))), "an existing identity cannot receive a new key");
        existing.attach_admitted_original_keys(&[("one", &key)]).unwrap();
        let unprotected = BTreeMap::from([("one".to_owned(), false)]);
        assert!(existing.final_stored(&unprotected).unwrap()["one"].as_ref().unwrap().protected_key_present);
    }

    #[test]
    fn a_protected_record_stays_protected_without_a_new_key() {
        let mut fields = Fields::new();
        fields.insert("a", Value::String("1".into()));
        let held = Projected {
            sequence: Some("sequence".into()),
            kept: Kept { record_type: Some("kind".into()), value: Some(fields), meta: Some(Meta { at: "stamp".into(), ..Meta::default() }) },
        };
        let changed = ecma(r#"{"a":2}"#);
        let records = [OriginalRecord { id: "one", record_type: "kind", value: Some(&changed) }];
        let plan = plan_original_records(&scope(), &records, &BTreeMap::from([("one".to_owned(), Some(held))]), &request(), &context(), &Guard::new(), &mut Ids(0)).unwrap();
        assert!(matches!(plan.final_stored(&BTreeMap::new()), Err(Error::Refused(_))), "missing proof is refused, not unprotected");
        assert!(plan.final_stored(&BTreeMap::from([("one".to_owned(), true)])).unwrap()["one"].as_ref().unwrap().protected_key_present);
    }

    #[test]
    fn a_setting_changes_only_from_its_expected_value() {
        let first = ecma(r#"{"theme":"dark"}"#);
        let created = plan_original_setting(&scope(), None, "look", None, &first, &request(), &context(), &mut Ids(0)).unwrap();
        let held = created.final_projected()[&setting_id("look").unwrap()].clone();
        let stored = created.final_stored(&BTreeMap::from([(setting_id("look").unwrap(), false)])).unwrap().remove(&setting_id("look").unwrap()).unwrap().unwrap();
        assert_eq!((stored.record_type.as_str(), stored.value_json.as_str()), ("setting", r#"{"value":{"theme":"dark"}}"#));

        let next = ecma(r#"{"theme":"light"}"#);
        assert!(matches!(
            plan_original_setting(&scope(), held.clone(), "look", None, &next, &request(), &context(), &mut Ids(1)),
            Err(Error::Conflict(_))
        ));
        let changed = plan_original_setting(&scope(), held.clone(), "look", Some(&first), &next, &request(), &context(), &mut Ids(1)).unwrap();
        assert_eq!(changed.receipt().previous_types[&setting_id("look").unwrap()].as_deref(), Some("setting"));
        let cleared = plan_original_setting(&scope(), held, "look", Some(&first), &Ecma::Null, &request(), &context(), &mut Ids(2)).unwrap();
        assert!(cleared.final_stored(&BTreeMap::from([(setting_id("look").unwrap(), false)])).unwrap()[&setting_id("look").unwrap()].is_none());

        let sealed = ecma(r#"{"\u0000sealed":{}}"#);
        assert!(matches!(
            plan_original_setting(&scope(), None, "look", None, &sealed, &request(), &context(), &mut Ids(3)),
            Err(Error::Refused(_))
        ), "an opaque wrapper is never copied as plain setting data");
    }
}
