// Ported from Trillion-X/trillion test/marketplace-starting-defaults.test.mjs (the overlay's own promises: defaults
// read with no row written, the person's edit and removal surviving a new deploy, reset) and new checks of
// `lay_under`, the record-level rule the show-rules read uses.
use super::*;
use crate::ecma_json;

fn parse(text: &str) -> Value {
    ecma_json::parse(text.as_bytes(), Default::default()).unwrap()
}
fn show(value: &Value) -> String {
    ecma_json::stringify(value, Default::default()).unwrap()
}

#[derive(Default, Clone)]
struct Memory {
    rows: BTreeMap<String, (String, Value)>,
    unwatched: Vec<String>,
}
impl Memory {
    fn bytes(&self) -> String {
        self.rows.iter().map(|(id, (kind, value))| format!("{id}|{kind}|{}\n", show(value))).collect()
    }
}
impl OwnRecords for Memory {
    fn read(&self, id: &str) -> Option<Value> {
        self.rows.get(id).map(|(_, v)| v.clone())
    }
    fn kind_of(&self, id: &str) -> Option<String> {
        self.rows.get(id).map(|(k, _)| k.clone())
    }
    fn ids(&self, kind: &str) -> Vec<String> {
        self.rows.iter().filter(|(_, (k, _))| k == kind).map(|(id, _)| id.clone()).collect()
    }
    fn write(&mut self, entries: Vec<Entry>, unwatched: bool) {
        for entry in entries {
            if unwatched {
                self.unwatched.push(entry.id.clone());
            }
            match entry.value {
                Some(value) => {
                    self.rows.insert(entry.id, (entry.kind, value));
                }
                None => {
                    self.rows.remove(&entry.id);
                }
            }
        }
    }
}

/// A published default with the shape the default publisher ships (its repository is named in settings.json,
/// tools/starting-set/shipped-defaults.json): a type in use for everyone until the person switches it off.
fn default_row(label: &str) -> Value {
    parse(&format!(
        r#"{{"kind":"shipped-default","record":"show-rules","merge":{{"by_id":["types"],"switched":[{{"field":"in_use","off_in":"starting"}}]}},"value":{{"types":[{{"id":"fixture-type","label":"{label}","inherits":[],"rules":[]}}],"in_use":["fixture-type"]}}}}"#
    ))
}
fn ids(value: &Value, field: &str) -> Vec<String> {
    list(get(value, field)).iter().map(|v| text(v).or_else(|| id_of(v)).unwrap()).collect()
}

#[test]
fn a_blank_account_reads_the_shipped_record() {
    let laid = lay_under(&default_row("One"), None).unwrap();
    assert_eq!(ids(&laid, "types"), ["fixture-type"]);
    assert_eq!(ids(&laid, "in_use"), ["fixture-type"]);
    assert_eq!(record_of(&default_row("One")).as_deref(), Some("show-rules"));
}

