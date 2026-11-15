//! crates/composition-engine-core/src/binding/path.rs
//!
//! Deterministic, side-effect-free utilities to parse, stringify, and safely resolve
//! JSON-like paths against plain data.
//!
//! These functions are the only allowed way to dereference paths inside the kernel.
//! They are hardened against prototype pollution, unexpected getters, and malformed input.
//!
//! Non-Negotiable Invariants:
//! - Read-only: never mutates inputs. No setters here.
//! - Pure: no access to system time, random, or global state.
//! - Guarded traversal: only own properties are accessed.
//! - Stable outputs: parsing and stringifying are inverse operations.
//!
//! Key Concepts:
//! - Path: vec of PathSegment (string keys or numeric indices)
//! - parse_path: converts dotted/bracket notation into a Path
//! - get_at_path: walks an object/array defensively and reports structured diagnostics
//! - stringify_path: stable lossless formatter for Path
//!
//! Security Considerations:
//! - Traversal stops on non-object/array and reports PATH_INVALID or PATH_MISSING
//! - "__proto__", "constructor", and "prototype" keys are blocked
//! - Non-numeric array indices are rejected during numeric resolution
//!
//! Ported from: frontends/web/composition-engine/binding/path.ts

use super::ast::{Diagnostic, DiagnosticCode, DiagnosticLevel, Path, PathSegment};
use std::collections::HashSet;

// ============================================================================
// Constants
// ============================================================================

lazy_static::lazy_static! {
    /// Keys that are forbidden to access for safety.
    static ref FORBIDDEN_KEYS: HashSet<&'static str> = {
        let mut set = HashSet::new();
        set.insert("__proto__");
        set.insert("prototype");
        set.insert("constructor");
        set
    };
}

// ============================================================================
// Path Stringification
// ============================================================================

/// Escape a property name for bracket notation when needed.
/// Note: We allow colons in identifiers to support FSM keys like "editor:mode"
fn needs_bracket_notation(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }

    let mut chars = s.chars();
    let first = chars.next().unwrap();

    // First char must be [A-Za-z_$]
    if !first.is_ascii_alphabetic() && first != '_' && first != '$' {
        return true;
    }

    // Rest must be [A-Za-z0-9_$:] (colon allowed for FSM keys like "editor:mode")
    for c in chars {
        if !c.is_ascii_alphanumeric() && c != '_' && c != '$' && c != ':' {
            return true;
        }
    }

    false
}

