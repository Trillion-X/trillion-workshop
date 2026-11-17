//! The C ABI a shell uses: the header names exactly the functions src/ffi.rs exports, and a listing goes through
//! them end to end (event in, request out with its body beside it, answer in, items out), with a buffer too small
//! for a command losing nothing.

use std::collections::BTreeSet;

use files_core::ffi::{files_core_event, files_core_free, files_core_new, files_core_next_command, files_core_refusal, files_core_take_bytes};
use serde_json::{json, Value};

fn exported(text: &str, marker: &str) -> BTreeSet<String> {
    text.split(marker)
        .skip(1)
        .filter_map(|rest| rest.split('(').next())
        .map(|name| name.trim().trim_start_matches('*').to_owned())
        .filter(|name| name.starts_with("files_core_"))
        .collect()
}

#[test]
fn the_header_names_every_exported_function() {
    let header = include_str!("../include/files_core.h");
    let source = include_str!("../src/ffi.rs");
    let in_header: BTreeSet<String> = header
        .lines()
        .filter(|line| !line.trim_start().starts_with('*') && !line.trim_start().starts_with("/*"))
        .flat_map(|line| line.split(|character: char| !(character.is_alphanumeric() || character == '_' || character == '(')))
        .filter_map(|word| word.strip_suffix('(').or_else(|| word.split('(').next().filter(|_| word.contains('('))))
        .filter(|word| word.starts_with("files_core_"))
        .map(str::to_owned)
        .collect();
    assert_eq!(in_header, exported(source, "pub unsafe extern \"C\" fn "));
}

fn next(core: *mut files_core::ffi::FilesCore) -> Option<(Value, Vec<u8>)> {
    let mut small = [0u8; 4];
    // SAFETY: a live core and buffers of the lengths given.
    unsafe {
        let needed = files_core_next_command(core, small.as_mut_ptr(), small.len());
        if needed == 0 {
            return None;
        }
        // Too small: nothing copied, and the same command waits.
        assert!(needed > small.len());
        let mut buffer = vec![0u8; needed];
        assert_eq!(files_core_next_command(core, buffer.as_mut_ptr(), buffer.len()), needed);
        let command: Value = serde_json::from_slice(&buffer).unwrap();
        let mut bytes = vec![0u8; files_core_take_bytes(core, std::ptr::null_mut(), 0)];
        files_core_take_bytes(core, bytes.as_mut_ptr(), bytes.len());
        Some((command, bytes))
    }
}

fn event(core: *mut files_core::ffi::FilesCore, event: Value, bytes: &[u8]) -> usize {
    let text = event.to_string();
    // SAFETY: a live core and buffers of the lengths given.
    unsafe { files_core_event(core, text.as_ptr(), text.len(), bytes.as_ptr(), bytes.len()) }
}

/// The door's answer carrying `result` (trillion-rust src/mcp.rs `tool_outcome`).
fn answer(core: *mut files_core::ffi::FilesCore, request: Value, now_ms: u64, result: &Value) {
    let body = json!({"jsonrpc": "2.0", "id": request, "result": {"content": [{"type": "text", "text": result.to_string()}], "structuredContent": result, "isError": false}}).to_string();
    let answered = json!({"now_ms": now_ms, "answer": {"request": request, "reached": true, "sent_ms": now_ms - 1, "first_byte_ms": now_ms - 1, "done_ms": now_ms}});
    assert_eq!(event(core, answered, body.as_bytes()), 0);
}

#[test]
fn a_listing_goes_through_the_c_abi() {
    let setup = json!({"device": "device-a", "device_label": "Example Laptop", "computers": [{"origin": "https://computer.example.com"}], "root": {"id": "trillion", "name": "Trillion", "folder": "/"}}).to_string();
    // SAFETY: the setup buffer is valid for its length.
    let core = unsafe { files_core_new(setup.as_ptr(), setup.len()) };
    assert!(!core.is_null());
    let (ready, _) = next(core).expect("the first command");
    assert_eq!(ready, json!({"ready": {"root": "trillion", "trash": "trash"}}));
    assert_eq!(event(core, json!({"now_ms": 5, "list": {"demand": 1, "folder": "trillion", "page": null, "page_size": null}}), &[]), 0);
    // The contract's bounds come first: one door message, the operation and its input inside it.
    let (send, body) = next(core).expect("the bounds call");
    assert_eq!(send["send"]["url"], "https://computer.example.com/mcp");
    assert_eq!(send["send"]["bytes"], body.len());
    let message: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!((message["method"].as_str(), message["params"]["arguments"]["input"]["op"].as_str()), (Some("tools/call"), Some("bounds")));
    let bounds = json!({"span_most": 33554432, "piece_most": 33554432, "idle_seconds": 30});
    answer(core, send["send"]["request"].clone(), 6, &bounds);
    let (send, body) = next(core).expect("the listing");
    let message: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(message["params"]["arguments"]["input"]["op"], "list_files");
    assert_eq!(message["params"]["arguments"]["input"]["input"], json!({"device": "device-a", "folder": "/"}));
    let listing = json!({"names": [{"name": "/a.txt", "item": "item-1", "identity": "1f:aa", "byte_length": 3, "generation": 1}], "folders": [], "next_after": null});
    answer(core, send["send"]["request"].clone(), 9, &listing);
    let (wake, _) = next(core).expect("the wake for the request's deadline");
    assert!(wake.get("wake").is_some(), "{wake}");
    let (items, _) = next(core).expect("the items");
    assert_eq!(items["items"]["items"][0]["name"], "a.txt");
    assert_eq!(items["items"]["items"][0]["parent"], "trillion");
    assert!(next(core).is_none());

    // A refused event says why.
    let refused = event(core, json!({"now_ms": 10, "no_such_event": {}}), &[]);
    assert!(refused > 0);
    let mut why = vec![0u8; refused];
    // SAFETY: a live core and a buffer of the length given.
    unsafe {
        files_core_refusal(core, why.as_mut_ptr(), why.len());
        files_core_free(core);
    }
    assert!(!why.is_empty());
}

#[test]
fn a_setup_with_no_computer_is_refused() {
    let setup = json!({"device": "d", "device_label": "d", "computers": [], "root": {"id": "r", "name": "r", "folder": "/"}}).to_string();
    // SAFETY: the setup buffer is valid for its length.
    assert!(unsafe { files_core_new(setup.as_ptr(), setup.len()) }.is_null());
}