#[test]
fn an_existing_account_gets_the_shipped_type_beside_its_own() {
    let own = parse(r#"{"types":[{"id":"mine","label":"Mine","inherits":[],"rules":[]}],"in_use":["mine"],"rules":[{"id":"r"}]}"#);
    let laid = lay_under(&default_row("One"), Some(&own)).unwrap();
    assert_eq!(ids(&laid, "types"), ["fixture-type", "mine"]);
    assert_eq!(ids(&laid, "in_use"), ["mine", "fixture-type"]);
    assert_eq!(list(get(&laid, "rules")).len(), 1, "a field the default does not ship is the person's");
}

#[test]
fn a_switched_off_default_stays_off_after_a_new_deploy() {
    let own = parse(r#"{"starting":{"fixture-type":{"on":false}}}"#);
    for label in ["One", "Two, after a new deploy"] {
        let laid = lay_under(&default_row(label), Some(&own)).unwrap();
        assert!(ids(&laid, "in_use").is_empty(), "{label}");
        assert_eq!(ids(&laid, "types"), ["fixture-type"], "the type stays listed so it can be switched back on");
    }
    let back_on = parse(r#"{"starting":{"fixture-type":{"on":true}}}"#);
    assert_eq!(ids(&lay_under(&default_row("Two"), Some(&back_on)).unwrap(), "in_use"), ["fixture-type"]);
}

#[test]
fn an_account_that_had_turned_it_off_is_not_switched_back_on_and_its_edit_wins() {
    let own = parse(
        r#"{"starting":{"fixture-type":{"on":false}},"in_use":[],"types":[{"id":"fixture-type","label":"My edit","inherits":[],"rules":[]}]}"#,
    );
    let laid = lay_under(&default_row("Shipped"), Some(&own)).unwrap();
    assert!(ids(&laid, "in_use").is_empty());
    let types = list(get(&laid, "types"));
    assert_eq!(types.len(), 1);
    assert_eq!(get(&types[0], "label").and_then(text).as_deref(), Some("My edit"));
}

fn shipped(label: &str) -> BTreeMap<String, Shipped> {
    BTreeMap::from([(
        "fixture-rule".to_owned(),
        Shipped { kind: "rule".to_owned(), value: parse(&format!(r#"{{"label":"{label}","set_at":"a"}}"#)) },
    )])
}

#[test]
fn reading_defaults_writes_nothing_and_a_new_deploy_reaches_an_untouched_account() {
    let mut layer = OverlayRecords::new(Memory::default(), shipped("One"), CHANGE_KIND, &["set_at"]);
    let before = layer.store.bytes();
    assert_eq!(get(&layer.read("fixture-rule").unwrap(), "label").and_then(text).as_deref(), Some("One"));
    assert_eq!(layer.ids("rule"), ["fixture-rule"]);
    assert_eq!(layer.kind_of("fixture-rule").as_deref(), Some("rule"));
    assert_eq!(layer.store.bytes(), before, "the store is byte-equal before and after a read");
    assert!(layer.store.rows.is_empty());
    assert!(layer.replace_defaults(shipped("Two")));
    assert!(!layer.replace_defaults(shipped("Two")));
    assert_eq!(get(&layer.read("fixture-rule").unwrap(), "label").and_then(text).as_deref(), Some("Two"));
    assert!(layer.refuses_field_read("rule") && !layer.refuses_field_read("other"));
}

#[test]
fn an_edit_survives_a_new_deploy_a_removal_stays_gone_and_reset_goes_back() {
    let mut layer = OverlayRecords::new(Memory::default(), shipped("One"), CHANGE_KIND, &["set_at"]);
    let edit = |label: &str| Entry { id: "fixture-rule".into(), kind: "rule".into(), value: Some(parse(&format!(r#"{{"label":"{label}"}}"#))) };
    layer.write(vec![edit("Mine")], "t1");
    layer.replace_defaults(shipped("Two"));
    assert_eq!(get(&layer.read("fixture-rule").unwrap(), "label").and_then(text).as_deref(), Some("Mine"));
    assert_eq!(layer.changes_from_defaults(), [("fixture-rule".to_owned(), Change::Edited)]);
    // A write equal to the shipped value, ignoring set_at, is a reset.
    layer.write(vec![Entry { value: Some(parse(r#"{"label":"Two","set_at":"z"}"#)), ..edit("") }], "t2");
    assert!(layer.store.rows.is_empty() && !layer.changed("fixture-rule"));
    // A removal leaves one unwatched change record and stays gone through a new deploy.
    layer.write(vec![Entry { value: None, ..edit("") }], "t3");
    layer.replace_defaults(shipped("Three"));
    assert_eq!(layer.read("fixture-rule"), None);
    assert!(layer.ids("rule").is_empty());
    assert_eq!(layer.changes_from_defaults(), [("fixture-rule".to_owned(), Change::Removed)]);
    assert_eq!(layer.store.unwatched, [change_id()]);
    // Writing it again takes the change record away; reset goes back to the shipped value.
    layer.write(vec![edit("Again")], "t4");
    assert_eq!(get(&layer.read("fixture-rule").unwrap(), "label").and_then(text).as_deref(), Some("Again"));
    assert!(layer.store.kind_of(&change_id()).is_none());
    assert!(layer.reset_default("fixture-rule"));
    assert_eq!(get(&layer.read("fixture-rule").unwrap(), "label").and_then(text).as_deref(), Some("Three"));
    assert!(!layer.reset_default("not-shipped"));
    assert!(layer.store.rows.is_empty());
}

#[derive(Default)]
struct FactMemory(BTreeMap<String, Value>);
impl Facts for FactMemory {
    fn read(&self, name: &str) -> Option<Value> {
        self.0.get(name).cloned()
    }
    fn list(&self, prefix: &str) -> Vec<Value> {
        self.0.iter().filter(|(n, _)| n.starts_with(prefix)).map(|(_, v)| v.clone()).collect()
    }
    fn write(&mut self, name: &str, value: Value) {
        self.0.insert(name.to_owned(), value);
    }
    fn reset(&mut self, name: &str) {
        self.0.remove(name);
    }
}

#[test]
fn facts_read_the_shipped_value_until_the_person_keeps_their_own() {
    let shipped = || BTreeMap::from([("event-rule-a".to_owned(), parse(r#"{"rule_id":"a","on":true,"set_at":"x"}"#))]);
    let name_of = |v: &Value| get(v, "rule_id").and_then(text).map(|id| format!("event-rule-{id}"));
    let mut facts = OverlayFacts::new(FactMemory::default(), shipped, "event-rule-", name_of, &["set_at"]);
    assert_eq!(facts.list("event-rule-").len(), 1);
    assert!(facts.read("event-rule-a").is_some() && facts.read("other-a").is_none());
    assert!(facts.facts.0.is_empty(), "a read writes nothing");
    facts.write("event-rule-a", parse(r#"{"rule_id":"a","on":false}"#));
    assert_eq!(facts.changes_from_defaults(), [("event-rule-a".to_owned(), Change::Edited)]);
    assert_eq!(facts.list("event-rule-").len(), 1, "the person's own replaces the shipped value");
    facts.write("event-rule-a", parse(r#"{"rule_id":"a","on":true,"set_at":"y"}"#));
    assert!(facts.facts.0.is_empty(), "a write equal to the shipped value is a reset");
    facts.write("event-rule-a", parse(r#"{"rule_id":"a","removed":true}"#));
    assert_eq!(facts.changes_from_defaults(), [("event-rule-a".to_owned(), Change::Removed)]);
    assert!(facts.reset_default("event-rule-a") && facts.facts.0.is_empty());
    assert!(!facts.reset_default("event-rule-b"));
}

/// The change record of the fixture default, named the way the layer names it.
fn change_id() -> String {
    format!("{CHANGE_KIND}:fixture-rule")
}

/// The change kind a test caller names (any kind; the tool that keeps the changes names the real one).
const CHANGE_KIND: &str = "fixture-change";
