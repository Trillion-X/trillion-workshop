//! The record model of the tools installed for one account, joined from their tool rows with generic code.
//!
//! Each tool row may hold a `record_model` object (settings.json `row_field`) in the record model's own shape,
//! holding only what that tool keeps: its kinds, value kinds, list rules, field kinds, indexes and links. This owner
//! reads the rows of the tools installed in the account's state folder (`installed_rows`, the catalog read) and joins
//! them after its own part (`own_part`): a listed section is every tool's list one after another, an object section
//! is their keys together. It names no kind, section or tool.
//!
//! Non-Negotiable Invariants:
//! - Two tools giving one object key, or two rows of a listed section with the same `unique` fields (two kinds with
//!   one type, two indexes with one type and name), refuse the whole model: a read never silently picks one.
//! - A section whose name starts with `_` is a note and is never joined.
//! - A join that refuses never refuses a call and is never silent: the model served instead (the rows that last admitted,
//!   else the own part alone) is marked, and every record answer carries it as `record_model` (account_routes.rs).
//! - With no tools installed the model is the own part alone; installed tools whose rows refuse are a refusal,
//!   never an empty model.
//! - A kind stays on this computer when its row says so, and every kind does when the account has no tools
//!   installed or its model refuses: an unavailable policy is not evidence that a record may leave.
//! - The join is kept per state folder while the catalog hands back the same parse (catalog.rs keeps one per
//!   installed commit), so a record read does not join the model again.
//!
//! Ports old trillion src/record-engine.mjs:35-36 (`recordModel` read once from src/record-model.json and handed to
//! parts/record-log/do-work/record-log-store.mjs `recordLogStore({model})`): there the model was one file the app
//! carried; here each tool carries its part. Dropped: the one shipped file (docs/PRINCIPLES.md rule 5).
use super::{nested_erasable_paths, Error, Result};
use crate::{
    ecma_json::{self, Object, Value},
    record_value::{self, OpenPolicy},
};
use serde::Deserialize;
use serde_json::Value as Json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    row_field: String,
    unique: BTreeMap<String, Vec<String>>,
    kinds: String,
    kind_name: String,
    device_only: String,
    /// The field a kind names its only readers by (`owner_only` in settings.json, "readers"): such a kind's records are
    /// answered to no door read, list or search, and no tool row may declare it.
    owner_only: String,
    indexes: String,
    /// The joined order declarations (the record store reads them as its declared orders), one list entry per order.
    orders: String,
    kept_models: usize,
    /// The file in the account's state folder the rows of the last admitted join are kept in (`served_instead`): a refused
    /// join serves them, and when they do not join either, the engine's own part alone.
    admitted_file: String,
    /// The own part, joined before every tool's: the kinds trillion-local itself writes.
    own_part: Json,
}

fn settings() -> Result<&'static Settings> {
    static SETTINGS: OnceLock<Option<Settings>> = OnceLock::new();
    SETTINGS
        .get_or_init(|| serde_json::from_slice(include_bytes!("settings.json")).ok())
        .as_ref()
        .ok_or(crate::cause!(Error::Invalid))
}

/// One account's record model: the joined DATA, its open policy and the kinds that stay on this computer.
pub struct Installed {
    json: Json,
    data: Value,
    open: OpenPolicy,
    /// Logical participation declarations, parsed once from the joined model.
    parts: Vec<crate::storage::record_store::ReferrerPart>,
    /// None when a kind row's device flag is not true or false: then every kind stays.
    device_only: Option<BTreeSet<String>>,
    /// The kinds whose readers are named (`owner_only`); None when the joined model cannot say.
    owner_only: Option<BTreeSet<String>>,
    /// Whether the account has tools installed; with none, every kind stays.
    tools_found: bool,
    /// Set only on the instance `served_instead` builds: the answers' `record_model` field (the model served, why the join
    /// refused, and each conflicting entry with the rows declaring it). None on every model that joined.
    degraded: Option<Json>,
}

impl std::fmt::Debug for Installed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Installed")
            .field("tools_found", &self.tools_found)
            .finish_non_exhaustive()
    }
}

