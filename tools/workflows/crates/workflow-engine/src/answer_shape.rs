// The shape an ask's answer must have, checked where every host's answer enters the engine (Access::ask), so no host
// can hand the engine an answer its step did not ask for. A step names the shape as `submit` in what it asks: a JSON
// Schema. This checks the keywords the workflows use (type, properties, required, additionalProperties, items, minItems,
// maxItems, uniqueItems, minLength, maxLength, pattern, enum, const, minimum, maximum, exclusiveMinimum,
// exclusiveMaximum, minProperties, maxProperties, anyOf, oneOf, allOf, not). `format` and `description` are notes, as
// JSON Schema itself treats them. Any other keyword is refused as unknown, so a shape is never silently half-checked.
use serde_json::Value;

const NOTES: &[&str] = &["description", "title", "format", "examples", "default", "$comment", "$schema", "$id"];
const CHECKED: &[&str] = &[
    "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength",
    "maxLength", "pattern", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minProperties",
    "maxProperties", "anyOf", "oneOf", "allOf", "not",
];

/// Every way `answer` misses `shape`, each as "where: what is wrong"; empty when it fits.
pub fn misses(shape: &Value, answer: &Value) -> Vec<String> {
    let mut found = Vec::new();
    check(shape, answer, "answer", &mut found);
    found
}

fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0) => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_type(value: &Value, name: &str) -> bool {
    let has = type_of(value);
    has == name || (name == "number" && has == "integer")
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 60 { format!("{}...", text.chars().take(60).collect::<String>()) } else { text }
}

fn check(shape: &Value, value: &Value, at: &str, found: &mut Vec<String>) {
    let Some(rules) = shape.as_object() else {
        if shape == &Value::Bool(false) { found.push(format!("{at}: nothing is allowed here")); }
        return;
    };
    for key in rules.keys() {
        if !CHECKED.contains(&key.as_str()) && !NOTES.contains(&key.as_str()) {
            found.push(format!("{at}: the shape uses {key}, which this check does not know, so the answer cannot be checked"));
        }
    }
    if let Some(wanted) = rules.get("type") {
        let names: Vec<&str> = match wanted {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        if !names.iter().any(|name| is_type(value, name)) {
            found.push(format!("{at}: is {} {}, but must be {}", type_of(value), short(value), names.join(" or ")));
            return;
        }
    }
    if let Some(Value::Array(allowed)) = rules.get("enum") {
        if !allowed.contains(value) { found.push(format!("{at}: is {}, but must be one of {}", short(value), short(&Value::Array(allowed.clone())))); }
    }
    if let Some(only) = rules.get("const") {
        if only != value { found.push(format!("{at}: is {}, but must be {}", short(value), short(only))); }
    }
    match value {
        Value::String(text) => {
            let length = text.chars().count() as u64;
            if let Some(min) = rules.get("minLength").and_then(Value::as_u64) { if length < min { found.push(format!("{at}: has {length} characters, fewer than {min}")); } }
            if let Some(max) = rules.get("maxLength").and_then(Value::as_u64) { if length > max { found.push(format!("{at}: has {length} characters, more than {max}")); } }
            if let Some(pattern) = rules.get("pattern").and_then(Value::as_str) {
                match regex::Regex::new(pattern) {
                    Ok(re) => if !re.is_match(text) { found.push(format!("{at}: {} does not match {pattern}", short(value))); },
                    Err(error) => found.push(format!("{at}: the shape's pattern {pattern} is not a pattern ({error})")),
                }
            }
        }
        Value::Number(number) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            let bound = |key: &str| rules.get(key).and_then(Value::as_f64);
            if let Some(min) = bound("minimum") { if n < min { found.push(format!("{at}: {n} is below {min}")); } }
            if let Some(max) = bound("maximum") { if n > max { found.push(format!("{at}: {n} is above {max}")); } }
            if let Some(min) = bound("exclusiveMinimum") { if n <= min { found.push(format!("{at}: {n} is not above {min}")); } }
            if let Some(max) = bound("exclusiveMaximum") { if n >= max { found.push(format!("{at}: {n} is not below {max}")); } }
        }
        Value::Array(items) => {
            let count = items.len() as u64;
            if let Some(min) = rules.get("minItems").and_then(Value::as_u64) { if count < min { found.push(format!("{at}: has {count} items, fewer than {min}")); } }
            if let Some(max) = rules.get("maxItems").and_then(Value::as_u64) { if count > max { found.push(format!("{at}: has {count} items, more than {max}")); } }
            if rules.get("uniqueItems") == Some(&Value::Bool(true)) {
                for (i, item) in items.iter().enumerate() {
                    if items[..i].contains(item) { found.push(format!("{at}[{i}]: repeats {}", short(item))); }
                }
            }
            if let Some(each) = rules.get("items") {
                for (i, item) in items.iter().enumerate() { check(each, item, &format!("{at}[{i}]"), found); }
            }
        }
        Value::Object(fields) => {
            let count = fields.len() as u64;
            if let Some(min) = rules.get("minProperties").and_then(Value::as_u64) { if count < min { found.push(format!("{at}: has {count} fields, fewer than {min}")); } }
            if let Some(max) = rules.get("maxProperties").and_then(Value::as_u64) { if count > max { found.push(format!("{at}: has {count} fields, more than {max}")); } }
            for name in rules.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if !fields.contains_key(name) { found.push(format!("{at}.{name}: is missing")); }
            }
            let named = rules.get("properties").and_then(Value::as_object);
            for (name, field) in fields {
                match named.and_then(|all| all.get(name)) {
                    Some(inner) => check(inner, field, &format!("{at}.{name}"), found),
                    None => match rules.get("additionalProperties") {
                        Some(Value::Bool(false)) => found.push(format!("{at}.{name}: is not a field this step asks for")),
                        Some(other @ Value::Object(_)) => check(other, field, &format!("{at}.{name}"), found),
                        _ => {}
                    },
                }
            }
        }
        _ => {}
    }
    if let Some(Value::Array(all)) = rules.get("allOf") {
        for inner in all { check(inner, value, at, found); }
    }
    if let Some(Value::Array(any)) = rules.get("anyOf") {
        if !any.iter().any(|inner| misses_at(inner, value, at).is_empty()) { found.push(format!("{at}: fits none of the {} shapes allowed", any.len())); }
    }
    if let Some(Value::Array(one)) = rules.get("oneOf") {
        let fits = one.iter().filter(|inner| misses_at(inner, value, at).is_empty()).count();
        if fits != 1 { found.push(format!("{at}: fits {fits} of the {} shapes, but must fit exactly one", one.len())); }
    }
    if let Some(never) = rules.get("not") {
        if misses_at(never, value, at).is_empty() { found.push(format!("{at}: fits a shape it must not fit")); }
    }
}

