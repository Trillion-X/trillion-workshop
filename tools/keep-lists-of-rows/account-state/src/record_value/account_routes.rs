// src/record_value/account_routes.rs
//
// Purpose: The account routes' generic read of an account's own records: one record by id, one page of a kind through the
// generic list read (`record_value::list`), or one page of a record's version history (`record_value::history`).
// The operation names, the resource, the default page and which of these
// operations a tool run may be granted (with the input paths naming the kinds each touches) are product DATA
// (`records-routes.json`). No kind, order, field or tool is named here.
//
// Non-Negotiable Invariants:
// - Every record answered is opened through `record_value::read` (sealed fields, erasure, shared expansion), under
//   the caller's admission; this module only shapes the input and the answer.
// - A read that names a type answers a record of another type exactly as a missing record (value null), so the
//   answer never tells a caller that an id holds a record of a kind it did not ask for.
// - Unknown input fields refuse (`Invalid`); each list answer walks at most LIST_SCAN_BUDGET positions and returns
//   its exact cursor when work or answer bytes cut the page.
//
// Key Concepts:
// - Cursor: a page's `next` is one text, the order value (base64url of its UTF-16 code units, as the store keys it)
//   and the id, joined by `~` (never in base64url). A caller hands it back unchanged as `after`.
// - Run rules (`run_operations`, read by `account_rights::run_rules`): what one call of each operation touches, so a
//   run capability can be narrowed to it.
//
// Security Considerations:
// - This module is no admission. The account's routes call it only after the person's key (or a run capability narrowed to the
//   kinds it names) was admitted; the answer leaves only through that caller's disclosure.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    history::{self, VersionSupply},
    list::{self, ListQuery, ListRange, OrderedSupply, MAX_LIST_ROWS},
    read, search, Error, Limits, LogicalRecord, OpenPolicy, Result,
};
use crate::account_rights::run_rules::Rules;
use crate::mcp::InputFault;
use crate::record_model_policy::Installed;
use crate::storage::{kind_views::KindSchemas, record_store::OrderCursor};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

/// The declared product DATA file this owner is read from.
const DATA: &[u8] = include_bytes!("records-routes.json");
/// Joins a cursor's order value and id; base64url never holds it.
const CURSOR_MARK: char = '~';
/// The most field names one list may ask for (its `fields`).
const MAX_PROJECTED_FIELDS: usize = 64;
/// The rows a list page reads at a time before it checks that what it read still fits one answer.
const LIST_CHUNK: usize = 32;
/// An answer may inspect only this many order positions or ids (including lookahead) before returning a continuation.
const LIST_SCAN_BUDGET: usize = list::MAX_LIST_WALK;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    resource: String,
    read: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(rename = "_result_read", default)]
    _result_read: String,
    #[serde(rename = "_current_read_identity", default)]
    _current_read_identity: String,
    list: String,
    list_page: usize,
    /// The order positions or ids one `where` list answer may walk before it returns a continuation: a filter reads
    /// the whole list, not one page of it.
    where_walk_most: usize,
    /// One question over every record the account keeps (`record_value::search`).
    search: search::SearchSettings,
    history: String,
    references: super::references::Settings,
    history_max: usize,
    outside_choices: String,
    /// The operation that issues a one-use challenge for the person present to confirm one write
    /// (`account::person_present`); none when these routes issue none.
    #[serde(default)]
    person_present: Option<String>,
    instructions: InstructionsFile,
    wake: WakeOperations,
    run_operations: Rules,
    #[serde(rename = "_homes", default)]
    _homes: String,
    /// Where a kind's records live when they left the primary store (`Homes`); none when these routes keep no homes.
    #[serde(default)]
    homes: Option<Homes>,
    #[serde(rename = "_old_paths")]
    _old_paths: String,
    /// The paths old trillion's page called for one record, each one of these reads (`account_files::page_paths`).
    old_paths: crate::account_files::page_paths::OldPaths,
}

/// Where a kind's records live when they are not in the primary store: the row `<row_prefix><kind>` names the record
/// domain that holds them, for a kind that starts with one of `kinds` (records-routes.json `_homes`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Homes {
    row_prefix: String,
    kinds: Vec<String>,
}

impl Homes {
    fn valid(&self) -> bool {
        !self.row_prefix.is_empty() && !self.kinds.is_empty() && self.kinds.iter().all(|kind| !kind.is_empty())
    }
    /// Whether records of `kind` may live in a home of their own.
    pub fn kind_has_home(&self, kind: &str) -> bool {
        self.kinds.iter().any(|prefix| kind.len() > prefix.len() && kind.starts_with(prefix.as_str()))
    }
    /// The id of the primary's row that names `kind`'s home.
    pub fn row_id(&self, kind: &str) -> String {
        format!("{}{kind}", self.row_prefix)
    }
}

/// How the installed tools say which of their files holds the rows an AI is told on connecting (src/mcp/instructions.rs
/// reads it): a row of kind `row_kind` in one tool folder's rows file, whose `file` names that folder's list
/// (src/tool_runs/tools/instruction_file.rs). No tool folder is named here.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstructionsFile {
    row_kind: String,
}

/// The account routes' wake operations (answered by the routes with `wake::Waker`, not by a records read).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WakeOperations {
    switch: String,
    causes: String,
}

/// The account routes' records reads and the operations a run may be granted, from DATA.
pub struct Door {
    settings: Settings,
}

/// Exact original record command supplied for protected result recovery. `request_key` is the ORIGINAL command
/// key; the result-read call's outer delivery key never replaces it. This value grants no authority or replay.
#[derive(Clone, PartialEq)]
pub struct RecordResultInput {
    pub request_key: String,
    pub operation: String,
    pub input: Value,
}
impl std::fmt::Debug for RecordResultInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecordResultInput([redacted])")
    }
}

