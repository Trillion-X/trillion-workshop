//! Origins: the signed row, which hosts a row may name, and the forwarder carrying a request for another origin to
//! the installation that host shows, at the live computer of the account that signed it.
use super::*;
use crate::account::computers::{KeptAccount, ComputersRow};
use crate::mcp::{http::BearerAuthenticator, Principal};
use crate::forwarder::{
    gateway::Gateway,
    session::{self, ConnectionAdmission, ConnectionGrant},
    ClientProofIssuer,
};
use crate::resource_authority::{decode_message, InvokeMessage, Route};
use std::{
    os::unix::net::UnixStream,
    sync::{Arc, Mutex as StdMutex},
    thread,
    time::Duration,
};

const INSTALL_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INSTALL_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMPUTER: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn key(secret: &str) -> AccountKey {
    AccountKey::from_secret_text(&secret.repeat(32)).unwrap()
}

fn origin(host: &str, installation: &str) -> Origin {
    Origin { host: host.into(), installation: installation.into(), moved_to: None }
}

fn moved(host: &str, installation: &str, to: &str) -> Origin {
    Origin { host: host.into(), installation: installation.into(), moved_to: Some(to.into()) }
}

/// A fixed clock for the book's own tests (ms).
const T0: i64 = 1_000_000_000;

fn found(address: String, installation: &str) -> Lookup {
    Lookup::Found { address, installation: installation.into(), moved_to: None }
}

/// A resolver with made-up TXT answers, the test resolver the proof runs against.
struct TestResolver(Vec<(String, String)>);
impl OriginProof for TestResolver {
    fn txt(&self, name: &str) -> Vec<String> {
        self.0.iter().filter(|(at, _)| at == name).map(|(_, value)| value.clone()).collect()
    }
}

fn everyone_live(_: &str) -> bool {
    true
}

#[test]
fn a_row_is_believed_only_for_the_address_its_own_key_names() {
    let owner = key("07");
    let row = OriginsRow::sign(1, &[origin("Shop.Trillion.Run.", INSTALL_A)], &owner).unwrap();
    assert_eq!(row.origins[0].host, "shop.trillion.run", "a host is kept in its one form");
    assert!(row.believed(&owner.address()));
    assert!(!row.believed(&key("08").address()), "not for another address");

    let mut changed = row.clone();
    changed.origins[0].installation = INSTALL_B.into();
    assert!(!changed.believed(&owner.address()), "a changed installation breaks the signature");

    // An impostor signs a row for the owner's address with its own key: the key does not name the address.
    let impostor = key("09");
    let mut forged = OriginsRow::sign(1, &[origin("shop.trillion.run", INSTALL_A)], &impostor).unwrap();
    forged.account = owner.address();
    assert!(!forged.believed(&owner.address()));
    forged.account_key = owner.public_hex();
    assert!(!forged.believed(&owner.address()), "the owner's key did not sign it");
}

#[test]
fn a_row_in_another_shape_is_refused_before_it_is_signed() {
    let owner = key("07");
    for bad in [origin("shop.trillion.run", "not-an-installation"), origin("localhost", INSTALL_A), origin("1.2.3.4", INSTALL_A),
        origin("-shop.trillion.run", INSTALL_A), origin("shop.trillion.run:x", INSTALL_A)] {
        assert!(OriginsRow::sign(1, &[bad.clone()], &owner).is_err(), "{bad:?}");
    }
    let twice = [origin("shop.trillion.run", INSTALL_A), origin("SHOP.trillion.run", INSTALL_B)];
    assert!(OriginsRow::sign(1, &twice, &owner).is_err(), "one host once");
    assert!(OriginsRow::sign(0, &[], &owner).is_err(), "revisions start at 1");
}

#[test]
fn a_host_is_read_in_one_form_from_a_request() {
    assert_eq!(host_of("Shop.Trillion.Run:443").as_deref(), Some("shop.trillion.run"));
    assert_eq!(host_of("example.com.").as_deref(), Some("example.com"));
    assert_eq!(host_of("[::1]:443"), None);
    assert_eq!(host_of("127.0.0.1:8080"), None);
    assert_eq!(host_of("user@example.com"), None);
}

