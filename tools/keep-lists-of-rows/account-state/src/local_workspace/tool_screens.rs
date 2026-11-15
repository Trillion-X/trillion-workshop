// src/local_workspace/tool_screens.rs
// Purpose: Mount the original screen-host page call in the existing LocalWorkspace executor.
// Invariants: Reuse the same account Arc, sessions, cancellation permit and concrete SelectedAccount page source; no second executor or route table.
// Security: GET /screens only, bounded query/body encoding, current browser checks remain in parent executor, no provider execution or invented empty result.
// AI Assistant Directive: Preserve and extend the original response and unsupported-operation boundaries.

use super::{DomainAnswer, LocalWorkspace, WorkspaceError};
use crate::{
    ecma_json::{self, JsString, Object, Value},
    native_boot::{
        tool_screens::{ReadLimits, ToolLabelLocale},
        SelectedAccount,
    },
    workspace_tool_screens::{Failure, ToolScreenPage},
};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use std::sync::{atomic::AtomicBool, Arc};

pub(super) const OPERATION: &str = "screen-host:request";
pub(super) const PRESENTATION_OPERATION: &str = "presentation:request";
mod presentation_request;
pub(super) use presentation_request::{request as presentation_request, PresentationRequest};
pub(super) struct Mount {
    pub(super) locale: Arc<dyn ToolLabelLocale>,
    pub(super) limits: ReadLimits,
}
impl LocalWorkspace {
    /// Native composition supplies the actual language primitive, while the
    /// selected descriptor supplies program DATA. Missing either refuses reads.
    pub fn with_tool_screens(
        mut self,
        locale: Arc<dyn ToolLabelLocale>,
        limits: ReadLimits,
    ) -> Self {
        self.tool_screens = Some(Arc::new(Mount { locale, limits }));
        self
    }
}
/// FamilyRoutes already normalizes the original native request envelope. Read
/// its first normalized `after` value, preserving that envelope's existing
/// repeated-value comma joining and the canonical decoder's '+' handling.
pub(super) fn request(input: &serde_json::Value) -> Result<String, WorkspaceError> {
    if input.get("method").and_then(serde_json::Value::as_str) != Some("GET") {
        return Err(crate::cause!(WorkspaceError::NoOwner));
    }
    let path = input
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if path.len() > 32 * 1024 {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    if path != "/screens" {
        return Err(crate::cause!(WorkspaceError::NoOwner));
    }
    for part in query.split('&') {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if crate::workspace_domain::decode(name, true)? == "after" {
            let after = crate::workspace_domain::decode(value, true)?;
            if after.encode_utf16().count() > 4096 {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
            return Ok(after);
        }
    }
    Ok(String::new())
}
fn error(error: Failure) -> WorkspaceError {
    let cause = error.cause();
    match error {
        Failure::Invalid(_, _) => WorkspaceError::Invalid(cause),
        Failure::Bounds(_) => WorkspaceError::TooLarge(cause),
        Failure::Cancelled(_) => WorkspaceError::Conflict(cause),
        Failure::Integrity(_) | Failure::SecretValue(_) | Failure::UnknownPlacement(_) => {
            WorkspaceError::Integrity(cause)
        }
        Failure::Source(_) => WorkspaceError::Unavailable(cause),
        Failure::Physical(error, _) => match error.kind {
            crate::tool_fact_page::Kind::Invalid(_) => WorkspaceError::Invalid(cause),
            crate::tool_fact_page::Kind::Bounds(_) => WorkspaceError::TooLarge(cause),
            crate::tool_fact_page::Kind::Cancelled(_) => WorkspaceError::Conflict(cause),
            crate::tool_fact_page::Kind::Schema(_) | crate::tool_fact_page::Kind::Corrupt(_) => {
                WorkspaceError::Integrity(cause)
            }
            _ => WorkspaceError::Unavailable(cause),
        },
    }
}
pub(super) fn read(
    owner: &mut SelectedAccount,
    session: &str,
    after: String,
    mount: &Mount,
    cancel: Arc<AtomicBool>,
) -> Result<ToolScreenPage, WorkspaceError> {
    owner
        .current_tool_screens(session, after, mount.locale.as_ref(), &mount.limits, cancel)
        .map_err(error)
}
pub(super) fn answer(page: ToolScreenPage) -> Result<DomainAnswer, WorkspaceError> {
    let mut body = Object::new();
    body.insert("surfaces".into(), Value::Array(page.surfaces));
    body.insert(
        "next".into(),
        page.next
            .map(|next| Value::String(JsString::from(next)))
            .unwrap_or(Value::Null),
    );
    let limits = ecma_json::Limits {
        input_bytes: ecma_json::HARD_BYTES,
        output_bytes: ecma_json::HARD_BYTES,
        depth: ecma_json::HARD_DEPTH,
        nodes: ecma_json::HARD_NODES,
        string_units: ecma_json::HARD_BYTES,
        total_string_units: ecma_json::HARD_BYTES,
        container_entries: ecma_json::HARD_NODES,
        number_bytes: ecma_json::HARD_NUMBER_BYTES,
    };
    let body = ecma_json::stringify(&Value::Object(body), limits)
        .map_err(|error| WorkspaceError::TooLarge(error.cause()))?
        .into_bytes();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(DomainAnswer::Http {
        status: StatusCode::OK,
        headers,
        body,
    })
}