impl Installed {
    /// Join the `record_model` of each row, in catalog order, after the own part.
    pub fn from_rows<'a>(
        rows: impl IntoIterator<Item = &'a Json>,
        tools_found: bool,
    ) -> Result<Self> {
        let settings = settings()?;
        let rows: Vec<&Json> = rows.into_iter().collect();
        // Every list entry the unique fields name is declared once: a repeat refuses the model, and each repeat is logged
        // with every part that declares it.
        let duplicates = duplicates(rows.iter().copied())?;
        if !duplicates.is_empty() {
            for duplicate in &duplicates {
                crate::quiet_eprintln!(
                    "record-model-duplicate section={} entry={} declared-by={}",
                    duplicate.section,
                    duplicate.entry,
                    duplicate.declared_by.join(",")
                );
            }
            return Err(crate::cause!(Error::Invalid));
        }
        let mut joined = serde_json::Map::new();
        let parts = std::iter::once(Some(&settings.own_part))
            .chain(rows.iter().map(|row| row.get(&settings.row_field)));
        for part in parts {
            match part {
                None | Some(Json::Null) => {}
                Some(Json::Object(part)) => {
                    for (section, value) in
                        part.iter().filter(|(section, _)| !section.starts_with('_'))
                    {
                        join(&mut joined, section, value)?;
                    }
                }
                Some(_) => return Err(crate::cause!(Error::Invalid)),
            }
        }
        let json = Json::Object(joined);
        let bytes = serde_json::to_vec(&json).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let data =
            ecma_json::parse(&bytes, ecma_json::Limits::default()).map_err(
                |error| match error {
                    ecma_json::Error::InputBound(_)
                    | ecma_json::Error::NodeBound(_)
                    | ecma_json::Error::DepthBound(_)
                    | ecma_json::Error::StringBound(_)
                    | ecma_json::Error::TotalStringBound(_)
                    | ecma_json::Error::ContainerBound(_)
                    | ecma_json::Error::OutputBound(_) => Error::Bounds(error.cause()),
                    _ => Error::Invalid(error.cause()),
                },
            )?;
        // Explicitly reproduce recordLogStore's canonical `erasable = {}` default.
        let erasable = Value::Object(Object::new());
        let paths = nested_erasable_paths(&data, &erasable)?;
        let open = OpenPolicy::new(paths).map_err(|error| match error {
            record_value::Error::Bounds(_) => Error::Bounds(error.cause()),
            _ => Error::Invalid(error.cause()),
        })?;
        let parts = referrer_parts_of(&json, settings)?;
        let device_only = device_only_kinds(&json, settings);
        let owner_only = owner_only_kinds(&json, settings);
        Ok(Self {
            json,
            data,
            open,
            parts,
            device_only,
            owner_only,
            tools_found,
            degraded: None,
        })
    }

    /// The `record_model` field every record answer carries while this model is a stand-in for a refused join, None when
    /// the rows joined.
    pub fn degraded(&self) -> Option<&Json> {
        self.degraded.as_ref()
    }

    /// The joined model, as the record readers and writers take it.
    pub fn data(&self) -> &Value {
        &self.data
    }

    /// The joined model as plain JSON (the index declarations are read from it).
    pub fn json(&self) -> &Json {
        &self.json
    }

    /// Logical parts declared by the installed kinds (old record-model.mjs partsOf). The read owner rechecks
    /// these against each opened value, so index keys alone never disclose erased or unreadable participation.
    pub fn referrer_parts(&self) -> &[crate::storage::record_store::ReferrerPart] {
        &self.parts
    }

    /// The nested erasable fields every logical read opens through.
    pub fn open_policy(&self) -> &OpenPolicy {
        &self.open
    }

    /// The joined index declarations (settings.json `indexes`), an empty list when no tool declares one.
    pub fn indexes(&self) -> Json {
        settings()
            .ok()
            .and_then(|settings| self.json.get(&settings.indexes))
            .cloned()
            .unwrap_or_else(|| Json::Array(Vec::new()))
    }

    /// The joined order declarations (settings.json `orders`), an empty list when no tool declares one.
    pub fn orders(&self) -> Json {
        settings()
            .ok()
            .and_then(|settings| self.json.get(&settings.orders))
            .cloned()
            .unwrap_or_else(|| Json::Array(Vec::new()))
    }

    /// The text one installed tool gives `key` in the object section `section` (a record or kind the engine reads by
    /// a name the tool declares), or None when no installed tool declares it.
    pub fn named(&self, section: &str, key: &str) -> Option<&str> {
        self.json
            .get(section)?
            .get(key)?
            .as_str()
            .filter(|name| !name.is_empty())
    }

    /// Whether records of `kind` stay on this computer.
    pub fn stays(&self, kind: &str) -> bool {
        requires_local(
            self.tools_found
                .then_some(self.device_only.as_ref())
                .flatten(),
            kind,
        )
    }

    /// Whether records of `kind` are the owner store's own: no door answers them, and no every-kind search shows them. A
    /// model that cannot say keeps every kind out of reach (the door answers nothing it cannot judge).
    pub fn owner_only(&self, kind: &str) -> bool {
        self.owner_only.as_ref().is_none_or(|kinds| kinds.contains(kind))
    }

    /// Whether installed tools supplied a readable device policy. A missing policy still keeps every kind here,
    /// but a remote caller must hear that the source is unavailable, not that its particular kind is local-only.
    pub fn device_policy_available(&self) -> bool {
        self.tools_found && self.device_only.is_some()
    }
}

