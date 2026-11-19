// src/main.rs
//
// Purpose: The Namespace tool program: the person's files, served from one state folder.
//
//   live-namespace mcp   --state FOLDER [--settings FILE] [--computer JSON]   MCP over stdio: each operation of the account files is a
//                        tool, and `this_computer` answers the computer the run is on ({id, label}, as the engine fills it)
//   live-namespace serve-shares --state FOLDER [--settings FILE]   the public byte route of a share (src/share_bytes), on the loopback
//                        address settings.json `share_bytes` names
//   live-namespace account-files-bind [show] --state FOLDER [--settings FILE]   bind the origins of the person's files to them
//   live-namespace rows --state FOLDER (--login-fd N | --sqlite FILE)   MCP over stdio: the person's names rows answered to the files
//                        run (src/serve/rows.rs), the one run that holds the database login
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

const USAGE: &str = "usage: live-namespace mcp --state FOLDER [--settings FILE] [--computer JSON] | serve-shares --state FOLDER [--settings FILE] | account-files-bind [show] --state FOLDER [--settings FILE] | rows --state FOLDER (--login-fd N | --sqlite FILE) | import-index --from FOLDER --origin ID --state FOLDER (--login-fd N | --sqlite FILE) [--under FOLDER] [--batch N] [--look]";

enum Command {
    Serve { state: PathBuf, settings: Option<PathBuf>, computer: Value },
    Shares { state: PathBuf, settings: Option<PathBuf> },
    Bind { show: bool, state: PathBuf, settings: Option<PathBuf> },
    Rows { state: PathBuf, kept: serve::rows::Kept },
    Import { from: PathBuf, origin: String, state: PathBuf, kept: serve::rows::Kept, under: Option<String>, batch: usize, look: bool },
}

/// The `--state` and `--settings` flags of a command; with no `--settings`, the settings the program was built with.
fn flags(args: &[String]) -> Result<(PathBuf, Option<PathBuf>), String> {
    let (mut state, mut settings) = (None, None);
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        match (flag.as_str(), rest.next()) {
            ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
            ("--settings", Some(file)) => settings = Some(PathBuf::from(file)),
            _ => return Err(USAGE.into()),
        }
    }
    Ok((state.ok_or(USAGE)?, settings))
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
        "serve-shares" => {
            let (state, settings) = flags(&args[1..])?;
            Ok(Command::Shares { state, settings })
        }
        "account-files-bind" => {
            let show = args.get(1).is_some_and(|word| word == "show");
            let (state, settings) = flags(&args[1 + usize::from(show)..])?;
            Ok(Command::Bind { show, state, settings })
        }
        "rows" => {
            let (mut state, mut kept) = (None, None);
            let mut rest = args[1..].iter();
            while let Some(flag) = rest.next() {
                match (flag.as_str(), rest.next()) {
                    ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
                    ("--login-fd", Some(fd)) => kept = Some(serve::rows::Kept::Postgres { fd: fd.parse().ok().filter(|fd| *fd >= 3).ok_or(USAGE)? }),
                    ("--sqlite", Some(file)) => kept = Some(serve::rows::Kept::Sqlite { file: file.clone() }),
                    _ => return Err(USAGE.into()),
                }
            }
            Ok(Command::Rows { state: state.ok_or(USAGE)?, kept: kept.ok_or(USAGE)? })
        }
        "import-index" => {
            let (mut from, mut origin, mut state, mut kept, mut under, mut batch, mut look) = (None, None, None, None, None, 2000, false);
            let mut rest = args[1..].iter();
            while let Some(flag) = rest.next() {
                if flag == "--look" {
                    look = true;
                    continue;
                }
                match (flag.as_str(), rest.next()) {
                    ("--from", Some(folder)) => from = Some(PathBuf::from(folder)),
                    ("--origin", Some(id)) => origin = Some(id.clone()),
                    ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
                    ("--login-fd", Some(fd)) => kept = Some(serve::rows::Kept::Postgres { fd: fd.parse().ok().filter(|fd| *fd >= 3).ok_or(USAGE)? }),
                    ("--sqlite", Some(file)) => kept = Some(serve::rows::Kept::Sqlite { file: file.clone() }),
                    ("--under", Some(folder)) => under = Some(folder.clone()),
                    ("--batch", Some(count)) => batch = count.parse().ok().filter(|count| (1..=20_000).contains(count)).ok_or(USAGE)?,
                    _ => return Err(USAGE.into()),
                }
            }
            Ok(Command::Import { from: from.ok_or(USAGE)?, origin: origin.ok_or(USAGE)?, state: state.ok_or(USAGE)?, kept: kept.ok_or(USAGE)?, under, batch, look })
        }
        _ => Err(USAGE.into()),
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Bind { show, state, settings } => {
            let settings = Settings::read_or_shipped(settings.as_deref()).map_err(|error| error.to_string())?;
            let store = Namespace::rows(&settings, &state).map_err(|error| error.to_string())?;
            live_namespace::account_files::bind::run(&store, &settings.account, show, &mut io::stdout()).map_err(|error| error.to_string())
        }
        Command::Shares { state, settings } => {
            let settings = Settings::read_or_shipped(settings.as_deref()).map_err(|error| error.to_string())?;
            serve::shares::run(&settings, &state).map_err(|error| error.to_string())
        }
        Command::Serve { state, settings, computer } => {
            let settings = Settings::read_or_shipped(settings.as_deref()).map_err(|error| error.to_string())?;
            let namespace = Arc::new(Namespace::open(&settings, &state, computer).map_err(|error| error.to_string())?);
            serve::mcp::serve(namespace, BufReader::new(io::stdin()), io::stdout())
        }
        Command::Import { from, origin, state, kept, under, batch, look } => {
            // What the export makes is said first; with --look nothing is written.
            let (rows, found) = live_namespace::account_files::import_index::rows_of_export(&from, &origin, under.as_deref())?;
            println!("{}", serde_json::json!({"found": found, "rows": rows.len()}));
            if look {
                return Ok(());
            }
            std::fs::create_dir_all(&state).map_err(|error| error.to_string())?;
            let store = serve::rows::open(&kept, &state, false).map_err(|error| error.to_string())?;
            let (mut added, mut skipped) = (0, 0);
            for (at, group) in rows.chunks(batch).enumerate() {
                let done = store.add_new(group, "import-index:").map_err(|error| format!("batch {at} was not added: {error:?}"))?;
                added += done.added;
                skipped += done.skipped;
                live_namespace::quiet_eprintln!("import-index batch={at} rows={} added={} skipped={}", group.len(), done.added, done.skipped);
            }
            println!("{}", serde_json::json!({"added": added, "skipped": skipped}));
            Ok(())
        }
        Command::Rows { state, kept } => {
            std::fs::create_dir_all(&state).map_err(|error| error.to_string())?;
            serve::rows::run(&kept, &state, BufReader::new(io::stdin()), io::stdout()).map_err(|error| error.to_string())
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
