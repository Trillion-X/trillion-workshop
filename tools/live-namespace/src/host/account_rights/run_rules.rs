// src/account_rights/run_rules.rs
//
// Purpose: What one routes call touches, as each route set's own DATA declares it (`run_operations` in records-routes.json and
// account-files-routes.json): the items a call names, each item's domain (a record kind, or the route set's resource when its
// rule names no kind field) and the records or names it reaches (one id, the ids under a prefix, or no bound). A run
// capability (`run_capability`) grants a call only when a declared right covers every item. No route set, kind, field or
// tool is named here.
//
// Non-Negotiable Invariants:
// - `named` answers only when every item the rule reaches names its kind (when the rule has a kind field) and the id
//   or prefix its rule needs as non-empty text; an input that names no item answers nothing, so it is refused.
// - `stamp` sets the run's cause in every value a call writes, replacing a tool's own. A removal (no value) cannot
//   carry it: the routes name the removal's change to wake instead (`wake::Waker::own_change`), after it commits.
//
// Key Concepts:
// - Rule: `items` is the path to the items (`["records", "*"]` follows `records`, then every item of that array;
//   empty is the input itself); `kind` the field naming an item's kind (absent: the route set's resource is the domain);
//   `id` the field naming the one record or name it reaches (or a list of fields: an item that reaches two, a move's
//   `from` and `to`, is checked for each), or `id_prefix` the field naming the start of the ones it reaches (absent means all of them; an item naming `id_prefix_unless`, an order, has no bound on ids). `addressed_ids` and `addressed_prefixes` are paths ending in `*`, each resolving to an array of scalar ids or prefixes; `value`
//   the field a write carries; `every_kind` the text that stands for every kind the person holds, for a read whose item
//   may leave its kind out (records:search over every kind): that item's domain is the text, so only a right naming
//   it as its kind covers the call, and an item naming the text as its kind is refused.
//
// Security Considerations:
// - These rules only describe inputs. Authority stays with the person's key and the run capability; a call no rule
//   describes is never granted to a run.
// - A rule with `every_kind` reads only (no value, id, prefix, addressed array or items path; `valid`), so a right
//   over every kind can never write.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// The array step of an items path.
const EVERY_ITEM: &str = "*";

/// What one routes operation touches, for a run's capability.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    #[serde(default)]
    items: Vec<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    id: Vec<String>,
    #[serde(default)]
    id_prefix: Option<String>,
    #[serde(default)]
    id_prefix_unless: Option<String>,
    /// Paths to arrays of scalar ids, with `*` selecting each string as an exact address.
    #[serde(default)]
    addressed_ids: Vec<Vec<String>>,
    /// Paths to arrays of scalar prefixes, with `*` selecting each string as a prefix address.
    #[serde(default)]
    addressed_prefixes: Vec<Vec<String>>,
    #[serde(default)]
    value: Option<String>,
    /// The text that stands for every kind: an item that names no kind (its `kind` field absent) reaches every kind
    /// the person holds, and its domain is this text, so only a right whose kind is this text covers it. Only a rule
    /// that reads may carry it: it has a `kind` field and names no value, id, id prefix, addressed array or items.
    #[serde(default)]
    every_kind: Option<String>,
}
impl Rule {
    fn valid(&self) -> bool {
        let named = |field: &Option<String>| field.as_deref().is_none_or(|field| !field.is_empty());
        self.items.iter().all(|step| !step.is_empty())
            && named(&self.kind)
            && self.id.iter().all(|field| !field.is_empty())
            && named(&self.id_prefix)
            && named(&self.id_prefix_unless)
            && self.addressed_ids.iter().chain(&self.addressed_prefixes).all(|path| {
                path.last().is_some_and(|step| step == EVERY_ITEM) && path.iter().all(|step| !step.is_empty())
            })
            && named(&self.value)
            && (self.id.is_empty() || self.id_prefix.is_none())
            && (self.id.is_empty() || self.addressed_ids.is_empty() && self.addressed_prefixes.is_empty())
            && (self.id_prefix.is_none() || self.addressed_ids.is_empty() && self.addressed_prefixes.is_empty())
            && (self.id_prefix_unless.is_none() || self.id_prefix.is_some())
            && named(&self.every_kind)
            && (self.every_kind.is_none()
                || self.kind.is_some()
                    && self.value.is_none()
                    && self.items.is_empty()
                    && self.id.is_empty()
                    && self.id_prefix.is_none()
                    && self.addressed_ids.is_empty()
                    && self.addressed_prefixes.is_empty())
    }
}

