// examples/local_door_proof.rs
//
// Purpose: Prove the local account routes the way an AI uses them: run the repo's own `native-serve` composition
// (`native_entry::run_selected`) on an APFS clone of a selected state folder, play the Mac parent (one launch message,
// parent pipe held open), then call the same-process MCP route (`POST /mcp`, `run_resource_operation`) with the
// person's own personal key from the Keychain, step by step from a plan, and record every answer.
//
// Non-Negotiable Invariants:
// - Never a live state: `clone` makes the clone with one clonefile(2) call (the source is only read by the file
//   system), and the descriptor names the clone (`Selection::from_descriptor` refuses any other folder).
// - The personal key is read from the Keychain item the product's account-key settings name, held in zeroizing
//   memory, sent only in the Authorization header to the loopback routes, and never printed or written. Every answer
//   is checked not to contain it.
//
// Key Concepts:
// - The plan is DATA (a JSON file): `requests: [{name, method?, arguments?, pause_ms?, bearer?, page?}]`. `method` is a JSON-RPC
//   method (`tools/list`, `initialize` with its `params`); `pause_ms` waits that long (trillion-local's own wake ticks and runs go on meanwhile);
//   otherwise the step calls `run_resource_operation` with `arguments` ({address, method, request_key, input}). `bearer`
//   calls as that bearer instead of the person's key (a share bearer the person handed someone). `page`
//   ({method, path, body?, key?, origin?}) is one request of the person's own signed-in page instead: the clone's
//   browser session (`<state>/browser-session.key`) as its cookie, the routes' own Origin unless `origin` names
//   another, `key` as its x-trillion-request-key; its line keeps the answer's access-control headers (a preflight's).
// - Result lines: name, HTTP status, milliseconds, the JSON-RPC result (or error).
//
// Security Considerations:
// - Loopback only; the child's stdout is the private parent channel and is drained, never shown.
// - The page's session is read from the clone, held in zeroizing memory, sent only in the Cookie header, and every
//   answer is checked not to contain it, like the personal key.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage:
//   local_door_proof clone SOURCE TARGET
//   local_door_proof serve DESCRIPTOR CARRIED_SELECTION STATE ADDRESS
//   local_door_proof run DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN RESULT_FILE STDERR_FILE WAIT_SECONDS
// CARRIED_SELECTION is an app's carried frontend selection (`native_boot::CARRIED_SELECTION` in its frontend folder).

use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use trillion_local::{native_boot::Selection, native_entry::run_selected}; // PACKAGE-SET-IDENTITY-EXEMPT: this repository's own crate, named once here
use std::{
    ffi::CString,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::ffi::OsStrExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("clone") if args.len() == 3 => clone(Path::new(&args[1]), Path::new(&args[2])),
        Some("serve") if args.len() == 5 => serve(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3]), args[4].parse()?),
        Some("run") if args.len() == 9 => run(&args[1..]),
        Some("call") if args.len() == 4 => call_running(&args[1..]),
        _ => Err("usage: local_door_proof clone SOURCE TARGET | serve DESCRIPTOR CARRIED_SELECTION STATE ADDRESS | run DESCRIPTOR CARRIED_SELECTION STATE ADDRESS PLAN RESULT_FILE STDERR_FILE WAIT_SECONDS | call ADDRESS PLAN RESULT_FILE".into()),
    }
}

/// The child: the same composition `native-serve` runs, selected from an explicit descriptor and carried selection.
fn serve(descriptor: &Path, carried: &Path, state: &Path, address: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    run_selected(Selection::from_descriptor(descriptor, carried, state, address)?, address)
}

