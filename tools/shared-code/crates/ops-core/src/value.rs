//! Value type for operator semantics
//!
//! OpValue wraps a custom OpNode enum (instead of serde_json::Value) to provide
//! reference semantics with Arc-based structural sharing for O(1) clone and O(log n)
//! mutations via persistent im::HashMap and im::Vector.
//!
//! This enables P1 (Structural Sharing) performance for operators that manipulate
//! data structures like set/merge/get.
//!
//! serde_json::Value is used ONLY at serialization boundaries (deserialization and
//! legacy conversions), never in hot-path operations.

use crate::OpError;
use rust_decimal::prelude::*;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value as JsonValue;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

/// Physics-level limits for JSON crossings into and out of [`OpValue`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonConversionBudget {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_string_bytes: usize,
    pub max_total_bytes: usize,
}

impl Default for JsonConversionBudget {
    fn default() -> Self {
        Self {
            max_depth: 512,
            max_nodes: 262_144,
            max_string_bytes: 16 * 1024 * 1024,
            max_total_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JsonConversionError {
    #[error("FE_PAYLOAD_TOO_DEEP: JSON depth {observed} exceeds limit {limit}")]
    TooDeep { observed: usize, limit: usize },
    #[error("FE_PAYLOAD_TOO_LARGE: JSON node count {observed} exceeds limit {limit}")]
    TooManyNodes { observed: usize, limit: usize },
    #[error("FE_PAYLOAD_TOO_LARGE: JSON bytes {observed_bytes} exceeds limit {limit_bytes}")]
    TooLarge {
        observed_bytes: usize,
        limit_bytes: usize,
    },
    #[error("FE_RESOURCE_POLICY_INVALID: {field}: {reason}")]
    InvalidPolicy { field: String, reason: String },
}

impl JsonConversionBudget {
    pub fn validate(&self) -> Result<(), JsonConversionError> {
        for (field, value) in [
            ("max_depth", self.max_depth),
            ("max_nodes", self.max_nodes),
            ("max_string_bytes", self.max_string_bytes),
            ("max_total_bytes", self.max_total_bytes),
        ] {
            if value == 0 {
                return Err(JsonConversionError::InvalidPolicy {
                    field: field.to_string(),
                    reason: "must be greater than zero".to_string(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct JsonCharge {
    nodes: usize,
    string_bytes: usize,
    total_bytes: usize,
}

fn checked_charge(
    charge: &mut JsonCharge,
    budget: &JsonConversionBudget,
    string_bytes: usize,
    allocation_bytes: usize,
) -> Result<(), JsonConversionError> {
    charge.nodes = charge
        .nodes
        .checked_add(1)
        .ok_or(JsonConversionError::TooManyNodes {
            observed: usize::MAX,
            limit: budget.max_nodes,
        })?;
    if charge.nodes > budget.max_nodes {
        return Err(JsonConversionError::TooManyNodes {
            observed: charge.nodes,
            limit: budget.max_nodes,
        });
    }
    charge.string_bytes =
        charge
            .string_bytes
            .checked_add(string_bytes)
            .ok_or(JsonConversionError::TooLarge {
                observed_bytes: usize::MAX,
                limit_bytes: budget.max_string_bytes,
            })?;
    if charge.string_bytes > budget.max_string_bytes {
        return Err(JsonConversionError::TooLarge {
            observed_bytes: charge.string_bytes,
            limit_bytes: budget.max_string_bytes,
        });
    }
    charge.total_bytes =
        charge
            .total_bytes
            .checked_add(allocation_bytes)
            .ok_or(JsonConversionError::TooLarge {
                observed_bytes: usize::MAX,
                limit_bytes: budget.max_total_bytes,
            })?;
    if charge.total_bytes > budget.max_total_bytes {
        return Err(JsonConversionError::TooLarge {
            observed_bytes: charge.total_bytes,
            limit_bytes: budget.max_total_bytes,
        });
    }
    Ok(())
}

/// Validate and convert JSON without consuming attacker-controlled native stack.
pub fn try_from_json_with_budget(
    value: &JsonValue,
    budget: &JsonConversionBudget,
) -> Result<OpValue, JsonConversionError> {
    budget.validate()?;
    let mut charge = JsonCharge::default();
    let mut validation = vec![(value, 1usize)];
    while let Some((current, depth)) = validation.pop() {
        if depth > budget.max_depth {
            return Err(JsonConversionError::TooDeep {
                observed: depth,
                limit: budget.max_depth,
            });
        }
        let (strings, bytes) = match current {
            JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => (0, 16),
            JsonValue::String(s) => (s.len(), 16usize.saturating_add(s.len())),
            JsonValue::Array(values) => {
                for child in values.iter().rev() {
                    validation.push((child, depth + 1));
                }
                (0, 24usize.saturating_add(values.len().saturating_mul(16)))
            }
            JsonValue::Object(values) => {
                let key_bytes = values.keys().map(|key| key.len()).sum::<usize>();
                for child in values.values().rev() {
                    validation.push((child, depth + 1));
                }
                (
                    key_bytes,
                    48usize
                        .saturating_add(key_bytes)
                        .saturating_add(values.len().saturating_mul(32)),
                )
            }
        };
        checked_charge(&mut charge, budget, strings, bytes)?;
    }

    enum Frame<'a> {
        Visit(&'a JsonValue),
        Array(usize),
        Object(Vec<Arc<str>>),
    }
    let mut work = vec![Frame::Visit(value)];
    let mut built: Vec<Arc<OpNode>> = Vec::new();
    while let Some(frame) = work.pop() {
        match frame {
            Frame::Visit(JsonValue::Null) => built.push(OpNode::null()),
            Frame::Visit(JsonValue::Bool(value)) => built.push(OpNode::bool(*value)),
            Frame::Visit(JsonValue::Number(value)) => {
                built.push(OpNode::number(value.as_f64().unwrap_or(0.0)))
            }
            Frame::Visit(JsonValue::String(value)) => {
                built.push(OpNode::string(Arc::from(value.as_str())))
            }
            Frame::Visit(JsonValue::Array(values)) => {
                work.push(Frame::Array(values.len()));
                for child in values.iter().rev() {
                    work.push(Frame::Visit(child));
                }
            }
            Frame::Visit(JsonValue::Object(values)) => {
                let keys = values.keys().map(|key| Arc::from(key.as_str())).collect();
                work.push(Frame::Object(keys));
                for child in values.values().rev() {
                    work.push(Frame::Visit(child));
                }
            }
            Frame::Array(len) => {
                let start = built.len() - len;
                let values = built.drain(start..).collect::<Vec<_>>();
                built.push(OpNode::array(im::Vector::from(values)));
            }
            Frame::Object(keys) => {
                let start = built.len() - keys.len();
                let values = built.drain(start..).collect::<Vec<_>>();
                let mut map = im::HashMap::new();
                for (key, value) in keys.into_iter().zip(values) {
                    map.insert(key, value);
                }
                built.push(OpNode::object(map));
            }
        }
    }
    Ok(OpValue(
        built.pop().expect("root conversion always emits one node"),
    ))
}

/// Convert an [`OpValue`] back to JSON under the same structural and byte budget.
pub fn try_to_json_with_budget(
    value: &OpValue,
    budget: &JsonConversionBudget,
) -> Result<JsonValue, JsonConversionError> {
    budget.validate()?;
    let mut charge = JsonCharge::default();
    let mut validation = vec![(value.node(), 1usize)];
    while let Some((current, depth)) = validation.pop() {
        if depth > budget.max_depth {
            return Err(JsonConversionError::TooDeep {
                observed: depth,
                limit: budget.max_depth,
            });
        }
        let (strings, bytes) = match current {
            OpNode::Null | OpNode::Bool(_) | OpNode::Number(_) => (0, 16),
            OpNode::String(s) => (s.len(), 16usize.saturating_add(s.len())),
            OpNode::Array(values) => {
                for child in values.iter().rev() {
                    validation.push((child.as_ref(), depth + 1));
                }
                (0, 24usize.saturating_add(values.len().saturating_mul(16)))
            }
            OpNode::Object(values) => {
                let key_bytes = values.keys().map(|key| key.len()).sum::<usize>();
                for child in values.values() {
                    validation.push((child.as_ref(), depth + 1));
                }
                (
                    key_bytes,
                    48usize
                        .saturating_add(key_bytes)
                        .saturating_add(values.len().saturating_mul(32)),
                )
            }
        };
        checked_charge(&mut charge, budget, strings, bytes)?;
    }
    Ok(opnode_to_json_value(value.node()))
}

/// The internal representation of OpValue — custom enum with Arc-based sharing.
///
/// `OpNode` uses `im::HashMap<Arc<str>, Arc<OpNode>>` and `im::Vector<Arc<OpNode>>`
/// for structural sharing: mutating one entry/element creates a new collection that
/// shares unchanged entries/elements via Arc pointers with the original (O(log n) path-copy).
///
/// This replaces `serde_json::Value` which uses value semantics (every clone is O(total)).
#[derive(Clone, Debug)]
pub enum OpNode {
    Null,
    Bool(bool),
    Number(f64),
    String(Arc<str>),
    Array(im::Vector<Arc<OpNode>>),
    Object(im::HashMap<Arc<str>, Arc<OpNode>>),
}

// Implement PartialEq and Eq manually (f64 doesn't implement Eq due to NaN)
impl PartialEq for OpNode {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (OpNode::Null, OpNode::Null) => true,
            (OpNode::Bool(a), OpNode::Bool(b)) => a == b,
            (OpNode::Number(a), OpNode::Number(b)) => {
                // Handle NaN: in our semantics, NaN == NaN
                if a.is_nan() && b.is_nan() {
                    true
                } else {
                    a == b
                }
            }
            (OpNode::String(a), OpNode::String(b)) => a == b,
            (OpNode::Array(a), OpNode::Array(b)) => a == b,
            (OpNode::Object(a), OpNode::Object(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for OpNode {}

// Implement Hash manually (f64 doesn't implement Hash, but we need it for the collections)
// We use a lossy hash of the bits (excluding NaN special cases)
impl std::hash::Hash for OpNode {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            OpNode::Null => 0u8.hash(state),
            OpNode::Bool(b) => {
                1u8.hash(state);
                b.hash(state);
            }
            OpNode::Number(n) => {
                2u8.hash(state);
                n.to_bits().hash(state);
            }
            OpNode::String(s) => {
                3u8.hash(state);
                s.hash(state);
            }
            OpNode::Array(a) => {
                4u8.hash(state);
                a.len().hash(state);
            }
            OpNode::Object(o) => {
                5u8.hash(state);
                o.len().hash(state);
            }
        }
    }
}

impl OpNode {
    /// Create a null node
    pub fn null() -> Arc<Self> {
        Arc::new(OpNode::Null)
    }

    /// Create a boolean node
    pub fn bool(b: bool) -> Arc<Self> {
        Arc::new(OpNode::Bool(b))
    }

    /// Create a number node
    pub fn number(n: f64) -> Arc<Self> {
        Arc::new(OpNode::Number(n))
    }

    /// Create a string node from Arc<str>
    pub fn string(s: Arc<str>) -> Arc<Self> {
        Arc::new(OpNode::String(s))
    }

    /// Create a string node from &str (allocates)
    pub fn string_owned(s: &str) -> Arc<Self> {
        Arc::new(OpNode::String(Arc::from(s)))
    }

    /// Create a string node from a static string (zero alloc)
    pub fn string_static(s: &'static str) -> Arc<Self> {
        Arc::new(OpNode::String(Arc::from(s)))
    }

    /// Create an array node
    pub fn array(arr: im::Vector<Arc<OpNode>>) -> Arc<Self> {
        Arc::new(OpNode::Array(arr))
    }

    /// Create an object node
    pub fn object(obj: im::HashMap<Arc<str>, Arc<OpNode>>) -> Arc<Self> {
        Arc::new(OpNode::Object(obj))
    }
}

// Implement custom Deserialize to parse JSON directly into OpNode
impl<'de> Deserialize<'de> for OpNode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let json_value = JsonValue::deserialize(deserializer)?;
        try_from_json_with_budget(&json_value, &JsonConversionBudget::default())
            .map(|value| value.0.as_ref().clone())
            .map_err(serde::de::Error::custom)
    }
}

// Implement custom Serialize to output OpNode as JSON
impl Serialize for OpNode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let json_value = opnode_to_json_value(self);
        json_value.serialize(serializer)
    }
}

/// Convert an OpNode into a serde_json::Value without native recursion.
pub(crate) fn opnode_to_json_value(node: &OpNode) -> JsonValue {
    enum Frame<'a> {
        Visit(&'a OpNode),
        Array(usize),
        Object(Vec<String>),
    }
    let mut work = vec![Frame::Visit(node)];
    let mut built = Vec::new();
    while let Some(frame) = work.pop() {
        match frame {
            Frame::Visit(OpNode::Null) => built.push(JsonValue::Null),
            Frame::Visit(OpNode::Bool(value)) => built.push(JsonValue::Bool(*value)),
            Frame::Visit(OpNode::Number(value)) => {
                let value = *value;
                let json = if value.fract() == 0.0
                    && value.is_finite()
                    && value >= i64::MIN as f64
                    && value <= i64::MAX as f64
                {
                    JsonValue::Number(serde_json::Number::from(value as i64))
                } else {
                    serde_json::Number::from_f64(value)
                        .map(JsonValue::Number)
                        .unwrap_or(JsonValue::Null)
                };
                built.push(json);
            }
            Frame::Visit(OpNode::String(value)) => built.push(JsonValue::String(value.to_string())),
            Frame::Visit(OpNode::Array(values)) => {
                work.push(Frame::Array(values.len()));
                for child in values.iter().rev() {
                    work.push(Frame::Visit(child));
                }
            }
            Frame::Visit(OpNode::Object(values)) => {
                let entries = values.iter().collect::<Vec<_>>();
                let keys = entries
                    .iter()
                    .map(|(key, _)| key.to_string())
                    .collect::<Vec<_>>();
                work.push(Frame::Object(keys));
                for (_, child) in entries.into_iter().rev() {
                    work.push(Frame::Visit(child.as_ref()));
                }
            }
            Frame::Array(len) => {
                let start = built.len() - len;
                let values = built.drain(start..).collect();
                built.push(JsonValue::Array(values));
            }
            Frame::Object(keys) => {
                let start = built.len() - keys.len();
                let values = built.drain(start..).collect::<Vec<_>>();
                built.push(JsonValue::Object(keys.into_iter().zip(values).collect()));
            }
        }
    }
    built.pop().expect("root conversion always emits one value")
}

/// The operator evaluation runtime value type using the newtype pattern.
///
/// By wrapping `Arc<OpNode>` in our own struct, we create a distinct type
/// that we own. The internal data uses reference semantics with structural sharing
/// to enable O(1) clone and O(log n) mutations.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OpValue(pub(crate) Arc<OpNode>);

impl OpValue {
    /// Get a reference to the inner OpNode
    pub fn node(&self) -> &OpNode {
        &self.0
    }

    /// Get the inner Arc<OpNode>
    pub fn arc_node(&self) -> Arc<OpNode> {
        Arc::clone(&self.0)
    }

    /// Create an OpValue from an Arc<OpNode>
    pub fn from_arc(node: Arc<OpNode>) -> Self {
        OpValue(node)
    }

    /// Create an OpValue from an OpNode (wraps in Arc)
    pub fn from_node(node: OpNode) -> Self {
        OpValue(Arc::new(node))
    }

    /// Create a new null value
    pub fn null() -> Self {
        OpValue(OpNode::null())
    }

    /// Create a new boolean value
    pub fn bool(b: bool) -> Self {
        OpValue(OpNode::bool(b))
    }

    /// Create a new number value from f64
    pub fn number(n: f64) -> Self {
        OpValue(OpNode::number(n))
    }

    /// Create a new string value
    pub fn string<S: Into<String>>(s: S) -> Self {
        let s_string = s.into();
        OpValue(OpNode::string_owned(&s_string))
    }

    /// Compatibility constructor for statically bounded/trusted values.
    /// Production crossings must use [`Self::try_from_json_with_budget`].
    pub fn array(arr: Vec<JsonValue>) -> Self {
        OpValue::from(JsonValue::Array(arr))
    }

    /// Compatibility constructor for statically bounded/trusted values.
    /// Production crossings must use [`Self::try_from_json_with_budget`].
    pub fn object(obj: serde_json::Map<String, JsonValue>) -> Self {
        OpValue::from(JsonValue::Object(obj))
    }

    pub fn try_from_json_with_budget(
        value: &JsonValue,
        budget: &JsonConversionBudget,
    ) -> Result<Self, JsonConversionError> {
        try_from_json_with_budget(value, budget)
    }

    /// Create an OpValue array from a Vec<OpValue>
    pub fn from_op_array(arr: Vec<OpValue>) -> Self {
        let nodes: im::Vector<Arc<OpNode>> = arr.into_iter().map(|v| v.0).collect();
        OpValue(OpNode::array(nodes))
    }

    /// Create an OpValue from a rust_decimal::Decimal: a number whenever an f64 holds exactly that decimal (every
    /// sum of ordinary amounts does: 0.1 + 0.2 is 0.3), so an answer of strict arithmetic compares, sorts and adds
    /// like any number; the exact decimal text only when no f64 holds it (more digits than an f64 keeps).
    pub fn from_decimal(d: Decimal) -> Self {
        let d = d.normalize();
        if let Some(n) = d.to_f64().filter(|n| n.is_finite()) {
            if Decimal::from_str(&n.to_string()).ok() == Some(d) {
                return OpValue::number(n);
            }
        }
        OpValue::from(serde_json::json!(d))
    }

    /// Create an OpValue from an i64
    pub fn from_i64(n: i64) -> Self {
        OpValue(OpNode::number(n as f64))
    }

    /// Create an OpValue from a usize
    pub fn from_usize(n: usize) -> Self {
        OpValue(OpNode::number(n as f64))
    }

    /// Get the inner Arc<OpNode> and consume self
    pub fn into_arc(self) -> Arc<OpNode> {
        self.0
    }

    /// Get the inner serde_json::Value (converts from OpNode)
    pub fn into_inner(self) -> JsonValue {
        opnode_to_json_value(&self.0)
    }

    /// Get a reference to the inner value as serde_json::Value (allocates)
    pub fn as_inner(&self) -> JsonValue {
        opnode_to_json_value(&self.0)
    }

    /// Get an object as Arc<im::HashMap<Arc<str>, Arc<OpNode>>>
    pub fn as_object_arc(&self) -> Option<&im::HashMap<Arc<str>, Arc<OpNode>>> {
        match self.node() {
            OpNode::Object(map) => Some(map),
            _ => None,
        }
    }

    /// Get an array as Arc<im::Vector<Arc<OpNode>>>
    pub fn as_array_arc(&self) -> Option<&im::Vector<Arc<OpNode>>> {
        match self.node() {
            OpNode::Array(arr) => Some(arr),
            _ => None,
        }
    }

    /// Checks if a value is considered "truthy" in operator logic.
    ///
    /// Follows standard conventions:
    /// - `null` is falsy
    /// - `false` is falsy
    /// - `0` (and `0.0`) is falsy
    /// - `""` (empty string) is falsy
    /// - `[]` (empty array) is falsy
    /// - `{}` (empty object) is falsy
    /// - Everything else is truthy
    pub fn is_truthy(&self) -> bool {
        match self.node() {
            OpNode::Null => false,
            OpNode::Bool(b) => *b,
            OpNode::Number(n) => *n != 0.0,
            OpNode::String(s) => !s.is_empty(),
            OpNode::Array(a) => !a.is_empty(),
            OpNode::Object(o) => !o.is_empty(),
        }
    }

    /// Performs a deep equality check between two OpValues.
    ///
    /// This normalizes number comparisons to handle the case where one number
    /// came from a literal (f64) and another from JSON deserialization (integer).
    /// For example, `OpValue::number(0.0)` should equal an OpValue created from `json!(0)`.
    ///
    /// Special cases:
    /// - `NaN == NaN` returns `true` (unlike IEEE 754 standard)
    /// - Integer and float representations are compared by value (0 == 0.0)
    /// - Arrays and objects are compared recursively
    pub fn are_equal(a: &OpValue, b: &OpValue) -> bool {
        Self::nodes_equal(a.node(), b.node())
    }

    fn nodes_equal(a: &OpNode, b: &OpNode) -> bool {
        match (a, b) {
            // For numbers, compare as f64 to handle integer vs float representation
            (OpNode::Number(n1), OpNode::Number(n2)) => {
                // Handle NaN specially (NaN != NaN in IEEE 754, but we treat as equal)
                if n1.is_nan() && n2.is_nan() {
                    true
                } else {
                    n1 == n2
                }
            }
            // For arrays, compare element by element
            (OpNode::Array(arr1), OpNode::Array(arr2)) => {
                if arr1.len() != arr2.len() {
                    return false;
                }
                arr1.iter()
                    .zip(arr2.iter())
                    .all(|(v1, v2)| Self::nodes_equal(v1, v2))
            }
            // For objects, compare all key-value pairs
            (OpNode::Object(obj1), OpNode::Object(obj2)) => {
                if obj1.len() != obj2.len() {
                    return false;
                }
                obj1.iter()
                    .all(|(k, v1)| obj2.get(k).is_some_and(|v2| Self::nodes_equal(v1, v2)))
            }
            // For all other types, direct comparison
            (OpNode::Null, OpNode::Null) => true,
            (OpNode::Bool(b1), OpNode::Bool(b2)) => b1 == b2,
            (OpNode::String(s1), OpNode::String(s2)) => s1 == s2,
            _ => false,
        }
    }

    // --- Type Predicates ---

    pub fn is_null(&self) -> bool {
        matches!(self.node(), OpNode::Null)
    }

    pub fn is_bool(&self) -> bool {
        matches!(self.node(), OpNode::Bool(_))
    }

    pub fn is_number(&self) -> bool {
        matches!(self.node(), OpNode::Number(_))
    }

    pub fn is_string(&self) -> bool {
        matches!(self.node(), OpNode::String(_))
    }

    pub fn is_array(&self) -> bool {
        matches!(self.node(), OpNode::Array(_))
    }

    pub fn is_object(&self) -> bool {
        matches!(self.node(), OpNode::Object(_))
    }

    /// Get the type name of this value for error messages and debugging.
    pub fn type_name(&self) -> &'static str {
        match self.node() {
            OpNode::Null => "null",
            OpNode::Bool(_) => "boolean",
            OpNode::Number(_) => "number",
            OpNode::String(_) => "string",
            OpNode::Array(_) => "array",
            OpNode::Object(_) => "object",
        }
    }

    // --- Value Extraction Methods ---

    /// Extract the value as a rust_decimal::Decimal.
    ///
    /// This method preserves precision by checking for integer types first,
    /// then falling back to f64 conversion.
    pub fn as_decimal(&self, operation: &str) -> Result<Decimal, OpError> {
        match self.node() {
            OpNode::Number(n) => {
                // Try to convert as integer first to preserve precision
                let i = *n as i64;
                if (i as f64 - n).abs() < f64::EPSILON {
                    return Ok(Decimal::from(i));
                }
                Decimal::from_f64(*n).ok_or_else(|| OpError::ConversionError {
                    operation: operation.to_string(),
                    from: "f64".to_string(),
                    to: "Decimal".to_string(),
                })
            }
            OpNode::String(s) => Decimal::from_str(s).map_err(|_| OpError::ConversionError {
                operation: operation.to_string(),
                from: "string".to_string(),
                to: "Decimal".to_string(),
            }),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "number".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract the value as an f64.
    pub fn as_f64(&self, operation: &str) -> Result<f64, OpError> {
        match self.node() {
            OpNode::Number(n) => Ok(*n),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "number".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract the value as a boolean.
    pub fn as_bool(&self, operation: &str) -> Result<bool, OpError> {
        match self.node() {
            OpNode::Bool(b) => Ok(*b),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "boolean".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract the value as a string reference.
    pub fn as_str(&self, operation: &str) -> Result<&str, OpError> {
        match self.node() {
            OpNode::String(s) => Ok(s),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "string".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract the value as an array reference.
    pub fn as_array(&self, operation: &str) -> Result<&im::Vector<Arc<OpNode>>, OpError> {
        match self.node() {
            OpNode::Array(arr) => Ok(arr),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "array".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    // --- Tristate & Nullable Extraction Methods ---

    /// Extract boolean with tristate semantics (true, false, or null).
    /// Used by logical operators that implement SQL-style null propagation.
    pub fn as_bool_or_null(&self, operation: &str) -> Result<Option<bool>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            OpNode::Bool(b) => Ok(Some(*b)),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "boolean or null".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract a string, returning None for null, error for other types.
    pub fn as_str_opt(&self, operation: &str) -> Result<Option<&str>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            OpNode::String(s) => Ok(Some(s.as_ref())),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "string or null".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract an array, returning None for null.
    pub fn as_array_or_null(
        &self,
        operation: &str,
    ) -> Result<Option<&im::Vector<Arc<OpNode>>>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            OpNode::Array(arr) => Ok(Some(arr)),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "array or null".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract a number as f64, returning None for null.
    pub fn as_f64_or_null(&self, operation: &str) -> Result<Option<f64>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            OpNode::Number(n) => Ok(Some(*n)),
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "number or null".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract an integer, returning an error for non-integer values.
    pub fn as_i64(&self, operation: &str) -> Result<i64, OpError> {
        match self.node() {
            OpNode::Number(n) => {
                // Check if f64 is a whole number
                if n.fract() == 0.0
                    && n.is_finite()
                    && *n >= i64::MIN as f64
                    && *n <= i64::MAX as f64
                {
                    return Ok(*n as i64);
                }
                Err(OpError::TypeMismatch {
                    operation: operation.to_string(),
                    expected: "integer".to_string(),
                    actual: "non-integer number".to_string(),
                })
            }
            _ => Err(OpError::TypeMismatch {
                operation: operation.to_string(),
                expected: "integer".to_string(),
                actual: self.type_name().to_string(),
            }),
        }
    }

    /// Extract an integer, returning None for null.
    pub fn as_i64_or_null(&self, operation: &str) -> Result<Option<i64>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            _ => self.as_i64(operation).map(Some),
        }
    }

    /// Extract a usize (non-negative integer)
    pub fn as_usize(&self, operation: &str) -> Result<usize, OpError> {
        let i = self.as_i64(operation)?;
        if i < 0 {
            return Err(OpError::InvalidArgument {
                operation: operation.to_string(),
                reason: "expected non-negative integer".to_string(),
            });
        }
        Ok(i as usize)
    }

    /// Extract a usize, returning None for null.
    pub fn as_usize_or_null(&self, operation: &str) -> Result<Option<usize>, OpError> {
        match self.node() {
            OpNode::Null => Ok(None),
            _ => self.as_usize(operation).map(Some),
        }
    }

    /// Traverse a dotted path into this value.
    ///
    /// # Path Traversal Semantics
    ///
    /// This is the **canonical** path traversal for operators. It handles:
    /// - Dotted notation: "style.padding" → obj["style"]["padding"]
    /// - Array indices: "items.0.name" → obj["items"][0]["name"]
    /// - Mixed: "children.0.props.text" → nested access
    ///
    /// # Returns
    /// - The value at the path if found
    /// - `null` if any segment is missing or the path is invalid
    ///
    /// # Security
    /// - "__proto__", "prototype", "constructor" are forbidden keys
    /// - Invalid array indices return null (no panic)
    pub fn get_path(&self, path: &str) -> OpValue {
        // Forbidden keys for security (prototype pollution prevention)
        const FORBIDDEN: &[&str] = &["__proto__", "prototype", "constructor"];

        if path.is_empty() {
            return self.clone();
        }

        let segments: Vec<&str> = path.split('.').collect();
        let mut current = self.clone();

        for segment in segments {
            // Security: block forbidden keys
            if FORBIDDEN.contains(&segment) {
                return OpValue::null();
            }

            match current.node() {
                OpNode::Object(obj) => {
                    let key_arc = Arc::from(segment);
                    current = match obj.get(&key_arc) {
                        Some(v) => OpValue(Arc::clone(v)),
                        None => return OpValue::null(),
                    };
                }
                OpNode::Array(arr) => {
                    // Try to parse segment as array index
                    match segment.parse::<usize>() {
                        Ok(idx) if idx < arr.len() => {
                            current = OpValue(Arc::clone(&arr[idx]));
                        }
                        _ => return OpValue::null(),
                    }
                }
                _ => return OpValue::null(),
            }
        }

        current
    }

    /// Convert any value to its string representation.
    /// Used by text operators for type coercion.
    pub fn to_string_repr(&self) -> String {
        match self.node() {
            OpNode::Null => String::new(),
            OpNode::Bool(b) => b.to_string(),
            OpNode::Number(n) => n.to_string(),
            OpNode::String(s) => s.to_string(),
            OpNode::Array(_) | OpNode::Object(_) => opnode_to_json_value(self.node()).to_string(),
        }
    }
}

// Implement From trait for easy conversion from serde_json::Value
impl From<JsonValue> for OpValue {
    fn from(value: JsonValue) -> Self {
        let compatibility_budget = JsonConversionBudget {
            max_depth: usize::MAX,
            max_nodes: usize::MAX,
            max_string_bytes: usize::MAX,
            max_total_bytes: usize::MAX,
        };
        try_from_json_with_budget(&value, &compatibility_budget)
            .expect("trusted compatibility conversion cannot exceed usize limits")
    }
}

// Implement Into trait for conversion back to serde_json::Value
impl From<OpValue> for JsonValue {
    fn from(value: OpValue) -> Self {
        opnode_to_json_value(&value.0)
    }
}

// Implement Debug manually to provide clean output
impl fmt::Debug for OpValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpValue({:?})", self.node())
    }
}

// Implement Display for user-friendly output
impl fmt::Display for OpValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.node() {
            OpNode::Null => write!(f, "null"),
            OpNode::Bool(b) => write!(f, "{}", b),
            OpNode::Number(n) => write!(f, "{}", n),
            OpNode::String(s) => write!(f, "{}", s),
            OpNode::Array(_) => write!(f, "[...]"),
            OpNode::Object(_) => write!(f, "{{...}}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_opvalue_constructors() {
        assert!(OpValue::null().is_null());
        assert!(OpValue::bool(true).is_bool());
        assert!(OpValue::number(42.0).is_number());
        assert!(OpValue::string("hello").is_string());
        assert!(OpValue::array(vec![]).is_array());
        assert!(OpValue::object(serde_json::Map::new()).is_object());
    }

    #[test]
    fn test_truthiness_null() {
        assert!(!OpValue::null().is_truthy());
    }

    #[test]
    fn test_truthiness_bool() {
        assert!(OpValue::bool(true).is_truthy());
        assert!(!OpValue::bool(false).is_truthy());
    }

    #[test]
    fn test_truthiness_number() {
        assert!(!OpValue::number(0.0).is_truthy());
        assert!(OpValue::number(1.0).is_truthy());
        assert!(OpValue::number(-1.0).is_truthy());
    }

    #[test]
    fn test_truthiness_string() {
        assert!(!OpValue::string("").is_truthy());
        assert!(OpValue::string("hello").is_truthy());
    }

    #[test]
    fn test_truthiness_array() {
        assert!(!OpValue::array(vec![]).is_truthy());
        assert!(OpValue::array(vec![json!(1)]).is_truthy());
    }

    #[test]
    fn test_truthiness_object() {
        assert!(!OpValue::object(serde_json::Map::new()).is_truthy());
        let mut map = serde_json::Map::new();
        map.insert("key".to_string(), json!("value"));
        assert!(OpValue::object(map).is_truthy());
    }

    #[test]
    fn test_equality_integer_vs_float() {
        let int_zero = OpValue::from(json!(0));
        let float_zero = OpValue::number(0.0);
        assert!(OpValue::are_equal(&int_zero, &float_zero));
    }

    #[test]
    fn test_equality_nan() {
        let nan1 = OpValue::number(f64::NAN);
        let nan2 = OpValue::number(f64::NAN);
        // In our semantics, NaN == NaN
        assert!(OpValue::are_equal(&nan1, &nan2));
    }

    #[test]
    fn test_from_json_value() {
        let json_val = json!({"key": "value"});
        let op_val = OpValue::from(json_val.clone());
        assert_eq!(op_val.as_inner(), json_val);
    }

    #[test]
    fn test_into_inner() {
        let op_val = OpValue::string("test");
        let json_val = op_val.into_inner();
        assert_eq!(json_val, json!("test"));
    }

    // =========================================================================
    // Round-trip tests (L1 compliance)
    // =========================================================================

    #[test]
    fn round_trip_null() {
        let original = json!(null);
        let opval = OpValue::from(original.clone());
        let roundtrip = opval.into_inner();
        assert_eq!(original, roundtrip);
    }

    #[test]
    fn round_trip_bool() {
        for val in &[true, false] {
            let original = json!(val);
            let opval = OpValue::from(original.clone());
            let roundtrip = opval.into_inner();
            assert_eq!(original, roundtrip);
        }
    }

    #[test]
    fn round_trip_number() {
        // Integers round-trip exactly
        for val in &[0i64, 1, -1, 42, -999] {
            let original = json!(val);
            let opval = OpValue::from(original.clone());
            let roundtrip = opval.into_inner();
            assert_eq!(original, roundtrip, "integer {} should round-trip", val);
        }
        // Non-whole floats round-trip exactly
        for val in &[3.14159, -0.5, 1.5] {
            let original = json!(val);
            let opval = OpValue::from(original.clone());
            let roundtrip = opval.into_inner();
            assert_eq!(original, roundtrip, "float {} should round-trip", val);
        }
        // Whole-number floats (0.0, 1.0) collapse to integers — this is expected
        // since OpNode::Number(f64) can't distinguish 1 from 1.0
        let opval = OpValue::from(json!(1.0));
        assert_eq!(opval.into_inner(), json!(1));
    }

    #[test]
    fn round_trip_string() {
        let test_cases = vec!["", "hello", "with spaces", "emoji 🎉"];
        for s in test_cases {
            let original = json!(s);
            let opval = OpValue::from(original.clone());
            let roundtrip = opval.into_inner();
            assert_eq!(original, roundtrip);
        }
    }

    #[test]
    fn round_trip_array() {
        // Note: whole-number floats (3.0) collapse to integers (3) — expected behavior
        let original = json!([1, "two", 3, true, null]);
        let opval = OpValue::from(original.clone());
        let roundtrip = opval.into_inner();
        assert_eq!(original, roundtrip);
        // Non-whole floats preserved
        let original2 = json!([1.5, "two", 3.14, true, null]);
        let opval2 = OpValue::from(original2.clone());
        assert_eq!(original2, opval2.into_inner());
    }

    #[test]
    fn round_trip_object() {
        let original = json!({"a": 1, "b": "two", "c": [3, 4, 5]});
        let opval = OpValue::from(original.clone());
        let roundtrip = opval.into_inner();
        assert_eq!(original, roundtrip);
    }

    #[test]
    fn round_trip_deeply_nested() {
        let original = json!({
            "level1": {
                "level2": {
                    "level3": [1, 2, {"key": "value"}]
                }
            }
        });
        let opval = OpValue::from(original.clone());
        let roundtrip = opval.into_inner();
        assert_eq!(original, roundtrip);
    }

    // =========================================================================
    // P1 structural sharing tests (verify Arc::ptr_eq on unchanged entries)
    // =========================================================================

    #[test]
    fn p1_sharing_object_update() {
        // Create a large object
        let original = json!({
            "a": 1,
            "b": 2,
            "c": 3,
            "d": 4,
            "e": 5,
            "f": 6,
            "g": 7,
            "h": 8,
        });

        let opval1 = OpValue::from(original);
        let obj_map1 = opval1.as_object_arc().expect("should be object");

        // Simulate updating via im::HashMap::update (create a new version)
        let mut obj_map2 = obj_map1.clone();
        let new_value = Arc::new(OpNode::Number(999.0));
        obj_map2 = obj_map2.update(Arc::from("a"), new_value.clone());

        // Verify that unchanged entries share Arc pointers with the original
        // (This tests the core P1 property: Arc::ptr_eq on unchanged subtrees)
        let b1 = obj_map1.get(&Arc::from("b")).unwrap();
        let b2 = obj_map2.get(&Arc::from("b")).unwrap();
        assert!(
            Arc::ptr_eq(b1, b2),
            "unchanged entry 'b' should share Arc pointer"
        );

        let c1 = obj_map1.get(&Arc::from("c")).unwrap();
        let c2 = obj_map2.get(&Arc::from("c")).unwrap();
        assert!(
            Arc::ptr_eq(c1, c2),
            "unchanged entry 'c' should share Arc pointer"
        );

        // Verify that the updated entry is different
        let a1 = obj_map1.get(&Arc::from("a")).unwrap();
        let a2 = obj_map2.get(&Arc::from("a")).unwrap();
        assert!(
            !Arc::ptr_eq(a1, a2),
            "updated entry 'a' should have new Arc pointer"
        );
    }

    #[test]
    fn p1_sharing_array_update() {
        let original = json!([1, 2, 3, 4, 5]);
        let opval1 = OpValue::from(original);

        if let Some(arr1) = opval1.as_array_arc() {
            // Create a new array with first element changed
            let new_elem = Arc::new(OpNode::Number(999.0));
            let mut arr2 = arr1.clone();
            arr2.set(0, new_elem.clone());

            // Verify unchanged elements share Arc pointers
            assert!(
                Arc::ptr_eq(&arr1[1], &arr2[1]),
                "unchanged element at [1] should share Arc pointer"
            );
            assert!(
                Arc::ptr_eq(&arr1[2], &arr2[2]),
                "unchanged element at [2] should share Arc pointer"
            );
            assert!(
                Arc::ptr_eq(&arr1[3], &arr2[3]),
                "unchanged element at [3] should share Arc pointer"
            );
            assert!(
                Arc::ptr_eq(&arr1[4], &arr2[4]),
                "unchanged element at [4] should share Arc pointer"
            );

            // Verify changed element is different
            assert!(
                !Arc::ptr_eq(&arr1[0], &arr2[0]),
                "changed element at [0] should have new Arc pointer"
            );
        } else {
            panic!("Expected array");
        }
    }

    // =========================================================================
    // get_path tests
    // =========================================================================

    #[test]
    fn test_get_path_simple() {
        let obj = OpValue::from(json!({"name": "Alice"}));
        let result = obj.get_path("name");
        assert_eq!(result, OpValue::from(json!("Alice")));
    }

    #[test]
    fn test_get_path_nested() {
        let obj = OpValue::from(json!({"style": {"padding": 8, "color": "red"}}));
        assert_eq!(obj.get_path("style.padding"), OpValue::from(json!(8)));
        assert_eq!(obj.get_path("style.color"), OpValue::from(json!("red")));
    }

    #[test]
    fn test_get_path_deeply_nested() {
        let obj = OpValue::from(json!({
            "a": {"b": {"c": {"d": 42}}}
        }));
        assert_eq!(obj.get_path("a.b.c.d"), OpValue::from(json!(42)));
    }

    #[test]
    fn test_get_path_array_index() {
        let obj = OpValue::from(json!({"items": [10, 20, 30]}));
        assert_eq!(obj.get_path("items.0"), OpValue::from(json!(10)));
        assert_eq!(obj.get_path("items.1"), OpValue::from(json!(20)));
        assert_eq!(obj.get_path("items.2"), OpValue::from(json!(30)));
    }

    #[test]
    fn test_get_path_mixed_object_array() {
        let obj = OpValue::from(json!({
            "children": [
                {"name": "first", "value": 100},
                {"name": "second", "value": 200}
            ]
        }));
        assert_eq!(
            obj.get_path("children.0.name"),
            OpValue::from(json!("first"))
        );
        assert_eq!(obj.get_path("children.1.value"), OpValue::from(json!(200)));
    }

    #[test]
    fn test_get_path_missing_returns_null() {
        let obj = OpValue::from(json!({"style": {"padding": 8}}));
        assert!(obj.get_path("style.nonexistent").is_null());
        assert!(obj.get_path("nonexistent").is_null());
        assert!(obj.get_path("style.padding.deep").is_null());
    }

    #[test]
    fn test_get_path_empty_returns_self() {
        let obj = OpValue::from(json!({"name": "Alice"}));
        assert_eq!(obj.get_path(""), obj);
    }

    #[test]
    fn test_get_path_forbidden_keys_blocked() {
        let obj = OpValue::from(json!({"__proto__": "evil", "constructor": "bad"}));
        assert!(obj.get_path("__proto__").is_null());
        assert!(obj.get_path("constructor").is_null());
        assert!(obj.get_path("prototype").is_null());
    }

    #[test]
    fn test_get_path_array_index_out_of_bounds() {
        let obj = OpValue::from(json!({"items": [1, 2, 3]}));
        assert!(obj.get_path("items.99").is_null());
    }

    #[test]
    fn test_get_path_non_numeric_array_index() {
        let arr = OpValue::from(json!([1, 2, 3]));
        assert!(arr.get_path("foo").is_null());
    }

    #[test]
    fn test_get_path_on_primitive() {
        let num = OpValue::number(42.0);
        assert!(num.get_path("anything").is_null());

        let s = OpValue::string("hello");
        assert!(s.get_path("length").is_null());
    }
}