/// Escape a string for bracket notation
fn escape_for_bracket(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// Stringifies a Path to stable dotted/bracket notation.
///
/// Examples:
/// - ["user", "name"] -> "user.name"
/// - ["items", 0, "price"] -> "items[0].price"
/// - ["user", "first-name"] -> "user[\"first-name\"]"
pub fn stringify_path(path: &Path) -> String {
    let mut out = String::new();

    for (i, seg) in path.iter().enumerate() {
        match seg {
            PathSegment::Index(idx) => {
                out.push_str(&format!("[{}]", idx));
            }
            PathSegment::Key(key) => {
                if i == 0 {
                    if needs_bracket_notation(key) {
                        out.push_str(&format!("[{}]", escape_for_bracket(key)));
                    } else {
                        out.push_str(key);
                    }
                } else if needs_bracket_notation(key) {
                    out.push_str(&format!("[{}]", escape_for_bracket(key)));
                } else {
                    out.push('.');
                    out.push_str(key);
                }
            }
        }
    }

    out
}

// ============================================================================
// Path Parsing
// ============================================================================

/// Parse a path string into a Path array.
///
/// Supports:
/// - Dotted notation: "user.profile.name"
/// - Bracket notation: "items[0]", "user[\"first-name\"]"
/// - Mixed: "user.items[0].name"
///
/// Returns Err on syntax errors.
pub fn parse_path(input: &str) -> Result<Path, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Empty path".to_string());
    }

    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut segs: Path = Vec::new();

    // Helper to read an identifier
    // Note: We allow colons in identifiers to support FSM keys like "editor:mode"
    let read_ident = |chars: &[char], start: &mut usize| -> Result<String, String> {
        let i = *start;
        if i >= chars.len() {
            return Err(format!("Expected identifier at position {}", i));
        }

        let first = chars[i];
        if !first.is_ascii_alphabetic() && first != '_' && first != '$' {
            return Err(format!("Invalid identifier start at position {}", i));
        }

        let mut end = i + 1;
        while end < chars.len() {
            let c = chars[end];
            // Allow alphanumeric, underscore, dollar sign, and colon (for FSM keys like "editor:mode")
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == ':' {
                end += 1;
            } else {
                break;
            }
        }

        let ident: String = chars[i..end].iter().collect();
        *start = end;
        Ok(ident)
    };

    // Helper to read a bracket segment
    let read_bracket = |chars: &[char], start: &mut usize| -> Result<PathSegment, String> {
        let i = *start;
        if i >= chars.len() || chars[i] != '[' {
            return Err(format!("Expected '[' at position {}", i));
        }
        *start = i + 1;

        // Check for numeric index first
        let mut num_end = *start;
        while num_end < chars.len() && chars[num_end].is_ascii_digit() {
            num_end += 1;
        }

        if num_end > *start && num_end < chars.len() && chars[num_end] == ']' {
            // Numeric index
            let num_str: String = chars[*start..num_end].iter().collect();
            let idx: usize = num_str.parse().map_err(|_| "Invalid index".to_string())?;
            *start = num_end + 1;
            return Ok(PathSegment::Index(idx));
        }

        // String literal "..." or '...'
        let quote = chars.get(*start).copied();
        if quote != Some('"') && quote != Some('\'') {
            return Err(format!("Expected quote or number at position {}", *start));
        }
        let quote = quote.unwrap();
        *start += 1;

        let mut buf = String::new();
        while *start < chars.len() {
            let ch = chars[*start];
            *start += 1;

            if ch == '\\' {
                // Escape sequence
                if *start >= chars.len() {
                    return Err("Unterminated escape".to_string());
                }
                let next = chars[*start];
                *start += 1;
                buf.push(next);
                continue;
            }

            if ch == quote {
                // End of string
                break;
            }

            buf.push(ch);
        }

        if *start >= chars.len() || chars[*start] != ']' {
            return Err(format!("Expected ']' at position {}", *start));
        }
        *start += 1;

        Ok(PathSegment::Key(buf))
    };

    // First segment must be an identifier (or bracket for edge cases)
    if chars[0] == '[' {
        segs.push(read_bracket(&chars, &mut i)?);
    } else {
        let ident = read_ident(&chars, &mut i)?;
        segs.push(PathSegment::Key(ident));
    }

    // Rest: .ident | [index|string]
    while i < chars.len() {
        let ch = chars[i];
        if ch == '.' {
            i += 1;
            let ident = read_ident(&chars, &mut i)?;
            segs.push(PathSegment::Key(ident));
        } else if ch == '[' {
            segs.push(read_bracket(&chars, &mut i)?);
        } else {
            return Err(format!("Unexpected '{}' at position {}", ch, i));
        }
    }

    Ok(segs)
}

/// Parse from either a string or an existing path array
pub fn parse_path_like(input: PathLike) -> Result<Path, String> {
    match input {
        PathLike::String(s) => parse_path(&s),
        PathLike::Array(p) => Ok(p),
    }
}

/// Input that can be converted to a path
pub enum PathLike {
    String(String),
    Array(Path),
}

impl From<&str> for PathLike {
    fn from(s: &str) -> Self {
        PathLike::String(s.to_string())
    }
}

impl From<String> for PathLike {
    fn from(s: String) -> Self {
        PathLike::String(s)
    }
}

impl From<Path> for PathLike {
    fn from(p: Path) -> Self {
        PathLike::Array(p)
    }
}

// ============================================================================
// Path Resolution
// ============================================================================

/// Options that control missing behavior for get_at_path.
#[derive(Debug, Clone, Default)]
pub struct GetOptions {
    /// If true, accessing forbidden or missing paths yields diagnostics but never panics.
    pub tolerant: bool,
    /// JSON Pointer for diagnostic locations.
    pub at: String,
}

/// Result of safe traversal.
#[derive(Debug, Clone)]
pub struct GetResult {
    pub ok: bool,
    pub value: Option<serde_json::Value>,
    pub diagnostic: Option<Diagnostic>,
    /// Fully-qualified string path for observability.
    pub fq_path: String,
}

impl GetResult {
    /// Create a successful result
    pub fn success(value: serde_json::Value, fq_path: String) -> Self {
        Self {
            ok: true,
            value: Some(value),
            diagnostic: None,
            fq_path,
        }
    }

