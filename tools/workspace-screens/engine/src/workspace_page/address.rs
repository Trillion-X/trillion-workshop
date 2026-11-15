//! Resolve a browser path to one screen row in the captured, merged workspace DATA.
//!
//! Purpose: Preserve the current `screenAt` route behavior for a bounded Rust workspace adapter.
//! Non-Negotiable Invariants: A row is reachable only when present in the pinned DATA; exact/query-qualified routes precede prefixes; malformed routed encodings refuse.
//! Key Concepts: `route_paths`, `route_prefix`, `route_input`, `route_item_input`, and the row's `surface_input` / `package_entry` alias.
//! Security Considerations: Pin the supplied bytes, bound parsing and route inputs, and never infer a default screen catalogue.
//!
//! The workspace-page owner exports these selectors. The host owns redirects, sign-in and current offered rows
//! separately; `ScreenRequest` represents only an address that resolves to a workspace screen.

use crate::workspace::WorkspaceError;
use content_crypto::advanced::blake3;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_ROWS: usize = 2048;
const MAX_ROUTE_FIELDS: usize = 128;

/// A screen selected from the supplied, pinned merged screen DATA.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenRequest {
    pub entry: Option<String>,
    pub startup_screen: Option<String>,
    pub input: BTreeMap<String, String>,
}

/// A screen selected by the original MCP `screenFor` contract. A row may have
/// no browser address; callers must preserve that absence rather than invent one.
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenSelection {
    pub id: String,
    pub label: String,
    pub address: Option<String>,
    pub input: Map<String, Value>,
    pub whole: bool,
}

