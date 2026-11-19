// src/serve/rows.rs
//
// Purpose: `live-namespace rows`: the person's names rows answered to the files run, as an MCP server over stdio. The engine
// runs it as a session that takes calls (tool:your-files-names). It is the one run that holds the database's login, and the
// files run (tool:your-files) holds the byte store's key alone: the engine lets one process reach only the hosts every value
// it holds may go to, so one run holding both could reach none. Each tool of this server is one operation of `Rows`
// (store/by_calls.rs `OPERATIONS`), and its answer is `by_calls::answer`. That answer is written as a file in the run's kept
// folder and named as the call's `bytes` (the row's `session.byte_result`), so the engine hands it to the caller as bytes and
// no page of rows is held to one message.
//
// Non-Negotiable Invariants:
// - The login reaches this run only on the descriptor its row attaches, and is never printed or answered.
// - Each call runs on a thread of its own and answers under its own id, so a wait for a change (`wait_for_order`) holds back
//   no other call. One answer line is written whole before the next. The input ends only after every call has answered.
// - A call answers once: an answer file that cannot be written is the call's error, never a partial answer.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::Refusal;
use live_namespace::{
    secrets::Held,
    store::{by_calls, link::Link, SqlStore, Store},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read as _, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

/// The protocol version this server answers when the client names none.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// The most bytes one call may hold: a mutate carries one row of at most 1 MiB (store/mod.rs MAX_RECORD_BYTES) and its envelope.
const MOST_CALL_BYTES: usize = 2 * 1024 * 1024;
/// The folder of the kept folder each answer is written in; the engine removes each file once it has handed it on.
const ANSWERS: &str = "names-answers";
/// The field of a call's structured content that names its answer file (the row's `session.byte_result`).
const BYTE_RESULT: &str = "bytes";
/// The vault service and field of the database login (the person's own Postgres).
const LOGIN: (&str, &str) = ("own-rows-postgres", "connection");

/// Where the rows are: the person's Postgres, its login on a descriptor, or a SQLite file of the kept folder (for tests and a
/// person's own computer).
pub enum Kept {
    Postgres { fd: i32 },
    Sqlite { file: String },
}

/// The rows `kept` names, opened; with `hearing`, a Postgres store also hears other processes' changes.
pub fn open(kept: &Kept, state: &Path, hearing: bool) -> Result<SqlStore, Refusal> {
    Ok(match kept {
        Kept::Postgres { fd } => {
            let held = Held::from_descriptors(&[(LOGIN.0, LOGIN.1, *fd)])?;
            let name = live_namespace::secrets::held_name(LOGIN.0, LOGIN.1)?;
            let login = held.plain(&name).map_err(|_| "the database login is not attached: attach it to start the run")?;
            let store = SqlStore::open(Link::postgres(login.as_str())?)?;
            if hearing { store.hearing(Link::postgres(login.as_str())?)? } else { store }
        }
        Kept::Sqlite { file } => SqlStore::open(Link::sqlite(&state.join(file))?)?,
    })
}

/// Open the rows and answer calls on `input` until it ends.
pub fn run(kept: &Kept, state: &Path, input: impl BufRead, output: impl Write + std::marker::Send) -> Result<(), Refusal> {
    let store: Store = Arc::new(open(kept, state, true)?);
    let answers = state.join(ANSWERS);
    std::fs::create_dir_all(&answers)?;
    serve(&store, &answers, input, output)
}

fn serve(store: &Store, answers: &Path, mut input: impl BufRead, output: impl Write + std::marker::Send) -> Result<(), Refusal> {
    let output = Mutex::new(output);
    let write = |line: &Value| -> Result<(), Refusal> {
        let mut output = output.lock().map_err(|_| "the answer stream is held by a call that failed")?;
        serde_json::to_writer(&mut *output, line)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    };
    thread::scope(|calls| {
        let mut line = String::new();
        loop {
            line.clear();
            if (&mut input).take(MOST_CALL_BYTES as u64 + 1).read_line(&mut line)? == 0 {
                return Ok(());
            }
            if line.len() > MOST_CALL_BYTES {
                return Err("a call is longer than this server takes".into());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                write(&json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "The message is not JSON."}}))?;
                continue;
            };
            let Some(id) = message.get("id").cloned() else { continue };
            match message["method"].as_str() {
                Some("tools/call") => {
                    let (write, store) = (&write, store.clone());
                    calls.spawn(move || {
                        let reply = call(store.as_ref(), answers, &message["params"]);
                        let line = match reply {
                            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                            Err(said) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": said}}),
                        };
                        let _ = write(&line);
                    });
                }
                Some("initialize") => write(&json!({"jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "live-namespace rows", "version": env!("CARGO_PKG_VERSION")},
                }}))?,
                Some("tools/list") => {
                    let tools: Vec<Value> = by_calls::OPERATIONS.iter().map(|name| json!({
                        "name": name,
                        "description": "One operation of the person's names rows (live-namespace src/store/mod.rs Rows).",
                        "inputSchema": {"type": "object"},
                    })).collect();
                    write(&json!({"jsonrpc": "2.0", "id": id, "result": {"tools": tools}}))?;
                }
                Some("ping") => write(&json!({"jsonrpc": "2.0", "id": id, "result": {}}))?,
                _ => write(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "This server answers tools only."}}))?,
            }
        }
    })
}

/// One call: its operation answered and written as a file of `answers`, named as the call's bytes.
fn call(store: &dyn live_namespace::store::Rows, answers: &Path, params: &Value) -> Result<Value, &'static str> {
    let operation = params["name"].as_str().ok_or("a call names its operation")?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let answer = serde_json::to_vec(&by_calls::answer(store, operation, &arguments)).map_err(|_| "the answer does not encode")?;
    let file = answer_file(answers);
    std::fs::write(&file, &answer).map_err(|_| "the answer could not be written")?;
    let name = format!("{ANSWERS}/{}", file.file_name().and_then(|name| name.to_str()).ok_or("the answer has no name")?);
    let total = answer.len();
    Ok(json!({
        "content": [{"type": "text", "text": "Answered as bytes."}],
        "structuredContent": {BYTE_RESULT: {"file": name, "total": total, "offset": 0, "length": total}},
        "isError": false,
    }))
}

/// A file name no other answer of this run uses.
fn answer_file(answers: &Path) -> PathBuf {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    answers.join(format!("{}-{}.json", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<Value> {
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[test]
    fn each_call_answers_as_a_file_the_caller_reads_back_whole() {
        let folder = tempfile::tempdir().unwrap();
        let input = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "mutate", "arguments": {"scope": "@namespace/a",
                "mutation": {"id": "one", "expected_version": 0, "request_key": "k", "value": {"name": "x"}}}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let mut output = Vec::new();
        run(&Kept::Sqlite { file: "rows.sqlite".into() }, folder.path(), input.as_bytes(), &mut output).unwrap();
        let said = lines(std::str::from_utf8(&output).unwrap());
        let by_id = |id: i64| said.iter().find(|line| line["id"] == id).unwrap().clone();
        assert_eq!(by_id(1)["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(by_id(3)["result"]["tools"].as_array().unwrap().len(), by_calls::OPERATIONS.len());
        let bytes = &by_id(2)["result"]["structuredContent"][BYTE_RESULT];
        let kept = std::fs::read(folder.path().join(bytes["file"].as_str().unwrap())).unwrap();
        assert_eq!(kept.len() as u64, bytes["length"].as_u64().unwrap());
        let answer: Value = serde_json::from_slice(&kept).unwrap();
        assert_eq!(answer["answer"]["version"], 1);
    }
}
