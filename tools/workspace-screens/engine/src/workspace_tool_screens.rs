// src/workspace_tool_screens.rs
//
// Purpose: Project actually admitted tool cards into the original shared tool-screen DATA.
// Non-Negotiable Invariants: Raw current descriptors confer no offer or execution right; retain physical cursors, original catalog admission and selected current authority.
// Key Concepts: Original toolSurfaces/replacing/titleOf, pinned shared DATA, bounded physical pages and explicit deployed-placement/locale supplies.
// Security Considerations: No raw HTML, new screen layout, secret-value fallback, source execution, arbitrary account source or remote effect.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod catalog;

use crate::{
    ecma_json::{self as json, JsString, Object, Value},
    record_source::BoundedRecordSql,
    tool_fact_page,
};
use content_crypto::advanced::blake3;
use catalog::AdmittedTool;
pub use catalog::Placement;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum Failure {
    Invalid(&'static str, crate::refusal_cause::Cause),
    SecretValue(crate::refusal_cause::Cause),
    UnknownPlacement(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Integrity(crate::refusal_cause::Cause),
    Cancelled(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Physical(tool_fact_page::Failure, crate::refusal_cause::Cause),
}
impl Failure {
    /// The source condition carried through catalog and projection adapters.
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Bounds(cause) => cause,
            Self::Cancelled(cause) => cause,
            Self::Integrity(cause) => cause,
            Self::SecretValue(cause) => cause,
            Self::Source(cause) => cause,
            Self::UnknownPlacement(cause) => cause,
            Self::Invalid(_, cause) => cause,
            Self::Physical(_, cause) => cause,
        }
    }
}
crate::impl_caused!(Failure);

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let words = match self {
            Self::Invalid(_, _) => "Tool screen input is invalid",
            Self::SecretValue(_) => "Tool descriptor contains a secret value",
            Self::UnknownPlacement(_) => "Tool descriptor has no current deployed placement",
            Self::Bounds(_) => "Tool screen projection exceeds its bound",
            Self::Integrity(_) => "Tool screen program DATA differs",
            Self::Cancelled(_) => "Tool screen projection was cancelled",
            Self::Source(_) => "Current tool screen authority is unavailable",
            Self::Physical(_, _) => "Original tool page could not be read",
        };
        write!(f, "{words}; cause={}", self.cause())
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub cards: usize,
    pub shipped: usize,
    pub program_bytes: usize,
    /// The shared catalog's bytes are bounded as the catalog reader admitted them (tools_catalog `max_source_bytes`),
    /// not by the surfaces' and looks' program bound: an installed Workshop's rows were 3,076,761 bytes on Nov 13 2026
    /// (commit 7588b8c8, 669 rows), past the 2 MiB program bound, so its tool screens answered 413.
    pub catalog_bytes: usize,
    pub output_bytes: usize,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            cards: 4096,
            shipped: 2048,
            program_bytes: 2 * 1024 * 1024,
            catalog_bytes: crate::tools_catalog::Limits::default().max_source_bytes,
            output_bytes: 16 * 1024 * 1024,
            elapsed: Duration::from_secs(2),
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<(), Failure> {
        if self.cards > 16384
            || self.shipped > 16384
            || self.program_bytes > json::HARD_BYTES
            || self.catalog_bytes > json::HARD_BYTES
            || self.output_bytes > json::HARD_BYTES
            || self.output_bytes < 2
            || self.elapsed.is_zero()
            || self.elapsed > Duration::from_secs(30)
        {
            return Err(crate::cause!(Failure::Bounds));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default)]
pub struct Work {
    pub cards_seen: usize,
    pub surfaces: usize,
    pub refused_descriptors: usize,
    pub skipped_rows: usize,
    pub label_comparisons: usize,
    pub output_bytes: usize,
}

fn codec_limits(bytes: usize) -> json::Limits {
    json::Limits {
        input_bytes: bytes,
        output_bytes: bytes,
        depth: json::HARD_DEPTH,
        nodes: json::HARD_NODES,
        string_units: bytes,
        total_string_units: bytes,
        container_entries: json::HARD_NODES,
        number_bytes: json::HARD_NUMBER_BYTES,
    }
}
fn get<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(value) => value.get(&name.into()),
        _ => None,
    }
}
fn text(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}
fn string(value: &str) -> Value {
    Value::String(value.into())
}
fn object(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut value = Object::new();
    for (name, item) in entries {
        value.insert(name.into(), item);
    }
    Value::Object(value)
}
fn eq_text(value: Option<&Value>, expected: &str) -> bool {
    value
        .and_then(text)
        .is_some_and(|value| value.units() == JsString::from(expected).units())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => *v != 0.0 && !v.is_nan(),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn nullish<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Option<&'a Value> {
    values
        .into_iter()
        .flatten()
        .find(|value| !matches!(value, Value::Null))
}
fn js_space(value: u16) -> bool {
    matches!(value,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn trim(value: &JsString) -> JsString {
    let units = value.units();
    let first = units
        .iter()
        .position(|v| !js_space(*v))
        .unwrap_or(units.len());
    let last = units
        .iter()
        .rposition(|v| !js_space(*v))
        .map(|at| at + 1)
        .unwrap_or(first);
    JsString::from_units(units[first..last].to_vec())
}
fn capital(value: &JsString) -> JsString {
    let Some(&first) = value.units().first() else {
        return value.clone();
    };
    let mut out = if let Some(character) = char::from_u32(u32::from(first)) {
        character
            .to_uppercase()
            .collect::<String>()
            .encode_utf16()
            .collect::<Vec<_>>()
    } else {
        vec![first]
    };
    out.extend_from_slice(&value.units()[1..]);
    JsString::from_units(out)
}
fn lower(value: &JsString) -> JsString {
    let mut out = Vec::new();
    let mut chunk = Vec::new();
    let flush = |chunk: &mut Vec<u16>, out: &mut Vec<u16>| {
        if !chunk.is_empty() {
            let valid = String::from_utf16(chunk).expect("scalar chunk");
            out.extend(valid.to_lowercase().encode_utf16());
            chunk.clear();
        }
    };
    let mut at = 0;
    while at < value.len() {
        let unit = value.units()[at];
        if (0xd800..=0xdbff).contains(&unit)
            && value
                .units()
                .get(at + 1)
                .is_some_and(|v| (0xdc00..=0xdfff).contains(v))
        {
            chunk.push(unit);
            chunk.push(value.units()[at + 1]);
            at += 2;
        } else if (0xd800..=0xdfff).contains(&unit) {
            flush(&mut chunk, &mut out);
            out.push(unit);
            at += 1;
        } else {
            chunk.push(unit);
            at += 1;
        }
    }
    flush(&mut chunk, &mut out);
    JsString::from_units(out)
}
fn words(value: &JsString) -> JsString {
    let mut out = Vec::new();
    for unit in value.units() {
        let unit = if matches!(*unit, 45 | 95) || js_space(*unit) {
            32
        } else {
            *unit
        };
        if unit != 32 || out.last().is_some_and(|v| *v != 32) {
            out.push(unit);
        }
    }
    while out.last() == Some(&32) {
        out.pop();
    }
    capital(&lower(&JsString::from_units(out)))
}
fn id_like(value: &JsString) -> bool {
    if value.units().iter().any(|v| js_space(*v)) {
        return false;
    }
    if value.units().iter().any(|v| matches!(*v, 95 | 58 | 47)) {
        return true;
    }
    let mut has_dash = false;
    let mut previous_dash = true;
    for unit in value.units() {
        if *unit == 45 {
            if previous_dash {
                return false;
            }
            has_dash = true;
            previous_dash = true;
        } else if (97..=122).contains(unit) || (48..=57).contains(unit) {
            previous_dash = false;
        } else {
            return false;
        }
    }
    has_dash && !previous_dash
}
fn js_string(value: &Value, limit: usize) -> Result<JsString, Failure> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::String(value) => value.clone(),
        Value::Number(value) if value.is_nan() => "NaN".into(),
        Value::Number(value) if value.is_infinite() => {
            if value.is_sign_negative() {
                "-Infinity".into()
            } else {
                "Infinity".into()
            }
        }
        Value::Number(_) => json::stringify(value, codec_limits(limit))
            .map_err(|error| crate::carry_cause!(Failure::Bounds, error))?
            .into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => {
            let mut out = Vec::new();
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(44);
                }
                if !matches!(item, Value::Null) {
                    out.extend_from_slice(js_string(item, limit)?.units());
                }
                if out.len() > limit {
                    return Err(crate::cause!(Failure::Bounds));
                }
            }
            JsString::from_units(out)
        }
    })
}

