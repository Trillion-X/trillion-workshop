// crates/workflow-engine/src/fill_input.rs
//
// Purpose:
//   Fills what a run's input leaves out from a row the person keeps, so a bare start (`wf start X '{"request":…}'`, or
//   a workflow-run start with no store) runs on the starting account's own stores. The starter is handed a reader
//   `{tool, input, with?, with_if_given?, fills_at, from_at?, fills_absent, when_no_row?, step?}`: it asks `tool` with
//   `input` (any tool, as a step would), each value `with` names ({path in the input: path in what the starter knows},
//   such as `account`, the signed-in account starting the run) set where it says, and each `with_if_given` value (such as
//   `input.store`, a store the caller gave) set there too, as null when not given; takes the object at `fills_at` in the
//   answer (`rows.0.fills`), and sets each of its fields the input does not give. What it set is answered as
//   `filled_from` ({field: the row at `from_at`}), which the starter keeps with the run. So a caller who gives one store
//   gets the others from the row that holds that store, never from another pursuit's: the reader's own query pairs them,
//   and an answer with no row is refused in the reader's `when_no_row` words ({path} filled from the run's input).
//
// Non-Negotiable Invariants:
//   1. A caller's own value always wins: a field the input gives (anything but null) is never filled.
//   2. One implementation: the workflow component and `wf start` both call these, with the same reader, so a bare start
//      fills the same way wherever it starts.
//   3. Nothing here names a store, a table, a tool or a person: the reader is DATA the person's starter hands in, and who
//      is starting comes from the starter's own sign-in (`with`), never from a name in code.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
use serde_json::{json, Map, Value};

/// The step a reader answers under when it names none.
pub const STEP: &str = "fill-input";

/// The value at a dotted path (`rows.0.fills`): a part that is a number indexes an array.
fn at_path<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').filter(|part| !part.is_empty()).try_fold(value, |at, part| match (at, part.parse::<usize>()) {
        (Value::Array(items), Ok(index)) => items.get(index),
        (Value::Object(fields), _) => fields.get(part),
        _ => None,
    })
}

fn given(input: &Value, field: &str) -> bool {
    input.get(field).is_some_and(|value| !value.is_null())
}

