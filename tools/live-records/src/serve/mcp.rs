// src/serve/mcp.rs
//
// Purpose: The records tool as an MCP server over stdio: one JSON-RPC message a line in, one a line out. Each operation of the records door
// is a tool of the same name (`mcp-tools.json` says what each is for and what it takes): records:read, records:list, records:search,
// records:write, records:result, workspace:read and workspace:write. A tool call is one call of `Records::call`; its answer is the tool
// result, as text and as structured content.
//
// Non-Negotiable Invariants:
// - A line longer than `message_bytes` is refused and read to its end; an answer never is longer than a message (`Records::call` cuts it).
// - The tool list and the operations agree: a run does not start when an operation has no tool or a tool names no operation.
// - Each tool call runs on a thread of its own and answers under its own id when it is done, so a slow list never holds back the calls
//   sent after it; every other message is answered in order. One answer is written whole before the next begins. The input ends only
//   after every call has answered.
// - A refusal names its code and whether the call may have had an effect, never a value.
//
// Security Considerations:
// - The server speaks only to the process that started it (the engine's session); it opens no port.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use live_records::records::{Records, OPERATIONS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{BufRead, Write},
    sync::{Arc, Mutex},
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
    tools: Vec<Tool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    name: String,
    description: String,
    input_schema: Value,
}

/// The tools of this server, checked against the operations the tool answers.
fn tools() -> Result<Tools, String> {
    let listed: Tools = serde_json::from_slice(TOOLS).map_err(|error| format!("mcp-tools.json is refused: {error}"))?;
    let named: BTreeSet<&str> = listed.tools.iter().map(|tool| tool.name.as_str()).collect();
    let operations: BTreeSet<&str> = OPERATIONS.into_iter().collect();
    if named.len() != listed.tools.len() || named != operations {
        return Err("mcp-tools.json and the operations of the records door do not list the same names".into());
    }
    Ok(listed)
}

/// Serve MCP over `input` and `output` until `input` ends and every call has answered; `message_bytes` bounds one line read.
pub fn serve(records: Arc<Records>, message_bytes: usize, input: impl BufRead, output: impl Write + Send) -> Result<(), String> {
    let listed = tools()?;
    serve_calls(&listed, message_bytes, |name, arguments| records.call(name, arguments).map_err(|refusal| (refusal.code, refusal.unknown)), input, output)
}

/// `serve` with `call` answering each tool call: its answer, or its refusal's code and whether it may have had an effect.
fn serve_calls(listed: &Tools, message_bytes: usize, call: impl Fn(&str, &Value) -> Result<Value, (&'static str, bool)> + Sync, input: impl BufRead,
    output: impl Write + Send) -> Result<(), String> {
    let output = Mutex::new(output);
    let write = |answer: &Value| write_line(&mut *output.lock().map_err(|error| error.to_string())?, answer);
    let mut input = input;
    let mut line = String::new();
    thread::scope(|calls| loop {
        line.clear();
        let read = std::io::Read::take(&mut input, message_bytes as u64 + 1).read_line(&mut line).map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        if line.len() > message_bytes {
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
                let (call, write) = (&call, &write);
                calls.spawn(move || {
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    // An answer that cannot be written has no one left to read it.
                    let _written = write(&answer_call(listed, call, id, &params));
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
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "live-records", "version": env!("CARGO_PKG_VERSION")},
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": listed.tools.iter().map(|tool| json!({
            "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
        })).collect::<Vec<_>>()}),
        _ => return Some(error(id, -32601, "No such method.")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn answer_call(listed: &Tools, call: &(impl Fn(&str, &Value) -> Result<Value, (&'static str, bool)> + Sync), id: Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error(id, -32602, "A tool call names its tool.");
    };
    if !listed.tools.iter().any(|tool| tool.name == name) {
        return error(id, -32602, "No such tool.");
    }
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return error(id, -32602, "A tool call's arguments are an object.");
    }
    let result = match call(name, &arguments) {
        Ok(answer) => tool_result(&answer, false),
        Err((code, unknown)) => {
            live_records::quiet_eprintln!("records-refusal operation={name} code={code} outcome={}", if unknown { "unknown" } else { "not_started" });
            tool_result(&json!({"code": code, "outcome": if unknown { "unknown" } else { "not_started" }}), true)
        }
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// A tool result: a short text and the answer as structured content (the answer is not sent twice).
fn tool_result(answer: &Value, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": if is_error { "refused" } else { "ok" }}], "structuredContent": answer, "isError": is_error})
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
    fn the_shipped_tools_are_the_operations_of_the_door() {
        assert!(tools().is_ok());
    }

    #[test]
    fn a_call_that_waits_never_holds_back_the_calls_sent_after_it_and_a_refusal_says_its_code_and_outcome() {
        let listed = Tools { _what: String::new(), tools: ["records:read", "records:write"].map(|name| Tool {
            name: name.to_owned(), description: String::new(), input_schema: json!({"type": "object"}) }).into() };
        let (answers, heard) = mpsc::channel();
        let (fast_done, fast_answered) = mpsc::channel::<()>();
        let fast_answered = Mutex::new(fast_answered);
        // `records:read` answers only after `records:write`, sent after it, has run (and refused).
        let call = |name: &str, _: &Value| -> Result<Value, (&'static str, bool)> {
            if name == "records:read" {
                let waited = fast_answered.lock().unwrap().recv_timeout(Duration::from_secs(30));
                Ok(json!({"waited": waited.is_ok()}))
            } else {
                let _done = fast_done.send(());
                Err(("original_input_refused", false))
            }
        };
        let input = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "records:read"}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "records:write"}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
        ].iter().map(|message| format!("{message}\n")).collect::<String>();
        serve_calls(&listed, 4096, call, Cursor::new(input), Answers(answers)).unwrap();
        let order: Vec<Value> = heard.try_iter().collect();
        let ids: Vec<i64> = order.iter().filter_map(|answer| answer["id"].as_i64()).collect();
        // The slow call answered `waited: true`: the call sent after it ran, and answered, while it was still waiting.
        assert_eq!(order.iter().find(|answer| answer["id"] == 1).map(|answer| answer["result"]["structuredContent"]["waited"].clone()), Some(json!(true)));
        let refused = order.iter().find(|answer| answer["id"] == 2).unwrap();
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(refused["result"]["structuredContent"], json!({"code": "original_input_refused", "outcome": "not_started"}));
        assert_eq!(ids.len(), 3, "{order:?}");
    }
}
