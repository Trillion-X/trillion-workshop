//! Instruction projections travelling over the existing authenticated resource
//! transport. Only the rendering selector is transport vocabulary; the words,
//! account overrides, fills and continuation operation remain Workshop DATA.
use super::{Invoke, Operation, OperationFailure, Told, Value, Workshop, REQUESTS};
use serde_json::json;
use std::sync::atomic::Ordering;

/// The two MCP metadata fields that carry the same installed instruction rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetadataPart {
    Initialize,
    ToolDescription,
}

/// Internal resource operation for the MCP metadata projection. It reaches the
/// same account and checks the same private reach as a records read.
pub const METADATA_OPERATION: &str = "mcp:instructions";

/// Whether this installed list owns the addressed continuation operation.
/// The metadata selector has one protocol-owned name; continuation stays DATA.
pub fn answers(call: &Operation, workshop: Workshop<'_>) -> bool {
    if call.operation == METADATA_OPERATION {
        return crate::record_value::account_routes::Door::shipped()
            .is_ok_and(|door| call.resource == door.resource());
    }
    super::Shipped::read(workshop).is_ok_and(|shipped| {
        call.resource == shipped.settings.read.resource
            && call.operation == shipped.settings.read.operation
    })
}

pub fn metadata_call(part: MetadataPart) -> Option<Operation> {
    let door = crate::record_value::account_routes::Door::shipped().ok()?;
    Some(Operation { person_present: None,
        resource: door.resource().to_owned(),
        operation: METADATA_OPERATION.into(),
        request_key: format!(
            "mcp-instructions:{}:{}",
            std::process::id(),
            REQUESTS.fetch_add(1, Ordering::Relaxed)
        ),
        input: json!({"part": match part { MetadataPart::Initialize => "initialize", MetadataPart::ToolDescription => "tool-description" }}),
    })
}

/// Resolve metadata or a continuation through the original instruction owner.
/// Its caller supplies already admitted same-account reads and attaches the
/// result to that request's final credential/source check.
pub fn projection(
    call: &Operation,
    workshop: Workshop<'_>,
    invoke: Invoke<'_>,
) -> Option<Result<Value, OperationFailure>> {
    let unavailable = |cause: crate::refusal_cause::Cause| OperationFailure { cause: cause.into(),
        code: "instruction_source_unavailable".into(),
        outcome_unknown: false,
        detail: None,
    };
    let invalid = |cause: crate::refusal_cause::Cause| OperationFailure { cause: cause.into(),
        code: "instruction_read_invalid".into(),
        outcome_unknown: false,
        detail: None,
    };
    if call.operation != METADATA_OPERATION {
        return super::answer(call, workshop, invoke);
    }
    let door = match crate::record_value::account_routes::Door::shipped() {
        Ok(door) => door,
        Err(_) => return Some(Err(unavailable(crate::cause!()))),
    };
    if call.resource != door.resource() {
        return Some(Err(invalid(crate::cause!())));
    }
    let part = match call.input.as_object() {
        Some(fields) if fields.len() == 1 => match fields.get("part").and_then(Value::as_str) {
            Some("initialize") => MetadataPart::Initialize,
            Some("tool-description") => MetadataPart::ToolDescription,
            _ => return Some(Err(invalid(crate::cause!()))),
        },
        _ => return Some(Err(invalid(crate::cause!()))),
    };
    Some(
        Told::read(workshop, invoke)
            .map_err(|error| unavailable(error.cause()))
            .and_then(|told| {
                let text = match part {
                    MetadataPart::Initialize => told.initialize_text(),
                    MetadataPart::ToolDescription => told.tool_description(),
                };
                let value = Value::String(text);
                // Transport framing and the final MCP envelope retain their own bounds.
                // Refuse an oversized projection instead of truncating a paragraph or
                // inventing a continuation offset that was never rendered.
                if crate::mcp::encode_bounded(&value).is_none() {
                    return Err(unavailable(crate::cause!()));
                }
                Ok(value)
            }),
    )
}
