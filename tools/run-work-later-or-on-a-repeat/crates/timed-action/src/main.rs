//! crates/timed-action/src/main.rs
//!
//! Purpose
//!   The timed-action engine as one WebAssembly component (built for wasm32-wasip2): the program the engine runs for a
//!   timed-action tool row on any computer. A row's argv names the export after the component's file:
//!     ["component", "<this .wasm>", "<export>"]   the request object on standard input
//!   and its last line on standard output is `{"result": ...}`, or `{"error": "..."}` with a failing exit.
//!
//! Non-negotiable invariants
//!   - The component reads only its standard input and writes only its standard output: no file, network, secret or
//!     door, so a row runs it with nothing but its own bytes.
//!   - An empty request is the empty object, as an optional argument reads.

use std::io::{Read, Write};

use serde_json::{json, Value};
use timed_action::requests;

fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let mut text = String::new();
    let answer = std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| format!("The request could not be read: {error}"))
        .and_then(|_| {
            let request: Value = if text.trim().is_empty() {
                requests::request_or_empty(None)
            } else {
                serde_json::from_str(&text).map_err(|error| format!("The request is not JSON: {error}"))?
            };
            requests::call(&name, &request).map_err(|refused| refused.message)
        });
    let (line, failed) = match answer {
        Ok(result) => (json!({ "result": result }), false),
        Err(message) => (json!({ "error": message }), true),
    };
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    if failed {
        std::process::exit(1);
    }
}
