// src/tool_runs/tools/effects.rs
//
// PURPOSE
//   What a tool's run changes on the screens that show it, declared once on the tool's own row (`effects`), so every
//   place that runs the tool (the web, the native apps, an AI over MCP) refreshes or patches the same reads the same way,
//   and no screen hand-writes what a run changed.
//
//   Moved from Trillion-X/trillion parts/ai-tool-catalog/read-data/declared-effects.ts, function for function
//   (declaredEffectsProblem, effectsAt, effectReads, applyMerge); its tests are the ones below.
//
// SHAPE (DATA on the tool row, machine readable, no string templates)
//   effects: [{ on: "mutate" | "success", action: "update" | "invalidate", read: Part[], merge?: Merge }]
//   Part   = "literal text" | { from: "input" | "output", path: ["key", ...] }   joined into the read's address, each
//            value part address-encoded.
//   Merge  = { at: ["key", ...], op: "set" | "append" | "replace" | "remove", match?: "key", value: Part-like ref | { value } }
//   `mutate` effects are what a caller may show as soon as the call starts; `success` effects hold once it completed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One reader: `declared_effects_problem` (the catalog refuses a malformed row with it) and `effects_at` (every
//      runner resolves a phase's effects from it) are the only code that reads `effects`.
//   2. An effect whose read names a value the call does not have is left out, never sent to a half-built address.
//   3. `apply_merge` never changes what it is given: it answers a new value, or the same value when the path is not there.
//   4. Blind: nothing here names a tool, a read or a screen.
//
// Wired: the catalog (catalog.rs `keep`) leaves out a row `declared_effects_problem` refuses (at most tool-runs.json
// `max_effects`), a tool's details carry its `effects` (so a caller resolves `mutate` before it calls), and a run's
// answer at the door carries `effects`, its `success` effects resolved over {input, output: the run's result}
// (tools.rs `answer_with_deadline`). The screens that apply them are the Workshop's.

use serde_json::{json, Map, Value};

const PHASES: [&str; 2] = ["mutate", "success"];
const ACTIONS: [&str; 2] = ["update", "invalidate"];
const OPS: [&str; 4] = ["set", "append", "replace", "remove"];
const SOURCES: [&str; 2] = ["input", "output"];

fn is_path(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|keys| keys.iter().all(|key| key.as_str().is_some_and(|key| !key.is_empty())))
}
fn is_ref(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 2
            && object.get("from").and_then(Value::as_str).is_some_and(|from| SOURCES.contains(&from))
            && is_path(object.get("path"))
            && object.get("path").and_then(Value::as_array).is_some_and(|path| !path.is_empty())
    })
}
fn str_in(value: Option<&Value>, set: &[&str]) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| set.contains(&text))
}

/// What is wrong with a row's `effects`, or None when it is absent or well formed.
pub fn declared_effects_problem(effects: Option<&Value>, most: usize) -> Option<String> {
    let effects = effects?;
    let Some(list) = effects.as_array().filter(|list| !list.is_empty() && list.len() <= most) else {
        return Some(format!("effects must be a list of 1 to {most} effects"));
    };
    for effect in list {
        let Some(effect) = effect.as_object().filter(|e| str_in(e.get("on"), &PHASES) && str_in(e.get("action"), &ACTIONS)) else {
            return Some("each effect needs on (mutate or success) and action (update or invalidate)".into());
        };
        let read = effect.get("read").and_then(Value::as_array);
        if !read.is_some_and(|read| !read.is_empty() && read.iter().all(|part| part.as_str().is_some_and(|text| !text.is_empty()) || is_ref(part))) {
            return Some("each effect read is a list of literal text and { from, path } values".into());
        }
        if !read.and_then(|read| read[0].as_str()).is_some_and(|first| first.starts_with('/')) {
            return Some("each effect read starts with the literal address of a read, beginning with /".into());
        }
        let action = effect.get("action").and_then(Value::as_str);
        if action == Some("invalidate") && effect.contains_key("merge") {
            return Some("an invalidate effect has no merge".into());
        }
        if action == Some("update") {
            let Some(merge) = effect.get("merge").and_then(Value::as_object).filter(|m| is_path(m.get("at")) && str_in(m.get("op"), &OPS)) else {
                return Some("an update effect needs merge { at, op (set, append, replace or remove), value }".into());
            };
            let value = merge.get("value");
            let plain = value.and_then(Value::as_object).is_some_and(|v| v.len() == 1 && v.contains_key("value"));
            if !(value.is_some_and(is_ref) || plain) {
                return Some("merge.value is { from, path } or { value }".into());
            }
            let op = merge.get("op").and_then(Value::as_str);
            if matches!(op, Some("replace" | "remove")) && merge.get("match").and_then(Value::as_str).is_none_or(|m| m.is_empty()) {
                return Some("a replace or remove merge names the key it matches items by (match)".into());
            }
        }
    }
    None
}