/// Original titleOf result. Values remain UTF-16; a route's later URI encoding
/// may refuse a lone surrogate without replacing a label or whole JSON body.
pub struct Title {
    pub title: JsString,
    pub service: Option<JsString>,
}
pub fn title_of(card: &Value) -> Result<Title, Failure> {
    for field in ["title", "name", "label"] {
        if let Some(value) = get(card, field).and_then(text) {
            let value = trim(value);
            if !value.is_empty() && !id_like(&value) {
                let first = value.units()[0];
                let second = value.units().get(1).copied();
                let title = if (97..=122).contains(&first)
                    && !second.is_some_and(|v| (65..=90).contains(&v))
                {
                    capital(&value)
                } else {
                    value
                };
                return Ok(Title {
                    title,
                    service: None,
                });
            }
        }
    }
    let empty = string("");
    let original = js_string(
        nullish([get(card, "tool_id"), get(card, "label")]).unwrap_or(&empty),
        4096,
    )?;
    let mut units = original.units();
    if let Some(colon) = units.iter().position(|v| *v == 58) {
        if colon > 0
            && units[..colon]
                .iter()
                .all(|v| (97..=122).contains(v) || *v == 45)
        {
            units = &units[colon + 1..];
        }
    }
    for (at, unit) in units.iter().enumerate() {
        if *unit != 45 {
            continue;
        }
        let suffix = &units[at + 1..];
        if let Some(underscore) = suffix.iter().position(|v| *v == 95) {
            if !suffix[..underscore].contains(&45)
                && !units
                    .iter()
                    .any(|v| matches!(*v, 10 | 13 | 0x2028 | 0x2029))
            {
                return Ok(Title {
                    title: words(&JsString::from_units(suffix.to_vec())),
                    service: Some(words(&JsString::from_units(units[..at].to_vec()))),
                });
            }
        }
    }
    Ok(Title {
        title: words(&JsString::from_units(units.to_vec())),
        service: None,
    })
}
fn encoded_id(id: &Value) -> Result<String, Failure> {
    let value = js_string(id, 4096)?;
    let mut units = value.units();
    if units.starts_with(&[116, 111, 111, 108, 58]) {
        units = &units[5..];
    }
    let text = String::from_utf16(units)
        .map_err(|_| Failure::Invalid("URI input contains a lone UTF-16 surrogate", crate::cause!()))?;
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(encoded)
}

