//! Text operators for ops-core
//!
//! This module implements text manipulation operators with proper Unicode support
//! using grapheme clusters for correct character counting and slicing.
//!
//! # Null Handling
//!
//! Most text operators propagate null:
//! - upper(null) = null
//! - concat("a", null) = null (strict mode) or "a" (lenient mode)
//!
//! # Unicode Correctness
//!
//! All operations use grapheme clusters for character counting:
//! - len("👨‍👩‍👧‍👦") = 1 (one family emoji)
//! - len("café") = 4 (correct handling of combining characters)

use crate::{EvalContext, OpError, OpValue};
use serde_json::Value as JsonValue;
use unicode_segmentation::UnicodeSegmentation;

// =============================================================================
// CONCATENATION
// =============================================================================

/// Concatenate two strings.
///
/// Returns null if either operand is null.
pub fn concat(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let a_str = a.as_str_opt("concat")?;
    let b_str = b.as_str_opt("concat")?;

    match (a_str, b_str) {
        (Some(a), Some(b)) => {
            let mut result = String::with_capacity(a.len() + b.len());
            result.push_str(a);
            result.push_str(b);
            Ok(OpValue::string(result))
        }
        _ => Ok(OpValue::null()), // Either null -> null
    }
}

/// Concatenate multiple strings.
///
/// Skips null values (lenient mode, like Excel's CONCAT).
pub fn concat_many(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let mut result = String::new();

    for val in values {
        if let Some(s) = val.as_str_opt("concat")? {
            result.push_str(s);
        }
        // Skip nulls
    }

    Ok(OpValue::string(result))
}

// =============================================================================
// CASE TRANSFORMATION
// =============================================================================

/// Convert string to uppercase.
///
/// Returns null if input is null.
pub fn upper(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("upper")? {
        Some(s) => Ok(OpValue::string(s.to_uppercase())),
        None => Ok(OpValue::null()),
    }
}

/// Convert string to lowercase.
///
/// Returns null if input is null.
pub fn lower(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("lower")? {
        Some(s) => Ok(OpValue::string(s.to_lowercase())),
        None => Ok(OpValue::null()),
    }
}

// =============================================================================
// TRIMMING
// =============================================================================

/// Trim whitespace from both ends.
///
/// Returns null if input is null.
pub fn trim(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("trim")? {
        Some(s) => Ok(OpValue::string(s.trim())),
        None => Ok(OpValue::null()),
    }
}

/// Trim whitespace from the start (left).
///
/// Returns null if input is null.
pub fn trim_start(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("trim_start")? {
        Some(s) => Ok(OpValue::string(s.trim_start())),
        None => Ok(OpValue::null()),
    }
}

/// Trim whitespace from the end (right).
///
/// Returns null if input is null.
pub fn trim_end(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("trim_end")? {
        Some(s) => Ok(OpValue::string(s.trim_end())),
        None => Ok(OpValue::null()),
    }
}

// =============================================================================
// LENGTH
// =============================================================================

/// Get the length of a string in grapheme clusters.
///
/// This correctly counts user-perceived characters:
/// - len("hello") = 5
/// - len("👨‍👩‍👧‍👦") = 1 (family emoji is one grapheme)
/// - len("café") = 4
///
/// Returns null if input is null.
pub fn len(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match a.as_str_opt("len")? {
        Some(s) => Ok(OpValue::number(grapheme_len(s) as f64)),
        None => Ok(OpValue::null()),
    }
}

/// Helper: count graphemes in a string.
fn grapheme_len(s: &str) -> usize {
    s.graphemes(true).count()
}

// =============================================================================
// SUBSTRING OPERATIONS
// =============================================================================