impl Door {
    /// The shipped DATA, read and checked once per process.
    pub fn shipped() -> Result<&'static Door> {
        static SHIPPED: OnceLock<Result<Door>> = OnceLock::new();
        SHIPPED
            .get_or_init(|| {
                let bytes = DATA;
                Door::from_data(bytes)
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn from_data(bytes: &[u8]) -> Result<Door> {
        let settings: Settings = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        if settings.resource.is_empty()
            || settings.read.is_empty()
            || settings.list.is_empty()
            || settings.history.is_empty()
            || [&settings.read, &settings.list].contains(&&settings.history)
            || settings.wake.switch.is_empty()
            || settings.wake.causes.is_empty()
            || settings.wake.switch == settings.wake.causes
            || settings.outside_choices.is_empty()
            || settings.instructions.row_kind.is_empty()
            || [&settings.read, &settings.list, &settings.history]
                .contains(&&settings.outside_choices)
            || [
                &settings.read,
                &settings.list,
                &settings.history,
                &settings.outside_choices,
            ]
            .iter()
            .any(|records| [&settings.wake.switch, &settings.wake.causes].contains(records))
            || settings.read == settings.list
            || settings.result.as_deref().is_some_and(|result| {
                result.is_empty()
                    || [
                        &settings.read,
                        &settings.list,
                        &settings.history,
                        &settings.outside_choices,
                        &settings.references.operation,
                        &settings.search.operation,
                        &settings.wake.switch,
                        &settings.wake.causes,
                    ]
                    .iter()
                    .any(|operation| operation.as_str() == result)
                    || settings.person_present.as_deref() == Some(result)
            })
            || !(1..=MAX_LIST_ROWS).contains(&settings.history_max)
            || !(1..=MAX_LIST_ROWS).contains(&settings.list_page)
            || settings.where_walk_most < LIST_SCAN_BUDGET
            || !settings.references.valid()
            || [
                &settings.read,
                &settings.list,
                &settings.history,
                &settings.outside_choices,
                &settings.search.operation,
                &settings.wake.switch,
                &settings.wake.causes,
            ]
            .contains(&&settings.references.operation)
            || settings.person_present.as_ref() == Some(&settings.references.operation)
            || !settings.search.valid()
            || [
                &settings.read,
                &settings.list,
                &settings.history,
                &settings.outside_choices,
                &settings.wake.switch,
                &settings.wake.causes,
            ]
            .contains(&&settings.search.operation)
            || settings.person_present.as_ref() == Some(&settings.search.operation)
            || !settings.run_operations.valid()
            || settings.homes.as_ref().is_some_and(|homes| !homes.valid())
            || settings.person_present.as_ref().is_some_and(|operation| {
                operation.is_empty()
                    || [
                        &settings.read,
                        &settings.list,
                        &settings.history,
                        &settings.outside_choices,
                        &settings.wake.switch,
                        &settings.wake.causes,
                    ]
                    .contains(&operation)
            })
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let door = Door { settings };
        if !door
            .settings
            .old_paths
            .valid(&|operation| door.answers(&door.settings.resource, operation))
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(door)
    }

    /// The resource every records operation is addressed to.
    pub fn resource(&self) -> &str {
        &self.settings.resource
    }

    /// Where a kind's records live when they left the primary store; none when these routes keep no homes.
    pub fn homes(&self) -> Option<&Homes> {
        self.settings.homes.as_ref()
    }

    /// Send a records call for one kind to that kind's home (records-routes.json `_homes`), the one rule every road to
    /// this door takes (an AI's call, src/native_boot/mcp_local.rs; the page's, src/local_workspace.rs). `input` is the
    /// call's input, `writes` whether `operation` is the records write, and `read_home` reads one row of the primary by
    /// id under the caller's own admission, answering its value. A list moved into a store of its own (old trillion
    /// src/placed-lists.mjs invariant 1: "One store answers for a list's rows: its home") keeps its rows in a record
    /// domain (src/storage/record_store_resources/domains.rs) named by its `home:` row; a call naming no scope and one
    /// such kind (a read or list by `type`, a write whose records are all of it) gets that scope, as if the caller had
    /// named it. A call that names a scope, or no single homed kind, is left as it is. `scope: null` names the primary
    /// itself and is taken out of the input: the move reads what is left there and removes it, so a write so addressed
    /// may only remove. Answers false when the call is refused: a write mixing a homed kind with another (one command
    /// writes one history), or a write to the primary that is not a removal.
    pub fn to_home<E>(&self, operation: &str, input: &mut Value, writes: bool,
        read_home: &mut dyn FnMut(&str) -> std::result::Result<Value, E>) -> std::result::Result<bool, E> {
        let Some(homes) = self.homes() else { return Ok(true) };
        let Some(fields) = input.as_object_mut() else { return Ok(true) };
        if fields.get("scope").is_some_and(Value::is_null) {
            let only_removals = fields.get("records").and_then(Value::as_array)
                .is_some_and(|records| records.iter().all(|record| record.get("value").is_some_and(Value::is_null)));
            fields.remove("scope");
            return Ok(!writes || only_removals);
        }
        if fields.contains_key("scope") { return Ok(true) }
        let kinds: std::collections::BTreeSet<String> = if writes {
            fields.get("records").and_then(Value::as_array).into_iter().flatten()
                .filter_map(|record| record.get("type").and_then(Value::as_str).map(str::to_owned)).collect()
        } else if operation == self.settings.read || operation == self.settings.list || operation == self.settings.history
            || operation == self.settings.search.operation {
            fields.get("type").and_then(Value::as_str).map(str::to_owned).into_iter().collect()
        } else { return Ok(true) };
        let mut scopes = Vec::with_capacity(kinds.len());
        for kind in &kinds {
            let scope = if homes.kind_has_home(kind) {
                read_home(&homes.row_id(kind))?.get("scope").filter(|scope| scope.is_object()).cloned()
            } else { None };
            scopes.push(scope);
        }
        match scopes.iter().flatten().next() {
            None => Ok(true),
            Some(scope) if scopes.len() == 1 => {
                let mut scope = scope.clone();
                if writes { scope["create"] = Value::Bool(false) }
                fields.insert("scope".into(), scope);
                Ok(true)
            }
            Some(_) => Ok(false),
        }
    }

    /// The read of one record.
    pub fn read_operation(&self) -> &str {
        &self.settings.read
    }

    /// The protected original-command result reader, mounted by the native journal owner, not a logical value read.
    pub fn result_operation(&self) -> Option<&str> {
        self.settings.result.as_deref()
    }
    pub fn answers_result(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource && self.result_operation() == Some(operation)
    }
    pub fn result_input(&self, input: &Value) -> Result<RecordResultInput> {
        result_input(object_of(input)?).map_err(Error::from)
    }

    /// The bounded reverse lookup over declared record parts.
    pub fn references_operation(&self) -> &str {
        &self.settings.references.operation
    }

    /// The read of one page of a kind.
    pub fn list_operation(&self) -> &str {
        &self.settings.list
    }

    /// The one question over every record the account keeps.
    pub fn search_operation(&self) -> &str {
        &self.settings.search.operation
    }

    /// The read of one page of a record's version history.
    pub fn history_operation(&self) -> &str {
        &self.settings.history
    }

    /// The kind of the tool row that names the file holding the rows an AI is told on connecting.
    pub fn instructions_row_kind(&self) -> &str {
        &self.settings.instructions.row_kind
    }

    /// The read of one page of a list definition's rows whose values are outside its fields' choices.
    pub fn outside_choices_operation(&self) -> &str {
        &self.settings.outside_choices
    }

    /// The switch of one declared wake, on or off.
    pub fn wake_switch_operation(&self) -> &str {
        &self.settings.wake.switch
    }

    /// The read of what the person's causes screen shows.
    pub fn wake_causes_operation(&self) -> &str {
        &self.settings.wake.causes
    }

    /// The operation that issues a challenge for the person present to confirm one write, when these routes have one.
    pub fn person_present_operation(&self) -> Option<&str> {
        self.settings.person_present.as_deref()
    }

    /// Whether `operation` at `resource` asks for a challenge for the person present.
    pub fn answers_person_present(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource
            && self.settings.person_present.as_deref() == Some(operation)
    }

    /// Whether `operation` at `resource` is one of these routes' wake operations (a switch or the causes read).
    pub fn answers_wake(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource
            && (operation == self.settings.wake.switch || operation == self.settings.wake.causes)
    }

    /// Whether this owner answers `operation` at `resource` (a read, a list, a history or an outside-choices read).
    pub fn answers(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource
            && (operation == self.settings.read
                || operation == self.settings.list
                || operation == self.settings.history
                || operation == self.settings.outside_choices
                || operation == self.settings.search.operation
                || operation == self.settings.references.operation)
    }

    /// A page's call of these routes' records read, as the page's route table sends it: the row whose family is
    /// their resource (src/server/owner-routes.json) makes the operation `<resource>:request` with input
    /// {path, method, body}. The path's last segment names the read, list or history operation and the query's one
    /// `input` field holds its JSON input object (none is `{}`). `None` when `operation` is not that family; a call
    /// with another method, another operation (a write or a wake), another query field or an input that is not a
    /// JSON object is refused. The page's session admits it; no key is involved. The path may also name the challenge
    /// operation for the person present (`person_present_operation`), so the page asks for the challenge a refused
    /// write named; it is answered by the caller, never as a read (`local_workspace::read_door`).
    /// A path old trillion's page called for one record (DATA `old_paths`: GET /records/<id>) is first made into the
    /// read its row names, with the input as the old route took it (`account_files::page_paths`).
    pub fn page_call(&self, operation: &str, input: &Value) -> Option<Result<(String, Value)>> {
        if operation.strip_suffix(":request") != Some(self.settings.resource.as_str()) {
            return None;
        }
        // A path under old trillion's page road to this door that no row takes, under any method, has no owner here
        // (404 no-owner): it is not ported (`page_paths::OldPaths::unported`).
        if self.settings.old_paths.unported(
            input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            return None;
        }
        let call = || -> Result<(String, Value)> {
            let target = input
                .get("path")
                .and_then(Value::as_str)
                .ok_or(crate::cause!(Error::Invalid))?;
            let method = input
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // A path old trillion's page called is the read its DATA row names, with the input as the old route took it.
            if let Some(call) = self
                .settings
                .old_paths
                .call(method, target, input.get("body"))
            {
                return call.map_err(|error| crate::carry_cause!(Error::Invalid, error));
            }
            if method != "GET" {
                return Err(crate::cause!(Error::Invalid));
            }
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            let decode = |text: &str, form| {
                crate::workspace_domain::decode(text, form).map_err(|error| crate::carry_cause!(Error::Invalid, error))
            };
            let name = decode(path.rsplit('/').next().unwrap_or_default(), false)?;
            if !self.answers(&self.settings.resource, &name)
                && !self.answers_person_present(&self.settings.resource, &name)
            {
                return Err(crate::cause!(Error::Invalid));
            }
            let mut given = None;
            for pair in query.split('&').filter(|pair| !pair.is_empty()) {
                match pair.split_once('=') {
                    Some(("input", text)) if given.is_none() => given = Some(decode(text, true)?),
                    _ => return Err(crate::cause!(Error::Invalid)),
                }
            }
            let given = match given {
                None => Value::Object(Map::new()),
                Some(text) => serde_json::from_str(&text).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            };
            if !given.is_object() {
                return Err(crate::cause!(Error::Invalid));
            }
            Ok((name, given))
        };
        Some(call())
    }

    /// What a run may be granted here: each operation's rule of what one call touches (`account_rights::run_rules`).
    pub fn run_rules(&self) -> &Rules {
        &self.settings.run_operations
    }

    /// Answer one records read on `supply`, every record opened under `policy` within `limits`. The answer is one
    /// that `fits` admits (the caller's message bound): a list or history page shows as many leading rows as fit,
    /// its `next` the position after the last one shown; an answer of one record, or of a first row, that does not
    /// fit alone is delivered as pages of its own bytes (`mcp::byte_page`): the call that cannot be answered whole
    /// answers `{"byte_page": ..}` for the one record (a list or history: its first row, as a page of one row), and
    /// the same call with `after_byte` (the page's `next_after_byte`) answers the page from there. A reader joins the
    /// pages' bytes, checks their length and BLAKE3 against `total` and `blake3`, and parses the answer it would have
    /// had. No record is refused for its size.
    pub fn answer(
        &self,
        operation: &str,
        input: &Value,
        supply: &mut (impl OrderedSupply + VersionSupply + KindSchemas),
        model: &Installed,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value> {
        self.answer_scoped(operation, input, supply, model, limits, fits, false, "")
    }

    /// The same generic read with the admitted caller's privacy boundary. Reverse lookups bind their opaque
    /// continuation to `scope` (account and sign-in), filter local-only holders for remote callers and never return
    /// raw index work counts. The native caller keeps the ordinary record-read scope current until disclosure.
    pub fn answer_scoped(
        &self,
        operation: &str,
        input: &Value,
        supply: &mut (impl OrderedSupply + VersionSupply + KindSchemas),
        model: &Installed,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
        remote: bool,
        scope: &str,
    ) -> Result<Value> {
        let domain = record_domain(input)?;
        if domain != supply.record_domain() { return Err(crate::cause!(Error::Invalid)); }
        let context = supply.record_generation()?.map(|generation| json!({"generation":generation}));
        supply.set_model(model)?;
        // A model standing in for a refused join says so at the top of every answer, never inside a record's context (that is
        // a history identity); the byte bound counts it.
        let degraded = model.degraded();
        let bind = |answer: &mut Value| {
            if let Some(domain) = &domain { bind_record_domain(answer, domain); }
            if let Some(context) = &context { bind_record_context(answer, context); }
            if let (Some(degraded), Some(object)) = (degraded, answer.as_object_mut()) {
                object.insert("record_model".into(), degraded.clone());
            }
        };
        let bound_fits = |answer: &Value| {
            if domain.is_none() && context.is_none() && degraded.is_none() { return fits(answer); }
            let mut shown = answer.clone();
            bind(&mut shown);
            fits(&shown)
        };
        let mut fields = logical_fields(input)?;
        let after_byte = after_byte_of(&mut fields)?;
        // The one guard every door operation passes (`owner_only`, record_model_policy DATA): a named kind the owner keeps
        // is refused, and so is a read or a history of an id whose current record holds one, and an answer that names one.
        // Search skips such rows instead (search.rs), so its every-kind answer shows the rest.
        if fields.get("type").and_then(Value::as_str).is_some_and(|kind| model.owner_only(kind)) {
            return Err(crate::cause!(Error::Invalid));
        }
        if operation == self.settings.read || operation == self.settings.history {
            let by_id = Map::from_iter(fields.get("id").map(|id| ("id".to_owned(), id.clone())));
            let current = read_one(&by_id, supply, model.open_policy(), limits, &mut Derived::of(model))?;
            if current["type"].as_str().is_some_and(|kind| model.owner_only(kind)) {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        // A history answers each version it holds: every live version's kind is checked, the deleted ones included (a soft
        // delete keeps the version's kind). An erased version keeps neither its value nor its kind, so it answers no content.
        if operation == self.settings.history {
            let input = self.history_input(&fields)?;
            let page = supply.versions(input.id, input.before, input.limit)?;
            let owned = page.versions.iter().any(|held| {
                held.stored.as_ref().is_some_and(|stored| model.owner_only(&stored.record_type))
            });
            if owned {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        let whole = match after_byte {
            None => self.answer_fitting(
                operation, &fields, supply, model, limits, &bound_fits, remote, scope,
            ),
            Some(_) => Err(crate::cause!(Error::Bounds)),
        };
        match whole {
            Err(Error::Bounds(_)) => {}
            answered => {
                let answer = answered?;
                if answer["type"].as_str().is_some_and(|kind| model.owner_only(kind)) {
                    return Err(crate::cause!(Error::Invalid));
                }
                let mut answer = answer;
                bind(&mut answer);
                return Ok(answer);
            }
        }
        // The one item the answer would be: a single row of a list or of a history.
        let answer = if operation == self.settings.references.operation {
            super::references::answer_first(
                &fields,
                &self.settings.references,
                supply,
                model,
                limits,
                remote,
                scope,
            )?
        } else {
            if operation != self.settings.read {
                fields.insert("limit".into(), json!(1));
            }
            self.answer_fitting(
                operation,
                &fields,
                supply,
                model,
                limits,
                &|_| true,
                remote,
                scope,
            )?
        };
        let mut answer = answer;
        bind(&mut answer);
        let bytes = serde_json::to_vec(&answer).map_err(|error| crate::carry_cause!(Error::Bounds, error))?;
        let mut page = crate::mcp::byte_page(&bytes, after_byte.unwrap_or(0), &bound_fits).ok_or(crate::cause!(Error::Invalid))?;
        bind(&mut page);
        Ok(page)
    }

    /// `answer` for one input, refusing (`Bounds`) what does not fit alone.
    fn answer_fitting(
        &self,
        operation: &str,
        fields: &Map<String, Value>,
        supply: &mut (impl OrderedSupply + VersionSupply + KindSchemas),
        model: &Installed,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
        remote: bool,
        scope: &str,
    ) -> Result<Value> {
        if operation == self.settings.references.operation {
            return super::references::answer(
                fields,
                &self.settings.references,
                supply,
                model,
                limits,
                fits,
                remote,
                scope,
            );
        }
        let policy = model.open_policy();
        if operation == self.settings.read {
            let record = read_one(fields, supply, policy, limits, &mut Derived::of(model))?;
            return if fits(&record) {
                Ok(record)
            } else {
                Err(crate::cause!(Error::Bounds))
            };
        }
        if operation == self.settings.list {
            return self.list_page(fields, supply, model, limits, fits);
        }
        if operation == self.settings.history {
            return self.history_page(fields, supply, policy, limits, fits);
        }
        if operation == self.settings.outside_choices {
            return self.outside_choices_page(fields, supply, model, limits, fits);
        }
        if operation == self.settings.search.operation {
            let input = search::input(fields, &self.settings.search)?;
            let answer = search::answer(
                input,
                &self.settings.search,
                &self.settings.resource,
                &self.settings.read,
                supply,
                model,
                limits,
            )?;
            return if fits(&answer) {
                Ok(answer)
            } else {
                Err(crate::cause!(Error::Bounds))
            };
        }
        Err(crate::cause!(Error::Invalid))
    }

    fn history_input<'a>(&self, fields: &'a Map<String, Value>) -> Parsed<HistoryInput<'a>> {
        closed(fields, &["id", "before_version", "limit"])?;
        let id = required_text(fields, "id")?;
        let before = match fields.get("before_version") {
            None | Some(Value::Null) => None,
            Some(before) => Some(before.as_i64().filter(|before| *before > 0).ok_or_else(
                || InputFault::new("before_version", "a whole number above 0 (a page's next)"),
            )?),
        };
        Ok(HistoryInput {
            id,
            before,
            limit: count_of(fields, "limit", self.settings.history_max, None)?,
        })
    }

    fn outside_choices_input<'a>(
        &self,
        fields: &'a Map<String, Value>,
    ) -> Parsed<OutsideChoicesInput<'a>> {
        closed(fields, &["list", "limit", "after"])?;
        Ok(OutsideChoicesInput {
            list_id: required_text(fields, "list")?,
            limit: count_of(
                fields,
                "limit",
                MAX_LIST_ROWS,
                Some(self.settings.list_page),
            )?,
            after: cursor_of(fields)?,
        })
    }

    fn list_input<'a>(&self, fields: &'a Map<String, Value>) -> Parsed<ListInput<'a>> {
        closed(
            fields,
            &[
                "type", "order", "prefix", "above", "below", "reverse", "limit", "after", "fields",
                "view", "where",
            ],
        )?;
        let kind = required_text(fields, "type")?;
        let order = optional_text(fields, "order")?;
        let reverse = match fields.get("reverse") {
            None | Some(Value::Null) => order.is_none(),
            Some(Value::Bool(reverse)) => *reverse,
            Some(_) => return Err(InputFault::new("reverse", "true or false")),
        };
        let limit = count_of(fields, "limit", usize::MAX, Some(self.settings.list_page))?;
        let after = cursor_of(fields)?;
        let projection = fields_of(fields)?;
        let wanted = where_of(fields)?;
        let view = match fields.get("view") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(InputFault::new("view", "true or false")),
        };
        let range = ListRange {
            prefix: optional_text(fields, "prefix")?.map(str::to_owned),
            above: optional_text(fields, "above")?.map(str::to_owned),
            below: optional_text(fields, "below")?.map(str::to_owned),
        };
        Ok(ListInput {
            kind,
            order,
            reverse,
            limit,
            after,
            projection,
            wanted,
            view,
            range,
        })
    }

    /// What is wrong with `input` of `operation`, by field name and expected shape, or none when these routes find
    /// nothing wrong in its shape (or does not answer the operation). It runs the same parses the answer does, so
    /// the words cannot drift from what the routes refuse; it is asked only after a call was refused for its input.
    pub fn input_fault(&self, operation: &str, input: &Value) -> Option<InputFault> {
        if self.result_operation() == Some(operation) {
            return object_of(input).and_then(result_input).err();
        }
        let parse = || -> Parsed<()> {
            let mut fields = logical_fields(input)?;
            after_byte_of(&mut fields)?;
            if operation == self.settings.read {
                read_input(&fields).map(drop)
            } else if operation == self.settings.list {
                self.list_input(&fields).map(drop)
            } else if operation == self.settings.history {
                self.history_input(&fields).map(drop)
            } else if operation == self.settings.outside_choices {
                self.outside_choices_input(&fields).map(drop)
            } else if operation == self.settings.references.operation {
                super::references::input(&fields, &self.settings.references).map(drop)
            } else if operation == self.settings.search.operation {
                search::input(&fields, &self.settings.search).map(drop)
            } else {
                Ok(())
            }
        };
        parse().err()
    }

    /// The kind this read asks for when that kind stays on this computer (`stays_on_this_device`), else none: a list's
    /// `type`, the type of the record a read or a history names, the kind a list definition declares. What a caller
    /// that is not running here without a way out is refused, before anything of the kind is read or answered.
    pub fn device_only_asked(
        &self,
        operation: &str,
        input: &Value,
        supply: &mut impl OrderedSupply,
        model: &Installed,
        limits: Limits,
    ) -> Result<Option<String>> {
        if record_domain(input)? != supply.record_domain() { return Err(crate::cause!(Error::Invalid)); }
        let fields = logical_fields(input)?;
        let fields = &fields;
        let policy = model.open_policy();
        let stays = |kind: &str| model.stays(kind).then(|| kind.to_owned());
        if operation == self.settings.list || operation == self.settings.search.operation {
            return Ok(optional_text(fields, "type")?.and_then(stays));
        }
        // Reverse lookup checks its canonical target/declaration through the current privacy wrapper, including
        // identities that are valid index keys but are not ordinary own-record ids.
        if operation == self.settings.references.operation {
            return Ok(None);
        }
        if operation == self.settings.read || operation == self.settings.history {
            let id = required_text(fields, "id")?;
            return Ok(
                read(id, supply, policy, limits)?.and_then(|record| stays(record.record_type()))
            );
        }
        if operation == self.settings.outside_choices {
            let list_id = required_text(fields, "list")?;
            let Some(definition) = read(list_id, supply, policy, limits)? else {
                return Ok(None);
            };
            return Ok(self
                .declared_kind(&definition, list_id, model)?
                .and_then(|kind| stays(&kind)));
        }
        Ok(None)
    }

