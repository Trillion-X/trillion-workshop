// crates/workflow-core/src/api.rs
//
// Purpose:
//   Canonical workflow slot request types. These are the public wire contracts
//   the workflow slot accepts over Envelope dispatch.
//
// Non-Negotiable Invariants:
//   1. These DTOs belong to workflow, not the stone.
//   2. The canonical interactive execution contract is definition-shaped, not
//      action-shaped.
//   3. The handler deserializes these types directly — no unstructured JSON
//      routing as the primary contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FIELD_TUPLE_MAGIC: &[u8; 4] = b"BWF1";
const NAMED_FIELD_TUPLE_MAGIC: &[u8; 4] = b"BFN1";
const FIELD_TUPLE_HEADER_BYTES: usize = 6;
const FIELD_TUPLE_CELL_HEADER_BYTES: usize = 5;
const NAMED_FIELD_TUPLE_CELL_HEADER_BYTES: usize = 7;
const FIELD_TUPLE_TYPE_UTF8: u8 = 2;
const FIELD_TUPLE_TYPE_JSON: u8 = 3;
const FIELD_TUPLE_TYPE_BOOLEAN: u8 = 4;
const FIELD_TUPLE_TYPE_NULL: u8 = 5;
const FIELD_TUPLE_TYPE_F64: u8 = 6;

/// Canonical interactive workflow execution request.
///
/// This is the workflow-owned wire contract for "execute this definition with
/// this input". The caller does not tell workflow where the definition came
/// from; it only supplies the definition ID and input payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteDefinitionRequest {
    pub operation: String,
    pub definition_id: String,
    #[serde(default = "default_input")]
    pub input: Value,
    #[serde(default = "default_include_steps")]
    pub include_steps: bool,
    #[serde(default = "default_include_output")]
    pub include_output: bool,
    pub user_id: Option<String>,
    #[serde(default)]
    pub receipt: Option<ExecutionReceiptTarget>,
}

/// Optional workflow-owned receipt write requested by the caller.
///
/// The caller chooses the plain workflow address/path where a completion receipt
/// should be written. Workflow only records generic execution facts there; it
/// does not interpret the package meaning of the address.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionReceiptTarget {
    pub address: String,
    #[serde(default)]
    pub path: Vec<String>,
    #[serde(default)]
    pub partition_key: Option<String>,
    #[serde(default)]
    pub evidence: Value,
}

fn default_input() -> Value {
    Value::Object(serde_json::Map::new())
}

fn default_include_steps() -> bool {
    true
}

fn default_include_output() -> bool {
    true
}

impl ExecuteDefinitionRequest {
    pub const OPERATION: &'static str = "execute_definition";
}

pub fn decode_execute_definition_field_tuple(
    bytes: &[u8],
) -> Result<Option<ExecuteDefinitionRequest>, String> {
    if bytes.starts_with(NAMED_FIELD_TUPLE_MAGIC) {
        return decode_execute_definition_named_field_tuple(bytes).map(Some);
    }
    if !bytes.starts_with(FIELD_TUPLE_MAGIC) {
        return Ok(None);
    }
    if bytes.len() < FIELD_TUPLE_HEADER_BYTES {
        return Err("workflow execute-definition tuple header is truncated".to_string());
    }
    let field_count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if field_count != 2 {
        return Err(format!(
            "workflow execute-definition tuple expected 2 fields, got {field_count}"
        ));
    }
    let mut cursor = FIELD_TUPLE_HEADER_BYTES;
    let definition_id = read_field_tuple_cell(bytes, &mut cursor, FIELD_TUPLE_TYPE_UTF8)?;
    let input = read_field_tuple_cell(bytes, &mut cursor, FIELD_TUPLE_TYPE_JSON)?;
    if cursor != bytes.len() {
        return Err("workflow execute-definition tuple has trailing bytes".to_string());
    }
    let definition_id = std::str::from_utf8(definition_id)
        .map_err(|e| format!("workflow execute-definition id is not utf8: {e}"))?
        .to_string();
    if definition_id.trim().is_empty() {
        return Err("workflow execute-definition id is empty".to_string());
    }
    let input = serde_json::from_slice(input)
        .map_err(|e| format!("workflow execute-definition input decode failed: {e}"))?;
    Ok(Some(ExecuteDefinitionRequest {
        operation: ExecuteDefinitionRequest::OPERATION.to_string(),
        definition_id,
        input,
        include_steps: default_include_steps(),
        include_output: false,
        user_id: None,
        receipt: None,
    }))
}

