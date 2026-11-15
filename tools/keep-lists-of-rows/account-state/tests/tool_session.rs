// tests/tool_session.rs
//
// Purpose: Tests macOS CLI parent-pipe lifetime, bounded result delivery, cancellation, and durable retry receipts.
//
// Non-Negotiable Invariants:
// - Parent EOF or stalled output cannot launch duplicate work; completed receipts remain replayable under the original request key.
//
// Key Concepts:
// - The CLI parent pipe controls admission and result delivery for an owned child process.
// - Durable terminal receipts support original-key retry after EOF or stalled output without duplicate tool launch.
//
// Security Considerations:
// - Child processes and tools use temporary local fixtures; ownership is limited to each spawned CLI, and invalid parent input must not start a tool.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Actual CLI parent-pipe lifetime and durable retry checks, using local fixtures.
#![cfg(target_os = "macos")]
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

struct OwnedCli(Child);
impl Drop for OwnedCli {
    fn drop(&mut self) {
        // Parent EOF reaches the normal owner first. Kill only this CLI if its
        // own bounded exit unexpectedly fails; never signal a guessed group.
        self.0.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while matches!(self.0.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn start(db: &Path, mode: &str, input: &Value) -> OwnedCli {
    let mut child = Command::new(env!("CARGO_BIN_EXE_trillion-local"))
        .arg(db).args(["fixture-owner", "fixture-tools", mode])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), input).unwrap();
    child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
    OwnedCli(child)
}
fn finish(child: &mut OwnedCli) -> Output {
    let deadline = Instant::now() + Duration::from_secs(4);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() { break status; }
        assert!(Instant::now() < deadline, "owned CLI did not exit within the bound");
        thread::sleep(Duration::from_millis(10));
    };
    let mut stdout=Vec::new(); let mut stderr=Vec::new();
    if let Some(mut pipe)=child.0.stdout.take() { pipe.read_to_end(&mut stdout).unwrap(); }
    child.0.stderr.take().unwrap().read_to_end(&mut stderr).unwrap();
    Output { status, stdout, stderr }
}

#[test]
fn unread_result_delivery_is_bounded_and_parent_eof_preserves_a_completed_receipt() {
    for close_parent in [false,true] {
        let folder=tempfile::tempdir().unwrap();
        let db=folder.path().join("tools.sqlite");
        let marker=folder.path().join("effects.txt");
        let mut command=spec(folder.path(),"large-result");
        command["executable"]=json!("/usr/bin/awk");
        command["args"]=json!(["BEGIN { for(i=0;i<200000;i++) printf \"x\"; print \"done\" >> ARGV[1]; exit 0 }",marker]);
        command["max_output_bytes"]=json!(256*1024);
        command["deadline_ms"]=json!(5000);
        let mut child=start(&db,"tool-session",&command);
        let deadline=Instant::now()+Duration::from_secs(3);
        // Observe the durable completion, rather than guessing from a sleep
        // whether the process has exited. No parent result bytes are drained.
        loop {
            if db.exists() {
                if let Ok(store)=trillion_local::store::Store::open(&db) {
                    if store.list("fixture-owner","fixture-tools","",100).unwrap()
                        .iter().any(|record| record.value["state"]=="exited") { break; }
                }
            }
            assert!(Instant::now()<deadline,"tool did not commit its completed receipt");
            thread::sleep(Duration::from_millis(10));
        }
        if close_parent { child.0.stdin.take(); }
        let output=finish(&mut child);
        assert!(!output.status.success() || close_parent);
        assert!(serde_json::from_slice::<Value>(&output.stdout).is_err(),"stalled result was reported completely delivered");
        assert_eq!(fs::read_to_string(&marker).unwrap(),"done\n");
        let mut retry=start(&db,"tool",&command);
        retry.0.stdin.take();
        // This retry deliberately reads its output; only the first parent was
        // stalled. Drain concurrently so the test creates no second deadlock.
        let mut pipe=retry.0.stdout.take().unwrap();
        let reader=thread::spawn(move || {let mut bytes=Vec::new();pipe.read_to_end(&mut bytes).unwrap();bytes});
        let mut recovered=finish(&mut retry);
        recovered.stdout=reader.join().unwrap();
        assert!(recovered.status.success());
        let receipt:Value=serde_json::from_slice(&recovered.stdout).unwrap();
        assert_eq!(receipt["state"],"exited");
        assert_eq!(receipt["replayed"],true);
        assert_eq!(receipt["report"]["exit_code"],0);
        assert_eq!(receipt["final_receipt_stored"],true);
        assert_eq!(fs::read_to_string(&marker).unwrap(),"done\n");
    }
}
fn spec(folder: &Path, key: &str) -> Value {
    json!({"request_key":key,"executable":"/usr/bin/printf","args":["local-result"],
        "cwd":folder,"deadline_ms":2000,"max_output_bytes":4096})
}