/// Immutable DATA for the original generic projection, not an offer/execute grant.
pub struct ToolScreenProjection {
    shared_catalog: Option<SharedCatalog>,
    shipped: BTreeMap<JsString, Value>,
    icon: Value,
    surface_defaults: Value,
}
struct SharedCatalog {
    identity: String,
    payloads: Vec<Value>,
}
impl ToolScreenProjection {
    /// Bind the full effective shared catalog as an array of original payload
    /// rows. The current authority must independently acknowledge this identity
    /// as its selected catalog, including applicable Marketplace defaults. A
    /// pin establishes byte identity, not completeness or current selection.
    pub fn with_shared_catalog(
        mut self,
        bytes: &[u8],
        pin: &str,
        limits: &Limits,
    ) -> Result<Self, Failure> {
        limits.validate()?;
        if bytes.len() > limits.catalog_bytes {
            return Err(crate::cause!(Failure::Bounds));
        }
        if pin.len() != 64 || blake3::hash(bytes).to_hex().as_str() != pin {
            return Err(crate::cause!(Failure::Integrity));
        }
        let source = json::parse(bytes, codec_limits(limits.catalog_bytes))
            .map_err(|error| crate::carry_cause!(Failure::Integrity, error))?;
        let Value::Array(payloads) = source else {
            return Err(crate::cause!(Failure::Integrity));
        };
        if payloads.len() > limits.cards {
            return Err(crate::cause!(Failure::Bounds));
        }
        self.shared_catalog = Some(SharedCatalog {
            identity: pin.to_owned(),
            payloads,
        });
        Ok(self)
    }
    pub fn from_sources(
        surfaces: &[u8],
        surfaces_pin: &str,
        looks: &[u8],
        looks_pin: &str,
        limits: &Limits,
    ) -> Result<Self, Failure> {
        limits.validate()?;
        for (bytes, pin) in [(surfaces, surfaces_pin), (looks, looks_pin)] {
            if bytes.len() > limits.program_bytes {
                return Err(crate::cause!(Failure::Bounds));
            }
            if pin.len() != 64 || blake3::hash(bytes).to_hex().as_str() != pin {
                return Err(crate::cause!(Failure::Integrity));
            }
        }
        let data = json::parse(surfaces, codec_limits(limits.program_bytes))
            .map_err(|error| crate::carry_cause!(Failure::Integrity, error))?;
        let Value::Array(rows) = get(&data, "surfaces").ok_or(crate::cause!(Failure::Integrity))? else {
            return Err(crate::cause!(Failure::Integrity));
        };
        if rows.len() > limits.shipped {
            return Err(crate::cause!(Failure::Bounds));
        }
        let mut shipped = BTreeMap::new();
        for row in rows {
            let id = get(row, "id").and_then(text).ok_or(crate::cause!(Failure::Integrity))?;
            shipped.insert(id.clone(), row.clone());
        }
        let looks = json::parse(looks, codec_limits(limits.program_bytes))
            .map_err(|error| crate::carry_cause!(Failure::Integrity, error))?;
        // Mount identity belongs to the selected program DATA, not this
        // generic projector. A historical source without the template refuses.
        let surface_defaults = get(&looks, "tool_surface_defaults")
            .filter(|value| matches!(value, Value::Object(_)))
            .ok_or(crate::cause!(Failure::Integrity))?;
        let entry = get(surface_defaults, "package_entry")
            .filter(|value| matches!(value, Value::Object(_)))
            .ok_or(crate::cause!(Failure::Integrity))?;
        for field in ["package_name", "entry_name"] {
            if !get(entry, field)
                .and_then(text)
                .is_some_and(|value| !value.is_empty())
            {
                return Err(crate::cause!(Failure::Integrity));
            }
        }
        if !get(surface_defaults, "material_target")
            .and_then(text)
            .is_some_and(|value| !value.is_empty())
            || !matches!(get(surface_defaults, "placement_labels"), Some(Value::Array(labels))
                if !labels.is_empty() && labels.iter().all(|value| text(value).is_some_and(|value| !value.is_empty())))
        {
            return Err(crate::cause!(Failure::Integrity));
        }
        let surface_defaults = surface_defaults.clone();
        let icon = get(&looks, "screen_icon")
            .filter(|value| matches!(value, Value::String(_)))
            .cloned()
            .ok_or(crate::cause!(Failure::Integrity))?;
        Ok(Self {
            shipped,
            icon,
            surface_defaults,
            shared_catalog: None,
        })
    }
    fn surface(&self, card: &Value) -> Result<Option<Value>, Failure> {
        let Some(id) = get(card, "tool_id").filter(|v| truthy(v)) else {
            return Ok(None);
        };
        let screen = get(card, "screen");
        if !get(card, "next_call").is_some_and(truthy)
            && !screen.is_some_and(|v| matches!(v, Value::Object(_) | Value::Array(_)))
        {
            return Ok(None);
        }
        let route = format!("/use/{}", encoded_id(id)?);
        let id_text = js_string(id, 4096)?;
        let mut order = JsString::from("tool:").units().to_vec();
        order.extend_from_slice(id_text.units());
        let title = title_of(card)?.title;
        let source = object([("kind", string("tool")), ("tool_id", id.clone())]);
        let Value::Object(mut source) = source else {
            unreachable!()
        };
        if let Some(group) = screen
            .and_then(|v| get(v, "group"))
            .filter(|v| text(v).is_some_and(|v| !v.is_empty()))
        {
            source.insert("group".into(), group.clone());
        }
        let mut row = Object::new();
        for (key, value) in [
            ("id", id.clone()),
            ("surface_id", id.clone()),
            ("kind", string("placeable-surface")),
            (
                "label",
                nullish([screen.and_then(|v| get(v, "label"))])
                    .cloned()
                    .unwrap_or(Value::String(title)),
            ),
            (
                "icon",
                nullish([screen.and_then(|v| get(v, "icon"))])
                    .cloned()
                    .unwrap_or_else(|| self.icon.clone()),
            ),
            (
                "package_entry",
                get(&self.surface_defaults, "package_entry")
                    .ok_or(crate::cause!(Failure::Integrity))?
                    .clone(),
            ),
            ("surface_input", object([("tool_id", id.clone())])),
            ("route_paths", Value::Array(vec![string(&route)])),
            (
                "placement_labels",
                get(&self.surface_defaults, "placement_labels")
                    .ok_or(crate::cause!(Failure::Integrity))?
                    .clone(),
            ),
            (
                "placement_order_key",
                Value::String(JsString::from_units(order)),
            ),
            ("wrap_material", Value::Bool(false)),
            (
                "material_target",
                get(&self.surface_defaults, "material_target")
                    .ok_or(crate::cause!(Failure::Integrity))?
                    .clone(),
            ),
            (
                "description",
                nullish([
                    screen.and_then(|v| get(v, "about")),
                    get(card, "description"),
                    get(card, "job"),
                ])
                .cloned()
                .unwrap_or_else(|| string("")),
            ),
        ] {
            row.insert(key.into(), value);
        }
        if let Some(Value::Array(asked)) = screen
            .and_then(|v| get(v, "asked"))
            .filter(|v| matches!(v,Value::Array(v)if !v.is_empty()))
        {
            row.insert(
                "asked".into(),
                Value::Array(
                    asked
                        .iter()
                        .filter(|v| matches!(v, Value::String(_)))
                        .cloned()
                        .collect(),
                ),
            );
        }
        if let Some(listed) = get(card, "listed_on").filter(|v| truthy(v)) {
            row.insert("listed_on".into(), listed.clone());
        }
        if let Some(until) = screen
            .and_then(|v| get(v, "new_until"))
            .filter(|v| matches!(v, Value::String(_)))
        {
            row.insert("sidebar_new_until".into(), until.clone());
        }
        row.insert("source".into(), Value::Object(source));
        row.insert("actions".into(), Value::Array(vec![]));
        let replaced = screen
            .and_then(|v| get(v, "replaces"))
            .and_then(text)
            .and_then(|id| self.shipped.get(id));
        let Some(Value::Object(shipped)) = replaced else {
            return Ok(Some(Value::Object(row)));
        };
        let same = eq_text(screen.and_then(|v| get(v, "kind")), "app-entry")
            && screen.and_then(|v| get(v, "entry"))
                == shipped
                    .get(&"package_entry".into())
                    .and_then(|v| get(v, "entry_name"));
        let mount = if same { shipped } else { &row };
        let mut result = shipped.clone();
        for name in ["label", "icon", "description", "source"] {
            if let Some(value) = row.get(&name.into()) {
                result.insert(name.into(), value.clone());
            }
        }
        for name in ["package_entry", "material_target"] {
            if let Some(value) = mount.get(&name.into()) {
                result.insert(name.into(), value.clone());
            }
        }
        if let Some(value) = mount.get(&"surface_input".into()).filter(|v| truthy(v)) {
            result.insert("surface_input".into(), value.clone());
        }
        for name in ["asked", "listed_on", "sidebar_new_until"] {
            if let Some(value) = row.get(&name.into()).filter(|v| truthy(v)) {
                result.insert(name.into(), value.clone());
            }
        }
        let mut routes = Vec::new();
        let mut seen = BTreeSet::new();
        for paths in [
            shipped.get(&"route_paths".into()),
            row.get(&"route_paths".into()),
        ] {
            if let Some(Value::Array(paths)) = paths {
                for path in paths {
                    let path = text(path).ok_or(crate::cause!(Failure::Integrity))?;
                    if seen.insert(path.clone()) {
                        routes.push(Value::String(path.clone()));
                    }
                }
            }
        }
        result.insert("route_paths".into(), Value::Array(routes));
        Ok(Some(Value::Object(result)))
    }
    pub fn project_cards(
        &self,
        cards: &[Value],
        limits: &Limits,
        cancel: &AtomicBool,
    ) -> Result<(Vec<Value>, Work), Failure> {
        self.project_cards_at(cards, limits, cancel, Instant::now())
    }
    fn project_cards_at(
        &self,
        cards: &[Value],
        limits: &Limits,
        cancel: &AtomicBool,
        started: Instant,
    ) -> Result<(Vec<Value>, Work), Failure> {
        limits.validate()?;
        if cards.len() > limits.cards {
            return Err(crate::cause!(Failure::Bounds));
        }
        let mut work = Work {
            output_bytes: 2,
            ..Work::default()
        };
        let mut surfaces = Vec::new();
        for card in cards {
            check(cancel, started, limits)?;
            // Check existing value model limits before JS primitive coercion can
            // recurse through any externally supplied JSON-origin array ID.
            json::stringify(card, codec_limits(limits.output_bytes))
                .map_err(|error| crate::carry_cause!(Failure::Bounds, error))?;
            work.cards_seen += 1;
            if let Some(row) = self.surface(card)? {
                let bytes = json::stringify(&row, codec_limits(limits.output_bytes))
                    .map_err(|error| crate::carry_cause!(Failure::Bounds, error))?
                    .len();
                work.output_bytes = work
                    .output_bytes
                    .checked_add(bytes + usize::from(!surfaces.is_empty()))
                    .ok_or(crate::cause!(Failure::Bounds))?;
                if work.output_bytes > limits.output_bytes {
                    return Err(crate::cause!(Failure::Bounds));
                }
                surfaces.push(row);
                work.surfaces += 1;
            }
        }
        check(cancel, started, limits)?;
        Ok((surfaces, work))
    }
}

