// src/host/records_door.rs
//
// Purpose: The client this tool uses to reach the person's own records and Workshop tools through the door its run was handed: the same
// door `tools/records-door/read-data/records-door.mjs` is the client of for a tool that runs in a container. The run is handed one JSON
// line `{ url, resource, capability, tools_resource? }` (attached as a held field, `settings.json` `share.descriptor`); every call is one
// `run_resource_operation` at an address, sent to the door's loopback `url` with the capability as its bearer.
//
// Non-Negotiable Invariants:
// - The capability is never printed, logged, returned or in an error; an answer that holds it is refused.
// - The door answers on this computer's loopback only (the HTTP client refuses any other plain-http host).
// - A call is made once. A refusal, an interrupted answer or a timeout never proves an effect did not happen, so nothing here retries: a
//   caller that must be sure sends the same request key again and reads the same answer.
//
// Key Concepts:
// - `call(address, method, input, key)`: one operation at one address. `write` is `records:write` at the descriptor's `resource`, `run` is
//   `tools:run` at its `tools_resource` (else `@tools`), only for a tool id the row declares in `runs`.
//
// Security Considerations:
// - An error names the door's own refusal code, never its text, and never the descriptor.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::https::{Ask, Client, Upload};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    time::{Duration, Instant},
};
use url::Url;
use zeroize::Zeroizing;

const PROTOCOL: &str = "2025-06-18";
/// The most one call waits for the door's answer, and the most an answer may hold.
const CALL_SECONDS: u64 = 60;
const MOST_ANSWER_BYTES: u64 = 4 * 1024 * 1024;
const WORKSHOP_TOOLS: &str = "@tools";

/// Why a call did not answer.
#[derive(Debug, PartialEq, Eq)]
pub enum DoorError {
    /// The descriptor is not a door.
    NoDoor,
    /// The door could not be reached, or its answer was unreadable: the call may or may not have been done.
    Unavailable,
    /// The door refused the call with this code (and said whether it had started).
    Refused { code: String, started: bool },
}

impl std::fmt::Display for DoorError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DoorError::NoDoor => out.write_str("this run was not handed a records door"),
            DoorError::Unavailable => out.write_str("the records door could not be reached; the call may or may not have been done"),
            DoorError::Refused { code, .. } => write!(out, "the records door refused the call ({code})"),
        }
    }
}
impl std::error::Error for DoorError {}

#[derive(Deserialize)]
struct Descriptor {
    url: String,
    resource: String,
    capability: String,
    #[serde(default)]
    tools_resource: Option<String>,
}

/// The door a run was handed.
pub struct RecordsDoor {
    client: Client,
    url: Url,
    resource: String,
    tools_resource: String,
    capability: Zeroizing<String>,
}

impl RecordsDoor {
    /// The door the descriptor line names.
    pub fn from_descriptor(line: &str) -> Result<Self, DoorError> {
        let descriptor: Descriptor = serde_json::from_str(line.trim()).map_err(|_| DoorError::NoDoor)?;
        let url = Url::parse(&descriptor.url).map_err(|_| DoorError::NoDoor)?;
        if descriptor.resource.is_empty() || descriptor.capability.is_empty() {
            return Err(DoorError::NoDoor);
        }
        Ok(Self {
            client: Client::verified().map_err(|_| DoorError::Unavailable)?,
            url,
            resource: descriptor.resource,
            tools_resource: descriptor.tools_resource.unwrap_or_else(|| WORKSHOP_TOOLS.to_owned()),
            capability: Zeroizing::new(descriptor.capability),
        })
    }

    /// `records:write` of these records at the person's own records.
    pub fn write(&self, records: &[Value], key: &str) -> Result<Value, DoorError> {
        self.call(&self.resource, "records:write", &json!({ "records": records }), key)
    }

    /// The record of `kind` and `id` at the person's own records, or None when there is none (`records:read`). A value the store
    /// answers as its stored body `{ kind, sequence, stored, .. }` is the value parsed from `stored`.
    pub fn read_record(&self, kind: &str, id: &str, key: &str) -> Result<Option<Value>, DoorError> {
        let answer = self.call(&self.resource, "records:read", &json!({ "id": id, "type": kind }), key)?;
        Ok(match answer.get("value") {
            None | Some(Value::Null) => None,
            Some(value) => Some(stored_value(value)),
        })
    }

    /// The workspace record at the exact `label`, or None when there is none (`workspace:read` of that one label).
    pub fn read_workspace(&self, label: &str, key: &str) -> Result<Option<Value>, DoorError> {
        let answer = self.call(&self.resource, "workspace:read", &json!({ "selection": { "labels": [label], "prefixes": [] } }), key)?;
        workspace_record(&answer, label)
    }