#[test]
fn a_name_is_held_by_the_first_account_while_it_is_live_and_for_the_hold_after() {
    let book = OriginBook::new();
    let (first, second) = (key("07"), key("08"));
    let name = [origin("shop.trillion.run", INSTALL_A)];
    book.take(&first.address(), OriginsRow::sign(1, &name, &first).unwrap(), T0, &everyone_live, None).unwrap();
    assert_eq!(book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), T0, &everyone_live, None),
        Err(Refusal::Taken("shop.trillion.run".into(), crate::cause!())));
    assert_eq!(book.find("shop.trillion.run", &everyone_live), found(first.address(), INSTALL_A));

    // The first account has no live computer: its host answers nobody, but the name stays held for `name_hold_ms`.
    let first_address = first.address();
    let only_second = |address: &str| address != first_address;
    let hold = settings().name_hold_ms;
    assert_eq!(book.find("shop.trillion.run", &only_second), Lookup::Unknown);
    assert_eq!(book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), T0 + hold, &only_second, None),
        Err(Refusal::Taken("shop.trillion.run".into(), crate::cause!())), "held for the whole hold");
    // Once the hold ran out the row is let go, and the second account may name the host.
    book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), T0 + hold + 1, &only_second, None).unwrap();
    assert_eq!(book.find("SHOP.trillion.run:443", &everyone_live), found(second.address(), INSTALL_A));
}

#[test]
fn a_hold_counts_from_when_a_computer_of_the_account_was_last_seen_live() {
    let book = OriginBook::new();
    let (first, second, third) = (key("07"), key("08"), key("09"));
    let first_address = first.address();
    let hold = settings().name_hold_ms;
    book.take(&first.address(), OriginsRow::sign(1, &[origin("shop.trillion.run", INSTALL_A)], &first).unwrap(), T0, &everyone_live, None).unwrap();
    // Another account's take while the first is still live renews the first's hold from that time.
    book.take(&third.address(), OriginsRow::sign(1, &[origin("else.trillion.run", INSTALL_A)], &third).unwrap(), T0 + hold, &everyone_live, None).unwrap();
    let without_first = |address: &str| address != first_address;
    let name = [origin("shop.trillion.run", INSTALL_B)];
    assert_eq!(book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), T0 + 2 * hold, &without_first, None),
        Err(Refusal::Taken("shop.trillion.run".into(), crate::cause!())), "seen live at T0 + hold, so held until T0 + 2 holds");
    book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), T0 + 2 * hold + 1, &without_first, None).unwrap();
}

#[test]
fn an_older_row_does_not_replace_a_newer_one_and_a_refused_row_leaves_the_last_one_standing() {
    let book = OriginBook::new();
    let owner = key("07");
    let address = owner.address();
    book.take(&address, OriginsRow::sign(2, &[origin("shop.trillion.run", INSTALL_B)], &owner).unwrap(), T0, &everyone_live, None).unwrap();
    assert_eq!(book.take(&address, OriginsRow::sign(1, &[origin("shop.trillion.run", INSTALL_A)], &owner).unwrap(), T0, &everyone_live, None),
        Err(crate::cause!(Refusal::Stale)));
    let unproven = [origin("shop.trillion.run", INSTALL_A), origin("shop.example", INSTALL_A)];
    assert_eq!(book.take(&address, OriginsRow::sign(3, &unproven, &owner).unwrap(), T0, &everyone_live, None),
        Err(Refusal::Unproven("shop.example".into(), crate::cause!())));
    assert_eq!(book.find("shop.trillion.run", &everyone_live), found(address, INSTALL_B));
}