fn check(cancel: &AtomicBool, started: Instant, limits: &Limits) -> Result<(), Failure> {
    if cancel.load(AtomicOrdering::Acquire) {
        return Err(crate::cause!(Failure::Cancelled));
    }
    if started.elapsed() >= limits.elapsed {
        return Err(crate::cause!(Failure::Bounds));
    }
    Ok(())
}

/// Actual selected account/source/deployment owner. Public program DATA and raw
/// descriptor DTOs cannot implement this by themselves. The locale comparator
/// must match the original app's JavaScript localeCompare; no binary-order fallback.
pub trait CurrentToolScreenAuthority {
    fn assert_current(&mut self) -> Result<(), Failure>;
    /// Verify the supplied full effective catalog identity against the current
    /// selected program/default-row owner. Screen-only record subsets, old
    /// captures and absence of the defaults owner cannot count as completeness.
    fn assert_shared_catalog(&mut self, identity: &str) -> Result<(), Failure>;
    fn placements(&mut self) -> Result<Vec<Placement>, Failure>;
    fn compare_labels(&mut self, left: &JsString, right: &JsString) -> Result<Ordering, Failure>;
}

pub struct ToolScreenPage {
    pub surfaces: Vec<Value>,
    pub next: Option<String>,
    pub read_work: tool_fact_page::Work,
    pub projection_work: Work,
}
impl fmt::Debug for ToolScreenPage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolScreenPage")
            .field("surfaces", &self.surfaces.len())
            .field("has_next", &self.next.is_some())
            .finish()
    }
}

