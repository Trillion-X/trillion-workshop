//! Bounded local stdin/stdout fixture protocol. Public origin/CA and address/owner metadata only;
//! never print an account key, passkey, cookie, vault value or request body.
use super::{computer::Fixture, Settings};
use serde_json::{json, Value};
use std::{
    io::Write,
    time::{Duration, Instant},
};

fn emit(settings: &Settings, value: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}{}", settings.control_prefix, value).unwrap();
    out.flush().unwrap();
}

fn line(deadline: Instant, limit: usize) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // The test owns stdin; poll bounds both an idle parent and a partial control line.
        let ready = unsafe {
            libc::poll(
                &mut fd,
                1,
                i32::try_from(left.as_millis()).unwrap_or(i32::MAX),
            )
        };
        if ready <= 0 {
            return None;
        }
        let mut byte = [0];
        let read = unsafe { libc::read(libc::STDIN_FILENO, byte.as_mut_ptr().cast(), 1) };
        if read <= 0 {
            return None;
        }
        if byte[0] == b'\n' {
            return Some(body);
        }
        if body.len() >= limit {
            return None;
        }
        body.push(byte[0]);
    }
}

pub fn run(settings: Settings) {
    let mut fixture = Fixture::start(settings.clone());
    emit(
        &settings,
        json!({"event":"ready","version":settings.version,"origin":fixture.origin,
        "ca_pem":String::from_utf8(fixture.ca_pem.clone()).unwrap(),"pid":std::process::id()}),
    );
    let deadline = Instant::now() + Duration::from_millis(settings.lifetime_ms);
    while let Some(bytes) = line(deadline, settings.maximum_control_bytes) {
        let Ok(command) = serde_json::from_slice::<Value>(&bytes) else {
            emit(&settings, json!({"error":"invalid-control"}));
            continue;
        };
        let id = command.get("id").and_then(Value::as_u64);
        match command.get("method").and_then(Value::as_str) {
            Some("read-created-account") => {
                let found = command
                    .get("address")
                    .and_then(Value::as_str)
                    .and_then(|address| fixture.read_created_account(address));
                emit(
                    &settings,
                    match found {
                        Some(found) => json!({"id":id,"result":found}),
                        None => json!({"id":id,"error":"account-not-created"}),
                    },
                );
            }
            Some("close") => {
                let closed = fixture.close();
                emit(&settings, json!({"id":id,"result":closed}));
                return;
            }
            _ => emit(&settings, json!({"id":id,"error":"unknown-control"})),
        }
    }
    let closed = fixture.close();
    emit(&settings, json!({"event":"closed","result":closed}));
}
