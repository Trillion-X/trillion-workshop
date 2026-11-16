//! Structural data access operations: get, keys, set, merge
//!
//! These operations provide irreducible lens-like primitives for navigating
//! and manipulating object and array structures. They work on both objects
//! (with string keys) and arrays (with numeric indices) without requiring
//! type dispatch from the caller.
//!
//! Performance: All operations use Arc-based structural sharing (P1) for O(log n)
//! mutations via `im::HashMap::update()` and `im::Vector::set()`. No deep clones.
//!
//! Nullability: All operations propagate null gracefully:
//! - `get(null, key)` returns null
//! - `keys(null)` returns empty array
//! - `set(null, key, value)` creates a new object `{key: value}`
//! - `merge(null, obj)` returns obj

use crate::value::OpNode;
use crate::{EvalContext, OpError, OpValue};
use std::sync::Arc;

/// Get a value by key (object) or index (array). Returns null for missing keys.
///
/// # Behavior
/// - **Object**: `get({a: 1, b: 2}, "a")` → `1`
/// - **Array**: `get([10, 20, 30], 1)` → `20`
/// - **Null input**: `get(null, "key")` → `null`
/// - **Missing key**: `get({a: 1}, "b")` → `null`
/// - **Out of bounds**: `get([1, 2], 10)` → `null`
/// - **Type mismatch**: `get(42, "key")` → error
pub fn get(value: &OpValue, key: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match value.node() {
        OpNode::Null => Ok(OpValue::null()),
        OpNode::Object(map) => {
            let k = key.as_str("get")?;
            match map.get(&Arc::from(k)) {
                Some(v) => Ok(OpValue::from_arc(Arc::clone(v))),
                None => Ok(OpValue::null()),
            }
        }
        OpNode::Array(arr) => {
            let idx = key.as_f64("get")? as usize;
            match arr.get(idx) {
                Some(v) => Ok(OpValue::from_arc(Arc::clone(v))),
                None => Ok(OpValue::null()),
            }
        }
        _ => Err(OpError::TypeMismatch {
            operation: "get".to_string(),
            expected: "object, array, or null".to_string(),
            actual: value.type_name().to_string(),
        }),
    }
}

/// Get all keys (object) or indices (array). Returns empty array for null or non-containers.
///
/// # Behavior
/// - **Object**: `keys({a: 1, b: 2})` → `["a", "b"]` (order arbitrary)
/// - **Array**: `keys([10, 20, 30])` → `[0, 1, 2]`
/// - **Null input**: `keys(null)` → `[]`
/// - **Scalar**: `keys(42)` → `[]`
pub fn keys(value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match value.node() {
        OpNode::Null => Ok(OpValue::from_arc(OpNode::array(im::Vector::new()))),
        OpNode::Object(map) => {
            let key_nodes: im::Vector<Arc<OpNode>> = map
                .keys()
                .map(|k| Arc::new(OpNode::String(Arc::clone(k))))
                .collect();
            Ok(OpValue::from_arc(OpNode::array(key_nodes)))
        }
        OpNode::Array(arr) => {
            let index_nodes: im::Vector<Arc<OpNode>> = (0..arr.len())
                .map(|i| Arc::new(OpNode::Number(i as f64)))
                .collect();
            Ok(OpValue::from_arc(OpNode::array(index_nodes)))
        }
        _ => Ok(OpValue::from_arc(OpNode::array(im::Vector::new()))),
    }
}