fn admitted(
    raw: &Value,
    placements: &[Placement],
    work: &mut Work,
) -> Result<Option<AdmittedTool>, Failure> {
    if !eq_text(get(raw, "kind"), "ai-tool-descriptor") {
        work.skipped_rows += 1;
        return Ok(None);
    }
    match catalog::admit_tool(raw, placements) {
        Ok(tool) => Ok(Some(tool)),
        Err(Failure::Invalid(_, _) | Failure::SecretValue(_) | Failure::UnknownPlacement(_)) => {
            work.refused_descriptors += 1;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
fn active(tool: &AdmittedTool) -> bool {
    get(tool.payload(), "status")
        .is_none_or(|value| matches!(value, Value::Null) || eq_text(Some(value), "active"))
}
fn label(tool: &AdmittedTool) -> &JsString {
    get(tool.payload(), "label")
        .and_then(text)
        .unwrap_or_else(|| tool.id())
}
fn ordered(
    mut tools: Vec<AdmittedTool>,
    authority: &mut impl CurrentToolScreenAuthority,
    work: &mut Work,
    cancel: &AtomicBool,
    started: Instant,
    limits: &Limits,
) -> Result<Vec<AdmittedTool>, Failure> {
    let mut order = (0..tools.len()).collect::<Vec<_>>();
    let mut width = 1;
    while width < order.len() {
        let mut merged = Vec::with_capacity(order.len());
        for start in (0..order.len()).step_by(width * 2) {
            let middle = (start + width).min(order.len());
            let end = (middle + width).min(order.len());
            let (mut left, mut right) = (start, middle);
            while left < middle && right < end {
                check(cancel, started, limits)?;
                work.label_comparisons += 1;
                if authority
                    .compare_labels(label(&tools[order[left]]), label(&tools[order[right]]))?
                    != Ordering::Greater
                {
                    merged.push(order[left]);
                    left += 1;
                } else {
                    merged.push(order[right]);
                    right += 1;
                }
            }
            merged.extend_from_slice(&order[left..middle]);
            merged.extend_from_slice(&order[right..end]);
        }
        order = merged;
        width = width.checked_mul(2).ok_or(crate::cause!(Failure::Bounds))?;
    }
    let mut slots = tools.drain(..).map(Some).collect::<Vec<_>>();
    Ok(order
        .into_iter()
        .map(|at| slots[at].take().expect("one index per tool"))
        .collect())
}

/// Read the real bounded current tool-fact page, admit through the actual pure
/// catalog, then project offered cards. The caller MUST finish its same retained
/// SnapshotRecordSql and recheck fresh rights before disclosing this provisional
/// result. Source/entitlement failure never returns a partial surface list.
pub fn read_tool_screen_page(
    source: &mut impl BoundedRecordSql,
    authority: &mut impl CurrentToolScreenAuthority,
    request: &tool_fact_page::PageRequest,
    read_limits: &tool_fact_page::Limits,
    projection: &ToolScreenProjection,
    host: &JsString,
    limits: &Limits,
    cancel: &AtomicBool,
) -> Result<ToolScreenPage, Failure> {
    limits.validate()?;
    let started = Instant::now();
    let shared_catalog = projection
        .shared_catalog
        .as_ref()
        .ok_or(crate::cause!(Failure::Integrity))?;
    check(cancel, started, limits)?;
    authority.assert_current()?;
    authority.assert_shared_catalog(&shared_catalog.identity)?;
    let placements = authority.placements()?;
    authority.assert_current()?;
    check(cancel, started, limits)?;
    // The physical reader must inherit the remaining outer budget; otherwise
    // a shorter projection deadline could still permit a full reader deadline.
    let mut physical_limits = read_limits.clone();
    physical_limits.elapsed = physical_limits.elapsed.min(
        limits
            .elapsed
            .checked_sub(started.elapsed())
            .ok_or(crate::cause!(Failure::Bounds))?,
    );
    let page = tool_fact_page::tool_values_page(source, request, &physical_limits, cancel)
        .map_err(|value| { let cause = value.cause(); Failure::Physical(value, cause) })?;
    authority.assert_current()?;
    check(cancel, started, limits)?;
    if shared_catalog
        .payloads
        .len()
        .saturating_add(page.rows.len())
        > limits.cards
    {
        return Err(crate::cause!(Failure::Bounds));
    }
    let mut work = Work::default();
    let mut shared = Vec::new();
    for raw in &shared_catalog.payloads {
        check(cancel, started, limits)?;
        if let Some(tool) = admitted(raw, &placements, &mut work)? {
            shared.push(tool);
        }
    }
    let shared_ids = shared
        .iter()
        .map(|tool| tool.id().clone())
        .collect::<BTreeSet<_>>();
    let mut saved = Vec::new();
    for row in &page.rows {
        check(cancel, started, limits)?;
        if eq_text(get(&row.value, "status"), "deleted")
            || get(&row.value, "id")
                .and_then(text)
                .is_some_and(|id| shared_ids.contains(id))
        {
            work.skipped_rows += 1;
            continue;
        }
        let mut raw = row.value.clone();
        if let Value::Object(value) = &mut raw {
            if value.get(&"listed_on".into()).is_none() {
                if let Some(saved) = value.get(&"saved_at".into()).cloned() {
                    value.insert("listed_on".into(), saved);
                }
            }
        }
        if let Some(tool) = admitted(&raw, &placements, &mut work)? {
            let screen = get(tool.payload(), "screen");
            // Original screenOnly admits only parts screens with no invoke.
            // Other screen objects can be shared program entries, but do not
            // make an arbitrary saved descriptor eligible for this page.
            let screen_only = get(tool.payload(), "invoke").is_none()
                && screen.is_some_and(|value| {
                    matches!(value, Value::Object(_)) && eq_text(get(value, "kind"), "parts")
                });
            if active(&tool) && (get(tool.payload(), "invoke").is_some() || screen_only) {
                saved.push(tool);
            }
        }
    }
    let shared = ordered(shared, authority, &mut work, cancel, started, limits)?;
    let saved = ordered(saved, authority, &mut work, cancel, started, limits)?;
    let mut cards = Vec::new();
    if request.after.is_empty() {
        for tool in shared {
            let screen = get(tool.payload(), "screen");
            if active(&tool)
                && (get(tool.payload(), "invoke").is_some()
                    || screen.is_some_and(|value| {
                        matches!(value, Value::Object(_))
                            && !matches!(get(value, "surface"), Some(Value::Object(_)))
                    }))
            {
                cards.push(catalog::tool_card(
                    &tool,
                    &placements,
                    host,
                    &"shared".into(),
                )?);
            }
        }
    }
    for tool in saved {
        cards.push(catalog::tool_card(
            &tool,
            &placements,
            host,
            &"this account".into(),
        )?);
    }
    let (surfaces, projected) = projection.project_cards_at(&cards, limits, cancel, started)?;
    work.cards_seen = projected.cards_seen;
    work.surfaces = projected.surfaces;
    work.output_bytes = projected.output_bytes;
    authority.assert_current()?;
    authority.assert_shared_catalog(&shared_catalog.identity)?;
    check(cancel, started, limits)?;
    Ok(ToolScreenPage {
        surfaces,
        next: page.next,
        read_work: page.work,
        projection_work: work,
    })
}