    /// The kind a list definition declares (`record:<row_type>`), none when the record declares nothing.
    fn declared_kind(
        &self,
        definition: &LogicalRecord,
        id: &str,
        installed: &Installed,
    ) -> Result<Option<String>> {
        use crate::ecma_json::JsString;
        // The installed tools' model holds the list rule's field kinds (`field_kinds`) too.
        let mut model =
            crate::record_write_model::Model::from_product_data(installed.data(), installed.data())
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let named = model
            .declare(
                &JsString::from(definition.record_type()),
                &JsString::from(id),
                definition.value(),
            )
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        named
            .map(|named| named.to_rust_string().map_err(|error| Error::Source(error.cause())))
            .transpose()
    }

    /// `{list, limit?, after?}`: the rows of the list definition `list` whose values are outside the choices its fields
    /// declare, as {kind, scanned, rows_outside, outside: [{id, field, value}], next}. A list definition's change is
    /// never blocked by rows written under its old choices; this reports them. Rows are scanned by id, greatest first,
    /// `limit` (1..999, `list_page` when absent) at a time and cut to the leading rows whose answer fits one message;
    /// `next` is the `after` of the call that continues, null once every row was scanned. A definition that declares no
    /// choices answers `kind` null and nothing outside. A record that is absent is an input refusal.
    fn outside_choices_page(
        &self,
        fields: &Map<String, Value>,
        supply: &mut impl OrderedSupply,
        installed: &Installed,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value> {
        let policy = installed.open_policy();
        use crate::ecma_json::JsString;
        let OutsideChoicesInput {
            list_id,
            limit,
            after,
        } = self.outside_choices_input(fields)?;
        let mut cursor = after;
        let definition = read(list_id, supply, policy, limits)?.ok_or(crate::cause!(Error::Invalid))?;
        let mut model =
            crate::record_write_model::Model::from_product_data(installed.data(), installed.data())
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let id = JsString::from(list_id);
        let Some(named) = model
            .declare(
                &JsString::from(definition.record_type()),
                &id,
                definition.value(),
            )
            .map_err(|error| crate::carry_cause!(Error::Source, error))?
        else {
            return Ok(
                json!({"kind": null, "scanned": 0, "rows_outside": 0, "outside": [], "next": null}),
            );
        };
        let kind = named.to_rust_string().map_err(|error| Error::Source(error.cause()))?;
        let shape = |outside: &[Value], scanned: usize, rows: usize, next: Option<&str>| json!({"kind": kind, "scanned": scanned, "rows_outside": rows, "outside": outside, "next": next});
        let (mut outside, mut scanned, mut walked, mut rows, mut last) =
            (Vec::<Value>::new(), 0usize, 0usize, 0usize, None::<String>);
        let next = 'scan: loop {
            let query = ListQuery {
                kind: &kind,
                order: None,
                range: ListRange::default(),
                reverse: true,
                limit: (limit - scanned).min(LIST_CHUNK),
                walk_limit: LIST_SCAN_BUDGET - walked,
                after: cursor.take(),
            };
            let page = list::list(supply, &query, policy, limits)?;
            walked += page.walked;
            for row in page.rows {
                let before = outside.len();
                for (field, value) in model.outside_choices_of(&id, row.value()) {
                    outside.push(json!({
                        "id": row.id(),
                        "field": field.to_rust_string().map_err(|error| crate::carry_cause!(Error::Source, error))?,
                        "value": value.to_rust_string().map_err(|error| crate::carry_cause!(Error::Source, error))?,
                    }));
                }
                let counted = rows + usize::from(outside.len() > before);
                let here = cursor_text(&OrderCursor {
                    value: Vec::new(),
                    id: row.id().to_owned(),
                });
                if !fits(&shape(&outside, scanned + 1, counted, Some(&here))) {
                    outside.truncate(before);
                    if scanned == 0 {
                        return Err(crate::cause!(Error::Bounds));
                    }
                    break 'scan last;
                }
                (scanned, rows, last) = (scanned + 1, counted, Some(here));
            }
            match page.next {
                None => break None,
                Some(_) if scanned >= limit => break last,
                Some(next) if walked >= LIST_SCAN_BUDGET => break Some(cursor_text(&next)),
                Some(next) => cursor = Some(next),
            }
        };
        Ok(shape(&outside, scanned, rows, next.as_deref()))
    }

    /// `{id, before_version?, limit}`: that record's versions newest first, `next` the `before_version` of the next
    /// page. A deleted version answers `deleted: true` and no value; an unknown id answers no versions.
    fn history_page(
        &self,
        fields: &Map<String, Value>,
        supply: &mut impl VersionSupply,
        policy: &OpenPolicy,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value> {
        let HistoryInput { id, before, limit } = self.history_input(fields)?;
        let page = history::history(id, before, limit, supply, policy, limits)?;
        let versions = page
            .versions
            .into_iter()
            .map(|held| {
                Ok(json!({
                    "version": held.version,
                    "value": held.value,
                    "deleted": held.value.is_none(),
                    "at": iso(held.at_ms)?,
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        let shape = |shown: &[Value], next: Option<i64>| json!({"versions": shown, "next": next});
        if fits(&shape(&versions, page.next)) {
            return Ok(shape(&versions, page.next));
        }
        // The next page continues below the last version shown; the longest version number bounds the probe.
        let shown = rows_that_fit(&versions, |shown| fits(&shape(shown, Some(i64::MAX))))?;
        Ok(shape(
            &versions[..shown],
            versions[shown - 1]["version"].as_i64(),
        ))
    }

    fn list_page(
        &self,
        fields: &Map<String, Value>,
        supply: &mut (impl OrderedSupply + KindSchemas),
        model: &Installed,
        limits: Limits,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value> {
        let policy = model.open_policy();
        let ListInput {
            kind,
            order,
            reverse,
            limit,
            after,
            projection,
            wanted,
            view,
            mut range,
        } = self.list_input(fields)?;
        // A filter narrows by a declared order when one lists the kind by a field it names: the rows holding that value
        // are one run of the order. With none, it streams rows by id and returns a cursor at the per-answer work bound.
        // A continuation of a page read row by row (its cursor names an id alone, no order value) goes on row by row:
        // an order filled between the two pages would read that cursor as a position it never was.
        let mut order = order;
        let mut chosen_by_where = false;
        let by_row = after.as_ref().is_some_and(|after| after.value.is_empty());
        if let (None, Some(wanted), false) = (order, wanted.as_ref(), by_row) {
            if range == ListRange::default() {
                let settings = supply.settings();
                let chosen = wanted
                    .iter()
                    .find_map(|(field, value)| list::order_for_field(settings, kind, field, value));
                match chosen {
                    Some((name, prefix)) => {
                        order = Some(name);
                        range.prefix = Some(prefix);
                        chosen_by_where = after.is_none();
                    }
                    None => {}
                }
            }
        }
        // `view: true` reads the kind as a typed table: the kind's schema once, and each row's fields through it.
        let schema = if view {
            Some(supply.kind_schema(kind)?)
        } else {
            None
        };
        let shape = |shown: &[Value], next: Option<&str>| {
            let mut page = json!({"records": shown, "next": next});
            if schema.is_some() {
                page["schema"] = json!(schema);
            }
            page
        };
        // Rows are read in chunks under a per-answer position budget; reading also stops when the answer overflows.
        // Without `where`, `limit` bounds the rows read. With `where`, it bounds the rows shown: the answer reads on
        // through the whole list (up to `where_walk_most` positions) until `limit` rows match, so a row that matches
        // far down a large list is found in one call, never reported missing because the first page held no match.
        let budget = if wanted.is_some() {
            self.settings.where_walk_most
        } else {
            LIST_SCAN_BUDGET
        };
        let mut records: Vec<Value> = Vec::new();
        let mut derived = Derived::of(model);
        let (mut read, mut walked) = (0usize, 0usize);
        let mut cursor = after;
        let next = loop {
            if walked >= budget {
                break cursor.as_ref().map(cursor_text);
            }
            let want = if wanted.is_some() {
                (limit - records.len()).min(LIST_CHUNK)
            } else {
                (limit - read).min(LIST_CHUNK)
            };
            let query = ListQuery {
                kind,
                order,
                range: range.clone(),
                reverse,
                limit: want,
                walk_limit: (budget - walked).min(LIST_SCAN_BUDGET),
                after: cursor.take(),
            };
            let page = match list::list(supply, &query, policy, limits) {
                // The order this `where` chose is declared but not yet filled for the rows kept before it was (idle
                // upkeep fills it, `RecordStore::fill_order`; the store refuses its page until then): this answer reads
                // the kind row by row instead, as it did before the order was declared, and its `next` is a row-walk
                // cursor, so the pages after it go on row by row too.
                Err(Error::Invalid(_)) if chosen_by_where && walked == 0 => {
                    (order, range, chosen_by_where) = (None, ListRange::default(), false);
                    continue;
                }
                page => page?,
            };
            read += page.rows.len();
            walked += page.walked;
            for row in page.rows {
                let mut shown = record_json(row)?;
                if !matches_where(&shown["value"], wanted.as_ref()) {
                    continue;
                }
                derived.fill(&mut shown, supply, policy, limits)?;
                if let Some(Some(schema)) = &schema {
                    let typed = schema.view(&shown["value"]);
                    shown["fields"] = json!(typed.fields);
                    shown["mismatched"] = json!(typed.mismatched);
                }
                records.push(project(shown, projection.as_deref()));
            }
            cursor = page.next;
            let enough = if wanted.is_some() {
                records.len() >= limit
            } else {
                read >= limit
            };
            if cursor.is_none() || enough || walked >= budget || !fits(&shape(&records, None)) {
                break cursor.as_ref().map(cursor_text);
            }
        };
        if fits(&shape(&records, next.as_deref())) {
            return Ok(shape(&records, next.as_deref()));
        }
        // The next page continues after the last row shown: that row's position in the order (the cursor text a row
        // carries is longer than none, so each count is probed with the longest cursor this page could name).
        let probe = next.clone().unwrap_or_default();
        let mut shown = rows_that_fit(&records, |shown| fits(&shape(shown, Some(&probe))))?;
        loop {
            let last = records[shown - 1]["id"].as_str().ok_or(crate::cause!(Error::Source))?;
            let cursor = match order {
                Some(order) => {
                    list::position_of(supply, kind, order, last)?.ok_or(crate::cause!(Error::Source))?
                }
                None => OrderCursor {
                    value: Vec::new(),
                    id: last.to_owned(),
                },
            };
            let text = cursor_text(&cursor);
            let page = shape(&records[..shown], Some(&text));
            if fits(&page) {
                return Ok(page);
            }
            // This row's own cursor outgrew the probe: show one row fewer.
            shown -= 1;
            if shown == 0 {
                return Err(crate::cause!(Error::Bounds));
            }
        }
    }
}

/// The most leading `rows` (at least one) for which `fits` admits the page: the page of all of them does not fit.
/// Refuses (`Bounds`) when not even the first row alone fits.
fn rows_that_fit(rows: &[Value], fits: impl Fn(&[Value]) -> bool) -> Result<usize> {
    // `low` rows fit (or none yet), `high` do not.
    let (mut low, mut high) = (0, rows.len());
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        if fits(&rows[..middle]) {
            low = middle;
        } else {
            high = middle;
        }
    }
    if low == 0 && !rows.is_empty() && fits(&rows[..1]) {
        low = 1;
    }
    if low == 0 {
        Err(crate::cause!(Error::Bounds))
    } else {
        Ok(low)
    }
}

/// `{id, type?}`: that record, or value null when it is absent or, with a type given, of another type.
fn read_one(
    fields: &Map<String, Value>,
    supply: &mut (impl OrderedSupply + VersionSupply),
    policy: &OpenPolicy,
    limits: Limits,
    derived: &mut Derived,
) -> Result<Value> {
    let ReadInput { id, kind, at } = read_input(fields)?;
    // `at`: the record as it was saved then (history::read_at, the record store's record_at; old trillion
    // record-log-store.mjs recordAt(id, { known })). The answer says which version that was, when it was saved, and
    // whether the store still holds what could answer (`complete`, `kept_from`).
    if let Some(at_ms) = at {
        let (opened, complete, kept_from) = history::read_at(id, at_ms, supply, policy, limits)?;
        let kept_from = kept_from.map(iso).transpose()?;
        return match opened {
            Some((version, saved, record))
                if kind.is_none_or(|kind| kind == record.record_type()) =>
            {
                let mut shown = record_json(record)?;
                if let Some(object) = shown.as_object_mut() {
                    object.insert("version".into(), json!(version));
                    object.insert("saved_at".into(), json!(iso(saved)?));
                    object.insert("complete".into(), json!(complete));
                    object.insert("kept_from".into(), json!(kept_from));
                }
                Ok(shown)
            }
            _ => Ok(
                json!({"id": id, "type": kind, "value": null, "complete": complete, "kept_from": kept_from}),
            ),
        };
    }
    match read(id, supply, policy, limits)? {
        Some(record) if kind.is_none_or(|kind| kind == record.record_type()) => {
            // The opaque root field stamp of this SAME admitted read, before computed fields. Shared children and
            // derived data are not fenced by a root version. Historical/missing/wrong-type reads have no witness.
            let identity = record.root_identity().map(str::to_owned);
            let mut shown = record_json(record)?;
            if let Some(identity) = identity {
                shown["identity"] = json!(identity);
            }
            derived.fill(&mut shown, supply, policy, limits)?;
            Ok(shown)
        }
        _ => Ok(json!({"id": id, "type": kind, "value": null})),
    }
}

/// A list row's computed fields, worked out when the row is read (Trillion: a list's formula column, which its page
/// worked out with the formula evaluator from the row's own values). A row is a record whose kind is a list's row
/// kind (`rule_bindings::rules_and_runs` settings: a `list` record
/// whose `row_type` names it, as record-model.json declared_by says); its list's fields are read once per answer, from
/// at most `most_lists` lists. The values go beside the row's own as `computed` (field id → value, null for one that
/// could not be worked out), so a value the row keeps and one worked out from it are never confused; a row whose list
/// has no computed field, or a record that is no row, is answered unchanged. Nothing is written.
#[derive(Default)]
struct Derived {
    fields_by_kind: std::collections::BTreeMap<String, Option<Vec<Value>>>,
    /// The list rule's field kinds the account's installed tools declare (their model's `field_kinds`).
    kinds: Vec<Value>,
}

impl Derived {
    fn of(model: &Installed) -> Self {
        Self {
            fields_by_kind: Default::default(),
            kinds: crate::rule_bindings::rules_and_runs::field_kinds(model),
        }
    }

    fn fill(
        &mut self,
        shown: &mut Value,
        supply: &mut impl OrderedSupply,
        policy: &OpenPolicy,
        limits: Limits,
    ) -> Result<()> {
        let settings =
            crate::rule_bindings::rules_and_runs::settings().map_err(|error| Error::Source(error.cause()))?;
        let Some(kind) = shown["type"].as_str().map(str::to_owned) else {
            return Ok(());
        };
        let Some(row_type) = kind.strip_prefix(settings.row_kind_prefix.as_str()) else {
            return Ok(());
        };
        if !self.fields_by_kind.contains_key(&kind) {
            let fields = declaring_fields(row_type, supply, policy, limits, settings)?;
            self.fields_by_kind.insert(kind.clone(), fields);
        }
        let Some(Some(fields)) = self.fields_by_kind.get(&kind) else {
            return Ok(());
        };
        let values = crate::rule_bindings::rules_and_runs::derived_values(
            fields,
            &self.kinds,
            &shown["value"],
        );
        if !values.is_empty() {
            shown["computed"] = Value::Object(values);
        }
        Ok(())
    }
}

/// The fields of the list whose rows are `row_type`, or none when no list (among the first `most_lists`) names it.
fn declaring_fields(
    row_type: &str,
    supply: &mut impl OrderedSupply,
    policy: &OpenPolicy,
    limits: Limits,
    settings: &crate::rule_bindings::rules_and_runs::Settings,
) -> Result<Option<Vec<Value>>> {
    let (mut after, mut seen) = (None, 0usize);
    loop {
        let query = ListQuery {
            kind: &settings.list_kind,
            order: None,
            range: ListRange::default(),
            reverse: true,
            limit: MAX_LIST_ROWS,
            walk_limit: list::MAX_LIST_WALK,
            after: after.take(),
        };
        let page = list::list(supply, &query, policy, limits)?;
        for row in page.rows {
            let shown = record_json(row)?;
            if shown["value"][settings.row_type_field.as_str()].as_str() == Some(row_type) {
                return Ok(shown["value"][settings.fields_field.as_str()]
                    .as_array()
                    .cloned());
            }
            seen += 1;
            if seen >= settings.most_lists {
                return Ok(None);
            }
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return Ok(None),
        }
    }
}

/// A refused input is a fault by field name and expected shape (`mcp::InputFault`); inside these routes it travels as
/// `Invalid`, and the call's own refusal names it again from `Door::input_fault`, which runs these same parses.
type Parsed<T> = std::result::Result<T, InputFault>;

fn result_input(fields: &Map<String, Value>) -> Parsed<RecordResultInput> {
    closed(fields, &["request_key", "operation", "input"])?;
    let request_key = required_text(fields, "request_key")?;
    if request_key.encode_utf16().count() > 512 {
        return Err(InputFault::new(
            "request_key",
            "the original non-empty command key, at most 512 UTF-16 units",
        ));
    }
    let operation = required_text(fields, "operation")?;
    let command = crate::record_write_model::write_command::Command::shipped().map_err(|_| {
        InputFault::new("operation", "the current declared records write operation")
    })?;
    if operation != command.operation() {
        return Err(InputFault::new(
            "operation",
            "the original declared records write operation",
        ));
    }
    let input = fields
        .get("input")
        .filter(|input| input.is_object())
        .ok_or_else(|| InputFault::new("input", "the original records-write input object"))?;
    command
        .parse_json(input)
        .map_err(|_| InputFault::new("input", "the original records-write input, unchanged"))?;
    Ok(RecordResultInput {
        request_key: request_key.into(),
        operation: operation.into(),
        input: input.clone(),
    })
}

impl From<InputFault> for Error {
    fn from(error: InputFault) -> Self {
        Error::Invalid(error.cause())
    }
}

/// The input as its object, or the fault of the whole input.
fn object_of(input: &Value) -> Parsed<&Map<String, Value>> {
    input
        .as_object()
        .ok_or_else(|| InputFault::new("(input)", "a JSON object"))
}

/// Validate the complete history context separately from operation fields.
/// Bind address-bearing result structure, never fields inside a user's value.
/// A forwarded search address and a row detached from its page keep the same
/// logical history. Paging accounts for these bytes before choosing a boundary.
fn bind_record_domain(answer: &mut Value, domain: &Value) {
    let Some(object) = answer.as_object_mut() else { return; };
    object.insert("scope".into(), domain.clone());
    if let Some(input) = object.get_mut("address").and_then(|address| address.get_mut("input")).and_then(Value::as_object_mut) {
        input.insert("scope".into(), domain.clone());
    }
    for name in ["records", "versions", "results", "outside", "holders"] {
        if let Some(rows) = object.get_mut(name).and_then(Value::as_array_mut) {
            for row in rows { bind_record_domain(row, domain); }
        }
    }
}

fn bind_record_context(answer: &mut Value, context: &Value) {
    let Some(object) = answer.as_object_mut() else { return; };
    object.insert("context".into(), context.clone());
    for name in ["records", "versions", "results", "outside", "holders"] {
        if let Some(rows) = object.get_mut(name).and_then(Value::as_array_mut) {
            for row in rows { bind_record_context(row, context); }
        }
    }
}

/// Validate the complete history context separately from operation fields.
/// The native owner checks this same value against the stored domain header;
/// pure readers also compare it with their supplied context before any read.
fn record_domain(input: &Value) -> Parsed<Option<Value>> {
    let selected = crate::storage::record_store_resources::domains::Selection::from_input(input)
        .map_err(|_| InputFault::new("scope", "a complete resource history identity"))?;
    selected.map(|selected| {
        if selected.create { return Err(InputFault::new("scope", "an existing resource history identity")); }
        serde_json::to_value(selected.identity())
            .map_err(|_| InputFault::new("scope", "a complete resource history identity"))
    }).transpose()
}
fn logical_fields(input: &Value) -> Parsed<Map<String, Value>> {
    record_domain(input)?;
    let mut fields = object_of(input)?.clone();
    fields.remove("scope");
    Ok(fields)
}

/// No field but `allowed`: the first one that is not named, by its name.
pub(super) fn closed(fields: &Map<String, Value>, allowed: &[&str]) -> Parsed<()> {
    match fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        None => Ok(()),
        Some(key) => Err(InputFault::new(
            key.as_str(),
            format!(
                "not a field of this operation; its fields are {}",
                allowed.join(", ")
            ),
        )),
    }
}

/// `after_byte`, taken out of the input: a whole number from a page's `next_after_byte`.
fn after_byte_of(fields: &mut Map<String, Value>) -> Parsed<Option<u64>> {
    match fields.remove("after_byte") {
        None | Some(Value::Null) => Ok(None),
        Some(after) => after.as_u64().map(Some).ok_or_else(|| {
            InputFault::new("after_byte", "a whole number (a page's next_after_byte)")
        }),
    }
}

pub(super) fn required_text<'a>(fields: &'a Map<String, Value>, name: &str) -> Parsed<&'a str> {
    optional_text(fields, name)?.ok_or_else(|| InputFault::new(name, "required: non-empty text"))
}

pub(super) fn optional_text<'a>(
    fields: &'a Map<String, Value>,
    name: &str,
) -> Parsed<Option<&'a str>> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text)),
        Some(_) => Err(InputFault::new(name, "non-empty text")),
    }
}

