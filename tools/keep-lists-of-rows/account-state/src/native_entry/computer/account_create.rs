// src/native_entry/computer/account_create.rs
//
// Purpose: a sign-in program on this same machine (trillion-workshop tools/better-auth-official, its user-create hook) makes
// the account of a person it has just signed up with `POST /accounts/create`, body `{}`, answered `{"address"}`. The account
// is made by `account::create::create_named`, opened, given its first computers row and served the way a skipped account
// is started (`Computer::start_skipped`), with no passkey, password or session here: the person signs in through that
// program, which keeps the address in the person's `trillionAccount`.
//
// Security Considerations:
// - Only a request this listener took straight from a loopback peer with no proxy header (`PROXIED`) is answered; any other
//   (another machine, a reverse proxy on this one, the forwarder's session, which carries no peer) gets the 404 of an
//   unknown path, so the route is not shown off this machine.
// - The computer's own limits refuse it as they refuse any new account: `takes_new_accounts` false answers 403
//   `sign_up_closed`, a computer at its account limit answers 429 `sign_up_limited`.
// - A failure after the folder was made removes the folder, so no half-made account is served or counted.

use super::{compose_account, mark_if_listening, open_folder, Computer, ComputerAccount};
use crate::account::computers::{self, Candidate};
use crate::account::rows::store::Store;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

/// The headers a reverse proxy adds to a request it carries (Caddy's reverse_proxy sets X-Forwarded-For on every request; the
/// relay's front door also sets CF-Connecting-IP). A request with one came from elsewhere through a proxy on this machine.
const PROXIED: [&str; 3] = ["x-forwarded-for", "forwarded", "cf-connecting-ip"];

/// The most bytes of a create request's body: it is `{}`.
const MOST_BODY_BYTES: usize = 64;

/// Why a create was refused.
#[derive(Debug, Clone)]
pub(crate) enum Refused {
    /// This computer takes no new accounts (`report.takes_new_accounts`).
    Closed(crate::refusal_cause::Cause),
    /// This computer holds as many accounts as its limit lets it.
    Limited(crate::refusal_cause::Cause),
    /// The body is not `{}`.
    Input(crate::refusal_cause::Cause),
    /// The account could not be made, opened or landed.
    Unavailable(crate::refusal_cause::Cause),
}

impl Refused {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Closed(cause) | Self::Limited(cause) | Self::Input(cause) | Self::Unavailable(cause) => cause.clone(),
        }
    }

    fn answer(&self) -> Response {
        let (status, code) = match self {
            Self::Closed(_) => (StatusCode::FORBIDDEN, "sign_up_closed"),
            Self::Limited(_) => (StatusCode::TOO_MANY_REQUESTS, "sign_up_limited"),
            Self::Input(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        };
        crate::quiet_eprintln!("account-create outcome=refused code={code} cause={}", self.cause());
        crate::forwarder::answers::json(status, &json!({"error": code}), &[("cache-control", "no-store")])
    }
}
crate::impl_caused!(Refused);

/// `POST /accounts/create` (see the top of this file). Body `{}`; answers `{"address"}`.
pub(crate) async fn create_for_sign_in(State(computer): State<Arc<Computer>>, request: Request) -> Response {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip());
    if !peer.is_some_and(|ip| ip.is_loopback()) || PROXIED.iter().any(|name| request.headers().contains_key(*name)) {
        return crate::forwarder::answers::json(StatusCode::NOT_FOUND, &json!({"error": "not_found"}), &[("cache-control", "no-store")]);
    }
    let Ok(body) = axum::body::to_bytes(request.into_body(), MOST_BODY_BYTES).await else {
        return crate::cause!(Refused::Input).answer();
    };
    if !matches!(serde_json::from_slice::<Value>(&body), Ok(Value::Object(fields)) if fields.is_empty()) {
        return crate::cause!(Refused::Input).answer();
    }
    let made = tokio::task::spawn_blocking(move || computer.create_for_sign_in()).await;
    match made {
        Ok(Ok(address)) => crate::forwarder::answers::json(StatusCode::OK, &json!({"address": address}), &[("cache-control", "no-store")]),
        Ok(Err(refused)) => refused.answer(),
        Err(error) => crate::carry_cause!(Refused::Unavailable, error).answer(),
    }
}

impl Computer {
    /// Make, open, land and serve one new account for a sign-in program on this machine; answers its address. Any failure
    /// after the folder was made removes the folder.
    pub(crate) fn create_for_sign_in(self: &Arc<Self>) -> Result<String, Refused> {
        if !self.config.report.takes_new_accounts {
            return Err(crate::cause!(Refused::Closed));
        }
        if !self.config.takes_one_more(self.accounts().len()) {
            return Err(crate::cause!(Refused::Limited));
        }
        let starting = self.config.new_accounts.as_ref().ok_or(crate::cause!(Refused::Unavailable))?;
        let made = crate::account::create::create_named(&self.config.accounts, &self.computer_key, starting)
            .map_err(|error| Refused::Unavailable(error.cause()))?;
        let folder = self.config.accounts.join(&made.owner_id);
        match self.serve_made(&folder) {
            Ok(account) => Ok(self.adopt(account, &folder)),
            Err(refused) => {
                let _ = std::fs::remove_dir_all(&folder);
                Err(refused)
            }
        }
    }

