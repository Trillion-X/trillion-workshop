// src/main.rs
//
// Purpose: The Namespace tool program: the person's files, served from one state folder.
//
//   live-namespace mcp   --state FOLDER [--settings FILE] [--computer JSON]   MCP over stdio: each operation of the account files is a
//                        tool, and `this_computer` answers the computer the run is on ({id, label}, as the engine fills it)
//   live-namespace account-files-bind [show] --state FOLDER [--settings FILE]   bind the origins of the person's files to them
//   live-namespace counts --state FOLDER [--settings FILE]   how many rows each names-index table of the rows holds (only reads)
//   live-namespace copy-archive --from FILE --state FOLDER [--settings FILE]   copy an archive's ns_* tables (read-only) into the rows
//
// A credential is never an argument: the engine attaches the person's `files-store` connection (and the database's own) to the run on
// the file descriptors `settings.json` `attached` names (src/serve/mod.rs). The program opens no port: the engine runs `mcp` as a
// session that takes calls (its tool row), and every caller reaches the person's files through the engine's one door.
//
// Non-Negotiable Invariants:
// - A refusal names what was wrong with the run, never a value of the connection.
// - `mcp` ends when its input ends and every call has answered.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod serve;

use serde_json::Value;
use serve::{settings::Settings, Namespace};
use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
};

const USAGE: &str = "usage: live-namespace mcp --state FOLDER [--settings FILE] [--computer JSON] | account-files-bind [show] --state FOLDER [--settings FILE] | counts --state FOLDER [--settings FILE] | copy-archive --from FILE --state FOLDER [--settings FILE]";

/// The settings file next to the tool's own folder when none is named: the one the tool ships.
const SHIPPED_SETTINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json");

enum Command {
    Serve { state: PathBuf, settings: PathBuf, computer: Value },
    Bind { show: bool, state: PathBuf, settings: PathBuf },
    Counts { state: PathBuf, settings: PathBuf },
    CopyArchive { from: PathBuf, state: PathBuf, settings: PathBuf },
}

/// The `--state` and `--settings` flags of a command.
fn flags(args: &[String]) -> Result<(PathBuf, PathBuf), String> {
    let (mut state, mut settings) = (None, None);
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        match (flag.as_str(), rest.next()) {
            ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
            ("--settings", Some(file)) => settings = Some(PathBuf::from(file)),
            _ => return Err(USAGE.into()),
        }
    }
    Ok((state.ok_or(USAGE)?, settings.unwrap_or_else(|| PathBuf::from(SHIPPED_SETTINGS))))
}

fn parse(args: &[String]) -> Result<Command, String> {
    let command = args.first().map(String::as_str).ok_or(USAGE)?;
    match command {
        "mcp" => {
            // `--computer` comes last when it is given: the engine fills it from the computer the run is on.
            let (rest, computer) = match args.len().checked_sub(2).map(|at| (&args[at], &args[at + 1])) {
                Some((flag, text)) if flag == "--computer" => {
                    let computer: Value = serde_json::from_str(text).map_err(|_| USAGE.to_owned())?;
                    if !computer["id"].is_string() {
                        return Err(USAGE.into());
                    }
                    (&args[1..args.len() - 2], computer)
                }
                _ => (&args[1..], Value::Null),
            };
            let (state, settings) = flags(rest)?;
            Ok(Command::Serve { state, settings, computer })
        }
        "account-files-bind" => {
            let show = args.get(1).is_some_and(|word| word == "show");
            let (state, settings) = flags(&args[1 + usize::from(show)..])?;
            Ok(Command::Bind { show, state, settings })
        }
        "counts" => {
            let (state, settings) = flags(&args[1..])?;
            Ok(Command::Counts { state, settings })
        }
        "copy-archive" => {
            let (from, rest) = match (args.get(1).map(String::as_str), args.get(2)) {
                (Some("--from"), Some(file)) => (PathBuf::from(file), &args[3..]),
                _ => return Err(USAGE.into()),
            };
            let (state, settings) = flags(rest)?;
            Ok(Command::CopyArchive { from, state, settings })
        }
        _ => Err(USAGE.into()),
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Bind { show, state, settings } => {
            let settings = Settings::read(&settings).map_err(|error| error.to_string())?;
            let store = Namespace::rows(&settings, &state).map_err(|error| error.to_string())?;
            live_namespace::account_files::bind::run(&store, &settings.account, show, &mut io::stdout()).map_err(|error| error.to_string())
        }
        Command::Counts { state, settings } => {
            let settings = Settings::read(&settings).map_err(|error| error.to_string())?;
            for (table, rows) in Namespace::counts(&settings, &state).map_err(|error| error.to_string())? {
                live_namespace::quiet_println!("{table}\t{rows}");
            }
            Ok(())
        }
        Command::CopyArchive { from, state, settings } => {
            let settings = Settings::read(&settings).map_err(|error| error.to_string())?;
            let mut last = (String::new(), 0u64);
            let counts = Namespace::copy_archive(&settings, &state, &from, &mut |table, rows| {
                if table != last.0 || rows >= last.1 + 50_000 {
                    last = (table.to_owned(), rows);
                    live_namespace::quiet_eprintln!("{table}: {rows}");
                }
            })
            .map_err(|error| error.to_string())?;
            for (table, rows) in counts {
                live_namespace::quiet_println!("{table}\t{rows}");
            }
            Ok(())
        }
        Command::Serve { state, settings, computer } => {
            let settings = Settings::read(&settings).map_err(|error| error.to_string())?;
            let namespace = Arc::new(Namespace::open(&settings, &state, computer).map_err(|error| error.to_string())?);
            serve::mcp::serve(namespace, BufReader::new(io::stdin()), io::stdout())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(refusal) => {
            live_namespace::quiet_eprintln!("live-namespace: {refusal}");
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
    fn mcp_takes_the_computer_the_engine_filled_last_and_refuses_one_without_an_id() {
        let filled = parse(&words(&["mcp", "--state", "/s", "--computer", r#"{"id":"computer-1","label":"Example Mac"}"#])).unwrap();
        assert!(matches!(filled, Command::Serve { computer, .. } if computer == serde_json::json!({"id": "computer-1", "label": "Example Mac"})));
        assert!(matches!(parse(&words(&["mcp", "--state", "/s"])).unwrap(), Command::Serve { computer: Value::Null, .. }));
        assert!(parse(&words(&["mcp", "--state", "/s", "--computer", r#"{"label":"Example Mac"}"#])).is_err());
        assert!(parse(&words(&["mcp", "--state", "/s", "--computer", "not json"])).is_err());
    }
}
