// examples/native_serve_clone.rs
//
// Purpose: Run the repo's own `native-serve` composition (`native_entry::run_selected`) against a CLONE of a selected
// state folder, without the Mac app, and drive real HTTP requests at it. The parent mode plays the Mac parent: it
// starts the child, writes the one launch message the app writes, keeps the parent pipe open, waits for startup
// preparation to reach a terminal line on the child's stderr, then sends the requests a plan names and records each
// answer's status, time, size and BLAKE3, with the child's resident memory before and after every request.
//
// Non-Negotiable Invariants:
// - Never a live state: the child takes the state's own state lock (`local-runtime.lock`), so a state a running app
//   holds is refused by the same state lock check the app's own engine uses.
// - The descriptor names the clone; `Selection::from_descriptor` refuses a descriptor whose `state` differs from the
//   folder asked for, so the selection cannot reach the original.
// - Stdout and the result file hold counts, statuses, timings and digests only. The browser session token is read
//   from the clone's own `browser-session.key` and sent in the cookie; it is never printed or written.
//
// Key Concepts:
// - The plan is DATA (a JSON file): `requests: [{name, method, path, headers?, body?, body_from?, report?}]`.
//   `body_from` copies a value out of an earlier answer into this request's body: `{step, pointer, into}` (JSON
//   pointers). `report` lists JSON pointers of answer fields whose shape is copied into the result row: numbers, flags
//   and null as they are, text, lists and objects as their length.
// - Startup lines: the child's stderr is written to a file; lines starting `native-startup-preparation status=` are
//   the same protocol the Mac app reads (macos/Shared/StartupPreparationDiagnostics.swift in the app repository).
//
// Security Considerations:
// - Loopback only (`from_descriptor` refuses other addresses). The session token never leaves the two processes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage:
//   native_serve_clone serve DESCRIPTOR CARRIED_SELECTION STATE ADDRESS
//   native_serve_clone probe DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN STDERR_FILE RESULT_FILE WAIT_SECONDS
//   native_serve_clone probe-clone SOURCE DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN STDERR_FILE RESULT_FILE WAIT_SECONDS
// CARRIED_SELECTION is an app's carried frontend selection (`native_boot::CARRIED_SELECTION` in its frontend folder).
//
// `probe-clone` first makes STATE as one APFS copy-on-write clone of the whole SOURCE folder (clonefile(2) on the
// directory), then probes STATE. SOURCE is only read by the file system's clone call, never opened by the engine, so
// a kept restore point stays byte-for-byte unchanged. STATE must not exist yet.

use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use trillion_local::{native_boot::Selection, native_entry::run_selected}; // PACKAGE-SET-IDENTITY-EXEMPT: this repository's own crate, named once here
use std::{
    ffi::CString,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") if args.len() == 5 => serve(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3]), args[4].parse()?),
        Some("probe") if args.len() == 9 => probe(&args[1..]),
        Some("probe-clone") if args.len() == 10 => {
            clone_folder(Path::new(&args[1]), Path::new(&args[4]))?;
            probe(&args[2..])
        }
        _ => Err("usage: native_serve_clone serve DESCRIPTOR CARRIED_SELECTION STATE ADDRESS | probe DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN STDERR_FILE RESULT_FILE WAIT_SECONDS | probe-clone SOURCE DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN STDERR_FILE RESULT_FILE WAIT_SECONDS".into()),
    }
}

/// One copy-on-write clone of a whole folder; refuses an existing target or a source that is not a directory.
fn clone_folder(source: &Path, target: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !std::fs::symlink_metadata(source)?.is_dir() { return Err("clone source is not a directory".into()); }
    if std::fs::symlink_metadata(target).is_ok() { return Err("clone target already exists".into()); }
    let (from, to) = (CString::new(source.as_os_str().as_bytes())?, CString::new(target.as_os_str().as_bytes())?);
    clonefile(&from, &to)?;
    Ok(())
}