/// Immutably set a key on an object or index on an array.
///
/// Uses `im::HashMap::update()` for O(log n) path-copy (P1 structural sharing).
/// Creates a new object if input is null. Extends array if index is out of bounds.
///
/// # Behavior
/// - **Object set**: `set({a: 1}, "b", 2)` → `{a: 1, b: 2}` (unchanged subtrees shared via Arc)
/// - **Object overwrite**: `set({a: 1}, "a", 99)` → `{a: 99}`
/// - **Set on null**: `set(null, "k", 1)` → `{k: 1}`
/// - **Array set**: `set([10, 20], 1, 99)` → `[10, 99]`
/// - **Array extend**: `set([10], 3, 99)` → `[10, null, null, 99]`
/// - **Type mismatch**: `set(42, "key", 1)` → error
pub fn set(
    target: &OpValue,
    key: &OpValue,
    val: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let val_node = val.arc_node();
    match target.node() {
        OpNode::Null => {
            // Create new object from null
            let k = key.as_str("set")?;
            let mut map = im::HashMap::new();
            map.insert(Arc::from(k), val_node);
            Ok(OpValue::from_arc(OpNode::object(map)))
        }
        OpNode::Object(map) => {
            let k = key.as_str("set")?;
            let new_map = map.update(Arc::from(k), val_node);
            Ok(OpValue::from_arc(OpNode::object(new_map)))
        }
        OpNode::Array(arr) => {
            let idx = key.as_f64("set")? as usize;
            let mut new_arr = arr.clone();
            // Extend array with nulls if index is out of bounds
            while new_arr.len() <= idx {
                new_arr.push_back(OpNode::null());
            }
            new_arr.set(idx, val_node);
            Ok(OpValue::from_arc(OpNode::array(new_arr)))
        }
        _ => Err(OpError::TypeMismatch {
            operation: "set".to_string(),
            expected: "object, array, or null".to_string(),
            actual: target.type_name().to_string(),
        }),
    }
}