/// Only the whole-workspace policy comes from pinned screen-view DATA. Screen
/// rows remain in ScreenRoutes; this adds no second catalogue or route owner.
#[derive(Clone, Debug)]
pub struct ScreenSelectionPolicy {
    names: BTreeSet<String>,
    label: String,
    address: String,
}
impl ScreenSelectionPolicy {
    pub fn from_source(bytes: &[u8], pin: &str) -> Result<Self, WorkspaceError> {
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        if !valid_digest(pin) || blake3::hash(bytes).to_hex().as_str() != pin {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let data: Value = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let whole = data.get("whole").ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let names = whole
            .get("names")
            .and_then(Value::as_array)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if names.len() > MAX_ROUTE_FIELDS {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let names = names
            .iter()
            .map(|name| {
                name.as_str()
                    .map(str::to_lowercase)
                    .ok_or(crate::cause!(WorkspaceError::Integrity))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let label = whole
            .get("label")
            .and_then(Value::as_str)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .to_owned();
        let address = whole
            .get("address")
            .and_then(Value::as_str)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .to_owned();
        if label.is_empty()
            || label.len() > MAX_PATH_BYTES
            || address.len() > MAX_PATH_BYTES
            || !address.starts_with('/')
            || address.starts_with("//")
            || address.contains(['\\', '\r', '\n', '\0'])
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(Self {
            names,
            label,
            address,
        })
    }
}

/// Pinned workspace routes parsed from the actual merged `screens.mjs` DATA shape.
#[derive(Clone, Debug)]
pub struct ScreenRoutes {
    home_path: String,
    rows: Vec<Value>,
    application: Option<String>,
}

impl ScreenRoutes {
    /// Parse merged `{home_path, surfaces}` JSON only when its BLAKE3 pin matches.
    pub fn from_source(bytes: &[u8], pin: &str) -> Result<Self, WorkspaceError> {
        if bytes.len() > MAX_SOURCE_BYTES || !valid_digest(pin) {
            return Err(if bytes.len() > MAX_SOURCE_BYTES {
                crate::cause!(WorkspaceError::TooLarge)
            } else {
                crate::cause!(WorkspaceError::Invalid)
            });
        }
        if blake3::hash(bytes).to_hex().as_str() != pin {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let data: Value = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let home_path = data
            .get("home_path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty() && path.len() <= MAX_PATH_BYTES)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let rows = data
            .get("surfaces")
            .and_then(Value::as_array)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if rows.len() > MAX_ROWS {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        Ok(Self {
            home_path: home_path.to_owned(),
            rows: rows.clone(),
            application: data
                .get("address_label")
                .and_then(Value::as_str)
                .and_then(|label| label.rsplit("::").next())
                .filter(|name| !name.is_empty())
                .map(str::to_owned),
        })
    }

    /// Resolve the supplied path and query, preserving exact, query-qualified, then prefix precedence.
    /// `query` is the raw query string without its leading `?` (as with `Uri::query`).
    pub fn resolve(
        &self,
        path: &str,
        query: &str,
    ) -> Result<Option<ScreenRequest>, WorkspaceError> {
        if path.len() > MAX_PATH_BYTES
            || query.len() > MAX_QUERY_BYTES
            || !path.starts_with('/')
            || path.contains(['?', '#'])
        {
            return Err(
                if path.len() > MAX_PATH_BYTES || query.len() > MAX_QUERY_BYTES {
                    crate::cause!(WorkspaceError::TooLarge)
                } else {
                    crate::cause!(WorkspaceError::Invalid)
                },
            );
        }
        let query_pairs = parse_query(query)?;
        if let Some((row, input)) = self.match_route(path, &query_pairs, false)? {
            return Ok(Some(request_for(row, input)));
        }

        // The home address first uses an explicitly routed row. Otherwise the page's ordinary startup DATA owns its
        // starting screens; this resolver represents that address without inventing a particular screen row.
        if path == self.home_path {
            return Ok(Some(ScreenRequest {
                entry: None,
                startup_screen: None,
                input: BTreeMap::new(),
            }));
        }
        Ok(None)
    }

    /// Original screenFor selection over the same pinned rows as resolve().
    /// Addresses accept ordinary local browser paths. Network authorities,
    /// backslashes and control characters explicitly refuse; this bounded
    /// adapter does not claim to implement the full WHATWG URL parser.
    pub fn screen_for(
        &self,
        asked: &str,
        input: &Map<String, Value>,
        policy: &ScreenSelectionPolicy,
    ) -> Result<Option<ScreenSelection>, WorkspaceError> {
        let text = asked.trim_matches(|character: char| {
            u16::try_from(character as u32)
                .is_ok_and(crate::workspace_tool_screens::catalog::js_space)
        });
        if text.len() > MAX_PATH_BYTES + MAX_QUERY_BYTES {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        if text.is_empty() {
            return Ok(None);
        }
        let app = self
            .application
            .as_deref()
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let lower = text.to_lowercase();
        if policy.names.contains(&lower) {
            return Ok(Some(ScreenSelection {
                id: format!("{app}.workspace"),
                label: policy.label.clone(),
                address: Some(policy.address.clone()),
                input: input.clone(),
                whole: true,
            }));
        }
        let opened = if text.starts_with('/') {
            Some(local_address(text)?)
        } else {
            None
        };
        let tool_path = text
            .strip_prefix("tool:")
            .map(|_| format!("/use/{}", encode_component(text)));
        let path = opened
            .as_ref()
            .map(|(path, _)| path.as_str())
            .or(tool_path.as_deref());
        let query = opened
            .as_ref()
            .map(|(_, query)| query.as_str())
            .unwrap_or("");
        let query_pairs = parse_query_mode(query, true)?;
        let routed = path
            .map(|path| self.match_route(path, &query_pairs, true))
            .transpose()?
            .flatten();
        let row = routed.as_ref().map(|(row, _)| *row).or_else(|| {
            self.rows.iter().find(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == text || id == format!("{app}.{text}"))
                    || row
                        .get("label")
                        .and_then(Value::as_str)
                        .is_some_and(|label| label.to_lowercase() == lower)
            })
        });
        let Some(row) = row else {
            return Ok(None);
        };
        let mut given = Map::new();
        if let Some((_, path_input)) = routed {
            let fixed = row.get("surface_input").and_then(Value::as_object);
            let mut mapped = BTreeSet::new();
            for item in &self.rows {
                if let Some(fields) = item.get("route_query").and_then(Value::as_object) {
                    mapped.extend(fields.keys().map(String::as_str));
                }
            }
            if let Some(fields) = row.get("route_query_on_path").and_then(Value::as_object) {
                mapped.extend(fields.keys().map(String::as_str));
            }
            for (name, value) in &query_pairs {
                if !normal_json_object_has(fixed, name) && !mapped.contains(name.as_str()) {
                    given.insert(name.clone(), Value::String(value.clone()));
                }
            }
            given.extend(
                path_input
                    .into_iter()
                    .map(|(key, value)| (key, Value::String(value))),
            );
            overlay_mapped(&mut given, row.get("route_query_on_path"), &query_pairs)?;
            // screensAtAddress finds the first query request with the path row's
            // id, even when supplied DATA contains another row with that id.
            let id = row.get("id");
            for other in &self.rows {
                if other.get("id") != id {
                    continue;
                }
                let mut own = Map::new();
                overlay_mapped(&mut own, other.get("route_query"), &query_pairs)?;
                if !own.is_empty() {
                    given.extend(own);
                    break;
                }
            }
        }
        // screenFor applies on-path fields once more after screenOfAddress.
        overlay_mapped(&mut given, row.get("route_query_on_path"), &query_pairs)?;
        given.extend(input.clone());
        let address = if let Some((path, query)) = opened {
            Some(if query.is_empty() {
                path
            } else {
                format!("{path}?{query}")
            })
        } else if let (Some(prefix), Some(name)) = (
            row.get("route_prefix").and_then(Value::as_str),
            row.get("route_input").and_then(Value::as_str),
        ) {
            given
                .get(name)
                .and_then(Value::as_str)
                .map(|value| format!("{prefix}{}", encode_component(value)))
                .or_else(|| strings(row.get("route_paths")).next().map(str::to_owned))
        } else {
            strings(row.get("route_paths")).next().map(str::to_owned)
        };
        Ok(Some(ScreenSelection {
            id: row
                .get("id")
                .and_then(Value::as_str)
                .ok_or(crate::cause!(WorkspaceError::Integrity))?
                .to_owned(),
            label: row
                .get("label")
                .and_then(Value::as_str)
                .ok_or(crate::cause!(WorkspaceError::Integrity))?
                .to_owned(),
            address,
            input: given,
            whole: false,
        }))
    }

    fn match_route<'a>(
        &'a self,
        path: &str,
        query_pairs: &[(String, String)],
        browser_query: bool,
    ) -> Result<Option<(&'a Value, BTreeMap<String, String>)>, WorkspaceError> {
        // Query-qualified aliases are DATA addresses. The most specific matching alias wins; ties retain row order.
        let mut best: Option<(&Value, usize)> = None;
        for row in &self.rows {
            for address in strings(row.get("route_paths")) {
                let Some((address_path, required_query)) = address.split_once('?') else {
                    continue;
                };
                if address_path != path {
                    continue;
                }
                let required = parse_query_mode(required_query, browser_query)?;
                if required.is_empty() || required.len() > MAX_ROUTE_FIELDS {
                    continue;
                }
                if required.iter().all(|(name, value)| {
                    query_pairs
                        .iter()
                        .find(|(key, _)| key == name)
                        .is_some_and(|(_, actual)| actual == value)
                }) && best.map_or(true, |(_, specificity)| required.len() > specificity)
                {
                    best = Some((row, required.len()));
                }
            }
        }
        if let Some((row, _)) = best {
            return Ok(Some((row, BTreeMap::new())));
        }

        // An exact address wins over any prefix it also falls under.
        if let Some(row) = self
            .rows
            .iter()
            .find(|row| strings(row.get("route_paths")).any(|route| route == path))
        {
            return Ok(Some((row, BTreeMap::new())));
        }

        for row in &self.rows {
            let Some(prefix) = row.get("route_prefix").and_then(Value::as_str) else {
                continue;
            };
            let Some(route_input) = row.get("route_input").and_then(Value::as_str) else {
                continue;
            };
            if prefix.is_empty() || !path.starts_with(prefix) {
                continue;
            }
            let rest = &path[prefix.len()..];
            let mut segments = rest.split('/');
            let first_raw = segments.next().unwrap_or_default();
            let item = segments.next();
            if first_raw.is_empty() || segments.next().is_some() || item.is_some_and(str::is_empty)
            {
                continue;
            }
            if item.is_some()
                && row
                    .get("route_item_input")
                    .and_then(Value::as_str)
                    .is_none()
            {
                continue;
            }
            let first = decode_path_segment(first_raw)?;
            let mut route_values = BTreeMap::new();
            route_values.insert(route_input.to_owned(), first.clone());
            let item_values = match item {
                Some(item) => {
                    let name = row
                        .get("route_item_input")
                        .and_then(Value::as_str)
                        .ok_or(crate::cause!(WorkspaceError::Integrity))?;
                    BTreeMap::from([(name.to_owned(), decode_path_segment(item)?)])
                }
                None => BTreeMap::new(),
            };

            // Some rows are the specific DATA row for this route's own input (for example, one tool's screen).
            // The matched row owns the route input in `surface_input`; only a nested item remains as request input.
            if let Some(own) = self.rows.iter().find(|other| {
                is_own_route_alias(other, row, prefix, first_raw, &first, route_input)
            }) {
                return Ok(Some((own, item_values)));
            }
            route_values.extend(item_values);
            return Ok(Some((row, route_values)));
        }

        Ok(None)
    }
}

/// `name in fixed` in the original addresses.mjs includes the standard
/// Object.prototype properties of normal JSON.parse objects (and `{}` when
/// surface_input is absent). Keep this local to that exact filter; these names
/// remain legal own keys in explicit input, applied by object spread later.
/// Custom/replaced prototypes and host mutations are outside the pinned JSON
/// DATA contract; this is not a general JavaScript property evaluator.
fn normal_json_object_has(object: Option<&Map<String, Value>>, name: &str) -> bool {
    object.is_some_and(|object| object.contains_key(name))
        || matches!(
            name,
            "constructor"
                | "__defineGetter__"
                | "__defineSetter__"
                | "hasOwnProperty"
                | "__lookupGetter__"
                | "__lookupSetter__"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "toString"
                | "valueOf"
                | "__proto__"
                | "toLocaleString"
        )
}

fn overlay_mapped(
    input: &mut Map<String, Value>,
    fields: Option<&Value>,
    query: &[(String, String)],
) -> Result<(), WorkspaceError> {
    let Some(fields) = fields.and_then(Value::as_object) else {
        return Ok(());
    };
    for (field, name) in fields {
        let name = name.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if let Some((_, value)) = query.iter().find(|(key, _)| key == field) {
            if !value.is_empty() {
                input.insert(name.to_owned(), Value::String(value.clone()));
            }
        }
    }
    Ok(())
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn local_address(text: &str) -> Result<(String, String), WorkspaceError> {
    if text.starts_with("//") || text.contains('\\') || text.chars().any(char::is_control) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let text = text.split('#').next().unwrap_or(text);
    let (path, query) = text.split_once('?').unwrap_or((text, ""));
    if path.len() > MAX_PATH_BYTES || query.len() > MAX_QUERY_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    fn escaped(value: &str, query: bool) -> String {
        let mut out = String::new();
        for byte in value.bytes() {
            let encode = !byte.is_ascii()
                || byte <= b' '
                || b"\"<>".contains(&byte)
                || (!query && byte == b'`')
                || (!query && b"{}".contains(&byte))
                || (query && byte == b'\'');
            if encode {
                out.push_str(&format!("%{byte:02X}"));
            } else {
                out.push(byte as char);
            }
        }
        out
    }
    let path = escaped(path, false);
    let mut segments = Vec::new();
    let mut trailing = path.ends_with('/');
    let raw_segments: Vec<_> = path.split('/').skip(1).collect();
    for (at, segment) in raw_segments.iter().enumerate() {
        let dots = segment.to_ascii_lowercase().replace("%2e", ".");
        if dots == "." {
            if at + 1 == raw_segments.len() {
                trailing = true;
            }
            continue;
        }
        if dots == ".." {
            segments.pop();
            if at + 1 == raw_segments.len() {
                trailing = true;
            }
            continue;
        }
        segments.push(*segment);
    }
    let mut normalized = format!("/{}", segments.join("/"));
    if trailing && !normalized.ends_with('/') {
        normalized.push('/');
    }
    Ok((normalized, escaped(query, true)))
}

fn request_for(row: &Value, input: BTreeMap<String, String>) -> ScreenRequest {
    ScreenRequest {
        entry: row
            .pointer("/package_entry/entry_name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        startup_screen: row
            .pointer("/surface_input/screen")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                row.pointer("/package_entry/entry_name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }),
        input,
    }
}

fn is_own_route_alias(
    other: &Value,
    row: &Value,
    prefix: &str,
    raw_first: &str,
    first: &str,
    route_input: &str,
) -> bool {
    if std::ptr::eq(other, row) {
        return false;
    }
    if strings(other.get("route_paths")).any(|path| path == format!("{prefix}{raw_first}")) {
        return true;
    }
    let other_entry = other
        .pointer("/package_entry/entry_name")
        .and_then(Value::as_str);
    let row_entry = row
        .pointer("/package_entry/entry_name")
        .and_then(Value::as_str);
    if other_entry != row_entry {
        return false;
    }
    other
        .pointer(&format!("/surface_input/{}", escape_pointer(route_input)))
        .and_then(Value::as_str)
        == Some(first)
}

fn strings(value: Option<&Value>) -> impl Iterator<Item = &str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn valid_digest(pin: &str) -> bool {
    pin.len() == 64
        && pin
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn parse_query(query: &str) -> Result<Vec<(String, String)>, WorkspaceError> {
    parse_query_mode(query, false)
}

fn parse_query_mode(
    query: &str,
    browser_query: bool,
) -> Result<Vec<(String, String)>, WorkspaceError> {
    if query.len() > MAX_QUERY_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let mut pairs = Vec::new();
    for field in query
        .strip_prefix('?')
        .unwrap_or(query)
        .split('&')
        .filter(|part| !part.is_empty())
    {
        if pairs.len() >= MAX_ROUTE_FIELDS {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let (name, value) = field.split_once('=').unwrap_or((field, ""));
        pairs.push((
            decode_query_component(name, browser_query)?,
            decode_query_component(value, browser_query)?,
        ));
    }
    Ok(pairs)
}

fn decode_query_component(value: &str, browser_query: bool) -> Result<String, WorkspaceError> {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut at = 0;
    while at < raw.len() {
        match raw[at] {
            b'+' => {
                bytes.push(b' ');
                at += 1;
            }
            b'%' => {
                let decoded = raw
                    .get(at + 1..at + 3)
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                match decoded {
                    Some(byte) => {
                        bytes.push(byte);
                        at += 3;
                    }
                    None if browser_query => {
                        bytes.push(b'%');
                        at += 1;
                    }
                    None => return Err(crate::cause!(WorkspaceError::Invalid)),
                }
            }
            byte => {
                bytes.push(byte);
                at += 1;
            }
        }
    }
    if browser_query {
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        String::from_utf8(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
    }
}

fn decode_path_segment(value: &str) -> Result<String, WorkspaceError> {
    if value.len() > MAX_PATH_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut at = 0;
    while at < raw.len() {
        if raw[at] == b'%' {
            let hex = raw.get(at + 1..at + 3).ok_or(crate::cause!(WorkspaceError::Invalid))?;
            let text = std::str::from_utf8(hex).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            bytes.push(u8::from_str_radix(text, 16).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
            at += 3;
        } else {
            bytes.push(raw[at]);
            at += 1;
        }
    }
    // Original screenAt splits raw path segments before decodeURIComponent.
    // An encoded separator is therefore INPUT data, not a new route segment or
    // filesystem path. StartupContract encodes it again when building a read.
    String::from_utf8(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes(data: &str) -> ScreenRoutes {
        let pin = blake3::hash(data.as_bytes()).to_hex().to_string();
        ScreenRoutes::from_source(data.as_bytes(), &pin).expect("fixture DATA is pinned")
    }

    #[test]
    fn exact_routes_beat_prefixes_and_derive_screen_from_row_data() {
        let routes = routes(
            r#"{"home_path":"/","surfaces":[
            {"route_prefix":"/use/","route_input":"tool_id","package_entry":{"entry_name":"tool-screen"}},
            {"route_paths":["/use/ordinary"],"surface_input":{"screen":"custom"},"package_entry":{"entry_name":"guide"}}
        ]}"#,
        );
        let exact = routes.resolve("/use/ordinary", "").unwrap().unwrap();
        assert_eq!(exact.entry.as_deref(), Some("guide"));
        assert_eq!(exact.startup_screen.as_deref(), Some("custom"));
        let prefix = routes.resolve("/use/tool", "").unwrap().unwrap();
        assert_eq!(
            prefix.input.get("tool_id").map(String::as_str),
            Some("tool")
        );
    }

    #[test]
    fn query_alias_most_specific_match_wins() {
        let routes = routes(
            r#"{"home_path":"/","surfaces":[
            {"route_paths":["/x?mode=one"],"package_entry":{"entry_name":"one"}},
            {"route_paths":["/x?mode=one&view=two"],"package_entry":{"entry_name":"two"}}
        ]}"#,
        );
        assert_eq!(
            routes
                .resolve("/x", "mode=one&view=two")
                .unwrap()
                .unwrap()
                .entry
                .as_deref(),
            Some("two")
        );
        assert_eq!(
            routes
                .resolve("/x", "mode=one")
                .unwrap()
                .unwrap()
                .entry
                .as_deref(),
            Some("one")
        );
    }

    #[test]
    fn prefix_item_and_own_row_alias_keep_only_nested_item_input() {
        let routes = routes(
            r#"{"home_path":"/","surfaces":[
            {"route_prefix":"/use/","route_input":"tool_id","route_item_input":"post_id","package_entry":{"entry_name":"tool-screen"}},
            {"surface_input":{"tool_id":"alpha"},"package_entry":{"entry_name":"tool-screen"}}
        ]}"#,
        );
        let result = routes
            .resolve("/use/alpha/post%2Done", "")
            .unwrap()
            .unwrap();
        assert_eq!(result.entry.as_deref(), Some("tool-screen"));
        assert_eq!(
            result.input.get("post_id").map(String::as_str),
            Some("post-one")
        );
        assert!(!result.input.contains_key("tool_id"));
    }

    #[test]
    fn malformed_segments_refuse_and_home_fallback_has_no_invented_screen() {
        let routes = routes(
            r#"{"home_path":"/","surfaces":[{"route_prefix":"/p/","route_input":"id","package_entry":{"entry_name":"item"}}]}"#,
        );
        for value in ["/p/%", "/p/%GG", "/p/%FF"] {
            assert!(matches!(
                routes.resolve(value, ""),
                Err(WorkspaceError::Invalid(_))
            ));
        }
        assert_eq!(
            routes.resolve("/p/%2F", "").unwrap().unwrap().input["id"],
            "/"
        );
        assert_eq!(
            routes.resolve("/p/a%5Cb", "").unwrap().unwrap().input["id"],
            "a\\b"
        );
        assert_eq!(
            routes.resolve("/p/%252F", "").unwrap().unwrap().input["id"],
            "%2F"
        );
        let home = routes.resolve("/", "").unwrap().unwrap();
        assert_eq!(home.entry, None);
        assert_eq!(home.startup_screen, None);
        assert!(home.input.is_empty());
        assert_eq!(routes.resolve("/unknown", "").unwrap(), None);
    }

    #[test]
    fn source_pin_is_required() {
        let data = br#"{"home_path":"/","surfaces":[]}"#;
        assert!(matches!(
            ScreenRoutes::from_source(data, &"0".repeat(64)),
            Err(WorkspaceError::Integrity(_))
        ));
    }

    fn selection_fixture() -> (ScreenRoutes, ScreenSelectionPolicy) {
        let routes = routes(
            r#"{"address_label":"placeable-surface-list::example","home_path":"/","surfaces":[
            {"id":"example.list","label":"Lists","route_prefix":"/lists/","route_input":"id","route_query":{"pick":"selected"},"route_query_on_path":{"view":"view_id"},"surface_input":{"screen":"list"}},
            {"id":"example.record","label":"Record","route_paths":["/record"],"route_query":{"meeting":"meeting_id"}},
            {"id":"example.tool","label":"Tool","route_prefix":"/use/","route_input":"tool_id","route_item_input":"item_id","package_entry":{"entry_name":"tool-screen"}},
            {"id":"example.own","label":"Posts","route_paths":["/use/tool%3Aposts"],"surface_input":{"tool_id":"tool:posts"},"package_entry":{"entry_name":"tool-screen"}},
            {"id":"example.guide","label":"Guide","route_paths":["/guide"]},
            {"id":"example.files","label":"Files","route_paths":["/files"]},
            {"id":"example.qualified","label":"Specific","route_paths":["/guide?mode=specific"]},
            {"id":"example.missing-address","label":"No address"}
        ]}"#,
        );
        let bytes = br#"{"whole":{"names":["Everything","/"],"label":"All work","address":"/"}}"#;
        let policy =
            ScreenSelectionPolicy::from_source(bytes, &blake3::hash(bytes).to_hex().to_string())
                .unwrap();
        (routes, policy)
    }

    #[test]
    fn selection_carries_raw_query_but_excludes_fixed_and_mapped_names() {
        let (routes, policy) = selection_fixture();
        let actual = routes
            .screen_for(
                "/lists/one?screen=evil&view=saved&meeting=secret&pick=picked&raw=first&raw=last",
                &Map::new(),
                &policy,
            )
            .unwrap()
            .unwrap();
        assert_eq!(actual.id, "example.list");
        assert_eq!(
            actual.input,
            serde_json::json!({"id":"one","view_id":"saved","selected":"picked","raw":"last"})
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(
            actual.address.as_deref(),
            Some("/lists/one?screen=evil&view=saved&meeting=secret&pick=picked&raw=first&raw=last")
        );
        assert!(!actual.whole);
    }

    #[test]
    fn selection_explicit_input_overrides_routes_and_preserves_non_url_values() {
        let (routes, policy) = selection_fixture();
        let input = serde_json::json!({"id":"explicit","view_id":"override","nested":{"draft":[1,true]},"empty":null});
        let actual = routes
            .screen_for(
                "/lists/path?view=query&id=query",
                input.as_object().unwrap(),
                &policy,
            )
            .unwrap()
            .unwrap();
        assert_eq!(&actual.input, input.as_object().unwrap());
        // Explicit input must not rewrite the address actually asked for.
        assert_eq!(
            actual.address.as_deref(),
            Some("/lists/path?view=query&id=query")
        );
    }

    #[test]
    fn selection_names_ids_and_tool_ids_share_the_pinned_route_owner() {
        let (routes, policy) = selection_fixture();
        for asked in ["Guide", "gUiDe", "guide", "example.guide"] {
            let actual = routes
                .screen_for(asked, &Map::new(), &policy)
                .unwrap()
                .unwrap();
            assert_eq!(actual.id, "example.guide");
            assert_eq!(actual.address.as_deref(), Some("/guide"));
        }
        let tool = routes
            .screen_for("tool:posts", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(tool.id, "example.own");
        assert!(tool.input.is_empty());
        let nested = routes
            .screen_for("/use/tool%3Aposts/post%2Fone", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(nested.id, "example.own");
        assert_eq!(nested.input["item_id"], "post/one");
    }

    #[test]
    fn selection_whole_policy_does_not_turn_page_home_fallback_into_a_screen() {
        let (routes, policy) = selection_fixture();
        let input = serde_json::json!({"open":"somewhere"});
        for asked in ["  EVERYTHING  ", "/"] {
            let actual = routes
                .screen_for(asked, input.as_object().unwrap(), &policy)
                .unwrap()
                .unwrap();
            assert_eq!(actual.id, "example.workspace");
            assert_eq!(actual.label, "All work");
            assert_eq!(actual.address.as_deref(), Some("/"));
            assert!(actual.whole);
            assert_eq!(&actual.input, input.as_object().unwrap());
        }
        assert!(routes
            .screen_for("", &Map::new(), &policy)
            .unwrap()
            .is_none());
        assert!(routes
            .screen_for("/unoffered?meeting=a", &Map::new(), &policy)
            .unwrap()
            .is_none());
        assert_eq!(routes.resolve("/", "").unwrap().unwrap().entry, None);
    }

    #[test]
    fn selection_query_matches_browser_first_mapped_last_raw_and_tolerant_decoding() {
        let (routes, policy) = selection_fixture();
        let actual = routes
            .screen_for(
                "/lists/one?view=first&view=second&q=one+two&bad=%FF&literal=%GG&tick=`",
                &Map::new(),
                &policy,
            )
            .unwrap()
            .unwrap();
        assert_eq!(actual.input["view_id"], "first");
        assert_eq!(actual.input["q"], "one two");
        assert_eq!(actual.input["bad"], "�");
        assert_eq!(actual.input["literal"], "%GG");
        assert_eq!(actual.input["tick"], "`");
        // Existing page ABI intentionally keeps its strict query decoding.
        assert!(routes.resolve("/lists/one", "bad=%FF").is_err());
        let empty = routes
            .screen_for("/lists/one?view=&view=later", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert!(!empty.input.contains_key("view_id"));
        assert!(!empty.input.contains_key("view"));
    }

    #[test]
    fn selection_normalizes_ordinary_browser_paths_and_preserves_encoded_slashes() {
        let (routes, policy) = selection_fixture();
        let actual = routes
            .screen_for(
                "/unused/%2e%2e/lists/a%2Fb?x=one two#ignored",
                &Map::new(),
                &policy,
            )
            .unwrap()
            .unwrap();
        assert_eq!(actual.input["id"], "a/b");
        assert_eq!(actual.input["x"], "one two");
        assert_eq!(actual.address.as_deref(), Some("/lists/a%2Fb?x=one%20two"));
        assert_eq!(local_address("/a//../b").unwrap().0, "/a/b");
        for bad in [
            "//foreign.invalid/guide",
            "/guide\\other",
            "/guide\n?x=a",
            "/lists/%GG",
            "/lists/%FF",
        ] {
            assert!(
                routes.screen_for(bad, &Map::new(), &policy).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn selection_specific_query_alias_and_no_address_row_remain_exact() {
        let (routes, policy) = selection_fixture();
        let actual = routes
            .screen_for("/guide?mode=specific&extra=yes", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(actual.id, "example.qualified");
        assert_eq!(actual.input["extra"], "yes");
        assert_eq!(actual.input["mode"], "specific");
        let absent = routes
            .screen_for("No address", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(absent.address, None);
        assert!(routes
            .screen_for("not-offered", &Map::new(), &policy)
            .unwrap()
            .is_none());
    }

    #[test]
    fn selection_policy_requires_its_actual_pinned_data() {
        let bytes = br#"{"whole":{"names":["Everything"],"label":"All","address":"/"}}"#;
        assert!(ScreenSelectionPolicy::from_source(bytes, &"0".repeat(64)).is_err());
        for address in ["//foreign.invalid/", "/\\path"] {
            let source = serde_json::to_vec(
                &serde_json::json!({"whole":{"names":["x"],"label":"x","address":address}}),
            )
            .unwrap();
            assert!(ScreenSelectionPolicy::from_source(
                &source,
                &blake3::hash(&source).to_hex().to_string()
            )
            .is_err());
        }
    }

    #[test]
    fn selection_reuses_ecmascript_trim_for_bom_but_keeps_nel_as_input() {
        let (routes, policy) = selection_fixture();
        let actual = routes
            .screen_for("\u{feff}Files\u{feff}", &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(actual.id, "example.files");
        assert!(routes
            .screen_for("\u{0085}Files\u{0085}", &Map::new(), &policy)
            .unwrap()
            .is_none());
        assert!(routes
            .screen_for("\u{1f600}Files\u{1f600}", &Map::new(), &policy)
            .unwrap()
            .is_none());
    }

    #[test]
    fn selection_raw_query_uses_normal_json_in_membership_but_explicit_overlay_keeps_keys() {
        let (routes, policy) = selection_fixture();
        let inherited = [
            "constructor",
            "__defineGetter__",
            "__defineSetter__",
            "hasOwnProperty",
            "__lookupGetter__",
            "__lookupSetter__",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "toString",
            "valueOf",
            "__proto__",
            "toLocaleString",
        ];
        let fields = inherited
            .iter()
            .map(|name| format!("{name}=query"))
            .collect::<Vec<_>>()
            .join("&");
        let address = format!(
            "/lists/one?{fields}&screen=query&prototype=ordinary&tostring=case&ordinary=okay"
        );
        let raw = routes
            .screen_for(&address, &Map::new(), &policy)
            .unwrap()
            .unwrap();
        assert_eq!(raw.input,serde_json::json!({"id":"one","prototype":"ordinary","tostring":"case","ordinary":"okay"}).as_object().unwrap().clone());
        // JSON input/object spread creates own keys, including __proto__.
        // A global deny list here would lose useful explicit input and differ.
        let mut explicit = Map::new();
        for name in inherited {
            explicit.insert(name.to_owned(), Value::String("explicit".to_owned()));
        }
        explicit.insert(
            "screen".to_owned(),
            Value::String("explicit-screen".to_owned()),
        );
        let overlaid = routes
            .screen_for(&address, &explicit, &policy)
            .unwrap()
            .unwrap();
        let mut expected = raw.input;
        expected.extend(explicit);
        assert_eq!(overlaid.input, expected);
        // An absent surface_input uses an ordinary {} in the original too.
        let absent = routes
            .screen_for(
                "/files?constructor=query&ordinary=kept",
                &Map::new(),
                &policy,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            absent.input,
            serde_json::json!({"ordinary":"kept"})
                .as_object()
                .unwrap()
                .clone()
        );
    }
}