/// Add one tool's `section` to the joined model.
fn join(joined: &mut serde_json::Map<String, Json>, section: &str, value: &Json) -> Result<()> {
    match (joined.get_mut(section), value) {
        (None, Json::Array(_) | Json::Object(_)) => {
            joined.insert(section.to_owned(), value.clone());
        }
        (Some(Json::Array(kept)), Json::Array(more)) => kept.extend(more.iter().cloned()),
        (Some(Json::Object(kept)), Json::Object(more)) => {
            for (key, value) in more {
                if kept.insert(key.clone(), value.clone()).is_some() {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
        }
        _ => return Err(crate::cause!(Error::Invalid)),
    }
    Ok(())
}

/// Flatten kinds' logical parts into the existing index's declaration shape. Notes remain notes; malformed
/// declarations refuse the joined model rather than silently claiming that its participation index is complete.
fn referrer_parts_of(
    json: &Json,
    settings: &Settings,
) -> Result<Vec<crate::storage::record_store::ReferrerPart>> {
    let Some(kinds) = json.get(&settings.kinds) else {
        return Ok(Vec::new());
    };
    let kinds = kinds.as_array().ok_or(crate::cause!(Error::Invalid))?;
    let mut out = Vec::new();
    for kind in kinds {
        let name = kind
            .get(&settings.kind_name)
            .and_then(Json::as_str)
            .filter(|name| !name.is_empty())
            .ok_or(crate::cause!(Error::Invalid))?;
        let Some(parts) = kind.get("parts") else {
            continue;
        };
        for part in parts.as_array().ok_or(crate::cause!(Error::Invalid))? {
            let mut declared = part.as_object().ok_or(crate::cause!(Error::Invalid))?.clone();
            declared.retain(|name, _| !name.starts_with('_'));
            if declared
                .insert("kind".into(), Json::String(name.into()))
                .is_some()
            {
                return Err(crate::cause!(Error::Invalid));
            }
            let part: crate::storage::record_store::ReferrerPart =
                serde_json::from_value(Json::Object(declared)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            if !part.valid() {
                return Err(crate::cause!(Error::Invalid));
            }
            out.push(part);
        }
    }
    Ok(out)
}

/// The kinds whose row says `device_only` true. None when a row has no kind name, or a flag that is not true or
/// false.
/// The kinds that name readers (`owner_only`, a non-empty text): the owner store's own kinds.
fn owner_only_kinds(json: &Json, settings: &Settings) -> Option<BTreeSet<String>> {
    let mut held = BTreeSet::new();
    let rows = match json.get(&settings.kinds) {
        None => return Some(held),
        Some(rows) => rows.as_array()?,
    };
    for row in rows {
        let kind = row
            .get(&settings.kind_name)?
            .as_str()
            .filter(|kind| !kind.is_empty())?;
        match row.get(&settings.owner_only) {
            None | Some(Json::Null) => {}
            Some(Json::String(readers)) if !readers.is_empty() => {
                held.insert(kind.to_owned());
            }
            Some(_) => return None,
        }
    }
    Some(held)
}

fn device_only_kinds(json: &Json, settings: &Settings) -> Option<BTreeSet<String>> {
    let mut held = BTreeSet::new();
    let rows = match json.get(&settings.kinds) {
        None => return Some(held),
        Some(rows) => rows.as_array()?,
    };
    for row in rows {
        let kind = row
            .get(&settings.kind_name)?
            .as_str()
            .filter(|kind| !kind.is_empty())?;
        let local = match row.get(&settings.device_only) {
            None => false,
            Some(Json::Bool(local)) => *local,
            Some(_) => return None,
        };
        if local {
            held.insert(kind.to_owned());
        }
    }
    Some(held)
}

/// A kind stays here when the policy names it, and every kind does when the policy could not be read.
fn requires_local(kinds: Option<&BTreeSet<String>>, kind: &str) -> bool {
    kinds.is_none_or(|kinds| kinds.contains(kind))
}

/// One kept join: the state folder, the catalog parse it was joined from (None: no tools installed), and the outcome.
struct Kept {
    root: PathBuf,
    rows: Option<Arc<Vec<Json>>>,
    installed: Result<Arc<Installed>>,
}

static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());

/// The record model of the tools installed for the account whose state folder is `state_root`.
pub fn installed(state_root: &Path) -> Result<Arc<Installed>> {
    let settings = settings()?;
    let tools = crate::tool_runs::tools::shipped().map_err(|error| Error::Invalid(error.cause()))?;
    // A catalog that does not read (two rows with one id) never refuses the door: the rows that last admitted are served instead.
    let rows = match tools.installed_rows(state_root) {
        Ok(rows) => rows,
        Err(refused) => return served_instead(state_root, &settings.admitted_file, Error::Invalid(refused.cause()), &[]),
    };
    let same = |kept: &Kept| {
        kept.root == state_root
            && match (&kept.rows, &rows) {
                (None, None) => true,
                (Some(kept), Some(now)) => Arc::ptr_eq(kept, now),
                _ => false,
            }
    };
    if let Ok(kept) = KEPT.lock() {
        if let Some(kept) = kept.iter().find(|kept| same(kept)) {
            return kept.installed.clone();
        }
    }
    let listed = rows.as_deref().map(Vec::as_slice).unwrap_or_default();
    // A join that refuses never refuses the door: the rows that last admitted are served instead (`served_instead`).
    let installed = match Installed::from_rows(listed, rows.is_some()) {
        Ok(model) => {
            if rows.is_some() {
                keep_admitted(state_root, &settings.admitted_file, listed);
            }
            Ok(Arc::new(model))
        }
        Err(refused) => served_instead(state_root, &settings.admitted_file, refused, listed),
    };
    if let Ok(mut kept) = KEPT.lock() {
        kept.retain(|kept| kept.root != state_root);
        if kept.len() >= settings.kept_models.max(1) {
            kept.remove(0);
        }
        kept.push(Kept {
            root: state_root.to_owned(),
            rows,
            installed: installed.clone(),
        });
    }
    installed
}

/// The own part alone: the model of the kinds trillion-local writes itself (a plain setting, the command journal's
/// results), the same for every account.
/// One list entry that more than one part declares: its section, its unique field values as `field=value` words, and
/// every part that declares it (the engine's own part, or a tool row's id).
#[derive(Debug, PartialEq)]
pub struct Duplicate {
    pub section: String,
    pub entry: String,
    pub declared_by: Vec<String>,
}

/// Every list entry, in the sections `unique` names, and every key of an object section, that two or more parts declare (the
/// engine's own part first, then each row's `record_model`), in section and entry order.
pub fn duplicates<'a>(rows: impl IntoIterator<Item = &'a Json>) -> Result<Vec<Duplicate>> {
    let settings = settings()?;
    let parts = std::iter::once(("the engine's own part", Some(&settings.own_part))).chain(rows.into_iter().map(|row| {
        let owner = row.get("id").and_then(Json::as_str).unwrap_or("a tool row without an id");
        (owner, row.get(&settings.row_field))
    }));
    let mut declared: BTreeMap<(String, String), Duplicate> = BTreeMap::new();
    for (owner, part) in parts {
        let Some(Json::Object(part)) = part else { continue };
        for (section, value) in part.iter().filter(|(section, _)| !section.starts_with('_')) {
            // An object section is the parts' keys together: a key two parts give is named like a repeated list entry.
            if let Json::Object(keys) = value {
                for key in keys.keys() {
                    declared
                        .entry((section.clone(), format!("key\u{1f}{key}")))
                        .or_insert_with(|| Duplicate { section: section.clone(), entry: format!("key={}", Json::String(key.clone())), declared_by: Vec::new() })
                        .declared_by
                        .push(owner.to_owned());
                }
                continue;
            }
            let (Some(fields), Json::Array(entries)) = (settings.unique.get(section), value) else { continue };
            for entry in entries {
                let key: Vec<String> = fields
                    .iter()
                    .map(|field| entry.get(field).map(Json::to_string).unwrap_or_default())
                    .collect();
                let words: Vec<String> = fields.iter().zip(&key).map(|(field, value)| format!("{field}={value}")).collect();
                declared
                    .entry((section.clone(), key.join("\u{1f}")))
                    .or_insert_with(|| Duplicate { section: section.clone(), entry: words.join(" "), declared_by: Vec::new() })
                    .declared_by
                    .push(owner.to_owned());
            }
        }
    }
    Ok(declared.into_values().filter(|duplicate| duplicate.declared_by.len() > 1).collect())
}

/// The rows of the last join that admitted, kept in the account's state folder so a later refusal can serve them.
/// A write that fails is logged and changes nothing the join answers.
fn keep_admitted(state_root: &Path, file: &str, rows: &[Json]) {
    let path = state_root.join(file);
    let kept = serde_json::to_vec(rows).and_then(|bytes| {
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes).map_err(serde_json::Error::io)?;
        std::fs::rename(&temporary, &path).map_err(serde_json::Error::io)
    });
    if let Err(error) = kept {
        crate::quiet_eprintln!("record-model-admitted-not-kept cause={error}");
    }
}

