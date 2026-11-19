// src/store/through_the_door.rs
//
// Purpose: The call `RowsByCalls` sends, made through the engine's door of this run. The engine hands the run, on the file
// descriptor its row's `invoke.records.fd` names, `{url, capability, tools_resource}` (the engine's run
// capability). The run's row names the tool that keeps the names in `invoke.records.runs`, so its
// capability may run exactly that tool. One call is one `tools:run {tool, call: {name, arguments}}` to that tool's session.
// The session answers each call as a file of bytes (its row's `session.byte_result`), and this caller accepts
// application/octet-stream, so the door hands those bytes back as the HTTP answer itself. No answer is held to the door's
// one-message bound, and a page of rows crosses whole.
//
// Non-Negotiable Invariants:
// - The door is plain http on this computer's loopback address only (https.rs refuses any other http address).
// - The capability is read once from its descriptor, sent only as this door's bearer, and never printed, kept or answered.
// - A call that does not come back as the session's own bytes is that call's failure, never an answer.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{by_calls::Send, Error};
use crate::https::{Ask, Client, Upload};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

/// The most bytes the run's door descriptor may hold.
const MOST_DESCRIPTOR_BYTES: u64 = 64 * 1024;
/// The most bytes one answer of the names may hold: a page of rows is at most 4 MiB (store/mod.rs MAX_PAGE_BYTES), and a
/// row of it is JSON inside JSON.
const MOST_ANSWER_BYTES: usize = 16 * 1024 * 1024;
/// The MCP protocol version the door is asked in.
const PROTOCOL: &str = "2025-06-18";
/// The door's one tool.
const DOOR_TOOL: &str = "do_one_thing_in_my_account";
/// The method that runs a Workshop tool.
const RUN_METHOD: &str = "tools:run";

/// The run's own door, and the tool its calls go to.
pub struct Door {
    url: url::Url,
    capability: Zeroizing<String>,
    tools: Option<String>,
    tool: String,
    client: Client,
}

impl Door {
    /// The door the engine handed this run on descriptor `fd`, calling `tool`.
    #[cfg(unix)]
    pub fn from_descriptor(fd: i32, tool: &str) -> Result<Self, Error> {
        use std::os::fd::{FromRawFd, OwnedFd};
        // SAFETY: the descriptor is the one the run's row names for its door; it is checked open, read once and closed here.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            return Err(Error::Invalid("the run was handed no door on the descriptor its settings name", crate::cause!()));
        }
        let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        let mut text = Zeroizing::new(String::new());
        file.take(MOST_DESCRIPTOR_BYTES).read_to_string(&mut text).map_err(|_| crate::cause!(Error::Unavailable))?;
        Self::from_text(&text, tool)
    }

    fn from_text(text: &str, tool: &str) -> Result<Self, Error> {
        let refused = || Error::Invalid("the run's door is not {url, capability, tools_resource}", crate::cause!());
        let said: Value = serde_json::from_str(text).map_err(|_| refused())?;
        let url = said["url"].as_str().and_then(|url| url::Url::parse(url).ok()).ok_or_else(refused)?;
        let capability = Zeroizing::new(said["capability"].as_str().ok_or_else(refused)?.to_owned());
        let tools = said["tools_resource"].as_str().map(str::to_owned);
        let client = Client::verified().map_err(|_| crate::cause!(Error::Unavailable))?;
        Ok(Self { url, capability, tools, tool: tool.to_owned(), client })
    }

    /// This door as the call `RowsByCalls` sends.
    pub fn sender(self) -> Box<Send> {
        Box::new(move |operation: &str, arguments: &Value, wait: Duration| self.call(operation, arguments, wait))
    }

    /// One call of the names' `operation`, answered with the session's own JSON.
    fn call(&self, operation: &str, arguments: &Value, wait: Duration) -> Result<Value, Error> {
        let mut door_arguments = json!({
            "method": RUN_METHOD,
            "request_key": request_key(operation),
            "input": {"tool": self.tool, "call": {"name": operation, "arguments": arguments}},
        });
        if let Some(tools) = &self.tools {
            door_arguments["address"] = json!(tools);
        }
        let body = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": DOOR_TOOL, "arguments": door_arguments}})).map_err(|_| crate::cause!(Error::Unavailable))?;
        let bearer = Zeroizing::new(format!("Bearer {}", self.capability.as_str()));
        let headers = [
            ("authorization", bearer.as_str()),
            ("content-type", "application/json"),
            ("accept", "application/octet-stream, application/json, text/event-stream"),
            ("mcp-protocol-version", PROTOCOL),
        ];
        let deadline = Instant::now() + wait;
        let mut reader = body.as_slice();
        let length = body.len() as u64;
        let mut opened = self.client
            .open_uploading(&Ask { method: "POST", url: &self.url, headers: &headers, body: &[] }, Upload { length, reader: &mut reader }, wait, deadline)
            .map_err(|_| crate::cause!(Error::Unavailable))?;
        let raw = opened.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.starts_with("application/octet-stream"));
        if opened.status != 200 || !raw {
            // The door answered in JSON: the call was refused, or its outcome is not known; never an answer of the names.
            return Err(crate::cause!(Error::Unavailable));
        }
        let mut bytes = Vec::new();
        let mut piece = vec![0_u8; 64 * 1024];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(crate::cause!(Error::Unavailable));
            }
            match opened.body.read_waiting(&mut piece, left).map_err(|_| crate::cause!(Error::Unavailable))? {
                Some(0) => break,
                Some(count) if bytes.len() + count <= MOST_ANSWER_BYTES => bytes.extend_from_slice(&piece[..count]),
                Some(_) => return Err(crate::cause!(Error::Unavailable)),
                None => continue,
            }
        }
        serde_json::from_slice(&bytes).map_err(|_| crate::cause!(Error::Unavailable))
    }
}

/// A request key no other call of any run uses: the operation, this process, the time and a count.
fn request_key(operation: &str) -> String {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_nanos());
    format!("names-{operation}-{}-{nanos}-{}", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_door_that_is_not_url_capability_and_tools_is_refused_and_a_full_one_is_read() {
        assert!(matches!(Door::from_text("{}", "tool:x"), Err(Error::Invalid(..))));
        assert!(matches!(Door::from_text("not json", "tool:x"), Err(Error::Invalid(..))));
        let door = Door::from_text(r#"{"url":"http://127.0.0.1:1/mcp","capability":"c","tools_resource":"@tools"}"#, "tool:x").unwrap();
        assert_eq!(door.tools.as_deref(), Some("@tools"));
    }

    #[test]
    fn a_door_that_does_not_answer_fails_the_call_and_names_no_value() {
        let door = Door::from_text(r#"{"url":"http://127.0.0.1:1/mcp","capability":"held-capability","tools_resource":"@tools"}"#, "tool:x").unwrap();
        let failed = door.call("get", &json!({"scope": "s", "id": "i"}), Duration::from_millis(500)).unwrap_err();
        assert!(matches!(failed, Error::Unavailable(_)));
        assert!(!format!("{failed:?}").contains("held-capability"));
    }

    #[test]
    fn every_request_key_differs() {
        assert_ne!(request_key("get"), request_key("get"));
    }
}