fn misses_at(shape: &Value, value: &Value, at: &str) -> Vec<String> {
    let mut found = Vec::new();
    check(shape, value, at, &mut found);
    found
}

#[cfg(test)]
mod tests {
    use super::misses;
    use serde_json::json;

    fn decision() -> serde_json::Value {
        json!({ "type": "object", "required": ["case_id", "areas"], "additionalProperties": false, "properties": {
            "case_id": { "type": "string", "minLength": 3, "pattern": "^case:" },
            "areas": { "type": "array", "minItems": 2, "uniqueItems": true, "items": { "type": "object", "required": ["area", "effect"],
                "properties": { "area": { "type": "string", "minLength": 1 }, "effect": { "enum": ["serves", "leaves-out", "takes-from"] } } } },
            "score": { "type": ["integer", "null"], "minimum": 0, "maximum": 10 },
            "link": { "type": "string", "format": "uri", "description": "a note, not checked" } } })
    }

    #[test]
    fn an_answer_that_fits_has_no_misses() {
        let answer = json!({ "case_id": "case:one", "areas": [{ "area": "health", "effect": "serves" }, { "area": "money", "effect": "takes-from" }], "score": null, "link": "x" });
        assert_eq!(misses(&decision(), &answer), Vec::<String>::new());
    }

    #[test]
    fn every_miss_is_named_with_where_it_is() {
        let answer = json!({ "case_id": "x", "areas": [{ "area": "", "effect": "maybe" }], "score": 11, "extra": true });
        let found = misses(&decision(), &answer);
        for expected in ["answer.case_id: has 1 characters, fewer than 3", "answer.case_id: \"x\" does not match ^case:", "answer.areas: has 1 items, fewer than 2",
            "answer.areas[0].area: has 0 characters, fewer than 1", "answer.areas[0].effect: is \"maybe\", but must be one of", "answer.score: 11 is above 10",
            "answer.extra: is not a field this step asks for"] {
            assert!(found.iter().any(|miss| miss.starts_with(expected)), "{expected} not in {found:?}");
        }
    }

    #[test]
    fn a_missing_field_and_a_wrong_type_are_named() {
        let found = misses(&decision(), &json!({ "areas": "two" }));
        assert!(found.contains(&"answer.case_id: is missing".to_string()), "{found:?}");
        assert!(found.iter().any(|miss| miss.starts_with("answer.areas: is string")), "{found:?}");
        assert_eq!(misses(&decision(), &json!("words")), vec!["answer: is string \"words\", but must be object".to_string()]);
    }

    #[test]
    fn an_integer_answer_fits_a_number_and_a_whole_float_fits_an_integer() {
        assert!(misses(&json!({ "type": "number" }), &json!(3)).is_empty());
        assert!(misses(&json!({ "type": "integer" }), &json!(3.0)).is_empty());
        assert!(!misses(&json!({ "type": "integer" }), &json!(3.5)).is_empty());
    }

    #[test]
    fn a_keyword_this_check_does_not_know_refuses_rather_than_half_checks() {
        let found = misses(&json!({ "type": "string", "contentEncoding": "base64" }), &json!("abc"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("contentEncoding"), "{found:?}");
    }

    #[test]
    fn any_of_one_of_and_not_choose_between_shapes() {
        let either = json!({ "anyOf": [{ "type": "string" }, { "type": "integer" }] });
        assert!(misses(&either, &json!(1)).is_empty());
        assert!(!misses(&either, &json!(true)).is_empty());
        let one = json!({ "oneOf": [{ "type": "number" }, { "type": "integer" }] });
        assert!(!misses(&one, &json!(1)).is_empty(), "1 fits both, so oneOf refuses it");
        assert!(!misses(&json!({ "not": { "const": "ai" } }), &json!("ai")).is_empty());
    }
}