/// The model served when a join refuses: the rows that last admitted, or else the engine's own part alone (no tools
/// found, so every kind stays on this computer). It is a model of its own, marked `degraded` with what it serves, the
/// refusal's cause and every conflicting entry with the rows declaring it (`rows`, the rows that did not join), so a record
/// answer says so; the shared `own_model()` stays unmarked for accounts with no tools. The cause is also logged.
fn served_instead(state_root: &Path, file: &str, refused: Error, rows: &[Json]) -> Result<Arc<Installed>> {
    let entries: Vec<Json> = duplicates(rows)?
        .into_iter()
        .map(|duplicate| serde_json::json!({"section": duplicate.section, "entry": duplicate.entry, "declared_by": duplicate.declared_by}))
        .collect();
    let marked = |served: &str, mut model: Installed| {
        model.degraded = Some(serde_json::json!({"served": served, "cause": refused.cause().to_string(), "entries": entries}));
        Arc::new(model)
    };
    let kept: Option<Vec<Json>> = std::fs::read(state_root.join(file))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if let Some(model) = kept.and_then(|rows| Installed::from_rows(&rows, true).ok()) {
        crate::quiet_eprintln!("record-model-refused served=last-admitted cause={}", refused.cause());
        return Ok(marked("last-admitted", model));
    }
    crate::quiet_eprintln!("record-model-refused served=own-part cause={}", refused.cause());
    Ok(marked("own-part", Installed::from_rows(std::iter::empty(), false)?))
}