/// One copy-on-write clone of a file or a whole folder; refuses an existing target.
fn clone(source: &Path, target: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::symlink_metadata(source)?;
    if std::fs::symlink_metadata(target).is_ok() {
        return Err("clone target already exists".into());
    }
    let (from, to) = (CString::new(source.as_os_str().as_bytes())?, CString::new(target.as_os_str().as_bytes())?);
    clonefile(&from, &to)?;
    println!("{}", json!({"cloned": target}));
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

/// The person's own personal key, from the Keychain item the launcher's product settings name (`secret_home`).
fn personal_key() -> Result<Zeroizing<String>, Box<dyn std::error::Error>> {
    let kept = trillion_local::secrets::KeychainItem::shipped()?;
    let output = Command::new(&kept.program).args(["find-generic-password", "-s", &kept.item, "-w"]).stderr(Stdio::null()).output()?;
    let text = Zeroizing::new(String::from_utf8(output.stdout).map_err(|_| "the kept key is not text")?);
    if !output.status.success() || text.trim().is_empty() {
        return Err("no personal key is kept in the Keychain".into());
    }
    Ok(Zeroizing::new(text.trim().to_owned()))
}

/// Wait for a terminal startup line on the child's stderr file; answer the status lines seen.
fn wait_for_startup(stderr: &Path, wait: Duration) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let started = Instant::now();
    loop {
        let text = std::fs::read_to_string(stderr).unwrap_or_default();
        let lines: Vec<String> = text.lines().filter(|l| l.starts_with("native-startup-preparation status=")).map(str::to_owned).collect();
        if lines.iter().any(|l| {
            let status = &l["native-startup-preparation status=".len()..];
            status == "Failed" || status == "Cancelled" || status.starts_with("ScopedComplete") || status.starts_with("Incomplete")
        }) || started.elapsed() >= wait
        {
            return Ok(lines);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// One JSON-RPC request to the account's routes; answers the HTTP status and the parsed body.
fn call(address: SocketAddr, key: &str, body: &Value) -> Result<(u16, Value), Box<dyn std::error::Error>> {
    let bytes = body.to_string();
    let mut request = Zeroizing::new(format!(
        "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\nConnection: close\r\n\
         Content-Length: {}\r\n\r\n",
        bytes.len()
    ));
    request.push_str(&bytes);
    let (status, _, answer) = send(address, &request)?;
    Ok((status, answer))
}

/// One request of the person's own page (a plan's `page` step) with its browser `session`: answers the HTTP status,
/// the answer's access-control header lines and the parsed body.
fn page_call(address: SocketAddr, session: &str, page: &Value) -> Result<(u16, Vec<String>, Value), Box<dyn std::error::Error>> {
    let method = page["method"].as_str().ok_or("a page step names its method")?;
    let path = page["path"].as_str().ok_or("a page step names its path")?;
    let origin = page["origin"].as_str().map_or_else(|| format!("http://{address}"), str::to_owned);
    let bytes = page.get("body").map(Value::to_string).unwrap_or_default();
    let mut request = Zeroizing::new(format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nCookie: nm_session={session}\r\nOrigin: {origin}\r\nConnection: close\r\n"
    ));
    if !bytes.is_empty() {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", bytes.len()));
    }
    if let Some(key) = page["key"].as_str() {
        request.push_str(&format!("x-trillion-request-key: {key}\r\n"));
    }
    if method == "OPTIONS" {
        request.push_str("Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type, x-trillion-request-key\r\n");
    }
    request.push_str("\r\n");
    request.push_str(&bytes);
    let (status, head, answer) = send(address, &request)?;
    let allowances = head.lines().filter(|line| line.starts_with("access-control-")).map(str::to_owned).collect();
    Ok((status, allowances, answer))
}

/// Send one whole HTTP/1.1 request; answers the status, the lowercased head and the parsed body.
fn send(address: SocketAddr, request: &str) -> Result<(u16, String, Value), Box<dyn std::error::Error>> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("response has no header end")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status: u16 = head.split_whitespace().nth(1).ok_or("response has no status")?.parse()?;
    let mut body = raw[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        body = dechunked(&body).ok_or("response has a malformed chunked body")?;
    }
    // A streamed answer (text/event-stream) carries the JSON-RPC reply as its last `data:` line.
    if head.contains("content-type: text/event-stream") {
        let text = String::from_utf8_lossy(&body).to_string();
        body = text.lines().rev().find_map(|line| line.strip_prefix("data:")).unwrap_or_default().trim().as_bytes().to_vec();
    }
    let answer = serde_json::from_slice(&body)
        .unwrap_or_else(|_| json!({"unparsed_body": {"bytes": body.len(), "head": head.lines().filter(|line| line.starts_with("content-")).collect::<Vec<_>>()}}));
    Ok((status, head, answer))
}

/// The bytes of an HTTP/1.1 chunked body.
fn dechunked(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let line = rest.windows(2).position(|w| w == b"\r\n")?;
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..line]).ok()?.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line + 2..];
        if size == 0 {
            return Some(body);
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (descriptor, carried, state, address) = (&args[0], &args[1], &args[2], args[3].parse::<SocketAddr>()?);
    let plan: Value = serde_json::from_slice(&std::fs::read(&args[4])?)?;
    let (result_file, stderr_file) = (Path::new(&args[5]), Path::new(&args[6]));
    let wait = Duration::from_secs(args[7].parse()?);
    let selection: Value = serde_json::from_slice(&std::fs::read(descriptor)?)?;
    let identity = selection["receipt_identity"].as_str().ok_or("descriptor has no receipt_identity")?;
    let key = personal_key()?;
    // The person's own page session in this clone, for the plan's page steps.
    let session = Zeroizing::new(std::fs::read_to_string(Path::new(state).join("browser-session.key")).unwrap_or_default().trim().to_owned());

    let mut child = Command::new(std::env::current_exe()?)
        .args(["serve", descriptor, carried, state, &args[3]])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(std::fs::File::create(stderr_file)?)
        .spawn()?;
    let readiness: String = blake3::hash(format!("door-proof-{}-{:?}", child.id(), Instant::now()).as_bytes()).to_hex().to_string();
    // The parent's door credential for this launch; this proof calls the door with its own key, never with it.
    let owner: String = blake3::hash(format!("door-proof-owner-{}-{:?}", child.id(), Instant::now()).as_bytes()).to_hex().to_string();
    // A boot id is 16 to 128 characters: the pid is padded, so a short pid still makes a valid launch.
    let launch = json!({"version": "trillion.local-runtime-launch/v1", "boot_id": format!("door-proof-{:010}", std::process::id()),
        "state_identity": identity, "origin": format!("http://{address}"), "owner_pid": child.id(), "readiness_key": readiness,
        "owner_binding": owner});
    let mut input = child.stdin.take().ok_or("child stdin")?;
    input.write_all(format!("{launch}\n").as_bytes())?;
    input.flush()?;
    // The parent channel's replies are private; drain them so the child never blocks on a full pipe.
    let mut output = child.stdout.take().ok_or("child stdout")?;
    std::thread::spawn(move || std::io::copy(&mut output, &mut std::io::sink()));

    let startup = wait_for_startup(stderr_file, wait)?;
    let mut lines = vec![json!({"startup": startup})];
    let leaked = play(address, &key, Some(&session), &plan, &mut lines)?;
    std::fs::write(result_file, lines.iter().map(|line| format!("{line}\n")).collect::<String>())?;
    drop(input);
    let stopped = Instant::now();
    while child.try_wait()?.is_none() && stopped.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    if child.try_wait()?.is_none() {
        child.kill()?;
    }
    if leaked {
        return Err("an answer contained the personal key".into());
    }
    Ok(())
}

