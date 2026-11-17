// src/main.rs
//
// Purpose: The Namespace tool program: the person's files, served from one state folder.
//
//   live-namespace mcp   --state FOLDER [--settings FILE]   MCP over stdio: each operation of the account files is a tool
//   live-namespace dav   --state FOLDER [--settings FILE]   the WebDAV folder on 127.0.0.1:<settings dav.port>, until stopped
//   live-namespace serve --state FOLDER [--settings FILE]   both (the WebDAV folder runs while the stdio session lasts)
//   live-namespace account-files-bind STORE_FILE ACCOUNT [show | into STATE_FOLDER]   bind a store file to its account files
//
// The store credential is never an argument: the engine attaches the person's `files-store` connection to the run on the file
// descriptors `settings.json` `attached` names (src/serve/mod.rs).
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

const USAGE: &str = "usage: live-namespace (mcp | dav | serve) --state FOLDER [--settings FILE] | account-files-bind STORE_FILE ACCOUNT [show | into STATE_FOLDER]";

/// The settings file next to the tool's own folder when none is named: the one the tool ships.
const SHIPPED_SETTINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json");

enum Command {
    Serve { mcp: bool, dav: bool, state: PathBuf, settings: PathBuf },
    Bind { store: PathBuf, account: String, show: bool, into: Option<PathBuf> },
}

fn parse(args: &[String]) -> Result<Command, String> {
    let command = args.first().map(String::as_str).ok_or(USAGE)?;
    match command {
        "mcp" | "dav" | "serve" => {
            let (mut state, mut settings) = (None, None);
            let mut rest = args[1..].iter();
            while let Some(flag) = rest.next() {
                match (flag.as_str(), rest.next()) {
                    ("--state", Some(folder)) => state = Some(PathBuf::from(folder)),
                    ("--settings", Some(file)) => settings = Some(PathBuf::from(file)),
                    _ => return Err(USAGE.into()),
                }
            }
            Ok(Command::Serve {
                mcp: command != "dav",
                dav: command != "mcp",
                state: state.ok_or(USAGE)?,
                settings: settings.unwrap_or_else(|| PathBuf::from(SHIPPED_SETTINGS)),
            })
        }
        "account-files-bind" => match &args[1..] {
            [store, account] => Ok(Command::Bind { store: store.into(), account: account.clone(), show: false, into: None }),
            [store, account, show] if show == "show" => Ok(Command::Bind { store: store.into(), account: account.clone(), show: true, into: None }),
            [store, account, into, state] if into == "into" => Ok(Command::Bind { store: store.into(), account: account.clone(), show: false, into: Some(state.into()) }),
            _ => Err(USAGE.into()),
        },
        _ => Err(USAGE.into()),
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Bind { store, account, show, into } => {
            let mut out = io::stdout();
            match into {
                Some(state) => live_namespace::account_files::bind::install(&store, &account, &state, &mut out),
                None => live_namespace::account_files::bind::run(&store, &account, show, &mut out),
            }
            .map_err(|error| error.to_string())
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