pub fn own_model() -> Result<Arc<Installed>> {
    static OWN: OnceLock<Result<Arc<Installed>>> = OnceLock::new();
    OWN.get_or_init(|| Installed::from_rows(std::iter::empty(), false).map(Arc::new))
        .clone()
}

/// The joined model DATA for canonical value opening and mutation preparation (recordLogStore's `model`).
pub fn model_data(state_root: &Path) -> Result<Value> {
    installed(state_root).map(|installed| installed.data.clone())
}

/// The open policy built from the same joined model (`nested_erasable_paths` over `erasable = {}`).
pub fn open_policy(state_root: &Path) -> Result<OpenPolicy> {
    installed(state_root).map(|installed| installed.open.clone())
}

/// Whether records of `kind` stay on this computer for this account: they are refused to anything that is not
/// running here without a way out. Every kind does when the model cannot be read.
pub fn stays_on_this_device(state_root: &Path, kind: &str) -> bool {
    installed(state_root).map_or(true, |installed| installed.stays(kind))
}

/// Install, in the account state folder `state_root`, a tool `tool:kept-records` whose row keeps `record_model`, for tests that read the model the way an account does (catalog, join, answer).
#[cfg(test)]
pub(crate) fn install_tool_model(state_root: &Path, record_model: Json) {
    let folder = state_root
        .join("workshop")
        .join("tools")
        .join("kept-records");
    std::fs::create_dir_all(&folder).expect("tool folder");
    let rows = serde_json::json!({"records": [{"payload": {"kind": "ai-tool-descriptor", "id": "tool:kept-records", "record_model": record_model}}]});
    std::fs::write(
        folder.join("tool-rows.json"),
        serde_json::to_vec(&rows).expect("rows"),
    )
    .expect("rows file");
}

/// The synthetic tools a fixture account has installed: a list rule (a list declares `record:<row_type>`, its fields
/// of three field kinds), a kind that stays on this computer (`kept-here`), and a message whose words are sealed.
#[cfg(test)]
pub(crate) fn install_test_tools(state_root: &Path) {
    install_tool_model(
        state_root,
        serde_json::json!({
        "reference_lookup": [{"pattern":"^(list:[^:]+):rows:(.+)$","declaration":"$1","row":"$2","join":":"}],
        "declared_by": [{"type": "list", "kind": {"path": ["row_type"], "prefix": "record:"},
            "properties": {"path": ["fields"], "name": ["id"], "kind": ["kind"], "choices": ["choices"], "moves": ["moves"]}, "indexes": {"path": ["indexes"]}}],
        "field_kinds": [{"id": "text", "value": "text"}, {"id": "choice", "value": "text"}, {"id": "tags", "value": "texts"}],
        "kinds": [{"type": "kept-here", "stays_on_this_device": true}, {"type": "message", "erasable": ["text"]}],
        // The kind a harness hook keeps a session's card as (tools/hand-work-to-ais names it), here a made-up one.
        "harness_hooks": {"agent_card": "session-card"}}),
    );
}

/// A state folder holding one installed tool whose row keeps `record_model`.
#[cfg(test)]
pub(crate) fn state_with_tool_model(record_model: Json) -> tempfile::TempDir {
    let state = tempfile::tempdir().expect("state folder");
    install_tool_model(state.path(), record_model);
    state
}

/// One state folder for the whole test run whose one installed tool flags the kind `kept-here` as staying on this
/// computer and declares nothing else.
#[cfg(test)]
pub(crate) fn test_state() -> &'static Path {
    static STATE: OnceLock<tempfile::TempDir> = OnceLock::new();
    STATE
        .get_or_init(|| {
            state_with_tool_model(
                serde_json::json!({"kinds": [{"type": "kept-here", "stays_on_this_device": true}]}),
            )
        })
        .path()
}

/// The model of one installed tool keeping a list rule: a list declares the kind `record:<row_type>`, its fields of
/// the field kinds the tool names.
#[cfg(test)]
pub(crate) fn list_rule_model() -> &'static Installed {
    static MODEL: OnceLock<Installed> = OnceLock::new();
    MODEL.get_or_init(|| {
        let rule = serde_json::json!({"type": "list", "kind": {"path": ["row_type"], "prefix": "record:"},
            "properties": {"path": ["fields"], "name": ["id"], "kind": ["kind"], "choices": ["choices"], "moves": ["moves"]}, "indexes": {"path": ["indexes"]}});
        let field_kinds = serde_json::json!([{"id": "text", "value": "text"}, {"id": "choice", "value": "text"}, {"id": "tags", "value": "texts"}]);
        Installed::from_rows(&[serde_json::json!({"record_model": {
            "reference_lookup": [{"pattern":"^(list:[^:]+):rows:(.+)$","declaration":"$1","row":"$2","join":":"}],
            "declared_by": [rule], "field_kinds": field_kinds}})], true).expect("list rule model")
    })
}