fn value_at<'a>(value: Option<&'a Value>, path: &[Value]) -> Option<&'a Value> {
    path.iter().try_fold(value?, |at, key| {
        let key = key.as_str()?;
        match at {
            Value::Object(object) => object.get(key),
            Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
            _ => None,
        }
    })
}

/// JavaScript's encodeURIComponent.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
/// JavaScript's String() of a JSON scalar.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A phase's effects of one call, resolved from its input (and output, once it has one); invariant 2.
/// `call` is { input?, output? }. Each answer is { action, read, merge? } as the old copy answered it.
pub fn effects_at(effects: Option<&Value>, phase: &str, call: &Value) -> Vec<Value> {
    let mut resolved = Vec::new();
    for effect in effects.and_then(Value::as_array).into_iter().flatten() {
        if effect.get("on").and_then(Value::as_str) != Some(phase) {
            continue;
        }
        let parts: Vec<&Value> = effect["read"].as_array().map(|read| read.iter().collect()).unwrap_or_default();
        let mut read = String::new();
        let mut whole = true;
        for part in &parts {
            match part {
                Value::String(text) => read.push_str(text),
                reference => match value_at(call.get(reference["from"].as_str().unwrap_or("")), reference["path"].as_array().map(Vec::as_slice).unwrap_or(&[])) {
                    Some(value) if !value.is_null() && !value.is_object() && !value.is_array() => read.push_str(&encode_component(&text_of(value))),
                    _ => { whole = false; break; }
                },
            }
        }
        if !whole {
            continue;
        }
        let merge = effect.get("merge").filter(|_| effect.get("action").and_then(Value::as_str) == Some("update"));
        let Some(merge) = merge else {
            resolved.push(json!({ "action": "invalidate", "read": read }));
            continue;
        };
        let source = &merge["value"];
        let value = match source.get("value") {
            Some(value) => Some(value),
            None => value_at(call.get(source["from"].as_str().unwrap_or("")), source["path"].as_array().map(Vec::as_slice).unwrap_or(&[])),
        };
        let Some(value) = value else { continue };
        let mut out = Map::new();
        out.insert("at".into(), merge["at"].clone());
        out.insert("op".into(), merge["op"].clone());
        if let Some(matched) = merge.get("match").filter(|m| m.as_str().is_some_and(|m| !m.is_empty())) {
            out.insert("match".into(), matched.clone());
        }
        out.insert("value".into(), value.clone());
        resolved.push(json!({ "action": "update", "read": read, "merge": Value::Object(out) }));
    }
    resolved
}

/// The reads a call's resolved effects name, once each, in order.
pub fn effect_reads(effects: Option<&[Value]>) -> Vec<String> {
    let mut reads: Vec<String> = Vec::new();
    for effect in effects.into_iter().flatten() {
        if let Some(read) = effect.get("read").and_then(Value::as_str) {
            if !reads.iter().any(|seen| seen == read) {
                reads.push(read.to_string());
            }
        }
    }
    reads
}

