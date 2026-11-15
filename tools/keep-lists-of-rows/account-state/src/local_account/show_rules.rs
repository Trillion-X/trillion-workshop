//! Actual selected-account GET show-rule composition. Reads the canonical
//! workspace projection and the SAME selected APP_KV reader. No store/decoder,
//! caller role, empty-success fallback, mutation or decide implementation.
//! Original owners: native-show-rules.mjs, show-rules-store.mjs, service-records.mjs.
pub(super) mod clock;

use super::LocalAccount;
use content_crypto::advanced::blake3;
use crate::{
    account::{AccountError, AccountResult, BrowserAdmission},
    ecma_json::{self, JsString, Object, Value},
    rule_bindings::{self, evaluator::FormulaBindingEvaluator},
    tool_label_locale::QualifiedLocale,
    workspace_store::{Selection, Snapshot},
    workspace_startup::ViewerAdmission,
    workspace_show_rules::{self as rules, Authority, ClockOwner, CurrentOwner, GivenContext},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn parse(bytes: &[u8]) -> AccountResult<Value> {
    ecma_json::parse(bytes, Default::default()).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
}
/// One DATA file this reader (and the service records' publisher, service_records.rs) names in `show_rules/data.json`, read from the account's installed tools (the
/// DATA's one owner); a name not there, or a file the installed tools do not carry, is unavailable source.
pub(crate) fn tools_json(root: &std::path::Path, name: &str) -> AccountResult<Value> {
    static FILES: std::sync::OnceLock<BTreeMap<String, (String, String)>> = std::sync::OnceLock::new();
    let files = FILES.get_or_init(|| {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Data {
            #[serde(rename = "_what")]
            _what: String,
            files: BTreeMap<String, (String, String)>,
        }
        serde_json::from_slice::<Data>(include_bytes!("show_rules/data.json"))
            .expect("show_rules/data.json is well formed")
            .files
    });
    let (tool, file) = files.get(name).ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    crate::tool_runs::tools::installed_data::json(root, tool, file).ok_or(crate::cause!(AccountError::SourceUnavailable))
}
fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    if let Value::Object(o) = v {
        o.get(&JsString::from(k))
    } else {
        None
    }
}
fn arr(v: Option<&Value>) -> &[Value] {
    if let Some(Value::Array(a)) = v {
        a
    } else {
        &[]
    }
}
fn text(v: &Value) -> Option<String> {
    if let Value::String(s) = v {
        s.to_rust_string().ok()
    } else {
        None
    }
}
fn field(v: &Value, k: &str) -> Option<String> {
    get(v, k).and_then(text)
}
fn obj() -> Value {
    Value::Object(Object::new())
}
fn put(v: &mut Value, k: &str, x: Value) {
    if let Value::Object(o) = v {
        o.insert(JsString::from(k), x);
    }
}
fn word(s: impl Into<String>) -> Value {
    Value::String(JsString::from(s.into()))
}
fn hash(value: &Value) -> AccountResult<[u8; 32]> {
    let bytes = Zeroizing::new(
        ecma_json::stringify(value, Default::default())
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?,
    );
    Ok(*blake3::hash(bytes.as_bytes()).as_bytes())
}
fn checked(cancel: &AtomicBool, deadline: Instant) -> AccountResult<()> {
    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
        Err(crate::cause!(AccountError::SourceChanged))
    } else {
        Ok(())
    }
}
/// Opaque current-source evidence; contains no borrowed SQLite handle and no
/// caller assertions. A repeated actual read checks value/source continuity.
pub struct ShowRulesDeliveryWitness<A = BrowserAdmission, R = ()> {
    admitted: A,
    retained: R,
    stamp: [u8; 32],
    deadline: Instant,
    until: Option<i64>,
}
// Preserve the original HTTP serializer and limits for every admitted caller.
impl<A, R> ShowRulesDeliveryWitness<A, R> {
pub(crate) fn encoded_body(&self, value: &Value) -> AccountResult<Zeroizing<Vec<u8>>> {
    let limits = crate::ecma_json::Limits {
        input_bytes: crate::workspace_show_rules::Limits::default().bytes,
        output_bytes: crate::workspace_show_rules::Limits::default().bytes,
        depth: crate::ecma_json::HARD_DEPTH,
        nodes: crate::ecma_json::HARD_NODES,
        string_units: crate::ecma_json::HARD_BYTES,
        total_string_units: crate::ecma_json::HARD_BYTES,
        container_entries: crate::ecma_json::HARD_NODES,
        number_bytes: crate::ecma_json::HARD_NUMBER_BYTES,
    };
    crate::ecma_json::stringify(value, limits)
        .map(String::into_bytes)
        .map(Zeroizing::new)
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
}

}
struct Sources<A, R> {
    admitted: A,
    retained: R,
    stamp: [u8; 32],
    personal: Option<Value>,
    giver: Value,
    context: Value,
    authority: Authority,
    /// The types the person's given shares give now (`account_rights::share_given`), read at each sharer's door.
    given: Vec<Value>,
}
impl LocalAccount {
    /// The operator's published show rules and setup context, as every account reads them (old trillion
    /// src/setup-steps.mjs readSetupPolicy's `operator.workspaceRecord(label)`, src/native-setup.mjs facts): the
    /// service records of the labels the installed tools name (show-rules.json `record`, setup-steps.json
    /// `policy.context_record`), each null when none is published. For Get started's facts at the account files
    /// door (`setup_facts`, Round 2 contract C).
    pub(crate) fn operator_setup_records(&mut self) -> AccountResult<(serde_json::Value, serde_json::Value)> {
        let root = self.source.selected.root.clone();
        let data = tools_json(&root, "show-rules")?;
        let setup = tools_json(&root, "setup-steps")?;
        let label = field(&data, "record").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let context_label = get(&setup, "policy")
            .and_then(|v| field(v, "context_record"))
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let plain = |value: Value| -> AccountResult<serde_json::Value> {
            let limits = crate::ecma_json::Limits {
                input_bytes: 4 * 1024 * 1024,
                output_bytes: 4 * 1024 * 1024,
                depth: crate::ecma_json::HARD_DEPTH,
                nodes: crate::ecma_json::HARD_NODES,
                string_units: crate::ecma_json::HARD_BYTES,
                total_string_units: crate::ecma_json::HARD_BYTES,
                container_entries: crate::ecma_json::HARD_NODES,
                number_bytes: crate::ecma_json::HARD_NUMBER_BYTES,
            };
            let text = crate::ecma_json::stringify(&value, limits).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            serde_json::from_str(&text).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
        };
        let shared = self.show_rule_service_record(&label)?;
        let context = self.show_rule_service_record(&context_label)?;
        Ok((plain(shared)?, plain(context)?))
    }