#[cfg(test)]
mod device_policy_controls {
    use super::*;
    use serde_json::json;

    fn model(rows: &[Json]) -> Result<Installed> {
        Installed::from_rows(rows, true)
    }

    /// Explicit, read-only compatibility read of an installed catalog. The caller supplies the state folder;
    /// this never guesses an account, opens its records, installs tools or prints model payloads.
    #[test]
    #[ignore = "requires an explicitly selected installed catalog"]
    fn installed_catalog_parts_diagnostic() {
        let root = std::env::var_os("INSTALLED_MODEL_STATE_ROOT")
            .expect("an explicit installed catalog state root");
        let tools = crate::tool_runs::tools::shipped().expect("the tools settings read");
        let rows = tools
            .installed_rows(Path::new(&root))
            .expect("the installed catalog rows read")
            .expect("the explicitly selected installed catalog exists");
        Installed::from_rows(rows.as_slice(), true).expect("the catalog's declared model joins");
        let installed = super::installed(Path::new(&root))
            .expect("the installed catalog and joined model read");
        let kinds = installed
            .json()
            .get(&settings().unwrap().kinds)
            .and_then(Json::as_array)
            .map_or(0, Vec::len);
        crate::quiet_eprintln!(
            "installed-model: kinds={kinds} parts={}",
            installed.referrer_parts().len()
        );
    }

    #[test]
    fn the_native_write_fixtures_installed_model_reads_through_the_real_catalog() {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().canonicalize().unwrap();
        install_test_tools(&root);
        let installed =
            super::installed(&root).expect("the native-write fixture's installed model reads");
        assert!(installed.named("harness_hooks", "agent_card").is_some());
        assert!(!installed.referrer_parts().is_empty());
    }

    #[test]
    fn installed_logical_parts_are_checked_once_with_the_joined_model() {
        let installed = model(&[
            json!({"record_model":{"kinds":[{"type":"future-kind", "parts":[
                {"role":"named","path":["targets"],"role_from":["as"],"_why":"a model note"},
                {"role":"source","path":["refs"],"each":["ref"],"role_from":["role"]}
            ]}]}}),
        ])
        .unwrap();
        let parts = installed
            .referrer_parts()
            .iter()
            .filter(|part| part.kind == "future-kind")
            .collect::<Vec<_>>();
        assert_eq!(parts[0].path, ["targets"]);
        let logical = json!({"targets":["source:one"],"refs":"{\"ref\":\"source:hidden-in-text\"}","as":"seen"});
        let actual = crate::storage::record_store::referrers::parts_of(
            installed.referrer_parts(),
            Some("future-kind"),
            &logical,
        );
        assert_eq!(
            actual.len(),
            1,
            "declared logical paths never parse content strings as reference envelopes"
        );
        assert_eq!(actual[0].id, "source:one");
        for bad in [
            json!(null),
            json!({}),
            json!([{"role":"named","path":[]}]),
            json!([{"role":"named","path":["x"],"absolute_only":true}]),
        ] {
            assert!(
                model(&[json!({"record_model":{"kinds":[{"type":"bad", "parts":bad}]}})]).is_err()
            );
        }
    }

    #[test]
    fn missing_or_malformed_device_policy_cannot_approve_a_share() {
        // A kind row with no name refuses the whole model, and a model that refuses keeps every kind here.
        assert_eq!(
            model(&[json!({"record_model": {"kinds": [{"stays_on_this_device": true}]}})])
                .unwrap_err(),
            crate::cause!(Error::Invalid)
        );
        let installed = model(&[
            json!({"record_model": {"kinds": [{"type": "note", "stays_on_this_device": "yes"}]}}),
        ])
        .unwrap();
        assert!(!installed.device_policy_available());
        assert!(installed.stays("kept-here"));
        assert!(installed.stays("note"));
        let rows = [
            json!({"record_model": {"kinds": [{"type": "kept-here", "stays_on_this_device": true}]}}),
            json!({"record_model": {"kinds": [{"type": "note"}]}}),
        ];
        let installed = model(&rows).unwrap();
        assert!(installed.device_policy_available());
        assert!(installed.stays("kept-here"));
        assert!(!installed.stays("note"));
        // No tools installed: every kind stays, though the own rows still join.
        let alone = Installed::from_rows(&rows, false).unwrap();
        assert!(!alone.device_policy_available());
        assert!(alone.stays("note"));
        // A state folder with no tools installed keeps every kind here.
        let state = tempfile::tempdir().unwrap();
        assert!(stays_on_this_device(state.path(), "note"));
        // Read the way an account reads it: its installed tools' rows, joined.
        let state = state_with_tool_model(
            json!({"kinds": [{"type": "kept-here", "stays_on_this_device": true}, {"type": "note"}]}),
        );
        assert!(stays_on_this_device(state.path(), "kept-here"));
        assert!(!stays_on_this_device(state.path(), "note"));
        assert!(open_policy(state.path()).is_ok());
    }

