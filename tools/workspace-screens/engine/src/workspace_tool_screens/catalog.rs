//! Pure projection of one original `ai-tool-descriptor` DATA row.
//!
//! The caller supplies the placements it has already resolved from current
//! deployment and entitlement state. This module does not read raw authority
//! rows, choose a resource, execute `invoke`, or apply declared `effects`.
//! Unknown top-level descriptor fields are dropped; nested values retained by
//! the original decoder stay in the ECMAScript JSON connection without serde.

pub mod placements;
pub use placements::{admit_placement, placements_from_catalog};

use super::Failure;
use crate::ecma_json::{self, JsString, Object, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub id: JsString,
    pub label: JsString,
    pub reachable_from: Vec<JsString>,
}

#[derive(Clone)]
pub struct AdmittedTool {
    payload: Value,
    id: JsString,
    placements: Vec<JsString>,
}
impl AdmittedTool {
    pub fn id(&self) -> &JsString {
        &self.id
    }
    pub fn placements(&self) -> &[JsString] {
        &self.placements
    }
    /// Read-only projected payload for current-owner eligibility checks.
    pub fn payload(&self) -> &Value {
        &self.payload
    }
}

#[track_caller]
fn invalid(reason: &'static str) -> Failure {
    Failure::Invalid(reason, crate::cause!(caller_site: invalid_tool_descriptor))
}
fn key(name: &str) -> JsString {
    JsString::from(name)
}
fn get<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&key(name)),
        _ => None,
    }
}
fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}
fn string(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}
fn has(value: &Value, name: &str) -> bool {
    get(value, name).is_some()
}
fn insert(object: &mut Object, name: &str, value: Value) {
    object.insert(key(name), value);
}
fn string_value(value: &JsString) -> Value {
    Value::String(value.clone())
}
fn text_field(value: &Value, name: &str) -> Option<JsString> {
    let value = string(get(value, name)?)?;
    nonblank(value).then(|| value.clone())
}

// ECMAScript String.prototype.trim's WhiteSpace and LineTerminator code units.
pub(crate) fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x0009 | 0x000a | 0x000b | 0x000c | 0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}
fn nonblank(value: &JsString) -> bool {
    value.units().iter().any(|unit| !js_space(*unit))
}
fn trimmed(value: &JsString) -> JsString {
    let units = value.units();
    let start = units
        .iter()
        .position(|unit| !js_space(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !js_space(*unit))
        .map_or(start, |at| at + 1);
    JsString::from_units(units[start..end].to_vec())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => *value != 0.0 && !value.is_nan(),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn is_safe_integer(value: &Value) -> bool {
    match value {
        Value::Number(value) => {
            value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
        }
        _ => false,
    }
}
fn text_list(value: &Value) -> Option<Vec<JsString>> {
    let rows = match value {
        Value::Array(rows) if !rows.is_empty() => rows,
        _ => return None,
    };
    rows.iter()
        .map(|row| string(row).filter(|value| nonblank(value)).cloned())
        .collect()
}
fn object_entries(value: &Value) -> Option<Vec<(JsString, Value)>> {
    match value {
        Value::Object(object) => Some(
            object
                .property_entries()
                .into_iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        ),
        _ => None,
    }
}
fn object_has_only(value: &Value, names: &[&str]) -> bool {
    let Some(entries) = object_entries(value) else {
        return false;
    };
    entries
        .iter()
        .all(|(name, _)| names.iter().any(|candidate| name == &key(candidate)))
}
fn exact_object_keys(value: &Value, names: &[&str]) -> bool {
    let Some(entries) = object_entries(value) else {
        return false;
    };
    entries.len() == names.len() && object_has_only(value, names)
}
fn field_is(value: &Value, name: &str, expected: &str) -> bool {
    string(get(value, name).unwrap_or(&Value::Null)).is_some_and(|value| value == &key(expected))
}
fn is_path(value: &Value) -> bool {
    match value {
        Value::Array(parts) if !parts.is_empty() => parts
            .iter()
            .all(|part| string(part).is_some_and(|part| !part.is_empty())),
        _ => false,
    }
}
fn selector_valid(value: &Value) -> bool {
    let Some(selector) = string(value) else {
        return false;
    };
    let units = selector.units();
    if units.first() != Some(&(b'$' as u16)) {
        return false;
    }
    let mut at = 1;
    while at < units.len() {
        if units[at] == b'.' as u16 {
            at += 1;
            if at >= units.len() || !(units[at] == b'_' as u16 || ascii_alpha(units[at])) {
                return false;
            }
            at += 1;
            while at < units.len()
                && (units[at] == b'_' as u16 || ascii_alpha(units[at]) || ascii_digit(units[at]))
            {
                at += 1;
            }
        } else if units[at] == b'[' as u16 {
            at += 1;
            let first = at;
            while at < units.len() && ascii_digit(units[at]) {
                at += 1;
            }
            if first == at
                || units.get(at) != Some(&(b']' as u16))
                || at - first > 1 && units[first] == b'0' as u16
            {
                return false;
            }
            at += 1;
        } else {
            return false;
        }
    }
    true
}
fn ascii_alpha(unit: u16) -> bool {
    (b'A' as u16..=b'Z' as u16).contains(&unit) || (b'a' as u16..=b'z' as u16).contains(&unit)
}
fn ascii_digit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit)
}
fn ascii_lower(unit: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&unit) {
        unit + u16::from(b'a' - b'A')
    } else {
        unit
    }
}
fn selector_ref(value: &Value) -> bool {
    exact_object_keys(value, &["from", "path"])
        && (field_is(value, "from", "input") || field_is(value, "from", "output"))
        && matches!(get(value, "path"), Some(path) if is_path(path))
        && matches!(get(value, "path"), Some(Value::Array(path)) if !path.is_empty())
}

