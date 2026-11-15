//! Array operators for ops-core
//!
//! This module implements array manipulation operators with proper null handling.
//!
//! # Null Handling
//!
//! Most array operators propagate null:
//! - length(null) = 0 (special case)
//! - first(null) = null
//! - nth([1, 2], null) = null

use crate::value::{opnode_to_json_value, OpNode};
use crate::{EvalContext, OpError, OpValue};
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use std::sync::Arc;

// =============================================================================
// SIZE OPERATIONS
// =============================================================================

/// Get the length of an array.
///
/// length(null) = 0 (special case, matches Excel behavior)
pub fn length(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match arr.as_array_or_null("length")? {
        Some(array) => Ok(OpValue::number(array.len() as f64)),
        None => Ok(OpValue::number(0.0)), // null returns 0
    }
}

/// Alias for length.
pub fn count(arr: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    length(arr, ctx)
}

// =============================================================================
// ELEMENT ACCESS
// =============================================================================

/// Get the first element of an array.
///
/// Returns null if array is empty or null.
pub fn first(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match arr.as_array_or_null("first")? {
        Some(array) => {
            if array.is_empty() {
                Ok(OpValue::null())
            } else {
                Ok(OpValue::from_arc(Arc::clone(&array[0])))
            }
        }
        None => Ok(OpValue::null()),
    }
}

/// Get the last element of an array.
///
/// Returns null if array is empty or null.
pub fn last(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match arr.as_array_or_null("last")? {
        Some(array) => {
            if array.is_empty() {
                Ok(OpValue::null())
            } else {
                Ok(OpValue::from_arc(Arc::clone(&array[array.len() - 1])))
            }
        }
        None => Ok(OpValue::null()),
    }
}