    #[test]
    fn two_tools_cannot_declare_one_kind_or_one_index_or_one_key() {
        let kind = json!({"record_model": {"kinds": [{"type": "note"}]}});
        assert_eq!(model(&[kind.clone(), kind]).unwrap_err(), crate::cause!(Error::Invalid));
        let index = json!({"record_model": {"indexes": [{"type": "note", "name": "by-day", "paths": [["day"]]}]}});
        assert_eq!(model(&[index.clone(), index]).unwrap_err(), crate::cause!(Error::Invalid));
        // Two tools declaring one order name refuse the whole model; distinct orders join into one list.
        let order = json!({"record_model": {"orders": [{"order": "ai-job/status", "kind": "ai-job", "path": ["stored", "status"]}]}});
        assert_eq!(model(&[order.clone(), order]).unwrap_err(), crate::cause!(Error::Invalid));
        let first = json!({"record_model": {"orders": [{"order": "a/x", "kind": "a", "path": ["stored", "x"]}]}});
        let second = json!({"record_model": {"orders": [{"order": "b/y", "kind": "b", "path": ["stored", "y"]}]}});
        assert_eq!(model(&[first, second]).unwrap().orders().as_array().map(Vec::len), Some(2));
        let key = json!({"record_model": {"value_kinds": {"words": {"is": "string"}}}});
        assert_eq!(model(&[key.clone(), key]).unwrap_err(), crate::cause!(Error::Invalid));
        // Nor declare again what the own part declares.
        assert_eq!(
            model(&[json!({"record_model": {"value_kinds": {"text": {"is": "string"}}}})])
                .unwrap_err(),
            crate::cause!(Error::Invalid)
        );
        let shape = [
            json!({"record_model": {"kinds": []}}),
            json!({"record_model": {"kinds": {}}}),
        ];
        assert_eq!(model(&shape).unwrap_err(), crate::cause!(Error::Invalid));
    }

    #[test]
    fn each_tools_part_joins_in_catalog_order_and_notes_stay_out() {
        let rows = [
            json!({"id": "tool:a", "record_model": {"_what": "a", "value_kinds": {"a-words": {"is": "string"}},
                "kinds": [{"type": "message", "erasable": [["body", "text"]]}]}}),
            json!({"id": "tool:b"}),
            json!({"id": "tool:c", "record_model": {"_what": "c", "value_kinds": {"c-ids": {"list_of": "id"}},
                "kinds": [{"type": "entry", "erasable": [["input", "said"]]}], "indexes": [{"type": "entry", "name": "n", "paths": [["n"]]}]}}),
        ];
        let installed = model(&rows).unwrap();
        let kinds: Vec<_> = installed.json()["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|kind| kind["type"].clone())
            .collect();
        // The own kinds first, then each tool's in catalog order.
        assert_eq!(kinds[kinds.len() - 2..], [json!("message"), json!("entry")]);
        assert!(installed.json().get("_what").is_none());
        let value_kinds = installed.json()["value_kinds"].as_object().unwrap();
        assert!(
            value_kinds.contains_key("a-words")
                && value_kinds.contains_key("c-ids")
                && value_kinds.contains_key("text")
        );
        // The own part declares its own indexes first; a tool's follow.
        let own = model(&[]).unwrap().indexes().as_array().unwrap().len();
        let indexes = installed.indexes();
        assert_eq!(indexes.as_array().unwrap().len(), own + 1);
        assert_eq!(indexes.as_array().unwrap().last().unwrap()["type"], "entry");
    }
}

#[cfg(test)]
mod refusal_tests {
    use super::*;
    use serde_json::json;

    fn from_rows_join_refuses(rows: &[Json]) -> bool {
        Installed::from_rows(rows, true).is_err()
    }

    fn row(id: &str, kind: &str) -> Json {
        json!({"id": id, "record_model": {"kinds": [{"type": kind}]}})
    }

    #[test]
    fn a_kind_declared_by_two_rows_refuses_the_join() {
        let rows = [row("tool:one", "record:twice"), row("tool:two", "record:twice")];
        assert!(Installed::from_rows(&rows, true).is_err());
    }

    #[test]
    fn a_refused_join_serves_the_rows_that_last_admitted_and_not_the_refused_ones() {
        let state = tempfile::tempdir().unwrap();
        keep_admitted(state.path(), "record-model-admitted.json", &[row("tool:good", "record:good")]);
        let served = served_instead(state.path(), "record-model-admitted.json", Error::Invalid(crate::cause!()), &[]).unwrap();
        let kinds = served.json().get("kinds").and_then(Json::as_array).unwrap();
        assert!(kinds.iter().any(|kind| kind["type"] == "record:good"));
        assert!(!kinds.iter().any(|kind| kind["type"] == "record:twice"));
    }