/// Which records or names one input item reaches: one id, the ones that start with a prefix, or no bound (a list in
/// a declared order, whose range is over values; or a call over the whole domain).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope<'a> {
    Id(&'a str),
    Prefix(&'a str),
    Unbounded,
}

/// One item a routes call touches: its domain (a record kind, or the route set's resource) and what it reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Named<'a> {
    pub kind: &'a str,
    pub scope: Scope<'a>,
}

/// One route set's rules, by operation name.
#[derive(Deserialize, Default)]
#[serde(transparent)]
pub struct Rules(BTreeMap<String, Rule>);

impl Rules {
    /// Every rule is well formed and there is at least one.
    pub fn valid(&self) -> bool {
        !self.0.is_empty() && self.0.iter().all(|(operation, rule)| !operation.is_empty() && rule.valid())
    }

    /// The operations these rules describe.
    pub fn operations(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }

    /// Whether a tool row may declare `operation` for a run.
    pub fn grantable(&self, operation: &str) -> bool {
        self.0.contains_key(operation)
    }

    /// The text `operation`'s rule lets stand for every kind (`every_kind`), when it has one: a read over every kind
    /// the person holds, never a write.
    pub fn every_kind(&self, operation: &str) -> Option<&str> {
        self.0.get(operation)?.every_kind.as_deref()
    }

    /// Whether `kind` is the every-kind text of any rule here: such a kind is never a record kind a right may name
    /// for an operation without that rule.
    pub fn names_every_kind(&self, kind: &str) -> bool {
        self.0.values().any(|rule| rule.every_kind.as_deref() == Some(kind))
    }

    /// The items `input` touches by `operation`, each with its domain (its kind, or `domain` when the rule names no
    /// kind field) and what it reaches. None when the operation is not grantable, the items path does not hold, an
    /// item does not name what its rule needs as non-empty text, or the input names no item.
    pub fn named<'a>(&'a self, operation: &str, input: &'a Value, domain: &'a str) -> Option<Vec<Named<'a>>> {
        let rule = self.0.get(operation)?;
        let mut named = Vec::new();
        for item in items(input, &rule.items)? {
            let text = |field: &str| item.get(field).and_then(Value::as_str).filter(|text| !text.is_empty());
            let kind = match (&rule.kind, &rule.every_kind) {
                // An item that names the every-kind text as its kind is refused: it is not a kind.
                (Some(field), Some(every)) => match item.get(field.as_str()) {
                    None | Some(Value::Null) => every.as_str(),
                    Some(_) => text(field).filter(|kind| kind != every)?,
                },
                (Some(field), None) => text(field)?,
                (None, _) => domain,
            };
            // A configured addressed array is required to be present as an array. This lets DATA say that every
            // selector must be explicit; omitted selection cannot silently become an unbounded read.
            let addressed = |paths: &[Vec<String>], prefix: bool| -> Option<Vec<Named<'a>>> {
                let mut found = Vec::new();
                for path in paths {
                    let values = items(input, path)?;
                    for value in values {
                        let address = value.as_str().filter(|address| !address.is_empty())?;
                        found.push(Named { kind, scope: if prefix { Scope::Prefix(address) } else { Scope::Id(address) } });
                    }
                }
                Some(found)
            };
            if !rule.addressed_ids.is_empty() || !rule.addressed_prefixes.is_empty() {
                let mut ids = addressed(&rule.addressed_ids, false)?;
                ids.extend(addressed(&rule.addressed_prefixes, true)?);
                named.extend(ids);
                continue;
            }
            if !rule.id.is_empty() {
                for id in &rule.id {
                    named.push(Named { kind, scope: Scope::Id(text(id)?) });
                }
                continue;
            }
            let scope = match &rule.id_prefix {
                Some(prefix) => {
                    let ordered = rule.id_prefix_unless.as_deref().is_some_and(|order| !item[order].is_null());
                    match (ordered, &item[prefix.as_str()]) {
                        (true, _) => Scope::Unbounded,
                        (false, Value::Null) => Scope::Prefix(""),
                        (false, value) => Scope::Prefix(value.as_str()?),
                    }
                }
                None => Scope::Unbounded,
            };
            named.push(Named { kind, scope });
        }
        (!named.is_empty()).then_some(named)
    }

    /// Set `field` to `cause` in the value of every item `input` writes by `operation`, as wake stamps its own
    /// effects; a removal (a null value) is left as it is. None when the operation is not grantable, its items path
    /// does not hold, or a value is neither an object nor null; an operation that writes no value is left as it is.
    pub fn stamp(&self, operation: &str, input: &mut Value, field: &str, cause: &str) -> Option<()> {
        let rule = self.0.get(operation)?;
        let Some(value) = &rule.value else { return Some(()) };
        for item in items_mut(input, &rule.items)? {
            match item.get_mut(value.as_str())? {
                Value::Null => {}
                Value::Object(fields) => {
                    fields.insert(field.to_owned(), Value::String(cause.to_owned()));
                }
                _ => return None,
            }
        }
        Some(())
    }
}