fn secret_field(name: &JsString) -> bool {
    let lower: Vec<u16> = name.units().iter().map(|unit| ascii_lower(*unit)).collect();
    let candidates: [&[u8]; 8] = [
        b"secret",
        b"password",
        b"passphrase",
        b"token",
        b"credential",
        b"authorization",
        b"api",
        b"private",
    ];
    let contains = |needle: &[u8]| {
        lower.windows(needle.len()).any(|part| {
            part.iter()
                .copied()
                .eq(needle.iter().map(|byte| *byte as u16))
        })
    };
    let mut matched = candidates[..6].iter().any(|needle| contains(needle));
    if !matched {
        for start in 0..lower.len() {
            if lower[start..].starts_with(&[b'a' as u16, b'p' as u16, b'i' as u16]) {
                let mut at = start + 3;
                if matches!(lower.get(at), Some(95 | 45)) {
                    at += 1;
                }
                if lower
                    .get(at..at + 3)
                    .is_some_and(|tail| tail == [b'k' as u16, b'e' as u16, b'y' as u16])
                {
                    matched = true;
                    break;
                }
            }
            if lower[start..].starts_with(&[
                b'p' as u16,
                b'r' as u16,
                b'i' as u16,
                b'v' as u16,
                b'a' as u16,
                b't' as u16,
                b'e' as u16,
            ]) {
                let mut at = start + 7;
                if matches!(lower.get(at), Some(95 | 45)) {
                    at += 1;
                }
                if lower
                    .get(at..at + 3)
                    .is_some_and(|tail| tail == [b'k' as u16, b'e' as u16, b'y' as u16])
                {
                    matched = true;
                    break;
                }
            }
        }
    }
    matched && !secret_name_reference(&lower)
}
fn secret_name_reference(lower: &[u16]) -> bool {
    [
        b"_name".as_slice(),
        b"_names",
        b"_ref",
        b"_refs",
        b"_id",
        b"_ids",
        b"_url",
        b"_urls",
    ]
    .iter()
    .any(|suffix| lower.ends_with(&suffix.iter().map(|unit| *unit as u16).collect::<Vec<_>>()))
}
fn secret_value(value: &JsString) -> bool {
    let units = value.units();
    let mut at = 0;
    while at < units.len() && js_space(units[at]) {
        at += 1;
    }
    let rest = &units[at..];
    for prefix in [&b"bearer"[..], &b"basic"[..]] {
        if starts_ascii_case(rest, prefix) {
            let mut pos = prefix.len();
            if pos >= rest.len() || !js_space(rest[pos]) {
                continue;
            }
            while pos < rest.len() && js_space(rest[pos]) {
                pos += 1;
            }
            if rest[pos..]
                .iter()
                .take_while(|unit| !js_space(**unit))
                .count()
                >= 8
            {
                return true;
            }
        }
    }
    pem_private_key(rest)
}
fn starts_ascii_case(units: &[u16], prefix: &[u8]) -> bool {
    units.len() >= prefix.len()
        && units
            .iter()
            .zip(prefix)
            .all(|(unit, byte)| ascii_lower(*unit) == u16::from(byte.to_ascii_lowercase()))
}
fn pem_private_key(units: &[u16]) -> bool {
    const BEGIN: &[u8] = b"-----BEGIN ";
    if !starts_ascii_case(units, BEGIN) {
        return false;
    }
    let mut at = BEGIN.len();
    loop {
        // The source's [A-Z ]* can backtrack to the beginning of PRIVATE KEY.
        // Check each legal prefix boundary instead of greedily swallowing it.
        if starts_ascii_case(&units[at..], b"PRIVATE KEY-----") {
            return true;
        }
        if at == units.len() || !(ascii_alpha(units[at]) || units[at] == b' ' as u16) {
            return false;
        }
        at += 1;
    }
}
fn has_secret(value: &Value, depth: usize, nodes: &mut usize) -> Result<bool, Failure> {
    *nodes = nodes.checked_add(1).ok_or(crate::cause!(Failure::Bounds))?;
    if *nodes > ecma_json::HARD_NODES || depth > ecma_json::HARD_DEPTH {
        return Err(crate::cause!(Failure::Bounds));
    }
    match value {
        Value::String(value) => Ok(secret_value(value)),
        Value::Array(values) => {
            for value in values {
                if has_secret(value, depth + 1, nodes)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Value::Object(object) => {
            for (name, child) in object.property_entries() {
                if string(child).is_some_and(|value| nonblank(value)) && secret_field(name) {
                    return Ok(true);
                }
                if has_secret(child, depth + 1, nodes)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

fn tool_lines(value: &Value) -> Option<Vec<Value>> {
    let rows = match value {
        Value::Array(rows) if (1..=8).contains(&rows.len()) => rows,
        _ => return None,
    };
    let mut lines = Vec::with_capacity(rows.len());
    let mut folded = Vec::with_capacity(rows.len());
    for row in rows {
        let value = string(row)?;
        let line = trimmed(value);
        if line.is_empty()
            || line.len() > 160
            || line
                .units()
                .iter()
                .any(|unit| *unit <= 0x001f || *unit == 0x007f)
        {
            return None;
        }
        let lower = lowercase_units(&line);
        if folded.iter().any(|previous| previous == &lower) {
            return None;
        }
        folded.push(lower);
        lines.push(Value::String(line));
    }
    Some(lines)
}
fn lowercase_units(value: &JsString) -> Vec<u16> {
    let mut result = Vec::new();
    let units = value.units();
    let mut at = 0;
    while at < units.len() {
        let first = units[at];
        if (0xd800..=0xdbff).contains(&first)
            && units
                .get(at + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            let scalar =
                0x10000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(units[at + 1]) - 0xdc00);
            if let Some(character) = char::from_u32(scalar) {
                for lower in character.to_lowercase() {
                    let mut buffer = [0_u16; 2];
                    result.extend_from_slice(lower.encode_utf16(&mut buffer));
                }
            }
            at += 2;
        } else if (0xd800..=0xdfff).contains(&first) {
            result.push(first);
            at += 1;
        } else if let Some(character) = char::from_u32(u32::from(first)) {
            for lower in character.to_lowercase() {
                let mut buffer = [0_u16; 2];
                result.extend_from_slice(lower.encode_utf16(&mut buffer));
            }
            at += 1;
        } else {
            result.push(first);
            at += 1;
        }
    }
    result
}

fn effects_problem(value: &Value) -> Option<&'static str> {
    let effects = match value {
        Value::Array(effects) if (1..=20).contains(&effects.len()) => effects,
        Value::Array(_) => return Some("effects must be a list of 1 to 20 effects"),
        _ => return Some("effects must be a list of 1 to 20 effects"),
    };
    for effect in effects {
        if !is_record(effect)
            || !(field_is(effect, "on", "mutate") || field_is(effect, "on", "success"))
            || !(field_is(effect, "action", "update") || field_is(effect, "action", "invalidate"))
        {
            return Some(
                "each effect needs on (mutate or success) and action (update or invalidate)",
            );
        }
        let read = match get(effect, "read") {
            Some(Value::Array(read)) if !read.is_empty() => read,
            _ => {
                return Some("each effect read is a list of literal text and { from, path } values")
            }
        };
        if !read
            .iter()
            .all(|part| string(part).is_some_and(|value| !value.is_empty()) || selector_ref(part))
        {
            return Some("each effect read is a list of literal text and { from, path } values");
        }
        if !matches!(read.first(), Some(Value::String(value)) if value.units().first() == Some(&(b'/' as u16)))
        {
            return Some(
                "each effect read starts with the literal address of a read, beginning with /",
            );
        }
        let merge = get(effect, "merge");
        if field_is(effect, "action", "invalidate") && merge.is_some() {
            return Some("an invalidate effect has no merge");
        }
        if field_is(effect, "action", "update") {
            let Some(merge) = merge.filter(|value| is_record(value)) else {
                return Some("an update effect needs merge { at, op (set, append, replace or remove), value }");
            };
            let op = ["set", "append", "replace", "remove"]
                .iter()
                .find(|op| field_is(merge, "op", op));
            if !matches!(get(merge, "at"), Some(path) if is_path(path)) || op.is_none() {
                return Some("an update effect needs merge { at, op (set, append, replace or remove), value }");
            }
            let merge_value = get(merge, "value");
            let valid_value = merge_value.is_some_and(selector_ref)
                || matches!(merge_value, Some(value) if exact_object_keys(value, &["value"]));
            if !valid_value {
                return Some("merge.value is { from, path } or { value }");
            }
            if matches!(op, Some(&"replace") | Some(&"remove"))
                && !string(get(merge, "match").unwrap_or(&Value::Null))
                    .is_some_and(|value| !value.is_empty())
            {
                return Some("a replace or remove merge names the key it matches items by (match)");
            }
        }
    }
    None
}

fn admits_encodes(value: &Value) -> Result<Value, Failure> {
    let Some(accepts) = get(value, "accepts").and_then(text_list) else {
        return Err(invalid(
            "encodes.accepts must be a non-empty list of content kinds, for example [\"text\"]",
        ));
    };
    let space = get(value, "space").filter(|value| is_record(value));
    let Some(space) = space else {
        return Err(invalid(
            "encodes.space must name its model and a whole-number dim above 0",
        ));
    };
    let model = text_field(space, "model");
    let dim = get(space, "dim");
    if model.is_none()
        || !dim.is_some_and(is_safe_integer)
        || matches!(dim, Some(Value::Number(value)) if *value < 1.0)
    {
        return Err(invalid(
            "encodes.space must name its model and a whole-number dim above 0",
        ));
    }
    if !object_has_only(
        space,
        &["model", "revision", "dim", "query_prompt", "passage_prompt"],
    ) {
        return Err(invalid(
            "encodes.space holds only model, revision, dim, query_prompt, passage_prompt",
        ));
    }
    for field in ["revision", "query_prompt", "passage_prompt"] {
        if has(space, field) && string(get(space, field).unwrap()).is_none() {
            return Err(invalid("encodes.space revision and prompts must be text"));
        }
    }
    let reads = match get(value, "reads") {
        Some(Value::Array(reads)) if !reads.is_empty() => reads,
        _ => {
            return Err(invalid(
                "encodes.reads must be a non-empty list of the pieces it reads",
            ))
        }
    };
    let mut normalized_reads = Vec::with_capacity(reads.len());
    for read in reads {
        if !is_record(read) || text_field(read, "place").is_none() {
            return Err(invalid("each encodes.reads row must name its place"));
        }
        let times = get(read, "time_fields");
        if let Some(times) = times {
            let valid = is_record(times)
                && object_entries(times).unwrap().iter().all(|(name, child)| {
                    (name == &key("start") || name == &key("end"))
                        && string(child).is_some_and(|value| nonblank(value))
                });
            if !valid {
                return Err(invalid(
                    "encodes.reads time_fields holds only start and end, each a field name",
                ));
            }
        }
        let place = text_field(read, "place").unwrap();
        let mut row = Object::new();
        if let (Some(result_kind), Some(pieces_path), Some(text_field_name)) = (
            text_field(read, "result_kind"),
            text_field(read, "pieces_path"),
            text_field(read, "text_field"),
        ) {
            insert(&mut row, "result_kind", string_value(&result_kind));
            insert(&mut row, "place", string_value(&place));
            insert(&mut row, "pieces_path", string_value(&pieces_path));
            insert(&mut row, "text_field", string_value(&text_field_name));
            if let Some(times) = times {
                insert(&mut row, "time_fields", normalize_time_fields(times));
            }
        } else if let Some(media_types) = get(read, "media_types").and_then(text_list) {
            insert(
                &mut row,
                "media_types",
                Value::Array(media_types.iter().map(string_value).collect()),
            );
            insert(&mut row, "place", string_value(&place));
        } else {
            return Err(invalid("each encodes.reads row is { result_kind, place, pieces_path, text_field } or { media_types, place }"));
        }
        normalized_reads.push(Value::Object(row));
    }
    let mut normalized_space = Object::new();
    insert(
        &mut normalized_space,
        "model",
        string_value(&model.unwrap()),
    );
    insert(&mut normalized_space, "dim", dim.unwrap().clone());
    for field in ["revision", "query_prompt", "passage_prompt"] {
        if string(get(space, field).unwrap_or(&Value::Null)).is_some() {
            insert(
                &mut normalized_space,
                field,
                get(space, field).unwrap().clone(),
            );
        }
    }
    let mut normalized = Object::new();
    insert(
        &mut normalized,
        "accepts",
        Value::Array(accepts.iter().map(string_value).collect()),
    );
    insert(&mut normalized, "space", Value::Object(normalized_space));
    insert(&mut normalized, "reads", Value::Array(normalized_reads));
    Ok(Value::Object(normalized))
}
fn normalize_time_fields(value: &Value) -> Value {
    let mut out = Object::new();
    for field in ["start", "end"] {
        if let Some(value) = get(value, field) {
            insert(&mut out, field, value.clone());
        }
    }
    Value::Object(out)
}
fn canonical_ref(value: &Value) -> Option<Value> {
    if !is_record(value) {
        return None;
    }
    let pick = |snake: &str, camel: &str| -> Option<JsString> {
        let first = get(value, snake).filter(|value| !matches!(value, Value::Null));
        let found = first.or_else(|| get(value, camel))?;
        let found = string(found)?;
        nonblank(found).then(|| found.clone())
    };
    let address = pick("canonical_address", "canonicalAddress")?;
    let revision = pick("canonical_revision", "canonicalRevision")?;
    let hash = pick("payload_hash", "payloadHash")?;
    let mut object = Object::new();
    insert(&mut object, "canonicalAddress", string_value(&address));
    insert(&mut object, "canonicalRevision", string_value(&revision));
    insert(&mut object, "payloadHash", string_value(&hash));
    Some(Value::Object(object))
}

/// Admit a descriptor and check runnable placement against the caller's already
/// resolved current deployment/entitlement set. No raw DATA row grants a place.
pub fn admit_tool(raw: &Value, placements: &[Placement]) -> Result<AdmittedTool, Failure> {
    if !is_record(raw) || !field_is(raw, "kind", "ai-tool-descriptor") {
        return Err(invalid("kind must be \"ai-tool-descriptor\""));
    }
    let id = text_field(raw, "id").ok_or_else(|| invalid("id must be a non-empty string"))?;
    let mut nodes = 0;
    if has_secret(raw, 0, &mut nodes)? {
        return Err(crate::cause!(Failure::SecretValue));
    }
    if has(raw, "bytes_fingerprint")
        && !string(get(raw, "bytes_fingerprint").unwrap()).is_some_and(fingerprint_valid)
    {
        return Err(invalid("bytes_fingerprint must be a BLAKE3 identity: \"1f:\" followed by 64 lowercase hex characters"));
    }
    if has(raw, "invoke")
        && !(get(raw, "invoke").is_some_and(is_record)
            && text_field(get(raw, "invoke").unwrap(), "kind").is_some())
    {
        return Err(invalid("invoke must be an object with a kind"));
    }
    let placement_ids = if let Some(value) = get(raw, "placements") {
        text_list(value)
            .ok_or_else(|| invalid("placements must be a non-empty list of placement ids"))?
    } else {
        Vec::new()
    };
    if has(raw, "show_on_public_site")
        && !matches!(get(raw, "show_on_public_site"), Some(Value::Bool(_)))
    {
        return Err(invalid("show_on_public_site must be true or false"));
    }
    if let Some(public_run) = get(raw, "public_run") {
        let valid = is_record(public_run)
            && matches!(get(public_run, "runs_per_day"), Some(value) if is_safe_integer(value) && matches!(value, Value::Number(v) if (1.0..=100.0).contains(v)))
            && object_has_only(public_run, &["runs_per_day", "max_input_bytes"])
            && (!has(public_run, "max_input_bytes")
                || matches!(get(public_run, "max_input_bytes"), Some(value) if is_safe_integer(value) && matches!(value, Value::Number(v) if (1.0..=16384.0).contains(v))));
        if !valid {
            return Err(invalid("public_run must name runs_per_day from 1 to 100 and optional max_input_bytes from 1 to 16384"));
        }
    }
    for field in ["needs", "provenance"] {
        if has(raw, field) && !is_record(get(raw, field).unwrap()) {
            return Err(invalid(if field == "needs" {
                "needs must be an object"
            } else {
                "provenance must be an object"
            }));
        }
    }
    if let Some(verify) = get(raw, "verify") {
        let valid = matches!(verify, Value::Array(rows) if !rows.is_empty() && rows.iter().all(|row| is_record(row) && text_field(row, "kind").is_some()));
        if !valid {
            return Err(invalid(
                "verify must be a non-empty list of checks, each with a kind",
            ));
        }
    }
    if let Some(records) = get(raw, "keeps_records") {
        let valid = matches!(records, Value::Array(rows) if rows.iter().all(|row| is_record(row)
            && matches!(get(row, "output_selector"), Some(value) if selector_valid(value))
            && text_field(row, "type_field").is_some() && text_field(row, "id_field").is_some()));
        if !valid {
            return Err(invalid(
                "keeps_records must be a list of { output_selector, type_field, id_field }",
            ));
        }
    }
    if let Some(observes) = get(raw, "observes") {
        let valid = is_record(observes)
            && matches!(get(observes, "fields"), Some(Value::Object(fields))
            if fields.property_entries().into_iter().all(|(field, spec)| is_record(spec)
                && (field_is(spec, "from", "output") && matches!(get(spec, "path"), Some(value) if selector_valid(value))
                    || (field == &key("provider") || field == &key("route")) && text_field(spec, "value").is_some())));
        if !valid {
            return Err(invalid("observes.fields must select actual output values; only provider and route may be declared constants"));
        }
    }
    if let Some(limits) = get(raw, "use_limits") {
        let valid = is_record(limits)
            && !object_entries(limits).unwrap().is_empty()
            && object_has_only(limits, &["runs_per_day", "failures_per_day"])
            && object_entries(limits).unwrap().iter().all(|(_, value)| {
                is_safe_integer(value) && matches!(value, Value::Number(value) if *value >= 1.0)
            });
        if !valid {
            return Err(invalid(
                "use_limits must name positive integer runs_per_day or failures_per_day",
            ));
        }
    }
    if let Some(retry) = get(raw, "retry") {
        let valid = is_record(retry)
            && matches!(get(retry, "max_attempts"), Some(value) if is_safe_integer(value) && matches!(value, Value::Number(value) if *value >= 1.0))
            && object_has_only(
                retry,
                &[
                    "max_attempts",
                    "first_after_seconds",
                    "factor",
                    "longest_after_seconds",
                ],
            )
            && object_entries(retry)
                .unwrap()
                .iter()
                .all(|(_, value)| matches!(value, Value::Number(value) if *value > 0.0));
        if !valid {
            return Err(invalid("retry must be { max_attempts (a whole number), first_after_seconds, factor, longest_after_seconds }, each above 0"));
        }
    }
    let serves = if let Some(value) = get(raw, "serves") {
        Some(
            text_list(value)
                .ok_or_else(|| invalid("serves must be a non-empty list of job names"))?,
        )
    } else {
        None
    };
    if has(raw, "minimum_host_version")
        && !string(get(raw, "minimum_host_version").unwrap()).is_some_and(version_valid)
    {
        return Err(invalid(
            "minimum_host_version must be a version such as 2026.9.28: numbers joined by dots",
        ));
    }
    if let Some(effects) = get(raw, "effects") {
        if let Some(problem) = effects_problem(effects) {
            return Err(invalid(problem));
        }
    }
    let encodes = get(raw, "encodes").map(admits_encodes).transpose()?;
    if encodes.is_some()
        && !serves
            .as_ref()
            .is_some_and(|serves| serves.iter().any(|serve| serve == &key("encode")))
    {
        return Err(invalid(
            "a tool that declares encodes must serve \"encode\"",
        ));
    }
    if let Some(needs) = get(raw, "needs") {
        if has(needs, "secret_names") && text_list(get(needs, "secret_names").unwrap()).is_none() {
            return Err(invalid("needs.secret_names must be a list of secret names"));
        }
    }

    let mut projected = Object::new();
    for field in ["description", "handler_ref", "permission_capability_ref"] {
        copy_optional_text(raw, &mut projected, field);
    }
    insert(&mut projected, "id", string_value(&id));
    for field in ["input_schema"] {
        copy_existing(raw, &mut projected, field);
    }
    copy_optional_text(raw, &mut projected, "label");
    copy_existing(raw, &mut projected, "output_schema");
    copy_optional_text(raw, &mut projected, "status");
    for field in ["fixed_input", "trusted_context"] {
        copy_if_record(raw, &mut projected, field);
    }
    for field in ["result_selector", "surface_selector"] {
        if get(raw, field).is_some_and(selector_valid) {
            copy_existing(raw, &mut projected, field);
        }
    }
    if let Some(value) = get(raw, "cancellation_capability_ref").and_then(canonical_ref) {
        insert(&mut projected, "cancellation_capability_ref", value);
    }
    copy_optional_text(raw, &mut projected, "job");
    for field in ["can_do", "cannot_do"] {
        if let Some(lines) = get(raw, field).and_then(tool_lines) {
            insert(&mut projected, field, Value::Array(lines));
        }
    }
    for field in ["bytes_fingerprint", "minimum_host_version"] {
        copy_optional_text(raw, &mut projected, field);
    }
    if let Some(value) = get(raw, "effects") {
        insert(&mut projected, "effects", value.clone());
    }
    copy_if_record(raw, &mut projected, "invoke");
    copy_if_record(raw, &mut projected, "needs");
    copy_optional_text(raw, &mut projected, "licence_class");
    if !placement_ids.is_empty() {
        insert(
            &mut projected,
            "placements",
            Value::Array(placement_ids.iter().map(string_value).collect()),
        );
    }
    for field in ["maker", "listed_on", "price_ref"] {
        copy_optional_text(raw, &mut projected, field);
    }
    if matches!(get(raw, "show_on_public_site"), Some(Value::Bool(true))) {
        insert(&mut projected, "show_on_public_site", Value::Bool(true));
    }
    if let Some(public_run) = get(raw, "public_run") {
        insert(
            &mut projected,
            "public_run",
            normalize_public_run(public_run),
        );
    }
    for field in ["result_saved_as_tool", "runs_quietly", "read_only"] {
        if matches!(get(raw, field), Some(Value::Bool(true))) {
            insert(&mut projected, field, Value::Bool(true));
        }
    }
    for field in ["keeps_records", "observes", "verify"] {
        copy_existing(raw, &mut projected, field);
    }
    copy_if_record(raw, &mut projected, "provenance");
    if get(raw, "screen")
        .is_some_and(|value| is_record(value) && text_field(value, "kind").is_some())
    {
        copy_existing(raw, &mut projected, "screen");
    }
    for field in ["controls", "billing"] {
        copy_if_record(raw, &mut projected, field);
    }
    copy_existing(raw, &mut projected, "use_limits");
    copy_existing(raw, &mut projected, "retry");
    if let Some(serves) = serves {
        insert(
            &mut projected,
            "serves",
            Value::Array(serves.iter().map(string_value).collect()),
        );
    }
    if let Some(encodes) = encodes {
        insert(&mut projected, "encodes", encodes);
    }

    let runnable = has(&Value::Object(projected.clone()), "invoke");
    if runnable
        && !placement_ids
            .iter()
            .any(|id| placements.iter().any(|placement| &placement.id == id))
    {
        return Err(crate::cause!(Failure::UnknownPlacement));
    }
    Ok(AdmittedTool {
        payload: Value::Object(projected),
        id,
        placements: placement_ids,
    })
}

fn copy_optional_text(source: &Value, target: &mut Object, field: &str) {
    if text_field(source, field).is_some() {
        copy_existing(source, target, field);
    }
}
fn copy_existing(source: &Value, target: &mut Object, field: &str) {
    if let Some(value) = get(source, field) {
        insert(target, field, value.clone());
    }
}
fn copy_if_record(source: &Value, target: &mut Object, field: &str) {
    if get(source, field).is_some_and(is_record) {
        copy_existing(source, target, field);
    }
}
fn normalize_public_run(value: &Value) -> Value {
    let mut out = Object::new();
    copy_existing(value, &mut out, "runs_per_day");
    copy_existing(value, &mut out, "max_input_bytes");
    Value::Object(out)
}
fn fingerprint_valid(value: &JsString) -> bool {
    let units = value.units();
    units.len() == 67
        && units[..3] == [b'1' as u16, b'f' as u16, b':' as u16]
        && units[3..]
            .iter()
            .all(|unit| ascii_digit(*unit) || (b'a' as u16..=b'f' as u16).contains(unit))
}
fn version_valid(value: &JsString) -> bool {
    let units = value.units();
    let mut at = 0;
    let mut count = 0;
    loop {
        let start = at;
        while at < units.len() && ascii_digit(units[at]) {
            at += 1;
        }
        if at == start || at - start > 9 {
            return false;
        }
        count += 1;
        if at == units.len() {
            return count <= 4;
        }
        if units[at] != b'.' as u16 || count == 4 {
            return false;
        }
        at += 1;
    }
}

/// Render the read-only catalog card for an already admitted descriptor.
/// `placements` is the caller's current resolved placement set; this function
/// never resolves authority or executes a suggested call. The source helper
/// accepts optional run statistics, but these shared/saved screen call sites
/// pass `undefined`; this ABI therefore uses that exact zero-run default.
pub fn tool_card(
    tool: &AdmittedTool,
    placements: &[Placement],
    host: &JsString,
    made_by: &JsString,
) -> Result<Value, Failure> {
    let payload = tool.payload();
    let place_rows: Vec<&Placement> = tool
        .placements()
        .iter()
        // The JavaScript caller builds a Map from rows, so a duplicate id is
        // resolved to its last inserted row.
        .filter_map(|id| {
            placements
                .iter()
                .rev()
                .find(|placement| &placement.id == id)
        })
        .collect();
    let here = place_rows.iter().any(|place| {
        place
            .reachable_from
            .iter()
            .any(|reachable| reachable == host)
    });
    let invoke = get(payload, "invoke").is_some_and(truthy);
    let mut card = Object::new();
    insert(&mut card, "tool_id", string_value(tool.id()));
    insert(
        &mut card,
        "label",
        get(payload, "label")
            .filter(|value| !matches!(value, Value::Null))
            .cloned()
            .unwrap_or_else(|| string_value(tool.id())),
    );
    copy_existing(payload, &mut card, "job");
    insert(
        &mut card,
        "description",
        get(payload, "description")
            .filter(|value| !matches!(value, Value::Null))
            .cloned()
            .unwrap_or(Value::Null),
    );
    for field in ["can_do", "cannot_do"] {
        if get(payload, field).is_some_and(truthy) {
            copy_existing(payload, &mut card, field);
        }
    }
    insert(
        &mut card,
        "input_schema",
        get(payload, "input_schema")
            .filter(|value| !matches!(value, Value::Null))
            .cloned()
            .unwrap_or_else(|| {
                let mut schema = Object::new();
                insert(&mut schema, "type", Value::String(key("object")));
                Value::Object(schema)
            }),
    );
    insert(
        &mut card,
        "runs_on",
        Value::Array(
            place_rows
                .iter()
                .map(|place| string_value(&place.label))
                .collect(),
        ),
    );
    if invoke && !here {
        insert(&mut card, "runs_here", Value::Bool(false));
    }
    let mut runs = Object::new();
    for field in ["runs", "contract_passed", "reported_met", "reported_failed"] {
        insert(&mut runs, field, Value::Number(0.0));
    }
    insert(&mut card, "earlier_runs", Value::Object(runs));
    insert(&mut card, "made_by", string_value(made_by));
    for field in ["price_ref", "listed_on", "use_limits"] {
        if get(payload, field).is_some_and(truthy) {
            copy_existing(payload, &mut card, field);
        }
    }
    if let Some(billing) = get(payload, "billing").filter(|value| is_record(value)) {
        if let Some(price) = get(billing, "price_micros") {
            let dollars = js_number(price)? / 1_000_000.0;
            let price_text = format!("${}", js_to_fixed_four(dollars));
            let mut price_object = Object::new();
            insert(
                &mut price_object,
                "amount",
                Value::String(JsString::from(price_text)),
            );
            insert(
                &mut price_object,
                "per",
                get(billing, "per")
                    .filter(|value| !matches!(value, Value::Null))
                    .cloned()
                    .unwrap_or_else(|| Value::String(key("call"))),
            );
            insert(&mut price_object, "before_markup", Value::Bool(true));
            insert(&mut card, "price", Value::Object(price_object));
        }
        if get(billing, "payers").is_some_and(truthy) {
            insert(
                &mut card,
                "who_can_pay",
                get(billing, "payers").unwrap().clone(),
            );
        }
        if get(billing, "measured_by_source").is_some_and(truthy) {
            insert(
                &mut card,
                "measured_by_its_source",
                get(billing, "measured_by_source").unwrap().clone(),
            );
        }
    }
    copy_optional_text(payload, &mut card, "bytes_fingerprint");
    if get(payload, "screen").is_some_and(is_record) {
        copy_existing(payload, &mut card, "screen");
    }
    if made_by == &key("a public source") {
        if let Some(provenance) = get(payload, "provenance").filter(|value| is_record(value)) {
            let mut source = Object::new();
            for (output, input) in [
                ("api", "api"),
                ("licence", "licence"),
                ("read_at", "read_at"),
            ] {
                insert(
                    &mut source,
                    output,
                    get(provenance, input)
                        .filter(|value| !matches!(value, Value::Null))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
            let url = ["page", "description", "server"]
                .iter()
                .find_map(|name| {
                    get(provenance, name).filter(|value| !matches!(value, Value::Null))
                })
                .cloned()
                .unwrap_or(Value::Null);
            insert(&mut source, "url", url);
            insert(&mut card, "source", Value::Object(source));
        }
    }
    if invoke {
        let mut arguments = Object::new();
        insert(&mut arguments, "tool_id", string_value(tool.id()));
        insert(
            &mut arguments,
            "input",
            Value::String(key("(an object matching input_schema)")),
        );
        insert(
            &mut arguments,
            "request_key",
            Value::String(key(
                "(any unique text; reuse it only to repeat this exact call)",
            )),
        );
        let mut call = Object::new();
        insert(&mut call, "tool", Value::String(key("run_tool")));
        insert(&mut call, "arguments", Value::Object(arguments));
        insert(&mut card, "next_call", Value::Object(call));
    } else {
        insert(&mut card, "next_call", Value::Null);
    }
    Ok(Value::Object(card))
}

/// ECMAScript Number.prototype.toFixed(4) formatting for a finite binary64
/// magnitude below 1e21. Multiplying the integer significand by 10,000 first
/// preserves the exact binary value, then rounds ties toward positive infinity
/// as the specification requires. For larger values, JS delegates to Number
/// string conversion, owned by this crate's existing ryu-js dependency.
fn js_to_fixed_four(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity".to_owned()
        } else {
            "Infinity".to_owned()
        };
    }
    if value.abs() >= 1e21 {
        let mut buffer = ryu_js::Buffer::new();
        return buffer.format_finite(value).to_owned();
    }

    let bits = value.abs().to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (significand, exponent) = if exponent_bits == 0 {
        (u128::from(fraction), -1074)
    } else {
        (
            u128::from((1_u64 << 52) | fraction),
            exponent_bits - 1023 - 52,
        )
    };
    let scaled = significand * 10_000;
    let rounded = if exponent >= 0 {
        scaled << exponent as u32
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let quotient = scaled >> shift;
            let remainder = scaled & ((1_u128 << shift) - 1);
            let half = 1_u128 << (shift - 1);
            quotient + u128::from(remainder >= half)
        }
    };
    let negative = value.is_sign_negative() && value != 0.0;
    let sign = if negative { "-" } else { "" };
    format!("{sign}{}.{:04}", rounded / 10_000, rounded % 10_000)
}

/// ECMAScript Number coercion for JSON-origin values used by billing's
/// `price_micros / 1e6`. JSON objects retain their ordinary prototype: objects
/// become NaN through `[object Object]`, while an own non-callable `toString`
/// shadows the intrinsic method and causes the same primitive-conversion
/// failure as the original JavaScript program.
fn js_number(value: &Value) -> Result<f64, Failure> {
    match value {
        Value::Null => Ok(0.0),
        Value::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => Ok(*value),
        Value::String(value) => Ok(js_number_string(value)),
        Value::Array(values) => {
            if has_own_to_string(value) {
                return Err(invalid(
                    "billing.price_micros cannot convert to a primitive value",
                ));
            }
            let mut joined = Vec::new();
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    joined.push(b',' as u16);
                }
                if matches!(item, Value::Null) {
                    continue;
                }
                let text = js_to_string(item)?;
                joined.extend_from_slice(text.units());
            }
            Ok(js_number_string(&JsString::from_units(joined)))
        }
        Value::Object(_) => {
            if has_own_to_string(value) {
                Err(invalid(
                    "billing.price_micros cannot convert to a primitive value",
                ))
            } else {
                Ok(f64::NAN)
            }
        }
    }
}

fn has_own_to_string(value: &Value) -> bool {
    has(value, "toString")
}

fn js_to_string(value: &Value) -> Result<JsString, Failure> {
    Ok(match value {
        Value::Null => key("null"),
        Value::Bool(value) => key(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            if value.is_nan() {
                key("NaN")
            } else if *value == f64::INFINITY {
                key("Infinity")
            } else if *value == f64::NEG_INFINITY {
                key("-Infinity")
            } else if *value == 0.0 {
                key("0")
            } else {
                let mut buffer = ryu_js::Buffer::new();
                JsString::from(buffer.format_finite(*value))
            }
        }
        Value::String(value) => value.clone(),
        Value::Array(values) => {
            if has_own_to_string(value) {
                return Err(invalid(
                    "billing.price_micros cannot convert to a primitive value",
                ));
            }
            let mut joined = Vec::new();
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    joined.push(b',' as u16);
                }
                if !matches!(item, Value::Null) {
                    joined.extend_from_slice(js_to_string(item)?.units());
                }
            }
            JsString::from_units(joined)
        }
        Value::Object(_) => {
            if has_own_to_string(value) {
                return Err(invalid(
                    "billing.price_micros cannot convert to a primitive value",
                ));
            }
            key("[object Object]")
        }
    })
}