/// The fields the reader fills when the input leaves them out (`fills_absent`).
fn fills_absent(reader: &Value) -> Vec<&str> {
    reader["fills_absent"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

/// Whether `reader` is one and the input leaves out a field it fills: only then is it asked.
pub fn wanted(reader: &Value, input: &Value) -> bool {
    reader.get("tool").and_then(Value::as_str).is_some_and(|tool| !tool.is_empty())
        && fills_absent(reader).iter().any(|field| !given(input, field))
}

/// The step the reader answers under: its `step`, else `STEP`.
pub fn step(reader: &Value) -> String {
    reader["step"].as_str().filter(|step| !step.is_empty()).unwrap_or(STEP).to_string()
}

/// `value` with `put` set at a dotted path (`params.0`), making the objects and arrays on the way.
fn set_at(value: &mut Value, path: &str, put: Value) {
    let parts: Vec<&str> = path.split('.').filter(|part| !part.is_empty()).collect();
    let mut at = value;
    for (index, part) in parts.iter().enumerate() {
        at = match part.parse::<usize>() {
            Ok(position) => {
                if !at.is_array() { *at = json!([]); }
                let items = at.as_array_mut().unwrap();
                while items.len() <= position { items.push(Value::Null); }
                &mut items[position]
            }
            Err(_) => {
                if !at.is_object() { *at = json!({}); }
                at.as_object_mut().unwrap().entry(part.to_string()).or_insert(Value::Null)
            }
        };
        if index + 1 == parts.len() { *at = put; return; }
    }
}

/// The tool the reader asks, and the input it asks it with: its `input` with each value its `with` names, read from
/// `known` (what the starter knows, such as {account}), set where it says. A value the starter does not know is refused
/// in words, so a reader never runs unscoped.
pub fn ask(reader: &Value, known: &Value) -> Result<(String, Value), String> {
    let mut input = reader.get("input").cloned().unwrap_or(json!({}));
    for (to, from) in reader["with"].as_object().into_iter().flatten() {
        let from = from.as_str().unwrap_or_default();
        let value = at_path(known, from).filter(|value| !value.is_null() && value.as_str() != Some(""))
            .ok_or_else(|| format!("the input was not filled: the reader needs {from}, which this start does not know"))?;
        set_at(&mut input, to, value.clone());
    }
    for (to, from) in reader["with_if_given"].as_object().into_iter().flatten() {
        let value = from.as_str().and_then(|from| at_path(known, from)).cloned().unwrap_or(Value::Null);
        set_at(&mut input, to, value);
    }
    Ok((reader["tool"].as_str().unwrap_or_default().to_string(), input))
}

/// Sets in `input` each field of the reader's answer at `fills_at` that `fills_absent` names and the input leaves out;
/// answers `filled_from` ({field: the row at `from_at`, else true}) for what it set, empty when it set nothing. An
/// answer with nothing at `fills_at` sets nothing and says why.
pub fn apply(reader: &Value, input: &mut Value, answer: &Value) -> Result<Map<String, Value>, String> {
    let fills_at = reader["fills_at"].as_str().unwrap_or("fills");
    let Some(fills) = at_path(answer, fills_at).and_then(Value::as_object) else {
        return Err(match reader["when_no_row"].as_str() {
            Some(words) => fill_words(words, input),
            None => format!("the input was left without {}: the reader answered nothing at {fills_at} (is there a row for this account?)",
                fills_absent(reader).join(", ")),
        });
    };
    let from = reader["from_at"].as_str().and_then(|path| at_path(answer, path)).cloned().unwrap_or(json!(true));
    if !input.is_object() { *input = json!({}); }
    let mut filled = Map::new();
    for field in fills_absent(reader) {
        if given(input, field) { continue; }
        if let Some(value) = fills.get(field).filter(|value| !value.is_null()) {
            input[field] = value.clone();
            filled.insert(field.to_string(), from.clone());
        }
    }
    Ok(filled)
}

/// `words` with each {path} (or {path|other}) filled from `input` (a text as it is, anything else as its JSON, nothing as
/// "none").
fn fill_words(words: &str, input: &Value) -> String {
    let mut out = String::new();
    let mut rest = words;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else { break };
        // `{a|b}`: the first of the paths the input holds.
        let found = rest[open + 1..open + close].split('|').find_map(|path| at_path(input, path).filter(|value| !value.is_null()));
        out.push_str(&match found {
            Some(Value::String(text)) => text.clone(),
            Some(value) if !value.is_null() => value.to_string(),
            _ => "none".to_string(),
        });
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader() -> Value {
        json!({ "tool": "tool:read", "input": { "sql": "select", "params": [] }, "with": { "params.0": "account" },
            "fills_at": "rows.0.fills", "from_at": "rows.0.id", "fills_absent": ["store", "uses_store"] })
    }

    // A caller's own store is handed to the reader, so the row that holds it fills the rest; no such row is refused in
    // the reader's words, never filled from the default.
    #[test]
    fn a_given_store_is_paired_from_its_own_row_or_refused() {
        let mut paired = reader();
        paired["with_if_given"] = json!({ "params.1": "input.store" });
        paired["when_no_row"] = json!("uses_store_not_paired: no account row holds the given store {store.credential_name|store}");
        let (_, asked) = ask(&paired, &json!({ "account": "acct-1", "input": { "store": { "credential_name": "runs-b" } } })).unwrap();
        assert_eq!(asked["params"], json!(["acct-1", { "credential_name": "runs-b" }]));
        let (_, bare) = ask(&paired, &json!({ "account": "acct-1", "input": {} })).unwrap();
        assert_eq!(bare["params"], json!(["acct-1", null]), "a bare start asks with no store");
        let mut input = json!({ "store": { "credential_name": "runs-b" } });
        let row = json!({ "rows": [{ "id": "record:account-store:b", "fills": { "store": { "credential_name": "runs-b" }, "uses_store": { "credential_name": "uses-b" } } }] });
        let filled = apply(&paired, &mut input, &row).unwrap();
        assert_eq!(input["uses_store"], json!({ "credential_name": "uses-b" }));
        assert_eq!(Value::Object(filled), json!({ "uses_store": "record:account-store:b" }));
        let mut lone = json!({ "store": { "credential_name": "elsewhere" } });
        let why = apply(&paired, &mut lone, &json!({ "rows": [] })).unwrap_err();
        assert_eq!(why, "uses_store_not_paired: no account row holds the given store elsewhere");
        assert!(lone.get("uses_store").is_none(), "never filled from another row");
        let mut named = json!({ "store": "plain-name" });
        assert!(apply(&paired, &mut named, &json!({ "rows": [] })).unwrap_err().ends_with("given store plain-name"));
    }

    #[test]
    fn the_reader_is_scoped_to_the_account_starting_the_run() {
        let (tool, input) = ask(&reader(), &json!({ "account": "acct-1" })).unwrap();
        assert_eq!(tool, "tool:read");
        assert_eq!(input, json!({ "sql": "select", "params": ["acct-1"] }));
        let why = ask(&reader(), &json!({ "account": "" })).unwrap_err();
        assert!(why.contains("account"), "{why}");
        assert!(ask(&reader(), &json!({})).is_err(), "never asked unscoped");
    }

    fn answer() -> Value {
        json!({ "rows": [{ "id": "record:account-store:a", "fills": { "store": { "credential_name": "runs" }, "uses_store": { "credential_name": "uses" }, "other": 1 } }] })
    }

    #[test]
    fn a_bare_input_is_filled_from_the_row_and_says_which() {
        let mut input = json!({ "request": "a job" });
        assert!(wanted(&reader(), &input));
        let filled = apply(&reader(), &mut input, &answer()).unwrap();
        assert_eq!(input, json!({ "request": "a job", "store": { "credential_name": "runs" }, "uses_store": { "credential_name": "uses" } }));
        assert_eq!(Value::Object(filled), json!({ "store": "record:account-store:a", "uses_store": "record:account-store:a" }));
    }

    #[test]
    fn a_callers_own_store_always_wins() {
        let mut input = json!({ "store": { "credential_name": "mine" } });
        assert!(wanted(&reader(), &input), "uses_store is still left out");
        let filled = apply(&reader(), &mut input, &answer()).unwrap();
        assert_eq!(input["store"], json!({ "credential_name": "mine" }));
        assert_eq!(input["uses_store"], json!({ "credential_name": "uses" }));
        assert_eq!(Value::Object(filled), json!({ "uses_store": "record:account-store:a" }));
        let mut whole = json!({ "store": "a", "uses_store": "b" });
        assert!(!wanted(&reader(), &whole), "nothing is left out, so the reader is not asked");
        assert!(apply(&reader(), &mut whole, &answer()).unwrap().is_empty());
    }

    #[test]
    fn no_reader_or_no_row_fills_nothing_and_says_why() {
        assert!(!wanted(&json!(null), &json!({})));
        assert!(!wanted(&json!({ "fills_absent": ["store"] }), &json!({})), "a reader names its tool");
        let mut input = json!({});
        let why = apply(&reader(), &mut input, &json!({ "rows": [] })).unwrap_err();
        assert!(why.contains("store, uses_store") && why.contains("rows.0.fills"), "{why}");
        assert_eq!(input, json!({}));
    }
}
