// src/workspace_tool_screens/catalog/placements.rs
//
// Purpose: Admit original shared Workshop placement rows for read-only tool cards.
// Invariants: Use the bounded current catalog bytes; retain only the fields the
//   screen consumes; preserve source order and duplicate IDs for last-row lookup.
// Security: Secret values and machine-specific placements are refused; placement
//   data never grants deployment, credentials, or execution.
// AI Assistant Directive: Preserve and extend these source and authority limits.

use super::{field_is, get, has_secret, text_field, text_list, Failure, Placement};
use crate::ecma_json::{self, JsString, Value};

/// Admit one original `tool-placement` row for read-only card projection.
///
/// `executor` remains required by the original row contract, but is not copied
/// into `Placement`: screens use only its id, label and reachability. Physical
/// placement fields are refused, and raw row data never grants execution.
pub fn admit_placement(raw: &Value) -> Result<Placement, Failure> {
    if !matches!(raw, Value::Object(_)) {
        return Err(Failure::Invalid("tool placement must be an object", crate::cause!()));
    }
    let mut nodes = 0;
    if has_secret(raw, 0, &mut nodes)? {
        return Err(crate::cause!(Failure::SecretValue));
    }

    let required = |cause| Failure::Invalid("a placement needs id, label, executor and reachable_from", cause);
    let id = text_field(raw, "id").ok_or_else(|| required(crate::cause!()))?;
    let label = text_field(raw, "label").ok_or_else(|| required(crate::cause!()))?;
    if text_field(raw, "executor").is_none() {
        return Err(required(crate::cause!()));
    }
    let reachable_from =
        text_list(get(raw, "reachable_from").ok_or_else(|| required(crate::cause!()))?).ok_or_else(|| required(crate::cause!()))?;

    if !reachable_from
        .iter()
        .any(|host| host == &JsString::from("hosted"))
    {
        return Err(Failure::Invalid("reachable_from must include hosted", crate::cause!()));
    }
    if get(raw, "singular").is_some() || get(raw, "waiting_label").is_some() {
        return Err(Failure::Invalid(
            "singular and waiting_label are not shared placement fields",
         crate::cause!()));
    }

    Ok(Placement {
        id,
        label,
        reachable_from,
    })
}

/// Parse the exact bounded catalog JSON array and retain valid placement rows
/// in source order. Other catalog kinds are ignored, as in `readToolData`;
/// invalid placement rows are refused and skipped while valid rows remain.
/// The caller's card projection resolves duplicate ids from the last row.
pub fn placements_from_catalog(
    bytes: &[u8],
    bytes_bound: usize,
) -> Result<Vec<Placement>, Failure> {
    if bytes_bound == 0 || bytes_bound > ecma_json::HARD_BYTES || bytes.len() > bytes_bound {
        return Err(crate::cause!(Failure::Bounds));
    }
    let limits = super::super::codec_limits(bytes_bound);
    let catalog = ecma_json::parse(bytes, limits).map_err(|error| {
        let cause = error.cause();
        match error {
            ecma_json::Error::InvalidJson(_) => Failure::Integrity(cause),
            _ => Failure::Bounds(cause),
        }
    })?;
    let rows = match catalog {
        Value::Array(rows) => rows,
        _ => return Err(crate::cause!(Failure::Integrity)),
    };

    let mut placements = Vec::new();
    for row in rows {
        if !field_is(&row, "kind", "tool-placement") {
            continue;
        }
        match admit_placement(&row) {
            Ok(placement) => placements.push(placement),
            // readToolData records row-level refusal and continues through the
            // catalog. Source and safety-bound failures must abort the whole read.
            Err(Failure::Invalid(_, _) | Failure::SecretValue(_) | Failure::UnknownPlacement(_)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(placements)
}