    pub(super) fn show_rule_service_record(&mut self, label: &str) -> AccountResult<Value> {
        let admitted = tools_json(&self.source.selected.root, "service-records")?;
        if !arr(get(&admitted, "labels"))
            .iter()
            .any(|v| text(v).as_deref() == Some(label))
            || !matches!(label, "show-rules" | "setup-context")
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        self.assert_owned()?;
        let now = self.source.clock()?;
        let bytes = self.source.read_kv_bytes_bounded(
            &format!("service-record:{label}"),
            now,
            4 * 1024 * 1024,
        )?;
        let value = match bytes {
            None => Value::Null,
            Some(bytes) => get(&parse(&bytes)?, "value")
                .cloned()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        };
        self.assert_owned()?;
        Ok(value)
    }
    fn show_rule_sources<A: ViewerAdmission, R>(
        &mut self,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        current: &mut impl FnMut(&mut Self) -> AccountResult<(A, [u8; 32])>,
        projection: &mut impl FnMut(&mut Self, &Selection, Arc<AtomicBool>, Instant) -> AccountResult<(Snapshot, R)>,
    ) -> AccountResult<Sources<A, R>> {
        checked(&cancel, deadline)?;
        let (admitted, policy) = current(self)?;
        // A receipt that names no operator proves there is none (`startup_service_setting`): an account made by `account
        // create` reads its show rules as its own person, as service_records.rs `is_operator` already reads it.
        let operator = self.startup_service_setting("OPERATOR_ACCOUNT_ID")?;
        let authority = if operator.as_deref() == Some(admitted.account().user_id.as_str()) {
            Authority::Operator
        } else {
            Authority::Personal
        };
        let root = self.source.selected.root.clone();
        let data = tools_json(&root, "show-rules")?;
        let setup = tools_json(&root, "setup-steps")?;
        let label = field(&data, "record").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let context_label = get(&setup, "policy")
            .and_then(|v| field(v, "context_record"))
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let mut labels = vec![label.clone()];
        if authority == Authority::Operator {
            labels.push(context_label.clone());
        }
        let receiving = crate::account_rights::share_given::Receiving::shipped()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let prefixes = vec![receiving.record_prefix().to_owned()];
        let (snapshot, retained) = projection(self, &Selection { labels, prefixes }, cancel.clone(), deadline)?;
        let mut rows: BTreeMap<String, Value> = snapshot.records.into_iter().collect();
        let given_labels: Vec<String> =
            rows.keys().filter(|label| label.starts_with(receiving.record_prefix())).cloned().collect();
        let given_rows: BTreeMap<String, Value> =
            given_labels.iter().filter_map(|label| rows.remove_entry(label)).collect();
        let given = self.given_show_types(receiving, &admitted.account().user_id, given_rows)?;
        checked(&cancel, deadline)?;
        let personal = rows
            .remove(&label)
            .filter(|v| matches!(v, Value::Object(_)));
        // Trillion's defaults for this record (the default publisher's rows in the account's installed tools) are laid under
        // the person's own record at every read and never written into their store; what the person changed wins
        // (src/records/shipped_defaults.rs). The stamp below covers them, so a new deploy of the defaults is a change.
        let personal = laid_under_defaults(&self.source.selected.root, &label, personal);
        let (giver, context) = if authority == Authority::Operator {
            (
                personal.clone().unwrap_or(Value::Null),
                rows.remove(&context_label).unwrap_or(Value::Null),
            )
        } else {
            (
                self.show_rule_service_record(&label)?,
                self.show_rule_service_record(&context_label)?,
            )
        };
        let mut source = obj();
        put(
            &mut source,
            "personal",
            personal.clone().unwrap_or(Value::Null),
        );
        put(&mut source, "giver", giver.clone());
        put(&mut source, "context", context.clone());
        put(&mut source, "operator", operator.map_or(Value::Null, word));
        put(&mut source, "given", Value::Array(given.clone()));
        // Gate observations bind the complete original policy view, including
        // current controls. This digest is private and is never serialized.
        put(&mut source, "policy", word(blake3::Hash::from_bytes(policy).to_hex().to_string()));
        let (final_admitted, final_policy) = current(self)?;
        if !admitted.same(&final_admitted) || policy != final_policy {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        checked(&cancel, deadline)?;
        self.assert_owned()?;
        Ok(Sources {
            admitted,
            retained,
            stamp: hash(&source)?,
            personal,
            giver,
            context,
            authority,
            given,
        })
    }
    /// The types the person's given shares give now: `rows` are the records under the given prefix, each read at its sharer's door with the key the person's vault holds for it,
    /// kept for the service records' `read_seconds`. No given share reads no vault and no door; a read that fails is
    /// unavailable, never no rules.
    fn given_show_types(&mut self, receiving: &crate::account_rights::share_given::Receiving, person: &str,
        rows: BTreeMap<String, Value>) -> AccountResult<Vec<Value>> {
        use crate::account_rights::share_given::{HttpsDoor, Kept};
        let records: BTreeMap<String, serde_json::Value> = rows
            .into_iter()
            .map(|(label, value)| {
                let text = ecma_json::stringify(&value, Default::default()).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                Ok((label, serde_json::from_str(&text).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?))
            })
            .collect::<AccountResult<_>>()?;
        let given = receiving.given(&records).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if given.is_empty() {
            return Ok(Vec::new());
        }
        let seconds = match get(&tools_json(&self.source.selected.root, "service-records")?, "read_seconds") {
            Some(Value::Number(n)) if n.is_finite() && *n >= 0.0 => *n,
            _ => return Err(crate::cause!(AccountError::SourceUnavailable)),
        };
        let vault = crate::secrets::open_home(&self.source.selected.root, &self.source.account.owner_id)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let types = Kept::process()
            .types(receiving, &*vault, &HttpsDoor, person, &given, Duration::from_secs_f64(seconds), Instant::now())
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        types
            .iter()
            .map(|ty| {
                let text = serde_json::to_string(ty).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                parse(text.as_bytes())
            })
            .collect()
    }
    pub fn current_show_rules(
        &mut self, session: &str, locale: &QualifiedLocale, cancel: Arc<AtomicBool>,
    ) -> AccountResult<(Value, ShowRulesDeliveryWitness)> {
        self.current_show_rules_admitted(locale, cancel, Instant::now() + Duration::from_secs(2),
            &mut |owner| browser_admission(owner, session),
            &mut |owner, selection, cancel, _| owner.workspace_snapshot(session, Some(selection), cancel)
                .map(|snapshot| (snapshot, ())).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error)),
            &mut |_, _| Ok(()))
    }
    /// One canonical source/projector/witness owner for independently proved
    /// admissions. Callbacks are supplied only by the original browser or key
    /// owner; neither transport manufactures the other's admission or session.
    pub(crate) fn current_show_rules_admitted<A: ViewerAdmission, R>(
        &mut self, locale: &QualifiedLocale, cancel: Arc<AtomicBool>, deadline: Instant,
        current: &mut impl FnMut(&mut Self) -> AccountResult<(A, [u8; 32])>,
        projection: &mut impl FnMut(&mut Self, &Selection, Arc<AtomicBool>, Instant) -> AccountResult<(Snapshot, R)>,
        retained_current: &mut impl FnMut(&mut Self, &R) -> AccountResult<()>,
    ) -> AccountResult<(Value, ShowRulesDeliveryWitness<A, R>)> {
        let deadline = deadline.min(Instant::now() + Duration::from_secs(2));
        let source = self.show_rule_sources(cancel.clone(), deadline, current, projection)?;
        let root = self.source.selected.root.clone();
        let data = tools_json(&root, "show-rules")?;
        let operators = tools_json(&root, "rule-operators")?;
        let context = given_context(&root, &source)?;
        let mut formula = rules::formula::RuleFormulaOwner::new(
            &operators,
            locale,
            FormulaBindingEvaluator,
            rule_bindings::Limits::default(),
        );
        let mut edit = match source.personal.as_ref().and_then(|v| get(v, "edit_rules")) {
            Some(Value::Array(a)) => a.clone(),
            _ => arr(get(
                get(&data, "edit_authority").unwrap_or(&Value::Null),
                "starting_rules",
            ))
            .to_vec(),
        };
        edit.retain(|v| {
            matches!(v, Value::Object(_)) && !matches!(get(v, "on"), Some(Value::Bool(false)))
        });
        edit.extend(
            rules::current_given_edit_rules(
                &data,
                Some(&context),
                &mut formula,
                rules::Limits::default(),
            )
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?,
        );
        let attribute_fields = declared_tags(
            &root,
            source
                .personal
                .as_ref()
                .and_then(|v| get(v, "attribute_fields")),
        )?;
        let mut owner = ReadOwner {
            record: source.personal.clone(),
            context,
            authority: source.authority,
            edit,
            attribute_fields,
            operators: operators.clone(),
            controls: controls(&root)?,
        };
        let mut clock = clock::GetClock;
        let result = rules::ShowRules {
            data: &data,
            owner: &mut owner,
            formula: &mut formula,
            clock: &mut clock,
            limits: rules::Limits::default(),
        }
        .read()
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut until = None;
        let now = clock.now_ms().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        for rule in arr(get(&result, "rules")) {
            if let Some(v) = get(rule, "until") {
                if let Value::String(_) = v {
                    if let Some(at) = clock
                        .date_parse(v)
                        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
                    {
                        if at <= now { return Err(crate::cause!(AccountError::SourceChanged)); }
                        until = Some(until.map_or(at, |old: i64| old.min(at)));
                    }
                }
            }
        }
        let witness = ShowRulesDeliveryWitness {
            admitted: source.admitted,
            retained: source.retained,
            stamp: source.stamp,
            deadline,
            until,
        };
        self.assert_show_rules_admitted_current(cancel, &witness, current, projection, retained_current)?;
        Ok((result, witness))
    }
    pub fn assert_show_rules_delivery_current(
        &mut self, session: &str, cancel: Arc<AtomicBool>, witness: &ShowRulesDeliveryWitness,
    ) -> AccountResult<()> {
        self.assert_show_rules_admitted_current(cancel, witness,
            &mut |owner| browser_admission(owner, session),
            &mut |owner, selection, cancel, _| owner.workspace_snapshot(session, Some(selection), cancel)
                .map(|snapshot| (snapshot, ())).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error)),
            &mut |_, _| Ok(()))
    }
    pub(crate) fn assert_show_rules_admitted_current<A: ViewerAdmission, R>(
        &mut self, cancel: Arc<AtomicBool>, witness: &ShowRulesDeliveryWitness<A, R>,
        current: &mut impl FnMut(&mut Self) -> AccountResult<(A, [u8; 32])>,
        projection: &mut impl FnMut(&mut Self, &Selection, Arc<AtomicBool>, Instant) -> AccountResult<(Snapshot, R)>,
        retained_current: &mut impl FnMut(&mut Self, &R) -> AccountResult<()>,
    ) -> AccountResult<()> {
        checked(&cancel, witness.deadline)?;
        if let Some(until) = witness.until {
            if clock::GetClock.now_ms().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))? >= until {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
        }
        let fresh = self.show_rule_sources(cancel.clone(), witness.deadline, current, projection)?;
        if !fresh.admitted.same(&witness.admitted) || fresh.stamp != witness.stamp {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        retained_current(self, &witness.retained)?;
        // Source verification itself can cross the returned rule's expiry.
        // This is a clock check only; no owner read follows physical custody.
        if let Some(until) = witness.until {
            if clock::GetClock.now_ms().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))? >= until {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
        }
        checked(&cancel, witness.deadline)
    }
}
/// The person's record of `label` with the installed tools' published default for it laid under, or as it is when
/// they publish none.
fn laid_under_defaults(state_root: &std::path::Path, label: &str, personal: Option<Value>) -> Option<Value> {
    match crate::tool_runs::tools::shipped_defaults::for_record(state_root, label) {
        Some(row) => crate::records::shipped_defaults::lay_under(&row, personal.as_ref()),
        None => personal,
    }
}
fn browser_admission(owner: &mut LocalAccount, session: &str) -> AccountResult<(BrowserAdmission, [u8; 32])> {
    let (admitted, gate) = owner.current_window_with_policy(session)?;
    let bytes = Zeroizing::new(serde_json::to_vec(&gate.snapshot).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?);
    Ok((admitted, *blake3::hash(&bytes).as_bytes()))
}