impl Rules {
    /// Remove `field` from the value of every item `input` writes by `operation`: a write that no run caused carries no
    /// run's stamp, whatever a client copied from a stored value. A removal (a null value) is left as it is, and so is
    /// an operation this table does not name or one that writes no value; an item whose value is not an object is the
    /// write model's to refuse.
    pub fn unstamp(&self, operation: &str, input: &mut Value, field: &str) {
        let Some(rule) = self.0.get(operation) else { return };
        let Some(value) = &rule.value else { return };
        let Some(written) = items_mut(input, &rule.items) else { return };
        for item in written {
            if let Some(Value::Object(fields)) = item.get_mut(value.as_str()) {
                fields.remove(field);
            }
        }
    }
}

/// A rule field naming one input field, or a list of them.
fn one_or_many<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Fields {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Fields::deserialize(deserializer)? {
        Fields::One(field) => vec![field],
        Fields::Many(fields) => fields,
    })
}

/// The items at `path` (`*` is every item of an array); None when the path does not hold.
fn items<'a>(input: &'a Value, path: &[String]) -> Option<Vec<&'a Value>> {
    let mut here = vec![input];
    for step in path {
        let mut next = Vec::with_capacity(here.len());
        for value in here {
            if step == EVERY_ITEM {
                next.extend(value.as_array()?.iter());
            } else {
                next.push(value.get(step.as_str())?);
            }
        }
        here = next;
    }
    Some(here)
}

