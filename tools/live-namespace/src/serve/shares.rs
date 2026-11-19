// src/serve/shares.rs
//
// Purpose: One run of `serve-shares`: the public byte route of a share (`share_bytes`) over this run's person: the shares are read from the person's
// own rows (`@namespace/file-shares`), the bytes by range through the account files, each read counted for the
// account. The route opens one loopback port or one unix socket (`share_bytes.listen`); a front door carries the public to it. When the
// settings name the https address the public reaches it at (`share.origin`), the route writes that address into the person's rows
// (`@namespace/share-route`) as it starts, so a files run on any other computer makes share links that open here.
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
    account_files::{account_routes::AccountFilesDoor, CallControl, FILES, SHARE_ROUTE, SHARE_ROUTE_ID, SHARE_ROUTE_KIND},
    store::Mutation,
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
    if let Some(share) = &settings.share {
        announce(&store, &share.origin)?;
    }
    let grants = RowGrants::new(store.clone());
    let reader = FilesReader { door, state, store, account: settings.account.clone(), call_limit: Duration::from_secs(settings.call_seconds) };
    let listen = config.listen.clone();
    let socket = config.socket_path().map(Path::to_path_buf);
    let route = Route { grants: Arc::new(grants), reader: Arc::new(reader), config };
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async move {
        let router = live_namespace::share_bytes::router(route);
        match socket {
            Some(path) => {
                // A socket a run before this one left is not a listener any more: it is removed before this run binds its own.
                if std::fs::symlink_metadata(&path).is_ok_and(|kept| std::os::unix::fs::FileTypeExt::is_socket(&kept.file_type())) {
                    std::fs::remove_file(&path)?;
                }
                let listener = tokio::net::UnixListener::bind(&path)?;
                // The front door (another user, in this socket's group) connects to it; no one else may.
                std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o660))?;
                live_namespace::quiet_eprintln!("live-namespace: the share byte route listens on {listen}");
                axum::serve(listener, router).await?;
            }
            None => {
                let listener = tokio::net::TcpListener::bind(&listen).await?;
                live_namespace::quiet_eprintln!("live-namespace: the share byte route listens on {listen}");
                axum::serve(listener, router).await?;
            }
        }
        Ok::<(), Refusal>(())
    })
}

/// Write `origin` as where the person's share route answers, unless the person's rows say so already.
fn announce(store: &Store, origin: &str) -> Result<(), Refusal> {
    let origin = origin.trim_end_matches('/');
    let (version, held) = store.held_record_with_version(SHARE_ROUTE, SHARE_ROUTE_ID).map_err(|_| "the person's rows did not answer where the share route is")?;
    if held.as_ref().and_then(|row| row.value.get("origin")).and_then(serde_json::Value::as_str) == Some(origin) {
        return Ok(());
    }
    let value = serde_json::json!({"kind": SHARE_ROUTE_KIND, "origin": origin});
    let key = format!("share-route:{}", content_crypto::advanced::blake3::hash(format!("{version}:{origin}").as_bytes()).to_hex());
    store
        .mutate(SHARE_ROUTE, Mutation { id: SHARE_ROUTE_ID.to_owned(), expected_version: version, request_key: key, deleted: false, value })
        .map_err(|_| "the share route's address could not be written to the person's rows")?;
    live_namespace::quiet_eprintln!("live-namespace: the share route's address is written to the person's rows");
    Ok(())
}