#[test]
fn live_parent_receives_terminal_result_without_closing_its_input() {
    let folder=tempfile::tempdir().unwrap();
    let mut child=start(&folder.path().join("tools.sqlite"),"tool-session",&spec(folder.path(),"live"));
    let output=finish(&mut child);
    assert!(output.status.success(), "{}",String::from_utf8_lossy(&output.stderr));
    let receipt:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["state"],"exited");
    assert_eq!(receipt["report"]["exit_code"],0);
    assert_eq!(receipt["report"]["cleanup_confirmed"],true);
    assert_eq!(receipt["replayed"],false);
}

#[test]
fn parent_eof_stops_real_tool_suppresses_reply_and_retries_original_without_launch() {
    let folder=tempfile::tempdir().unwrap();
    let db=folder.path().join("tools.sqlite");
    let marker=folder.path().join("effects.txt");
    let mut command=spec(folder.path(),"parent-eof");
    command["executable"]=json!("/bin/sh");
    command["args"]=json!(["-c","printf 'started\\n' >> \"$1\"; /bin/sleep 20; printf 'finished\\n' >> \"$1\"","fixture",marker]);
    command["deadline_ms"]=json!(5000);
    let mut child=start(&db,"tool-session",&command);
    let deadline=Instant::now()+Duration::from_secs(3);
    while fs::read_to_string(&marker).unwrap_or_default()!="started\n" {
        assert!(Instant::now()<deadline,"real tool did not reach its marker");
        assert!(child.0.try_wait().unwrap().is_none(),"CLI exited before the real tool marker");
        thread::sleep(Duration::from_millis(10));
    }
    child.0.stdin.take();
    let output=finish(&mut child);
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    assert!(output.stdout.is_empty(),"closed parent received a result");
    assert_eq!(fs::read_to_string(&marker).unwrap(),"started\n");
    let mut retry=start(&db,"tool",&command);
    retry.0.stdin.take();
    let output=finish(&mut retry);
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let receipt:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["state"],"unknown");
    assert_eq!(receipt["replayed"],true);
    assert_eq!(receipt["final_receipt_stored"],true);
    assert_eq!(receipt["report"]["reason"],"cancelled");
    assert_eq!(receipt["report"]["cleanup_confirmed"],true);
    assert_eq!(fs::read_to_string(&marker).unwrap(),"started\n");
}

#[test]
fn prebuffered_extra_input_and_already_closed_parent_never_start_a_tool() {
    let folder=tempfile::tempdir().unwrap();
    for mode in ["extra", "closed"] {
        let marker=folder.path().join(format!("must-not-exist-{mode}"));
        let mut command=spec(folder.path(),mode);
        command["executable"]=json!("/usr/bin/touch");
        command["args"]=json!([marker]);
        // Prepare the complete pipe contents before spawning the CLI so the
        // startup observation cannot depend on scheduler timing.
        let mut descriptors=[0;2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) },0);
        use std::os::fd::{FromRawFd,OwnedFd};
        let read=unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        let mut write=fs::File::from(unsafe { OwnedFd::from_raw_fd(descriptors[1]) });
        serde_json::to_writer(&mut write,&command).unwrap();
        write.write_all(if mode=="extra" {b"\nx"} else {b"\n"}).unwrap();
        write.flush().unwrap();
        let writer=if mode=="closed" {drop(write);None} else {Some(write)};
        let mut child=OwnedCli(Command::new(env!("CARGO_BIN_EXE_trillion-local"))
            .arg(folder.path().join(format!("{mode}.sqlite")))
            .args(["fixture-owner","fixture-tools","tool-session"])
            .stdin(Stdio::from(read)).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap());
        let output=finish(&mut child);
        assert!(!output.status.success(),"invalid parent was admitted");
        assert!(output.stdout.is_empty());
        assert!(!marker.exists(),"tool started before parent admission");
        drop(writer);
    }
}