/// A read's answer with one resolved merge laid on it (invariant 3): a new value, or a copy of the same when the path is not there.
pub fn apply_merge(answer: &Value, merge: &Value) -> Value {
    let op = merge["op"].as_str().unwrap_or("");
    let matched = merge.get("match").and_then(Value::as_str);
    let value = &merge["value"];
    // An item is the merge's own when its `match` key holds the merge value's (or the merge value itself, a bare key).
    let key = match (value.as_object(), matched) {
        (Some(object), Some(m)) => object.get(m).cloned().unwrap_or(Value::Null),
        _ => value.clone(),
    };
    let same = |item: &Value| matched.is_some_and(|m| item.as_object().is_some_and(|object| object.get(m).unwrap_or(&Value::Null) == &key));
    let change = |at: Option<&Value>| -> Option<Value> {
        if op == "set" {
            return Some(value.clone());
        }
        let list: Vec<Value> = match at {
            Some(Value::Array(items)) => items.clone(),
            None => Vec::new(),
            Some(_) => return at.cloned(),
        };
        Some(Value::Array(match op {
            "append" => list.into_iter().chain([value.clone()]).collect(),
            "replace" => list.into_iter().map(|item| if same(&item) { value.clone() } else { item }).collect(),
            _ => list.into_iter().filter(|item| !same(item)).collect(),
        }))
    };
    fn place(at: Option<&Value>, path: &[Value], change: &dyn Fn(Option<&Value>) -> Option<Value>) -> Option<Value> {
        let Some((key, rest)) = path.split_first() else { return change(at) };
        let Some(Value::Object(object)) = at else { return at.cloned() };
        let key = key.as_str().unwrap_or("");
        if !object.contains_key(key) && !rest.is_empty() {
            return at.cloned();
        }
        let mut next = object.clone();
        match place(object.get(key), rest, change) {
            Some(changed) => { next.insert(key.to_string(), changed); }
            None => { next.remove(key); }
        }
        Some(Value::Object(next))
    }
    place(Some(answer), merge["at"].as_array().map(Vec::as_slice).unwrap_or(&[]), &change).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    // Trillion-X/trillion test/action-effects.test.mjs, its three tests of declared-effects.ts. Its catalog test there
    // admitted the row through read-ai-tool-catalog.ts; here the reader's own words are checked. The Workshop-run test
    // stays with src/workshop.mjs. Every value here is made up.
    use super::*;

    fn effects() -> Value {
        json!([
            { "on": "mutate", "action": "update", "read": ["/work/api/lists/", { "from": "input", "path": ["list_id"] }], "merge": { "at": ["rows"], "op": "append", "value": { "from": "input", "path": ["row"] } } },
            { "on": "success", "action": "update", "read": ["/work/api/lists/", { "from": "input", "path": ["list_id"] }], "merge": { "at": ["rows"], "op": "replace", "match": "id", "value": { "from": "output", "path": ["row"] } } },
            { "on": "success", "action": "invalidate", "read": ["/work/api/activity"] }
        ])
    }

    #[test]
    fn well_formed_effects_pass_and_malformed_ones_are_refused_with_the_readers_words() {
        assert_eq!(declared_effects_problem(Some(&effects()), 20), None);
        assert_eq!(declared_effects_problem(None, 20), None);
        let refused = |bad: Value| declared_effects_problem(Some(&bad), 20).unwrap_or_default();
        assert!(refused(json!([])).contains("effects must be a list"));
        assert!(refused(json!([{ "on": "later", "action": "update", "read": ["/x"] }])).contains("on (mutate or success)"));
        assert!(refused(json!([{ "on": "success", "action": "invalidate", "read": ["work/api/x"] }])).contains("beginning with /"));
        assert!(refused(json!([{ "on": "success", "action": "invalidate", "read": ["/x/{input.id}", "y"], "merge": { "at": [], "op": "set", "value": { "value": 1 } } }])).contains("no merge"));
        assert!(refused(json!([{ "on": "success", "action": "update", "read": ["/x"], "merge": { "at": ["rows"], "op": "remove", "value": { "value": "a" } } }])).contains("match"));
        assert!(refused(json!([{ "on": "success", "action": "invalidate", "read": ["/x", { "from": "elsewhere", "path": ["a"] }] }])).contains("literal text"));
    }

    #[test]
    fn a_phase_resolves_its_reads_from_the_call_encoding_values_an_effect_missing_a_value_is_left_out() {
        let effects = effects();
        let mutate = effects_at(Some(&effects), "mutate", &json!({ "input": { "list_id": "to do/now", "row": { "id": "r1", "title": "Draft" } } }));
        assert_eq!(mutate, vec![json!({ "action": "update", "read": "/work/api/lists/to%20do%2Fnow", "merge": { "at": ["rows"], "op": "append", "value": { "id": "r1", "title": "Draft" } } })]);
        assert_eq!(effects_at(Some(&effects), "mutate", &json!({ "input": { "row": { "id": "r1" } } })), Vec::<Value>::new());
        let success = effects_at(Some(&effects), "success", &json!({ "input": { "list_id": "l" }, "output": { "row": { "id": "r1", "title": "Saved" } } }));
        assert_eq!(effect_reads(Some(&success)), vec!["/work/api/lists/l".to_string(), "/work/api/activity".to_string()]);
        assert_eq!(effect_reads(None), Vec::<String>::new());
    }

    #[test]
    fn merges_set_append_replace_and_remove_without_changing_what_they_are_given() {
        let answer = json!({ "list": { "rows": [{ "id": "a", "n": 1 }, { "id": "b", "n": 2 }] } });
        let ids = |value: Value| value["list"]["rows"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(apply_merge(&answer, &json!({ "at": ["list", "rows"], "op": "append", "value": { "id": "c" } }))), ["a", "b", "c"]);
        assert_eq!(apply_merge(&answer, &json!({ "at": ["list", "rows"], "op": "replace", "match": "id", "value": { "id": "b", "n": 9 } }))["list"]["rows"], json!([{ "id": "a", "n": 1 }, { "id": "b", "n": 9 }]));
        assert_eq!(apply_merge(&answer, &json!({ "at": ["list", "rows"], "op": "remove", "match": "id", "value": "a" }))["list"]["rows"], json!([{ "id": "b", "n": 2 }]));
        assert_eq!(apply_merge(&answer, &json!({ "at": ["list", "title"], "op": "set", "value": "New" }))["list"]["title"], json!("New"));
        assert_eq!(apply_merge(&answer, &json!({ "at": ["missing", "rows"], "op": "append", "value": 1 })), answer);
        assert_eq!(answer["list"]["rows"], json!([{ "id": "a", "n": 1 }, { "id": "b", "n": 2 }]));
    }
}