/// A row or version count: a whole number in `1..=most`, `default` when absent (none: required).
pub(super) fn count_of(
    fields: &Map<String, Value>,
    name: &str,
    most: usize,
    default: Option<usize>,
) -> Parsed<usize> {
    match (fields.get(name), default) {
        (None | Some(Value::Null), Some(default)) => Ok(default),
        (None | Some(Value::Null), None) => Err(InputFault::new(
            name,
            format!("required: a whole number from 1 to {most}"),
        )),
        (Some(count), _) => count
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())
            .filter(|count| (1..=most).contains(count))
            .ok_or_else(|| InputFault::new(name, format!("a whole number from 1 to {most}"))),
    }
}

/// `after`: the cursor text an earlier page gave as `next`.
fn cursor_of(fields: &Map<String, Value>) -> Parsed<Option<OrderCursor>> {
    optional_text(fields, "after")?
        .map(|text| {
            cursor_from_text(text).map_err(|_| {
                InputFault::new(
                    "after",
                    "the next value an earlier page of this list gave, unchanged",
                )
            })
        })
        .transpose()
}

/// `{id, type?, at?}` as read.
struct ReadInput<'a> {
    id: &'a str,
    kind: Option<&'a str>,
    /// The moment to read the record as saved at: wall-clock milliseconds.
    at: Option<u64>,
}

fn read_input(fields: &Map<String, Value>) -> Parsed<ReadInput<'_>> {
    closed(fields, &["id", "type", "at"])?;
    let at =
        match fields.get("at") {
            None | Some(Value::Null) => None,
            Some(Value::Number(ms)) => Some(ms.as_u64().ok_or_else(|| {
                InputFault::new("at", "a time: an ISO time or whole milliseconds")
            })?),
            Some(Value::String(text)) => Some(
                chrono::DateTime::parse_from_rfc3339(text)
                    .ok()
                    .and_then(|at| u64::try_from(at.timestamp_millis()).ok())
                    .ok_or_else(|| {
                        InputFault::new("at", "a time: an ISO time or whole milliseconds")
                    })?,
            ),
            Some(_) => {
                return Err(InputFault::new(
                    "at",
                    "a time: an ISO time or whole milliseconds",
                ))
            }
        };
    Ok(ReadInput {
        id: required_text(fields, "id")?,
        kind: optional_text(fields, "type")?,
        at,
    })
}

/// `{id, before_version?, limit}` as read.
struct HistoryInput<'a> {
    id: &'a str,
    before: Option<i64>,
    limit: usize,
}

/// `{list, limit?, after?}` as read.
struct OutsideChoicesInput<'a> {
    list_id: &'a str,
    limit: usize,
    after: Option<OrderCursor>,
}

/// `{type, order?, prefix?, above?, below?, reverse?, limit?, after?, fields?, where?, view?}` as read.
struct ListInput<'a> {
    kind: &'a str,
    order: Option<&'a str>,
    reverse: bool,
    limit: usize,
    after: Option<OrderCursor>,
    projection: Option<Vec<String>>,
    wanted: Option<Map<String, Value>>,
    view: bool,
    range: ListRange,
}

/// One opened record's value as plain JSON.
pub(super) fn value_json(record: &LogicalRecord) -> Result<Value> {
    let text = crate::ecma_json::stringify(record.value(), Default::default())
        .map_err(|error| Error::Bounds(error.cause()))?;
    serde_json::from_str(&text).map_err(|error| crate::carry_cause!(Error::Bounds, error))
}

/// The `fields` input of a list: none (absent or null) shows whole values; names show only those top-level fields of
/// each value; an empty list shows ids and types alone. Names are text, at most `MAX_PROJECTED_FIELDS`.
fn fields_of(fields: &Map<String, Value>) -> Parsed<Option<Vec<String>>> {
    let expected = || {
        InputFault::new(
            "fields",
            format!("a list of at most {MAX_PROJECTED_FIELDS} non-empty field names"),
        )
    };
    match fields.get("fields") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(names)) if names.len() <= MAX_PROJECTED_FIELDS => names
            .iter()
            .map(|name| {
                name.as_str()
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(expected)
            })
            .collect::<Parsed<Vec<_>>>()
            .map(Some),
        Some(_) => Err(expected()),
    }
}

/// The `where` input of a list: none (absent or null) shows every row read; an object of at most
/// `MAX_PROJECTED_FIELDS` top-level field names shows only the rows whose opened value holds each named field equal, as
/// JSON, to the value given.
fn where_of(fields: &Map<String, Value>) -> Parsed<Option<Map<String, Value>>> {
    match fields.get("where") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(wanted)) if !wanted.is_empty() && wanted.len() <= MAX_PROJECTED_FIELDS
            && wanted.keys().all(|name| !name.is_empty()) => Ok(Some(wanted.clone())),
        Some(_) => Err(InputFault::new("where", format!("an object of 1 to {MAX_PROJECTED_FIELDS} field names, each with the value it must equal"))),
    }
}

/// Whether an opened value holds every field `where` names, each equal to its value.
fn matches_where(value: &Value, wanted: Option<&Map<String, Value>>) -> bool {
    wanted.is_none_or(|wanted| {
        wanted
            .iter()
            .all(|(name, expected)| value.get(name) == Some(expected))
    })
}

/// One listed row narrowed to the asked `fields`: its id and type, its typed `fields` and `mismatched` when the list
/// asked for a `view`, and its value's named fields (a value that is not an object has none). The row was opened whole first (sealed fields, erasure), so the narrowing never reaches a field
/// the whole read would not show.
fn project(row: Value, projection: Option<&[String]>) -> Value {
    let Some(names) = projection else { return row };
    let mut shown = json!({"id": row["id"], "type": row["type"]});
    for typed in ["fields", "mismatched"] {
        if let Some(held) = row.get(typed) {
            shown[typed] = held.clone();
        }
    }
    if !names.is_empty() {
        let value: Map<String, Value> = names
            .iter()
            .filter_map(|name| {
                row["value"]
                    .get(name)
                    .map(|field| (name.clone(), field.clone()))
            })
            .collect();
        shown["value"] = Value::Object(value);
    }
    shown
}

/// One opened record as the account's routes answer it.
fn record_json(record: LogicalRecord) -> Result<Value> {
    let value = value_json(&record)?;
    Ok(json!({"id": record.id(), "type": record.record_type(), "value": value}))
}

/// A write's wall-clock milliseconds as an ISO time.
fn iso(at_ms: u64) -> Result<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        i64::try_from(at_ms).map_err(|error| crate::carry_cause!(Error::Bounds, error))?,
    )
    .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .ok_or(crate::cause!(Error::Bounds))
}