/// `items`, to change in place.
fn items_mut<'a>(input: &'a mut Value, path: &[String]) -> Option<Vec<&'a mut Value>> {
    let mut here = vec![input];
    for step in path {
        let mut next = Vec::with_capacity(here.len());
        for value in here {
            if step == EVERY_ITEM {
                next.extend(value.as_array_mut()?.iter_mut());
            } else {
                next.push(value.get_mut(step.as_str())?);
            }
        }
        here = next;
    }
    Some(here)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> Rules {
        serde_json::from_value(json!({
            "read": {"kind": "type", "id": "id"},
            "list": {"kind": "type", "id_prefix": "prefix", "id_prefix_unless": "order"},
            "write": {"items": ["records", "*"], "kind": "type", "id": "id", "value": "value"},
            "list_names": {"id_prefix": "folder"},
            "search": {"kind": "type", "every_kind": "*"},
            "move_names": {"id": ["from", "to"]},
            "summary": {}
        }))
        .unwrap()
    }

    #[test]
    fn named_gives_each_item_its_domain_and_what_it_reaches_and_refuses_an_input_that_names_none() {
        let rules = rules();
        assert!(rules.valid());
        let note = |scope| Named { kind: "note", scope };
        assert_eq!(rules.named("read", &json!({"id": "a", "type": "note"}), "door"), Some(vec![note(Scope::Id("a"))]));
        assert_eq!(rules.named("read", &json!({"id": "a"}), "door"), None);
        assert_eq!(rules.named("read", &json!({"id": "a", "type": ""}), "door"), None);
        assert_eq!(rules.named("read", &json!({"type": "note"}), "door"), None, "a read names its id");
        assert_eq!(rules.named("list", &json!({"type": "note"}), "door"), Some(vec![note(Scope::Prefix(""))]));
        assert_eq!(rules.named("list", &json!({"type": "note", "prefix": "n-1"}), "door"),
            Some(vec![note(Scope::Prefix("n-1"))]));
        assert_eq!(rules.named("list", &json!({"type": "note", "order": "by time", "prefix": "[1,"}), "door"),
            Some(vec![note(Scope::Unbounded)]), "an ordered list ranges over values, not ids");
        let both = json!({"records": [{"id": "a", "type": "note", "value": {}}, {"id": "b", "type": "task", "value": null}]});
        assert_eq!(rules.named("write", &both, "door"),
            Some(vec![note(Scope::Id("a")), Named { kind: "task", scope: Scope::Id("b") }]));
        let untyped = json!({"records": [{"id": "a", "type": "note", "value": {}}, {"id": "b", "value": null}]});
        assert_eq!(rules.named("write", &untyped, "door"), None);
        assert_eq!(rules.named("write", &json!({"records": []}), "door"), None);
        assert_eq!(rules.named("not an operation", &json!({"type": "note"}), "door"), None);
        // A rule without a kind field: the route set's own resource is the domain.
        assert_eq!(rules.named("list_names", &json!({"folder": "/a/"}), "@files"),
            Some(vec![Named { kind: "@files", scope: Scope::Prefix("/a/") }]));
        assert_eq!(rules.named("summary", &json!({}), "@files"), Some(vec![Named { kind: "@files", scope: Scope::Unbounded }]));
        // A rule naming two id fields: the item reaches both, and names neither unless it names both.
        let files = |scope| Named { kind: "@files", scope };
        assert_eq!(rules.named("move_names", &json!({"from": "/a/x", "to": "/b/x"}), "@files"),
            Some(vec![files(Scope::Id("/a/x")), files(Scope::Id("/b/x"))]));
        assert_eq!(rules.named("move_names", &json!({"from": "/a/x"}), "@files"), None);
        // A rule with an every-kind text: an item without its kind reaches every kind, under that text; the text
        // itself is not a kind; an item naming a kind reaches only it.
        assert_eq!(rules.named("search", &json!({"question": "q"}), "here"), Some(vec![Named { kind: "*", scope: Scope::Unbounded }]));
        assert_eq!(rules.named("search", &json!({"question": "q", "type": null}), "here"),
            Some(vec![Named { kind: "*", scope: Scope::Unbounded }]));
        assert_eq!(rules.named("search", &json!({"question": "q", "type": "note"}), "here"), Some(vec![note(Scope::Unbounded)]));
        assert_eq!(rules.named("search", &json!({"question": "q", "type": "*"}), "here"), None);
        assert_eq!(rules.named("search", &json!({"question": "q", "type": ""}), "here"), None);
        assert_eq!(rules.every_kind("search"), Some("*"));
        assert_eq!(rules.every_kind("read"), None);
        assert!(rules.names_every_kind("*") && !rules.names_every_kind("note"));
    }

    #[test]
    fn stamp_sets_the_cause_in_every_written_value_and_leaves_a_removal() {
        let rules = rules();
        let mut input = json!({"records": [{"id": "a", "type": "note", "value": {"n": 1}}, {"id": "b", "type": "note", "value": {}}]});
        assert_eq!(rules.stamp("write", &mut input, "cause field", "cause-1"), Some(()));
        assert_eq!(input["records"][0]["value"], json!({"n": 1, "cause field": "cause-1"}));
        assert_eq!(input["records"][1]["value"], json!({"cause field": "cause-1"}));
        let mut removal = json!({"records": [{"id": "a", "type": "note", "value": null}]});
        assert_eq!(rules.stamp("write", &mut removal, "cause field", "cause-1"), Some(()));
        assert_eq!(removal, json!({"records": [{"id": "a", "type": "note", "value": null}]}), "a removal carries no stamp");
        let mut odd = json!({"records": [{"id": "a", "type": "note", "value": [1]}]});
        assert_eq!(rules.stamp("write", &mut odd, "cause field", "cause-1"), None);
        let mut read = json!({"id": "a", "type": "note"});
        assert_eq!(rules.stamp("read", &mut read, "cause field", "cause-1"), Some(()));
        assert_eq!(read, json!({"id": "a", "type": "note"}), "a read writes nothing");
    }

    #[test]
    fn malformed_rules_are_not_valid() {
        let parse = |value: Value| serde_json::from_value::<Rules>(value).map(|rules| rules.valid()).unwrap_or(false);
        assert!(!parse(json!({})));
        assert!(!parse(json!({"read": {"id": "id", "id_prefix": "prefix"}})));
        assert!(!parse(json!({"read": {"id_prefix_unless": "order"}})));
        assert!(!parse(json!({"read": {"kind": ""}})));
        assert!(!parse(json!({"read": {"id": ["id", ""]}})));
        assert!(!parse(json!({"read": {"id": ["id"], "id_prefix": "prefix"}})));
        assert!(!parse(json!({"read": {"unknown": "x"}})));
        assert!(!parse(json!({"read": {"addressed_ids": [["selection", "labels"]]}})));
        assert!(!parse(json!({"read": {"id": "id", "addressed_ids": [["labels", "*"]]}})));
        // Only a read over a kind field may stand for every kind: never a write, an id, a prefix or a kindless rule.
        assert!(parse(json!({"search": {"kind": "type", "every_kind": "*"}})));
        assert!(!parse(json!({"search": {"kind": "type", "every_kind": ""}})));
        assert!(!parse(json!({"search": {"every_kind": "*"}})));
        assert!(!parse(json!({"write": {"items": ["records", "*"], "kind": "type", "id": "id", "value": "value", "every_kind": "*"}})));
        assert!(!parse(json!({"write": {"kind": "type", "value": "value", "every_kind": "*"}})));
        assert!(!parse(json!({"read": {"kind": "type", "id": "id", "every_kind": "*"}})));
        assert!(!parse(json!({"list": {"kind": "type", "id_prefix": "prefix", "every_kind": "*"}})));
    }

    #[test]
    fn addressed_scalar_arrays_name_every_exact_id_and_prefix_and_refuse_omitted_or_malformed_selectors() {
        let rules: Rules = serde_json::from_value(json!({"workspace:read": {
            "addressed_ids": [["selection", "labels", "*"]],
            "addressed_prefixes": [["selection", "prefixes", "*"]]
        }})).unwrap();
        let exact = |scope| Named { kind: "@own-records", scope };
        assert_eq!(rules.named("workspace:read", &json!({"selection":{"labels":["look-a","look-b"],"prefixes":[]}}), "@own-records"),
            Some(vec![exact(Scope::Id("look-a")), exact(Scope::Id("look-b"))]));
        assert_eq!(rules.named("workspace:read", &json!({"selection":{"labels":["look-a"],"prefixes":["look-"]}}), "@own-records"),
            Some(vec![exact(Scope::Id("look-a")), exact(Scope::Prefix("look-"))]));
        assert_eq!(rules.named("workspace:read", &json!({}), "@own-records"), None, "omitted selection is refused");
        assert_eq!(rules.named("workspace:read", &json!({"selection":null}), "@own-records"), None, "null selection is refused");
        assert_eq!(rules.named("workspace:read", &json!({"selection":[]}), "@own-records"), None, "scalar selection is refused");
        assert_eq!(rules.named("workspace:read", &json!({"selection":{"labels":[],"prefixes":[]}}), "@own-records"), None,
            "empty selection would be an unbounded read");
        assert_eq!(rules.named("workspace:read", &json!({"selection":{"labels":["look-a"],"prefixes":null}}), "@own-records"), None,
            "every selector array must be explicit");
        assert_eq!(rules.named("workspace:read", &json!({"selection":{"labels":["look-a",4],"prefixes":[]}}), "@own-records"), None,
            "partial valid arrays do not hide a malformed label");
    }
}