#[test]
fn a_persons_own_domain_needs_its_txt_proof_naming_this_account() {
    let book = OriginBook::new();
    let (owner, other) = (key("07"), key("08"));
    let domain = [origin("www.shop.example", INSTALL_A)];
    let row = OriginsRow::sign(1, &domain, &owner).unwrap();
    assert_eq!(book.take(&owner.address(), row.clone(), T0, &everyone_live, None), Err(Refusal::Unproven("www.shop.example".into(), crate::cause!())),
        "no resolver supplied: no domain is believed");
    let for_other = TestResolver(vec![("_trillion-verify.www.shop.example".into(), format!("trillion-account={}", other.address()))]);
    assert_eq!(book.take(&owner.address(), row.clone(), T0, &everyone_live, Some(&for_other)), Err(Refusal::Unproven("www.shop.example".into(), crate::cause!())),
        "a proof naming another account");
    let proven = TestResolver(vec![("_trillion-verify.www.shop.example".into(), format!("trillion-account={}", owner.address()))]);
    book.take(&owner.address(), row, T0, &everyone_live, Some(&proven)).unwrap();
    assert_eq!(book.find("www.shop.example", &everyone_live),
        found(owner.address(), INSTALL_A));

    // A second name under the suffix (two labels) is not a name: it needs a proof as a domain does.
    let deeper = OriginsRow::sign(1, &[origin("a.b.trillion.run", INSTALL_A)], &other).unwrap();
    assert_eq!(book.take(&other.address(), deeper, T0, &everyone_live, None), Err(Refusal::Unproven("a.b.trillion.run".into(), crate::cause!())));
}

#[test]
fn a_gone_accounts_row_is_let_go_once_its_hold_ran_out_so_two_rows_never_name_one_host() {
    let book = OriginBook::new();
    let (first, second) = (key("07"), key("08"));
    let name = [origin("shop.trillion.run", INSTALL_A)];
    let first_address = first.address();
    let later = T0 + settings().name_hold_ms + 1;
    book.take(&first.address(), OriginsRow::sign(1, &name, &first).unwrap(), T0, &everyone_live, None).unwrap();
    // After the first account had no live computer for the whole hold, the second takes the name; the first comes back.
    let without_first = |address: &str| address != first_address;
    book.take(&second.address(), OriginsRow::sign(1, &name, &second).unwrap(), later, &without_first, None).unwrap();
    assert_eq!(book.find("shop.trillion.run", &everyone_live), found(second.address(), INSTALL_A),
        "the gone account's row was let go, so it does not contest the host when it comes back");
    assert_eq!(book.take(&first.address(), OriginsRow::sign(2, &name, &first).unwrap(), later, &everyone_live, None),
        Err(Refusal::Taken("shop.trillion.run".into(), crate::cause!())), "it must hand in a row naming another host");
}

#[test]
fn a_proven_domain_goes_from_a_held_row_to_the_account_its_owner_proves_now() {
    let book = OriginBook::new();
    let (first, second) = (key("07"), key("08"));
    let first_address = first.address();
    let for_first = TestResolver(vec![("_trillion-verify.www.shop.example".into(), format!("trillion-account={first_address}"))]);
    let row = [origin("www.shop.example", INSTALL_A), origin("shop.trillion.run", INSTALL_A)];
    book.take(&first.address(), OriginsRow::sign(1, &row, &first).unwrap(), T0, &everyone_live, Some(&for_first)).unwrap();
    let for_second = TestResolver(vec![("_trillion-verify.www.shop.example".into(), format!("trillion-account={}", second.address()))]);
    let domain = [origin("www.shop.example", INSTALL_B)];
    assert_eq!(book.take(&second.address(), OriginsRow::sign(1, &domain, &second).unwrap(), T0, &everyone_live, Some(&for_second)),
        Err(Refusal::Taken("www.shop.example".into(), crate::cause!())), "a live holder keeps it");
    // The first account goes offline; the domain's owner now names the second account: it takes the domain at once.
    let without_first = |address: &str| address != first_address;
    book.take(&second.address(), OriginsRow::sign(1, &domain, &second).unwrap(), T0 + 1, &without_first, Some(&for_second)).unwrap();
    assert_eq!(book.find("www.shop.example", &everyone_live), found(second.address(), INSTALL_B),
        "the first comes back: the domain it held is released, never contested");
    // Its name is still held for it.
    let squatter = [origin("shop.trillion.run", INSTALL_B)];
    assert_eq!(book.take(&second.address(), OriginsRow::sign(2, &squatter, &second).unwrap(), T0 + 2, &without_first, None),
        Err(Refusal::Taken("shop.trillion.run".into(), crate::cause!())));
}