fn cursor_text(cursor: &OrderCursor) -> String {
    format!(
        "{}{CURSOR_MARK}{}",
        URL_SAFE_NO_PAD.encode(&cursor.value),
        cursor.id
    )
}

fn cursor_from_text(text: &str) -> Result<OrderCursor> {
    let (value, id) = text.split_once(CURSOR_MARK).ok_or(crate::cause!(Error::Invalid))?;
    let value = URL_SAFE_NO_PAD.decode(value).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    if id.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(OrderCursor {
        value,
        id: id.to_owned(),
    })
}

#[cfg(test)]
#[path = "account_routes_paging_tests.rs"]
mod paging_tests;

#[cfg(test)]
#[path = "account_routes_where_tests.rs"]
mod where_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record_value::list::tests::Prefilled;

    fn door() -> &'static Door {
        Door::shipped().unwrap()
    }

    fn model() -> &'static Installed {
        crate::record_model_policy::list_rule_model()
    }

    fn answer(operation: &str, input: Value, prefilled: &mut Prefilled) -> Result<Value> {
        door().answer(
            operation,
            &input,
            prefilled,
            model(),
            Limits::default(),
            &|_| true,
        )
    }

    fn answer_within(
        operation: &str,
        input: Value,
        prefilled: &mut Prefilled,
        bytes: usize,
    ) -> Result<Value> {
        let fits = |page: &Value| page.to_string().len() <= bytes;
        door().answer(
            operation,
            &input,
            prefilled,
            model(),
            Limits::default(),
            &fits,
        )
    }

    #[test]
    fn a_read_answers_the_record_and_a_record_of_another_type_as_missing() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"words": "hello"}));
        let read = door().read_operation();
        let mut current = answer(read, json!({"id": "n1"}), &mut prefilled).unwrap();
        assert_eq!(
            current.as_object_mut().unwrap().remove("identity"),
            Some(json!("seq-1"))
        );
        assert_eq!(
            current,
            json!({"id": "n1", "type": "note", "value": {"words": "hello"}})
        );
        assert_eq!(
            answer(read, json!({"id": "n1", "type": "note"}), &mut prefilled).unwrap()["value"]
                ["words"],
            "hello"
        );
        let other = answer(read, json!({"id": "n1", "type": "task"}), &mut prefilled).unwrap();
        let missing = answer(read, json!({"id": "n9", "type": "task"}), &mut prefilled).unwrap();
        assert_eq!(other["value"], Value::Null);
        assert!(other.get("identity").is_none() && missing.get("identity").is_none());
        assert_eq!(other, json!({"id": "n1", "type": "task", "value": null}));
        assert_eq!(missing["value"], Value::Null);
        assert_eq!(
            answer(read, json!({"id": "n1", "extra": 1}), &mut prefilled),
            Err(crate::cause!(Error::Invalid))
        );
    }

    #[test]
    fn protected_result_input_keeps_the_original_command_and_is_not_an_ordinary_read() {
        let operation = door().result_operation().unwrap();
        assert!(door().answers_result(door().resource(), operation));
        assert!(!door().answers(door().resource(), operation));
        assert!(!door().answers_result("different-resource", operation));
        let write = crate::record_write_model::write_command::Command::shipped()
            .unwrap()
            .operation();
        let kind = "sample-kind";
        let input = json!({"records":[{"id":"sample-id","type":kind,"value":{"canary":"private original input"},"expected":null}]});
        let request = json!({"request_key":"original-command-key","operation":write,"input":input});
        let parsed = door().result_input(&request).unwrap();
        assert_eq!(parsed.request_key, "original-command-key");
        assert_eq!(parsed.operation, write);
        assert_eq!(parsed.input, input);
        assert!(!format!("{parsed:?}").contains("canary"));
        for field in ["execution_ref", "result_id", "after_byte"] {
            let mut unknown = request.clone();
            unknown[field] = json!("not original input");
            assert!(door().result_input(&unknown).is_err());
            assert_eq!(
                door().input_fault(operation, &unknown).unwrap().field,
                field
            );
        }
        let mut wrong = request.clone();
        wrong["operation"] = json!(door().read_operation());
        assert!(door().result_input(&wrong).is_err());
        let mut wrong = request.clone();
        wrong["request_key"] = json!("🙂".repeat(257));
        assert!(door().result_input(&wrong).is_err());
        let mut wrong = request.clone();
        wrong["input"] = json!({"records":[]});
        assert!(door().result_input(&wrong).is_err());
        let mut alias: Value = serde_json::from_slice(DATA).unwrap();
        alias["result"] = json!(door().read_operation());
        assert!(Door::from_data(&serde_json::to_vec(&alias).unwrap()).is_err());
    }

    #[test]
    fn rows_outside_a_list_definitions_choices_are_reported_paged_by_the_bytes_and_by_the_limit() {
        let mut prefilled = Prefilled::new();
        // The kind a definition declares is named by the installed list rule (its prefix and the row_type).
        let task = format!(
            "{}task",
            model().json()["declared_by"][0]["kind"]["prefix"]
                .as_str()
                .unwrap()
        );
        let task = task.as_str();
        prefilled.put(
            "tasks-def",
            "list",
            json!({"row_type": "task", "fields": [
                {"id": "state", "kind": "choice", "choices": ["open", "done"]},
                {"id": "tags", "kind": "choice", "choices": ["red", "blue"]},
                {"id": "title", "kind": "text"},
            ]}),
        );
        prefilled.put("t1", task, json!({"state": "open", "title": "one"}));
        let long = "later".repeat(40);
        prefilled.put("t2", task, json!({"state": long, "title": "two"}));
        prefilled.put(
            "t3",
            task,
            json!({"state": "done", "tags": ["red", "green"]}),
        );
        prefilled.put("t4", task, json!({"state": null, "title": "four"}));
        let soon = "soon".repeat(40);
        prefilled.put("t5", task, json!({"state": soon, "tags": ["blue"]}));
        prefilled.put("n1", "note", json!({"state": "anything"}));
        let outside = door().outside_choices_operation();
        let whole = answer(outside, json!({"list": "tasks-def"}), &mut prefilled).unwrap();
        assert_eq!(
            whole,
            json!({"kind": task, "scanned": 5, "rows_outside": 3, "next": null, "outside": [
                {"id": "t5", "field": "state", "value": soon},
                {"id": "t3", "field": "tags", "value": "green"},
                {"id": "t2", "field": "state", "value": long},
            ]})
        );
        // Two rows at a time: every row is scanned once and the rows outside come in the same order.
        let (mut found, mut after, mut scanned) = (Vec::new(), None::<String>, 0);
        loop {
            let mut input = json!({"list": "tasks-def", "limit": 2});
            input["after"] = json!(after);
            let page = answer(outside, input, &mut prefilled).unwrap();
            found.extend(page["outside"].as_array().unwrap().iter().cloned());
            scanned += page["scanned"].as_u64().unwrap();
            match page["next"].as_str() {
                Some(next) => after = Some(next.to_owned()),
                None => break,
            }
        }
        assert_eq!(
            (found, scanned),
            (whole["outside"].as_array().unwrap().clone(), 5)
        );
        // A page cut to the bytes that fit continues exactly after its last scanned row.
        let size = whole.to_string().len();
        let (mut found, mut after, mut pages) = (Vec::new(), None::<String>, 0);
        loop {
            let mut input = json!({"list": "tasks-def"});
            input["after"] = json!(after);
            let page = answer_within(outside, input, &mut prefilled, size * 2 / 3).unwrap();
            assert!(page.to_string().len() <= size * 2 / 3);
            found.extend(page["outside"].as_array().unwrap().iter().cloned());
            pages += 1;
            match page["next"].as_str() {
                Some(next) => after = Some(next.to_owned()),
                None => break,
            }
        }
        assert_eq!(found, whole["outside"].as_array().unwrap().clone());
        assert!(pages >= 2, "{pages}");
        // A record that declares nothing reports none; an absent one and unknown inputs are refused.
        assert_eq!(
            answer(outside, json!({"list": "n1"}), &mut prefilled).unwrap()["kind"],
            Value::Null
        );
        assert_eq!(
            answer(outside, json!({"list": "no-def"}), &mut prefilled),
            Err(crate::cause!(Error::Invalid))
        );
        assert_eq!(
            answer(
                outside,
                json!({"list": "tasks-def", "extra": 1}),
                &mut prefilled
            ),
            Err(crate::cause!(Error::Invalid))
        );
        assert_eq!(
            answer(outside, json!({}), &mut prefilled),
            Err(crate::cause!(Error::Invalid))
        );
    }

    #[test]
    fn a_list_with_view_answers_the_kinds_schema_once_and_each_row_through_it() {
        use crate::storage::kind_views::FieldType;
        let mut prefilled = Prefilled::new();
        prefilled.schema(
            "note",
            &[
                ("words", FieldType::Text),
                ("stars", FieldType::Number),
                ("gone", FieldType::Boolean),
            ],
        );
        prefilled.put(
            "n1",
            "note",
            json!({"words": "one", "stars": 3, "extra": true}),
        );
        prefilled.put("n2", "note", json!({"words": 7, "stars": null}));
        prefilled.put("o1", "other", json!({"words": "x"}));
        let list = door().list_operation();
        let viewed = answer(list, json!({"type": "note", "view": true}), &mut prefilled).unwrap();
        assert_eq!(
            viewed["schema"],
            json!({"fields": {"gone": "boolean", "stars": "number", "words": "text"}, "indexes": []})
        );
        assert_eq!(
            viewed["records"][1]["fields"],
            json!({"gone": null, "stars": 3, "words": "one"})
        );
        assert_eq!(viewed["records"][1]["mismatched"], json!([]));
        assert_eq!(
            viewed["records"][0]["fields"],
            json!({"gone": null, "stars": null, "words": null})
        );
        assert_eq!(viewed["records"][0]["mismatched"], json!(["words"]));
        // The whole value stays; the asked `fields` narrow it and keep the typed view.
        assert_eq!(viewed["records"][1]["value"]["extra"], true);
        let narrowed = answer(
            list,
            json!({"type": "note", "view": true, "fields": []}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(narrowed["records"][1].get("value"), None);
        assert_eq!(narrowed["records"][1]["fields"]["words"], "one");
        // A kind with no history has a null schema and rows without typed fields; no view leaves the page as before.
        let none = answer(list, json!({"type": "other", "view": true}), &mut prefilled).unwrap();
        assert_eq!(
            (&none["schema"], none["records"][0].get("fields")),
            (&Value::Null, None)
        );
        let plain = answer(list, json!({"type": "note"}), &mut prefilled).unwrap();
        assert!(plain.get("schema").is_none() && plain["records"][0].get("fields").is_none());
        assert_eq!(
            answer(list, json!({"type": "note", "view": "yes"}), &mut prefilled),
            Err(crate::cause!(Error::Invalid))
        );
    }

    #[test]
    fn a_list_pages_a_kind_and_continues_from_its_cursor_text() {
        let mut prefilled = Prefilled::new();
        for n in 1..=5 {
            prefilled.put(&format!("n{n}"), "note", json!({"n": n}));
        }
        prefilled.put("t1", "task", json!({}));
        let list = door().list_operation();
        let first = answer(list, json!({"type": "note", "limit": 2}), &mut prefilled).unwrap();
        let ids = |page: &Value| {
            page["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&first), [json!("n5"), json!("n4")]);
        let next = first["next"].as_str().unwrap().to_owned();
        let second = answer(
            list,
            json!({"type": "note", "limit": 2, "after": next}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids(&second), [json!("n3"), json!("n2")]);
        let rest = answer(
            list,
            json!({"type": "note", "after": second["next"].clone()}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids(&rest), [json!("n1")]);
        assert_eq!(rest["next"], Value::Null);
        assert_eq!(
            answer(list, json!({"type": "note", "limit": 0}), &mut prefilled),
            Err(crate::cause!(Error::Invalid))
        );
        assert_eq!(
            answer(
                list,
                json!({"type": "note", "after": "no mark"}),
                &mut prefilled
            ),
            Err(crate::cause!(Error::Invalid))
        );
    }

    /// Every id a list answers over its pages, each page within `bytes`, and how many pages it took.
    fn paged_ids(
        mut input: Value,
        prefilled: &mut Prefilled,
        bytes: usize,
    ) -> (Vec<String>, usize) {
        let (mut ids, mut pages) = (Vec::new(), 0);
        loop {
            let page =
                answer_within(door().list_operation(), input.clone(), prefilled, bytes).unwrap();
            assert!(page.to_string().len() <= bytes, "a page is cut to fit");
            ids.extend(
                page["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["id"].as_str().unwrap().to_owned()),
            );
            pages += 1;
            match page["next"].as_str() {
                Some(next) => input["after"] = json!(next),
                None => return (ids, pages),
            }
        }
    }

    #[test]
    fn a_list_is_cut_to_the_bytes_that_fit_and_every_row_comes_once_in_order_by_id_and_by_an_order()
    {
        let mut prefilled = Prefilled::new();
        for n in 1..=9 {
            prefilled.put(
                &format!("n{n}"),
                "note",
                json!({"words": "w".repeat(100), "parent": format!("p{n}")}),
            );
        }
        let whole = answer(
            door().list_operation(),
            json!({"type": "note"}),
            &mut prefilled,
        )
        .unwrap()
        .to_string()
        .len();
        let by_id: Vec<String> = (1..=9).rev().map(|n| format!("n{n}")).collect();
        let (ids, pages) = paged_ids(json!({"type": "note"}), &mut prefilled, whole / 3);
        assert_eq!(ids, by_id);
        assert!(pages >= 3, "{pages}");
        // By an order, ascending by parent: the cursor a cut page names is that order's position of its last row.
        let (ids, pages) = paged_ids(
            json!({"type": "note", "order": "test order by parent"}),
            &mut prefilled,
            whole / 3,
        );
        assert_eq!(ids, (1..=9).map(|n| format!("n{n}")).collect::<Vec<_>>());
        assert!(pages >= 3, "{pages}");
        // What fits whole is answered whole, with no `next`.
        let all = answer_within(
            door().list_operation(),
            json!({"type": "note"}),
            &mut prefilled,
            whole,
        )
        .unwrap();
        assert_eq!(all["records"].as_array().unwrap().len(), 9);
        assert_eq!(all["next"], Value::Null);
    }

    #[test]
    fn a_list_page_that_spans_read_chunks_continues_exactly_after_its_last_row() {
        let mut prefilled = Prefilled::new();
        for n in 1..=80 {
            prefilled.put(
                &format!("n{n:02}"),
                "note",
                json!({"words": "w".repeat(100), "parent": format!("p{n:02}")}),
            );
        }
        let whole = answer(
            door().list_operation(),
            json!({"type": "note", "limit": 999}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(whole["records"].as_array().unwrap().len(), 80);
        let bound = whole.to_string().len() / 2;
        // About 40 rows a page: more than one read chunk, so a page ends past a chunk's edge.
        for input in [
            json!({"type": "note", "limit": 999}),
            json!({"type": "note", "limit": 999, "order": "test order by parent"}),
        ] {
            let (ids, pages) = paged_ids(input.clone(), &mut prefilled, bound);
            let by_order = input.get("order").is_some();
            let expected: Vec<String> = if by_order {
                (1..=80).map(|n| format!("n{n:02}")).collect()
            } else {
                (1..=80).rev().map(|n| format!("n{n:02}")).collect()
            };
            assert_eq!(ids, expected);
            assert_eq!(pages, 3, "{pages} pages");
        }
    }

    /// The answer a reader assembles from the byte pages of one that does not fit `bytes`: every page within
    /// `bytes`, the pages' lengths and BLAKE3 matching what each says of the whole.
    fn assembled(
        operation: &str,
        input: Value,
        prefilled: &mut Prefilled,
        bytes: usize,
    ) -> (Value, usize) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let (mut joined, mut pages, mut after) = (Vec::new(), 0, None::<u64>);
        loop {
            let mut call = input.clone();
            if let Some(after) = after {
                call["after_byte"] = json!(after);
            }
            let page = answer_within(operation, call, prefilled, bytes).unwrap();
            assert!(page.to_string().len() <= bytes, "a byte page fits");
            let page = &page["byte_page"];
            assert_eq!(page["offset"].as_u64().unwrap() as usize, joined.len());
            joined.extend(STANDARD.decode(page["base64"].as_str().unwrap()).unwrap());
            pages += 1;
            if page["next_after_byte"].is_null() {
                assert_eq!(page["total"].as_u64().unwrap() as usize, joined.len());
                assert_eq!(
                    page["blake3"].as_str().unwrap(),
                    content_crypto::advanced::blake3::hash(&joined)
                        .to_hex()
                        .as_str()
                );
                return (serde_json::from_slice(&joined).unwrap(), pages);
            }
            after = page["next_after_byte"].as_u64();
        }
    }

    #[test]
    fn a_list_projection_carries_only_the_named_fields_so_a_page_holds_many_more_rows() {
        let mut prefilled = Prefilled::new();
        for n in 1..=60 {
            prefilled.put(
                &format!("n{n:02}"),
                "note",
                json!({"words": "w".repeat(200), "parent": format!("p{n:02}")}),
            );
        }
        let list = door().list_operation();
        let bound = 4_000;
        let (whole_ids, whole_pages) =
            paged_ids(json!({"type": "note", "limit": 999}), &mut prefilled, bound);
        let named = answer_within(
            list,
            json!({"type": "note", "limit": 999, "fields": ["parent"]}),
            &mut prefilled,
            bound,
        )
        .unwrap();
        assert_eq!(
            named["next"],
            Value::Null,
            "sixty projected rows are one page"
        );
        assert!(whole_pages >= 4, "{whole_pages} pages without a projection");
        assert_eq!(named["records"].as_array().unwrap().len(), whole_ids.len());
        assert_eq!(
            named["records"][0],
            json!({"id": "n60", "type": "note", "value": {"parent": "p60"}})
        );
        // No names: ids and types alone. A name the value lacks is simply absent.
        let ids = answer(
            list,
            json!({"type": "note", "limit": 2, "fields": []}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids["records"][0], json!({"id": "n60", "type": "note"}));
        let missing = answer(
            list,
            json!({"type": "note", "limit": 1, "fields": ["nothing"]}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(missing["records"][0]["value"], json!({}));
        for bad in [
            json!("parent"),
            json!([""]),
            json!([1]),
            json!(vec!["f"; 65]),
        ] {
            assert_eq!(
                answer(list, json!({"type": "note", "fields": bad}), &mut prefilled),
                Err(crate::cause!(Error::Invalid))
            );
        }
    }

    #[test]
    fn a_list_where_shows_only_the_rows_whose_fields_equal_it_and_limit_bounds_the_rows_shown() {
        let mut prefilled = Prefilled::new();
        for n in 1..=60 {
            let step = if n % 10 == 0 { "rare" } else { "common" };
            prefilled.put(
                &format!("n{n:02}"),
                "note",
                json!({"step": step, "group": n % 2, "words": "w".repeat(200)}),
            );
        }
        let list = door().list_operation();
        // One call reads the whole kind and answers only its six matching rows, newest first.
        let rare = answer_within(
            list,
            json!({"type": "note", "limit": 999, "where": {"step": "rare"}}),
            &mut prefilled,
            4_000,
        )
        .unwrap();
        assert_eq!(rare["next"], Value::Null, "{rare}");
        let ids: Vec<&str> = rare["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["n60", "n50", "n40", "n30", "n20", "n10"]);
        // Every named field must match, and the asked `fields` still narrow what is shown.
        let both = answer(
            list,
            json!({"type": "note", "limit": 999, "where": {"step": "rare", "group": 1}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(both["records"], json!([]));
        let even = answer(list, json!({"type": "note", "limit": 999, "where": {"step": "rare", "group": 0}, "fields": []}), &mut prefilled).unwrap();
        assert_eq!(even["records"][0], json!({"id": "n60", "type": "note"}));
        // With `where`, `limit` bounds the rows shown: a page of 5 shows 5 matches, read as far down as they are, and
        // the next page continues after the last row it read.
        let first = answer(
            list,
            json!({"type": "note", "limit": 5, "where": {"step": "rare"}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(first["records"].as_array().unwrap().len(), 5, "{first}");
        let rest = answer(list, json!({"type": "note", "limit": 999, "where": {"step": "rare"}, "after": first["next"]}), &mut prefilled).unwrap();
        assert_eq!(rest["records"].as_array().unwrap().len(), 1, "{rest}");
        assert_eq!(rest["records"][0]["id"], "n10");
        for bad in [
            json!("rare"),
            json!({}),
            json!({"": 1}),
            json!([{"step": "rare"}]),
        ] {
            assert_eq!(
                answer(list, json!({"type": "note", "where": bad}), &mut prefilled),
                Err(crate::cause!(Error::Invalid))
            );
        }
    }

    /// A filter on a field a declared order lists the kind by reads that order's run of equal values, so a page of
    /// `limit` rows shows `limit` matches instead of the matches among `limit` rows read; with no such order it reads
    /// the kind row by row and continues at the exact last position when the bounded scan page ends.
    #[test]
    fn a_list_where_on_an_ordered_field_reads_its_run_and_unindexed_filters_continue() {
        let mut prefilled = Prefilled::new();
        for n in 1..=40 {
            prefilled.put(
                &format!("n{n:02}"),
                "note",
                json!({"parent": format!("p{}", n % 4), "step": n % 5, "words": "w"}),
            );
        }
        let list = door().list_operation();
        let ids = |page: &Value| -> Vec<String> {
            page["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_owned())
                .collect()
        };
        // `parent` has a declared order: five rows read are five matches, greatest id first, and the run continues.
        let first = answer(
            list,
            json!({"type": "note", "limit": 5, "where": {"parent": "p1"}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids(&first), ["n37", "n33", "n29", "n25", "n21"], "{first}");
        assert!(first["next"].is_string());
        let (mut all, mut input) = (
            ids(&first),
            json!({"type": "note", "limit": 5, "where": {"parent": "p1"}}),
        );
        input["after"] = first["next"].clone();
        loop {
            let page = answer(list, input.clone(), &mut prefilled).unwrap();
            all.extend(ids(&page));
            match page["next"].as_str() {
                Some(next) => input["after"] = json!(next),
                None => break,
            }
        }
        assert_eq!(all.len(), 10, "{all:?}");
        assert!(
            all.iter()
                .all(|id| id[1..].parse::<u32>().unwrap() % 4 == 1),
            "{all:?}"
        );
        // Another field of the same call still has to match, and a value no row holds shows nothing.
        let both = answer(
            list,
            json!({"type": "note", "limit": 99, "where": {"parent": "p1", "step": 2}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids(&both), ["n37", "n17"], "{both}");
        let none = answer(
            list,
            json!({"type": "note", "where": {"parent": "p9"}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(none["records"], json!([]));
        // `step` has no order: a small kind is read row by row (the matches among the rows read).
        let by_row = answer(
            list,
            json!({"type": "note", "limit": 999, "where": {"step": 2}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(ids(&by_row).len(), 8, "{by_row}");
        let unindexed = answer(
            list,
            json!({"type": "note", "limit": 10_000, "where": {"step": 2}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(
            ids(&unindexed).len(),
            8,
            "unindexed filtering remains available"
        );
        assert_eq!(unindexed["next"], Value::Null);
        let ordered = answer(
            list,
            json!({"type": "note", "where": {"parent": "p1"}}),
            &mut prefilled,
        );
        assert!(
            ordered.is_ok(),
            "an ordered field is read through its order"
        );
        let narrowed = answer(
            list,
            json!({"type": "note", "where": {"step": 2}, "prefix": "n1"}),
            &mut prefilled,
        );
        assert!(
            narrowed.is_ok(),
            "a call narrowed by id prefix remains available"
        );
    }

    #[test]
    fn a_large_unindexed_filter_reads_the_whole_list_in_one_answer() {
        let mut prefilled = Prefilled::new();
        for n in 0..=1_100 {
            let step = if n == 0 { "rare" } else { "common" };
            prefilled.put(&format!("n{n:04}"), "note", json!({"step": step}));
        }
        let list = door().list_operation();
        // The one match is the last id of 1,101: a filter reads past the first 1,000 positions in the same answer.
        let whole = answer(
            list,
            json!({"type": "note", "limit": 10_000, "where": {"step": "rare"}}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(whole["records"].as_array().unwrap().len(), 1, "{whole}");
        assert_eq!(whole["records"][0]["id"], "n0000");
        assert_eq!(whole["next"], Value::Null);
        // A list with no filter is still one bounded page of the rows read.
        let page = answer(
            list,
            json!({"type": "note", "limit": 10, "fields": []}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(page["records"].as_array().unwrap().len(), 10);
        assert!(page["next"].is_string());
    }

    /// One question over every kind (the port of old trillion src/search.mjs `finish`): the one row holding a word,
    /// written far down among thousands, comes back first with where it was found, the words around it and the read
    /// that opens it; every asked word must be held; an edit drops the old words; a type keeps only that kind.
    #[test]
    fn a_search_finds_the_one_row_holding_a_word_among_thousands_and_answers_its_address() {
        let mut prefilled = Prefilled::new();
        let lists = ["contacts", "invoices", "places"];
        for n in 1..=3_000u32 {
            let kind = lists[(n % 3) as usize];
            let words = if n == 2_731 {
                "call the zephyrine plumber about the leak".to_owned()
            } else {
                format!("ordinary row {n}")
            };
            prefilled.put(
                &format!("r{n:05}"),
                kind,
                json!({"title": format!("row {n}"), "notes": words, "state": "open"}),
            );
        }
        let search = door().search_operation();
        assert!(door().answers(door().resource(), search));
        let found = answer(
            search,
            json!({"question": "Zephyrine plumber?"}),
            &mut prefilled,
        )
        .unwrap();
        let results = found["results"].as_array().unwrap();
        assert_eq!(results.len(), 1, "{found}");
        let hit = &results[0];
        assert_eq!(hit["record"], "r02731");
        assert_eq!(hit["type"], lists[(2_731 % 3) as usize]);
        assert_eq!(hit["title"], "row 2731");
        assert_eq!(hit["found_in"], json!(["written"]));
        assert!(
            hit["said"].as_str().unwrap().contains("zephyrine plumber"),
            "{hit}"
        );
        assert_eq!(
            hit["address"],
            json!({"resource": door().resource(), "operation": door().read_operation(),
            "input": {"id": "r02731", "type": hit["type"]}})
        );
        assert_eq!(found["terms"], json!(["zephyrine", "plumber"]));
        // Every asked word must be held; a word no record holds answers nothing.
        let none = answer(
            search,
            json!({"question": "zephyrine electrician"}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(none["results"], json!([]));
        // A common word narrows nothing, and the rare one still finds the row.
        let common = answer(search, json!({"question": "the leak row"}), &mut prefilled).unwrap();
        assert_eq!(common["results"][0]["record"], "r02731", "{common}");
        // A type keeps only that kind.
        let other = answer(
            search,
            json!({"question": "zephyrine", "type": "places-elsewhere"}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(other["results"], json!([]));
        // An edit drops the words it no longer holds: the stale posting is checked against the current row.
        prefilled.put(
            "r02731",
            hit["type"].as_str().unwrap(),
            json!({"title": "row 2731", "notes": "fixed", "state": "done"}),
        );
        let gone = answer(search, json!({"question": "zephyrine"}), &mut prefilled).unwrap();
        assert_eq!(gone["results"], json!([]), "{gone}");
        let fixed = answer(search, json!({"question": "fixed"}), &mut prefilled).unwrap();
        assert_eq!(fixed["results"][0]["record"], "r02731");
        // Unknown fields, an empty question and an out-of-range limit are input refusals, named by field.
        for bad in [
            json!({}),
            json!({"question": " "}),
            json!({"question": "x", "limit": 0}),
            json!({"question": "x", "extra": 1}),
        ] {
            assert_eq!(
                answer(search, bad.clone(), &mut prefilled),
                Err(crate::cause!(Error::Invalid)),
                "{bad}"
            );
            assert!(door().input_fault(search, &bad).is_some(), "{bad}");
        }
    }

    /// The proof the case asks for, on trillion-local's own store in memory (the computer place-fsn1 was not reachable
    /// from where this was written): 10,000 rows across 3 lists, a word only row 9,731 holds, found first in one call
    /// and read back through the address the hit answers. The time is printed (`--nocapture`), measured, not assumed.
    #[test]
    fn a_search_over_ten_thousand_rows_in_three_lists_answers_row_9731_first() {
        let mut prefilled = Prefilled::new();
        let lists = ["list-a", "list-b", "list-c"];
        for n in 1..=10_000u32 {
            let words = if n == 9_731 {
                "quartzbeacon left at the dock".to_owned()
            } else {
                format!("plain row {n} of the list")
            };
            prefilled.put(
                &format!("row{n:05}"),
                lists[(n % 3) as usize],
                json!({"title": format!("row {n}"), "notes": words}),
            );
        }
        let started = std::time::Instant::now();
        let found = answer(
            door().search_operation(),
            json!({"question": "quartzbeacon"}),
            &mut prefilled,
        )
        .unwrap();
        let took = started.elapsed();
        crate::quiet_println!(
            "search over 10,000 rows in 3 lists: {} ms",
            took.as_secs_f64() * 1000.0
        );
        assert_eq!(found["results"][0]["record"], "row09731", "{found}");
        let address = &found["results"][0]["address"];
        let read = answer(
            address["operation"].as_str().unwrap(),
            address["input"].clone(),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(read["value"]["notes"], "quartzbeacon left at the dock");
        // The same row through a filtered list of its kind: `where` reads the whole list in one call.
        let started = std::time::Instant::now();
        let listed = answer(
            door().list_operation(),
            json!({"type": lists[(9_731 % 3) as usize], "where": {"title": "row 9731"}}),
            &mut prefilled,
        )
        .unwrap();
        crate::quiet_println!(
            "where over one list of 3,333 rows: {} ms",
            started.elapsed().as_secs_f64() * 1000.0
        );
        assert_eq!(listed["records"][0]["id"], "row09731", "{listed}");
    }

    /// A kind its model marks `readers` (record_model_policy DATA: the vault's own held values) is answered to no door
    /// read, list or search, and no every-kind search shows its rows, whichever kinds the caller holds. A second made-up
    /// kind with the same mark is hidden too, so a future private kind needs only its DATA row.
    #[test]
    fn a_vault_only_kind_is_hidden_from_every_door_read_list_and_every_kind_search() {
        let model = crate::record_model_policy::Installed::from_rows(
            [&json!({"record_model": {"kinds": [
                {"type": "vault-kind-a", "readers": "vault"},
                {"type": "vault-kind-b", "readers": "vault"},
            ]}})],
            true,
        )
        .unwrap();
        let mut prefilled = Prefilled::new();
        prefilled.put("c1", "contacts", json!({"title": "c1", "notes": "the merlinfalcon of contacts"}));
        prefilled.put("v1", "vault-kind-a", json!({"title": "v1", "notes": "the merlinfalcon of vault a"}));
        prefilled.put("v2", "vault-kind-b", json!({"title": "v2", "notes": "the merlinfalcon of vault b"}));
        let shipped = door();
        let search = shipped.search_operation();
        let read = shipped.read_operation();
        let answer = |operation: &str, input: Value, prefilled: &mut Prefilled| {
            shipped.answer(operation, &input, prefilled, &model, Limits::default(), &|_| true)
        };
        let every = answer(search, json!({"question": "merlinfalcon"}), &mut prefilled).unwrap();
        let kinds: Vec<&str> = every["results"].as_array().unwrap().iter().map(|hit| hit["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["contacts"], "every-kind search shows no vault-only rows: {every}");
        assert!(
            answer(search, json!({"question": "merlinfalcon", "type": "vault-kind-b"}), &mut prefilled).is_err(),
            "a search naming a vault-only kind is refused"
        );
        assert!(answer(read, json!({"id": "v1"}), &mut prefilled).is_err(), "a read of a vault-only record is refused");
        assert!(answer(read, json!({"id": "v2", "type": "vault-kind-b"}), &mut prefilled).is_err());
        assert!(answer(shipped.list_operation(), json!({"type": "vault-kind-a"}), &mut prefilled).is_err(), "a list of a vault-only kind is refused");
        assert!(answer(read, json!({"id": "c1"}), &mut prefilled).is_ok(), "an ordinary record still reads");
    }

    /// The history of a soft-deleted owner-only record is refused, since its live versions hold their kind; an ordinary
    /// record's history still answers.
    #[test]
    fn a_history_of_a_deleted_owner_only_record_is_refused_and_an_ordinary_one_answers() {
        let model = crate::record_model_policy::Installed::from_rows(
            [&json!({"record_model": {"kinds": [{"type": "vault-kind-a", "readers": "vault"}, {"type": "note"}]}})],
            true,
        )
        .unwrap();
        let mut prefilled = Prefilled::new();
        prefilled.put("v3", "vault-kind-a", json!({"title": "v3"}));
        prefilled.remove("v3");
        prefilled.put("n1", "note", json!({"title": "n1"}));
        let shipped = door();
        let history = shipped.history_operation();
        let answer = |id: &str, prefilled: &mut Prefilled| {
            shipped.answer(history, &json!({"id": id, "limit": 10}), prefilled, &model, Limits::default(), &|_| true)
        };
        assert!(answer("v3", &mut prefilled).is_err(), "a soft-deleted owner-only record keeps its refusal");
        assert!(answer("n1", &mut prefilled).is_ok(), "an ordinary record's history still answers");
    }

    /// A tool run's search over every kind, end to end through the shared rights owner: the run's capability is minted
    /// from its row's `invoke.records`, the call the run sends is narrowed by it (account_rights::run_capability), and
    /// the narrowed input is what is answered. With the read-only right over every kind the run finds rows of three
    /// kinds; without it the same call is refused before anything is read; with it the run still cannot write.
    #[test]
    fn a_run_with_the_search_right_over_every_kind_finds_rows_of_three_kinds_and_cannot_write() {
        use crate::account_rights::run_capability::{held, mint, Refusal, Rights};
        let mut prefilled = Prefilled::new();
        for (id, kind) in [
            ("c1", "contacts"),
            ("i1", "invoices"),
            ("t1", "trips"),
            ("t2", "trips"),
        ] {
            let words = if id == "t2" {
                "nothing here".to_owned()
            } else {
                format!("the merlinfalcon of {kind}")
            };
            prefilled.put(id, kind, json!({"title": id, "notes": words}));
        }
        let shipped = door();
        let search = shipped.search_operation();
        let write = crate::record_write_model::write_command::Command::shipped()
            .unwrap()
            .operation();
        let principal = crate::mcp::Principal { kind: crate::mcp::PrincipalKind::Person,            account_id: "account-1".into(),
            sign_in: "parent".into(),
            client_id: String::new(),
        };
        let call = |operation: &str, input: Value| crate::mcp::Operation {
            person_present: None,
            resource: shipped.resource().to_owned(),
            operation: operation.to_owned(),
            input,
            request_key: "k".into(),
        };
        let row = |rights: Value| Rights::declared(&json!({"fd": 3, "rights": rights})).unwrap();
        let minute = std::time::Duration::from_secs(60);
        let asked = json!({"question": "merlinfalcon"});

        let with = mint(
            "account-1",
            b"parent-key",
            row(json!([{"kind": "*", "operations": [search]}])),
            None,
            minute,
        )
        .unwrap();
        let run = held(with.token().as_bytes()).unwrap().unwrap();
        let narrowed = run
            .narrow(&principal, &call(search, asked.clone()))
            .unwrap();
        let found = answer(search, narrowed, &mut prefilled).unwrap();
        let mut kinds: Vec<&str> = found["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["type"].as_str().unwrap())
            .collect();
        kinds.sort_unstable();
        assert_eq!(kinds, ["contacts", "invoices", "trips"], "{found}");
        let written =
            json!({"records": [{"id": "c1", "type": "contacts", "value": {"title": "changed"}}]});
        assert_eq!(
            run.narrow(&principal, &call(write, written)),
            Err(crate::cause!(Refusal::NotGranted)),
            "the search right never writes"
        );

        let without = mint(
            "account-1",
            b"parent-key",
            row(json!([{"kind": "contacts", "operations": [search]}])),
            None,
            minute,
        )
        .unwrap();
        let run = held(without.token().as_bytes()).unwrap().unwrap();
        assert_eq!(
            run.narrow(&principal, &call(search, asked)),
            Err(crate::cause!(Refusal::NotGranted)),
            "no right over every kind"
        );
        let one = run
            .narrow(
                &principal,
                &call(
                    search,
                    json!({"question": "merlinfalcon", "type": "contacts"}),
                ),
            )
            .unwrap();
        assert_eq!(
            answer(search, one, &mut prefilled).unwrap()["results"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_search_ranks_each_kind_by_its_own_order_and_merges_them_by_rank() {
        let mut prefilled = Prefilled::new();
        prefilled.put("a1", "alpha", json!({"text": "kestrel one"}));
        prefilled.put("a2", "alpha", json!({"text": "kestrel two"}));
        prefilled.put("b1", "beta", json!({"text": "kestrel three"}));
        let found = answer(
            door().search_operation(),
            json!({"question": "kestrel"}),
            &mut prefilled,
        )
        .unwrap();
        let ids: Vec<&str> = found["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["record"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 3, "{found}");
        // The first of each kind ties at 1/(k+1); the second of alpha is worth 1/(k+2), so it comes last.
        assert_eq!(ids[2], "a1", "{found}");
        assert_eq!(found["results"][0]["score"], found["results"][1]["score"]);
        let one = answer(
            door().search_operation(),
            json!({"question": "kestrel", "limit": 1}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(one["results"].as_array().unwrap().len(), 1);
    }

    // records:read {id, at}: the record as it was saved at a moment (old trillion record-log-store.mjs recordAt; the
    // Workshop's keep-lists-of-rows readAt).
    #[test]
    fn a_read_at_a_moment_answers_the_version_saved_then() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"words": "first"}));
        std::thread::sleep(std::time::Duration::from_millis(5));
        prefilled.put("n1", "note", json!({"words": "second"}));
        let history = answer(
            door().history_operation(),
            json!({"id": "n1", "limit": 5}),
            &mut prefilled,
        )
        .unwrap();
        let first_at = history["versions"][1]["at"].as_str().unwrap().to_owned();
        let at_first = answer(
            door().read_operation(),
            json!({"id": "n1", "at": first_at}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(at_first["value"], json!({"words": "first"}), "{at_first}");
        assert!(
            at_first.get("identity").is_none(),
            "a historical version is not a current root fence"
        );
        assert_eq!(
            (at_first["version"].clone(), at_first["complete"].clone()),
            (json!(1), json!(true))
        );
        let now = answer(
            door().read_operation(),
            json!({"id": "n1", "at": u64::MAX >> 12}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(
            now["value"],
            json!({"words": "second"}),
            "a later moment reads the current version"
        );
        let before = answer(
            door().read_operation(),
            json!({"id": "n1", "at": 1}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(
            (before["value"].clone(), before["complete"].clone()),
            (Value::Null, json!(true)),
            "before its first save there was none"
        );
        let other = answer(
            door().read_operation(),
            json!({"id": "n1", "type": "task", "at": first_at}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(
            other["value"],
            Value::Null,
            "another kind answers nothing, as a plain read"
        );
        assert!(answer(
            door().read_operation(),
            json!({"id": "n1", "at": "yesterday"}),
            &mut prefilled
        )
        .is_err());
        assert_eq!(
            answer(door().read_operation(), json!({"id": "n1"}), &mut prefilled).unwrap()["value"],
            json!({"words": "second"})
        );
    }

    #[test]
    fn compact_identity_is_the_root_stamp_before_computed_fields() {
        let settings = crate::rule_bindings::rules_and_runs::settings().unwrap();
        let row_type = "sample";
        let row_kind = format!("{}{row_type}", settings.row_kind_prefix);
        let (field_kind, calculated, binding_kind) = ("text", "calculated", "binding");
        let formula = json!({"id":calculated,"kind":field_kind,"value":"computed","carries":{"key":"derive","defaults":{"target":"formula-engine","result_path":["value"]}}});
        let model =
            Installed::from_rows(&[json!({"record_model":{"field_kinds":[formula]}})], true)
                .unwrap();
        let fields = |name: &str| json!({"row_type":row_type,"fields":[{"id":"minutes","kind":field_kind},{"id":"other","kind":field_kind},{"id":"output","kind":calculated,"derive":{"request":{"binding":{"$kind":binding_kind,"select":{"from":"self","path":[name]}}}}}]});
        let mut prefilled = Prefilled::new();
        prefilled.put(
            "computed-definition",
            &settings.list_kind,
            fields("minutes"),
        );
        prefilled.put("computed-row", &row_kind, json!({"minutes":2,"other":3}));
        let before = door()
            .answer(
                door().read_operation(),
                &json!({"id":"computed-row"}),
                &mut prefilled,
                &model,
                Limits::default(),
                &|_| true,
            )
            .unwrap();
        assert_eq!(before["identity"], "seq-2");
        assert_eq!(before["computed"]["output"], 2);
        assert_eq!(
            before["value"],
            json!({"minutes":2,"other":3}),
            "computed fields are not part of the stored root"
        );
        prefilled.put("computed-definition", &settings.list_kind, fields("other"));
        let after = door()
            .answer(
                door().read_operation(),
                &json!({"id":"computed-row"}),
                &mut prefilled,
                &model,
                Limits::default(),
                &|_| true,
            )
            .unwrap();
        assert_eq!(
            after["identity"], before["identity"],
            "a root fence does not claim to fence its computed dependencies"
        );
        assert_eq!(after["computed"]["output"], 3);
    }

    #[test]
    fn scoped_byte_pages_search_addresses_and_detached_rows_keep_their_full_history() {
        let mut stores = [Prefilled::new(), Prefilled::new(), Prefilled::new()];
        let a = json!({"id":"scope-a","incarnation":"first","generation":1});
        let b = json!({"id":"scope-b","incarnation":"first","generation":1});
        stores[1].domain = Some(a.clone());
        stores[2].domain = Some(b.clone());
        for (index, store) in stores.iter_mut().enumerate() {
            store.put("n1", "note", json!({"title":"zephyrine","words":"w".repeat(500),"scope":{"user":"value"},"which":index}));
            store.put("n2", "note", json!({"title":"other","which":index}));
        }
        for (index, store) in stores.iter_mut().enumerate() {
            let mut input = json!({"id":"n1"});
            if let Some(scope) = &store.domain { input["scope"] = scope.clone(); }
            let (read, pages) = assembled(door().read_operation(), input.clone(), store, 450);
            assert!(pages >= 2);
            assert_eq!(read["value"]["which"], index);
            assert_eq!(read["value"]["scope"], json!({"user":"value"}), "user value is never rewritten");
            assert_eq!(read.get("scope"), input.get("scope"));
            let mut list_input = json!({"type":"note","limit":1});
            if let Some(scope) = read.get("scope") { list_input["scope"] = scope.clone(); }
            let page = answer(door().list_operation(), list_input.clone(), store).unwrap();
            assert_eq!(page["records"][0].get("scope"), read.get("scope"));
            list_input["after"] = page["next"].clone();
            let next = answer(door().list_operation(), list_input, store).unwrap();
            assert_ne!(page["records"][0]["id"], next["records"][0]["id"]);
            let mut search_input = json!({"question":"zephyrine"});
            if let Some(scope) = read.get("scope") { search_input["scope"] = scope.clone(); }
            let found = answer(door().search_operation(), search_input, store).unwrap();
            let address = &found["results"][0]["address"];
            assert_eq!(address["input"].get("scope"), read.get("scope"));
            let followed = answer(address["operation"].as_str().unwrap(), address["input"].clone(), store).unwrap();
            assert_eq!(followed["value"]["which"], index);
        }
        let before = stores[1].opened;
        assert_eq!(answer(door().read_operation(), json!({"id":"n1","scope":b}), &mut stores[1]), Err(crate::cause!(Error::Invalid)));
        assert_eq!(stores[1].opened, before, "wrong-history refusal precedes record access");
    }

    #[test]
    fn a_row_or_record_larger_than_the_bound_comes_as_pages_of_its_own_bytes() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"words": "w".repeat(500)}));
        let whole = |operation: &str, input: Value, prefilled: &mut Prefilled| {
            answer(operation, input, prefilled).unwrap()
        };
        // A read, a list's first row and a history's first version: each is the answer the caller would have had.
        let (read, pages) = assembled(
            door().read_operation(),
            json!({"id": "n1"}),
            &mut prefilled,
            300,
        );
        assert_eq!(
            read,
            whole(door().read_operation(), json!({"id": "n1"}), &mut prefilled)
        );
        assert!(pages >= 3, "{pages} pages");
        let (list, _) = assembled(
            door().list_operation(),
            json!({"type": "note"}),
            &mut prefilled,
            300,
        );
        assert_eq!(
            list,
            whole(
                door().list_operation(),
                json!({"type": "note", "limit": 1}),
                &mut prefilled
            )
        );
        let (history, _) = assembled(
            door().history_operation(),
            json!({"id": "n1", "limit": 5}),
            &mut prefilled,
            300,
        );
        assert_eq!(
            history,
            whole(
                door().history_operation(),
                json!({"id": "n1", "limit": 1}),
                &mut prefilled
            )
        );
        // What fits is not paged, and a byte past the answer's end is an input refusal.
        assert!(answer_within(
            door().read_operation(),
            json!({"id": "n1"}),
            &mut prefilled,
            600
        )
        .unwrap()
        .get("byte_page")
        .is_none());
        let beyond = answer_within(
            door().read_operation(),
            json!({"id": "n1", "after_byte": 100_000}),
            &mut prefilled,
            300,
        );
        assert_eq!(beyond, Err(crate::cause!(Error::Invalid)));
        assert_eq!(
            answer(
                door().read_operation(),
                json!({"id": "n1", "after_byte": "x"}),
                &mut prefilled
            ),
            Err(crate::cause!(Error::Invalid))
        );
    }

    #[test]
    fn a_history_is_cut_to_the_bytes_that_fit_and_continues_below_its_last_version() {
        let mut prefilled = Prefilled::new();
        for n in 1..=6 {
            prefilled.put("n1", "note", json!({"n": n, "words": "w".repeat(100)}));
        }
        let whole = history_of(json!({"id": "n1", "limit": 6}), &mut prefilled)
            .unwrap()
            .to_string()
            .len();
        let (mut seen, mut input) = (Vec::new(), json!({"id": "n1", "limit": 6}));
        loop {
            let page = answer_within(
                door().history_operation(),
                input.clone(),
                &mut prefilled,
                whole / 2,
            )
            .unwrap();
            assert!(page.to_string().len() <= whole / 2);
            seen.extend(versions_of(&page));
            match page["next"].as_i64() {
                Some(next) => input["before_version"] = json!(next),
                None => break,
            }
        }
        assert_eq!(seen, [6, 5, 4, 3, 2, 1]);
    }

    fn history_of(input: Value, prefilled: &mut Prefilled) -> Result<Value> {
        answer(door().history_operation(), input, prefilled)
    }

    fn versions_of(page: &Value) -> Vec<i64> {
        page["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["version"].as_i64().unwrap())
            .collect()
    }

    #[test]
    fn a_history_pages_three_versions_newest_first_by_two_and_continues_before_a_version() {
        let mut prefilled = Prefilled::new();
        for n in 1..=3 {
            prefilled.put("n1", "note", json!({"n": n}));
        }
        let first = history_of(json!({"id": "n1", "limit": 2}), &mut prefilled).unwrap();
        assert_eq!(versions_of(&first), [3, 2]);
        assert_eq!(first["versions"][0]["value"], json!({"n": 3}));
        assert_eq!(first["versions"][1]["value"], json!({"n": 2}));
        assert_eq!(first["versions"][0]["deleted"], false);
        let at = first["versions"][0]["at"].as_str().unwrap();
        assert!(at.ends_with('Z') && at.len() == 24, "{at}");
        assert_eq!(first["next"], 2);
        let second = history_of(
            json!({"id": "n1", "limit": 2, "before_version": first["next"].clone()}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(versions_of(&second), [1]);
        assert_eq!(second["versions"][0]["value"], json!({"n": 1}));
        assert_eq!(second["next"], Value::Null);
        let only = history_of(json!({"id": "n1", "limit": 5}), &mut prefilled).unwrap();
        assert_eq!(versions_of(&only), [3, 2, 1]);
        assert_eq!(only["next"], Value::Null);
        let before = history_of(
            json!({"id": "n1", "limit": 1, "before_version": 3}),
            &mut prefilled,
        )
        .unwrap();
        assert_eq!(versions_of(&before), [2]);
        assert_eq!(before["next"], 2);
    }

    #[test]
    fn a_history_of_an_unknown_id_is_empty_and_a_bad_input_refuses() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({}));
        let none = history_of(json!({"id": "n9", "limit": 3}), &mut prefilled).unwrap();
        assert_eq!(none, json!({"versions": [], "next": null}));
        for bad in [
            json!({"id": "n1"}),
            json!({"limit": 3}),
            json!({"id": "n1", "limit": 0}),
            json!({"id": "n1", "limit": 100_000}),
            json!({"id": "n1", "limit": 1, "before_version": 0}),
            json!({"id": "n1", "limit": 1, "before_version": "2"}),
            json!({"id": "n1", "limit": 1, "kind": "note"}),
        ] {
            assert_eq!(history_of(bad, &mut prefilled), Err(crate::cause!(Error::Invalid)));
        }
    }

    /// The field a refused input names and what it must be, for every operation, from the same parse the routes answer by.
    #[test]
    fn a_refused_input_names_its_field_and_the_shape_it_must_have_and_never_a_value() {
        let fault = |operation: &str, input: Value| {
            let fault = door()
                .input_fault(operation, &input)
                .unwrap_or_else(|| panic!("no fault for {input}"));
            (fault.field, fault.expected)
        };
        let (read, list, history, outside) = (
            door().read_operation(),
            door().list_operation(),
            door().history_operation(),
            door().outside_choices_operation(),
        );
        let missing_limit = fault(history, json!({"id": "n1"}));
        assert_eq!(
            missing_limit,
            (
                "limit".to_owned(),
                "required: a whole number from 1 to 100".to_owned()
            )
        );
        assert_eq!(fault(history, json!({"id": "n1", "limit": 0})).0, "limit");
        assert_eq!(
            fault(
                history,
                json!({"id": "n1", "limit": 1, "before_version": 0})
            )
            .0,
            "before_version"
        );
        let unknown = fault(history, json!({"id": "n1", "limit": 1, "SECRET_FIELD": 1}));
        assert_eq!(unknown.0, "SECRET_FIELD", "an unknown field is named");
        assert!(
            unknown.1.contains("id, before_version, limit"),
            "{}",
            unknown.1
        );
        assert_eq!(
            fault(read, json!({"type": "note"})),
            ("id".to_owned(), "required: non-empty text".to_owned())
        );
        assert_eq!(fault(read, json!([1])).0, "(input)");
        assert_eq!(fault(list, json!({"limit": 3})).0, "type");
        assert_eq!(
            fault(list, json!({"type": "note", "view": "VALUE_CANARY"})),
            ("view".to_owned(), "true or false".to_owned())
        );
        assert_eq!(
            fault(list, json!({"type": "note", "after": "VALUE_CANARY"})).0,
            "after"
        );
        assert_eq!(fault(list, json!({"type": "note", "where": {}})).0, "where");
        assert_eq!(
            fault(list, json!({"type": "note", "fields": [""]})).0,
            "fields"
        );
        assert_eq!(fault(outside, json!({})).0, "list");
        assert_eq!(
            fault(outside, json!({"list": "d", "after_byte": "x"})).0,
            "after_byte"
        );
        for (operation, input) in [
            (list, json!({"type": "note", "view": "VALUE_CANARY"})),
            (read, json!({"id": 7})),
        ] {
            let said = door().input_fault(operation, &input).unwrap();
            assert!(
                !format!("{said:?}").contains("VALUE_CANARY") && !format!("{said:?}").contains('7'),
                "{said:?}"
            );
        }
        assert_eq!(
            door().input_fault(read, &json!({"id": "n1"})),
            None,
            "a good input has no fault"
        );
        assert_eq!(
            door().input_fault("elsewhere", &json!({})),
            None,
            "an operation this door does not answer"
        );
    }

    #[test]
    fn a_destroyed_record_shows_no_erased_version_only_its_tombstone_as_deleted() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"secret": "old"}));
        prefilled.put("n1", "note", json!({"secret": "newer"}));
        prefilled.destroy("n1");
        let page = history_of(json!({"id": "n1", "limit": 10}), &mut prefilled).unwrap();
        assert_eq!(page["versions"].as_array().unwrap().len(), 1);
        assert_eq!(page["versions"][0]["deleted"], true);
        assert_eq!(page["versions"][0]["value"], Value::Null);
        assert!(!page.to_string().contains("secret"));
        assert_eq!(page["next"], Value::Null);
    }

    #[test]
    fn history_is_answered_at_the_door_but_never_granted_to_a_tool_run() {
        let door = door();
        let history = door.history_operation();
        assert!(door.answers(door.resource(), history));
        assert!(!door.run_rules().grantable(history));
    }

    /// The port of old trillion's GET /work/api/records/<id> (Trillion-X/trillion tag old-trillion-before-worker-retire
    /// src/own-resource-compatibility.mjs:276-277, the `records:read` command {id}, the id percent-decoded) onto this
    /// door's DATA row, beside the door's own page read, which is unchanged.
    #[test]
    fn the_page_reads_one_record_at_the_path_old_trillion_read_it_and_the_other_records_paths_are_not_ids(
    ) {
        let door = door();
        let family = format!("{}:request", door.resource());
        let call = |method: &str, path: &str| {
            door.page_call(
                &family,
                &json!({"path": path, "method": method, "body": {}}),
            )
        };
        assert_eq!(
            call("GET", "/records/%2FFunnels%2Fsales.json"),
            Some(Ok((
                "records:read".into(),
                json!({"id": "/Funnels/sales.json"})
            )))
        );
        assert_eq!(
            call("GET", "/records/note-1?ignored=1"),
            Some(Ok(("records:read".into(), json!({"id": "note-1"}))))
        );
        // Old trillion answered these paths by other owners first, so none is a record id here; none of those owners is
        // ported, so this door has no owner for them (404 no-owner, `page_paths::OldPaths::unported`).
        for path in [
            "/records/conflicts",
            "/records/model",
            "/records/history",
            "/records/turns",
            "/records/document-operations",
            "/records/find",
            "/records/erase",
            "/records/a/b",
        ] {
            assert!(call("GET", path).is_none(), "{path}");
        }
        assert!(
            matches!(call("GET", "/records/%zz"), Some(Err(Error::Invalid(_)))),
            "an id that does not decode is refused"
        );
        assert!(
            matches!(call("POST", "/records/note-1"), Some(Err(Error::Invalid(_)))),
            "old trillion read a record by GET only"
        );
        let read = url::form_urlencoded::byte_serialize(br#"{"id":"note-1"}"#).collect::<String>();
        assert_eq!(
            call("GET", &format!("/door/records:read?input={read}")),
            Some(Ok(("records:read".into(), json!({"id": "note-1"}))))
        );
    }
    #[test]
    fn every_answer_names_a_degraded_model_and_a_healthy_one_is_byte_identical() {
        // A tool row that declares again what the engine's own part declares: its join refuses and nothing was admitted before.
        let state = crate::record_model_policy::state_with_tool_model(json!({"value_kinds": {"text": {"is": "string"}}}));
        let degraded = crate::record_model_policy::installed(state.path()).unwrap();
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"words": "hello"}));
        let healthy = answer(door().read_operation(), json!({"id": "n1"}), &mut prefilled).unwrap();
        assert!(healthy.get("record_model").is_none());
        let with = |operation: &str, input: Value, prefilled: &mut Prefilled| {
            door().answer(operation, &input, prefilled, &degraded, Limits::default(), &|_| true).unwrap()
        };
        let read = with(door().read_operation(), json!({"id": "n1"}), &mut prefilled);
        let field = &read["record_model"];
        assert_eq!(field["served"], "own-part");
        assert!(field["cause"].as_str().is_some_and(|cause| !cause.is_empty()));
        assert_eq!(field["entries"][0]["section"], "value_kinds");
        assert_eq!(field["entries"][0]["declared_by"], json!(["the engine's own part", "tool:kept-records"]));
        // Nothing else of the answer changes.
        let mut stripped = read.clone();
        stripped.as_object_mut().unwrap().remove("record_model");
        assert_eq!(stripped, healthy);
        let list = with(door().list_operation(), json!({"type": "note"}), &mut prefilled);
        assert_eq!(list["record_model"], *field);
        // A byte-paged answer counts the field in its bound.
        let bytes = field.to_string().len() + 120;
        let fits = |page: &Value| page.to_string().len() <= bytes;
        let paged = door()
            .answer(door().list_operation(), &json!({"type": "note"}), &mut prefilled, &degraded, Limits::default(), &fits)
            .unwrap();
        assert!(paged.to_string().len() <= bytes);
    }
}
