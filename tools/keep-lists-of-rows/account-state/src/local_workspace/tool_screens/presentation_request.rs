//! Narrow adapter for the workspace frontend's tool-screen GET.
//!
//! The canonical route table delivers `/work/api/workshop/screens` as
//! `presentation:request`. This adapter accepts only that exact catalog GET; a
//! tool's describe is the tool tool:describe-a-tool (trillion-workshop
//! tools/describe-the-workshop), run at the account routes' tools:run. It does not provide a generic
//! presentation executor, a catalog fallback, or a tool execution grant.

use crate::workspace::WorkspaceError;
use serde_json::Value;

const PATH: &str = "/work/api/workshop/screens";
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_CURSOR_UNITS: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub(in crate::local_workspace) enum PresentationRequest {
    Screens(String),
}

/// Read the browser-authorized presentation envelope built by
/// `CanonicalWorkspace::specialized`. The caller still uses the same
/// `LocalWorkspace` session, selected account, tool-screen mount and final
/// source/browser checks as `screen-host:request`.
pub(in crate::local_workspace) fn request(
    input: &Value,
) -> Result<PresentationRequest, WorkspaceError> {
    if input.get("method").and_then(Value::as_str) != Some("GET") {
        return Err(crate::cause!(WorkspaceError::NoOwner));
    }
    let path = input
        .get("path")
        .and_then(Value::as_str)
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if path.len() > MAX_PATH_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
    if path_only != PATH {
        return Err(crate::cause!(WorkspaceError::NoOwner));
    }
    if !input
        .get("body")
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty)
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    // Match URLSearchParams.get('after'): unrelated keys are ignored and the
    // first repeated `after` wins. The canonical caller has already bounded
    // and parsed the full query; retain a separate bound on the selected cursor.
    let mut after = None;
    for part in query.split('&').filter(|part| !part.is_empty()) {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if crate::workspace_domain::decode(name, true)? != "after" {
            continue;
        }
        if after.is_some() {
            continue;
        }
        let value = crate::workspace_domain::decode(value, true)?;
        if value.encode_utf16().count() > MAX_CURSOR_UNITS {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        after = Some(value);
    }
    Ok(PresentationRequest::Screens(after.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request as the canonical route table hands it over. Its origin is the address the request arrived at: this
    /// computer's own reach, never a constant.
    fn envelope(path: &str, method: &str, body: Value) -> Value {
        serde_json::json!({
            "path": path,
            "origin": crate::account::computers::this_computer().reach,
            "method": method,
            "body": body
        })
    }

    #[test]
    fn accepts_only_the_frontend_tool_screens_route_and_cursor() {
        assert_eq!(
            request(&envelope(PATH, "GET", serde_json::json!({}))).unwrap(),
            PresentationRequest::Screens(String::new())
        );
        assert_eq!(
            request(&envelope(
                "/work/api/workshop/screens?ignored=value&after=tool%3Aalpha",
                "GET",
                serde_json::json!({})
            ))
            .unwrap(),
            PresentationRequest::Screens("tool:alpha".into())
        );
        assert_eq!(
            request(&envelope(
                "/work/api/workshop/screens?after=tool%3Aalpha&after=tool%3Abeta",
                "GET",
                serde_json::json!({})
            ))
            .unwrap(),
            PresentationRequest::Screens("tool:alpha".into())
        );
    }

    #[test]
    fn refuses_other_paths_methods_queries_bodies_and_malformed_cursors() {
        for input in [
            envelope("/work/api/workshop", "GET", serde_json::json!({})),
            envelope("/work/api/screens", "GET", serde_json::json!({})),
            envelope(PATH, "POST", serde_json::json!({})),
            envelope(
                "/work/api/workshop/screens?after=%GG",
                "GET",
                serde_json::json!({}),
            ),
            envelope(PATH, "GET", serde_json::json!({"surfaces":[]})),
        ] {
            assert!(request(&input).is_err(), "unexpected acceptance: {input}");
        }
    }
}