/// Play a plan at account routes that are already running (the installed app's), with the person's key from the Keychain:
/// `call ADDRESS PLAN RESULT_FILE`. Nothing is started or stopped.
fn call_running(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let address = args[0].parse::<SocketAddr>()?;
    let plan: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let key = personal_key()?;
    let mut lines = Vec::new();
    let leaked = play(address, &key, None, &plan, &mut lines)?;
    std::fs::write(&args[2], lines.iter().map(|line| format!("{line}\n")).collect::<String>())?;
    if leaked {
        return Err("an answer contained the personal key".into());
    }
    Ok(())
}

/// Send each plan step to the routes at `address` (a `page` step as the person's page, with `session`) and add one line
/// per step to `lines`; answers whether any answer held the personal key or the page's session (a final line says so).
fn play(address: SocketAddr, key: &str, session: Option<&str>, plan: &Value, lines: &mut Vec<Value>)
    -> Result<bool, Box<dyn std::error::Error>> {
    let mut leaked = false;
    for (index, step) in plan["requests"].as_array().ok_or("plan has no requests")?.iter().enumerate() {
        let name = step["name"].as_str().unwrap_or("step");
        // A pause lets the engine's own work (a wake tick, a run) happen between two calls.
        if let Some(pause) = step["pause_ms"].as_u64() {
            std::thread::sleep(Duration::from_millis(pause));
            lines.push(json!({"name": name, "paused_ms": pause}));
            continue;
        }
        if let Some(page) = step.get("page") {
            let session = session.filter(|session| !session.is_empty()).ok_or("a page step needs the clone's browser session")?;
            let started = Instant::now();
            let (status, allowances, answer) = page_call(address, session, page)?;
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            leaked |= answer.to_string().contains(key) || answer.to_string().contains(session);
            let line = json!({"name": name, "page_status": status, "ms": ms, "access_control": allowances, "answer": answer});
            println!("{line}");
            lines.push(line);
            continue;
        }
        let body = match step["method"].as_str() {
            Some(method) => json!({"jsonrpc": "2.0", "id": index, "method": method, "params": step.get("params").cloned().unwrap_or_else(|| json!({}))}),
            None => json!({"jsonrpc": "2.0", "id": index, "method": "tools/call",
                "params": {"name": "run_resource_operation", "arguments": step["arguments"]}}),
        };
        // A step may call as another bearer (`bearer`: a share bearer someone was handed), never as a second person key.
        let bearer = step["bearer"].as_str().unwrap_or(key);
        let started = Instant::now();
        let (status, answer) = call(address, bearer, &body)?;
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        leaked |= answer.to_string().contains(key);
        let reply = answer.get("result").and_then(|result| result.get("structuredContent").or(Some(result))).cloned()
            .or_else(|| answer.get("error").cloned()).unwrap_or(Value::Null);
        let line = json!({"name": name, "status": status, "ms": ms, "is_error": answer["result"]["isError"], "answer": reply});
        println!("{line}");
        lines.push(line);
    }
    lines.push(json!({"personal_key_or_session_in_any_answer": leaked}));
    Ok(leaked)
}