/// One clonefile(2) call. It exists only on macOS; elsewhere refuse rather than copy, since a copy is not one
/// atomic clone of the source.
#[cfg(target_os = "macos")]
fn clonefile(from: &CString, to: &CString) -> std::io::Result<()> {
    // SAFETY: both arguments are valid NUL-terminated paths that outlive the call.
    if unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn clonefile(_from: &CString, _to: &CString) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "clone needs macOS clonefile(2)"))
}

/// The child: the same composition `trillion-local native-serve` runs, selected from an explicit descriptor.
fn serve(descriptor: &Path, carried: &Path, state: &Path, address: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    run_selected(Selection::from_descriptor(descriptor, carried, state, address)?, address)
}

fn resident_kib(pid: u32) -> Option<u64> {
    let out = Command::new("/bin/ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

/// Wait for a terminal startup line on the child's stderr file (or the wait to end); return every status line seen.
fn wait_for_startup(stderr: &Path, wait: Duration, child: &mut Child) -> Result<(Vec<String>, f64), Box<dyn std::error::Error>> {
    let started = Instant::now();
    loop {
        let text = std::fs::read_to_string(stderr).unwrap_or_default();
        let lines: Vec<String> = text.lines().filter(|l| l.starts_with("native-startup-preparation status=")).map(str::to_owned).collect();
        let terminal = lines.iter().any(|l| {
            let status = &l["native-startup-preparation status=".len()..];
            status == "Failed" || status == "Cancelled" || status.starts_with("ScopedComplete") || status.starts_with("Incomplete")
        });
        if terminal || started.elapsed() >= wait {
            return Ok((lines, started.elapsed().as_secs_f64()));
        }
        if let Some(status) = child.try_wait()? {
            return Err(format!("native child ended before startup finished: {status}").into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// One HTTP/1.1 exchange on a fresh loopback connection; the body is de-chunked.
/// The `x-trillion-*-stage` headers come back too: the engine names a refusal's stage there, never a record value.
fn exchange(address: SocketAddr, request: &[u8]) -> Result<(u16, Vec<u8>, serde_json::Map<String, Value>), Box<dyn std::error::Error>> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.write_all(request)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("response has no header end")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status: u16 = head.split_whitespace().nth(1).ok_or("response has no status")?.parse()?;
    let mut body = raw[split + 4..].to_vec();
    if head.lines().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked")) {
        let mut reader = BufReader::new(&body[..]);
        let mut joined = Vec::new();
        loop {
            let mut size = String::new();
            reader.read_line(&mut size)?;
            let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16)?;
            if size == 0 { break; }
            let mut chunk = vec![0; size];
            reader.read_exact(&mut chunk)?;
            joined.extend(chunk);
            let mut end = [0u8; 2];
            reader.read_exact(&mut end)?;
        }
        body = joined;
    }
    let stages = head.lines().filter_map(|l| l.split_once(':')).filter(|(k, _)| { let k = k.to_ascii_lowercase(); k.starts_with("x-trillion-") && k.ends_with("-stage") })
        .map(|(k, v)| (k.to_ascii_lowercase(), Value::String(v.trim().to_owned()))).collect();
    Ok((status, body, stages))
}

fn probe(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (descriptor, state, address) = (PathBuf::from(&args[0]), PathBuf::from(&args[2]), args[3].parse::<SocketAddr>()?);
    let plan: Value = serde_json::from_slice(&std::fs::read(&args[4])?)?;
    let (stderr_file, result_file) = (PathBuf::from(&args[5]), PathBuf::from(&args[6]));
    let wait = Duration::from_secs(args[7].parse()?);
    let selection: Value = serde_json::from_slice(&std::fs::read(&descriptor)?)?;
    let identity = selection["receipt_identity"].as_str().ok_or("descriptor has no receipt_identity")?;
    let token = std::fs::read_to_string(state.join("browser-session.key"))?.trim().to_owned();

    let started = Instant::now();
    let mut child = Command::new(std::env::current_exe()?)
        .args(["serve", &args[0], &args[1], &args[2], &args[3]])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(std::fs::File::create(&stderr_file)?)
        .spawn()?;
    let key: String = (0..32).map(|_| format!("{:02x}", rand_byte())).collect();
    let owner: String = (0..32).map(|_| format!("{:02x}", rand_byte())).collect();
    let launch = json!({"version": "trillion.local-runtime-launch/v1", "boot_id": format!("clone-probe-{}", std::process::id()),
        "state_identity": identity, "origin": format!("http://{address}"), "owner_pid": child.id(), "readiness_key": key,
        "owner_binding": owner});
    let mut input = child.stdin.take().ok_or("child stdin")?;
    input.write_all(format!("{launch}\n").as_bytes())?;
    input.flush()?;

    let (startup, startup_seconds) = wait_for_startup(&stderr_file, wait, &mut child)?;
    let mut answers: Vec<(String, Value)> = Vec::new();
    let mut results = Vec::new();
    for step in plan["requests"].as_array().ok_or("plan has no requests")? {
        let name = step["name"].as_str().ok_or("request has no name")?.to_owned();
        let method = step["method"].as_str().unwrap_or("GET");
        let path = step["path"].as_str().ok_or("request has no path")?;
        let mut body = step.get("body").cloned();
        if let Some(from) = step.get("body_from") {
            let source = answers.iter().find(|(n, _)| Some(n.as_str()) == from["step"].as_str()).map(|(_, v)| v).ok_or("body_from names no earlier answer")?;
            let value = source.pointer(from["pointer"].as_str().unwrap_or("")).cloned().ok_or("body_from pointer is absent")?;
            let target = body.as_mut().and_then(|b| b.pointer_mut(from["into"].as_str().unwrap_or(""))).ok_or("body_from into is absent")?;
            *target = value;
        }
        let body_bytes = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nCookie: nm_session={token}\r\nConnection: close\r\nAccept: application/json\r\n");
        for (k, v) in step["headers"].as_object().into_iter().flatten() {
            head.push_str(&format!("{k}: {}\r\n", v.as_str().unwrap_or("")));
        }
        if !body_bytes.is_empty() {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body_bytes.len()));
        }
        head.push_str("\r\n");
        let mut request = head.into_bytes();
        request.extend(&body_bytes);
        let before = resident_kib(child.id());
        let sent = Instant::now();
        let (status, bytes, stages) = exchange(address, &request)?;
        let ms = sent.elapsed().as_secs_f64() * 1000.0;
        let after = resident_kib(child.id());
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let failure = parsed.get("failure_code").or_else(|| parsed.get("error")).cloned().unwrap_or(Value::Null);
        // `report` names answer fields; only their shape leaves the probe: numbers, flags and null as they are, text,
        // lists and objects as their length, so no record value reaches the result.
        let shape = |value: Option<&Value>| match value {
            Some(Value::String(text)) => json!({"text_chars": text.chars().count()}),
            Some(Value::Array(items)) => json!({"items": items.len()}),
            Some(Value::Object(fields)) => json!({"fields": fields.len()}),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        let reported: serde_json::Map<String, Value> = step["report"].as_array().into_iter().flatten()
            .filter_map(Value::as_str).map(|p| (p.to_owned(), shape(parsed.pointer(p)))).collect();
        let row = json!({"name": name, "method": method, "status": status, "ms": ms, "bytes": bytes.len(),
            "blake3": blake3::hash(&bytes).to_hex().as_str(), "failure": failure, "stages": stages, "reported": reported,
            "rss_kib_before": before, "rss_kib_after": after});
        println!("{row}");
        results.push(row);
        answers.push((name, parsed));
    }
    let resident = resident_kib(child.id());
    drop(input);
    let ended = child.wait()?;
    let report = json!({"startup_lines": startup, "startup_wait_seconds": startup_seconds, "requests": results,
        "rss_kib_end": resident, "child_exit": ended.code(), "total_seconds": started.elapsed().as_secs_f64()});
    std::fs::write(&result_file, serde_json::to_vec_pretty(&report)?)?;
    Ok(())
}

/// A launch key byte from the OS random source; the key only binds this probe's own child.
fn rand_byte() -> u8 {
    let mut byte = [0u8; 1];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut byte)).expect("OS random source");
    byte[0]
}
