//! A measurement against a real computer, not run by default: the core reads one large file of the person's files
//! straight through, as a player does, through an engine's door to live-namespace's session, and prints the read
//! rate, every read's wait and the bytes moved. This test plays the shell's one job (sending the core's requests, many
//! at once, with the device credential) with a plain HTTP client.
//!
//! Run: FILES_CORE_ORIGIN=https://<door> FILES_CORE_FILE=/folder/big.mov [FILES_CORE_CREDENTIAL_FILE=<a file holding
//!      the device credential>] [FILES_CORE_READS=64] [FILES_CORE_CONSUMES=<bytes per ms>]
//!      cargo test --release --test real_store -- --ignored --nocapture

use std::io::Read;
use std::sync::mpsc;
use std::time::Instant;

use files_core::{Command, Core, Event};
use serde_json::{json, Value};

fn setup(origin: &str) -> Value {
    json!({"origin": origin})
}

struct Answer {
    request: u64,
    reached: bool,
    headers: Value,
    sent_ms: u64,
    first_byte_ms: u64,
    done_ms: u64,
    body: Vec<u8>,
}

struct Shell {
    core: Core,
    started: Instant,
    answers: mpsc::Receiver<Answer>,
    sender: mpsc::Sender<Answer>,
    in_flight: usize,
    log: Vec<Command>,
    /// The `Authorization` value the door takes, when one is given.
    credential: Option<String>,
}

impl Shell {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn event(&mut self, mut kind: Value, bytes: &[u8]) {
        kind["now_ms"] = json!(self.now());
        self.core.handle(serde_json::from_value::<Event>(kind).unwrap(), bytes);
        while let Some((command, bytes)) = self.core.next_command() {
            if let Command::Send { request, url, accept, .. } = &command {
                let (request, url, accept, sender, started) = (*request, url.clone(), accept.clone(), self.sender.clone(), self.started);
                let credential = self.credential.clone();
                self.in_flight += 1;
                std::thread::spawn(move || {
                    let at = |instant: Instant| instant.duration_since(started).as_millis() as u64;
                    let sent = Instant::now();
                    let mut call = ureq::post(&url).set("content-type", "application/json").set("accept", &accept);
                    if let Some(credential) = &credential {
                        call = call.set("authorization", credential);
                    }
                    let answer = call.send_bytes(&bytes);
                    let first = Instant::now();
                    let (reached, headers, body) = match answer {
                        Ok(response) | Err(ureq::Error::Status(_, response)) => {
                            let headers: serde_json::Map<String, Value> = response
                                .headers_names()
                                .into_iter()
                                .filter_map(|name| response.header(&name).map(|value| (name.to_lowercase(), json!(value))))
                                .collect();
                            let mut body = Vec::new();
                            let _ = response.into_reader().read_to_end(&mut body);
                            (true, Value::Object(headers), body)
                        }
                        Err(_) => (false, json!({}), Vec::new()),
                    };
                    let _ = sender.send(Answer { request, reached, headers, sent_ms: at(sent), first_byte_ms: at(first), done_ms: at(Instant::now()), body });
                });
            }
            self.log.push(command);
        }
    }

    /// Deliver answers until `found` is logged.
    fn until(&mut self, from: usize, found: impl Fn(&Command) -> bool) -> Command {
        loop {
            if let Some(command) = self.log[from..].iter().find(|command| found(command)) {
                return command.clone();
            }
            let answer = self.answers.recv().expect("an answer");
            self.in_flight -= 1;
            let event = json!({"answer": {"request": answer.request, "reached": answer.reached, "sent_ms": answer.sent_ms, "first_byte_ms": answer.first_byte_ms, "done_ms": answer.done_ms, "headers": answer.headers}});
            self.event(event, &answer.body);
        }
    }
}

#[test]
#[ignore = "measures a real computer; run with FILES_CORE_ORIGIN and FILES_CORE_FILE"]
fn read_a_large_file_from_a_real_computer() {
    let origin = std::env::var("FILES_CORE_ORIGIN").expect("FILES_CORE_ORIGIN");
    let file = std::env::var("FILES_CORE_FILE").expect("FILES_CORE_FILE");
    let reads: u64 = std::env::var("FILES_CORE_READS").ok().and_then(|reads| reads.parse().ok()).unwrap_or(64);
    let consumes: Option<u64> = std::env::var("FILES_CORE_CONSUMES").ok().and_then(|rate| rate.parse().ok());
    let (sender, answers) = mpsc::channel();
    let core = Core::new(serde_json::from_value(setup(&origin)).unwrap()).unwrap();
    let credential = std::env::var("FILES_CORE_CREDENTIAL_FILE")
        .ok()
        .map(|path| format!("Bearer {}", std::fs::read_to_string(path).expect("the credential file").trim()));
    let mut shell = Shell { core, started: Instant::now(), answers, sender, in_flight: 0, log: Vec::new(), credential };

    // Find the file's item: list its folder page by page.
    let folder = match file.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(cut) => file[..cut].to_owned(),
    };
    let mut folder_id = files_core::Contract::shipped().root.id.clone();
    for part in folder.split('/').filter(|part| !part.is_empty()) {
        folder_id = find(&mut shell, &folder_id, part).0;
    }
    let leaf = &file[file.rfind('/').map_or(0, |cut| cut + 1)..];
    let (item, version) = find(&mut shell, &folder_id, leaf);
    let piece: u64 = 1 << 20;
    let opened = shell.now();
    let mut waits = Vec::new();
    for index in 0..reads {
        if let Some(rate) = consumes {
            let due = opened + index * piece / rate;
            while shell.now() < due {
                std::thread::sleep(std::time::Duration::from_millis(due - shell.now()));
            }
        }
        let from = shell.log.len();
        let asked = shell.now();
        shell.event(json!({"fetch": {"demand": 1000 + index, "item": item, "version": version, "offset": index * piece, "length": piece, "alignment": 4096}}), &[]);
        let answer = shell.until(from, |command| matches!(command, Command::Fetched { demand, .. } | Command::Failed { demand, .. } if *demand == 1000 + index));
        assert!(matches!(answer, Command::Fetched { .. }), "read {index}: {answer:?}");
        waits.push(shell.now() - asked);
        shell.event(json!({"handed": {"demand": 1000 + index}}), &[]);
    }
    let took = (shell.now() - opened).max(1);
    let asked: u64 = shell.log.iter().filter(|command| matches!(command, Command::Write { .. })).map(|command| match command {
        Command::Write { bytes, .. } => *bytes as u64,
        _ => 0,
    }).sum();
    println!("read {} MiB in {took} ms: {:.2} MiB/s; bytes written {asked}; link {:?}", reads, (reads * piece) as f64 / 1048.576 / took as f64, shell.core.link());
    println!("waits ms: {waits:?}");
}

/// The id and content version of a name in a folder, by listing it page by page.
fn find(shell: &mut Shell, folder: &str, leaf: &str) -> (String, String) {
    let mut page = Value::Null;
    for demand in 1.. {
        let from = shell.log.len();
        shell.event(json!({"list": {"demand": demand, "folder": folder, "page": page, "page_size": null}}), &[]);
        let Command::Items { items, next_page, .. } = shell.until(from, |command| matches!(command, Command::Items { .. } | Command::Failed { .. })) else {
            panic!("listing {folder} failed");
        };
        if let Some(found) = items.iter().find(|item| item.name == leaf) {
            return (found.id.clone(), found.content_version.clone().unwrap_or_default());
        }
        match next_page {
            Some(next) => page = json!(next),
            None => panic!("{leaf} is not in {folder}"),
        }
    }
    unreachable!()
}