    /// Create a failed result
    pub fn failure(diagnostic: Diagnostic, fq_path: String) -> Self {
        Self {
            ok: false,
            value: None,
            diagnostic: Some(diagnostic),
            fq_path,
        }
    }
}

/// Safely traverse a JSON value using Path.
///
/// - Blocks prototype keys (__proto__, prototype, constructor)
/// - Only direct properties are accessed
/// - Stops early on non-object/non-array parents
pub fn get_at_path(root: &serde_json::Value, path: &Path, opts: &GetOptions) -> GetResult {
    let at = &opts.at;
    let mut cur = root.clone();
    let mut fq = String::new();

    for (i, seg) in path.iter().enumerate() {
        // Build fully-qualified path string
        match seg {
            PathSegment::Index(idx) => {
                fq.push_str(&format!("[{}]", idx));
            }
            PathSegment::Key(key) => {
                if i == 0 {
                    fq.push_str(key);
                } else {
                    fq.push('.');
                    fq.push_str(key);
                }
            }
        }

        match seg {
            PathSegment::Key(key) => {
                // Check forbidden keys
                if FORBIDDEN_KEYS.contains(key.as_str()) {
                    let diagnostic = Diagnostic {
                        code: DiagnosticCode::PathAccessDenied,
                        level: DiagnosticLevel::Error,
                        message: format!("Access to key \"{}\" is forbidden", key),
                        at: at.clone(),
                        data: Some({
                            let mut map = std::collections::HashMap::new();
                            map.insert("key".to_string(), serde_json::json!(key));
                            map.insert(
                                "path".to_string(),
                                serde_json::json!(path.iter().take(i + 1).map(|s| {
                                    match s {
                                        PathSegment::Key(k) => serde_json::json!(k),
                                        PathSegment::Index(idx) => serde_json::json!(idx),
                                    }
                                }).collect::<Vec<_>>()),
                            );
                            map
                        }),
                    };
                    return GetResult::failure(diagnostic, fq);
                }

                // Must be an object
                match cur {
                    serde_json::Value::Object(ref obj) => {
                        if let Some(val) = obj.get(key) {
                            cur = val.clone();
                        } else {
                            let diagnostic = Diagnostic {
                                code: DiagnosticCode::PathMissing,
                                level: DiagnosticLevel::Warn,
                                message: format!("Missing key \"{}\" at segment {}", key, i),
                                at: at.clone(),
                                data: Some({
                                    let mut map = std::collections::HashMap::new();
                                    map.insert(
                                        "path".to_string(),
                                        serde_json::json!(path.iter().take(i + 1).map(|s| {
                                            match s {
                                                PathSegment::Key(k) => serde_json::json!(k),
                                                PathSegment::Index(idx) => serde_json::json!(idx),
                                            }
                                        }).collect::<Vec<_>>()),
                                    );
                                    map
                                }),
                            };
                            return GetResult::failure(diagnostic, fq);
                        }
                    }
                    _ => {
                        let diagnostic = Diagnostic {
                            code: DiagnosticCode::PathInvalid,
                            level: DiagnosticLevel::Error,
                            message: format!(
                                "Cannot read \"{}\" from non-object at segment {}",
                                key, i
                            ),
                            at: at.clone(),
                            data: Some({
                                let mut map = std::collections::HashMap::new();
                                map.insert(
                                    "parentType".to_string(),
                                    serde_json::json!(value_type_name(&cur)),
                                );
                                map
                            }),
                        };
                        return GetResult::failure(diagnostic, fq);
                    }
                }
            }
            PathSegment::Index(idx) => {
                // Must be an array
                match cur {
                    serde_json::Value::Array(ref arr) => {
                        if *idx < arr.len() {
                            cur = arr[*idx].clone();
                        } else {
                            let diagnostic = Diagnostic {
                                code: DiagnosticCode::PathMissing,
                                level: DiagnosticLevel::Warn,
                                message: format!(
                                    "Array index [{}] out of bounds at segment {}",
                                    idx, i
                                ),
                                at: at.clone(),
                                data: Some({
                                    let mut map = std::collections::HashMap::new();
                                    map.insert("length".to_string(), serde_json::json!(arr.len()));
                                    map.insert(
                                        "path".to_string(),
                                        serde_json::json!(path.iter().take(i + 1).map(|s| {
                                            match s {
                                                PathSegment::Key(k) => serde_json::json!(k),
                                                PathSegment::Index(idx) => serde_json::json!(idx),
                                            }
                                        }).collect::<Vec<_>>()),
                                    );
                                    map
                                }),
                            };
                            return GetResult::failure(diagnostic, fq);
                        }
                    }
                    _ => {
                        let diagnostic = Diagnostic {
                            code: DiagnosticCode::PathInvalid,
                            level: DiagnosticLevel::Error,
                            message: format!(
                                "Cannot index non-array with [{}] at segment {}",
                                idx, i
                            ),
                            at: at.clone(),
                            data: Some({
                                let mut map = std::collections::HashMap::new();
                                map.insert(
                                    "parentType".to_string(),
                                    serde_json::json!(value_type_name(&cur)),
                                );
                                map
                            }),
                        };
                        return GetResult::failure(diagnostic, fq);
                    }
                }
            }
        }
    }

    GetResult::success(cur, fq)
}