/// Extract a substring.
///
/// substring(text, start, length)
/// - start is 0-based index
/// - length is the number of graphemes to extract
///
/// Returns null if any input is null.
pub fn substring(
    text: &OpValue,
    start: &OpValue,
    length: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("substring")?;
    let start_idx = start.as_usize_or_null("substring")?;
    let len_val = length.as_usize_or_null("substring")?;

    match (text_str, start_idx, len_val) {
        (Some(s), Some(start), Some(len)) => {
            Ok(OpValue::string(grapheme_slice(s, start, Some(len))))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Extract leftmost characters.
///
/// left(text, count) - returns first `count` graphemes.
pub fn left(text: &OpValue, count: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("left")?;
    let count_val = count.as_usize_or_null("left")?;

    match (text_str, count_val) {
        (Some(s), Some(n)) => Ok(OpValue::string(grapheme_slice(s, 0, Some(n)))),
        _ => Ok(OpValue::null()),
    }
}

/// Extract rightmost characters.
///
/// right(text, count) - returns last `count` graphemes.
pub fn right(text: &OpValue, count: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("right")?;
    let count_val = count.as_usize_or_null("right")?;

    match (text_str, count_val) {
        (Some(s), Some(n)) => {
            let len = grapheme_len(s);
            let start = len.saturating_sub(n);
            Ok(OpValue::string(grapheme_slice(s, start, None)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Helper: slice a string by grapheme indices.
fn grapheme_slice(s: &str, start: usize, len: Option<usize>) -> String {
    let graphemes: Vec<&str> = s.graphemes(true).collect();
    let start_idx = start.min(graphemes.len());

    match len {
        Some(length) => {
            let end_idx = (start_idx + length).min(graphemes.len());
            graphemes[start_idx..end_idx].join("")
        }
        None => graphemes[start_idx..].join(""),
    }
}

// =============================================================================
// SEARCH AND REPLACE
// =============================================================================

/// Replace all occurrences of a pattern.
///
/// replace(text, from, to) - replaces all occurrences of `from` with `to`.
///
/// Returns null if any input is null.
pub fn replace(
    text: &OpValue,
    from: &OpValue,
    to: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let from_str = from.as_str_opt("replace")?;
    let to_str = to.as_str_opt("replace")?;

    // Try string input first (common path). as_str_opt returns Err for
    // non-null non-string types, so we catch that to handle objects/arrays.
    match text.as_str_opt("replace") {
        Ok(text_str) => match (text_str, from_str, to_str) {
            (Some(t), Some(f), Some(r)) => {
                if f.is_empty() {
                    Ok(OpValue::string(t))
                } else {
                    let result = t.replace(f, r);
                    Ok(OpValue::string(result))
                }
            }
            _ => Ok(OpValue::null()),
        },
        Err(_) => {
            // Text is not a string — if it's an object/array, serialize →
            // replace → parse back. Enables template replacement on JSON
            // structures (e.g., compiler config with __PLACEHOLDER__ values).
            match (from_str, to_str) {
                (Some(f), Some(r)) if !f.is_empty() && (text.is_object() || text.is_array()) => {
                    let inner = text.as_inner();
                    let serialized =
                        serde_json::to_string(&inner).map_err(|e| OpError::TypeMismatch {
                            operation: "replace".to_string(),
                            expected: "serializable JSON".to_string(),
                            actual: format!("serialize error: {}", e),
                        })?;
                    let replaced = serialized.replace(f, r);
                    match serde_json::from_str::<serde_json::Value>(&replaced) {
                        Ok(parsed) => Ok(OpValue::from(parsed)),
                        // If replacement broke JSON structure, return as string
                        Err(_e) => Ok(OpValue::string(replaced)),
                    }
                }
                _ => Ok(OpValue::null()),
            }
        }
    }
}

/// Find the position of a substring.
///
/// index_of(text, needle) - returns 0-based index or -1 if not found.
///
/// Uses grapheme-aware searching.
/// Returns null if any input is null.
pub fn index_of(text: &OpValue, needle: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("index_of")?;
    let needle_str = needle.as_str_opt("index_of")?;

    match (text_str, needle_str) {
        (Some(t), Some(n)) => {
            if n.is_empty() {
                return Ok(OpValue::number(0.0));
            }

            let text_graphemes: Vec<&str> = t.graphemes(true).collect();
            let needle_graphemes: Vec<&str> = n.graphemes(true).collect();

            if needle_graphemes.len() > text_graphemes.len() {
                return Ok(OpValue::number(-1.0));
            }

            let position = text_graphemes
                .windows(needle_graphemes.len())
                .position(|window| window == needle_graphemes.as_slice());

            match position {
                Some(pos) => Ok(OpValue::number(pos as f64)),
                None => Ok(OpValue::number(-1.0)),
            }
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// SPLIT AND JOIN
// =============================================================================

/// Split a string by a delimiter.
///
/// split(text, delimiter) - returns an array of strings.
///
/// If delimiter is empty, splits into individual graphemes.
/// Returns null if any input is null.
pub fn split(text: &OpValue, delimiter: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("split")?;
    let delim_str = delimiter.as_str_opt("split")?;

    match (text_str, delim_str) {
        (Some(t), Some(d)) => {
            let parts: Vec<JsonValue> = if d.is_empty() {
                // Split into graphemes
                t.graphemes(true)
                    .map(|g| JsonValue::String(g.to_string()))
                    .collect()
            } else {
                t.split(d)
                    .map(|s| JsonValue::String(s.to_string()))
                    .collect()
            };
            Ok(OpValue::array(parts))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Join an array of strings with a delimiter.
///
/// join(array, delimiter) - returns a single string.
///
/// Non-string values are converted to their string representation.
/// Returns null if any input is null.
pub fn join(arr: &OpValue, delimiter: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("join")?;
    let delim_str = delimiter.as_str_opt("join")?;

    match (array_opt, delim_str) {
        (Some(array), Some(d)) => {
            let strings: Vec<String> = array
                .iter()
                .map(|v| OpValue::from_arc(std::sync::Arc::clone(v)).to_string_repr())
                .collect();
            Ok(OpValue::string(strings.join(d)))
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// PREDICATES
// =============================================================================

/// Check if a string starts with a prefix.
///
/// Returns null if any input is null.
pub fn starts_with(
    text: &OpValue,
    prefix: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("starts_with")?;
    let prefix_str = prefix.as_str_opt("starts_with")?;

    match (text_str, prefix_str) {
        (Some(t), Some(p)) => Ok(OpValue::bool(t.starts_with(p))),
        _ => Ok(OpValue::null()),
    }
}

/// Check if `text` is a prefix of `target` (inverse of starts_with).
///
/// starts_with: "hello world".starts_with("hello") → true  (does text start with prefix?)
/// is_prefix_of: "hello".is_prefix_of("hello world") → true  (is text a prefix of target?)
///
/// Universal operation: DNS resolution, URL routing, IP routing (CIDR),
/// filesystem mount resolution, package scope routing. Every prefix-match
/// routing system needs "is this pattern a prefix of the input?"
///
/// Returns null if any input is null.
pub fn is_prefix_of(
    text: &OpValue,
    target: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("is_prefix_of")?;
    let target_str = target.as_str_opt("is_prefix_of")?;

    match (text_str, target_str) {
        (Some(prefix), Some(full)) => Ok(OpValue::bool(full.starts_with(prefix))),
        _ => Ok(OpValue::null()),
    }
}

/// Check if a string ends with a suffix.
///
/// Returns null if any input is null.
pub fn ends_with(text: &OpValue, suffix: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("ends_with")?;
    let suffix_str = suffix.as_str_opt("ends_with")?;

    match (text_str, suffix_str) {
        (Some(t), Some(s)) => Ok(OpValue::bool(t.ends_with(s))),
        _ => Ok(OpValue::null()),
    }
}

/// Check if a string contains a substring.
///
/// Returns null if any input is null.
pub fn contains(text: &OpValue, needle: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("contains")?;
    let needle_str = needle.as_str_opt("contains")?;

    match (text_str, needle_str) {
        (Some(t), Some(n)) => Ok(OpValue::bool(t.contains(n))),
        _ => Ok(OpValue::null()),
    }
}

/// Repeat a string n times.
///
/// Returns null if any input is null.
/// Limits output to 1MB to prevent memory exhaustion.
pub fn repeat(text: &OpValue, count: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    const MAX_SIZE: usize = 1_000_000;

    let text_str = text.as_str_opt("repeat")?;
    let count_val = count.as_usize_or_null("repeat")?;

    match (text_str, count_val) {
        (Some(t), Some(n)) => {
            if t.len() * n > MAX_SIZE {
                return Err(OpError::InvalidArgument {
                    operation: "repeat".to_string(),
                    reason: format!("Result would exceed maximum size of {} bytes", MAX_SIZE),
                });
            }
            Ok(OpValue::string(t.repeat(n)))
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// FORMATTING AND UNICODE
// =============================================================================

/// Format a template string with positional arguments.
///
/// format(template, arg0, arg1, ...) - replaces {0}, {1}, etc. with arguments.
///
/// # Example
/// ```ignore
/// format("Hello, {0}! You have {1} messages.", "Alice", 5)
/// // Returns: "Hello, Alice! You have 5 messages."
/// ```
///
/// Returns null if template is null.
pub fn format(
    template: &OpValue,
    args: &[OpValue],
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let template_str = template.as_str_opt("format")?;

    match template_str {
        Some(template) => {
            // Replace {0}, {1}, etc. with corresponding arguments
            let mut result = template.to_string();
            for (i, arg) in args.iter().enumerate() {
                let placeholder = format!("{{{}}}", i);
                let replacement = arg.to_string_repr();
                result = result.replace(&placeholder, &replacement);
            }
            Ok(OpValue::string(result))
        }
        None => Ok(OpValue::null()),
    }
}

/// Normalize a Unicode string to a specific form.
///
/// normalize(text, form) - normalizes text to NFC, NFD, NFKC, or NFKD form.
///
/// # Forms
/// - NFC: Canonical Decomposition, followed by Canonical Composition
/// - NFD: Canonical Decomposition
/// - NFKC: Compatibility Decomposition, followed by Canonical Composition
/// - NFKD: Compatibility Decomposition
///
/// Returns null if any input is null.
/// Returns an error for invalid normalization forms.
pub fn normalize(text: &OpValue, form: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    use unicode_normalization::UnicodeNormalization;

    let text_str = text.as_str_opt("normalize")?;
    let form_str = form.as_str_opt("normalize")?;

    match (text_str, form_str) {
        (Some(t), Some(f)) => {
            let normalized = match f.to_uppercase().as_str() {
                "NFC" => t.nfc().collect::<String>(),
                "NFD" => t.nfd().collect::<String>(),
                "NFKC" => t.nfkc().collect::<String>(),
                "NFKD" => t.nfkd().collect::<String>(),
                _ => {
                    return Err(OpError::InvalidArgument {
                        operation: "normalize".to_string(),
                        reason: "Invalid normalization form. Use NFC, NFD, NFKC, or NFKD."
                            .to_string(),
                    });
                }
            };
            Ok(OpValue::string(normalized))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Unicode case folding - converts text to a case-insensitive form.
///
/// case_fold(text) - applies Unicode case folding for case-insensitive comparison.
///
/// Case folding is more aggressive than lowercasing:
/// - German ß becomes "ss"
/// - Turkish İ handling
///
/// Returns null if input is null.
pub fn case_fold(text: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    use icu_casemap::CaseMapper;

    let text_str = text.as_str_opt("case_fold")?;

    match text_str {
        Some(t) => {
            let cm = CaseMapper::new();
            Ok(OpValue::string(cm.fold_string(t)))
        }
        None => Ok(OpValue::null()),
    }
}

// =============================================================================
// JSON PARSING
// =============================================================================

/// Parse a JSON-encoded string into its typed value.
///
/// json_parse(input) — if input is a string, attempts JSON parsing.
/// If input is an array, maps json_parse over each element.
/// Non-string/non-array inputs pass through unchanged.
///
/// # Behavior
/// - `"\"hello\""` → `"hello"` (JSON string decoded)
/// - `"42"` → `42` (JSON number decoded)
/// - `"[1,2,3]"` → `[1,2,3]` (JSON array decoded)
/// - `"{\"a\":1}"` → `{"a":1}` (JSON object decoded)
/// - `"invalid{"` → `null` (invalid JSON → null, no crash)
/// - `["\"a\"","\"b\""]` → `["a","b"]` (array: maps parse over elements)
/// - `null` → `null` (null propagation)
/// - `42` → `42` (non-string: pass-through)
///
/// # Use case: _databaseRead value_json decoding
/// The `value_json` column stores JSON-encoded TEXT. When read via
/// `_databaseRead`, the raw TEXT arrives as a string with JSON escaping.
/// `json_parse` decodes it so downstream transforms (regex_extract,
/// join, etc.) operate on actual values, not JSON-encoded strings.
///
/// This is the composable transform equivalent of `decode_value_json`
/// in the data module — same Physics operation, available in the
/// generic transform pipeline for any consumer.
pub fn json_parse(input: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    use crate::value::{opnode_to_json_value, OpNode};

    match input.node() {
        OpNode::String(s) => match serde_json::from_str::<JsonValue>(s.as_ref()) {
            Ok(parsed) => Ok(OpValue::from(parsed)),
            Err(_) => Ok(OpValue::null()),
        },
        OpNode::Array(arr) => {
            let parsed: Vec<JsonValue> = arr
                .iter()
                .map(|item| {
                    // Convert each OpNode back to JsonValue, parse if string
                    let json_item = opnode_to_json_value(item);
                    if let JsonValue::String(s) = &json_item {
                        serde_json::from_str::<JsonValue>(s).unwrap_or(JsonValue::Null)
                    } else {
                        json_item
                    }
                })
                .collect();
            Ok(OpValue::array(parsed))
        }
        _ => Ok(input.clone()),
    }
}

// =============================================================================
// REGEX EXTRACTION
// =============================================================================

/// Extract all matches of a regex pattern from a string.
///
/// regex_extract(text, pattern) — returns an array of strings, one per
/// capture-group-1 match.  If the pattern has no capture group, returns
/// full matches instead.
///
/// # CJS require() discovery use case
/// ```ignore
/// regex_extract(bundle, r#"require\(['"]([^'"]+)['"]\)"#)
/// // Returns: ["react", "react-dom", "@/components/ui", ...]
/// ```
///
/// Returns null if either input is null.
/// Returns an error if the pattern is not a valid regex.
pub fn regex_extract(
    text: &OpValue,
    pattern: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let text_str = text.as_str_opt("regex_extract")?;
    let pattern_str = pattern.as_str_opt("regex_extract")?;

    match (text_str, pattern_str) {
        (Some(t), Some(p)) => {
            let re = regex::Regex::new(p).map_err(|e| OpError::InvalidArgument {
                operation: "regex_extract".to_string(),
                reason: format!("Invalid regex pattern: {}", e),
            })?;

            let has_captures = re.captures_len() > 1;
            let matches: Vec<JsonValue> = re
                .captures_iter(t)
                .filter_map(|cap| {
                    if has_captures {
                        // Return capture group 1
                        cap.get(1)
                            .map(|m| JsonValue::String(m.as_str().to_string()))
                    } else {
                        // No capture group — return full match
                        cap.get(0)
                            .map(|m| JsonValue::String(m.as_str().to_string()))
                    }
                })
                .collect();

            Ok(OpValue::array(matches))
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> EvalContext {
        EvalContext::default()
    }

    // --- Concat Tests ---

    #[test]
    fn test_concat_basic() {
        let result = concat(&OpValue::string("a"), &OpValue::string("b"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("ab"));
    }

    #[test]
    fn test_concat_with_null() {
        let result = concat(&OpValue::string("a"), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_concat_many() {
        let values = vec![
            OpValue::string("a"),
            OpValue::null(),
            OpValue::string("b"),
            OpValue::string("c"),
        ];
        let result = concat_many(&values, &ctx()).unwrap();
        assert_eq!(result, OpValue::string("abc"));
    }

    // --- Case Tests ---

    #[test]
    fn test_upper() {
        let result = upper(&OpValue::string("hello"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("HELLO"));
    }

    #[test]
    fn test_lower() {
        let result = lower(&OpValue::string("WORLD"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("world"));
    }

    #[test]
    fn test_upper_null() {
        let result = upper(&OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Trim Tests ---

    #[test]
    fn test_trim() {
        let result = trim(&OpValue::string("  hi  "), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("hi"));
    }

    #[test]
    fn test_trim_start() {
        let result = trim_start(&OpValue::string("  hi  "), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("hi  "));
    }

    #[test]
    fn test_trim_end() {
        let result = trim_end(&OpValue::string("  hi  "), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("  hi"));
    }

    // --- Length Tests ---

    #[test]
    fn test_len_basic() {
        let result = len(&OpValue::string("hello"), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(5.0));
    }

    #[test]
    fn test_len_emoji() {
        // Family emoji is one grapheme cluster
        let result = len(&OpValue::string("👨‍👩‍👧‍👦"), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(1.0));
    }

    #[test]
    fn test_len_null() {
        let result = len(&OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Substring Tests ---

    #[test]
    fn test_substring() {
        let result = substring(
            &OpValue::string("hello world"),
            &OpValue::number(0.0),
            &OpValue::number(5.0),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("hello"));
    }

    #[test]
    fn test_left() {
        let result = left(&OpValue::string("hello"), &OpValue::number(3.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("hel"));
    }

    #[test]
    fn test_right() {
        let result = right(&OpValue::string("hello"), &OpValue::number(3.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("llo"));
    }

    // --- Replace Tests ---

    #[test]
    fn test_replace() {
        let result = replace(
            &OpValue::string("hello world"),
            &OpValue::string("world"),
            &OpValue::string("universe"),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("hello universe"));
    }

    // --- Split/Join Tests ---

    #[test]
    fn test_split() {
        let result = split(&OpValue::string("a,b,c"), &OpValue::string(","), &ctx()).unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 3);
    }

    #[test]
    fn test_join() {
        let arr = OpValue::array(vec![
            serde_json::json!("a"),
            serde_json::json!("b"),
            serde_json::json!("c"),
        ]);
        let result = join(&arr, &OpValue::string("-"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("a-b-c"));
    }

    // --- Predicate Tests ---

    #[test]
    fn test_starts_with() {
        let result =
            starts_with(&OpValue::string("hello"), &OpValue::string("hel"), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));

        let result =
            starts_with(&OpValue::string("hello"), &OpValue::string("world"), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_ends_with() {
        let result = ends_with(&OpValue::string("hello"), &OpValue::string("llo"), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_contains() {
        let result = contains(
            &OpValue::string("hello world"),
            &OpValue::string("lo wo"),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    // --- Index Of Tests ---

    #[test]
    fn test_index_of_found() {
        let result = index_of(&OpValue::string("hello"), &OpValue::string("ell"), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(1.0));
    }

    #[test]
    fn test_index_of_not_found() {
        let result = index_of(&OpValue::string("hello"), &OpValue::string("xyz"), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(-1.0));
    }

    // --- Repeat Tests ---

    #[test]
    fn test_repeat() {
        let result = repeat(&OpValue::string("ab"), &OpValue::number(3.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("ababab"));
    }

    // --- Format Tests ---

    #[test]
    fn test_format_basic() {
        let args = vec![OpValue::string("Alice"), OpValue::number(5.0)];
        let result = format(
            &OpValue::string("Hello, {0}! You have {1} messages."),
            &args,
            &ctx(),
        )
        .unwrap();
        // Note: OpNode::Number(5.0) formats as "5" via f64 Display (trims trailing .0)
        assert_eq!(
            result,
            OpValue::string("Hello, Alice! You have 5 messages.")
        );
    }

    #[test]
    fn test_format_no_args() {
        let result = format(&OpValue::string("Hello, world!"), &[], &ctx()).unwrap();
        assert_eq!(result, OpValue::string("Hello, world!"));
    }

    #[test]
    fn test_format_null() {
        let result = format(&OpValue::null(), &[OpValue::string("arg")], &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Normalize Tests ---

    #[test]
    fn test_normalize_nfc() {
        // é as e + combining acute (NFD form) should become single é (NFC form)
        let nfd_e = "e\u{0301}"; // e + combining acute accent
        let result = normalize(&OpValue::string(nfd_e), &OpValue::string("NFC"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("é"));
    }

    #[test]
    fn test_normalize_nfd() {
        let result = normalize(&OpValue::string("é"), &OpValue::string("NFD"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("e\u{0301}"));
    }

    #[test]
    fn test_normalize_invalid_form() {
        let result = normalize(
            &OpValue::string("test"),
            &OpValue::string("INVALID"),
            &ctx(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_normalize_null() {
        let result = normalize(&OpValue::null(), &OpValue::string("NFC"), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Case Fold Tests ---

    #[test]
    fn test_case_fold_basic() {
        let result = case_fold(&OpValue::string("HELLO"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("hello"));
    }

    #[test]
    fn test_case_fold_german_ss() {
        // German ß case-folds to "ss"
        let result = case_fold(&OpValue::string("ß"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("ss"));
    }

    #[test]
    fn test_case_fold_null() {
        let result = case_fold(&OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- JSON Parse Tests ---

    #[test]
    fn test_json_parse_string() {
        let result = json_parse(&OpValue::string(r#""hello""#), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("hello"));
    }

    #[test]
    fn test_json_parse_number() {
        let result = json_parse(&OpValue::string("42"), &ctx()).unwrap();
        assert_eq!(result, OpValue::from(serde_json::json!(42)));
    }

    #[test]
    fn test_json_parse_array() {
        let result = json_parse(&OpValue::string("[1,2,3]"), &ctx()).unwrap();
        assert_eq!(result, OpValue::from(serde_json::json!([1, 2, 3])));
    }

    #[test]
    fn test_json_parse_object() {
        let result = json_parse(&OpValue::string(r#"{"a":1}"#), &ctx()).unwrap();
        assert_eq!(result, OpValue::from(serde_json::json!({"a": 1})));
    }

    #[test]
    fn test_json_parse_invalid_returns_null() {
        let result = json_parse(&OpValue::string("not valid json {"), &ctx()).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_json_parse_null_propagation() {
        let result = json_parse(&OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_json_parse_non_string_passthrough() {
        let result = json_parse(&OpValue::number(42.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(42.0));
    }

    #[test]
    fn test_json_parse_array_of_strings() {
        // Simulates map(value_json) output — array of JSON-encoded strings
        let input = OpValue::from(serde_json::json!([
            r#""hello""#,
            r#"42"#,
            r#"{"key":"val"}"#
        ]));
        let result = json_parse(&input, &ctx()).unwrap();
        assert_eq!(
            result,
            OpValue::from(serde_json::json!([
                "hello",
                42,
                {"key": "val"}
            ]))
        );
    }

    #[test]
    fn test_json_parse_array_mixed_types() {
        // Non-string elements pass through unchanged
        let input = OpValue::from(serde_json::json!([r#""decoded""#, 42, null]));
        let result = json_parse(&input, &ctx()).unwrap();
        assert_eq!(
            result,
            OpValue::from(serde_json::json!(["decoded", 42, null]))
        );
    }

    #[test]
    fn test_json_parse_double_encoded() {
        // Double-encoded JSON: json_parse → json_parse
        let double = r#""\"inner\"""#; // JSON-encoded JSON string
        let first = json_parse(&OpValue::string(double), &ctx()).unwrap();
        assert_eq!(first, OpValue::string(r#""inner""#.to_string()));
        let second = json_parse(&first, &ctx()).unwrap();
        assert_eq!(second, OpValue::string("inner"));
    }

    #[test]
    fn test_json_parse_bundle_then_regex() {
        // End-to-end: JSON-encoded JS bundle → json_parse → regex_extract
        // This is the exact discover-requires use case
        let js_code = r#"var _react = require("react"); var z = require("zustand");"#;
        let json_encoded = serde_json::to_string(&serde_json::json!(js_code)).unwrap();
        // json_encoded is: "\"var _react = require(\\\"react\\\"); var z = require(\\\"zustand\\\");\""

        let parsed = json_parse(&OpValue::string(&json_encoded), &ctx()).unwrap();
        // parsed should be the raw JS code string
        assert_eq!(parsed, OpValue::string(js_code));

        // Now regex_extract should find the require() calls
        let pattern = r#"require\(['"]([^'"]+)['"]\)"#;
        let matches = regex_extract(&parsed, &OpValue::string(pattern), &ctx()).unwrap();
        assert_eq!(
            matches,
            OpValue::from(serde_json::json!(["react", "zustand"]))
        );
    }

    // --- Regex Extract Tests ---

    #[test]
    fn test_regex_extract_cjs_requires() {
        let bundle = r#"var React = require("react"); var UI = require('@/components/ui'); var z = require("zustand");"#;
        let pattern = r#"require\(['"]([^'"]+)['"]\)"#;
        let result =
            regex_extract(&OpValue::string(bundle), &OpValue::string(pattern), &ctx()).unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(
            OpValue::from_arc(std::sync::Arc::clone(&arr[0])),
            OpValue::from(serde_json::json!("react"))
        );
        assert_eq!(
            OpValue::from_arc(std::sync::Arc::clone(&arr[1])),
            OpValue::from(serde_json::json!("@/components/ui"))
        );
        assert_eq!(
            OpValue::from_arc(std::sync::Arc::clone(&arr[2])),
            OpValue::from(serde_json::json!("zustand"))
        );
    }

    #[test]
    fn test_regex_extract_no_matches() {
        let result = regex_extract(
            &OpValue::string("no requires here"),
            &OpValue::string(r#"require\(['"]([^'"]+)['"]\)"#),
            &ctx(),
        )
        .unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 0);
    }

    #[test]
    fn test_regex_extract_no_capture_group() {
        let result = regex_extract(
            &OpValue::string("abc 123 def 456"),
            &OpValue::string(r"\d+"),
            &ctx(),
        )
        .unwrap();
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(
            OpValue::from_arc(std::sync::Arc::clone(&arr[0])),
            OpValue::from(serde_json::json!("123"))
        );
        assert_eq!(
            OpValue::from_arc(std::sync::Arc::clone(&arr[1])),
            OpValue::from(serde_json::json!("456"))
        );
    }

    #[test]
    fn test_regex_extract_null() {
        let result = regex_extract(&OpValue::null(), &OpValue::string(r"\d+"), &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_regex_extract_invalid_pattern() {
        let result = regex_extract(
            &OpValue::string("test"),
            &OpValue::string(r"[invalid"),
            &ctx(),
        );
        assert!(result.is_err());
    }
}