fn js_number_string(value: &JsString) -> f64 {
    let units = value.units();
    let start = units
        .iter()
        .position(|unit| !js_space(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !js_space(*unit))
        .map_or(start, |at| at + 1);
    let units = &units[start..end];
    if units.is_empty() {
        return 0.0;
    }
    let Ok(text) = String::from_utf16(units) else {
        return f64::NAN;
    };
    match text.as_str() {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some((radix, digits)) = radix_prefix(&text) {
        return radix_integer_to_f64(digits, radix).unwrap_or(f64::NAN);
    }
    if !decimal_number_syntax(&text) {
        return f64::NAN;
    }
    normalize_decimal(&text).parse::<f64>().unwrap_or(f64::NAN)
}

fn normalize_decimal(text: &str) -> String {
    let bytes = text.as_bytes();
    let sign_len = usize::from(
        bytes
            .first()
            .is_some_and(|byte| matches!(*byte, b'+' | b'-')),
    );
    let mut normalized = text.to_owned();
    if bytes.get(sign_len) == Some(&b'.') {
        normalized.insert(sign_len, '0');
    }
    let bytes = normalized.as_bytes();
    let dot = bytes.iter().position(|byte| *byte == b'.');
    if let Some(dot) = dot {
        let end = bytes[dot + 1..]
            .iter()
            .position(|byte| matches!(*byte, b'e' | b'E'))
            .map_or(bytes.len(), |offset| dot + 1 + offset);
        if end == dot + 1 {
            normalized.insert(end, '0');
        }
    }
    normalized
}

fn radix_prefix(text: &str) -> Option<(u32, &str)> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'0' {
        return None;
    }
    let radix = match bytes[1] {
        b'x' | b'X' => 16,
        b'b' | b'B' => 2,
        b'o' | b'O' => 8,
        _ => return None,
    };
    Some((radix, &text[2..]))
}

fn radix_integer_to_f64(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Some(0.0);
    }
    let limit = match radix {
        2 => 1024,
        8 => 342,
        16 => 256,
        _ => unreachable!(),
    };
    if significant.len() > limit {
        return Some(f64::INFINITY);
    }
    let mut decimal = vec![0_u8]; // little-endian base-10 digits
    for character in significant.bytes() {
        let digit = match character {
            b'0'..=b'9' => u32::from(character - b'0'),
            b'a'..=b'f' => u32::from(character - b'a' + 10),
            b'A'..=b'F' => u32::from(character - b'A' + 10),
            _ => return None,
        };
        if digit >= radix {
            return None;
        }
        let mut carry = digit;
        for position in &mut decimal {
            let next = u32::from(*position) * radix + carry;
            *position = (next % 10) as u8;
            carry = next / 10;
        }
        while carry != 0 {
            decimal.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    let decimal: String = decimal
        .iter()
        .rev()
        .map(|digit| char::from(b'0' + *digit))
        .collect();
    Some(decimal.parse::<f64>().unwrap_or(f64::INFINITY))
}

fn decimal_number_syntax(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = usize::from(
        bytes
            .first()
            .is_some_and(|byte| matches!(*byte, b'+' | b'-')),
    );
    if at == bytes.len() {
        return false;
    }
    let integer_start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let integer_digits = at - integer_start;
    let mut fraction_digits = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let fraction_start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        fraction_digits = at - fraction_start;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if bytes
        .get(at)
        .is_some_and(|byte| matches!(*byte, b'e' | b'E'))
    {
        at += 1;
        if bytes
            .get(at)
            .is_some_and(|byte| matches!(*byte, b'+' | b'-'))
        {
            at += 1;
        }
        let exponent_start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == exponent_start {
            return false;
        }
    }
    at == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> Value {
        ecma_json::parse(source.as_bytes(), ecma_json::Limits::default()).unwrap()
    }

    fn text_field<'a>(value: &'a Value, name: &str) -> &'a JsString {
        string(get(value, name).unwrap()).unwrap()
    }

    #[test]
    fn refuses_secret_values_and_projects_only_owned_fields() {
        let secret =
            parse(r#"{"kind":"ai-tool-descriptor","id":"safe","api_token_value":"secret"}"#);
        assert!(matches!(
            admit_tool(&secret, &[]),
            Err(Failure::SecretValue(_))
        ));

        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","label":"Shown","unknown_metadata":{"x":1},"invoke":{"kind":"read"},"placements":["current"]}"#,
        );
        let admitted = admit_tool(
            &raw,
            &[Placement {
                id: "current".into(),
                label: "Current".into(),
                reachable_from: vec![],
            }],
        )
        .unwrap();
        assert!(get(admitted.payload(), "unknown_metadata").is_none());
        assert_eq!(
            text_field(admitted.payload(), "label"),
            &JsString::from("Shown")
        );
        assert!(get(admitted.payload(), "invoke").is_some());
    }

    #[test]
    fn rejects_invalid_nested_effect_selectors() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","effects":[{"on":"success","action":"update","read":["/items"],"merge":{"at":["items"],"op":"set","value":{"from":"output","path":"$.items"}}}]}"#,
        );
        assert!(matches!(admit_tool(&raw, &[]), Err(Failure::Invalid(_, _))));
    }

    #[test]
    fn runnable_admission_requires_intersection_with_current_placements() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","invoke":{"kind":"read"},"placements":["place-a"]}"#,
        );
        assert!(matches!(
            admit_tool(&raw, &[]),
            Err(Failure::UnknownPlacement(_))
        ));
        let admitted = admit_tool(
            &raw,
            &[Placement {
                id: "place-a".into(),
                label: "Cloud".into(),
                reachable_from: vec!["hosted".into()],
            }],
        )
        .unwrap();
        assert_eq!(admitted.placements(), &[JsString::from("place-a")]);
    }

    #[test]
    fn card_uses_current_placement_and_renders_call_and_control_hints() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","label":"Example","description":"Reads items","invoke":{"kind":"read"},"placements":["place-a"],"controls":{"subject":["item"]},"billing":{"price_micros":2550000}}"#,
        );
        let places = [Placement {
            id: "place-a".into(),
            label: "Cloud".into(),
            reachable_from: vec!["hosted".into()],
        }];
        let admitted = admit_tool(&raw, &places).unwrap();
        let card = tool_card(&admitted, &places, &"hosted".into(), &"shared".into()).unwrap();
        assert_eq!(text_field(&card, "tool_id"), &JsString::from("safe"));
        assert_eq!(text_field(&card, "label"), &JsString::from("Example"));
        assert!(get(&card, "runs_here").is_none());
        assert_eq!(
            text_field(get(&card, "price").unwrap(), "amount"),
            &JsString::from("$2.5500")
        );
        assert!(get(&card, "next_call").is_some());
        assert_eq!(
            get(&card, "earlier_runs").and_then(|value| get(value, "runs")),
            Some(&Value::Number(0.0))
        );

        let elsewhere = tool_card(&admitted, &places, &"local".into(), &"shared".into()).unwrap();
        assert_eq!(get(&elsewhere, "runs_here"), Some(&Value::Bool(false)));
    }

    #[test]
    fn malformed_price_strings_render_nan_like_javascript() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","billing":{"price_micros":"not-a-number"}}"#,
        );
        let admitted = admit_tool(&raw, &[]).unwrap();
        let card = tool_card(&admitted, &[], &"hosted".into(), &"shared".into()).unwrap();
        assert_eq!(
            text_field(get(&card, "price").unwrap(), "amount"),
            &JsString::from("$NaN")
        );
    }

    #[test]
    fn fixed_four_matches_javascript_binary64_rounding_and_special_cases() {
        assert_eq!(js_to_fixed_four(2.55), "2.5500");
        assert_eq!(js_to_fixed_four(1.23445), "1.2345");
        assert_eq!(js_to_fixed_four(0.0), "0.0000");
        assert_eq!(js_to_fixed_four(-0.0), "0.0000");
        assert_eq!(js_to_fixed_four(f64::from_bits(1)), "0.0000");
        assert_eq!(js_to_fixed_four(-f64::from_bits(1)), "-0.0000");
        assert_eq!(js_to_fixed_four(1e21), "1e+21");
        assert_eq!(js_to_fixed_four(f64::NAN), "NaN");
        assert_eq!(js_to_fixed_four(f64::INFINITY), "Infinity");
        assert_eq!(js_to_fixed_four(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn price_micros_is_divided_before_ecmascript_fixed_formatting() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","billing":{"price_micros":2550000}}"#,
        );
        let admitted = admit_tool(&raw, &[]).unwrap();
        let card = tool_card(&admitted, &[], &"hosted".into(), &"shared".into()).unwrap();
        assert_eq!(
            text_field(get(&card, "price").unwrap(), "amount"),
            &JsString::from("$2.5500")
        );

        let tiny =
            parse(r#"{"kind":"ai-tool-descriptor","id":"safe","billing":{"price_micros":-1}}"#);
        let admitted = admit_tool(&tiny, &[]).unwrap();
        let card = tool_card(&admitted, &[], &"hosted".into(), &"shared".into()).unwrap();
        assert_eq!(
            text_field(get(&card, "price").unwrap(), "amount"),
            &JsString::from("$-0.0000")
        );
    }

    #[test]
    fn billing_price_uses_javascript_numeric_coercion() {
        assert_eq!(
            js_number(&Value::String(JsString::from(" 2550000\u{00a0}"))).unwrap(),
            2_550_000.0
        );
        assert_eq!(
            js_number(&Value::String(JsString::from("0x10"))).unwrap(),
            16.0
        );
        assert_eq!(js_number(&Value::Null).unwrap(), 0.0);
        assert_eq!(js_number(&Value::Bool(true)).unwrap(), 1.0);
        assert_eq!(js_number(&Value::Bool(false)).unwrap(), 0.0);
        assert!(js_number(&Value::String(JsString::from("not-a-number")))
            .unwrap()
            .is_nan());
        assert_eq!(
            js_number(&Value::Array(vec![Value::Number(16.0)])).unwrap(),
            16.0
        );
        assert!(
            js_number(&Value::Array(vec![Value::Number(1.0), Value::Number(2.0)]))
                .unwrap()
                .is_nan()
        );
        assert!(js_number(&parse(r#"{"toString":null}"#)).is_err());
    }

    #[test]
    fn billing_card_renames_payers_and_source_measurement() {
        let raw = parse(
            r#"{"kind":"ai-tool-descriptor","id":"safe","billing":{"payers":["maker","account"],"measured_by_source":"meter"}}"#,
        );
        let admitted = admit_tool(&raw, &[]).unwrap();
        let card = tool_card(&admitted, &[], &"hosted".into(), &"shared".into()).unwrap();
        let payers = parse(r#"["maker","account"]"#);
        assert_eq!(get(&card, "who_can_pay"), Some(&payers));
        assert_eq!(
            get(&card, "measured_by_its_source"),
            Some(&Value::String(JsString::from("meter")))
        );
        assert!(get(&card, "payers").is_none());
        assert!(get(&card, "measured_by_source").is_none());
    }

    #[test]
    fn credential_shape_case_checks_preserve_utf16_and_contiguous_token_rules() {
        assert!(starts_ascii_case(
            JsString::from("bEaReR").units(),
            b"BEARER"
        ));
        assert!(starts_ascii_case(JsString::from("basic").units(), b"Basic"));
        // Separate short words do not satisfy the original consecutive-byte
        // token length; the description remains a permitted ordinary value.
        assert!(!secret_value(&JsString::from("Bearer abcd efgh")));
        assert!(!secret_value(&JsString::from("Basic abcdefg trailing")));
        assert_eq!(ascii_lower(0xD800), 0xD800);
        assert_eq!(ascii_lower(0x212A), 0x212A);
    }

    #[test]
    fn descriptor_conditions_keep_distinct_causes_through_the_shared_invalid_helper() {
        let absent_kind = admit_tool(&parse("{}"), &[]).err().unwrap();
        let absent_id = admit_tool(&parse(r#"{"kind":"ai-tool-descriptor"}"#), &[]).err().unwrap();
        assert!(matches!(absent_kind, Failure::Invalid(_, _)));
        assert!(matches!(absent_id, Failure::Invalid(_, _)));
        assert_ne!(absent_kind.cause(), absent_id.cause());
        for refused in [absent_kind, absent_id] {
            assert_eq!(refused.cause().file(), "src/workspace_tool_screens/catalog.rs");
            let source = include_str!("catalog.rs");
            let factory = source.find(concat!("crate::cause!(", "caller_site: invalid_tool_descriptor)")).unwrap();
            let prefix = &source[..factory];
            let factory_line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
            let factory_column = prefix.rsplit('\n').next().unwrap().chars().count() + 1;
            assert_eq!(refused.cause().condition(), format!("invalid_tool_descriptor via {}:{factory_line}:{factory_column}",
                module_path!().strip_suffix("::tests").unwrap()));
            let source_line = include_str!("catalog.rs").lines().nth(refused.cause().line() as usize - 1).unwrap();
            assert!(source_line.contains("invalid("));
        }
    }

}
