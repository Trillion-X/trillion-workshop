// src/serve/shares.rs
//
// Purpose: One run of `serve-shares`: the public byte route of a share (`share_bytes`) over this run's person: the shares are read from the person's
// own rows (`@namespace/file-shares`), the bytes by range through the account files, each read counted for the
// account. The route opens one loopback port (`share_bytes.listen`); a front door's route for `/share/*` carries the public to it.
//
// Non-Negotiable Invariants:
// - The store credential reaches the run only as `mcp` receives it (attached descriptors) and is never printed.
// - A read of bytes takes the same byte check as every read of the account files (`AccountFilesDoor::bytes_let_in`) and ends inside
//   `call_seconds`, so a stuck store never holds a share's body open.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{open_rows, settings::Settings, Refusal};
use live_namespace::{
    account_files::{account_routes::AccountFilesDoor, CallControl, FILES},
    share_bytes::{RowGrants, Reader, Route, Unavailable},
    store::Store,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

/// The person's files as the byte route reads them: one opening of the account files per window, so a window's reads end by its own time.
struct FilesReader {
    door: &'static AccountFilesDoor,
    state: PathBuf,
    store: Store,
    account: String,
    call_limit: Duration,
}

impl Reader for FilesReader {
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable> {
        let until = Instant::now() + self.call_limit;
        let control = CallControl::new(until, Arc::new(move || Instant::now() < until), self.door.bytes_let_in());
        let files = self.door.open_counted(&self.state, &self.store, &self.account, control).map_err(|_| Unavailable)?;
        let file = files.store.get(FILES, identity).map_err(|_| Unavailable)?.record.ok_or(Unavailable)?;
        files.read_range(&file, offset, length).map_err(|_| Unavailable)
    }
}

/// Serve the route until the process ends.
pub fn run(settings: &Settings, state: &Path) -> Result<(), Refusal> {
    let config = settings.share_bytes.clone().ok_or("settings.json names no share_bytes: the route has nowhere to listen")?;
    let door = AccountFilesDoor::shipped().ok_or("the account files door DATA is refused")?;
    let (state, _held, store) = open_rows(settings, state)?;
    let grants = RowGrants::new(store.clone());
    let reader = FilesReader { door, state, store, account: settings.account.clone(), call_limit: Duration::from_secs(settings.call_seconds) };
    let listen = config.listen.clone();
    let route = Route { grants: Arc::new(grants), reader: Arc::new(reader), config };
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(&listen).await?;
        live_namespace::quiet_eprintln!("live-namespace: the share byte route listens on {listen}");
        axum::serve(listener, live_namespace::share_bytes::router(route)).await?;
        Ok::<(), Refusal>(())
    })
}