fn decode_execute_definition_named_field_tuple(
    bytes: &[u8],
) -> Result<ExecuteDefinitionRequest, String> {
    if bytes.len() < FIELD_TUPLE_HEADER_BYTES {
        return Err("workflow execute-definition named tuple header is truncated".to_string());
    }
    let field_count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut cursor = FIELD_TUPLE_HEADER_BYTES;
    let mut payload = serde_json::Map::new();
    for _ in 0..field_count {
        let cell = read_named_field_tuple_cell(bytes, &mut cursor)?;
        set_json_path(&mut payload, &cell.path, cell.value)?;
    }
    if cursor != bytes.len() {
        return Err("workflow execute-definition named tuple has trailing bytes".to_string());
    }
    if !payload.contains_key("operation") {
        payload.insert(
            "operation".to_string(),
            Value::String(ExecuteDefinitionRequest::OPERATION.to_string()),
        );
    }
    if !payload.contains_key("input") {
        payload.insert("input".to_string(), Value::Object(serde_json::Map::new()));
    }
    if !payload.contains_key("include_steps") {
        payload.insert(
            "include_steps".to_string(),
            Value::Bool(default_include_steps()),
        );
    }
    if !payload.contains_key("include_output") {
        payload.insert("include_output".to_string(), Value::Bool(false));
    }
    if !payload.contains_key("user_id") {
        payload.insert("user_id".to_string(), Value::Null);
    }
    let request: ExecuteDefinitionRequest = serde_json::from_value(Value::Object(payload))
        .map_err(|error| {
            format!("workflow execute-definition named tuple request shape invalid: {error}")
        })?;
    if request.operation != ExecuteDefinitionRequest::OPERATION {
        return Err("workflow execute-definition named tuple operation is invalid".to_string());
    }
    if request.definition_id.trim().is_empty() {
        return Err("workflow execute-definition named tuple definition_id is empty".to_string());
    }
    Ok(request)
}

struct NamedFieldTupleCell {
    path: Vec<String>,
    value: Value,
}

fn read_named_field_tuple_cell(
    bytes: &[u8],
    cursor: &mut usize,
) -> Result<NamedFieldTupleCell, String> {
    let header_end = cursor
        .checked_add(NAMED_FIELD_TUPLE_CELL_HEADER_BYTES)
        .ok_or_else(|| {
            "workflow execute-definition named tuple cell offset overflow".to_string()
        })?;
    if header_end > bytes.len() {
        return Err("workflow execute-definition named tuple cell header is truncated".to_string());
    }
    let field_type = bytes[*cursor];
    let path_len = u16::from_le_bytes([bytes[*cursor + 1], bytes[*cursor + 2]]) as usize;
    let value_len = u32::from_le_bytes([
        bytes[*cursor + 3],
        bytes[*cursor + 4],
        bytes[*cursor + 5],
        bytes[*cursor + 6],
    ]) as usize;
    let path_start = header_end;
    let path_end = path_start.checked_add(path_len).ok_or_else(|| {
        "workflow execute-definition named tuple path length overflow".to_string()
    })?;
    let value_end = path_end.checked_add(value_len).ok_or_else(|| {
        "workflow execute-definition named tuple value length overflow".to_string()
    })?;
    if value_end > bytes.len() {
        return Err("workflow execute-definition named tuple cell is truncated".to_string());
    }
    let path = read_named_field_tuple_path(&bytes[path_start..path_end])?;
    let value = decode_named_field_tuple_value(field_type, &bytes[path_end..value_end])?;
    *cursor = value_end;
    Ok(NamedFieldTupleCell { path, value })
}