#[test]
fn a_reserved_name_a_view_shaped_name_or_a_code_shaped_name_is_held_by_nobody() {
    let book = OriginBook::new();
    let owner = key("07");
    for host in ["www.trillion.run", "app.trillion.run", "abc--shop.trillion.run", "0123456789abcdef0123.trillion.run"] {
        assert_eq!(book.take(&owner.address(), OriginsRow::sign(1, &[origin(host, INSTALL_A)], &owner).unwrap(), T0, &everyone_live, None),
            Err(Refusal::Reserved(host.into(), crate::cause!())), "{host}");
    }
    book.take(&owner.address(), OriginsRow::sign(1, &[origin("www-shop.trillion.run", INSTALL_A)], &owner).unwrap(), T0, &everyone_live, None).unwrap();
}

#[test]
fn a_renamed_host_names_another_host_of_the_same_row() {
    let owner = key("07");
    let row = OriginsRow::sign(1, &[moved("old.trillion.run", INSTALL_A, "New.Trillion.Run"), origin("new.trillion.run", INSTALL_A)], &owner).unwrap();
    assert_eq!(row.origins[1].moved_to.as_deref(), Some("new.trillion.run"), "kept in its one form");
    assert!(row.believed(&owner.address()));
    let mut changed = row.clone();
    changed.origins[1].moved_to = None;
    assert!(!changed.believed(&owner.address()), "moved_to is signed");
    for bad in [vec![moved("old.trillion.run", INSTALL_A, "new.trillion.run")],
        vec![moved("old.trillion.run", INSTALL_A, "old.trillion.run")],
        vec![moved("a.trillion.run", INSTALL_A, "b.trillion.run"), moved("b.trillion.run", INSTALL_A, "a.trillion.run")]] {
        assert!(OriginsRow::sign(1, &bad, &owner).is_err(), "{bad:?}: a host not in the row, itself, or a chain");
    }
    let book = OriginBook::new();
    book.take(&owner.address(), row, T0, &everyone_live, None).unwrap();
    assert_eq!(book.find("old.trillion.run", &everyone_live),
        Lookup::Found { address: owner.address(), installation: INSTALL_A.into(), moved_to: Some("new.trillion.run".into()) });
}

#[test]
fn the_computer_path_is_under_the_accounts_own_address() {
    assert_eq!(computer_target("ab", INSTALL_A, "/about?x=1"), format!("/a/ab/installations/{INSTALL_A}/about?x=1"));
    assert_eq!(computer_target("ab", INSTALL_A, "/"), format!("/a/ab/installations/{INSTALL_A}/"));
}

// -------------------------------------------------------------------------------------------------------------------
// The forwarder: a request for another origin reaches the account's live computer at the installation's path.