fn declared_tags(root: &std::path::Path, declared: Option<&Value>) -> AccountResult<Value> {
    let work = tools_json(root, "work-for-ais")?;
    let fixed: BTreeSet<String> = arr(get(&work, "facts"))
        .iter()
        .filter_map(|v| field(v, "id"))
        .collect();
    Ok(Value::Array(
        arr(declared)
            .iter()
            .filter(|v| {
                field(v, "kind").as_deref() == Some("tags")
                    && field(v, "id").is_some_and(|id| !fixed.contains(&id))
            })
            .cloned()
            .collect(),
    ))
}
fn needed_fields(v: &Value, fields: &mut BTreeSet<String>, depth: usize) -> AccountResult<()> {
    if depth > 128 {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    if field(v, "kind").as_deref() == Some("rule") {
        if let Some(id) = field(v, "field") {
            fields.insert(id);
        }
    }
    if field(v, "kind").as_deref() == Some("group") {
        for child in arr(get(v, "rules")) {
            needed_fields(child, fields, depth + 1)?;
        }
    }
    Ok(())
}
fn given_context<A: ViewerAdmission, R>(root: &std::path::Path, s: &Sources<A, R>) -> AccountResult<GivenContext> {
    let setup = tools_json(root, "setup-steps")?;
    let work = tools_json(root, "work-for-ais")?;
    let policy = get(&setup, "policy").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    let key = field(policy, "account_context_key").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    let entry = get(&s.context, &key)
        .and_then(|v| get(v, &s.admitted.account().user_id))
        .unwrap_or(&Value::Null);
    // No type ships in DATA: only the giver's own record keeps types (old trillion 190f72754e typesOf).
    let mut types: Vec<Value> = Vec::new();
    for ty in arr(get(&s.giver, "types")) {
        if let Some(id) = field(ty, "id") {
            if let Some(at) = types
                .iter()
                .position(|v| field(v, "id").as_deref() == Some(&id))
            {
                types[at] = ty.clone()
            } else {
                types.push(ty.clone())
            }
        }
    }
    // A preset someone shared with this person (`account_rights::share_given`) gives its types the same way.
    for ty in &s.given {
        if let Some(id) = field(ty, "id") {
            if let Some(at) = types.iter().position(|v| field(v, "id").as_deref() == Some(&id)) {
                types[at] = ty.clone()
            } else {
                types.push(ty.clone())
            }
        }
    }
    let mut needed = BTreeSet::new();
    for ty in &types {
        if let Some(a) = get(ty, "audience") {
            needed_fields(a, &mut needed, 0)?;
        }
        for rule in arr(get(ty, "edit_rules")) {
            if let Some(a) = get(rule, "audience") {
                needed_fields(a, &mut needed, 0)?;
            }
        }
    }
    for family in ["rules", "edit_rules"] {
        for rule in arr(get(&s.giver, family)) {
            if !matches!(get(rule, "on"), Some(Value::Bool(false))) {
                if let Some(a) = get(rule, "audience") {
                    needed_fields(a, &mut needed, 0)?;
                }
            }
        }
    }
    let mut fields = arr(get(&work, "facts")).to_vec();
    fields.extend(
        arr(Some(&declared_tags(root, get(&s.giver, "attribute_fields"))?))
            .iter()
            .cloned(),
    );
    let mut facts = obj();
    put(
        &mut facts,
        "cohorts",
        Value::Array(arr(get(entry, "cohorts")).to_vec()),
    );
    let tags: BTreeSet<String> = fields
        .iter()
        .filter(|v| field(v, "kind").as_deref() == Some("tags"))
        .filter_map(|v| field(v, "id"))
        .collect();
    for id in needed {
        let value = match id.as_str() {
            "account_id" => word(s.admitted.account().user_id.clone()),
            "operator" => Value::Bool(s.authority == Authority::Operator),
            "ai_connected" => Value::Bool(true),
            "cohorts" | "experiments" => Value::Array(arr(get(entry, &id)).to_vec()),
            "bucket" => {
                let epoch = field(policy, "bucket_epoch").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
                let count = if let Some(Value::Number(n)) = get(policy, "bucket_count") {
                    *n
                } else {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                };
                if !count.is_finite()
                    || count < 1.0
                    || count.fract() != 0.0
                    || count > 9_007_199_254_740_991.0
                {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                }
                let mut h = 0x811c9dc5u32;
                for unit in format!("{epoch}:{}", s.admitted.account().user_id).encode_utf16() {
                    h = (h ^ u32::from(unit)).wrapping_mul(0x01000193)
                }
                Value::Number((f64::from(h) / 4294967296.0 * count).floor())
            }
            // Access/creation/setup owners are not yet joined here. Unknown is
            // not null/free/false; only an audience that needs them is refused.
            "plan" | "offers" | "capabilities" | "created_at" | "setup_included" | "setup_done" => {
                return Err(crate::cause!(AccountError::SourceUnavailable))
            }
            _ if tags.contains(&id) => {
                let value = get(entry, "attributes").and_then(|v| get(v, &id));
                match value {
                    Some(Value::Array(a)) if a.iter().all(|v| matches!(v, Value::String(_))) => {
                        Value::Array(a.clone())
                    }
                    _ => Value::Null,
                }
            }
            _ => return Err(crate::cause!(AccountError::SourceUnavailable)),
        };
        put(&mut facts, &id, value);
    }
    Ok(GivenContext {
        giver: s.giver.clone(),
        facts,
        space_types: vec![],
        audience_fields: fields,
    })
}
fn controls(root: &std::path::Path) -> AccountResult<Value> {
    let mut rows = Vec::<(String, Value)>::new();
    // Each part's workspace controls, in the order the product declares them
    // (the tools' controls.json `parts`: sidebar, screen arrangement, Find
    // anything, shared UI); the first declaration of a path keeps its words.
    for part in arr(get(&tools_json(root, "controls")?, "parts")) {
        for row in arr(get(part, "controls")) {
            if let Some(id) = field(row, "id") {
                if !rows.iter().any(|(k, _)| k == &id) {
                    let label = get(row, "label")
                        .cloned()
                        .unwrap_or_else(|| word(id.clone()));
                    rows.push((id, label));
                }
            }
        }
    }
    for row in arr(get(&tools_json(root, "open-choices")?, "choices")) {
        let suffix = get(row, "id")
            .and_then(text)
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let id = format!("open.{suffix}");
        if !rows.iter().any(|(k, _)| k == &id) {
            rows.push((id, get(row, "label").cloned().unwrap_or(Value::Null)));
        }
    }
    Ok(Value::Array(
        rows.iter()
            .map(|(id, label)| {
                let mut row = obj();
                put(&mut row, "id", word(id.clone()));
                put(&mut row, "label", label.clone());
                let mut cut = id.rfind('.');
                while let Some(at) = cut {
                    let parent = &id[..at];
                    if rows.iter().any(|(k, _)| k == parent) {
                        put(&mut row, "parent", word(parent));
                        break;
                    }
                    cut = parent.rfind('.');
                }
                row
            })
            .collect(),
    ))
}
struct ReadOwner {
    record: Option<Value>,
    context: GivenContext,
    authority: Authority,
    edit: Vec<Value>,
    attribute_fields: Value,
    operators: Value,
    controls: Value,
}
impl CurrentOwner for ReadOwner {
    fn assert_current(&mut self) -> rules::Result<()> {
        Ok(())
    } // provisional; LocalAccount owns mandatory final recheck
    fn authority(&mut self) -> rules::Result<Authority> {
        Ok(self.authority)
    }
    fn personal_record(&mut self, _: &str) -> rules::Result<Option<Value>> {
        Ok(self.record.clone())
    }
    fn given_context(&mut self, space: Option<&str>) -> rules::Result<Option<GivenContext>> {
        if space.is_some() {
            return Err(crate::cause!(rules::Error::Unavailable));
        }
        Ok(Some(self.context.clone()))
    }
    fn thing_facts(&mut self, _: &[Value], _: &Value, _: i64) -> rules::Result<Value> {
        Err(crate::cause!(rules::Error::Unavailable))
    }
    fn edit_rules_now(&mut self, _: Option<&Value>, _: Authority, _: i64) -> rules::Result<Value> {
        let mut v = obj();
        put(&mut v, "rules", Value::Array(self.edit.clone()));
        Ok(v)
    }
    fn attribute_fields(&mut self, _: Option<&Value>) -> rules::Result<Value> {
        Ok(self.attribute_fields.clone())
    }
    fn controls(&mut self) -> rules::Result<Value> {
        Ok(self.controls.clone())
    }
    fn operators(&mut self) -> rules::Result<Value> {
        Ok(Value::Array(
            arr(get(&self.operators, "operators"))
                .iter()
                .filter_map(|v| {
                    get(v, "id").cloned().or_else(|| {
                        if !matches!(v, Value::Object(_)) {
                            Some(v.clone())
                        } else {
                            None
                        }
                    })
                })
                .collect(),
        ))
    }
}