fn read_named_field_tuple_path(bytes: &[u8]) -> Result<Vec<String>, String> {
    let Some((&count, mut rest)) = bytes.split_first() else {
        return Err("workflow execute-definition named tuple path is empty".to_string());
    };
    let mut path = Vec::with_capacity(count as usize);
    for _ in 0..count {
        if rest.len() < 2 {
            return Err(
                "workflow execute-definition named tuple path segment header is truncated"
                    .to_string(),
            );
        }
        let len = u16::from_le_bytes([rest[0], rest[1]]) as usize;
        rest = &rest[2..];
        if rest.len() < len {
            return Err(
                "workflow execute-definition named tuple path segment is truncated".to_string(),
            );
        }
        let segment = std::str::from_utf8(&rest[..len])
            .map_err(|e| format!("workflow execute-definition named tuple path is not utf8: {e}"))?
            .to_string();
        if segment.is_empty() {
            return Err(
                "workflow execute-definition named tuple path segment is empty".to_string(),
            );
        }
        path.push(segment);
        rest = &rest[len..];
    }
    if !rest.is_empty() || path.is_empty() {
        return Err("workflow execute-definition named tuple path is malformed".to_string());
    }
    Ok(path)
}

fn decode_named_field_tuple_value(field_type: u8, bytes: &[u8]) -> Result<Value, String> {
    match field_type {
        FIELD_TUPLE_TYPE_UTF8 => std::str::from_utf8(bytes)
            .map(|value| Value::String(value.to_string()))
            .map_err(|e| {
                format!("workflow execute-definition named tuple utf8 decode failed: {e}")
            }),
        FIELD_TUPLE_TYPE_JSON => serde_json::from_slice(bytes).map_err(|e| {
            format!("workflow execute-definition named tuple json decode failed: {e}")
        }),
        FIELD_TUPLE_TYPE_BOOLEAN => match bytes {
            [0] => Ok(Value::Bool(false)),
            [1] => Ok(Value::Bool(true)),
            _ => {
                Err("workflow execute-definition named tuple boolean value is invalid".to_string())
            }
        },
        FIELD_TUPLE_TYPE_NULL => {
            if bytes.is_empty() {
                Ok(Value::Null)
            } else {
                Err("workflow execute-definition named tuple null value is not empty".to_string())
            }
        }
        FIELD_TUPLE_TYPE_F64 => {
            if bytes.len() != 8 {
                return Err(
                    "workflow execute-definition named tuple f64 value is not 8 bytes".to_string(),
                );
            }
            let value = f64::from_le_bytes(bytes.try_into().expect("length checked"));
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or_else(|| {
                    "workflow execute-definition named tuple f64 is not finite".to_string()
                })
        }
        _ => Err(format!(
            "workflow execute-definition named tuple unsupported field type {field_type}"
        )),
    }
}

fn set_json_path(
    root: &mut serde_json::Map<String, Value>,
    path: &[String],
    value: Value,
) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return Err("workflow execute-definition named tuple path is empty".to_string());
    };
    let mut object = root;
    for segment in parents {
        let entry = object
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        let Value::Object(child) = entry else {
            return Err(format!(
                "workflow execute-definition named tuple path collides at {segment}"
            ));
        };
        object = child;
    }
    object.insert(last.clone(), value);
    Ok(())
}

