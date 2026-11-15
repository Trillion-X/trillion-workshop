// Purpose: The hosted-computer build. A computer whose storage its host lends (a host that gives each running object its own
// SQLite and lets it reach that database only through one statement call) runs this program's storage boundary from
// here: this program's own `src/storage` files, compiled by path with cfg `computer_build`, and the host's statement call
// reached through four imported functions (`place_host`), so nothing in this build names what kind of host it is.
//
// Non-Negotiable Invariants:
// - No storage code is copied here. `storage` is trillion-local's `src/storage/mod.rs`, `schema.rs`, `memory.rs` and
//   `hosted_sql.rs`, compiled as they are; what the cfg leaves out is named in `src/storage/mod.rs`.
// - The host is reached only through the imports below, by a JSON exchange whose cells are the hosted supply's own
//   (`hosted_sql::Cell`: null, a 64-bit float, text, bytes as hex). A 64-bit integer never crosses as a number: the
//   hosted supply binds it as text and reads it back as text, so a stamp above 2^53 is exact on any host language.
// - `check` is the same check on any supply: the memory supply in this crate's own tests on any computer, the hosted
//   supply over the imported statement call in the wasm build (`place_check`). Every step either holds or is named in
//   the report it answers.
//
// Key Concepts:
// - `Imported`: `HostSql` over the imports. `hold`/`release` do nothing: such a host runs one synchronous call of its
//   object (one `place_check`, one write) as one atomic unit, and the supply's own undo journal is every rollback.
// - The ABI (module `place_host`): `exec(ptr, len) -> i32` runs one statement from a JSON request
//   `{"sql": text, "bind": [cell]}` and answers the length of its JSON answer (`[[cell]]`), or a negative refusal
//   (-1 invalid, -2 busy, -3 too big, -4 conflict, -5 unavailable, -6 read-only); `answer(ptr)` copies that answer into
//   this module's memory; `size() -> f64` the database's bytes; `log(ptr, len)` one line of text.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![allow(dead_code)]

// The same content-free refusal identity as the source compiled below. This
// composition root lends no account state to the standalone computer build.
#[path = "../../../mcp/cause.rs"]
pub mod refusal_cause;

/// trillion-local's own source tree, so its files keep their own paths and `crate::storage` names what it names there.
#[path = "../../.."]
mod engine {
    pub mod storage;
}
pub use engine::storage;

use serde_json::{json, Value as Json};
use storage::{hosted_sql::Cell, Bound, Intent, Order, Range, Read, Storage, Value, When, Write};

/// One cell as it crosses the host's statement call in the JSON exchange.
pub fn cell_json(cell: &Cell) -> Json {
    match cell {
        Cell::Null => Json::Null,
        Cell::Real(v) => json!({ "r": v }),
        Cell::Text(v) => json!({ "t": v }),
        Cell::Blob(v) => json!({ "b": v.iter().map(|b| format!("{b:02x}")).collect::<String>() }),
    }
}

/// One cell back from the JSON exchange.
pub fn json_cell(value: &Json) -> Option<Cell> {
    if value.is_null() {
        return Some(Cell::Null);
    }
    let object = value.as_object()?;
    if let Some(v) = object.get("r") {
        return v.as_f64().map(Cell::Real);
    }
    if let Some(v) = object.get("t") {
        return v.as_str().map(|text| Cell::Text(text.to_owned()));
    }
    let hex = object.get("b")?.as_str()?;
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()).collect::<Option<Vec<u8>>>().map(Cell::Blob)
}

/// The refusal a negative answer of `exec` names.
#[track_caller]
pub fn refusal(code: i32) -> storage::Error {
    match code {
        -1 => crate::cause!(caller: storage::Error::Invalid),
        -2 => crate::cause!(caller: storage::Error::Busy),
        -3 => crate::cause!(caller: storage::Error::TooBig),
        -4 => crate::cause!(caller: storage::Error::Conflict),
        -6 => crate::cause!(caller: storage::Error::ReadOnly),
        _ => crate::cause!(caller: storage::Error::Unavailable),
    }
}