/// Get the type name of a JSON value
fn value_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Convenience: resolve any acceptable path representation.
/// Returns diagnostics on syntax errors instead of panicking.
pub fn resolve_path(
    root: &serde_json::Value,
    path_like: &str,
    opts: &GetOptions,
) -> GetResult {
    match parse_path(path_like) {
        Ok(path) => get_at_path(root, &path, opts),
        Err(err) => {
            let diagnostic = Diagnostic {
                code: DiagnosticCode::PathInvalid,
                level: DiagnosticLevel::Error,
                message: err,
                at: opts.at.clone(),
                data: Some({
                    let mut map = std::collections::HashMap::new();
                    map.insert("input".to_string(), serde_json::json!(path_like));
                    map
                }),
            };
            GetResult::failure(diagnostic, String::new())
        }
    }
}

/// Public API to reconstruct a stable string for observability dashboards.
pub fn format_qualified_path(
    source: super::ast::SelectSource,
    key: Option<&str>,
    path: &Path,
) -> String {
    use super::ast::SelectSource;

    let head = match source {
        SelectSource::SelfSource => "self".to_string(),
        SelectSource::Ambient => "ambient".to_string(),
        SelectSource::Vars => "vars".to_string(),
        SelectSource::Literal => "literal".to_string(),
        SelectSource::Fsm => "fsm".to_string(),
        SelectSource::DataSource => {
            if let Some(k) = key {
                format!("dataSource.{}", k)
            } else {
                "dataSource".to_string()
            }
        }
        SelectSource::Routing => {
            if let Some(k) = key {
                format!("routing.{}", k)
            } else {
                "routing".to_string()
            }
        }
        SelectSource::State => {
            if let Some(k) = key {
                format!("state.{}", k)
            } else {
                "state".to_string()
            }
        }
        SelectSource::Scene => {
            if let Some(k) = key {
                format!("scene.{}", k)
            } else {
                "scene".to_string()
            }
        }
        SelectSource::Context => "context".to_string(),
    };

    if path.is_empty() {
        return head;
    }

    format!("{}.{}", head, stringify_path(path))
}