fn read_field_tuple_cell<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    expected_type: u8,
) -> Result<&'a [u8], String> {
    let header_end = cursor
        .checked_add(FIELD_TUPLE_CELL_HEADER_BYTES)
        .ok_or_else(|| "workflow execute-definition tuple cell offset overflow".to_string())?;
    if header_end > bytes.len() {
        return Err("workflow execute-definition tuple cell header is truncated".to_string());
    }
    let field_type = bytes[*cursor];
    if field_type != expected_type {
        return Err(format!(
            "workflow execute-definition tuple expected field type {expected_type}, got {field_type}"
        ));
    }
    let len = u32::from_le_bytes([
        bytes[*cursor + 1],
        bytes[*cursor + 2],
        bytes[*cursor + 3],
        bytes[*cursor + 4],
    ]) as usize;
    let value_start = header_end;
    let value_end = value_start
        .checked_add(len)
        .ok_or_else(|| "workflow execute-definition tuple cell length overflow".to_string())?;
    if value_end > bytes.len() {
        return Err("workflow execute-definition tuple cell value is truncated".to_string());
    }
    *cursor = value_end;
    Ok(&bytes[value_start..value_end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execute_tuple(definition_id: &str, input_json: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"BWF1");
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.push(FIELD_TUPLE_TYPE_UTF8);
        bytes.extend_from_slice(&(definition_id.len() as u32).to_le_bytes());
        bytes.extend_from_slice(definition_id.as_bytes());
        bytes.push(FIELD_TUPLE_TYPE_JSON);
        bytes.extend_from_slice(&(input_json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(input_json);
        bytes
    }

    fn named_execute_tuple(cells: Vec<(Vec<&str>, u8, Vec<u8>)>) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"BFN1");
        bytes.extend_from_slice(&(cells.len() as u16).to_le_bytes());
        for (path, field_type, value) in cells {
            let mut path_bytes = Vec::new();
            path_bytes.push(path.len() as u8);
            for segment in path {
                path_bytes.extend_from_slice(&(segment.len() as u16).to_le_bytes());
                path_bytes.extend_from_slice(segment.as_bytes());
            }
            bytes.push(field_type);
            bytes.extend_from_slice(&(path_bytes.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&path_bytes);
            bytes.extend_from_slice(&value);
        }
        bytes
    }

    #[test]
    fn decode_execute_definition_field_tuple_maps_to_canonical_request() {
        let request = decode_execute_definition_field_tuple(&execute_tuple(
            "action:update",
            br#"{"title":"New"}"#,
        ))
        .expect("decode succeeds")
        .expect("tuple matched");

        assert_eq!(request.operation, ExecuteDefinitionRequest::OPERATION);
        assert_eq!(request.definition_id, "action:update");
        assert_eq!(request.input["title"], "New");
        assert!(request.include_steps);
        assert!(!request.include_output);
        assert!(request.user_id.is_none());
        assert!(request.receipt.is_none());
    }

    #[test]
    fn decode_execute_definition_field_tuple_ignores_non_tuple_bytes() {
        let decoded =
            decode_execute_definition_field_tuple(br#"{"operation":"execute_definition"}"#)
                .expect("non tuple is not an error");
        assert!(decoded.is_none());
    }

    #[test]
    fn decode_execute_definition_named_field_tuple_reconstructs_input_object() {
        let request = decode_execute_definition_field_tuple(&named_execute_tuple(vec![
            (
                vec!["definition_id"],
                FIELD_TUPLE_TYPE_UTF8,
                b"action:rename".to_vec(),
            ),
            (
                vec!["input", "session_id"],
                FIELD_TUPLE_TYPE_UTF8,
                b"session-1".to_vec(),
            ),
            (vec!["input", "enabled"], FIELD_TUPLE_TYPE_BOOLEAN, vec![1]),
            (
                vec!["input", "score"],
                FIELD_TUPLE_TYPE_F64,
                42.5f64.to_le_bytes().to_vec(),
            ),
        ]))
        .expect("decode succeeds")
        .expect("tuple matched");

        assert_eq!(request.definition_id, "action:rename");
        assert_eq!(request.input["session_id"], "session-1");
        assert_eq!(request.input["enabled"], true);
        assert_eq!(request.input["score"], 42.5);
        assert!(!request.include_output);
        assert!(request.receipt.is_none());
    }

    #[test]
    fn decode_execute_definition_named_field_tuple_keeps_declared_receipt_target() {
        let request = decode_execute_definition_field_tuple(&named_execute_tuple(vec![
            (
                vec!["definition_id"],
                FIELD_TUPLE_TYPE_UTF8,
                b"action:materialize".to_vec(),
            ),
            (
                vec!["receipt", "address"],
                FIELD_TUPLE_TYPE_UTF8,
                b"receipt:materialize".to_vec(),
            ),
            (
                vec!["receipt", "path"],
                FIELD_TUPLE_TYPE_JSON,
                br#"["current"]"#.to_vec(),
            ),
            (
                vec!["receipt", "evidence"],
                FIELD_TUPLE_TYPE_JSON,
                br#"{"source":"opaque"}"#.to_vec(),
            ),
        ]))
        .expect("decode succeeds")
        .expect("tuple matched");

        let receipt = request.receipt.expect("receipt target");
        assert_eq!(receipt.address, "receipt:materialize");
        assert_eq!(receipt.path, vec!["current".to_string()]);
        assert_eq!(receipt.evidence["source"], "opaque");
    }
}