/// Get the element at a specific index (0-based).
///
/// Returns an error if index is out of bounds.
/// Returns null if array or index is null.
pub fn nth(arr: &OpValue, index: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("nth")?;
    let index_opt = index.as_i64_or_null("nth")?;

    match (array_opt, index_opt) {
        (Some(array), Some(idx)) => {
            if idx < 0 {
                return Err(OpError::IndexOutOfBounds {
                    operation: "nth".to_string(),
                    index: idx,
                    length: array.len(),
                });
            }
            let i = idx as usize;
            if i >= array.len() {
                return Err(OpError::IndexOutOfBounds {
                    operation: "nth".to_string(),
                    index: idx,
                    length: array.len(),
                });
            }
            Ok(OpValue::from_arc(Arc::clone(&array[i])))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Get the element at index, returning a default if out of bounds.
pub fn nth_or_default(
    arr: &OpValue,
    index: &OpValue,
    default: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("nth_or_default")?;
    let index_opt = index.as_i64_or_null("nth_or_default")?;

    match (array_opt, index_opt) {
        (Some(array), Some(idx)) => {
            if idx < 0 || (idx as usize) >= array.len() {
                Ok(default.clone())
            } else {
                Ok(OpValue::from_arc(Arc::clone(&array[idx as usize])))
            }
        }
        _ => Ok(default.clone()),
    }
}

// =============================================================================
// ARRAY MODIFICATION
// =============================================================================

/// Append a value to the end of an array.
///
/// Returns a new array with the value appended.
pub fn append(arr: &OpValue, value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("append")?;

    match array_opt {
        Some(array) => {
            let mut new_arr = array.clone();
            new_arr.push_back(value.arc_node());
            Ok(OpValue::from_arc(OpNode::array(new_arr)))
        }
        None => Ok(OpValue::null()),
    }
}

/// Prepend a value to the start of an array.
///
/// Returns a new array with the value prepended.
pub fn prepend(arr: &OpValue, value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("prepend")?;

    match array_opt {
        Some(array) => {
            let mut new_arr = im::Vector::new();
            new_arr.push_front(value.arc_node());
            new_arr.extend(array.iter().cloned());
            Ok(OpValue::from_arc(OpNode::array(new_arr)))
        }
        None => Ok(OpValue::null()),
    }
}

/// Concatenate two arrays.
///
/// Returns a new array with elements from both arrays.
pub fn concat_arrays(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let a_opt = a.as_array_or_null("concat_arrays")?;
    let b_opt = b.as_array_or_null("concat_arrays")?;

    match (a_opt, b_opt) {
        (Some(arr_a), Some(arr_b)) => {
            let mut result = arr_a.clone();
            result.extend(arr_b.iter().cloned());
            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Reverse an array.
///
/// Returns a new array with elements in reverse order.
pub fn reverse(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("reverse")?;

    match array_opt {
        Some(array) => {
            let reversed: im::Vector<Arc<OpNode>> = array.iter().rev().cloned().collect();
            Ok(OpValue::from_arc(OpNode::array(reversed)))
        }
        None => Ok(OpValue::null()),
    }
}

/// Sort an array.
///
/// Numbers are sorted numerically, strings alphabetically.
/// Mixed types are grouped by type, then sorted within type.
pub fn sort(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("sort")?;

    match array_opt {
        Some(array) => {
            let mut sorted = array.clone();
            sorted.sort_by(|a, b| {
                let a_json = opnode_to_json_value(a);
                let b_json = opnode_to_json_value(b);
                compare_json_values(&a_json, &b_json)
            });
            Ok(OpValue::from_arc(OpNode::array(sorted)))
        }
        None => Ok(OpValue::null()),
    }
}

/// Helper: compare JSON values for sorting.
fn compare_json_values(a: &JsonValue, b: &JsonValue) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    match (a, b) {
        // Nulls first
        (JsonValue::Null, JsonValue::Null) => Ordering::Equal,
        (JsonValue::Null, _) => Ordering::Less,
        (_, JsonValue::Null) => Ordering::Greater,

        // Booleans (false < true)
        (JsonValue::Bool(ab), JsonValue::Bool(bb)) => ab.cmp(bb),

        // Numbers
        (JsonValue::Number(an), JsonValue::Number(bn)) => {
            let af = an.as_f64().unwrap_or(0.0);
            let bf = bn.as_f64().unwrap_or(0.0);
            af.partial_cmp(&bf).unwrap_or(Ordering::Equal)
        }

        // Strings
        (JsonValue::String(as_), JsonValue::String(bs)) => as_.cmp(bs),

        // Different types: order by type
        _ => type_order(a).cmp(&type_order(b)),
    }
}

fn type_order(v: &JsonValue) -> u8 {
    match v {
        JsonValue::Null => 0,
        JsonValue::Bool(_) => 1,
        JsonValue::Number(_) => 2,
        JsonValue::String(_) => 3,
        JsonValue::Array(_) => 4,
        JsonValue::Object(_) => 5,
    }
}

/// Sort an array of objects by a named field.
///
/// `direction`: "asc" (default) or "desc".
///
/// Uses the same comparison semantics as `sort` (nulls first, type-ordered).
/// Objects without the named field are sorted as if the field value is null.
///
/// Universal operation: every data table needs sorting by column.
pub fn sort_by(
    arr: &OpValue,
    field: &OpValue,
    direction: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("sort_by")?;
    let field_str = field.as_str_opt("sort_by")?;

    match (array_opt, field_str) {
        (Some(array), Some(f)) => {
            let desc = direction
                .as_str_opt("sort_by")?
                .map(|d| d == "desc")
                .unwrap_or(false);

            let mut sorted = array.clone();
            let f_arc = Arc::from(f);
            sorted.sort_by(|a, b| {
                let va = match a.as_ref() {
                    OpNode::Object(obj) => obj
                        .get(&f_arc)
                        .map(|v| opnode_to_json_value(v))
                        .unwrap_or(JsonValue::Null),
                    _ => JsonValue::Null,
                };
                let vb = match b.as_ref() {
                    OpNode::Object(obj) => obj
                        .get(&f_arc)
                        .map(|v| opnode_to_json_value(v))
                        .unwrap_or(JsonValue::Null),
                    _ => JsonValue::Null,
                };
                let cmp = compare_json_values(&va, &vb);
                if desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            });
            Ok(OpValue::from_arc(OpNode::array(sorted)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Remove duplicates from an array.
///
/// Preserves first occurrence of each value.
pub fn unique(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("unique")?;

    match array_opt {
        Some(array) => {
            let mut seen = HashSet::new();
            let mut result = im::Vector::new();

            for item in array {
                // Use JSON string representation as key
                let key = opnode_to_json_value(item).to_string();
                if seen.insert(key) {
                    result.push_back(Arc::clone(item));
                }
            }

            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        None => Ok(OpValue::null()),
    }
}

/// Flatten a nested array one level.
///
/// [[1, 2], [3, 4]] -> [1, 2, 3, 4]
pub fn flatten(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("flatten")?;

    match array_opt {
        Some(array) => {
            let mut result = im::Vector::new();

            for item in array {
                if let OpNode::Array(inner) = item.as_ref() {
                    for elem in inner {
                        result.push_back(Arc::clone(elem));
                    }
                } else {
                    result.push_back(Arc::clone(item));
                }
            }

            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        None => Ok(OpValue::null()),
    }
}

// =============================================================================
// SEARCH OPERATIONS
// =============================================================================

/// Check if an array contains a value.
///
/// Uses deep equality comparison.
pub fn includes(arr: &OpValue, value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("includes")?;

    match array_opt {
        Some(array) => {
            let found = array
                .iter()
                .any(|item| OpValue::are_equal(&OpValue::from_arc(Arc::clone(item)), value));
            Ok(OpValue::bool(found))
        }
        None => Ok(OpValue::null()),
    }
}

/// Find the index of a value in an array.
///
/// Returns -1 if not found.
pub fn index_of(arr: &OpValue, value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("index_of")?;

    match array_opt {
        Some(array) => {
            let position = array
                .iter()
                .position(|item| OpValue::are_equal(&OpValue::from_arc(Arc::clone(item)), value));
            match position {
                Some(idx) => Ok(OpValue::number(idx as f64)),
                None => Ok(OpValue::number(-1.0)),
            }
        }
        None => Ok(OpValue::null()),
    }
}

/// Find the first element in an array where element[field] == value.
///
/// Generic: works for ANY array of objects with ANY field name and ANY match value.
/// Quintillion users querying quintillion tables all use the same find_by.
///
/// find_by([{a:1,b:2},{a:3,b:4}], "a", 3) = {a:3,b:4}
/// find_by([{a:1},{a:2}], "a", 99) = null (no match)
/// find_by([], "a", 1) = null (empty array)
/// find_by(null, ...) = null (null propagation)
/// find_by(non_array, ...) = TypeMismatch error
pub fn find_by(
    arr: &OpValue,
    field: &OpValue,
    value: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("find_by")?;
    let field_str = field.as_str_opt("find_by")?;

    match (array_opt, field_str) {
        (Some(array), Some(f)) => {
            for item in array {
                let item_op = OpValue::from_arc(Arc::clone(item));
                let field_val = lookup(&item_op, &OpValue::string(f.to_string()), None, _ctx)?;
                if OpValue::are_equal(&field_val, value) {
                    return Ok(item_op);
                }
            }
            Ok(OpValue::null())
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// SLICE OPERATIONS
// =============================================================================

/// Take the first n elements of an array.
pub fn take(arr: &OpValue, n: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("take")?;
    let count_opt = n.as_usize_or_null("take")?;

    match (array_opt, count_opt) {
        (Some(array), Some(count)) => {
            let result: im::Vector<Arc<OpNode>> = array.iter().take(count).cloned().collect();
            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Skip the first n elements of an array.
pub fn skip(arr: &OpValue, n: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("skip")?;
    let count_opt = n.as_usize_or_null("skip")?;

    match (array_opt, count_opt) {
        (Some(array), Some(count)) => {
            let result: im::Vector<Arc<OpNode>> = array.iter().skip(count).cloned().collect();
            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Slice an array from start to end index.
pub fn slice(
    arr: &OpValue,
    start: &OpValue,
    end: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("slice")?;
    let start_opt = start.as_usize_or_null("slice")?;
    let end_opt = end.as_usize_or_null("slice")?;

    match (array_opt, start_opt, end_opt) {
        (Some(array), Some(s), Some(e)) => {
            let start_idx = s.min(array.len());
            let end_idx = e.min(array.len());
            let result: im::Vector<Arc<OpNode>> = array
                .iter()
                .skip(start_idx)
                .take(end_idx - start_idx)
                .cloned()
                .collect();
            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        _ => Ok(OpValue::null()),
    }
}

// =============================================================================
// LOOKUP OPERATIONS
// =============================================================================

/// Lookup a value in an object or array by key/index.
///
/// lookup(container, key_or_index, [fallback])
///
/// - For objects: looks up by string key
/// - For arrays: looks up by integer index
/// - Returns fallback if key/index not found (defaults to null)
pub fn lookup(
    container: &OpValue,
    key_or_index: &OpValue,
    fallback: Option<&OpValue>,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    use std::sync::Arc;

    let default_val = fallback.cloned().unwrap_or_else(OpValue::null);

    if container.is_null() {
        return Ok(default_val);
    }

    match container.node() {
        // Object lookup
        OpNode::Object(obj) => {
            let key_opt = key_or_index.as_str_opt("lookup")?;
            match key_opt {
                Some(key) => {
                    let key_arc = Arc::from(key);
                    match obj.get(&key_arc) {
                        Some(v) => Ok(OpValue::from_arc(Arc::clone(v))),
                        None => Ok(default_val),
                    }
                }
                None => Ok(default_val),
            }
        }
        // Array lookup
        OpNode::Array(arr) => {
            let index_opt = key_or_index.as_i64_or_null("lookup")?;
            match index_opt {
                Some(idx) => {
                    if idx < 0 {
                        return Err(OpError::InvalidArgument {
                            operation: "lookup".to_string(),
                            reason: "Array index must be >= 0".to_string(),
                        });
                    }
                    let i = idx as usize;
                    match arr.get(i) {
                        Some(v) => Ok(OpValue::from_arc(Arc::clone(v))),
                        None => Ok(default_val),
                    }
                }
                None => Ok(default_val),
            }
        }
        _ => Err(OpError::TypeMismatch {
            operation: "lookup".to_string(),
            expected: "object or array".to_string(),
            actual: container.type_name().to_string(),
        }),
    }
}

// =============================================================================
// HIGHER-ORDER FUNCTIONS
// =============================================================================

/// Filter an array based on a pre-computed mask.
///
/// This function accepts a pre-computed array of boolean flags indicating
/// which elements to keep.
///
/// filter_with_mask(array, mask_array) - keeps elements where mask is true
pub fn filter_with_mask(
    arr: &OpValue,
    mask: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("filter")?;
    let mask_opt = mask.as_array_or_null("filter")?;

    match (array_opt, mask_opt) {
        (Some(array), Some(mask_arr)) => {
            let mut result = im::Vector::new();

            for (item, keep) in array.iter().zip(mask_arr.iter()) {
                if let OpNode::Bool(b) = keep.as_ref() {
                    if *b {
                        result.push_back(Arc::clone(item));
                    }
                }
            }

            Ok(OpValue::from_arc(OpNode::array(result)))
        }
        _ => Ok(OpValue::null()),
    }
}

/// Count elements matching a pre-computed mask.
///
/// This function accepts a pre-computed boolean array where true indicates
/// elements to count.
pub fn count_if_mask(
    arr: &OpValue,
    mask: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let array_opt = arr.as_array_or_null("count_if")?;
    let mask_opt = mask.as_array_or_null("count_if")?;

    match (array_opt, mask_opt) {
        (Some(_array), Some(mask_arr)) => {
            let count = mask_arr
                .iter()
                .filter(|v| matches!(v.as_ref(), OpNode::Bool(true)))
                .count();
            Ok(OpValue::number(count as f64))
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
    use serde_json::json;

    fn ctx() -> EvalContext {
        EvalContext::default()
    }

    fn make_array(values: Vec<serde_json::Value>) -> OpValue {
        OpValue::array(values)
    }

    // --- Length Tests ---

    #[test]
    fn test_length() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = length(&arr, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(3.0));
    }

    #[test]
    fn test_length_null() {
        let result = length(&OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(0.0));
    }

    #[test]
    fn test_length_empty() {
        let arr = make_array(vec![]);
        let result = length(&arr, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(0.0));
    }

    // --- Element Access Tests ---

    #[test]
    fn test_first() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = first(&arr, &ctx()).unwrap();
        assert_eq!(result, OpValue::from(json!(1)));
    }

    #[test]
    fn test_first_empty() {
        let arr = make_array(vec![]);
        let result = first(&arr, &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_last() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = last(&arr, &ctx()).unwrap();
        assert_eq!(result, OpValue::from(json!(3)));
    }

    #[test]
    fn test_nth() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = nth(&arr, &OpValue::number(1.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::from(json!(2)));
    }

    #[test]
    fn test_nth_out_of_bounds() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = nth(&arr, &OpValue::number(10.0), &ctx());
        assert!(result.is_err());
    }

    // --- Modification Tests ---

    #[test]
    fn test_append() {
        let arr = make_array(vec![json!(1), json!(2)]);
        let result = append(&arr, &OpValue::number(3.0), &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 3);
    }

    #[test]
    fn test_prepend() {
        let arr = make_array(vec![json!(2), json!(3)]);
        let result = prepend(&arr, &OpValue::number(1.0), &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[0])),
            OpValue::from(json!(1.0))
        );
    }

    #[test]
    fn test_concat_arrays() {
        let a = make_array(vec![json!(1), json!(2)]);
        let b = make_array(vec![json!(3), json!(4)]);
        let result = concat_arrays(&a, &b, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 4);
    }

    #[test]
    fn test_reverse() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = reverse(&arr, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[0])),
            OpValue::from(json!(3))
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[2])),
            OpValue::from(json!(1))
        );
    }

    #[test]
    fn test_unique() {
        let arr = make_array(vec![json!(1), json!(2), json!(1), json!(3), json!(2)]);
        let result = unique(&arr, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 3);
    }

    #[test]
    fn test_flatten() {
        let arr = make_array(vec![json!([1, 2]), json!([3, 4]), json!(5)]);
        let result = flatten(&arr, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 5);
    }

    // --- Search Tests ---

    #[test]
    fn test_includes_found() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = includes(&arr, &OpValue::number(2.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_includes_not_found() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = includes(&arr, &OpValue::number(5.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_index_of_found() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = index_of(&arr, &OpValue::number(2.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(1.0));
    }

    #[test]
    fn test_index_of_not_found() {
        let arr = make_array(vec![json!(1), json!(2), json!(3)]);
        let result = index_of(&arr, &OpValue::number(5.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(-1.0));
    }

    // --- Slice Tests ---

    #[test]
    fn test_take() {
        let arr = make_array(vec![json!(1), json!(2), json!(3), json!(4)]);
        let result = take(&arr, &OpValue::number(2.0), &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 2);
    }

    #[test]
    fn test_skip() {
        let arr = make_array(vec![json!(1), json!(2), json!(3), json!(4)]);
        let result = skip(&arr, &OpValue::number(2.0), &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 2);
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[0])),
            OpValue::from(json!(3))
        );
    }

    #[test]
    fn test_sort() {
        let arr = make_array(vec![json!(3), json!(1), json!(2)]);
        let result = sort(&arr, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[0])).as_inner(),
            json!(1)
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[1])).as_inner(),
            json!(2)
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[2])).as_inner(),
            json!(3)
        );
    }

    // --- Lookup Tests ---

    #[test]
    fn test_lookup_object() {
        let mut obj = serde_json::Map::new();
        obj.insert("a".to_string(), json!(1));
        obj.insert("b".to_string(), json!(2));
        let container = OpValue::object(obj);

        let result = lookup(&container, &OpValue::string("a"), None, &ctx()).unwrap();
        assert_eq!(result, OpValue::from(json!(1)));
    }

    #[test]
    fn test_lookup_object_missing_key() {
        let mut obj = serde_json::Map::new();
        obj.insert("a".to_string(), json!(1));
        let container = OpValue::object(obj);

        let result = lookup(&container, &OpValue::string("missing"), None, &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_lookup_object_with_fallback() {
        let mut obj = serde_json::Map::new();
        obj.insert("a".to_string(), json!(1));
        let container = OpValue::object(obj);

        let result = lookup(
            &container,
            &OpValue::string("missing"),
            Some(&OpValue::string("default")),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("default"));
    }

    #[test]
    fn test_lookup_array() {
        let arr = make_array(vec![json!("a"), json!("b"), json!("c")]);

        let result = lookup(&arr, &OpValue::number(1.0), None, &ctx()).unwrap();
        assert_eq!(result, OpValue::from(json!("b")));
    }

    #[test]
    fn test_lookup_array_out_of_bounds() {
        let arr = make_array(vec![json!("a"), json!("b")]);

        let result = lookup(
            &arr,
            &OpValue::number(10.0),
            Some(&OpValue::string("default")),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("default"));
    }

    // --- Filter/Count Tests ---

    #[test]
    fn test_filter_with_mask() {
        let arr = make_array(vec![json!(1), json!(2), json!(3), json!(4)]);
        let mask = make_array(vec![json!(true), json!(false), json!(true), json!(false)]);

        let result = filter_with_mask(&arr, &mask, &ctx()).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 2);
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[0])).as_inner(),
            json!(1)
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[1])).as_inner(),
            json!(3)
        );
    }

    #[test]
    fn test_count_if_mask() {
        let arr = make_array(vec![json!(1), json!(2), json!(3), json!(4)]);
        let mask = make_array(vec![json!(true), json!(false), json!(true), json!(true)]);

        let result = count_if_mask(&arr, &mask, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(3.0));
    }
}