/// The checks of the storage boundary one computer must pass on whatever supply its storage is, in the record store's own
/// families: exact integers above 2^53, a bounded read of an oversized value, a named partial order, a refused put,
/// a scope rolled back and one committed, a batch, a count and an erase. Answers the report: each step that held, and
/// each that did not with why.
pub fn check(store: &dyn Storage) -> Json {
    let mut held = Vec::new();
    let mut failed = Vec::new();
    let mut step = |name: &str, outcome: Result<bool, storage::Error>| match outcome {
        Ok(true) => held.push(name.to_owned()),
        Ok(false) => failed.push(json!({ "step": name, "why": "answered wrong", "cause": crate::cause!().id() })),
        Err(error) => failed.push(json!({ "step": name, "why": format!("{error:?}"), "cause": error.cause().id() })),
    };
    const LIVE: i64 = i64::MAX;
    let row = |id: &str, valid_from: i64, body: &[u8]| -> Vec<(&'static str, Value)> {
        vec![
            ("account", Value::Text("place-check".into())),
            ("resource", Value::Text("notes".into())),
            ("id", Value::Text(id.into())),
            ("valid_to", Value::Integer(LIVE)),
            ("valid_from", Value::Integer(valid_from)),
            ("version", Value::Integer(1)),
            ("deleted", Value::Integer(0)),
            ("body", Value::Blob(body.to_vec())),
            ("ring", Value::Null),
            ("kind", Value::Text("note".into())),
        ]
    };
    let key = |id: &str| vec![Value::Text("place-check".into()), Value::Text("notes".into()), Value::Text(id.into()), Value::Integer(LIVE)];
    let scope = Range {
        order: Order::Key,
        from: Bound::Included(vec![Value::Text("place-check".into())]),
        to: Bound::Included(vec![Value::Text("place-check".into()), Value::Text("notes".into()), Value::Text("\u{10ffff}".into())]),
        reverse: false,
        limit: None,
    };
    // A stamp above 2^53, which a 64-bit float cannot hold exactly.
    let stamp: i64 = (1_762_250_000_000_i64 << 16) + 12_345;
    step("put", store.put("versions", &row("a", stamp, b"first"), When::New).map(|n| n == 1));
    step("get exact integers", store.get("versions", &key("a"), &[Read::whole("valid_from"), Read::whole("valid_to"), Read::whole("body")]).map(|row| {
        row.is_some_and(|row| row.0 == vec![Value::Integer(stamp), Value::Integer(LIVE), Value::Blob(b"first".to_vec())])
    }));
    step("bounded read", store.put("versions", &row("big", 1, &[7u8; 4096]), When::New).and_then(|_| {
        store.get("versions", &key("big"), &[Read::at_most("body", 16)]).map(|row| row.is_some_and(|row| row.0 == vec![Value::Oversized(4096)]))
    }));
    step("refused put", Ok(matches!(store.put("versions", &row("a", 2, b"again"), When::New), Ok(0) | Err(storage::Error::Conflict(_)))));
    step("named partial order", store.scan("versions", &Range::all().order(Order::Named("live")), &[Read::whole("id")]).map(|rows| rows.len() == 2));
    step("scope rolled back", (|| {
        store.open_scope(Intent::Write)?;
        store.put("versions", &row("rolled", 3, b"gone"), When::New)?;
        store.close_scope(false)?;
        Ok(store.get("versions", &key("rolled"), &[Read::whole("id")])?.is_none())
    })());
    step("scope committed", (|| {
        store.open_scope(Intent::Write)?;
        store.put("versions", &row("kept", 4, b"kept"), When::New)?;
        store.close_scope(true)?;
        Ok(store.get("versions", &key("kept"), &[Read::whole("id")])?.is_some())
    })());
    step("batch write", (|| {
        let one = row("b1", 5, b"one");
        let two = row("b2", 6, b"two");
        let answered = store.write_many(&[Write::Put { family: "versions", row: &one, when: When::New }, Write::Put { family: "versions", row: &two, when: When::New }])?;
        Ok(answered == vec![1, 1])
    })());
    step("count", store.count("versions", &scope).map(|n| n == 5));
    step("reverse page", store.scan("versions", &scope.clone().reverse().limit(2), &[Read::whole("id")]).map(|rows| {
        rows.iter().map(|row| row.0[0].as_text().unwrap_or_default().to_owned()).collect::<Vec<_>>() == ["rolled", "kept"].map(String::from).to_vec()
            || rows.iter().map(|row| row.0[0].as_text().unwrap_or_default().to_owned()).collect::<Vec<_>>() == ["kept", "big"].map(String::from).to_vec()
    }));
    step("erase", store.erase("versions", &scope).map(|n| n == 5));
    step("empty after erase", store.count("versions", &scope).map(|n| n == 0));
    json!({ "held": held.len(), "failed": failed, "steps": held })
}