    /// Open a just-made account, write its first computers row (the computers this computer's config gives every new
    /// account, `default_computers`, or, with none, this computer alone) and compose its door.
    fn serve_made(&self, folder: &Path) -> Result<Arc<ComputerAccount>, Refused> {
        let starting = self.config.starting_rows().map_err(|error| Refused::Unavailable(error.cause()))?;
        let local = open_folder(folder, starting).map_err(|error| Refused::Unavailable(error.cause()))?;
        let account = Arc::new(compose_account(&self.config, folder, local).map_err(|error| Refused::Unavailable(error.cause()))?);
        let sign_in = account.sign_in();
        let key = sign_in.account_key().ok_or(crate::cause!(Refused::Unavailable))?.clone();
        let store = Store::new(&**sign_in.storage());
        let landed = match &self.config.default_computers {
            Some(defaults) => computers::land_new_account_in(&store, sign_in.account(), defaults, &key),
            None => {
                let computer = self.computer_id();
                let candidates = [Candidate { computer: &computer, report: &self.config.report, live: true }];
                computers::land_new_account(&store, sign_in.account(), &candidates, &key)
            }
        };
        landed.map_err(|error| Refused::Unavailable(error.cause()))?;
        drop(store);
        Ok(account)
    }

    /// Serve a landed account as `start_skipped` serves one: held, its copies started, its tools installed, and told to the
    /// forwarder on the computer's session (or a session of its own past `max_told_rows`).
    fn adopt(self: &Arc<Self>, account: Arc<ComputerAccount>, folder: &Path) -> String {
        let address = account.address().to_owned();
        self.accounts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(account.clone());
        mark_if_listening(folder);
        self.start_copies(&account);
        self.copy_outside_changes(&account);
        if let Some(stop) = self.forwarder_stop.get() {
            self.install_tools(&account, *stop, false);
            if self.accounts().len() > computers::settings().max_told_rows {
                self.keep_session(&address, *stop);
            } else {
                self.tell_again(&address);
            }
        }
        crate::quiet_eprintln!("account-create outcome=made account={address}");
        address
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn computer(dir: &Path, takes_new_accounts: bool) -> Arc<Computer> {
        let (mut config, _) = super::super::join::tests::computer(dir, 9);
        config.report.takes_new_accounts = takes_new_accounts;
        Arc::new(Computer::start(config).unwrap_or_else(|error| panic!("{error}")))
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    /// `POST /accounts/create` from `peer` (None: no peer, as the forwarder's session hands requests in process), with
    /// `header` set when given: its status and body.
    fn create_from(computer: &Arc<Computer>, peer: Option<&str>, header: Option<(&str, &str)>) -> (StatusCode, Value) {
        use tower::ServiceExt as _;
        let mut request = axum::http::Request::builder().method("POST").uri("/accounts/create");
        if let Some((name, value)) = header {
            request = request.header(name, value);
        }
        let mut request = request.body(axum::body::Body::from("{}")).unwrap();
        if let Some(peer) = peer {
            request.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        }
        block_on(async {
            let response = computer.app().oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        })
    }

    fn folders(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("accounts")).map(|entries| entries.count()).unwrap_or(0)
    }

    #[test]
    fn a_loopback_sign_in_program_makes_an_account_that_this_computer_then_holds() {
        if !super::super::own_process("native_entry::computer::account_create::tests::a_loopback_sign_in_program_makes_an_account_that_this_computer_then_holds") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap();
        let computer = computer(&folder, true);
        let before = computer.accounts().len();
        let (status, body) = create_from(&computer, Some("127.0.0.1:50123"), None);
        assert_eq!(status, StatusCode::OK, "{body}");
        let address = body["address"].as_str().expect("the new account's address").to_owned();
        assert_eq!(computer.accounts().len(), before + 1);
        assert!(computer.accounts().iter().any(|account| account.address() == address), "this computer holds the new account");
        let (status, body) = create_from(&computer, Some("[::1]:50124"), None);
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_ne!(body["address"].as_str(), Some(address.as_str()), "each call makes its own account");
        assert_eq!(computer.accounts().len(), before + 2);
    }

    #[test]
    fn a_request_from_another_machine_or_through_a_proxy_is_not_found_and_makes_nothing() {
        if !super::super::own_process("native_entry::computer::account_create::tests::a_request_from_another_machine_or_through_a_proxy_is_not_found_and_makes_nothing") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap();
        let computer = computer(&folder, true);
        let (before, made) = (computer.accounts().len(), folders(&folder));
        assert_eq!(create_from(&computer, Some("192.0.2.7:443"), None).0, StatusCode::NOT_FOUND);
        assert_eq!(create_from(&computer, Some("127.0.0.1:50125"), Some(("x-forwarded-for", "192.0.2.7"))).0, StatusCode::NOT_FOUND);
        assert_eq!(create_from(&computer, Some("127.0.0.1:50126"), Some(("cf-connecting-ip", "192.0.2.7"))).0, StatusCode::NOT_FOUND);
        assert_eq!(create_from(&computer, None, None).0, StatusCode::NOT_FOUND);
        assert_eq!(computer.accounts().len(), before, "nothing was served");
        assert_eq!(folders(&folder), made, "no folder was made");
    }

    #[test]
    fn a_computer_that_takes_no_new_accounts_refuses_a_loopback_create_and_makes_nothing() {
        if !super::super::own_process("native_entry::computer::account_create::tests::a_computer_that_takes_no_new_accounts_refuses_a_loopback_create_and_makes_nothing") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap();
        let computer = computer(&folder, false);
        let (before, made) = (computer.accounts().len(), folders(&folder));
        let (status, body) = create_from(&computer, Some("127.0.0.1:50127"), None);
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "sign_up_closed");
        assert_eq!(computer.accounts().len(), before);
        assert_eq!(folders(&folder), made, "no folder was made");
    }
}
