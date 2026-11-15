// Purpose: read back the selection an installed app makes at start (Selection::installed_from: its computer-reader.json,
// its carried frontend selection, its service configuration and the descriptor it is named), and its real frontend supply.
// Invariants: the descriptor names the state and address, as at start; no account adoption,
// state lock, token/key read, listener, subprocess, provider or app activation.
// Security: private bounded stdin; fixed phase failures and public asset pins
// only. Selection is not authority or installed-app functionality.
//! Native packaging preflight through the same production selection/asset owner.

use serde::Deserialize;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
use trillion_local::{
    native_boot::{Error, Selection},
    workspace_domain::{OwnerRoutes, StartupContract},
    workspace_session::WorkspaceSessionSettings,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    /// The app's Contents folder (`/Applications/X.app/Contents`).
    contents: PathBuf,
    /// The descriptor the app names on its engine's command line (`native-serve DESCRIPTOR`).
    descriptor: PathBuf,
}

fn inspect() -> Result<(), &'static str> {
    if std::env::args_os().count() != 1 {
        return Err("arguments");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    io::stdin()
        .lock()
        .take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| "input")?;
    if bytes.is_empty() || bytes.len() > 16_384 {
        return Err("input");
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "input")?;
    let selection = Selection::installed_from(&request.contents, &request.descriptor)
    .map_err(|error| match error {
        Error::Invalid(_) => "selection-invalid",
        Error::Changed(_) => "selection-changed",
        Error::Unavailable(_) => "selection-unavailable",
    })?;
    // The startup steps before the account opens, in the engine's order (src/native_entry.rs run_selected), so a
    // preflight stops where the app would and names the same stage.
    let (assets, _) = selection.frontend.open(None).map_err(|_| "frontend-data")?;
    let first_source = selection.frontend.required(trillion_local::native_boot::FIRST_ANSWERS).map_err(|_| "frontend-data")?;
    let first_answers = first_source.read().map_err(|_| "frontend-data")?;
    let first_pin = &first_source.pin.blake3;
    WorkspaceSessionSettings::from_source(&first_answers, first_pin).map_err(|_| "frontend-data")?;
    OwnerRoutes::from_product().map_err(|_| "workspace-composition")?;
    let inputs_source = selection.frontend.required(trillion_local::native_boot::INPUTS).map_err(|_| "workspace-composition")?;
    let inputs = inputs_source.read().map_err(|_| "workspace-composition")?;
    StartupContract::from_sources(&first_answers, first_pin, &inputs, &inputs_source.pin.blake3)
        .map_err(|_| "workspace-composition")?;
    let shell = selection
        .frontend
        .open_shell()
        .map_err(|_| "shell-capture")?;
    selection
        .assert_current()
        .map_err(|_| "selection-changed")?;
    let output = serde_json::json!({"selected":true,"frontend_assets":true,"captured_shell":shell.is_some(),"account_adopted":false,"cloud_execution":false,"manifest_identity":assets.manifest_identity(),"tree_identity":assets.tree_identity(),"carried_files":selection.frontend.files.len(),"source_commit":selection.frontend.source.commit});
    let mut bytes = serde_json::to_vec(&output).map_err(|_| "output")?;
    bytes.push(b'\n');
    io::stdout().lock().write_all(&bytes).map_err(|_| "output")
}
fn main() {
    if let Err(phase) = inspect() {
        let _ = writeln!(
            io::stderr().lock(),
            "native selection inspection refused [{phase}]"
        );
        std::process::exit(1);
    }
}