/// The hosted supply over the imported statement call (the wasm build).
#[cfg(target_arch = "wasm32")]
mod imported {
    use super::{cell_json, json_cell, refusal, storage};
    use storage::{hosted_sql::{Cell, HostSql}, Intent, Result};

    #[link(wasm_import_module = "place_host")]
    extern "C" {
        fn exec(request: *const u8, length: usize) -> i32;
        fn answer(into: *mut u8);
        fn size() -> f64;
        fn log(text: *const u8, length: usize);
    }

    /// One line of text to the host's log.
    pub fn say(text: &str) {
        // SAFETY: the host reads `length` bytes at `text`, which this module owns for the call.
        unsafe { log(text.as_ptr(), text.len()) }
    }

    /// The host's lent database, reached only through the imports.
    pub struct Imported;

    impl HostSql for Imported {
        fn exec(&self, sql: &str, bind: &[Cell]) -> Result<Vec<Vec<Cell>>> {
            let request = serde_json::json!({ "sql": sql, "bind": bind.iter().map(cell_json).collect::<Vec<_>>() }).to_string();
            // SAFETY: the host reads `length` bytes at `request`, owned here for the call.
            let length = unsafe { exec(request.as_ptr(), request.len()) };
            if length < 0 {
                return Err(refusal(length));
            }
            let mut bytes = vec![0u8; length as usize];
            // SAFETY: the host writes exactly the `length` bytes it answered into the buffer made for them.
            unsafe { answer(bytes.as_mut_ptr()) };
            let rows: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(storage::Error::Unavailable, error))?;
            rows.as_array()
                .ok_or(crate::cause!(storage::Error::Unavailable))?
                .iter()
                .map(|row| row.as_array().ok_or(crate::cause!(storage::Error::Unavailable))?.iter().map(|cell| json_cell(cell).ok_or(crate::cause!(storage::Error::Unavailable))).collect())
                .collect()
        }
        fn hold(&self, _intent: Intent) -> Result<()> {
            Ok(())
        }
        fn release(&self) -> Result<()> {
            Ok(())
        }
        fn mark(&self) -> Result<i64> {
            Ok(0)
        }
        fn bytes(&self) -> Result<u64> {
            // SAFETY: a plain call that returns a number.
            Ok(unsafe { size() } as u64)
        }
        fn custody(&self) -> Result<()> {
            Ok(())
        }
        fn overwrites_removed(&self) -> bool {
            false
        }
    }
}

/// The computer's own check on its host's database, run once per call: the hosted supply opened in the record store's
/// schema over the imported statement call, `check` run on it, and its report logged. Answers the steps that failed
/// (0: every step held; -1: the supply did not open).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn place_check() -> i32 {
    let supply = match storage::hosted_sql::open(imported::Imported, "record_store", 1 << 20) {
        Ok(supply) => supply,
        Err(error) => {
            imported::say(&format!("{{\"opened\":false,\"why\":\"{error:?}\"}}"));
            return -1;
        }
    };
    let report = check(&supply);
    imported::say(&report.to_string());
    report["failed"].as_array().map_or(-1, |failed| failed.len() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_holds_on_the_memory_supply() {
        let memory = storage::memory::Memory::open("record_store").unwrap();
        let report = check(&memory);
        assert_eq!(report["failed"], json!([]), "{report}");
        assert_eq!(report["held"], 12);
    }

    #[test]
    fn cells_cross_the_exchange_unchanged() {
        for cell in [Cell::Null, Cell::Real(1.5), Cell::Text("ünï".into()), Cell::Blob(vec![0, 255, 16])] {
            assert_eq!(json_cell(&cell_json(&cell)), Some(cell));
        }
    }
}
