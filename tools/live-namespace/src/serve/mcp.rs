// src/serve/mcp.rs
//
// Purpose: The Namespace tool as an MCP server over stdio: one JSON-RPC message a line in, one a line out. Each operation of the
// account files' routes DATA is a tool of the same name (`mcp-tools.json` says what each is for and what it takes): list_files,
// read_file, write_file, share_file, move_names, queue_release and the rest. A tool call is one call of the door
// (`Namespace::call`); its answer is the tool result, as text and as structured content.
//
// Non-Negotiable Invariants:
// - A message longer than `MAX_MESSAGE_BYTES` is refused and an answer never is longer: a read selects a range that fits
//   (`tool_answer_fits`), and a refusal names its code and whether the call may have had an effect, never a value.
// - The tool list and the routes DATA agree: a run does not start when an operation has no tool or a tool names no operation.
// - A call that goes on while the caller has stopped listening (stdin closed) takes no later step.
// - Each tool call runs on a thread of its own and answers under its own id when it is done, so a call that waits (a
//   list_changes with `wait`, a long read) never holds back the calls sent after it; every other message is answered in
//   order. One answer is written whole before the next begins. The input ends only after every call has answered.
//
// Security Considerations:
// - The server speaks only to the process that started it; it opens no port (the WebDAV folder is `dav.rs`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::Namespace;
use live_namespace::mcp::{tool_answer_fits, MAX_MESSAGE_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

/// The protocol version this server answers when the client names none it knows.
const PROTOCOL_VERSION: &str = "2025-06-18";

const TOOLS: &[u8] = include_bytes!("../../mcp-tools.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tools {
    #[serde(rename = "_what")]
    _what: String,
    left_out: Vec<String>,
    tools: Vec<Tool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    name: String,
    description: String,
    input_schema: Value,
}

/// The tools of this server, checked against the operations the door answers.
fn tools(namespace: &Namespace) -> Result<Tools, String> {
    let listed: Tools = serde_json::from_slice(TOOLS).map_err(|error| format!("mcp-tools.json is refused: {error}"))?;
    let named: BTreeSet<&str> = listed.tools.iter().map(|tool| tool.name.as_str()).collect();
    let left_out: BTreeSet<&str> = listed.left_out.iter().map(String::as_str).collect();
    let operations: BTreeSet<&str> = namespace.operations().iter().map(String::as_str).collect();
    if named.len() != listed.tools.len() || !named.is_disjoint(&left_out) {
        return Err("mcp-tools.json names a tool twice, or one it leaves out".into());
    }
    let mut known: BTreeSet<&str> = named.clone();
    known.extend(&left_out);
    if known != operations {
        return Err("mcp-tools.json and the account files' routes DATA do not list the same operations".into());
    }
    Ok(listed)
}

/// Serve MCP over `input` and `output` until `input` ends and every call has answered.
pub fn serve(namespace: Arc<Namespace>, input: impl BufRead, output: impl Write + Send) -> Result<(), String> {
    let listed = tools(&namespace)?;
    let call = |listed: &Tools, listening: &Arc<AtomicBool>, id: Value, params: &Value| call(&namespace, listed, listening, id, params);
    serve_calls(&listed, call, input, output)
}

/// `serve` with `call` answering each tool call.
fn serve_calls(listed: &Tools, call: impl Fn(&Tools, &Arc<AtomicBool>, Value, &Value) -> Value + Sync, input: impl BufRead,
    output: impl Write + Send) -> Result<(), String> {
    let listening = Arc::new(AtomicBool::new(true));
    let output = Mutex::new(output);
    let write = |answer: &Value| write_line(&mut *output.lock().map_err(|error| error.to_string())?, answer);
    let mut input = input;
    let mut line = String::new();
    thread::scope(|calls| loop {
        line.clear();
        let read = std::io::Read::take(&mut input, MAX_MESSAGE_BYTES as u64 + 1).read_line(&mut line).map_err(|error| error.to_string())?;
        if read == 0 {
            listening.store(false, Ordering::SeqCst);
            return Ok(());
        }
        if line.len() > MAX_MESSAGE_BYTES {
            skip_rest_of_line(&mut input, &line)?;
            write(&error(Value::Null, -32600, "The message is longer than one MCP message."))?;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            write(&error(Value::Null, -32700, "The message is not JSON."))?;
            continue;
        };
        match message.get("id").cloned().filter(|_| message.get("method").and_then(Value::as_str) == Some("tools/call")) {
            Some(id) => {
                let (call, listening, write) = (&call, &listening, &write);
                calls.spawn(move || {
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    // An answer that cannot be written has no one left to read it.
                    let _written = write(&call(listed, listening, id, &params));
                });
            }
            None => {
                if let Some(answer) = answer(listed, &message) {
                    write(&answer)?;
                }
            }
        }
    })
}

/// A line that was longer than a message is read to its end without keeping it.
fn skip_rest_of_line(input: &mut impl BufRead, read: &str) -> Result<(), String> {
    if read.ends_with('\n') {
        return Ok(());
    }
    loop {
        let (used, done) = {
            let buffer = input.fill_buf().map_err(|error| error.to_string())?;
            if buffer.is_empty() {
                return Ok(());
            }
            match buffer.iter().position(|byte| *byte == b'\n') {
                Some(at) => (at + 1, true),
                None => (buffer.len(), false),
            }
        };
        input.consume(used);
        if done {
            return Ok(());
        }
    }
}

fn write_line(output: &mut impl Write, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    output.write_all(&bytes).and_then(|()| output.flush()).map_err(|error| error.to_string())
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// The answer to one message that is not a tool call, or none for a notification.
fn answer(listed: &Tools, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str)?;
    let Some(id) = id else {
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "live-namespace", "version": env!("CARGO_PKG_VERSION")},
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": listed.tools.iter().map(|tool| json!({
            "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
        })).collect::<Vec<_>>()}),
        _ => return Some(error(id, -32601, "No such method.")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn call(namespace: &Arc<Namespace>, listed: &Tools, listening: &Arc<AtomicBool>, id: Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error(id, -32602, "A tool call names its tool.");
    };
    if !listed.tools.iter().any(|tool| tool.name == name) {
        return error(id, -32602, "No such tool.");
    }
    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    if !input.is_object() {
        return error(id, -32602, "A tool call's arguments are an object.");
    }
    let current = {
        let listening = listening.clone();
        Arc::new(move || listening.load(Ordering::SeqCst)) as Arc<dyn Fn() -> bool + Send + Sync>
    };
    let result = match namespace.call(name, &input, current, &tool_answer_fits) {
        Ok(answer) => tool_result(&answer, false),
        Err(failure) => {
            let (code, unknown) = failure.code();
            live_namespace::quiet_eprintln!("namespace-refusal code={code} cause={}", failure.cause());
            let mut refusal = json!({"code": code, "outcome": if unknown { "unknown" } else { "not_started" }});
            if let Some(detail) = failure.detail() {
                refusal["detail"] = detail;
            }
            tool_result(&refusal, true)
        }
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// A tool result: the answer as text and as structured content.
fn tool_result(answer: &Value, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": answer.to_string()}], "structuredContent": answer, "isError": is_error})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, sync::mpsc, time::Duration};

    /// A writer the test reads every answer of, as written.
    #[derive(Clone)]
    struct Answers(mpsc::Sender<Value>);
    impl Write for Answers {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
                let _sent = self.0.send(serde_json::from_slice(line).map_err(std::io::Error::other)?);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_call_that_waits_never_holds_back_the_calls_sent_after_it() {
        let listed = Tools { _what: String::new(), left_out: Vec::new(), tools: ["slow", "fast"].map(|name| Tool {
            name: name.to_owned(), description: String::new(), input_schema: json!({"type": "object"}) }).into() };
        let (answers, heard) = mpsc::channel();
        let (fast_done, fast_answered) = mpsc::channel::<()>();
        let fast_answered = Mutex::new(fast_answered);
        // `slow` answers only after `fast`, sent after it, has answered.
        let call = |_: &Tools, _: &Arc<AtomicBool>, id: Value, params: &Value| {
            match params["name"].as_str() {
                Some("slow") => {
                    let waited = fast_answered.lock().unwrap().recv_timeout(Duration::from_secs(30));
                    json!({"jsonrpc": "2.0", "id": id, "result": {"waited": waited.is_ok()}})
                }
                _ => {
                    let _done = fast_done.send(());
                    json!({"jsonrpc": "2.0", "id": id, "result": {"fast": true}})
                }
            }
        };
        let input = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "slow"}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "fast"}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
        ].iter().map(|message| format!("{message}\n")).collect::<String>();
        serve_calls(&listed, call, Cursor::new(input), Answers(answers)).unwrap();
        let order: Vec<Value> = heard.try_iter().collect();
        let ids: Vec<i64> = order.iter().filter_map(|answer| answer["id"].as_i64()).collect();
        let at = |id: i64| ids.iter().position(|answered| *answered == id);
        assert!(at(2) < at(1), "{order:?}");
        assert_eq!(order.iter().find(|answer| answer["id"] == 1).map(|answer| answer["result"]["waited"].clone()), Some(json!(true)));
        assert_eq!(ids.len(), 3, "{order:?}");
    }
}