struct NoBearer;
impl BearerAuthenticator for NoBearer {
    fn authenticate(&self, _: &[u8]) -> Option<Principal> {
        None
    }
}
struct NoProof;
impl ClientProofIssuer for NoProof {
    fn issue(&self, _: &Principal, _: &InvokeMessage) -> Option<String> {
        None
    }
}
struct Admission(Route);
impl ConnectionAdmission for Admission {
    fn admit(&self, credential: &[u8], at: i64) -> Option<ConnectionGrant> {
        (credential == b"synthetic-computer").then(|| ConnectionGrant {
            route: self.0.clone(),
            expires_at_ms: at + 120_000,
            admission_identity: Some("synthetic-registration".into()),
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, at: i64) -> bool {
        at < grant.expires_at_ms && grant.route == self.0
    }
}

/// A forwarder for `forwarder.example.test` with one live computer of `owner` that answers every `computers:http`
/// message with the target it was asked for, and the targets it saw.
fn forwarder(owner: &AccountKey, root: bool) -> (Arc<Gateway>, Arc<StdMutex<Vec<String>>>, thread::JoinHandle<std::io::Result<()>>) {
    let route = Route { account_id: owner.address(), device_id: COMPUTER.into(), resource_address: "@own-records".into(),
        generation: "generation-one".into() };
    let proven = TestResolver(vec![("_trillion-verify.www.shop.example".into(), format!("trillion-account={}", owner.address()))]);
    let gateway = Gateway::new("forwarder.example.test", Arc::new(NoBearer), Arc::new(NoProof),
        Arc::new(Admission(route.clone())), std::sync::Arc::new(crate::storage::time_source::RealClock)).with_origin_proof(Arc::new(proven));
    let gateway = Arc::new(if root { gateway.with_root_account(&owner.address()).unwrap() } else { gateway });
    let row = ComputersRow::sign(&owner.address(), 1, &[COMPUTER.into()], &[COMPUTER.into()], owner).unwrap();
    let told = vec![KeptAccount { row, account_key: owner.public_hex() }];
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let (public, computer) = UnixStream::pair().unwrap();
    for stream in [&public, &computer] {
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    let kept = seen.clone();
    let worker = thread::spawn(move || {
        session::connect_mac_session_with_admission(computer, b"synthetic-computer", &told, &route, std::sync::Arc::new(crate::storage::time_source::RealClock), || Ok(()), |bytes| {
            let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
            let target = message.input["target"].as_str().unwrap_or_default().to_owned();
            kept.lock().unwrap().push(target.clone());
            use base64::Engine as _;
            let body = base64::engine::general_purpose::STANDARD.encode(target.as_bytes());
            serde_json::to_vec(&serde_json::json!({"state": "completed", "request_id": message.request_id,
                "value": {"status": 200, "headers": [["content-type", "text/plain"]], "body": body}})).map_err(|_| crate::refusal_cause::CodedError::new(()))
        })
    });
    gateway.admit_mac_connection(public).unwrap();
    (gateway, seen, worker)
}

async fn ask(forwarder: &axum::Router, host: &str, path: &str) -> (u16, String) {
    use tower::ServiceExt as _;
    let request = axum::http::Request::builder().uri(path).header("host", host).body(axum::body::Body::empty()).unwrap();
    let response = forwarder.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let body = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_for_a_name_or_a_proven_domain_reaches_the_installation_at_the_accounts_live_computer() {
    let owner = key("07");
    let address = owner.address();
    let (gateway, seen, worker) = forwarder(&owner, false);
    let forwarder = gateway.http_route_table().unwrap();

    // Before the computer hands its origins in, the host is the forwarder's own, as before: "/" names no account.
    let (status, body) = ask(&forwarder, "shop.trillion.run", "/").await;
    let answer: serde_json::Value = serde_json::from_str(&body).unwrap();
    let cause = crate::refusal_cause::Cause::from_wire(answer["cause"].as_str().unwrap()).unwrap();
    let source = include_str!("../gateway.rs");
    let condition = source.find("if hinted.is_none() && self.new_account_computers.is_empty()").unwrap();
    let at = condition + source[condition..].find("crate::cause!()").unwrap();
    let before = &source[..at];
    assert_eq!(cause.file(), "src/forwarder/gateway.rs");
    assert_eq!(cause.condition(), "refusal");
    assert_eq!(cause.line() as usize, before.bytes().filter(|byte| *byte == b'\n').count() + 1);
    assert_eq!(cause.column() as usize, before.rsplit('\n').next().unwrap().chars().count() + 1);
    assert_eq!((status, answer), (404, serde_json::json!({"error":"no_account", "cause":cause.id()})));


    let row = OriginsRow::sign(1, &[origin("shop.trillion.run", INSTALL_A), origin("www.shop.example", INSTALL_B)], &owner).unwrap();
    gateway.take_origins(&address, COMPUTER, row).unwrap();
    assert_eq!(gateway.take_origins(&address, &"e".repeat(64),
        OriginsRow::sign(2, &[origin("shop.trillion.run", INSTALL_A)], &owner).unwrap()), Err(crate::cause!(Refusal::NotBelieved)),
        "a computer the account's row does not name hands nothing in");

    let (status, body) = ask(&forwarder, "Shop.Trillion.Run:443", "/about?lang=en").await;
    assert_eq!(status, 200);
    assert_eq!(body, format!("/a/{address}/installations/{INSTALL_A}/about?lang=en"));
    let (status, body) = ask(&forwarder, "www.shop.example", "/").await;
    assert_eq!((status, body), (200, format!("/a/{address}/installations/{INSTALL_B}/")));
    // The MCP path of another origin is that installation's own path, never the forwarder's MCP.
    let (status, body) = ask(&forwarder, "shop.trillion.run", "/mcp").await;
    assert_eq!((status, body), (200, format!("/a/{address}/installations/{INSTALL_A}/mcp")));
    assert_eq!(ask(&forwarder, "other.trillion.run", "/").await.0, 404);
    assert_eq!(seen.lock().unwrap().len(), 3, "only the three known hosts reached the computer");
    // The TLS ingress lets a foreign Host through only when it is one of these origins (ingress.rs, 421 otherwise).
    assert!(gateway.names_origin("www.shop.example") && gateway.names_origin("Shop.Trillion.Run:443"));
    assert!(!gateway.names_origin("other.trillion.run") && !gateway.names_origin("evil.example"));

    drop(forwarder);
    drop(gateway);
    let _ = worker.join();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_renamed_host_sends_a_page_read_on_and_a_certificate_is_asked_only_for_a_host_a_live_account_names() {
    let owner = key("07");
    let address = owner.address();
    let (gateway, seen, worker) = forwarder(&owner, false);
    let forwarder = gateway.http_route_table().unwrap();
    let ask_path = settings().certificate_ask_path.clone();
    let row = OriginsRow::sign(1, &[moved("old.trillion.run", INSTALL_A, "new.trillion.run"), origin("new.trillion.run", INSTALL_A)], &owner).unwrap();
    assert_eq!(ask(&forwarder, "forwarder.example.test", &format!("{ask_path}?domain=new.trillion.run")).await.0, 404,
        "no row yet: no certificate");
    gateway.take_origins(&address, COMPUTER, row).unwrap();

    use tower::ServiceExt as _;
    let request = axum::http::Request::builder().uri("/pricing?x=1").header("host", "old.trillion.run").body(axum::body::Body::empty()).unwrap();
    let response = forwarder.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 301);
    assert_eq!(response.headers()["location"], "https://new.trillion.run/pricing?x=1");
    // Any other request is still the installation's.
    let request = axum::http::Request::builder().method("POST").uri("/form").header("host", "old.trillion.run").body(axum::body::Body::empty()).unwrap();
    let response = forwarder.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(seen.lock().unwrap().as_slice(), [format!("/a/{address}/installations/{INSTALL_A}/form")]);

    for (host, status) in [("new.trillion.run", 200), ("Old.Trillion.Run", 200), ("other.trillion.run", 404)] {
        assert_eq!(ask(&forwarder, "forwarder.example.test", &format!("{ask_path}?domain={host}")).await.0, status, "{host}");
    }
    assert_eq!(ask(&forwarder, "forwarder.example.test", &ask_path).await.0, 400, "no domain asked");
    drop(forwarder);
    drop(gateway);
    let _ = worker.join();
}

/// A byte route names no account in its path: on the forwarder's own host it is carried whole to the root account's live
/// computer, with its Range and lease intact, and no other path is carried that way.
#[tokio::test(flavor = "multi_thread")]
async fn a_byte_route_on_the_own_host_is_carried_to_the_root_account() {
    use tower::ServiceExt as _;
    let owner = key("07");
    let (gateway, seen, worker) = forwarder(&owner, true);
    let forwarder = gateway.http_route_table().unwrap();
    let target = "/namespace/bytes/1f%3Aabc?lease=run_synthetic";
    let request = axum::http::Request::builder().uri(target).header("host", "forwarder.example.test")
        .header("range", "bytes=0-99").body(axum::body::Body::empty()).unwrap();
    let response = forwarder.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(axum::body::to_bytes(response.into_body(), 65_536).await.unwrap().as_ref(), target.as_bytes());
    assert_eq!(seen.lock().unwrap().as_slice(), [target.to_owned()]);
    assert_eq!(ask(&forwarder, "forwarder.example.test", "/namespace/bytesx/1f").await.0, 404);
    drop(forwarder);
    drop(gateway);
    let _ = worker.join();
}
