//! Bounded text envelopes from an already admitted Workshop page-route run.
//!
//! This is response encoding only: existing route/run/session/custody owners still admit and disclose it.
//! Unmarked results and run failures use the caller's unchanged JSON owner. Text opts in with
//! `{status, body: <UTF-8 string>, http: {format: "text", content_type?, download_name?}}`. The compiled policy
//! permits only inert MIME inline; other MIME requires attachment. Tools cannot set cookies, redirects, cache
//! policy, CORS, body length or other headers. No listener, renderer, binary decoder or body lifetime is added.
use crate::{workspace::WorkspaceError, workspace_domain::DomainAnswer};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

const MAX_TEXT_BYTES: usize = crate::workspace_store::MAX_READ_BYTES;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    _what: String,
    max_content_type_bytes: usize,
    max_download_name_bytes: usize,
    default_content_type: String,
    inline_content_types: Vec<String>,
}
fn policy() -> Result<&'static Policy, WorkspaceError> {
    static POLICY: OnceLock<Option<Policy>> = OnceLock::new();
    POLICY
        .get_or_init(|| serde_json::from_str(include_str!("tool_http_response/settings.json")).ok())
        .as_ref()
        .ok_or(crate::cause!(WorkspaceError::Integrity))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextReply {
    status: u16,
    body: String,
    http: TextMetadata,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextMetadata {
    format: TextFormat,
    content_type: Option<String>,
    download_name: Option<String>,
}
#[derive(Deserialize)]
enum TextFormat {
    #[serde(rename = "text")]
    Text,
}

/// Keep the existing JSON owner, including malformed-result and failed-run envelopes.
/// A malformed explicit text reply keeps its rejection source beside the existing null marker,
/// so the route refusal retains its words while naming the exact failed condition.
pub(crate) fn answer(
    ran: Result<Value, crate::refusal_cause::CodedError<String>>,
    json: impl FnOnce(Result<Value, crate::refusal_cause::CodedError<String>>, Option<crate::refusal_cause::Cause>) -> Result<DomainAnswer, WorkspaceError>,
) -> Result<DomainAnswer, WorkspaceError> {
    match ran {
        Ok(result) if result.get("http").is_some() => match text(result) {
            Ok(answer) => Ok(answer),
            Err(failure) => json(Ok(Value::Null), Some(failure.cause())),
        },
        other => json(other, None),
    }
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'+-.^_`|~".contains(&byte))
}

/// A bounded MIME subset: type/subtype and simple token or quoted ASCII parameters.
/// The body is UTF-8, so a declared charset must describe those bytes. Header controls are refused.
fn content_type(value: &str) -> Result<(HeaderValue, String), WorkspaceError> {
    if value.is_empty()
        || value.len() > policy()?.max_content_type_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let mut parts = value.split(';');
    let essence = parts.next().ok_or(crate::cause!(WorkspaceError::Invalid))?.trim();
    let (major, minor) = essence.split_once('/').ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if !token(major) || !token(minor) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let mut names = std::collections::BTreeSet::new();
    for part in parts {
        let (name, parameter) = part.trim().split_once('=').ok_or(crate::cause!(WorkspaceError::Invalid))?;
        let name = name.trim();
        let parameter = parameter.trim();
        let parameter_value =
            if parameter.starts_with('"') && parameter.ends_with('"') && parameter.len() >= 2 {
                let inner = &parameter[1..parameter.len() - 1];
                if inner.is_empty() || inner.bytes().any(|byte| matches!(byte, b'"' | b'\\')) {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                inner
            } else {
                if !token(parameter) {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                parameter
            };
        if !token(name)
            || !names.insert(name.to_ascii_lowercase())
            || name.eq_ignore_ascii_case("charset")
                && !parameter_value.eq_ignore_ascii_case("utf-8")
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
    }
    Ok((
        HeaderValue::from_str(value).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?,
        essence.to_owned(),
    ))
}

fn disposition(name: &str) -> Result<HeaderValue, WorkspaceError> {
    if name.is_empty()
        || name.len() > policy()?.max_download_name_bytes
        || name.trim() != name
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._()-".contains(&byte))
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
}

fn text(result: Value) -> Result<DomainAnswer, WorkspaceError> {
    let reply: TextReply = serde_json::from_value(result).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    let TextFormat::Text = reply.http.format;
    if !(200..=599).contains(&reply.status)
        || reply.body.len() > MAX_TEXT_BYTES
        || matches!(reply.status, 204 | 205 | 304) && !reply.body.is_empty()
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let policy = policy()?;
    let status = StatusCode::from_u16(reply.status).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    let (content_type, essence) = content_type(
        reply
            .http
            .content_type
            .as_deref()
            .unwrap_or(&policy.default_content_type),
    )?;
    let mut headers = HeaderMap::new();
    if let Some(name) = &reply.http.download_name {
        headers.insert(header::CONTENT_DISPOSITION, disposition(name)?);
    } else if !policy
        .inline_content_types
        .iter()
        .any(|allowed| essence.eq_ignore_ascii_case(allowed))
    {
        // An authorized result is not permission to execute an active document in the page's origin.
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(DomainAnswer::Http {
        status,
        headers,
        body: reply.body.into_bytes(),
    })
}

#[cfg(test)]
mod tests;