/// Shallow merge two objects. Source keys override target.
///
/// Returns source if target is null, target if source is null.
/// Non-objects produce a type error.
///
/// # Behavior
/// - **Object merge**: `merge({a: 1, b: 2}, {b: 99, c: 3})` → `{a: 1, b: 99, c: 3}`
/// - **Merge with null (target)**: `merge(null, {a: 1})` → `{a: 1}`
/// - **Merge with null (source)**: `merge({a: 1}, null)` → `{a: 1}`
/// - **Type mismatch**: `merge({}, 42)` → error
pub fn merge(target: &OpValue, source: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    match (target.node(), source.node()) {
        (OpNode::Null, _) => Ok(source.clone()),
        (_, OpNode::Null) => Ok(target.clone()),
        (OpNode::Object(t_map), OpNode::Object(s_map)) => {
            let mut result = t_map.clone();
            for (k, v) in s_map.iter() {
                result.insert(Arc::clone(k), Arc::clone(v));
            }
            Ok(OpValue::from_arc(OpNode::object(result)))
        }
        _ => Err(OpError::TypeMismatch {
            operation: "merge".to_string(),
            expected: "object or null".to_string(),
            actual: format!("{} and {}", target.type_name(), source.type_name()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ==========================================================================
    // UNIT TESTS: GET
    // ==========================================================================

    #[test]
    fn test_get_from_object() {
        let obj = OpValue::from(json!({"a": 1, "b": 2}));
        let key = OpValue::string("a");
        let ctx = EvalContext::fast();
        let result = get(&obj, &key, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!(1)));
    }

    #[test]
    fn test_get_from_object_missing_key() {
        let obj = OpValue::from(json!({"a": 1}));
        let key = OpValue::string("missing");
        let ctx = EvalContext::fast();
        let result = get(&obj, &key, &ctx).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_get_from_array() {
        let arr = OpValue::from(json!([10, 20, 30]));
        let key = OpValue::number(1.0);
        let ctx = EvalContext::fast();
        let result = get(&arr, &key, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!(20)));
    }

    #[test]
    fn test_get_from_array_out_of_bounds() {
        let arr = OpValue::from(json!([10, 20]));
        let key = OpValue::number(10.0);
        let ctx = EvalContext::fast();
        let result = get(&arr, &key, &ctx).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_get_from_null() {
        let null_val = OpValue::null();
        let key = OpValue::string("key");
        let ctx = EvalContext::fast();
        let result = get(&null_val, &key, &ctx).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_get_type_error() {
        let num = OpValue::number(42.0);
        let key = OpValue::string("key");
        let ctx = EvalContext::fast();
        let result = get(&num, &key, &ctx);
        assert!(result.is_err());
    }

    // ==========================================================================
    // UNIT TESTS: KEYS
    // ==========================================================================

    #[test]
    fn test_keys_from_object() {
        let obj = OpValue::from(json!({"a": 1, "b": 2}));
        let ctx = EvalContext::fast();
        let result = keys(&obj, &ctx).unwrap();
        assert!(result.is_array());
        let arr = result.as_array("test").unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn test_keys_from_array() {
        let arr = OpValue::from(json!([10, 20, 30]));
        let ctx = EvalContext::fast();
        let result = keys(&arr, &ctx).unwrap();
        assert!(result.is_array());
        let indices = result.as_array("test").unwrap();
        assert_eq!(indices.len(), 3);
        // Verify indices are [0, 1, 2]
        assert_eq!(
            OpValue::from_arc(Arc::clone(&indices[0])),
            OpValue::number(0.0)
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&indices[1])),
            OpValue::number(1.0)
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&indices[2])),
            OpValue::number(2.0)
        );
    }

    #[test]
    fn test_keys_from_null() {
        let null_val = OpValue::null();
        let ctx = EvalContext::fast();
        let result = keys(&null_val, &ctx).unwrap();
        assert!(result.is_array());
        assert_eq!(result.as_array("test").unwrap().len(), 0);
    }

    #[test]
    fn test_keys_from_scalar() {
        let num = OpValue::number(42.0);
        let ctx = EvalContext::fast();
        let result = keys(&num, &ctx).unwrap();
        assert!(result.is_array());
        assert_eq!(result.as_array("test").unwrap().len(), 0);
    }

    // ==========================================================================
    // UNIT TESTS: SET
    // ==========================================================================

    #[test]
    fn test_set_on_object() {
        let obj = OpValue::from(json!({"a": 1}));
        let key = OpValue::string("b");
        let val = OpValue::number(2.0);
        let ctx = EvalContext::fast();
        let result = set(&obj, &key, &val, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"a": 1, "b": 2})));
    }

    #[test]
    fn test_set_on_object_overwrite() {
        let obj = OpValue::from(json!({"a": 1}));
        let key = OpValue::string("a");
        let val = OpValue::number(99.0);
        let ctx = EvalContext::fast();
        let result = set(&obj, &key, &val, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"a": 99})));
    }

    #[test]
    fn test_set_on_null_creates_object() {
        let null_val = OpValue::null();
        let key = OpValue::string("k");
        let val = OpValue::number(1.0);
        let ctx = EvalContext::fast();
        let result = set(&null_val, &key, &val, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"k": 1})));
    }

    #[test]
    fn test_set_on_array() {
        let arr = OpValue::from(json!([10, 20]));
        let key = OpValue::number(1.0);
        let val = OpValue::number(99.0);
        let ctx = EvalContext::fast();
        let result = set(&arr, &key, &val, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!([10, 99])));
    }

    #[test]
    fn test_set_on_array_extend() {
        let arr = OpValue::from(json!([10]));
        let key = OpValue::number(3.0);
        let val = OpValue::number(99.0);
        let ctx = EvalContext::fast();
        let result = set(&arr, &key, &val, &ctx).unwrap();
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 4);
        // Index 3 should be 99
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[3])),
            OpValue::number(99.0)
        );
        // Index 1 and 2 should be null
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[1])),
            OpValue::null()
        );
        assert_eq!(
            OpValue::from_arc(Arc::clone(&result_arr[2])),
            OpValue::null()
        );
    }

    #[test]
    fn test_set_type_error() {
        let num = OpValue::number(42.0);
        let key = OpValue::string("key");
        let val = OpValue::number(1.0);
        let ctx = EvalContext::fast();
        let result = set(&num, &key, &val, &ctx);
        assert!(result.is_err());
    }

    // ==========================================================================
    // UNIT TESTS: MERGE
    // ==========================================================================

    #[test]
    fn test_merge_two_objects() {
        let target = OpValue::from(json!({"a": 1, "b": 2}));
        let source = OpValue::from(json!({"b": 99, "c": 3}));
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"a": 1, "b": 99, "c": 3})));
    }

    #[test]
    fn test_merge_with_null_target() {
        let source = OpValue::from(json!({"a": 1}));
        let target = OpValue::null();
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx).unwrap();
        assert_eq!(result, source);
    }

    #[test]
    fn test_merge_with_null_source() {
        let target = OpValue::from(json!({"a": 1}));
        let source = OpValue::null();
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx).unwrap();
        assert_eq!(result, target);
    }

    #[test]
    fn test_merge_both_null() {
        let target = OpValue::null();
        let source = OpValue::null();
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx).unwrap();
        assert_eq!(result, OpValue::null());
    }

    #[test]
    fn test_merge_type_error_target_not_object() {
        let target = OpValue::number(42.0);
        let source = OpValue::from(json!({"a": 1}));
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx);
        assert!(result.is_err());
    }

    #[test]
    fn test_merge_type_error_source_not_object() {
        let target = OpValue::from(json!({"a": 1}));
        let source = OpValue::number(42.0);
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx);
        assert!(result.is_err());
    }

    // ==========================================================================
    // P1 STRUCTURAL SHARING TESTS
    // ==========================================================================

    #[test]
    fn test_p1_set_unchanged_subtrees_share_arc() {
        let obj = OpValue::from(json!({"a": {"nested": 1}, "b": 2}));
        let key = OpValue::string("c");
        let val = OpValue::number(3.0);
        let ctx = EvalContext::fast();
        let result = set(&obj, &key, &val, &ctx).unwrap();

        // Both should have the "a" key and it should point to the same Arc
        let orig_map = obj.as_object_arc().unwrap();
        let result_map = result.as_object_arc().unwrap();

        let orig_a = orig_map.get(&Arc::from("a")).unwrap();
        let result_a = result_map.get(&Arc::from("a")).unwrap();

        // Verify the Arc pointers are identical (structural sharing, not deep clone)
        assert!(Arc::ptr_eq(orig_a, result_a));
    }

    #[test]
    fn test_p1_merge_shared_keys_use_source() {
        let target = OpValue::from(json!({"a": {"x": 1}, "b": 2}));
        let source = OpValue::from(json!({"a": {"y": 2}, "c": 3}));
        let ctx = EvalContext::fast();
        let result = merge(&target, &source, &ctx).unwrap();

        let result_map = result.as_object_arc().unwrap();
        let result_a = result_map.get(&Arc::from("a")).unwrap();
        let source_a = source
            .as_object_arc()
            .unwrap()
            .get(&Arc::from("a"))
            .unwrap();

        // Verify source's "a" is used (Arc pointer identical)
        assert!(Arc::ptr_eq(result_a, source_a));
    }

    // ==========================================================================
    // ADVERSARIAL COMPOSITION TESTS (L069)
    // ==========================================================================

    #[test]
    fn test_adversarial_get_get() {
        // get(get(obj, "a"), "b")
        let obj = OpValue::from(json!({"a": {"b": 42}}));
        let key_a = OpValue::string("a");
        let key_b = OpValue::string("b");
        let ctx = EvalContext::fast();

        let inner = get(&obj, &key_a, &ctx).unwrap();
        let result = get(&inner, &key_b, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!(42)));
    }

    #[test]
    fn test_adversarial_set_set() {
        // set(set(obj, "a", 1), "b", 2)
        let obj = OpValue::from(json!({}));
        let key_a = OpValue::string("a");
        let key_b = OpValue::string("b");
        let val_1 = OpValue::number(1.0);
        let val_2 = OpValue::number(2.0);
        let ctx = EvalContext::fast();

        let intermediate = set(&obj, &key_a, &val_1, &ctx).unwrap();
        let result = set(&intermediate, &key_b, &val_2, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"a": 1, "b": 2})));
    }

    #[test]
    fn test_adversarial_merge_merge() {
        // merge(merge(a, b), c)
        let a = OpValue::from(json!({"x": 1}));
        let b = OpValue::from(json!({"y": 2}));
        let c = OpValue::from(json!({"z": 3}));
        let ctx = EvalContext::fast();

        let intermediate = merge(&a, &b, &ctx).unwrap();
        let result = merge(&intermediate, &c, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"x": 1, "y": 2, "z": 3})));
    }

    #[test]
    fn test_adversarial_keys_merge() {
        // keys(merge(a, b))
        let a = OpValue::from(json!({"a": 1}));
        let b = OpValue::from(json!({"b": 2}));
        let ctx = EvalContext::fast();

        let merged = merge(&a, &b, &ctx).unwrap();
        let result = keys(&merged, &ctx).unwrap();
        assert!(result.is_array());
        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 2);
    }

    #[test]
    fn test_adversarial_get_set() {
        // get(set(obj, "k", v), "k") should return v
        let obj = OpValue::from(json!({"a": 1}));
        let key = OpValue::string("k");
        let val = OpValue::number(99.0);
        let ctx = EvalContext::fast();

        let set_result = set(&obj, &key, &val, &ctx).unwrap();
        let get_result = get(&set_result, &key, &ctx).unwrap();
        assert_eq!(get_result, val);
    }

    #[test]
    fn test_adversarial_set_on_null() {
        // set(null, "a", set(null, "b", 1))
        let ctx = EvalContext::fast();
        let null_val = OpValue::null();
        let key_a = OpValue::string("a");
        let key_b = OpValue::string("b");
        let val_1 = OpValue::number(1.0);

        let inner_set = set(&null_val, &key_b, &val_1, &ctx).unwrap();
        let result = set(&null_val, &key_a, &inner_set, &ctx).unwrap();
        assert_eq!(result, OpValue::from(json!({"a": {"b": 1}})));
    }

    #[test]
    fn test_adversarial_merge_with_null() {
        // merge(null, obj) should return obj
        // merge(obj, null) should return obj
        let obj = OpValue::from(json!({"a": 1}));
        let null_val = OpValue::null();
        let ctx = EvalContext::fast();

        let result1 = merge(&null_val, &obj, &ctx).unwrap();
        let result2 = merge(&obj, &null_val, &ctx).unwrap();

        assert_eq!(result1, obj);
        assert_eq!(result2, obj);
    }

    #[test]
    fn test_adversarial_merge_conflicting_keys() {
        // merge(set(null, "a", 1), set(null, "a", 2)) should have "a": 2
        let ctx = EvalContext::fast();
        let key = OpValue::string("a");
        let val_1 = OpValue::number(1.0);
        let val_2 = OpValue::number(2.0);

        let obj1 = set(&OpValue::null(), &key, &val_1, &ctx).unwrap();
        let obj2 = set(&OpValue::null(), &key, &val_2, &ctx).unwrap();
        let result = merge(&obj1, &obj2, &ctx).unwrap();

        assert_eq!(result, OpValue::from(json!({"a": 2})));
    }

    #[test]
    fn test_adversarial_keys_nested() {
        // keys(set(null, "a", set(null, "b", 1)))
        let ctx = EvalContext::fast();
        let key_a = OpValue::string("a");
        let key_b = OpValue::string("b");
        let val = OpValue::number(1.0);

        let inner = set(&OpValue::null(), &key_b, &val, &ctx).unwrap();
        let outer = set(&OpValue::null(), &key_a, &inner, &ctx).unwrap();
        let result = keys(&outer, &ctx).unwrap();

        let result_arr = result.as_array("test").unwrap();
        assert_eq!(result_arr.len(), 1);
    }
}
