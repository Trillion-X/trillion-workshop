// src/main.rs
//
// Purpose: The Namespace tool program: the person's files, served from one state folder.
//
//   live-namespace mcp   --state FOLDER [--settings FILE]   MCP over stdio: each operation of the account files is a tool
//   live-namespace dav   --state FOLDER [--settings FILE]   the WebDAV folder on 127.0.0.1:<settings dav.port>, until stopped
//   live-namespace serve --state FOLDER [--settings FILE]   both (the WebDAV folder runs while the stdio session lasts)
//   live-namespace account-files-bind [show] --state FOLDER [--settings FILE]   bind the origins of the person's files to them
//
// A credential is never an argument: the engine attaches the person's `files-store` connection (and the database's own) to the run on
// the file descriptors `settings.json` `attached` names (src/serve/mod.rs).
//
// Non-Negotiable Invariants:
// - A refusal names what was wrong with the run, never a value of the connection.
// - `mcp` ends when its input ends, and `dav` ends only when the process is stopped.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod serve;

use serve::{settings::Settings, Namespace};
use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
};

const USAGE: &str = "usage: live-namespace (mcp | dav | serve) --state FOLDER [--settings FILE] | account-files-bind [show] --state FOLDER [--settings FILE]";

/// The settings file next to the tool's own folder when none is named: the one the tool ships.
const SHIPPED_SETTINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json");

enum Command {
    Serve { mcp: bool, dav: bool, state: PathBuf, settings: PathBuf },
    Bind { show: bool, state: PathBuf, settings: PathBuf },
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
        "mcp" | "dav" | "serve" => {
            let (state, settings) = flags(&args[1..])?;
            Ok(Command::Serve { mcp: command != "dav", dav: command != "mcp", state, settings })
        }
        "account-files-bind" => {
            let show = args.get(1).is_some_and(|word| word == "show");
            let (state, settings) = flags(&args[1 + usize::from(show)..])?;
            Ok(Command::Bind { show, state, settings })
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
        Command::Serve { mcp, dav, state, settings } => {
            let settings = Settings::read(&settings).map_err(|error| error.to_string())?;
            let namespace = Arc::new(Namespace::open(&settings, &state).map_err(|error| error.to_string())?);
            let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| error.to_string())?;
            let listener = dav.then(|| {
                let namespace = namespace.clone();
                let port = settings.dav.clone();
                runtime.spawn(async move { serve::dav::serve(namespace, &port).await })
            });
            if mcp {
                serve::mcp::serve(namespace, BufReader::new(io::stdin()), io::stdout().lock())?;
                return Ok(());
            }
            let listener = listener.ok_or(USAGE)?;
            runtime.block_on(listener).map_err(|error| error.to_string())?
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