    #[test]
    fn a_refused_join_with_nothing_admitted_serves_the_engines_part_alone_and_every_kind_stays_here() {
        let state = tempfile::tempdir().unwrap();
        let served = served_instead(state.path(), "record-model-admitted.json", Error::Invalid(crate::cause!()), &[]).unwrap();
        assert!(served.stays("record:anything"));
    }

    #[test]
    fn a_refused_join_on_a_duplicate_order_serves_the_orders_that_last_admitted() {
        let state = tempfile::tempdir().unwrap();
        let order = |id: &str, name: &str| json!({"id": id, "record_model": {"orders": [{"order": name, "kind": "ai-job", "path": ["stored", "status"]}]}});
        keep_admitted(state.path(), "record-model-admitted.json", &[order("tool:good", "ai-job/status")]);
        let served = served_instead(state.path(), "record-model-admitted.json", Error::Invalid(crate::cause!()), &[]).unwrap();
        let orders = served.orders();
        assert!(orders.as_array().unwrap().iter().any(|one| one["order"] == "ai-job/status"), "{orders}");
        let refused = [order("tool:one", "ai-job/state"), order("tool:two", "ai-job/state")];
        assert!(from_rows_join_refuses(&refused), "two tools declaring one order refuse the join");
    }

    #[test]
    fn every_part_that_declares_a_kind_is_named_in_its_duplicate() {
        let rows = [row("tool:one", "record:twice"), row("tool:two", "record:twice"), row("tool:three", "record:twice")];
        let found = duplicates(rows.iter()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].declared_by, vec!["tool:one", "tool:two", "tool:three"]);
    }
    #[test]
    fn a_degraded_model_names_what_it_serves_why_and_every_conflicting_entry() {
        let rows = [row("tool:one", "record:twice"), row("tool:two", "record:twice")];
        // Nothing admitted before: the engine's part alone.
        let state = tempfile::tempdir().unwrap();
        let served = served_instead(state.path(), "record-model-admitted.json", Error::Invalid(crate::cause!()), &rows).unwrap();
        let field = served.degraded().expect("a refused join is marked");
        assert_eq!(field["served"], "own-part");
        assert!(field["cause"].as_str().is_some_and(|cause| !cause.is_empty()));
        assert_eq!(field["entries"], json!([{"section": "kinds", "entry": "type=\"record:twice\"", "declared_by": ["tool:one", "tool:two"]}]));
        // The rows that last admitted: said so.
        keep_admitted(state.path(), "record-model-admitted.json", &[row("tool:good", "record:good")]);
        let served = served_instead(state.path(), "record-model-admitted.json", Error::Invalid(crate::cause!()), &rows).unwrap();
        assert_eq!(served.degraded().unwrap()["served"], "last-admitted");
        // A model that joined, and the shared engine part, are never marked.
        assert!(Installed::from_rows(&[row("tool:good", "record:good")], true).unwrap().degraded().is_none());
        assert!(own_model().unwrap().degraded().is_none());
    }

    #[test]
    fn a_catalog_that_lists_one_tool_id_twice_never_refuses_the_door_the_model_is_served_instead() {
        let state = tempfile::tempdir().unwrap();
        install_test_tools(state.path());
        assert!(super::installed(state.path()).unwrap().degraded().is_none());
        // A second folder lists the same tool id: the catalog refuses (DuplicateTool).
        let twice = state.path().join("workshop").join("tools").join("kept-records-again");
        std::fs::create_dir_all(&twice).unwrap();
        std::fs::write(twice.join("tool-rows.json"), json!({"records": [{"payload": {"kind": "ai-tool-descriptor", "id": "tool:kept-records"}}]}).to_string()).unwrap();
        let served = super::installed(state.path()).expect("a catalog that does not read never refuses the door");
        assert_eq!(served.degraded().expect("marked")["served"], "last-admitted");
    }

    #[test]
    fn a_repeated_object_key_is_named_with_the_rows_that_declare_it() {
        let own = json!({"id": "tool:a", "record_model": {"value_kinds": {"text": {"is": "string"}, "a-words": {"is": "string"}}}});
        let again = json!({"id": "tool:b", "record_model": {"value_kinds": {"a-words": {"is": "string"}}}});
        let found = duplicates([own, again].iter()).unwrap();
        let named: Vec<_> = found.iter().map(|d| (d.section.as_str(), d.entry.as_str(), d.declared_by.clone())).collect();
        assert_eq!(named, vec![
            ("value_kinds", "key=\"a-words\"", vec!["tool:a".to_owned(), "tool:b".to_owned()]),
            ("value_kinds", "key=\"text\"", vec!["the engine's own part".to_owned(), "tool:a".to_owned()]),
        ]);
    }
}
