//! crates/formula-engine/src/main.rs
//!
//! Purpose
//!   The formula engine as one WebAssembly component (built for wasm32-wasip2): the program the engine runs for the
//!   formula tool rows on any computer, whatever its system (trillion-rust src/tool_runs/tools/component.rs runs it as
//!   a WASI command in the run's folder). A row's argv names the request after the component's file:
//!     ["component", "<this .wasm>", "<request>"]   the request object on standard input
//!   and its last line on standard output is `{"result": ...}`, or `{"error": "..."}` with a failing exit.
//!
//!   Requests: filterRecords, evaluateFormula, listComparisons, classifyRecord (and compileRules, holds, testsHold,
//!   filterRows, evaluate), the same functions the wasm-bindgen module offers a JavaScript host.
//!
//! Non-negotiable invariants
//!   - The component reads only its standard input and writes only its standard output: no file, network, secret or
//!     door, so a row runs it with nothing but its own bytes.

use std::io::{Read, Write};

use formula_engine::guards::now_ms;
use formula_engine::{classify, requests, Refused};
use serde_json::{json, Value};

fn run(name: &str, request: &Value) -> Result<Value, Refused> {
    match name {
        "filterRecords" => requests::filter_records(request, &now_ms),
        "evaluateFormula" => requests::evaluate_formula(request, &now_ms),
        "listComparisons" => requests::list_comparisons(request),
        "classifyRecord" => classify::classify_record(request),
        "compileRules" => requests::compile_rules(request),
        "holds" => requests::holds(request, &now_ms).map(Value::Bool),
        "testsHold" => requests::tests_hold(request, &now_ms).map(Value::Bool),
        "filterRows" => requests::filter_rows(request, &now_ms),
        "evaluate" => requests::evaluate(request, &now_ms),
        other => Err(Refused::Sentence(format!("Unknown request: {other}."))),
    }
}

fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let mut text = String::new();
    let answer = std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| Refused::Sentence(format!("The request could not be read: {error}")))
        .and_then(|_| {
            let request = if text.trim().is_empty() { json!({}) } else {
                serde_json::from_str(&text).map_err(|error| Refused::Sentence(format!("The request is not JSON: {error}")))?
            };
            run(&name, &request)
        });
    let (line, failed) = match answer {
        Ok(result) => (json!({"result": result}), false),
        Err(refused) => (json!({"error": refused.message()}), true),
    };
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    if failed {
        std::process::exit(1);
    }
}