    /// `tools:run` of one Workshop tool the row declares in `runs`; answers the tool's own output.
    pub fn run(&self, tool: &str, input: &Value, key: &str) -> Result<Value, DoorError> {
        self.call(&self.tools_resource, "tools:run", &json!({ "tool": tool, "input": input }), key)
    }

    /// One operation at one address.
    pub fn call(&self, address: &str, method: &str, input: &Value, key: &str) -> Result<Value, DoorError> {
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "run_resource_operation", "arguments": { "address": address, "method": method, "request_key": key, "input": input } },
        }))
        .map_err(|_| DoorError::Unavailable)?;
        let bearer = Zeroizing::new(format!("Bearer {}", self.capability.as_str()));
        let headers = [
            ("authorization", bearer.as_str()),
            ("content-type", "application/json"),
            ("accept", "application/json, text/event-stream"),
            ("mcp-protocol-version", PROTOCOL),
        ];
        let deadline = Instant::now() + Duration::from_secs(CALL_SECONDS);
        let mut reader = body.as_slice();
        let mut opened = self
            .client
            .open_uploading(&Ask { method: "POST", url: &self.url, headers: &headers, body: &[] }, Upload { length: body.len() as u64, reader: &mut reader }, Duration::from_secs(CALL_SECONDS), deadline)
            .map_err(|_| DoorError::Unavailable)?;
        let mut text = Vec::new();
        (&mut opened.body).take(MOST_ANSWER_BYTES + 1).read_to_end(&mut text).map_err(|_| DoorError::Unavailable)?;
        if opened.status == 401 {
            return Err(DoorError::Refused { code: "capability_gone".into(), started: false });
        }
        if opened.status != 200 || text.len() as u64 > MOST_ANSWER_BYTES {
            return Err(DoorError::Unavailable);
        }
        let text = String::from_utf8(text).map_err(|_| DoorError::Unavailable)?;
        if text.contains(self.capability.as_str()) {
            return Err(DoorError::Unavailable);
        }
        let event_stream = opened.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.contains("text/event-stream"));
        answer_of(&text, event_stream)
    }
}

/// A record value as the store answers it: its stored body `{ kind, sequence, stored, meta, protected }` is the value parsed from `stored`.
fn stored_value(value: &Value) -> Value {
    match (value.get("sequence"), value.get("stored").and_then(Value::as_str)) {
        (Some(_), Some(stored)) => serde_json::from_str(stored).unwrap_or_else(|_| value.clone()),
        _ => value.clone(),
    }
}

/// The record at `label` in a `workspace:read` answer (`{ status, content_type, text }`, the text JSON `{ records: { label: value } }`).
fn workspace_record(answer: &Value, label: &str) -> Result<Option<Value>, DoorError> {
    let json = answer.get("content_type").and_then(Value::as_str).is_some_and(|kind| kind.trim_start().to_ascii_lowercase().starts_with("application/json"));
    if answer.get("status").and_then(Value::as_u64) != Some(200) || !json {
        return Err(DoorError::Unavailable);
    }
    let body: Value = serde_json::from_str(answer.get("text").and_then(Value::as_str).ok_or(DoorError::Unavailable)?).map_err(|_| DoorError::Unavailable)?;
    let records = body.get("records").and_then(Value::as_object).ok_or(DoorError::Unavailable)?;
    Ok(records.get(label).filter(|value| value.is_object()).cloned())
}

