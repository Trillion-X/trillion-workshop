// src/main.rs
//
// Purpose: The records tool program: the person's own records, served from one state folder.
//
//   live-records mcp --state FOLDER [--settings FILE] [--computer JSON]   MCP over stdio: each operation of the records door is a tool
//
// A credential is never an argument: the engine attaches the person's database connection to the run on the file descriptor
// `settings.json` `attached` names (src/serve/mod.rs). The program opens no port: the engine runs `mcp` as a session that takes calls (its
// tool row), and every caller reaches the person's records through the engine's one door. `--computer` is what the engine fills for every
// session; the records are the person's, not a computer's, so it is read and not used.
//
// Non-Negotiable Invariants:
// - A refusal names what was wrong with the run, never a value of the connection.
// - `mcp` ends when its input ends and every call has answered.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod serve;

use live_records::settings::Settings;
use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
};

const USAGE: &str = "usage: live-records mcp --state FOLDER [--settings FILE] [--computer JSON]";

/// The settings file the tool ships, when none is named.
const SHIPPED_SETTINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json");

struct Command {
    state: PathBuf,
    settings: PathBuf,
}

fn parse(args: &[String]) -> Result<Command, String> {
    if args.first().map(String::as_str) != Some("mcp") {
        return Err(USAGE.into());
    }
    let (mut state, mut settings) = (None, None);
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        match (flag.as_str(), rest.next()) {
            ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
            ("--settings", Some(file)) => settings = Some(PathBuf::from(file)),
            ("--computer", Some(text)) if serde_json::from_str::<serde_json::Value>(text).is_ok_and(|computer| computer["id"].is_string()) => {}
            _ => return Err(USAGE.into()),
        }
    }
    Ok(Command { state: state.ok_or(USAGE)?, settings: settings.unwrap_or_else(|| PathBuf::from(SHIPPED_SETTINGS)) })
}

fn run(command: Command) -> Result<(), String> {
    let settings = Settings::read(&command.settings).map_err(|error| error.to_string())?;
    let message_bytes = settings.bounds.message_bytes;
    let records = Arc::new(serve::open(&settings, &command.state).map_err(|error| error.to_string())?);
    serve::mcp::serve(records, message_bytes, BufReader::new(io::stdin()), io::stdout())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(refusal) => {
            live_records::quiet_eprintln!("live-records: {refusal}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &[&str]) -> Vec<String> {
        text.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn mcp_takes_the_state_and_the_computer_the_engine_fills_and_refuses_anything_else() {
        assert!(parse(&words(&["mcp", "--state", "/s", "--computer", r#"{"id":"computer-1","label":"Example Mac"}"#])).is_ok());
        assert!(parse(&words(&["mcp", "--state", "/s"])).is_ok());
        assert!(parse(&words(&["mcp", "--state", "/s", "--computer", r#"{"label":"Example Mac"}"#])).is_err());
        assert!(parse(&words(&["mcp"])).is_err());
        assert!(parse(&words(&["serve", "--state", "/s"])).is_err());
    }
}