/// Helper to quickly check if a string path is syntactically safe.
pub fn is_path_string_safe(s: &str) -> bool {
    parse_path(s).is_ok()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_path() {
        let path = parse_path("user.profile.name").unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0], PathSegment::Key("user".to_string()));
        assert_eq!(path[1], PathSegment::Key("profile".to_string()));
        assert_eq!(path[2], PathSegment::Key("name".to_string()));
    }

    #[test]
    fn test_parse_array_path() {
        let path = parse_path("items[0].name").unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0], PathSegment::Key("items".to_string()));
        assert_eq!(path[1], PathSegment::Index(0));
        assert_eq!(path[2], PathSegment::Key("name".to_string()));
    }

    #[test]
    fn test_parse_bracket_string() {
        let path = parse_path("user[\"first-name\"]").unwrap();
        assert_eq!(path.len(), 2);
        assert_eq!(path[0], PathSegment::Key("user".to_string()));
        assert_eq!(path[1], PathSegment::Key("first-name".to_string()));
    }

    #[test]
    fn test_stringify_path() {
        let path = vec![
            PathSegment::Key("user".to_string()),
            PathSegment::Key("profile".to_string()),
            PathSegment::Key("name".to_string()),
        ];
        assert_eq!(stringify_path(&path), "user.profile.name");
    }

    #[test]
    fn test_stringify_array_path() {
        let path = vec![
            PathSegment::Key("items".to_string()),
            PathSegment::Index(0),
            PathSegment::Key("name".to_string()),
        ];
        assert_eq!(stringify_path(&path), "items[0].name");
    }

    #[test]
    fn test_stringify_special_chars() {
        let path = vec![
            PathSegment::Key("user".to_string()),
            PathSegment::Key("first-name".to_string()),
        ];
        assert_eq!(stringify_path(&path), "user[\"first-name\"]");
    }

    #[test]
    fn test_get_at_path_simple() {
        let data = serde_json::json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        });
        let path = parse_path("user.name").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(result.ok);
        assert_eq!(result.value, Some(serde_json::json!("Alice")));
    }

    #[test]
    fn test_get_at_path_array() {
        let data = serde_json::json!({
            "items": ["a", "b", "c"]
        });
        let path = parse_path("items[1]").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(result.ok);
        assert_eq!(result.value, Some(serde_json::json!("b")));
    }

    #[test]
    fn test_get_at_path_missing_key() {
        let data = serde_json::json!({
            "user": { "name": "Alice" }
        });
        let path = parse_path("user.email").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(!result.ok);
        assert!(result.diagnostic.is_some());
        assert_eq!(
            result.diagnostic.as_ref().unwrap().code,
            DiagnosticCode::PathMissing
        );
    }

    #[test]
    fn test_get_at_path_forbidden_key() {
        let data = serde_json::json!({
            "user": { "__proto__": "bad" }
        });
        let path = parse_path("user.__proto__").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(!result.ok);
        assert!(result.diagnostic.is_some());
        assert_eq!(
            result.diagnostic.as_ref().unwrap().code,
            DiagnosticCode::PathAccessDenied
        );
    }

    #[test]
    fn test_get_at_path_array_out_of_bounds() {
        let data = serde_json::json!({
            "items": ["a", "b"]
        });
        let path = parse_path("items[5]").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(!result.ok);
        assert!(result.diagnostic.is_some());
        assert_eq!(
            result.diagnostic.as_ref().unwrap().code,
            DiagnosticCode::PathMissing
        );
    }

    #[test]
    fn test_get_at_path_invalid_parent() {
        let data = serde_json::json!({
            "value": "string"
        });
        let path = parse_path("value.nested").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(!result.ok);
        assert!(result.diagnostic.is_some());
        assert_eq!(
            result.diagnostic.as_ref().unwrap().code,
            DiagnosticCode::PathInvalid
        );
    }

    #[test]
    fn test_format_qualified_path() {
        use super::super::ast::SelectSource;

        let path = vec![
            PathSegment::Key("profile".to_string()),
            PathSegment::Key("name".to_string()),
        ];

        assert_eq!(
            format_qualified_path(SelectSource::DataSource, Some("user"), &path),
            "dataSource.user.profile.name"
        );

        assert_eq!(
            format_qualified_path(SelectSource::Ambient, None, &path),
            "ambient.profile.name"
        );

        assert_eq!(
            format_qualified_path(SelectSource::SelfSource, None, &vec![]),
            "self"
        );
    }

    #[test]
    fn test_roundtrip_parse_stringify() {
        let paths = vec![
            "user.profile.name",
            "items[0].price",
            "data[\"special-key\"]",
        ];

        for p in paths {
            let parsed = parse_path(p).unwrap();
            let stringified = stringify_path(&parsed);
            let reparsed = parse_path(&stringified).unwrap();
            assert_eq!(parsed, reparsed, "Roundtrip failed for: {}", p);
        }
    }

    #[test]
    fn test_parse_path_with_colon() {
        // FSM keys use colons, e.g., "editor:mode"
        let path = parse_path("editor:mode").unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path[0], PathSegment::Key("editor:mode".to_string()));
    }

    #[test]
    fn test_stringify_path_with_colon() {
        // Colons should not require bracket notation
        let path = vec![PathSegment::Key("editor:mode".to_string())];
        assert_eq!(stringify_path(&path), "editor:mode");
    }

    #[test]
    fn test_get_at_path_with_colon_key() {
        let data = serde_json::json!({
            "editor:mode": "edit"
        });
        let path = parse_path("editor:mode").unwrap();
        let result = get_at_path(&data, &path, &GetOptions::default());

        assert!(result.ok);
        assert_eq!(result.value, Some(serde_json::json!("edit")));
    }
}