/// The door's answer: JSON, or an event stream whose last `data:` line is the JSON. The tool result's structured content, or its refusal.
fn answer_of(text: &str, event_stream: bool) -> Result<Value, DoorError> {
    let json = if event_stream { text.lines().filter_map(|line| line.strip_prefix("data:")).next_back().ok_or(DoorError::Unavailable)? } else { text };
    let answer: Value = serde_json::from_str(json.trim()).map_err(|_| DoorError::Unavailable)?;
    if answer.get("error").is_some() {
        return Err(DoorError::Refused { code: "rpc_error".into(), started: false });
    }
    let result = answer.get("result").filter(|result| result.get("structuredContent").is_some()).ok_or(DoorError::Unavailable)?;
    let content = result["structuredContent"].clone();
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let code = content.get("code").and_then(Value::as_str).unwrap_or("refused").to_owned();
        return Err(DoorError::Refused { started: content.get("outcome").and_then(Value::as_str) != Some("not_started"), code });
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_read_is_the_record_at_its_label_and_a_stored_body_is_its_value() {
        let answer = json!({"status": 200, "content_type": "application/json; charset=utf-8", "text": r#"{"records":{"sharing:a":{"people":[]}}}"#});
        assert_eq!(workspace_record(&answer, "sharing:a"), Ok(Some(json!({"people": []}))));
        assert_eq!(workspace_record(&answer, "sharing:b"), Ok(None), "no record is none, not a refusal");
        assert_eq!(workspace_record(&json!({"status": 500, "content_type": "application/json", "text": "{}"}), "x"), Err(DoorError::Unavailable));
        assert_eq!(workspace_record(&json!({"status": 200, "content_type": "text/html", "text": "{}"}), "x"), Err(DoorError::Unavailable));
        let stored = json!({"kind": "r", "sequence": 3, "stored": r#"{"kind":"namespace-shared-file","identity":"1f:aa"}"#});
        assert_eq!(stored_value(&stored), json!({"kind": "namespace-shared-file", "identity": "1f:aa"}));
        assert_eq!(stored_value(&json!({"kind": "namespace-shared-file"})), json!({"kind": "namespace-shared-file"}));
    }

    #[test]
    fn a_result_is_its_structured_content_and_a_refusal_is_its_code() {
        let answered = r#"{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"changed":1},"isError":false}}"#;
        assert_eq!(answer_of(answered, false).unwrap(), json!({"changed": 1}));
        assert_eq!(answer_of(&format!("event: message\ndata: {answered}\n\n"), true).unwrap(), json!({"changed": 1}));
        let refused = r#"{"result":{"structuredContent":{"code":"selected_owner_unavailable","outcome":"not_started"},"isError":true}}"#;
        assert_eq!(answer_of(refused, false), Err(DoorError::Refused { code: "selected_owner_unavailable".into(), started: false }));
        let unknown = r#"{"result":{"structuredContent":{"code":"refused"},"isError":true}}"#;
        assert_eq!(answer_of(unknown, false), Err(DoorError::Refused { code: "refused".into(), started: true }), "no outcome never proves nothing started");
        assert_eq!(answer_of("{\"error\":{}}", false), Err(DoorError::Refused { code: "rpc_error".into(), started: false }));
        assert_eq!(answer_of("{\"result\":{}}", false), Err(DoorError::Unavailable));
    }

    /// A loopback door that answers one request with `answer` and hands back the request it read (head and body).
    fn door_answering(answer: &'static str, content_type: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{BufRead, BufReader, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut head, mut length) = (String::new(), 0usize);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len()).unwrap();
            format!("{head}\n{}", String::from_utf8(body).unwrap())
        });
        (url, server)
    }

    #[test]
    fn a_call_is_one_run_resource_operation_with_the_capability_as_its_bearer() {
        let (url, server) = door_answering(r#"{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"op":"share","link":{"url":"https://a.example.test/share/k"}},"isError":false}}"#, "application/json");
        let door = RecordsDoor::from_descriptor(&format!(r#"{{"url":"{url}","resource":"@own-records","capability":"cap-secret","tools_resource":"@tools"}}"#)).unwrap();
        let answer = door.run("tool:share-anything", &json!({"op": "share"}), "key-1").unwrap();
        assert_eq!(answer["link"]["url"], "https://a.example.test/share/k");
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("authorization: bearer cap-secret") && request.contains("mcp-protocol-version: 2025-06-18"), "{request}");
        let body: Value = serde_json::from_str(request.split_once('\n').map(|(_, rest)| rest.rsplit_once('\n').map_or(rest, |(_, last)| last)).unwrap()).unwrap();
        assert_eq!(body["params"]["name"], "run_resource_operation");
        assert_eq!(body["params"]["arguments"], json!({"address": "@tools", "method": "tools:run", "request_key": "key-1", "input": {"tool": "tool:share-anything", "input": {"op": "share"}}}));
    }

    #[test]
    fn an_answer_that_holds_the_capability_is_refused() {
        let (url, server) = door_answering(r#"{"result":{"structuredContent":{"echo":"cap-secret"},"isError":false}}"#, "application/json");
        let door = RecordsDoor::from_descriptor(&format!(r#"{{"url":"{url}","resource":"@own-records","capability":"cap-secret"}}"#)).unwrap();
        let refused = door.write(&[json!({"id": "a", "type": "t", "value": {}})], "k").unwrap_err();
        server.join().unwrap();
        assert_eq!(refused, DoorError::Unavailable);
        assert!(!refused.to_string().contains("cap-secret"));
    }

    #[test]
    fn a_descriptor_that_names_no_door_is_refused_and_never_echoed() {
        for line in ["", "not json", r#"{"url":"http://127.0.0.1:1/","resource":"","capability":"secret-value"}"#, r#"{"url":"nope","resource":"@own-records","capability":"secret-value"}"#] {
            let refused = RecordsDoor::from_descriptor(line).err().expect("refused");
            assert_eq!(refused, DoorError::NoDoor);
            assert!(!refused.to_string().contains("secret-value"));
        }
    }
}
