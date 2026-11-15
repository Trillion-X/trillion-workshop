//! A computer, end to end, behind its own forwarder: an account is created at a
//! computer, the computer starts from its config with no hosting app, a key is
//! issued with the sign-in command line, the forwarder runs in this
//! process and stores nothing, the computer opens a session to it and tells
//! the account's signed computers row, and a JSON-RPC MCP call with the key
//! through the forwarder reaches the computer and is answered from the
//! account's own rows, and a records write and read through it reach the
//! account's own records store, with trillion-local's own ICU locale. A credential names its account by its address (derived from
//! the account's signing key); the account's internal owner id is never
//! changed, so an account made the old way (random owner id, no signing key)
//! gets its key at start and routes the same way. A wrong key is refused 401
//! with the Bearer challenge, and a computers row signed by another key is not
//! believed (503).
//!
//! The computer's report sets its stores' free-space floor to zero, so the test
//! runs on a disk with less than the default floor free.
//!
//! Sign-up at the computer's own listener: a new person makes an account with a
//! passkey (a test authenticator answers the challenge), the account signs in
//! with a key issued from its own routes' sign-in note, and an MCP call through the
//! forwarder is answered from its own rows. Sign-up's abuse limit refuses the
//! sixth new account in a window.

#[path = "computer_forwarder/cause_gate.rs"]
mod cause_gate;
#[path = "support/installed_tools.rs"]
mod installed_tools;
#[path = "computer_forwarder/signup_route_hint.rs"]
mod signup_route_hint;
#[path = "computer_forwarder/fake_time.rs"]
mod test_time;
#[path = "computer_forwarder/wait_inventory.rs"]
mod wait_inventory;
#[path = "support/computer_harness.rs"]
mod computer_harness;
#[path = "support/front_door.rs"]
mod front_door;
use computer_harness::*;
use test_time::clock;
use trillion_local::storage::time_source::Clock as _;
use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest,
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::{json, Value};
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use tower::ServiceExt as _;
use trillion_local::{
    account::computers::{AccountKey, ComputerSigner, ComputersRow, KeptAccount},
    forwarder::{gateway::Gateway, remote_connection_check::computer_route, session},
    native_entry::computer::{read_config, Computer},
    secrets::secrets_key::ComputerKey,
};



/// The computer key file every test in this process uses. The process opens secrets keys one way (the first computer's key
/// file is chosen once), so each test names the same key.






















/// The structured answer of a tool call, or a panic naming the whole reply.
fn answered(status: StatusCode, answer: &Value) -> Value {
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(answer["result"]["isError"] != json!(true), "{answer}");
    answer["result"]["structuredContent"].clone()
}

#[test]
fn a_key_reaches_its_account_at_a_computer_through_a_forwarder_that_stores_nothing() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("first"), &computer_key);

    // An account is created at the computer; its folder is named by its internal owner id.
    let (owner, address) = create(&config_path);
    let state = dir.path().join("first/accounts").join(&owner);
    // The account's installed tools (every account installs its tools at its first start).
    installed_tools::install(&state);

    // The computer starts from its config alone: no hosting app, no browser build, no device-tied secret store.
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    assert_eq!(computer.accounts().len(), 1);
    assert_eq!(
        (
            computer.accounts()[0].owner_id(),
            computer.accounts()[0].address()
        ),
        (owner.as_str(), address.as_str())
    );
    let _door = computer.app();
    let key = sign_in_token(&address);

    // The forwarder runs here; the computer opens its session to it and tells the account's signed row.
    let forwarder = start_forwarder();
    let executor = two_threads();
    connect(&computer, &address, forwarder.sessions);

    // The call goes through the forwarder, reaches the computer and is answered from the account's own rows.
    let (status, answer) = call_when_up(&executor, &forwarder.http, &key, &read_computers());
    let computers = answered(status, &answer);
    assert_eq!(
        computers["places"]["account"],
        address.as_str(),
        "the row is the address's: {answer}"
    );
    assert!(
        answer.to_string().contains(&computer.computer_id()),
        "the row names this computer: {answer}"
    );

    // A records read through the forwarder is answered from the account's own records store, made at account
    // creation: the record is not there yet, so its value is null.
    let (status, answer) = mcp_call_ok(
        &executor,
        &forwarder.http,
        &key,
        &tool(
            3,
            "@own-records",
            "records:read",
            "read-note-1",
            json!({"id": "computer-note-1"}),
        ),
    );
    let read = answered(status, &answer);
    assert_eq!(read["value"], Value::Null, "{answer}");

    // A records write at the computer goes through the forwarder into the account's own store. Its label comparison
    // uses trillion-local's own linked ICU 78.2, so no hosting app is needed. A read then returns the written value, and
    // the same request key answers the same receipt and writes nothing again.
    let note = json!({"records": [{"id": "computer-note-1", "type": "note", "value": {"words": "COMPUTER_NOTE"}}]});
    let (status, answer) = mcp_call_ok(
        &executor,
        &forwarder.http,
        &key,
        &tool(
            4,
            "@own-records",
            "records:write",
            "write-note-1",
            note.clone(),
        ),
    );
    let written = answered(status, &answer);
    assert_eq!(
        written,
        json!({"changed": true, "write_count": 1}),
        "{answer}"
    );
    let (status, answer) = mcp_call_ok(
        &executor,
        &forwarder.http,
        &key,
        &tool(5, "@own-records", "records:write", "write-note-1", note),
    );
    assert_eq!(answered(status, &answer), written, "{answer}");
    let (status, answer) = mcp_call_ok(
        &executor,
        &forwarder.http,
        &key,
        &tool(
            6,
            "@own-records",
            "records:read",
            "read-note-2",
            json!({"id": "computer-note-1"}),
        ),
    );
    assert_eq!(
        answered(status, &answer)["value"]["words"],
        "COMPUTER_NOTE",
        "{answer}"
    );

    // Twenty tools/list calls in a row through the forwarder: each is a principal check and one call, two messages on
    // the computer's session with the account routes' own dispatch, and each answers well within a second.
    for index in 0..20 {
        let started = Instant::now();
        let (status, answer) = mcp_call_ok(
            &executor,
            &forwarder.http,
            &key,
            &json!({"jsonrpc": "2.0", "id": 100 + index, "method": "tools/list", "params": {}}),
        );
        let took = started.elapsed();
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert!(
            answer["result"]["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty()),
            "{answer}"
        );
        assert!(
            took < Duration::from_secs(1),
            "tools/list {index} took {took:?}"
        );
    }

    // A wrong key that names the same account is refused by the computer's own sign-in: 401 with the Bearer challenge.
    let wrong = format!("nm_{address}_{}", "0".repeat(64));
    let (status, challenge, _) = mcp_call(&executor, &forwarder.http, &wrong, &read_computers());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        challenge.is_some_and(|value| value.starts_with("Bearer")),
        "a 401 carries WWW-Authenticate"
    );

    // A key naming the account by its internal owner id is not routed: the forwarder knows no such address.
    let by_owner = format!("nm_{owner}_{}", "0".repeat(64));
    let (status, _, _) = mcp_call(&executor, &forwarder.http, &by_owner, &read_computers());
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // A credential in no current shape is refused before any computer is asked.
    let (status, challenge, _) = mcp_call(
        &executor,
        &forwarder.http,
        "not-a-credential",
        &read_computers(),
    );
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(challenge.is_some());

    // An account made the old way: a random owner id and no signing key in its vault (every account made before signing
    // keys). A copy never makes its own key (computers.rs kept_account_key), so this computer skips it at start and serves
    // no key for it, and the forwarder has no computer that answers for it.
    let old_config = computer_config(&dir.path().join("second"), &computer_key);
    let (old_owner, _made_address) = create(&old_config);
    let old_state = dir.path().join("second/accounts").join(&old_owner);
    for name in [
        "held-values.sqlite",
        "held-values.sqlite-wal",
        "held-values.sqlite-shm",
    ] {
        let _ = fs::remove_file(old_state.join(name));
    }
    let old_computer = Arc::new(
        Computer::start_with_clock(read_config(&old_config).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    assert!(
        old_computer.accounts().is_empty(),
        "a keyless account is skipped at start, never served with a key this computer made"
    );
    // And the first account still answers beside it.
    let (status, answer) = mcp_call_ok(&executor, &forwarder.http, &key, &read_computers());
    assert_eq!(
        answered(status, &answer)["places"]["account"],
        address.as_str()
    );

    // The forwarder kept nothing: a second one, which only an impostor computer reaches, believes no row for the
    // account and answers 503, though the impostor's row is newer and names itself.
    let lonely = start_forwarder();
    let impostor_computer =
        ComputerSigner::of(&ComputerKey::from_bytes(vec![7u8; 32]).unwrap()).unwrap();
    let impostor_account_key = AccountKey::generate().unwrap();
    let honest = computer.told(&address);
    assert_eq!(honest.len(), 1);
    assert!(
        honest[0].believed(&address),
        "the honest computer tells a row its account's key signed"
    );
    let real_public = honest[0].account_key.clone();
    let forged_row = ComputersRow::sign(
        &address,
        99,
        &[impostor_computer.computer_id()],
        &[impostor_computer.computer_id()],
        &impostor_account_key,
    )
    .unwrap();
    for told in [
        // Signed by another key and told with that key: the key does not name the address.
        KeptAccount {
            row: forged_row.clone(),
            account_key: impostor_account_key.public_hex(),
        },
        // Signed by another key and told with the account's own key.
        KeptAccount {
            row: forged_row.clone(),
            account_key: real_public.clone(),
        },
        // The account's real row, replayed by the impostor: believed, but it names only the honest computer, which is not
        // live at this forwarder.
        honest[0].clone(),
    ] {
        let credential = impostor_computer.session_credential(&address, now_ms());
        let (route, _) = computer_route(&credential, now_ms()).unwrap();
        let stream = TcpStream::connect(lonely.sessions).unwrap();
        timeouts(&stream);
        std::thread::spawn(move || {
            session::connect_mac_session_with_admission(
                stream,
                credential.as_bytes(),
                &[told],
                &route,
                real_clock(),
                || Ok(()),
                |_| Err::<Vec<u8>, trillion_local::refusal_cause::CodedError<()>>(trillion_local::refusal_cause::CodedError::new(())),
            )
        });
    }
    let deadline = Instant::now() + Duration::from_millis(300);
    for _ in 0..3 {
        lonely.admissions.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("each registration was judged");
    }
    let (status, _, body) = mcp_call(&executor, &lonely.http, &key, &read_computers());
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.to_string().contains("unavailable"), "{body}");

    // The honest forwarder still answers from the live computer.
    let (status, _, _) = mcp_call(&executor, &forwarder.http, &key, &read_computers());
    assert_eq!(status, StatusCode::OK);
    drop(forwarder.gateway);
    drop(lonely.gateway);
}

/// `mcp_call` without the challenge header.
fn mcp_call_ok(
    executor: &Executor,
    http: &RouteTable,
    key: &str,
    body: &Value,
) -> (StatusCode, Value) {
    let (status, _, answer) = mcp_call(executor, http, key, body);
    (status, answer)
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-up at a computer: a new person makes an account from the computer's own listener, with a passkey.

const ORIGIN: &str = "https://computer.test";
const RP: &str = "computer.test";
/// SPKI prefix of an uncompressed P-256 public key (91 bytes in all).
const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// A simulated passkey authenticator (the browser's side of WebAuthn, "none" attestation): a P-256 key, the SPKI DER
/// the browser reports for it, and its credential id.
struct Authenticator {
    spki: Vec<u8>,
    id: Vec<u8>,
}

impl Authenticator {
    fn new(id: u8) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let mut spki = P256_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(key.public_key().as_ref());
        Self {
            spki,
            id: vec![id; 16],
        }
    }

    /// The browser's `publicKeyCredential` answer to the registration `challenge`: the body the sign-up page posts to
    /// `/sign-up/finish`.
    fn registration(&self, challenge: &str, name: &str) -> Value {
        let client = json!({"type": "webauthn.create", "challenge": challenge, "origin": ORIGIN, "crossOrigin": false});
        // rpIdHash, flags (user present, user verified, attested), counter, AAGUID, the credential id, a COSE stand-in.
        let mut data = digest::digest(&digest::SHA256, RP.as_bytes())
            .as_ref()
            .to_vec();
        data.push(0x45);
        data.extend_from_slice(&0u32.to_be_bytes());
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
        data.extend_from_slice(&self.id);
        data.extend_from_slice(&[0xa5, 0x01, 0x02]);
        let encode = |bytes: &[u8]| URL_SAFE_NO_PAD.encode(bytes);
        json!({
            "name": name, "id": encode(&self.id), "rawId": encode(&self.id), "type": "public-key",
            "response": {
                "clientDataJSON": encode(client.to_string().as_bytes()),
                "authenticatorData": encode(&data),
                "publicKey": encode(&self.spki),
                "publicKeyAlgorithm": -7,
            },
        })
    }
}



/// The S256 code challenge of a verifier.
fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()))
}

#[test]
#[ignore = "reads each account's sign-in page and OAuth routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn two_accounts_at_one_computer_each_door_reaches_only_its_own_account() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("two"), &computer_key);
    let (_, address_a) = create(&config_path);
    let (_, address_b) = create(&config_path);
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    assert_eq!(computer.accounts().len(), 2);
    let app = computer.app();
    let executor = two_threads();
    let forwarder = start_forwarder();
    let (a, b) = (format!("/a/{address_a}"), format!("/a/{address_b}"));

    // Each account's browser sign-in page is its own: its passkey button posts to its own paths.
    let (status, page_a) = listener(
        &executor,
        &app,
        Method::GET,
        &format!("{a}/sign-in"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::OK, "{page_a}");
    assert!(page_a.contains(&format!("data-base=\"{a}\"")), "{page_a}");
    assert!(!page_a.contains(&address_b), "A's page names no part of B");
    let (status, page_b) = listener(
        &executor,
        &app,
        Method::GET,
        &format!("{b}/sign-in?next=/"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert!(
        page_b.contains(&format!("data-base=\"{b}\"")) && !page_b.contains(&address_a),
        "{page_b}"
    );

    // Discovery: the RFC 8414 metadata names each account's own issuer, in both forms.
    for url in [
        format!("{a}/.well-known/oauth-authorization-server"),
        format!("/.well-known/oauth-authorization-server/a/{address_a}"),
    ] {
        let (status, meta) = listener(&executor, &app, Method::GET, &url, None, None);
        assert_eq!(status, StatusCode::OK, "{meta}");
        let meta: Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(meta["issuer"], format!("https://computer.test{a}").as_str());
        assert_eq!(
            meta["authorization_endpoint"],
            format!("https://computer.test{a}/authorize").as_str()
        );
    }
    let (status, resource) = listener(
        &executor,
        &app,
        Method::GET,
        &format!("{b}/.well-known/oauth-protected-resource/mcp"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::OK, "{resource}");
    assert_eq!(
        serde_json::from_str::<Value>(&resource).unwrap()["resource"],
        format!("https://computer.test{b}/mcp").as_str()
    );
    // RFC 9728's root form, under the account's base and with the address after the well-known name, is the same document.
    for url in [
        format!("{b}/.well-known/oauth-protected-resource"),
        format!("/.well-known/oauth-protected-resource/a/{address_b}"),
    ] {
        let (status, root) = listener(&executor, &app, Method::GET, &url, None, None);
        assert_eq!(
            (status, root.as_str()),
            (StatusCode::OK, resource.as_str()),
            "{url}"
        );
    }

    // OAuth: a client registered at A is A's. Its authorize request goes to A's sign-in, under A's path. B does not
    // know the client, so B's authorize refuses it.
    let verifier = "a".repeat(43);
    let (status, client) = listener(
        &executor,
        &app,
        Method::POST,
        &format!("{a}/oauth/register"),
        None,
        Some(
            &json!({"client_name": "Test app", "redirect_uris": ["https://app.example/callback"]}),
        ),
    );
    assert_eq!(status, StatusCode::CREATED, "{client}");
    let client_id = serde_json::from_str::<Value>(&client).unwrap()["client_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let authorize = format!("response_type=code&client_id={client_id}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback\
        &code_challenge={}&code_challenge_method=S256&state=s1", s256(&verifier));
    let (status, _) = listener_with(
        &executor,
        &app,
        Method::GET,
        &format!("{a}/authorize?{authorize}"),
        &[],
        None,
    );
    assert_eq!(status, StatusCode::SEE_OTHER);
    let location = listener_location(&executor, &app, &format!("{a}/authorize?{authorize}"));
    // The next step is held in a cookie, never in the address.
    assert_eq!(location, format!("{a}/sign-in"), "A's sign-in, under A's path");
    let (status, refused) = listener_with(
        &executor,
        &app,
        Method::GET,
        &format!("{b}/authorize?{authorize}"),
        &[],
        None,
    );
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "B does not know A's client: {refused}"
    );
    let (status, _) = listener(
        &executor,
        &app,
        Method::POST,
        &format!("{b}/oauth/register"),
        None,
        Some(&json!({"client_name": "B app", "redirect_uris": ["https://app.example/callback"]})),
    );
    assert_eq!(status, StatusCode::CREATED);

    // A request that names no held account is refused plainly, and reaches no account.
    let unknown = "0".repeat(64);
    let (status, body) = listener(&executor, &app, Method::GET, "/sign-in/forgot-password", None, None);
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(
        body.contains("no_account") && !body.contains("data-passkey"),
        "{body}"
    );
    let (status, _) = listener(
        &executor,
        &app,
        Method::GET,
        &format!("/a/{unknown}/sign-in"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = listener(
        &executor,
        &app,
        Method::POST,
        "/mcp",
        None,
        Some(&read_computers()),
    );
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "no account named: refused before any door"
    );

    // A bearer credential names its account: a wrong key for A is refused by A's own routes (401, Bearer challenge), and
    // a credential for an unheld address is refused plainly.
    let wrong_a = format!("nm_{address_a}_{}", "0".repeat(64));
    let accept = ("accept", "application/json, text/event-stream");
    let (status, body) = listener_with(
        &executor,
        &app,
        Method::POST,
        "/mcp",
        &[("authorization", &format!("Bearer {wrong_a}")), accept],
        Some(&read_computers()),
    );
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let wrong_held_nowhere = format!("nm_{unknown}_{}", "0".repeat(64));
    let (status, _) = listener_with(
        &executor,
        &app,
        Method::POST,
        "/mcp",
        &[
            ("authorization", &format!("Bearer {wrong_held_nowhere}")),
            accept,
        ],
        Some(&read_computers()),
    );
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Each account still answers its own key through the forwarder, and not the other's.
    let key_b = sign_in_token(&address_b);
    connect(&computer, &address_b, forwarder.sessions);
    let (status, answer) = call_when_up(&executor, &forwarder.http, &key_b, &read_computers());
    assert_eq!(
        answered(status, &answer)["places"]["account"],
        address_b.as_str(),
        "{answer}"
    );

    // The forwarder carries a path under an account's address, whole, to a live computer of that account: B's
    // sign-in page, its RFC 9728 metadata and an OAuth registration (a POST with a body) reach B's door at the computer.
    let (status, page) = listener(
        &executor,
        &forwarder.http,
        Method::GET,
        &format!("{b}/sign-in"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page.contains(&format!("data-base=\"{b}\"")) && !page.contains(&address_a),
        "{page}"
    );
    // Each carried answer names the computer whose session answered it (`answered_by_header`).
    let numbers: Value =
        serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
    let answered_by = two_threads().block_on(async {
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("{b}/sign-in"))
            .header(header::HOST, "computer.test")
            .body(Body::empty())
            .unwrap();
        let response = forwarder.http.clone().oneshot(request).await.unwrap();
        response
            .headers()
            .get(numbers["answered_by_header"].as_str().unwrap())
            .map(|value| value.to_str().unwrap().to_owned())
    });
    assert_eq!(
        answered_by.as_deref(),
        Some(computer.computer_id().as_str()),
        "the answer names the computer that answered"
    );
    let (status, resource) = listener(
        &executor,
        &forwarder.http,
        Method::GET,
        &format!("/.well-known/oauth-protected-resource/a/{address_b}/mcp"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::OK, "{resource}");
    assert_eq!(
        serde_json::from_str::<Value>(&resource).unwrap()["resource"],
        format!("https://computer.test{b}/mcp").as_str()
    );
    let (status, client) = listener(
        &executor,
        &forwarder.http,
        Method::POST,
        &format!("{b}/oauth/register"),
        None,
        Some(
            &json!({"client_name": "Through the forwarder", "redirect_uris": ["https://app.example/callback"]}),
        ),
    );
    assert_eq!(status, StatusCode::CREATED, "{client}");
    // A has no live session at this forwarder: its paths answer 503. A path that names no account is not carried.
    let (status, body) = listener(
        &executor,
        &forwarder.http,
        Method::GET,
        &format!("{a}/sign-in"),
        None,
        None,
    );
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let (status, _) = listener(
        &executor,
        &forwarder.http,
        Method::GET,
        "/sign-in",
        None,
        None,
    );
    // The root sign-in is a hosting computer's page (it names an account by an email only a hosting computer may ask the
    // operator for): with no hosting computer named, the forwarder has none to carry it to.
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A computer message needs a computer's own proof for the account.
    let (status, _) = listener_with(
        &executor,
        &forwarder.http,
        Method::POST,
        &format!("{b}/places/{}", computer.computer_id()),
        &[("authorization", &format!("Bearer {key_b}"))],
        Some(&json!({"message": {"kind": "stamps"}})),
    );
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A refused credential's 401 challenge points at that account's own metadata at the forwarder.
    let wrong_b = format!("nm_{address_b}_{}", "0".repeat(64));
    let (status, challenge, _) = mcp_call(&executor, &forwarder.http, &wrong_b, &read_computers());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(challenge.as_deref(),
        Some(format!("Bearer resource_metadata=\"https://{FORWARDER_HOST}/.well-known/oauth-protected-resource/a/{address_b}/mcp\"").as_str()));
    drop(forwarder.gateway);
}

fn listener_location(executor: &Executor, app: &RouteTable, path: &str) -> String {
    use tower::ServiceExt as _;
    let request = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header(header::HOST, "computer.test")
        .body(Body::empty())
        .unwrap();
    executor.block_on(async {
        let response = app.clone().oneshot(request).await.unwrap();
        response
            .headers()
            .get(header::LOCATION)
            .expect("a redirect names where to go")
            .to_str()
            .unwrap()
            .to_owned()
    })
}

/// A POST of `body` to the computer's listener from its own origin: the status, the `set-cookie` header and the body.
fn post_with_cookie(
    executor: &Executor,
    app: &RouteTable,
    path: &str,
    body: &Value,
) -> (StatusCode, Option<String>, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::HOST, "computer.test")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    executor.block_on(async {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .map(|value| value.to_str().unwrap().to_owned());
        // A body that breaks on its way (the computer's session ended mid-answer) reads as an answer with no body.
        let bytes = to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap_or_default();
        (
            status,
            cookie,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    })
}

/// Default computers at sign-up: a computer whose config names three computers (`default_places`) gives every account its
/// sign-up makes a first row naming them, signed by the new account, with this computer may-answer. A config that names
/// a row this computer is not may-answer in, or a row in a wrong shape, refuses at start or at config.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_new_account_starts_in_the_computers_its_sign_up_computer_names_as_default() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("defaults"), &computer_key);
    let me = ComputerSigner::of(&ComputerKey::read(&computer_key).unwrap())
        .unwrap()
        .computer_id();
    let (other, copy_only) = ("b".repeat(64), "c".repeat(64));
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    config["default_places"] = json!({"holders": [me, other, copy_only], "answering": [me, other], "voters": [me]});
    fs::write(&config_path, config.to_string()).unwrap();
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    let app = computer.app();
    let executor = two_threads();

    let (status, given) = listener(
        &executor,
        &app,
        Method::POST,
        "/sign-up/options",
        Some(ORIGIN),
        Some(&json!({})),
    );
    assert_eq!(status, StatusCode::OK, "{given}");
    let challenge = serde_json::from_str::<Value>(&given).unwrap()["options"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let answer = Authenticator::new(21).registration(&challenge, "Default computers");
    let (status, done) = listener(
        &executor,
        &app,
        Method::POST,
        "/sign-up/finish",
        Some(ORIGIN),
        Some(&answer),
    );
    assert_eq!(status, StatusCode::OK, "{done}");
    let address = serde_json::from_str::<Value>(&done).unwrap()["address"]
        .as_str()
        .unwrap()
        .to_owned();
    let new = computer
        .accounts()
        .into_iter()
        .find(|account| account.address() == address)
        .expect("the new account is held");

    // The account's own row, as the computer keeps and tells it (what `sign-in:computers` reads), names the three computers.
    let told = computer
        .told(&address)
        .into_iter()
        .next()
        .expect("the computer tells the new account");
    let row = told.row.clone();
    let mut copy_keepers = vec![me.clone(), other.clone(), copy_only.clone()];
    copy_keepers.sort();
    assert_eq!(row.account, address);
    assert_eq!(row.revision, 1, "the first row");
    assert_eq!(row.copy_keepers, copy_keepers);
    assert_eq!(
        row.voters,
        vec![me.clone()],
        "the running computer is the only voter: a majority of one, so its own sign-in rows are current"
    );
    assert!(
        row.may_answer.contains(&me)
            && row.may_answer.contains(&other)
            && !row.may_answer.contains(&copy_only),
        "{row:?}"
    );
    assert!(
        told.believed(&address),
        "signed by the new account's own key"
    );
    assert!(
        new.copies().is_some(),
        "an account whose first row names voters runs copies from its sign-up"
    );
    // Its routes admit a key only on a majority of its voters: the running computer is one of one, so its key is admitted.
    let key = sign_in_token(&address);
    let accept = ("accept", "application/json, text/event-stream");
    let (status, body) = listener_with(
        &executor,
        &app,
        Method::POST,
        "/mcp",
        &[("authorization", &format!("Bearer {key}")), accept],
        Some(&read_computers()),
    );
    assert_eq!(status, StatusCode::OK, "a majority of one voter vouches for the key: {body}");

    // A default row this computer does not answer in refuses at start; a row in a wrong shape refuses at config.
    config["default_places"] = json!({"holders": [other], "answering": [other], "voters": []});
    fs::write(&config_path, config.to_string()).unwrap();
    let refused = Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
        .err()
        .expect("refused");
    assert!(refused.to_string().contains("stage=config"), "{refused}");
    config["default_places"] = json!({"holders": [me], "answering": [other], "voters": []});
    fs::write(&config_path, config.to_string()).unwrap();
    assert!(
        read_config(&config_path).is_err(),
        "a computer that may answer keeps a copy too"
    );
}

/// One forwarder session per computer: a computer holding 100 accounts opens one session that tells all of them, the
/// forwarder admits that one, and each account still routes through it with its own key; one account's row edit
/// leaves only that account to tell again, and the forwarder takes the new row for the computer's session.
/// Idle cost: with the computer's background running (sessions to a forwarder that does not answer, and its timer), 100
/// accounts nobody uses cost one session, no account timer, and a timer that ran no step.
#[test]
fn a_computer_keeping_100_accounts_keeps_one_session_and_idle_accounts_cost_no_timer() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("hundred"), &computer_key);
    let made: Vec<(String, String)> = (0..100).map(|_| create(&config_path)).collect();
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    assert_eq!(computer.accounts().len(), 100);
    let executor = two_threads();

    // A forwarder that counts the sessions it admits.
    let gateway = Arc::new(Gateway::with_computers(FORWARDER_HOST, real_clock()));
    let http = gateway.http_route_table().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let sessions = listener.local_addr().unwrap();
    let admitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let (gateway, admitted) = (gateway.clone(), admitted.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                timeouts(&stream);
                admitted.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                let _ = gateway.admit_mac_connection(stream);
            }
        });
    }
    {
        let computer = computer.clone();
        std::thread::spawn(move || {
            let stream = TcpStream::connect(sessions).unwrap();
            timeouts(&stream);
            computer.serve_computer_session(stream, &STOP)
        });
    }
    // Every account routes through the one session, each with its own key, and reads its own row.
    for (_, address) in &made {
        let key = sign_in_token(address);
        let (status, answer) = call_when_up(&executor, &http, &key, &read_computers());
        assert_eq!(
            answered(status, &answer)["places"]["account"],
            address.as_str(),
            "{answer}"
        );
    }
    assert_eq!(
        admitted.load(std::sync::atomic::Ordering::Acquire),
        1,
        "one session carries all 100 accounts"
    );
    assert!(
        made.iter()
            .all(|(_, address)| computer.row_to_tell(address).is_none()),
        "every row was told at the open"
    );

    // One account's row edit (a computers operation through its routes): only that account is left to tell again.
    let (_, address) = &made[7];
    let key = sign_in_token(address);
    let other_computer = "e".repeat(64);
    let (status, answer) = mcp_call_ok(
        &executor,
        &http,
        &key,
        &tool(
            9,
            "@sign-in",
            "sign-in:set-places",
            "add-copy-1",
            json!({"op": "add-computer", "computer": other_computer}),
        ),
    );
    let edited: ComputersRow =
        serde_json::from_value(answered(status, &answer)["places"].clone()).unwrap();
    assert_eq!(edited.revision, 2, "{answer}");
    let left: Vec<&String> = made
        .iter()
        .map(|(_, address)| address)
        .filter(|address| computer.row_to_tell(address).is_some())
        .collect();
    assert_eq!(left, vec![address], "only the edited account is told again");
    // The forwarder takes the edited row for the computer's session, by the computer's own proof for that account.
    let told = computer.row_to_tell(address).unwrap();
    let signer = ComputerSigner::of(&ComputerKey::read(&computer_key).unwrap()).unwrap();
    let proof = signer.message_credential(address, now_ms());
    let (status, body) = listener_with(
        &executor,
        &http,
        Method::POST,
        &format!("/a/{address}/places/announce"),
        &[("authorization", &format!("Bearer {proof}"))],
        Some(&json!({"announced": told})),
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    // A fresh request key: the same key from the loop above is answered again with the first answer, by design.
    let read_after_announce = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "run_resource_operation",
        "arguments": {"resource": "@sign-in", "operation": "sign-in:places", "request_key": "read-computers-after-announce", "input": {}},
    }});
    let (status, answer) = mcp_call_ok(&executor, &http, &key, &read_after_announce);
    assert_eq!(
        answered(status, &answer)["places"]["revision"],
        2,
        "the forwarder routes by the edited row: {answer}"
    );
    let (_, other_address) = &made[8];
    let other_key = sign_in_token(other_address);
    let (status, answer) = mcp_call_ok(&executor, &http, &other_key, &read_computers());
    assert_eq!(
        answered(status, &answer)["places"]["revision"],
        1,
        "another account's row is as it was: {answer}"
    );
    drop(gateway);
}

static IDLE_STOP: AtomicBool = AtomicBool::new(false);

#[test]
fn a_hundred_idle_accounts_cost_one_session_and_no_timer() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("idle"), &computer_key);
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    // A forwarder that never answers: the session keeps trying, as it would while the forwarder is away.
    config["router"] = json!("127.0.0.1:9");
    fs::write(&config_path, config.to_string()).unwrap();
    for _ in 0..100 {
        create(&config_path);
    }
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    let threads = || {
        fs::read_dir("/proc/self/task")
            .map(|tasks| tasks.count())
            .unwrap_or(0)
    };
    let before = threads();
    computer.keep_forwarder_sessions(&IDLE_STOP);
    let deadline = Instant::now() + Duration::from_millis(1500);
    while computer.background().forwarder_sessions != 1 || computer.background().computer_timers != 1 {
        clock().progress(deadline, Duration::from_millis(1500));
        assert!(Instant::now() < deadline, "the computer's background workers did not start");
    }
    // CPU this process used while advancing 10 virtual seconds with every account idle (utime + stime from /proc/self/stat, in ticks).
    let cpu = || {
        fs::read_to_string("/proc/self/stat")
            .ok()
            .and_then(|stat| {
                let fields: Vec<String> = stat
                    .rsplit(')')
                    .next()?
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect();
                Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
            })
            .unwrap_or(0)
    };
    let at = cpu();
    clock().advance(Duration::from_secs(10));
    let ticks = cpu().saturating_sub(at);
    let background = computer.background();
    let started = threads().saturating_sub(before);
    eprintln!("idle-cost accounts=100 forwarder_sessions={} account_timers={} computer_timers={} timer_steps={} active={} threads_started={started} cpu_ticks_virtual_10s={ticks}",
        background.forwarder_sessions, background.account_timers, background.computer_timers, background.timer_steps, background.active_accounts);
    assert_eq!(
        background.forwarder_sessions, 1,
        "one session for the computer, not one per account"
    );
    assert_eq!(
        background.account_timers, 0,
        "no account runs a timer of its own"
    );
    assert_eq!(background.computer_timers, 1);
    assert_eq!(
        background.timer_steps, 0,
        "with no account active the computer's timer ran no step"
    );
    assert_eq!(background.active_accounts, 0);
    IDLE_STOP.store(true, std::sync::atomic::Ordering::Release);
    clock().drive(|| computer.join_sessions(), Duration::from_secs(30), false);
    assert_eq!(
        computer.background().forwarder_sessions + computer.background().computer_timers,
        0,
        "everything stops"
    );
}

// ---- A computer follows a signed trillion-local release feed (src/native_entry/computer/releases.rs). ----

static RELEASE_STOP: AtomicBool = AtomicBool::new(false);

/// A test root and a `localhost` leaf it signed (the openssl command line, as trillion-local's own TLS fixture makes them):
/// the root's PEM, and the leaf's identity for the test's feed server.
fn localhost_tls(folder: &Path) -> (Vec<u8>, native_tls::Identity) {
    let openssl = |args: &[&str]| {
        let done = std::process::Command::new("openssl")
            .env("OPENSSL_CONF", folder.join("openssl.cnf"))
            .args(args)
            .current_dir(folder)
            .output()
            .expect("the openssl command line makes the test's TLS root");
        assert!(
            done.status.success(),
            "{}",
            String::from_utf8_lossy(&done.stderr)
        );
    };
    fs::write(
        folder.join("openssl.cnf"),
        "[req]\ndistinguished_name=dn\n[dn]\n",
    )
    .unwrap();
    openssl(&[
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-sha256",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-subj",
        "/CN=Release Feed Test Root",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    openssl(&[
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "leaf.key",
        "-out",
        "leaf.csr",
        "-subj",
        "/CN=localhost",
    ]);
    fs::write(folder.join("leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n").unwrap();
    openssl(&[
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "leaf.pem",
        "-days",
        "1",
        "-sha256",
        "-extfile",
        "leaf.ext",
    ]);
    openssl(&[
        "pkcs8",
        "-topk8",
        "-nocrypt",
        "-in",
        "leaf.key",
        "-out",
        "leaf-pkcs8.key",
    ]);
    let mut chain = fs::read(folder.join("leaf.pem")).unwrap();
    chain.extend_from_slice(&fs::read(folder.join("ca.pem")).unwrap());
    let identity =
        native_tls::Identity::from_pkcs8(&chain, &fs::read(folder.join("leaf-pkcs8.key")).unwrap())
            .unwrap();
    (fs::read(folder.join("ca.pem")).unwrap(), identity)
}

/// The test's own feed server over TLS at `localhost`: each GET answers the body its path names in `files`, or 404.
/// Answers its port.
fn feed_server(
    identity: native_tls::Identity,
    files: Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
) -> u16 {
    use std::io::{Read as _, Write as _};
    let acceptor = Arc::new(native_tls::TlsAcceptor::new(identity).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            timeouts(&stream);
            let (acceptor, files) = (acceptor.clone(), files.clone());
            std::thread::spawn(move || {
                let Ok(mut tls) = acceptor.accept(stream) else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && head.len() < 16384 {
                    if tls.read(&mut byte).unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let path = String::from_utf8_lossy(&head)
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .to_owned();
                let body = files.lock().unwrap().get(&path).cloned();
                let _ = match body {
                    Some(body) => tls.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                        .and_then(|_| tls.write_all(&body)),
                    None => tls.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                };
                let _ = tls.shutdown();
            });
        }
    });
    port
}

/// A release body: the trillion-local binary and product/.
fn release_body(binary: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    for (path, bytes) in [
        ("trillion-local", binary),
        ("product/data.json", b"{}".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Regular);
        builder.append_data(&mut header, path, bytes).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

/// A feed entry for `body` at `url`, signed with the Ed25519 key `private` (64 hex).
fn release_entry(
    commit: &str,
    sequence: u64,
    target: &str,
    url: &str,
    body: &[u8],
    urgent: bool,
    private: &str,
) -> Value {
    let content = format!(
        "1f:{}",
        content_crypto::advanced::blake3::hash(body).to_hex()
    );
    let signed = format!(
        "trillion-engine-release-v1\n{commit}\n{sequence}\n{target}\n{content}\n{}\n{urgent}",
        body.len()
    );
    let signature = content_crypto::Ed25519Signature::sign(signed.as_bytes(), private).unwrap();
    json!({"commit": commit, "sequence": sequence, "target": target, "url": url, "content": content, "bytes": body.len(),
        "urgent": urgent, "signature": signature})
}

/// The real `trillion-local serve CONFIG`, started as a copy older than the signed release `current` names, starts that
/// release instead of itself before it opens anything: same arguments, `TRILLION_STARTED_CURRENT` set to the commit (so
/// a service manager may start any copy). The release here is a script that writes what it was started with. With keys
/// the kept entry is not signed by, the copy starts nothing of `current` and goes on as itself.
#[cfg(unix)]
#[test]
fn an_older_copy_started_as_serve_starts_the_signed_current_release_in_its_own_place() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let private = "5555555555555555555555555555555555555555555555555555555555555555";
    let public = content_crypto::Ed25519Signature::public_key_from_private(private).unwrap();
    let releases = dir.path().join("releases");
    let commit: String = std::iter::repeat_n('7', 40).collect();
    let folder = releases.join(&commit);
    fs::create_dir_all(&folder).unwrap();
    let said = dir.path().join("said");
    let program = folder.join("trillion-local");
    fs::write(
        &program,
        format!(
            "#!/bin/sh\nprintf '%s|%s|%s' \"$1\" \"$2\" \"$TRILLION_STARTED_CURRENT\" > '{}'\n",
            said.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    let target = String::from_utf8(
        Command::new(env!("CARGO_BIN_EXE_trillion-local"))
            .arg("release")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .lines()
    .find_map(|line| line.strip_prefix("target ").map(str::to_owned))
    .unwrap();
    let entry = release_entry(
        &commit,
        1 << 62,
        &target,
        "https://releases.test/7.tar.gz",
        b"body",
        false,
        private,
    );
    fs::write(folder.join("release.json"), entry.to_string()).unwrap();
    std::os::unix::fs::symlink(&commit, releases.join("current")).unwrap();

    let config_path = computer_config(&dir.path().join("older"), &shared_computer_key());
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    config["release_feed"] = json!({"urls": ["https://releases.test/feed.json"], "public_keys": [public], "releases": releases});
    fs::write(&config_path, config.to_string()).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_trillion-local"))
        .arg("serve")
        .arg(&config_path)
        .env_remove("TRILLION_STARTED_CURRENT")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(
        status.success(),
        "the started release's own exit ends the process"
    );
    assert_eq!(
        fs::read_to_string(&said).unwrap(),
        format!("serve|{}|{commit}", config_path.display())
    );

    // Keys the kept entry is not signed by: `current` is not started (the copy serves as itself, stopped here).
    fs::remove_file(&said).unwrap();
    let stranger = content_crypto::Ed25519Signature::public_key_from_private(
        "6666666666666666666666666666666666666666666666666666666666666666",
    )
    .unwrap();
    config["release_feed"]["public_keys"] = json!([stranger]);
    config["listen"] = json!("127.0.0.1:7198");
    fs::write(&config_path, config.to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_trillion-local"))
        .arg("serve")
        .arg(&config_path)
        .env_remove("TRILLION_STARTED_CURRENT")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (said_progress, progress) = std::sync::mpsc::channel();
    let output = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for _ in std::io::BufReader::new(output).lines() { let _ = said_progress.send(()); }
    });
    let deadline = Instant::now() + Duration::from_millis(1500);
    while TcpStream::connect("127.0.0.1:7198").is_err() {
        progress.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("the serving copy started");
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        !said.exists(),
        "a release not signed by a listed key is never started"
    );
}


/// The handover a computer makes before it stops for a release (`releases::hand_over_all`, the same call
/// `Computer::hand_over_writer_turns` makes over every account it holds): one account at three computers A, B and C,
/// all voting, A the writer. While A hands its writer turn over, B keeps serving reads of the account from its own
/// copy, every one; then another computer takes the writer turn well before A's term would have run out, and writes go
/// on. (One process opens secrets keys one way, so the second computer of an account is its copies here, with a link
/// that calls the other computer's `Copies::answer` directly, as tests/computer_copies.rs runs them.)
#[test]
fn a_second_computer_of_the_account_keeps_answering_reads_while_the_first_hands_its_writer_turn_over_for_a_release(
) {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use trillion_local::{
        account::computers::{
            copies::{sign_in_rows, Copies, CopiesConfig, Link},
            messages::{Answer, Message},
        },
        records::Mutation,
        storage::record_store::settings::Limits,
    };
    const OWNER: &str = "0dd0000000000000000000000000000000000000000000000000000000000007";
    const RESOURCE: &str = "own-records";
    let numbers: Value =
        serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
    let (term_ms, renew_every_ms) = (
        numbers["term_ms"].as_i64().unwrap(),
        numbers["renew_every_ms"].as_i64().unwrap(),
    );

    #[derive(Default)]
    struct Net(std::sync::Mutex<HashMap<String, Arc<Copies>>>);
    struct Direct {
        me: String,
        net: Arc<Net>,
    }
    impl Link for Direct {
        fn send(&self, to: &str, message: &Message) -> Option<Answer> {
            let computer = self.net.0.lock().unwrap().get(to).cloned()?;
            Some(computer.answer(&self.me, message.clone()))
        }
    }

    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let account = AccountKey::generate().unwrap();
    let address = account.address();
    let keys: Vec<ComputerKey> = (0..3)
        .map(|at| ComputerKey::from_bytes(vec![70 + at as u8; 32]).unwrap())
        .collect();
    let ids: Vec<String> = keys
        .iter()
        .map(|key| ComputerSigner::of(key).unwrap().computer_id())
        .collect();
    let row = ComputersRow::sign_with_voters(&address, 1, &ids, &ids, &ids, &account).unwrap();
    let root = trillion_local::secrets::secrets_key::generate().unwrap();
    let context = numbers["computer_id_context"].as_str().unwrap().to_owned();
    let net = Arc::new(Net::default());
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let mut computers = Vec::new();
    for (at, key) in keys.into_iter().enumerate() {
        let folder = dir.path().join(["a", "b", "c"][at]);
        fs::create_dir_all(&folder).unwrap();
        let term_clock = clock.clone();
        let copies = Copies::new(
            CopiesConfig {
                stores: None,
                address: address.clone(),
                owner: OWNER.to_owned(),
                user: "person".to_owned(),
                computer: ids[at].clone(),
                row: row.clone(),
                records: folder.join("records.sqlite"),
                limits: Some(Limits::fixed(1 << 20, 1 << 30)),
                sign_in: sign_in_rows(&folder).unwrap(),
            },
            Arc::new(Direct {
                me: ids[at].clone(),
                net: net.clone(),
            }),
            Arc::new(move || term_clock.load(Ordering::Acquire)),
        )
        .unwrap();
        let held = (at == 0).then(|| {
            use trillion_local::secrets::secrets_key::{open_sent_key, write_sent};
            // The root reaches the computer the way the owner sends it: a sent file opened with the computer's own key.
            let sent = folder.join("held-root.sent");
            write_sent(&sent, &root, &ids[0]).unwrap();
            open_sent_key(&std::fs::read(&sent).unwrap(), &key, &context).unwrap()
        });
        let copies = Arc::new(copies.with_secrets_key(Arc::new(key), folder.clone(), held));
        net.0
            .lock()
            .unwrap()
            .insert(ids[at].clone(), copies.clone());
        computers.push(copies);
    }
    let (a, b, c) = (
        computers[0].clone(),
        computers[1].clone(),
        computers[2].clone(),
    );
    let write = |copies: &Copies, id: &str| {
        copies
            .write(|store| {
                store.mutate_local_with_check(
                    OWNER,
                    RESOURCE,
                    Mutation {
                        id: id.to_owned(),
                        expected_version: 0,
                        request_key: format!("write-{id}"),
                        deleted: false,
                        value: json!({"text": id}),
                    },
                    || Ok(()),
                )
            })
            .map(|_| ())
    };

    // A claims the writer turn and writes; B and C follow it.
    a.tick();
    assert!(
        a.holding().is_some(),
        "A claims the writer turn with every voter up"
    );
    b.tick();
    c.tick();
    write(&a, "before-release").expect("acknowledged");
    b.tick();
    assert!(
        b.read(RESOURCE, "before-release").unwrap().record.is_some(),
        "B holds the write"
    );

    // A hands over for its release while a reader asks B again and again.
    let reading = Arc::new(AtomicBool::new(true));
    let (answered, missed) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (read, observed) = std::sync::mpsc::channel();
    let reader = {
        let (b, reading, answered, missed) =
            (b.clone(), reading.clone(), answered.clone(), missed.clone());
        std::thread::spawn(move || {
            while reading.load(Ordering::Acquire) {
                match b.read(RESOURCE, "before-release") {
                    Ok(read) if read.record.is_some() => answered.fetch_add(1, Ordering::AcqRel),
                    _ => missed.fetch_add(1, Ordering::AcqRel),
                };
                let _ = read.send(());
            }
        })
    };
    observed.recv_timeout(Duration::from_millis(50)).expect("the reader answered during this handover phase");
    while observed.try_recv().is_ok() {}
    let handed = trillion_local::native_entry::computer::releases::hand_over_all(&[
        a.clone(),
        b.clone(),
        c.clone(),
    ]);
    assert_eq!(handed, 1, "only A held a writer turn");
    assert_eq!(a.holding(), None, "A writes no more");
    observed.recv_timeout(Duration::from_millis(50)).expect("the reader answered after the writer handed over");
    // Another computer takes the writer turn once its claim is due, long before A's term would have run out.
    let mut waited = 0;
    while b.holding().is_none() && c.holding().is_none() {
        assert!(
            waited < term_ms,
            "nobody took the writer turn before A's term would have run out"
        );
        clock.fetch_add(renew_every_ms, Ordering::AcqRel);
        waited += renew_every_ms;
        b.tick();
        c.tick();
    }
    reading.store(false, Ordering::Release);
    reader.join().unwrap();
    assert_eq!(
        missed.load(Ordering::Acquire),
        0,
        "B answered every read during the handover"
    );
    assert!(answered.load(Ordering::Acquire) > 0);
    let writer = if b.holding().is_some() { &b } else { &c };
    write(writer, "after-release").expect("the new writer's write is acknowledged");
    assert!(a.read(RESOURCE, "before-release").unwrap().record.is_some());
}

/// The account's copy rule is its own list rows, made with it from the computer's `new_accounts` and reached through its
/// routes by the forwarder (src/account/computers/copy_rule.rs): an account on one computer is short, so its rule starts the
/// workflow that adds the first offered computer with room; removing that computer from the computers list would leave
/// fewer keepers than the rule asks and is refused, unless the same edit lowers the rule.
#[test]
fn an_accounts_copy_rule_adds_an_offered_computer_and_refuses_an_edit_below_it_unless_the_edit_lowers_it(
) {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let computer_key = shared_computer_key();
    let config_path = computer_config(&dir.path().join("copies"), &computer_key);
    let (_, address) = create(&config_path);
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    let _door = computer.app();
    let key = sign_in_token(&address);
    let forwarder = start_forwarder();
    let executor = two_threads();
    connect(&computer, &address, forwarder.sessions);
    let me = computer.computer_id();
    let other = "b".repeat(64);
    let mut id = 40;
    let mut call = |operation: &str, input: Value| {
        id += 1;
        let (status, answer) = call_when_up(
            &executor,
            &forwarder.http,
            &key,
            &tool(id, "@sign-in", operation, &format!("copies-{id}"), input),
        );
        assert_eq!(status, StatusCode::OK, "{answer}");
        answer
    };

    // Made with the account: the copies row and the copy rules row, revision 1 each; one computer is three short.
    let shown = answered(StatusCode::OK, &call("sign-in:copies", json!({})));
    assert_eq!(shown["copies"]["revision"], 1, "{shown}");
    assert_eq!(shown["copies"]["settings"], starting("copies"), "{shown}");
    assert_eq!(shown["rules"]["settings"], starting("copies_rules"));
    assert_eq!(shown["computed"]["short_by"], 3, "{shown}");
    let list = answered(StatusCode::OK, &call("sign-in:computers-list", json!({})));
    assert_eq!(list["rows"].as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list["rows"][0]["computer"], me.as_str());

    // The offered computer answers for the account, so the door gives it its host kind first.
    answered(StatusCode::OK, &call("sign-in:set-host-kind", host_kind_input(&other, "my-device")));
    // A computer offered with room: the rule's workflow adds it, and waits for it to catch up before it votes.
    let offered = answered(
        StatusCode::OK,
        &call(
            "sign-in:set-offered-computers",
            json!({"expected_revision": 0, "computers": [{"computer": other, "has_room": true}]}),
        ),
    );
    assert_eq!(
        offered["copy_rule"]["runs"][0]["added"],
        other.as_str(),
        "{offered}"
    );
    assert_eq!(
        offered["copy_rule"]["runs"][0]["blocked"], "waiting_for_caught_up",
        "{offered}"
    );
    let (status, answer) = call_when_up(&executor, &forwarder.http, &key, &read_computers());
    let mut holders = vec![me.clone(), other.clone()];
    holders.sort();
    assert_eq!(
        answered(status, &answer)["places"]["holders"],
        json!(holders),
        "{answer}"
    );

    // Removing it again leaves one keeper of the rule's three: refused.
    let remove = json!({"row": {"computer": other, "keeps_copy": false}});
    let refused = call("sign-in:set-computers-list-row", remove.clone());
    assert!(
        refused.to_string().contains("computers_below_copy_rule"),
        "{refused}"
    );
    // The same edit lowers the rule to one: kept, and the run that added it ends.
    let mut lowering = remove;
    lowering["copies"] = json!({"expected_revision": 1, "settings": {"least_copy_keepers": 1, "least_voters": 0, "least_may_answer": 1, "least_always_on": 0}});
    let removed = answered(
        StatusCode::OK,
        &call("sign-in:set-computers-list-row", lowering),
    );
    assert_eq!(removed["places"]["holders"], json!([me]), "{removed}");
    assert_eq!(removed["copies"]["revision"], 2);
    assert_eq!(removed["copy_rule"]["short_by"], 0, "{removed}");
    let shown = answered(StatusCode::OK, &call("sign-in:copies", json!({})));
    assert_eq!(shown["runs"][0]["state"], "ended", "{shown}");
    assert_eq!(
        shown["runs"][0]["blocked"], "added_computer_removed",
        "{shown}"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Every account is kept by several computers by default (2026-11-03): three computers, each its own process (a process
// opens secrets keys one way, so three full computers cannot share one), behind one forwarder over verified TLS.

/// One computer of the three: its folder, config, id, listener port and process.
struct Peer {
    dir: PathBuf,
    config: PathBuf,
    id: String,
    port: u16,
    process: Option<std::process::Child>,
    clock: Arc<test_time::FakeClock>,
    control: Option<Arc<std::sync::Mutex<TcpStream>>>,
    logs_done: Vec<std::sync::mpsc::Receiver<()>>,
    /// The computer runs on the real clock, not the test's virtual one (see `on_real_clock`).
    real_clock: bool,
}

impl Peer {
    /// A computer folder with its own key (`byte`), listening on a free port, opening its session to the forwarder at
    /// `forwarder` (`host:port`).
    fn new(root: &Path, name: &str, byte: u8, forwarder: &str) -> Self {
        let dir = root.join(name);
        let key = dir.join("computer.key");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &key,
            base64::engine::general_purpose::STANDARD.encode([byte; 32]),
        )
        .unwrap();
        let config = computer_config(&dir, &key);
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let id = ComputerSigner::of(&ComputerKey::read(&key).unwrap())
            .unwrap()
            .computer_id();
        let peer = Self {
            dir,
            config,
            id,
            port,
            process: None,
            clock: clock(),
            control: None,
            logs_done: Vec::new(),
            real_clock: false,
        };
        peer.set("listen", json!(format!("127.0.0.1:{port}")));
        peer.set("router", json!(forwarder));
        peer
    }

    /// Run this computer on the real clock. Its retries and waits are then real time, as in production, while the test
    /// clock still moves the test's own calls; for a test where a separate command line process (its own real time
    /// wait) must reach this computer while it runs.
    fn on_real_clock(mut self) -> Self {
        self.real_clock = true;
        self
    }

    fn set(&self, field: &str, value: Value) {
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(&self.config).unwrap()).unwrap();
        config[field] = value;
        fs::write(&self.config, config.to_string()).unwrap();
    }

    /// Start the computer as its own process (`trillion-local serve`), trusting the test's TLS root; its log is its
    /// folder's `computer.log`.
    fn start(&mut self, trust: &Path) {
        let log = Arc::new(std::sync::Mutex::new(fs::File::create(self.dir.join("computer.log")).unwrap()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "virtual_computer_process", "--nocapture"])
            .env("FORWARDER_TEST_CONFIG", &self.config)
            .env("FORWARDER_TEST_CLOCK", listener.local_addr().unwrap().to_string())
            .envs(self.real_clock.then_some(("FORWARDER_TEST_REAL_CLOCK", "1")))
            .env("SSL_CERT_FILE", trust)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn().unwrap();
        fn follow(reader: impl std::io::Read + Send + 'static, log: Arc<std::sync::Mutex<fs::File>>, clock: Arc<test_time::FakeClock>) -> std::sync::mpsc::Receiver<()> {
            let (done, completed) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                use std::io::{BufRead, Write};
                for line in std::io::BufReader::new(reader).lines().map_while(Result::ok) {
                    writeln!(log.lock().unwrap(), "{line}").unwrap();
                    clock.changed();
                }
                clock.changed();
                let _ = done.send(());
            });
            completed
        }
        self.logs_done.push(follow(child.stdout.take().unwrap(), log.clone(), self.clock.clone()));
        self.logs_done.push(follow(child.stderr.take().unwrap(), log, self.clock.clone()));
        if !self.real_clock {
            self.control = Some(self.clock.connect(listener));
        }
        self.process = Some(child);
        let deadline = Instant::now() + Duration::from_secs(60);
        while TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            assert!(
                Instant::now() < deadline,
                "computer {} did not listen: {}",
                self.id,
                self.log()
            );
            self.clock.progress(deadline, Duration::from_millis(50));
        }
    }

    /// Send the computer SIGTERM (its service manager stopping it) and do not wait: `stop` reaps it later.
    fn ask_to_stop(&self) {
        if let Some(child) = &self.process {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            if let Some(control) = &self.control { test_time::wake_peer(control); }
        }
    }

    /// Stop the computer: SIGKILL (`hard`, as a computer that dies) or SIGTERM, and wait for it.
    fn stop(&mut self, hard: bool) {
        if let Some(mut child) = self.process.take() {
            unsafe {
                libc::kill(
                    child.id() as i32,
                    if hard { libc::SIGKILL } else { libc::SIGTERM },
                )
            };
            if hard {
                child.wait().unwrap();
            } else {
                if let Some(control) = &self.control { test_time::wake_peer(control); }
                self.clock.drive(|| child.wait(), Duration::from_secs(30), false).unwrap();
            }
            for completed in self.logs_done.drain(..) { completed.recv_timeout(Duration::from_secs(30)).expect("the stopped computer's output was recorded"); }
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("computer.log")).unwrap_or_default()
    }

    /// The folder of the account `owner` at this computer: it is named by the owner id only once it is whole.
    fn keeps(&self, owner: &str) -> bool {
        self.dir.join("accounts").join(owner).is_dir()
    }

    fn account(&self, owner: &str) -> PathBuf {
        self.dir.join("accounts").join(owner)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stop(true);
    }
}

/// One HTTP/1.1 POST to a computer's own listener at `port` with a bearer credential: its status and JSON body.
fn http_bearer(port: u16, path: &str, bearer: &str, body: &Value) -> (u16, Value) {
    clock().drive(|| {
    use std::io::{Read as _, Write as _};
    let body = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    timeouts(&stream);
    write!(stream, "POST {path} HTTP/1.1\r\nHost: computer.test\r\nAuthorization: Bearer {bearer}\r\nContent-Type: application/json\r\n\
        Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    let status = answer
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let text = answer
        .split_once("\r\n\r\n")
        .map(|(_, rest)| rest)
        .unwrap_or("");
    let start = text.find('{').unwrap_or(0);
    let end = text.rfind('}').map_or(text.len(), |at| at + 1);
    (
        status,
        serde_json::from_str(&text[start..end]).unwrap_or(Value::Null),
    )
    }, Duration::from_secs(30), false)
}

/// One HTTP/1.1 request to a computer's own listener at `port`: its status and body.
fn http(port: u16, method: &str, path: &str, origin: &str, body: &Value) -> (u16, Value) {
    clock().drive(|| {
    use std::io::{Read as _, Write as _};
    let body = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    timeouts(&stream);
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: computer.test\r\nOrigin: {origin}\r\nContent-Type: application/json\r\n\
        Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let text = answer
        .split_once("\r\n\r\n")
        .map(|(_, rest)| rest)
        .unwrap_or("");
    // A chunked body is one JSON value between the chunk lines.
    let start = text.find('{').unwrap_or(0);
    let end = text.rfind('}').map_or(text.len(), |at| at + 1);
    (
        status,
        serde_json::from_str(&text[start..end]).unwrap_or(Value::Null),
    )
    }, Duration::from_secs(30), false)
}

fn tool_ok(status: StatusCode, answer: &Value) -> bool {
    status == StatusCode::OK
        && answer["result"]["isError"] != json!(true)
        && !answer["result"]["structuredContent"].is_null()
}

/// The own records a computer's records store has, read from its file after the computer stopped: how many, and the
/// BLAKE3 of their ids, versions and stamps in id order (what a computer that only keeps a copy keeps plain; its values
/// are sealed), leaving out the record `leave_out`.
fn records_census(folder: &Path, leave_out: Option<&str>) -> (u64, String) {
    let db = rusqlite::Connection::open_with_flags(
        folder.join("records.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = db.prepare(
        "SELECT id, version, valid_from FROM versions WHERE resource = 'own-records' AND id LIKE 'spread-note-%' \
         AND valid_to IS 9223372036854775807 ORDER BY id, version").unwrap();
    let rows: Vec<(String, i64, i64)> = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .filter(|(id, _, _)| Some(id.as_str()) != leave_out)
        .collect();
    let mut hasher = content_crypto::advanced::blake3::Hasher::new();
    for (id, version, stamp) in &rows {
        hasher.update(format!("{id}\n{version}\n{stamp}\n").as_bytes());
    }
    (rows.len() as u64, hasher.finalize().to_hex().to_string())
}

/// the person, 2026-11-03: one deleted folder took a whole account down. Sign-up at A, whose config names three default
/// computers (A, B and C keep copies and vote; A and B may answer): B and C join the new account by themselves, with no
/// `computer take-copy` and no `computer join`; a write through the forwarder is acknowledged once they caught up; A is
/// killed; reads and writes still answer through the forwarder (B); and the computers that joined match the writer by
/// count and identity. #63's gaps, each of which this test failed on before (J2 finish):
/// - the account's policy holds a 60 KB row before B and C join: the holding answer carried the account stores in one
///   message and was refused; now they come through the writer's feed as records, and the holding answer goes in parts;
/// - a policy row A writes after B joined reaches B's own policy store (before: never);
/// - the only key is issued with the sign-in command line at A, which tells A, so it travels as an acknowledged change
///   and answers at B after A died (before: refused at B);
/// - B has no tools of its own (offline, no install): it takes A's copy, file for file; and once it serves the account
///   and loses them, it takes A's copy again at its next start.
/// Incident 21: a computer that the account's row names, but that does not hold the account yet, answers a request on its own
/// listener that carries another of the account's computers' message proof (`trp_`) with a retry (`not_answering_yet`), not a
/// 404 or a 401, and joins the account by itself, with no hand step. A proof for an account no computer holds (no computer can
/// show B is named in its row) still gets 401.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_computer_named_for_an_account_it_does_not_hold_joins_it_on_a_proven_http_request() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone()).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));

    let mut a = Peer::new(dir.path(), "a", 61, forwarder_host);
    let mut b = Peer::new(dir.path(), "b", 62, forwarder_host);
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone()],
        may_answer: vec![a.id.clone(), b.id.clone()],
        voters: vec![a.id.clone(), b.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(41).registration(&challenge, "Spread"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    b.start(&trust);
    assert!(!b.keeps(&owner), "B joined before the request, so the request proves nothing: {}", b.log());

    // A's own message proof for the account, sent to B's listener on the account's path.
    let a_signer = ComputerSigner::of(&ComputerKey::read(&a.dir.join("computer.key")).unwrap()).unwrap();
    let proof = a_signer.message_credential(&address, now_ms());
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    let (status, answer) = http_bearer(b.port, &format!("/a/{address}/mcp"), &proof, &body);
    assert_eq!(status, 503, "B is named for the account and answers a retry: {answer}\nB: {}", b.log());
    assert_eq!(answer["error"], "not_answering_yet", "{answer}");

    let deadline = Instant::now() + Duration::from_secs(60);
    while !b.keeps(&owner) {
        assert!(Instant::now() < deadline, "B did not join the account by the proven request\nB: {}", b.log());
        clock().progress(deadline, Duration::from_millis(200));
    }

    // Nobody holds this account, so no computer can show B is named in its row: 401.
    let stranger = "e".repeat(64);
    let stranger_proof = a_signer.message_credential(&stranger, now_ms());
    let (status, answer) = http_bearer(b.port, &format!("/a/{stranger}/mcp"), &stranger_proof, &body);
    assert_eq!(status, 401, "{answer}\nB: {}", b.log());
}

#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_new_account_is_held_by_its_default_computers_by_themselves_and_answers_after_its_first_computer_dies(
) {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    // One MCP call through the forwarder, sent again until `done` says its answer is the one waited for, or `seconds` pass.
    let call_until =
        |key: &str, body: &Value, seconds: u64, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(200));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 61, forwarder_host).on_real_clock();
    let mut b = Peer::new(dir.path(), "b", 62, forwarder_host).on_real_clock();
    let mut c = Peer::new(dir.path(), "c", 63, forwarder_host).on_real_clock();
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        may_answer: vec![a.id.clone(), b.id.clone()],
        voters: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);

    // Sign-up at A's own listener.
    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(31).registration(&challenge, "Spread"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    // The account's policy holds more than one message between computers carries (a rights row of 60 KB): before, the
    // holding answer carried the account stores in one message, and B was refused (`holding_unavailable`).
    let policy_at = |peer: &Peer| {
        let db = rusqlite::Connection::open(peer.account(&owner).join("policy.sqlite")).unwrap();
        db.busy_timeout(Duration::from_secs(10)).unwrap();
        db
    };
    policy_at(&a)
        .execute(
            "INSERT INTO policy_directory VALUES('rights:large', ?)",
            [json!("L".repeat(60_000)).to_string()],
        )
        .unwrap();
    // Each computer that may answer installs the account's tools at its first start (from the network); offline here, A
    // has the fixture tools and B takes A's copy (`Message::Tools`), with no install of its own.
    installed_tools::install(&a.account(&owner));
    b.start(&trust);
    c.start(&trust);

    // B and C join it by themselves: no take-copy, no join.
    let deadline = Instant::now() + Duration::from_secs(60);
    while !(b.keeps(&owner) && c.keeps(&owner)) {
        assert!(
            Instant::now() < deadline,
            "B and C did not join the account\nA: {}\nB: {}\nC: {}",
            a.log(),
            b.log(),
            c.log()
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    assert!(
        !c.account(&owner).join("policy.sqlite").exists(),
        "C only keeps a copy: no account stores"
    );

    // A key issued with the sign-in command line at A (another process, writing A's sign-in rows directly): it tells A,
    // which makes it one acknowledged sign-in change, so B holds it before the command answers. Before, it was logged
    // only on a later writer step, and refused at B once A died.
    // The command runs as its own process, as production runs it: it tells the serving computer process by SIGUSR1, and that
    // process copies the change on its real clock, so the command's own wait is real time too.
    let output = Command::new(env!("CARGO_BIN_EXE_trillion-local"))
        .args(["sign-in", "issue-key", a.account(&owner).to_str().unwrap(), "end-to-end", "records", "sign-in"])
        .output()
        .unwrap();
    let issued = format!(
        "{}\nSTDERR: {}",
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8_lossy(&output.stderr)
    );
    let key = issued.lines().next().unwrap().trim().to_owned();
    assert!(key.starts_with(&format!("nm_{address}_")), "{issued}");
    assert!(
        issued.contains("copied to the account's other computers"),
        "the command line's key was not copied: {issued}\nA: {}\nB: {}",
        a.log(),
        b.log()
    );
    let write = |n: u32| {
        tool(
            40 + u64::from(n),
            "@own-records",
            "records:write",
            &format!("spread-write-{n}"),
            json!({"records": [{"id": format!("spread-note-{n}"), "type": "note", "value": {"words": format!("SPREAD_{n}")}}]}),
        )
    };
    let read = |n: u32, request: &str| {
        tool(
            80 + u64::from(n),
            "@own-records",
            "records:read",
            request,
            json!({"id": format!("spread-note-{n}")}),
        )
    };
    let words = |n: u32| {
        move |status: StatusCode, answer: &Value| {
            tool_ok(status, answer)
                && answer["result"]["structuredContent"]["value"]["words"]
                    == format!("SPREAD_{n}").as_str()
        }
    };

    // The first write is acknowledged once B and C caught up.
    let (status, answer) = call_until(&key, &write(1), 120, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "the first write was not acknowledged: {answer}\nA: {}\nB: {}\nC: {}",
        a.log(),
        b.log(),
        c.log()
    );
    for n in 2..=5 {
        let (status, answer) = call_until(&key, &write(n), 60, &tool_ok);
        assert!(tool_ok(status, &answer), "{answer}");
    }
    // B opens its account routes (it may answer), C never does.
    let deadline = Instant::now() + Duration::from_secs(60);
    while !b.log().contains("event=door-composed") {
        assert!(
            Instant::now() < deadline,
            "B did not open the account's routes: {}",
            b.log()
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    assert!(
        !c.log().contains("event=door-composed"),
        "C only keeps a copy"
    );
    // B took A's tools (no install of its own), file for file.
    let tool_rows = "workshop/tools/kept-records/tool-rows.json";
    assert_eq!(
        fs::read(b.account(&owner).join(tool_rows)).ok(),
        fs::read(a.account(&owner).join(tool_rows)).ok(),
        "B has A's tools: {}",
        b.log()
    );
    // The account stores are at B from the writer's feed: the large row, and a change A makes later.
    let row_at = |peer: &Peer, name: &str| {
        policy_at(peer)
            .query_row(
                "SELECT value FROM policy_directory WHERE name=?",
                [name],
                |row| row.get::<_, String>(0),
            )
            .ok()
    };
    // The stores fill page by page as B's copy follows the feed (calls reach B only once it caught up).
    let deadline = Instant::now() + Duration::from_secs(60);
    while row_at(&b, "rights:large") != row_at(&a, "rights:large") {
        assert!(
            Instant::now() < deadline,
            "B never had A's large policy row\nA: {}\nB: {}",
            a.log(),
            b.log()
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    policy_at(&a)
        .execute(
            "INSERT INTO policy_directory VALUES('rights:later', '\"LATER\"')",
            [],
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        // Any request at the writer sends its changed stores as records.
        let _ = call_until(&key, &read(1, "spread-read-stores"), 10, &words(1));
        if row_at(&b, "rights:later").as_deref() == Some("\"LATER\"") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "A's later policy change never reached B\nA: {}\nB: {}",
            a.log(),
            b.log()
        );
        clock().progress(deadline, Duration::from_millis(200));
    }
    assert!(
        !c.account(&owner).join("policy.sqlite").exists(),
        "C only keeps a copy: still no account stores"
    );
    // B already serves the account and loses its tools (not a join): at its next start, still offline, it takes A's
    // copy again. Before, only a joining computer asked; B started with no tools.
    b.stop(false);
    for name in ["workshop", "workshop-installs"] {
        let path = b.account(&owner).join(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => fs::remove_file(&path).unwrap(),
            Ok(_) => fs::remove_dir_all(&path).unwrap(),
            Err(_) => {}
        }
    }
    assert!(
        fs::read(b.account(&owner).join(tool_rows)).is_err(),
        "B's tools are gone"
    );
    b.start(&trust);
    let deadline = Instant::now() + Duration::from_secs(60);
    while fs::read(b.account(&owner).join(tool_rows)).ok()
        != fs::read(a.account(&owner).join(tool_rows)).ok()
    {
        assert!(
            Instant::now() < deadline,
            "B, which serves the account, did not take A's tools again: {}",
            b.log()
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    let (status, answer) = call_until(&key, &read(1, "spread-read-before"), 60, &words(1));
    assert!(words(1)(status, &answer), "{answer}");
    let at_a = records_census(&a.account(&owner), None);

    // A dies. Reads and writes still answer through the forwarder.
    a.stop(true);
    let (status, answer) = call_until(&key, &read(1, "spread-read-after"), 120, &words(1));
    assert!(
        words(1)(status, &answer),
        "no read after A died: {answer}\nB: {}\nC: {}",
        b.log(),
        c.log()
    );
    let (status, answer) = call_until(&key, &write(6), 120, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no write after A died: {answer}\nB: {}\nC: {}",
        b.log(),
        c.log()
    );
    let (status, answer) = call_until(&key, &read(6, "spread-read-6"), 60, &words(6));
    assert!(words(6)(status, &answer), "{answer}");

    // The joined computers match the writer by count and identity: the five records A wrote, at B and at C.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        b.stop(false);
        c.stop(false);
        let at_b = records_census(&b.account(&owner), None);
        let at_c = records_census(&c.account(&owner), None);
        if (at_b.0, at_c.0) == (6, 6) || Instant::now() > deadline {
            assert_eq!(at_a.0, 5, "A had the five records it wrote");
            assert_eq!(at_b.0, 6, "B has A's five and the write after");
            assert_eq!(at_b, at_c, "C matches B by count and identity");
            let six = Some("spread-note-6");
            assert_eq!(
                records_census(&b.account(&owner), six),
                at_a,
                "B matches the writer A by count and identity"
            );
            assert_eq!(
                records_census(&c.account(&owner), six),
                at_a,
                "C matches the writer A by count and identity"
            );
            break;
        }
        b.start(&trust);
        c.start(&trust);
        clock().progress(deadline, Duration::from_millis(2000));
    }
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// Where an account is kept and how many copies, as list rows that act by themselves (cloud job J3, finished): three
/// full computers behind one forwarder over verified TLS. The account is made at A with B as its second keeper and voter;
/// its copies row asks one keeper and two voters. Every computer posts its own report to the forwarder and hears the
/// others' (C reports it takes new accounts; B does not). The owner removes B from the computers list (not refused: one
/// keeper is still the rule's least). With no other hand step: the rule fires, its workflow adds C (offered from C's own
/// report, never by hand), A tells C at once and C joins by itself, C catches up and reports so, and the voter step makes
/// C a voter as soon as it does (not at the next sweep). The computers list then reads C's `always_on` and `last_seen`
/// from C's own report.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn removing_a_computer_makes_the_accounts_rule_add_a_reported_computer_that_catches_up_and_votes_with_no_hand_step(
) {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, seconds: u64, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                let size = answer.to_string().len();
                if size > 100_000 {
                    eprintln!(
                        "rule-poll big status={status} bytes={size} head={}",
                        &answer.to_string()[..600]
                    );
                }
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(250));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 71, forwarder_host).on_real_clock();
    let mut b = Peer::new(dir.path(), "b", 72, forwarder_host).on_real_clock();
    let mut c = Peer::new(dir.path(), "c", 73, forwarder_host).on_real_clock();
    let config = |peer: &Peer| -> Value {
        serde_json::from_str(&fs::read_to_string(&peer.config).unwrap()).unwrap()
    };
    // B does not take new accounts, so it is never offered back; C does, and reports it is not always on.
    let mut report = config(&b)["report"].clone();
    report["takes_new_accounts"] = json!(false);
    b.set("report", report.clone());
    report["takes_new_accounts"] = json!(true);
    report["always_on"] = json!(false);
    c.set("report", report);
    // The account asks one computer that keeps a copy and two voters.
    let mut new_accounts = config(&a)["new_accounts"].clone();
    new_accounts["copies"] = json!({"least_copy_keepers": 1, "least_voters": 2, "least_may_answer": 1, "least_always_on": 0});
    a.set("new_accounts", new_accounts);
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone()],
        may_answer: vec![a.id.clone()],
        voters: vec![a.id.clone(), b.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    c.start(&trust);
    let logs =
        |a: &Peer, b: &Peer, c: &Peer| format!("\nA: {}\nB: {}\nC: {}", a.log(), b.log(), c.log());

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(41).registration(&challenge, "Rule"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !b.keeps(&owner) {
        assert!(
            Instant::now() < deadline,
            "B did not join the account{}",
            logs(&a, &b, &c)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }

    let key = sign_in_token(&address);
    let mut id = 500;
    let mut call = |operation: &str, input: Value, seconds: u64, done: &dyn Fn(&Value) -> bool| {
        id += 1;
        let body = tool(id, "@sign-in", operation, &format!("rule-{id}"), input);
        let (status, answer) = call_until(&key, &body, seconds, &|status, answer| {
            tool_ok(status, answer) && done(&answer["result"]["structuredContent"])
        });
        eprintln!(
            "rule-call {operation} status={status} bytes={}",
            answer.to_string().len()
        );
        assert!(tool_ok(status, &answer), "{operation}: {answer}");
        answer["result"]["structuredContent"].clone()
    };
    let shown = call("sign-in:copies", json!({}), 120, &|shown| {
        shown["computed"]["short_by"] == 0
    });
    assert_eq!(
        shown["computed"]["short_by"], 0,
        "A and B meet the rule: {shown}"
    );
    assert_eq!(shown["copies"]["settings"]["least_always_on"], 0);

    // The owner offers C as a my-device before B goes, so the copy rule adds C as answering. An offer that names no kind
    // is written as rented-host (sync and vote only) the moment the rule adds it, and that kind then stays.
    let offers = call("sign-in:copies", json!({}), 60, &|_| true);
    let mut computers: Vec<Value> = offers["offered"]["settings"].as_array().cloned().unwrap_or_default();
    computers.retain(|offer| offer["computer"] != c.id.as_str());
    computers.push(json!({"computer": c.id, "kind": "my-device", "has_room": true, "always_on": false}));
    call(
        "sign-in:set-offered-computers",
        json!({"expected_revision": offers["offered"]["revision"].as_u64().unwrap_or(0), "computers": computers}),
        60,
        &|_| true,
    );

    // The owner removes B. Not refused: one keeper is still the rule's least.
    let removed = call(
        "sign-in:set-computers-list-row",
        json!({"row": {"computer": b.id, "keeps_copy": false}}),
        120,
        &|_| true,
    );
    assert_eq!(removed["places"]["holders"], json!([a.id]), "{removed}");
    let started = Instant::now();
    // No hand step from here: C is offered from its own report, added, joins, catches up and votes.
    let list = call("sign-in:computers-list", json!({}), 300, &|list| {
        list["rows"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["computer"] == c.id.as_str() && row["votes"] == true)
        })
    });
    let rows = list["rows"].as_array().unwrap();
    let at_c = rows
        .iter()
        .find(|row| row["computer"] == c.id.as_str())
        .unwrap_or_else(|| panic!("C was never added: {list}{}", logs(&a, &b, &c)));
    assert_eq!(
        at_c["votes"],
        true,
        "C never voted: {list}{}",
        logs(&a, &b, &c)
    );
    let took = started.elapsed();
    assert_eq!(at_c["keeps_copy"], true);
    assert_eq!(at_c["may_answer"], true);
    assert_eq!(at_c["caught_up"], true, "{list}");
    assert_eq!(at_c["always_on"], false, "C's own report: {list}");
    assert!(
        at_c["last_seen"].as_u64().is_some_and(|seen| seen > 0),
        "C's own report: {list}"
    );
    assert!(c.keeps(&owner), "C joined by itself");
    assert!(
        rows.iter().all(|row| row["computer"] != b.id.as_str()),
        "B stays removed: {list}"
    );
    let finished_run = |shown: &Value| {
        shown["runs"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|run| run["state"] == "finished"))
    };
    let shown = call("sign-in:copies", json!({}), 120, &finished_run);
    assert_eq!(shown["computed"]["short_by"], 0, "{shown}");
    assert_eq!(
        shown["offered"]["settings"],
        json!([{"computer": c.id, "has_room": true, "always_on": false, "kind": "my-device"}]),
        "C's report fills its offer and the kind the owner named is kept: {shown}"
    );
    let finished = shown["runs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|run| run["state"] == "finished")
        .count();
    assert_eq!(finished, 1, "{shown}");
    // The voter step ran on C's caught-up report, not at the hourly sweep.
    assert!(a.log().contains("why=caught-up"), "{}", a.log());
    eprintln!("measured: remove B -> C votes in {} ms", took.as_millis());
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// Cloud job J5 (the person, 2026-11-03: one deleted folder took his whole account down). Measured on three full computers
/// that day, an account named at three computers was not answered once its writer was killed. Here the same, as
/// full computers (each its own `trillion-local serve` process) behind one forwarder over verified TLS:
/// - an account is made at A (sign-up at A's own listener, no default computers: one computer, no voters);
/// - a row with several may-answer computers and no voters is refused (`computers_no_writer_row`: two writers);
/// - B and C are named in the documented order (docs/placement-decision, stage 3 notes): A alone is the first voter (a `set` naming
///   three voters from none names A alone, and A's copies start at once), B and C are added as computers that may
///   answer and join by themselves, then each is made a voter by its own edit, refused `computers_voter_behind` until
///   it has caught up and says so itself (its joining marker gone);
/// - writes are acknowledged; A, the writer, is killed with SIGKILL; reads and acknowledged writes through the
///   forwarder resume within the takeover (the term, the clock margin, two renewal steps and one message wait) and no
///   acknowledged write is lost;
/// - the account is left idle past `idle_release_ms` (its writer turn is given up, nobody holds a term) and the next
///   read, sign-in change and write are answered.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn three_full_computers_answer_one_account_through_a_writer_kill_and_after_it_goes_idle() {
    let numbers: Value =
        serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
    let number = |name: &str| numbers[name].as_u64().unwrap();
    let takeover = Duration::from_millis(
        number("term_ms")
            + number("clock_margin_ms")
            + 2 * number("renew_every_ms")
            + number("message_wait_ms"),
    );
    let entry: Value =
        serde_json::from_str(include_str!("../src/native_entry/computer/settings.json")).unwrap();
    let idle = Duration::from_millis(
        number("idle_release_ms") + number("term_ms") + 2 * number("clock_margin_ms"),
    );

    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, wait: Duration, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + wait;
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(200));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 71, forwarder_host);
    let mut b = Peer::new(dir.path(), "b", 72, forwarder_host);
    let mut c = Peer::new(dir.path(), "c", 73, forwarder_host);
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    c.start(&trust);
    let logs =
        |a: &Peer, b: &Peer, c: &Peer| format!("\nA: {}\nB: {}\nC: {}", a.log(), b.log(), c.log());

    // The account is made at A, alone.
    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(41).registration(&challenge, "Kept"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    let key = sign_in_token(&address);

    let mut id = 500;
    let mut edit_row = |input: Value| {
        id += 1;
        tool(
            id,
            "@sign-in",
            "sign-in:set-places",
            &format!("j5-places-{id}"),
            input,
        )
    };
    let refused_with = |code: &'static str| {
        move |status: StatusCode, answer: &Value| {
            status == StatusCode::OK && answer.to_string().contains(code)
        }
    };
    let (ids, all) = (
        |peer: &Peer| peer.id.clone(),
        |list: &[&Peer]| list.iter().map(|peer| peer.id.clone()).collect::<Vec<_>>(),
    );

    // B and C answer for the account, so the door gives each its host kind before the rule sees them.
    for (peer, n) in [(&b, 1), (&c, 2)] {
        let kind = set_host_kind(900 + n, &ids(peer), "my-device");
        let (status, answer) = call_until(&key, &kind, Duration::from_secs(60), &tool_ok);
        assert!(tool_ok(status, &answer), "computer {n}'s host kind was not set: {answer}");
    }
    // Several may-answer computers and no voters: two writers. Refused.
    let two_writers = edit_row(
        json!({"op": "set", "keeps_copy": all(&[&a, &b, &c]), "may_answer": all(&[&a, &b, &c]), "voters": []}),
    );
    let (status, answer) = call_until(
        &key,
        &two_writers,
        Duration::from_secs(30),
        &|status, answer| status != StatusCode::SERVICE_UNAVAILABLE && answer != &Value::Null,
    );
    assert!(
        refused_with("computers_no_writer_row")(status, &answer),
        "{answer}{}",
        logs(&a, &b, &c)
    );

    // Three voters named at once from none: A alone is the first voter, and its copies start at once.
    let first = edit_row(
        json!({"op": "set", "keeps_copy": [ids(&a)], "may_answer": [ids(&a)], "voters": all(&[&a, &b, &c])}),
    );
    let (status, answer) = call_until(&key, &first, Duration::from_secs(30), &tool_ok);
    assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b, &c));
    let row = answer["result"]["structuredContent"]
        .as_object()
        .unwrap()
        .values()
        .find(|value| value.get("voters").is_some())
        .unwrap();
    assert_eq!(row["voters"], json!([ids(&a)]), "{answer}");

    // B and C may answer: each joins by itself, and becomes a voter only once it says it caught up.
    for (peer, n) in [(&b, 1), (&c, 2)] {
        let add =
            edit_row(json!({"op": "add-computer", "computer": ids(peer), "may_answer": true}));
        let (status, answer) = call_until(&key, &add, Duration::from_secs(60), &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "computer {n} was not added: {answer}{}",
            logs(&a, &b, &c)
        );
        let vote = edit_row(
            json!({"op": "add-computer", "computer": ids(peer), "may_answer": true, "voter": true}),
        );
        let (status, answer) = call_until(&key, &vote, Duration::from_secs(120), &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "computer {n} never became a voter: {answer}{}",
            logs(&a, &b, &c)
        );
        let joining = peer
            .account(&owner)
            .join(entry["joining_marker"].as_str().unwrap());
        assert!(
            !joining.exists(),
            "a voter step is made only once the new voter's joining marker is gone"
        );
    }
    let mut voters = all(&[&a, &b, &c]);
    voters.sort();
    let (status, answer) = call_until(&key, &read_computers(), Duration::from_secs(30), &tool_ok);
    assert_eq!(
        answered(status, &answer)["places"]["voters"],
        json!(voters),
        "{answer}"
    );
    installed_tools::install(&b.account(&owner));
    installed_tools::install(&c.account(&owner));

    let write = |n: u32| {
        tool(
            600 + u64::from(n),
            "@own-records",
            "records:write",
            &format!("j5-write-{n}"),
            json!({"records": [{"id": format!("kept-note-{n}"), "type": "note", "value": {"words": format!("KEPT_{n}")}}]}),
        )
    };
    let read = |n: u32, request: &str| {
        tool(
            700 + u64::from(n),
            "@own-records",
            "records:read",
            request,
            json!({"id": format!("kept-note-{n}")}),
        )
    };
    let words = |n: u32| {
        move |status: StatusCode, answer: &Value| {
            tool_ok(status, answer)
                && answer["result"]["structuredContent"]["value"]["words"]
                    == format!("KEPT_{n}").as_str()
        }
    };
    let mut acknowledged = Vec::new();
    for n in 1..=5 {
        let (status, answer) = call_until(&key, &write(n), Duration::from_secs(60), &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "write {n} was not acknowledged: {answer}{}",
            logs(&a, &b, &c)
        );
        acknowledged.push(n);
    }

    // A, the writer, is killed.
    assert!(
        a.log().contains("event=claimed"),
        "A took the writer turn: {}",
        a.log()
    );
    a.stop(true);
    let killed = test_time::mark();
    let (status, answer) = call_until(
        &key,
        &read(1, "j5-read-after-kill"),
        takeover * 3,
        &words(1),
    );
    let read_took = killed.elapsed();
    eprintln!("j5-virtual read_after_kill={read_took:?} clock_ms={}", clock().now_ms());
    assert!(
        words(1)(status, &answer),
        "no read after A died: {answer}{}",
        logs(&a, &b, &c)
    );
    let (status, answer) = call_until(&key, &write(6), takeover * 3, &tool_ok);
    let write_took = killed.elapsed();
    assert!(
        tool_ok(status, &answer),
        "no write after A died: {answer}{}",
        logs(&a, &b, &c)
    );
    acknowledged.push(6);
    eprintln!(
        "j5-measured read_after_kill_ms={} write_after_kill_ms={} takeover_bound_ms={}",
        read_took.as_millis(),
        write_took.as_millis(),
        takeover.as_millis()
    );
    assert!(
        write_took <= takeover,
        "writes resumed {write_took:?} after the kill, more than the takeover {takeover:?}{}",
        logs(&a, &b, &c)
    );
    for n in &acknowledged {
        let (status, answer) = call_until(
            &key,
            &read(*n, &format!("j5-read-{n}")),
            Duration::from_secs(30),
            &words(*n),
        );
        assert!(
            words(*n)(status, &answer),
            "acknowledged write {n} was lost: {answer}{}",
            logs(&a, &b, &c)
        );
    }

    // Idle past `idle_release_ms`: the writer turn is given up and nobody holds a term. The next calls are answered.
    clock().advance(idle);
    let woke = test_time::mark();
    let (status, answer) = call_until(&key, &read(6, "j5-read-after-idle"), takeover, &words(6));
    assert!(
        words(6)(status, &answer),
        "no read after the account was idle: {answer}{}",
        logs(&a, &b, &c)
    );
    let issue = tool(
        800,
        "@sign-in",
        "sign-in:issue-key",
        "j5-issue-after-idle",
        json!({"name": "after-idle", "scopes": ["records", "sign-in"]}),
    );
    let (status, answer) = call_until(&key, &issue, takeover, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no sign-in change after the account was idle: {answer}{}",
        logs(&a, &b, &c)
    );
    let (status, answer) = call_until(&key, &write(7), takeover, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no write after the account was idle: {answer}{}",
        logs(&a, &b, &c)
    );
    eprintln!(
        "j5-measured answered_after_idle_ms={}",
        woke.elapsed().as_millis()
    );

    // A stop (SIGTERM) ends within the stop grace: the listener's open connections and the session threads each get
    // `stop_grace_ms` at most, and the dispatch threads' shutdown as much again (measured 2026-11-03: 55 s and 90 s).
    let grace = Duration::from_millis(entry["stop_grace_ms"].as_u64().unwrap());
    for peer in [&mut b, &mut c] {
        let stopping = Instant::now();
        peer.stop(false);
        let took = stopping.elapsed();
        eprintln!("j5-measured stop_ms={}", took.as_millis());
        assert!(
            took <= grace * 4,
            "a stop took {took:?}, more than the grace allows ({grace:?} each step)"
        );
    }
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// docs/placement-decision/proofs.md (not covered by J5, where B and C join as computers that may answer): a computer that
/// only kept a copy is then let answer. Sign-up at A, whose config names three default computers (A, B and C keep copies
/// and vote; A and B may answer, C keeps a copy only): records are written, C holds them sealed and serves no account routes. The
/// owner edits the row so C may answer (`add-computer`, `may_answer`); C gets the root, the account stores and a records
/// store that opens, and opens its account routes. C's own listener then answers a records read of every acknowledged write
/// from its own copy, with a key issued while it kept only a copy; and once A, the writer, dies, B and C (two of three
/// voters) answer reads and take a write through the forwarder.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_computer_that_kept_only_a_copy_answers_from_its_own_copy_once_the_row_lets_it_answer() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, seconds: u64, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(200));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 91, forwarder_host);
    let mut b = Peer::new(dir.path(), "b", 92, forwarder_host);
    let mut c = Peer::new(dir.path(), "c", 93, forwarder_host);
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        may_answer: vec![a.id.clone(), b.id.clone()],
        voters: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    c.start(&trust);
    let logs =
        |a: &Peer, b: &Peer, c: &Peer| format!("\nA: {}\nB: {}\nC: {}", a.log(), b.log(), c.log());

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(51).registration(&challenge, "Promoted"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !(b.keeps(&owner) && c.keeps(&owner)) {
        assert!(
            Instant::now() < deadline,
            "B and C did not join the account{}",
            logs(&a, &b, &c)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    installed_tools::install(&a.account(&owner));
    installed_tools::install(&b.account(&owner));

    let first = sign_in_token(&address);
    let issue = tool(
        30,
        "@sign-in",
        "sign-in:issue-key",
        "promoted-issue-key",
        json!({"name": "promoted", "scopes": ["records", "sign-in"]}),
    );
    let (status, answer) = call_until(&first, &issue, 120, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no key was issued at A: {answer}{}",
        logs(&a, &b, &c)
    );
    let key = answer["result"]["structuredContent"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let write = |n: u32| {
        tool(
            40 + u64::from(n),
            "@own-records",
            "records:write",
            &format!("promoted-write-{n}"),
            json!({"records": [{"id": format!("spread-note-{n}"), "type": "note", "value": {"words": format!("PROMOTED_{n}")}}]}),
        )
    };
    let read = |n: u32, request: &str| {
        tool(
            80 + u64::from(n),
            "@own-records",
            "records:read",
            request,
            json!({"id": format!("spread-note-{n}")}),
        )
    };
    let words = |n: u32| {
        move |status: StatusCode, answer: &Value| {
            tool_ok(status, answer)
                && answer["result"]["structuredContent"]["value"]["words"]
                    == format!("PROMOTED_{n}").as_str()
        }
    };
    for n in 1..=3 {
        let (status, answer) = call_until(&key, &write(n), 120, &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "write {n} was not acknowledged: {answer}{}",
            logs(&a, &b, &c)
        );
    }
    let routes_open = |peer: &Peer| peer.log().contains("event=door-composed");
    assert!(!routes_open(&c), "C only keeps a copy{}", logs(&a, &b, &c));

    // The owner lets C answer. C gets the root and its stores, and opens its account routes.
    let promote = tool(
        60,
        "@sign-in",
        "sign-in:set-places",
        "promoted-let-c-answer",
        json!({"op": "add-computer", "computer": c.id, "may_answer": true, "voter": true}),
    );
    let (status, answer) = call_until(&first, &promote, 60, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "C was not let answer: {answer}{}",
        logs(&a, &b, &c)
    );
    let deadline = Instant::now() + Duration::from_secs(120);
    while !routes_open(&c) {
        assert!(
            Instant::now() < deadline,
            "C, let answer, did not open its account routes{}",
            logs(&a, &b, &c)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    installed_tools::install(&c.account(&owner));
    let (status, answer) = call_until(&key, &write(4), 120, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "write 4 was not acknowledged: {answer}{}",
        logs(&a, &b, &c)
    );

    // C's own listener answers each acknowledged write from C's own copy, with the key issued while C kept only a copy
    // (its sign-in rows, pulled once it was let answer). A lone computer of three voters never admits (it may admit
    // from its copy only within `admit_ms` of catching up with a live writer), so C is asked while A and B run.
    for n in 1..=4 {
        let deadline = Instant::now() + Duration::from_secs(60);
        let answer = loop {
            let (status, answer) = http_bearer(
                c.port,
                &format!("/a/{address}/mcp"),
                &key,
                &read(n, &format!("promoted-read-at-c-{n}")),
            );
            let ok = status == 200 && words(n)(StatusCode::OK, &answer);
            if ok || Instant::now() > deadline {
                break (ok, answer);
            }
            clock().progress(deadline, Duration::from_millis(200));
        };
        assert!(
            answer.0,
            "C did not answer write {n} from its own copy: {}{}",
            answer.1,
            logs(&a, &b, &c)
        );
    }
    // A, the writer, dies: B and C are two of three voters; reads and a write go on through the forwarder.
    a.stop(true);
    let (status, answer) = call_until(&key, &read(4, "promoted-read-after-kill"), 120, &words(4));
    assert!(
        words(4)(status, &answer),
        "no read after A died: {answer}{}",
        logs(&a, &b, &c)
    );
    let (status, answer) = call_until(&key, &write(5), 180, &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no write after A died: {answer}{}",
        logs(&a, &b, &c)
    );
    let (status, answer) = call_until(&key, &read(5, "promoted-read-5"), 60, &words(5));
    assert!(words(5)(status, &answer), "{answer}");
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// The live computer and failover proofs (docs/placement-decision/live-proofs-2026-11-04.md, item 2): an account moves
/// from A to B, two full computers (each its own `trillion-local serve` process) behind one forwarder over verified TLS,
/// with a read through the forwarder every `PROBE_MS` from before B is named until after A has stopped. The procedure is
/// the documented one: A alone is the first voter; B is added as a computer that may answer and joins by itself; B
/// becomes a voter once it says it caught up; A is removed (one voter step: from A and B to B); A stops. Every probe
/// read's status is kept; the test fails on any read that is not answered with the written record, and prints the
/// counts and the time of each step (`move-measured`).
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn an_account_moves_from_a_to_b_on_two_full_computers_with_every_probe_read_answered() {
    const PROBE_MS: u64 = 500;
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, wait: Duration, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + wait;
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(200));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 91, forwarder_host).on_real_clock();
    let mut b = Peer::new(dir.path(), "b", 92, forwarder_host).on_real_clock();
    // A move ends with one computer: the account asks one copy keeper, one voter and one computer that may answer (the
    // starting rule asks more, and refuses the last step `computers_below_copy_rule`).
    let mut new_accounts: Value =
        serde_json::from_str::<Value>(&fs::read_to_string(&a.config).unwrap()).unwrap()
            ["new_accounts"]
            .clone();
    new_accounts["copies"] = json!({"least_copy_keepers": 1, "least_voters": 1, "least_may_answer": 1, "least_always_on": 0});
    a.set("new_accounts", new_accounts);
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    let logs = |a: &Peer, b: &Peer| format!("\nA: {}\nB: {}", a.log(), b.log());

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(51).registration(&challenge, "Moved"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    let key = sign_in_token(&address);

    let mut id = 900;
    let mut edit_row = |input: Value| {
        id += 1;
        tool(
            id,
            "@sign-in",
            "sign-in:set-places",
            &format!("move-places-{id}"),
            input,
        )
    };
    let write = |n: u32| {
        tool(
            950 + u64::from(n),
            "@own-records",
            "records:write",
            &format!("move-write-{n}"),
            json!({"records": [{"id": format!("moved-note-{n}"), "type": "note", "value": {"words": format!("MOVED_{n}")}}]}),
        )
    };
    let words_of = |n: u32| {
        move |status: StatusCode, answer: &Value| {
            tool_ok(status, answer)
                && answer["result"]["structuredContent"]["value"]["words"]
                    == format!("MOVED_{n}").as_str()
        }
    };

    // A alone is the first voter, and one record is written there.
    let first = edit_row(
        json!({"op": "set", "keeps_copy": [a.id], "may_answer": [a.id], "voters": [a.id]}),
    );
    let (status, answer) = call_until(&key, &first, Duration::from_secs(30), &tool_ok);
    assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b));
    let (status, answer) = call_until(&key, &write(1), Duration::from_secs(60), &tool_ok);
    assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b));
    let (status, answer) = call_until(
        &key,
        &tool(
            970,
            "@own-records",
            "records:read",
            "move-read-ready",
            json!({"id": "moved-note-1"}),
        ),
        Duration::from_secs(30),
        &words_of(1),
    );
    assert!(words_of(1)(status, &answer), "{answer}");

    // The probe: one read through the forwarder every PROBE_MS, each status kept with its time from the probe's start.
    let probing = Arc::new(AtomicBool::new(true));
    let (sampled, samples) = std::sync::mpsc::channel();
    let probe_clock = clock();
    let probe = {
        let (forwarder, key, probing) = (forwarder.clone(), key.clone(), probing.clone());
        std::thread::spawn(move || {
            test_time::use_clock(probe_clock.clone());
            CALL_HOST.with(|host| host.set(forwarder_host));
            let rt = two_threads();
            let started = Instant::now();
            let mut seen: Vec<(u128, u16, bool, bool)> = Vec::new();
            let mut n = 0u64;
            while probing.load(std::sync::atomic::Ordering::Acquire) {
                n += 1;
                let body = tool(
                    10_000 + n,
                    "@own-records",
                    "records:read",
                    &format!("move-probe-{n}"),
                    json!({"id": "moved-note-1"}),
                );
                let (status, _, answer) = mcp_call(&rt, &forwarder, &key, &body);
                let ok = tool_ok(status, &answer)
                    && answer["result"]["structuredContent"]["value"]["words"] == "MOVED_1";
                if !ok {
                    eprintln!(
                        "move-probe miss at_ms={} status={status} answer={}",
                        started.elapsed().as_millis(),
                        answer.to_string().chars().take(300).collect::<String>()
                    );
                }
                // A typed refusal inside a 200 (`outcome` not_started): the route changed during the move, and the answer says so.
                // An aborted transfer is an answer withheld on the wire (the client gets no terminating chunk).
                let refused_or_aborted = status == StatusCode::OK
                    && (answer["result"]["structuredContent"]["outcome"] == "not_started" || answer["transfer"] == "aborted");
                seen.push((started.elapsed().as_millis(), status.as_u16(), ok, refused_or_aborted));
                let due = probe_clock.now_ms() + PROBE_MS as i64;
                sampled.send(due).ok();
                probe_clock.wait_until_running(due, &probing);
            }
            seen
        })
    };
    let moving = Instant::now();

    // B may answer: the door gives it its host kind, then it joins by itself, and becomes a voter once it says it caught up.
    let kind = set_host_kind(901, &b.id, "my-device");
    let (status, answer) = call_until(&key, &kind, Duration::from_secs(60), &tool_ok);
    assert!(tool_ok(status, &answer), "B's host kind was not set: {answer}");
    let add = edit_row(json!({"op": "add-computer", "computer": b.id, "may_answer": true}));
    let (status, answer) = call_until(&key, &add, Duration::from_secs(60), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "B was not added: {answer}{}",
        logs(&a, &b)
    );
    let added_ms = moving.elapsed().as_millis();
    let vote = edit_row(
        json!({"op": "add-computer", "computer": b.id, "may_answer": true, "voter": true}),
    );
    let (status, answer) = call_until(&key, &vote, Duration::from_secs(180), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "B never became a voter: {answer}{}",
        logs(&a, &b)
    );
    let voter_ms = moving.elapsed().as_millis();
    installed_tools::install(&b.account(&owner));
    let (status, answer) = call_until(&key, &write(2), Duration::from_secs(60), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no write with A and B voting: {answer}{}",
        logs(&a, &b)
    );

    // A is removed: one voter step, from A and B to B alone.
    let remove = edit_row(json!({"op": "remove-computer", "computer": a.id}));
    let (status, answer) = call_until(&key, &remove, Duration::from_secs(60), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "A was not removed: {answer}{}",
        logs(&a, &b)
    );
    let removed_ms = moving.elapsed().as_millis();
    let (status, answer) = call_until(&key, &write(3), Duration::from_secs(60), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no write at B after A was removed: {answer}{}",
        logs(&a, &b)
    );
    let write_after_ms = moving.elapsed().as_millis() - removed_ms;
    let (status, answer) = call_until(&key, &read_computers(), Duration::from_secs(30), &tool_ok);
    let row = answered(status, &answer)["places"].clone();
    assert_eq!(row["voters"], json!([b.id]), "{row}");
    assert_eq!(row["holders"], json!([b.id]), "{row}");

    // A stops; reads go on at B alone for a while.
    a.stop(false);
    let stopped = test_time::mark();
    for _ in 0..10_000 / PROBE_MS {
        loop {
            let due = samples.recv_timeout(Duration::from_secs(30)).expect("the probe answered at this virtual interval");
            if due > clock().now_ms() { clock().advance_to(due); break; }
        }
    }
    probing.store(false, std::sync::atomic::Ordering::Release);
    clock().advance(Duration::from_millis(PROBE_MS));
    let seen = probe.join().unwrap();
    let (status, answer) = call_until(
        &key,
        &tool(
            971,
            "@own-records",
            "records:read",
            "move-read-3",
            json!({"id": "moved-note-3"}),
        ),
        Duration::from_secs(30),
        &words_of(3),
    );
    assert!(
        words_of(3)(status, &answer),
        "the write after the move is not at B: {answer}{}",
        logs(&a, &b)
    );
    assert!(
        b.log().contains("event=claimed"),
        "B took the writer turn: {}",
        b.log()
    );

    let mut by_status = std::collections::BTreeMap::<u16, u32>::new();
    for (_, status, _, _) in &seen {
        *by_status.entry(*status).or_default() += 1;
    }
    let missed: Vec<_> = seen.iter().filter(|(_, _, ok, _)| !ok).collect();
    eprintln!("move-measured probes={} answered={} missed={} by_status={by_status:?} b_added_ms={added_ms} b_voter_ms={voter_ms} \
        a_removed_ms={removed_ms} first_write_at_b_after_removal_ms={write_after_ms} probed_after_a_stopped_ms={}",
        seen.len(), seen.len() - missed.len(), missed.len(), stopped.elapsed().as_millis());
    // A known gap (docs/placement-decision/live-proofs-2026-11-04.md): while the removal is being acknowledged, B
    // already holds the new row and refuses A's renewal, so A can no longer admit, and the forwarder still sends a call
    // to A until A tells it the new row; that call is answered 503 (the forwarder does not try another computer). At most
    // one probe falls in it. No 401: B admits the account's key from the first call it gets. A typed `not_started` refusal
    // inside a 200 (the route changed before the read ran) is an honest, retryable refusal of the same kind during a
    // handover, so it counts as refused; it still counts toward the one miss. An aborted transfer (the withheld answer ends
    // without its terminating chunk, so a client reads an incomplete response) counts the same way.
    assert!(
        missed.iter().all(|(_, status, _, refused_or_aborted)| *status == 503 || *refused_or_aborted),
        "a probe read was neither refused (not_started or an aborted transfer) nor unavailable: {missed:?}{}",
        logs(&a, &b)
    );
    assert!(
        missed.len() <= 1,
        "probe reads that were not answered during the move: {missed:?}{}",
        logs(&a, &b)
    );
    b.stop(false);
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// A protected removal request refused before its successor can answer can be asked again with the identical key and
/// body after that successor's actual readback. The initial successor only keeps a copy, so the unready state is
/// deterministic; promoting it is a separate signed edit while A remains the serving writer, with no timing test knob.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn the_same_mcp_move_request_key_succeeds_after_its_survivor_becomes_ready() {
    use trillion_local::account::computers::messages::{Message, Post};
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|held| held.set(host));
    let gateway = Arc::new(Gateway::with_computers(host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let ingress =
        front_door::behind_tls(listener, identity, gateway).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || ingress.serve(until));
    let rt = two_threads();
    let until_ok = |key: &str, body: &Value, seconds: u64| {
        let until = Instant::now() + Duration::from_secs(seconds);
        loop {
            let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
            if tool_ok(status, &answer) || Instant::now() > until {
                return (status, answer);
            }
            clock().progress(until, Duration::from_millis(200));
        }
    };
    let mut a = Peer::new(dir.path(), "a", 101, host);
    let mut b = Peer::new(dir.path(), "b", 102, host);
    let mut starting = serde_json::from_str::<Value>(&fs::read_to_string(&a.config).unwrap())
        .unwrap()["new_accounts"]
        .clone();
    starting["copies"] = json!({"least_copy_keepers": 1, "least_voters": 1, "least_may_answer": 1, "least_always_on": 0});
    a.set("new_accounts", starting);
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone()],
        may_answer: vec![a.id.clone()],
        voters: vec![a.id.clone(), b.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    let (status, options) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{options}");
    let challenge = options["options"]["challenge"].as_str().unwrap();
    let (status, made) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(71).registration(challenge, "Ready move"),
    );
    assert_eq!(status, 200, "{made} {}", a.log());
    let address = made["address"].as_str().unwrap();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    let key = sign_in_token(address);
    let write = tool(
        1,
        "@own-records",
        "records:write",
        "ready-move-write",
        json!({"records": [{"id": "ready-note", "type": "note", "value": {"words": "kept through readiness"}}]}),
    );
    let (status, answer) = until_ok(&key, &write, 60);
    assert!(
        tool_ok(status, &answer),
        "the first write was not acknowledged: {answer}\nA: {}\nB: {}",
        a.log(),
        b.log()
    );
    let signer =
        ComputerSigner::of(&ComputerKey::read(&a.dir.join("computer.key")).unwrap()).unwrap();
    let ready = || {
        let proof = signer.message_credential(address, now_ms());
        let body = serde_json::to_vec(&Post {
            message: Message::Ready,
        })
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/a/{address}/places/{}", b.id))
            .header(header::HOST, host)
            .header(header::AUTHORIZATION, format!("Bearer {proof}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        rt.block_on(async {
            let response = forwarder.clone().oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
            let answer: Value = serde_json::from_slice(&bytes).unwrap();
            status == StatusCode::OK && answer["kind"] == "done"
        })
    };
    assert!(
        !ready(),
        "a computer that only keeps a copy cannot attest call readiness"
    );
    let remove = tool(
        2,
        "@sign-in",
        "sign-in:set-places",
        "ready-move-same-key",
        json!({"op": "set", "keeps_copy": [b.id], "may_answer": [b.id], "voters": [b.id]}),
    );
    let (status, _, refused) = mcp_call(&rt, &forwarder, &key, &remove);
    assert!(
        !tool_ok(status, &refused),
        "the unready successor must not remove the serving writer: {refused}"
    );
    let (status, row) = until_ok(&key, &read_computers(), 30);
    assert_eq!(
        answered(status, &row)["places"]["answering"],
        json!([a.id]),
        "the refused request changed no serving row: {row}"
    );

    let promote = tool(
        3,
        "@sign-in",
        "sign-in:set-places",
        "ready-move-promote",
        json!({"op": "add-computer", "computer": b.id, "may_answer": true, "voter": true}),
    );
    let (status, answer) = until_ok(&key, &promote, 60);
    assert!(
        tool_ok(status, &answer),
        "B was not promoted while A served: {answer}\nA: {}\nB: {}",
        a.log(),
        b.log()
    );
    let until = Instant::now() + Duration::from_secs(60);
    while !ready() {
        assert!(
            Instant::now() < until,
            "B did not complete actual readback\nA: {}\nB: {}",
            a.log(),
            b.log()
        );
        clock().progress(until, Duration::from_millis(200));
    }
    let (status, answer) = until_ok(&key, &remove, 60);
    assert!(
        tool_ok(status, &answer),
        "the identical protected request remained refused after readiness: {answer}\nA: {}\nB: {}",
        a.log(),
        b.log()
    );
    let (status, row) = until_ok(&key, &read_computers(), 30);
    let row = answered(status, &row)["places"].clone();
    assert_eq!(row["holders"], json!([b.id]));
    assert_eq!(row["voters"], json!([b.id]));
    let read = tool(
        4,
        "@own-records",
        "records:read",
        "ready-move-read",
        json!({"id": "ready-note"}),
    );
    let (status, answer) = until_ok(&key, &read, 30);
    assert_eq!(
        answered(status, &answer)["value"]["words"],
        "kept through readiness"
    );
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// A TCP pass-through that holds every chunk `one_way` before passing it on, each direction on its own: a link with a round
/// trip of twice `one_way`. TLS passes through it untouched (the client still verifies the forwarder's certificate).
fn delaying_pass_through(listener: TcpListener, to: std::net::SocketAddr, one_way: Duration) {
    let clock = clock();
    fn pipe(mut from: TcpStream, mut to: TcpStream, one_way: Duration, clock: Arc<test_time::FakeClock>) {
        use std::io::{Read as _, Write as _};
        let (send, take) = std::sync::mpsc::channel::<(i64, Vec<u8>)>();
        let reading_clock = clock.clone();
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                match from.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if send
                            .send((reading_clock.now_ms() + one_way.as_millis() as i64, buffer[..read].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
        std::thread::spawn(move || {
            while let Ok((due, bytes)) = take.recv() {
                let now = clock.now_ms();
                if due > now {
                    clock.wait_link(Duration::from_millis((due - now) as u64));
                }
                if to.write_all(&bytes).is_err() {
                    break;
                }
            }
            let _ = to.shutdown(std::net::Shutdown::Write);
        });
    }
    std::thread::spawn(move || {
        for client in listener.incoming() {
            let Ok(client) = client else { continue };
            let Ok(upstream) = TcpStream::connect(to) else {
                continue;
            };
            let _ = (client.set_nodelay(true), upstream.set_nodelay(true));
            pipe(
                client.try_clone().unwrap(),
                upstream.try_clone().unwrap(),
                one_way,
                clock.clone(),
            );
            pipe(upstream, client, one_way, clock.clone());
        }
    });
}

/// The live computer and failover proofs (docs/placement-decision/live-proofs-2026-11-04.md, item 4): how long a change
/// larger than one message takes in parts when every computer reaches the forwarder over a link with a round trip.
/// Two full computers (A the writer, B the second voter, so B must hold each change before it is acknowledged) behind
/// one forwarder over verified TLS; the forwarder's public port is a TCP pass-through that delays each direction by half the
/// round trip, so every computer's post, and the session that carries it to the other computer, pays it. At each
/// round trip of `ROUND_TRIPS_MS`, records of `SIZES` bytes are written at A's own listener (a write through the
/// forwarder is bounded at 64 KiB) and the time to their acknowledgement is printed (`parts-measured`), with the parts A
/// sent (its log's part count is not kept, so it is `ceil(posted bytes / message_body_bytes)` from the record's size).
/// A write of the smallest size must be acknowledged; for the larger sizes the outcome is printed with the time (on
/// 2026-11-04 a 1 MB write was not acknowledged at any round trip: see the doc).
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_change_in_parts_is_timed_over_a_link_with_a_round_trip() {
    const ROUND_TRIPS_MS: [u64; 3] = [0, 20, 50];
    const SIZES: [usize; 4] = [30_000, 100_000, 300_000, 1_000_000];
    const EACH: u32 = 3;
    let numbers: Value =
        serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
    let message_bytes = numbers["message_body_bytes"].as_u64().unwrap() as usize;
    for round_trip in ROUND_TRIPS_MS {
        let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
        let tls = dir.path().join("tls");
        fs::create_dir_all(&tls).unwrap();
        let (_, identity) = localhost_tls(&tls);
        let public = TcpListener::bind("127.0.0.1:0").unwrap();
        let inner = TcpListener::bind("127.0.0.1:0").unwrap();
        let inner_at = inner.local_addr().unwrap();
        let forwarder_host: &'static str = Box::leak(
            format!("localhost:{}", public.local_addr().unwrap().port()).into_boxed_str(),
        );
        delaying_pass_through(public, inner_at, Duration::from_millis(round_trip / 2));
        CALL_HOST.with(|host| host.set(forwarder_host));
        let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
        let forwarder = gateway.http_route_table().unwrap();
        let serving =
            front_door::behind_tls(inner, identity, gateway.clone())
                .unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let until = shutdown.clone();
        std::thread::spawn(move || serving.serve(until));
        let rt = two_threads();
        let call_until =
            |key: &str, body: &Value, wait: Duration, done: &dyn Fn(StatusCode, &Value) -> bool| {
                let deadline = Instant::now() + wait;
                loop {
                    let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                    if done(status, &answer) || Instant::now() > deadline {
                        return (status, answer);
                    }
                    clock().progress(deadline, Duration::from_millis(200));
                }
            };
        let mut a = Peer::new(dir.path(), "a", 93, forwarder_host);
        let mut b = Peer::new(dir.path(), "b", 94, forwarder_host);
        let trust = tls.join("ca.pem");
        a.start(&trust);
        b.start(&trust);
        let logs = |a: &Peer, b: &Peer| format!("\nA: {}\nB: {}", a.log(), b.log());
        let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
        assert_eq!(status, 200, "{given}");
        let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
        let (status, done) = http(
            a.port,
            "POST",
            "/sign-up/finish",
            ORIGIN,
            &Authenticator::new(53).registration(&challenge, "Parts"),
        );
        assert_eq!(status, 200, "{done} {}", a.log());
        let address = done["address"].as_str().unwrap().to_owned();
        let owner = fs::read_dir(a.dir.join("accounts"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .find(|name| !name.starts_with('.'))
            .unwrap();
        installed_tools::install(&a.account(&owner));
        let key = sign_in_token(&address);
        let mut id = 1_200;
        let mut edit_row = |input: Value| {
            id += 1;
            tool(
                id,
                "@sign-in",
                "sign-in:set-places",
                &format!("parts-places-{id}"),
                input,
            )
        };
        let kind = set_host_kind(1_199, &b.id, "my-device");
        let (status, answer) = call_until(&key, &kind, Duration::from_secs(60), &tool_ok);
        assert!(tool_ok(status, &answer), "B's host kind was not set: {answer}");
        for edit in [
            json!({"op": "set", "keeps_copy": [a.id], "may_answer": [a.id], "voters": [a.id]}),
            json!({"op": "add-computer", "computer": b.id, "may_answer": true}),
            json!({"op": "add-computer", "computer": b.id, "may_answer": true, "voter": true}),
        ] {
            let (status, answer) = call_until(
                &key,
                &edit_row(edit.clone()),
                Duration::from_secs(240),
                &tool_ok,
            );
            assert!(tool_ok(status, &answer), "{edit}: {answer}{}", logs(&a, &b));
        }
        installed_tools::install(&b.account(&owner));
        // A first small write, so the writer turn is held and B is caught up before anything is timed.
        let small = tool(
            1_300,
            "@own-records",
            "records:write",
            "parts-warm",
            json!({"records": [{"id": "warm", "type": "note", "value": {"words": "W"}}]}),
        );
        let (status, answer) = call_until(&key, &small, Duration::from_secs(120), &tool_ok);
        assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b));

        // The writer's throughput for small writes one after another (each acknowledged by B before the next).
        const SMALL_WRITES: u64 = 40;
        let started = Instant::now();
        for w in 0..SMALL_WRITES {
            let body = tool(
                5_000 + w,
                "@own-records",
                "records:write",
                &format!("parts-small-{w}"),
                json!({"records": [{"id": format!("small-note-{w}"), "type": "note", "value": {"words": format!("S{w}")}}]}),
            );
            let (status, answer) = http_bearer(a.port, &format!("/a/{address}/mcp"), &key, &body);
            assert!(
                status == 200 && tool_ok(StatusCode::OK, &answer),
                "small write {w} at {round_trip} ms: {status} {answer}{}",
                logs(&a, &b)
            );
        }
        let elapsed = started.elapsed();
        eprintln!("parts-measured round_trip_ms={round_trip} small_writes={SMALL_WRITES} total_ms={} writes_per_s={:.1}",
            elapsed.as_millis(), SMALL_WRITES as f64 / elapsed.as_secs_f64());

        let mut n = 0u64;
        for size in SIZES {
            let mut took = Vec::new();
            for _ in 0..EACH {
                n += 1;
                let text: String = (0..size)
                    .map(|at| char::from(b'a' + ((at as u64 + n) % 26) as u8))
                    .collect();
                let body = tool(
                    1_400 + n,
                    "@own-records",
                    "records:write",
                    &format!("parts-write-{n}"),
                    json!({"records": [{"id": format!("parts-note-{n}"), "type": "note", "value": {"text": text}}]}),
                );
                let started = Instant::now();
                let (status, answer) =
                    http_bearer(a.port, &format!("/a/{address}/mcp"), &key, &body);
                let elapsed = started.elapsed();
                let ok = status == 200 && tool_ok(StatusCode::OK, &answer);
                let code = answer["result"]["structuredContent"]["code"]
                    .as_str()
                    .unwrap_or(if ok { "acknowledged" } else { "no_answer" })
                    .to_owned();
                if size <= SIZES[0] {
                    assert!(
                        ok,
                        "a {size} byte write at {round_trip} ms: {status} {answer}{}",
                        logs(&a, &b)
                    );
                }
                took.push((elapsed.as_millis(), code));
                if !ok {
                    // A write not acknowledged gives the writer turn up: the next one claims it again.
                    let (status, answer) =
                        call_until(&key, &small, Duration::from_secs(60), &tool_ok);
                    assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b));
                }
            }
            took.sort();
            eprintln!("parts-measured round_trip_ms={round_trip} record_bytes={size} parts_at_least={} each={took:?}",
                size.div_ceil(message_bytes));
        }
        a.stop(false);
        b.stop(false);
        shutdown.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// A request that ran is answered as its route answered it, whether or not a copy acknowledged the change it made to the
/// account stores (measured 2026-11-13: the person's door answered 503 `not_acknowledged` to calls whose route had succeeded, and
/// every caller replayed a write that had run). With the other two voters down, A's change to its policy rows is not
/// acknowledged: the call still answers 200 and does not wait for the copies. (What becomes of the change is the step's, see
/// `a_store_change_no_copy_acknowledged_is_reported_refused_and_written_by_a_later_step`.)
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_call_that_ran_is_answered_ok_when_no_copy_acknowledged_the_account_stores_change_it_left() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving = front_door::behind_tls(listener, identity, gateway.clone()).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until = |key: &str, body: &Value, seconds: u64, done: &dyn Fn(StatusCode, &Value) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        loop {
            let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
            if done(status, &answer) || Instant::now() > deadline {
                return (status, answer);
            }
            clock().progress(deadline, Duration::from_millis(200));
        }
    };
    let mut a = Peer::new(dir.path(), "a", 61, forwarder_host).on_real_clock();
    let mut b = Peer::new(dir.path(), "b", 62, forwarder_host).on_real_clock();
    let mut c = Peer::new(dir.path(), "c", 63, forwarder_host).on_real_clock();
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        may_answer: vec![a.id.clone(), b.id.clone()],
        voters: vec![a.id.clone(), b.id.clone(), c.id.clone()],
        kinds: Default::default(),
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);
    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(a.port, "POST", "/sign-up/finish", ORIGIN, &Authenticator::new(31).registration(&challenge, "Unacknowledged"));
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    b.start(&trust);
    c.start(&trust);
    let deadline = Instant::now() + Duration::from_secs(60);
    while !(b.keeps(&owner) && c.keeps(&owner)) {
        assert!(Instant::now() < deadline, "B and C did not join the account\nA: {}", a.log());
        clock().progress(deadline, Duration::from_millis(100));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_trillion-local"))
        .args(["sign-in", "issue-key", a.account(&owner).to_str().unwrap(), "unacknowledged", "records", "sign-in"])
        .output()
        .unwrap();
    let issued = String::from_utf8(output.stdout).unwrap();
    let key = issued.lines().next().unwrap().trim().to_owned();
    assert!(key.starts_with(&format!("nm_{address}_")), "{issued}");
    let read = |n: u64| tool(1_600 + n, "@own-records", "records:read", &format!("unacknowledged-read-{n}"), json!({"id": "warm"}));
    let warm = tool(1_599, "@own-records", "records:write", "unacknowledged-warm", json!({"records": [{"id": "warm", "type": "note", "value": {"words": "W"}}]}));
    let (status, answer) = call_until(&key, &warm, 120, &tool_ok);
    assert!(tool_ok(status, &answer), "the first write was not acknowledged: {answer}\nA: {}", a.log());

    // B and C go down, and A's policy rows change (as a route that writes the account stores leaves them).
    b.stop(true);
    c.stop(true);
    let policy_at = |peer: &Peer| {
        let db = rusqlite::Connection::open(peer.account(&owner).join("policy.sqlite")).unwrap();
        db.busy_timeout(Duration::from_secs(10)).unwrap();
        db
    };
    policy_at(&a).execute("INSERT INTO policy_directory VALUES('rights:unacknowledged', '\"ONE\"')", []).unwrap();
    // Asked at once: A holds its writer turn for `term_ms` after the computers that are down last answered its renewal.
    let (status, answer) = http_bearer(a.port, &format!("/a/{address}/mcp"), &key, &read(1));
    assert!(
        status == 200 && tool_ok(StatusCode::OK, &answer),
        "the call ran and must answer as its route did, not {status} {answer}\nA: {}",
        a.log()
    );
    let b_policy = b.account(&owner).join("policy.sqlite");
    let row_at_b = || {
        rusqlite::Connection::open(&b_policy).ok()
            .and_then(|db| db.query_row("SELECT value FROM policy_directory WHERE name='rights:unacknowledged'", [], |row| row.get::<_, String>(0)).ok())
    };
    assert_eq!(row_at_b(), None, "no copy holds the change yet");

    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

// ---------------------------------------------------------------------------------------------------------------
// A computer's account routes, as the live proofs on place-fsn1 found it (2026-11-04, trillion-rust 61ed056a): a records tool
// run had no routes to call back on, a new account had no files store, the person's files page road was 404, and an
// answer at the forwarder's own /mcp did not name the computer that answered.

/// One computer from its config with one account made there and the fixture tools: the computer, the account's state
/// folder, its address and a key with every scope.
fn one_account_computer(dir: &Path, name: &str) -> (Arc<Computer>, PathBuf, String, String) {
    let config_path = computer_config(&dir.join(name), &shared_computer_key());
    let (owner, address) = create(&config_path);
    let state = dir.join(name).join("accounts").join(&owner);
    installed_tools::install(&state);
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    let key = sign_in_token(&address);
    (computer, state, address, key)
}

/// One request of any method at a loopback door, with `host` and `bearer`: status and body text.
fn raw_at(address: std::net::SocketAddr, host: &str, method: &str, path: &str, bearer: &str, body: &str) -> (u16, String) {
    use std::io::Write as _;
    let mut stream = TcpStream::connect(address).unwrap();
    timeouts(&stream);
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {bearer}\r\nContent-Type: application/json\r\n\
        Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let (status, answer) = read_http_response(&mut stream)
        .unwrap_or_else(|error| panic!("HTTP response frame at {host}{path} failed: {error}"));
    (status, String::from_utf8_lossy(&answer).into_owned())
}

/// A tool run on a computer reads a Namespace file by Range as it does at the Mac app's door: its run bearer asks the
/// lease route for a read permit (declared files right only) and the permit reads `/namespace/bytes/<identity>` with
/// `?lease=`, both at the loopback door the run's descriptor names (plain or under `/a/<address>`). Red before: only
/// `/mcp` was served there, so both were 404 `no_route`.
#[test]
fn a_computers_loopback_door_serves_a_runs_read_lease_and_its_byte_reads() {
    use trillion_local::account_rights::run_capability::{mint, Rights};
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, _state, address, key) = one_account_computer(dir.path(), "loopback-lease");
    let account = computer.accounts()[0].clone();
    let door = account.loopback_door().expect("a computer's account has its own loopback door");
    let host = door.to_string();
    let clip = format!("1f:{}", "a".repeat(64));
    let rights = Rights::declared(&json!({"fd": 3, "rights": [{"files": "/", "id": clip, "operations": ["read_file_span"]}]})).unwrap();
    let run = mint(account.owner_id(), key.as_bytes(), rights, None, Duration::from_secs(60)).unwrap();
    for prefix in [String::new(), format!("/a/{address}")] {
        let (status, minted) = raw_at(door, &host, "POST", &format!("{prefix}/mcp/api/namespace/leases"), run.token(), r#"{"scope":"read","seconds":60}"#);
        assert_eq!(status, 200, "{prefix}: {minted}");
        let lease = serde_json::from_str::<Value>(&minted).unwrap()["lease"].as_str().expect("a lease").to_owned();
        let (status, read) = raw_at(door, &host, "GET", &format!("{prefix}/namespace/bytes/{clip}?lease={lease}"), run.token(), "");
        assert!(!read.contains("no_route"), "{prefix}: the byte route is served: {status} {read}");
    }
    let other = "0".repeat(address.len());
    let (status, refused) = raw_at(door, &host, "POST", &format!("/a/{other}/mcp/api/namespace/leases"), run.token(), r#"{"scope":"read"}"#);
    assert_eq!(status, 404, "another account's address is refused: {refused}");
    let (status, misdirected) = raw_at(door, "computer.test", "POST", "/mcp/api/namespace/leases", run.token(), r#"{"scope":"read"}"#);
    assert_eq!(status, 421, "{misdirected}");
}

/// One MCP call at `app` (an account's routes, or the loopback listener's own app) with `host` and `bearer`: status, headers
/// and body.
fn mcp_at(
    executor: &Executor,
    app: &RouteTable,
    path: &str,
    host: &str,
    bearer: &str,
    body: &Value,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::HOST, host)
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .body(Body::from(body.to_string()))
        .unwrap();
    executor.block_on(async {
        let response = app.clone().oneshot(request).await.unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap_or_default();
        (
            status,
            headers,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())),
        )
    })
}

/// One HTTP/1.1 request over a real TCP socket to `address`: the status and the body.
fn over_tcp(
    address: std::net::SocketAddr,
    host: &str,
    path: &str,
    bearer: &str,
    body: &Value,
) -> (u16, Value) {
    use std::io::Write as _;
    let mut stream = TcpStream::connect(address).unwrap();
    timeouts(&stream);
    let body = body.to_string();
    write!(stream, "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {bearer}\r\nContent-Type: application/json\r\n\
        Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let (status, answer) = read_http_response(&mut stream)
        .unwrap_or_else(|error| panic!("HTTP response frame at {host}{path} failed: {error}"));
    (
        status,
        serde_json::from_slice(&answer)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&answer).into_owned())),
    )
}

/// Read the status and complete HTTP-framed body, not the TCP connection's eventual
/// EOF. An early refusal may reset after sending its answer; guarded MCP replies
/// can be chunked. A reset before either framing's terminal boundary still fails.
fn read_http_response(reader: &mut impl std::io::Read) -> std::io::Result<(u16, Vec<u8>)> {
    fn invalid() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid HTTP response framing")
    }
    fn line(reader: &mut impl std::io::BufRead) -> std::io::Result<Vec<u8>> {
        let mut line = Vec::new();
        reader.read_until(b'\n', &mut line)?;
        if !line.ends_with(b"\r\n") {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "HTTP response framing is incomplete"));
        }
        line.truncate(line.len() - 2);
        Ok(line)
    }
    fn append(reader: &mut impl std::io::Read, body: &mut Vec<u8>, length: usize) -> std::io::Result<()> {
        let start = body.len();
        let end = start.checked_add(length).ok_or_else(invalid)?;
        body.try_reserve_exact(length).map_err(std::io::Error::other)?;
        body.resize(end, 0);
        reader.read_exact(&mut body[start..])
    }
    let mut reader = std::io::BufReader::new(reader);
    let status_line = line(&mut reader)?;
    let mut parts = std::str::from_utf8(&status_line).map_err(|_| invalid())?.split_whitespace();
    if parts.next() != Some("HTTP/1.1") {
        return Err(invalid());
    }
    let status = parts.next().ok_or_else(invalid)?.parse::<u16>().map_err(|_| invalid())?;
    let mut length = None;
    let mut chunked = false;
    loop {
        let line = line(&mut reader)?;
        if line.is_empty() {
            break;
        }
        let text = std::str::from_utf8(&line).map_err(|_| invalid())?;
        let (name, value) = text.split_once(':').ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.trim().eq_ignore_ascii_case("chunked") {
                return Err(invalid());
            }
            chunked = true;
        }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if length.is_some() || value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            length = Some(value.parse::<usize>().map_err(|_| invalid())?);
        }
    }
    let mut body = Vec::new();
    match (length, chunked) {
        (Some(length), false) => append(&mut reader, &mut body, length)?,
        (None, true) => loop {
            let size = line(&mut reader)?;
            let size = std::str::from_utf8(&size).map_err(|_| invalid())?.split(';').next().ok_or_else(invalid)?;
            if size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid());
            }
            let size = usize::from_str_radix(size, 16).map_err(|_| invalid())?;
            if size == 0 {
                while !line(&mut reader)?.is_empty() {}
                break;
            }
            append(&mut reader, &mut body, size)?;
            let mut end = [0; 2];
            std::io::Read::read_exact(&mut reader, &mut end)?;
            if end != *b"\r\n" {
                return Err(invalid());
            }
        },
        _ => return Err(invalid()),
    }
    Ok((status, body))
}

#[test]
fn loopback_http_frame_ends_at_its_declared_body_before_a_peer_reset() {
    struct ResetAfter(std::io::Cursor<Vec<u8>>);
    impl std::io::Read for ResetAfter {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = std::io::Read::read(&mut self.0, buffer)?;
            if read == 0 {
                return Err(std::io::ErrorKind::ConnectionReset.into());
            }
            Ok(read)
        }
    }
    for (status, body) in [(200, "{}"), (421, "{\"error\":\"host_not_admitted\"}"), (404, ""), (401, "{}") ] {
        let fixed = format!("HTTP/1.1 {status} Reply\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let chunks = if body.is_empty() { "0\r\n\r\n".to_owned() }
            else { format!("{:x};fixture=yes\r\n{body}\r\n0\r\nX-Fixture: complete\r\n\r\n", body.len()) };
        let chunked = format!("HTTP/1.1 {status} Reply\r\nTransfer-Encoding: chunked\r\n\r\n{chunks}");
        for frame in [fixed, chunked] {
            assert_eq!(read_http_response(&mut ResetAfter(std::io::Cursor::new(frame.into_bytes()))).unwrap(), (status, body.as_bytes().to_vec()));
        }
    }
}

#[test]
fn loopback_http_frame_refuses_a_reset_or_eof_before_its_body_is_complete() {
    struct ResetAfter(std::io::Cursor<Vec<u8>>);
    impl std::io::Read for ResetAfter {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = std::io::Read::read(&mut self.0, buffer)?;
            if read == 0 {
                return Err(std::io::ErrorKind::ConnectionReset.into());
            }
            Ok(read)
        }
    }
    for partial in [
        "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{}",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n",
    ] {
        assert_eq!(read_http_response(&mut ResetAfter(std::io::Cursor::new(partial.as_bytes().to_vec()))).unwrap_err().kind(), std::io::ErrorKind::ConnectionReset);
        assert_eq!(read_http_response(&mut std::io::Cursor::new(partial)).unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
    }
    for ambiguous in [
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
    ] {
        assert_eq!(read_http_response(&mut std::io::Cursor::new(ambiguous)).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    }
}

/// Gap 1: a tool run started at a computer's account routes is handed `http://127.0.0.1:<port>/mcp` and its run
/// capability (account_rights/run_capability.rs `issue_parent`). Before, a computer's account routes had no loopback address, so
/// every row that declares records was refused `workshop_tool_not_runnable_here` before it started. Now each account at
/// a computer has its own loopback listener: the run's capability reaches exactly its declared kind there, over a real
/// socket, as at the hosting app's routes; another Host, another path or no live capability is refused.
#[test]
fn a_computer_gives_each_accounts_door_a_loopback_door_where_a_tool_runs_capability_reaches_its_declared_records(
) {
    use trillion_local::account_rights::run_capability::{mint, Rights};
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, _state, address, key) = one_account_computer(dir.path(), "loopback");
    let account = computer.accounts()[0].clone();
    let door = account
        .loopback_door()
        .expect("a computer's account has its own loopback door");
    assert!(door.ip().is_loopback() && door.port() != 0, "{door}");
    let read = trillion_local::record_value::account_routes::Door::shipped()
        .unwrap()
        .read_operation()
        .to_owned();
    let read_call = |id: u64, kind: &str| {
        tool(
            id,
            "@own-records",
            &read,
            &format!("loopback-read-{id}"),
            json!({"id": format!("{kind}:none"), "type": kind}),
        )
    };
    let refused = |answer: &Value| {
        answer
            .to_string()
            .contains("current_workspace_rights_refused")
    };

    // A run capability for one kind, as the account's routes mint it for a row that declares `invoke.records`.
    let rights = Rights::declared(
        &json!({"fd": 3, "rights": [{"kind": "pursuit", "operations": [read.as_str()]}]}),
    )
    .unwrap();
    let run = mint(
        account.owner_id(),
        key.as_bytes(),
        rights,
        None,
        Duration::from_secs(60),
    )
    .unwrap();
    let host = door.to_string();
    let (status, granted) = over_tcp(door, &host, "/mcp", run.token(), &read_call(1, "pursuit"));
    assert_eq!(status, 200, "{granted}");
    assert!(
        !refused(&granted),
        "the declared kind is admitted at the loopback door: {granted}"
    );
    let (status, other) = over_tcp(
        door,
        &host,
        "/mcp",
        run.token(),
        &read_call(2, "agent-handoff"),
    );
    assert_eq!(status, 200, "{other}");
    assert!(refused(&other), "another kind is refused: {other}");
    // The door a run's descriptor names is the account's own route, `/a/<address>/mcp` (run_capability.rs `door_url`): it
    // reaches the same routes. Before, only `/mcp` was served here and every run that declares records was answered 404
    // `no_route` on a computer (agents-per-step-is-a-number lane, 2026-11-13). Another account's address is refused.
    let (status, named) = over_tcp(door, &host, &format!("/a/{address}/mcp"), run.token(), &read_call(5, "pursuit"));
    assert_eq!(status, 200, "{named}");
    assert!(!refused(&named), "the account's own address reaches its routes: {named}");
    let other_address = "0".repeat(address.len());
    let (status, someone_else) = over_tcp(door, &host, &format!("/a/{other_address}/mcp"), run.token(), &read_call(6, "pursuit"));
    assert_eq!(status, 404, "{someone_else}");
    let (status, below) = over_tcp(door, &host, &format!("/a/{address}/sign-in"), run.token(), &json!({}));
    assert_eq!(status, 404, "{below}");

    // Only POST /mcp with the loopback listener's own Host reaches the account's routes.
    let (status, misdirected) = over_tcp(
        door,
        "computer.test",
        "/mcp",
        run.token(),
        &read_call(3, "pursuit"),
    );
    assert_eq!(status, 421, "{misdirected}");
    let (status, elsewhere) = over_tcp(door, &host, "/sign-in", run.token(), &json!({}));
    assert_eq!(status, 404, "{elsewhere}");
    // A capability whose run ended is unauthorized.
    let token = run.token().to_owned();
    drop(run);
    let (status, ended) = over_tcp(door, &host, "/mcp", &token, &read_call(4, "pursuit"));
    assert_eq!(status, 401, "{ended}");
    // Two accounts at one computer each get their own loopback listener, and a stopped computer's listeners stop.
    let mut closing = TcpStream::connect(door).unwrap();
    closing.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    drop(account);
    drop(computer);
    { use std::io::Read; let _ = closing.read(&mut [0]); }
    assert!(
        TcpStream::connect(door).is_err(),
        "the loopback door stops with its account"
    );
    let config_path = dir.path().join("loopback/computer.json");
    create(&config_path);
    let again = Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
        .unwrap_or_else(|error| panic!("{error}"));
    let doors: std::collections::BTreeSet<_> = again
        .accounts()
        .iter()
        .filter_map(|account| account.loopback_door())
        .collect();
    assert_eq!(doors.len(), 2, "{doors:?}");
}

/// Gap 2: a new account made at a computer has its own files store from the start, as its records store is made
/// (account/create.rs, account_files/bind.rs `make_new`): its files answer through its routes with no `namespace-bind`.
/// Before, every call answered `namespace_unavailable` with step `no_store_file`.
#[test]
fn a_new_account_at_a_computer_has_its_files_store_from_the_start() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, state, _address, key) = one_account_computer(dir.path(), "files");
    let executor = two_threads();
    let path = trillion_local::storage::record_store_resources::placement(
        trillion_local::account_files::FILES,
    )
    .and_then(|placement| placement.in_state(&state))
    .unwrap();
    assert!(path.is_file(), "the files store is made with the account");
    let app = computer.accounts()[0].app();
    let (status, _, answer) = mcp_at(
        &executor,
        &app,
        "/mcp",
        "computer.test",
        &key,
        &tool(
            1,
            "@namespace",
            "files_summary",
            "files-summary-1",
            json!({}),
        ),
    );
    let summary = answered(status, &answer);
    assert!(!answer.to_string().contains("no_store_file"), "{answer}");
    assert!(summary.is_object(), "{answer}");
    // Making it again is refused: an account's files are never made twice.
    assert!(trillion_local::account_files::bind::make_new(
        &state,
        computer.accounts()[0].owner_id(),
        None
    )
    .is_err());
}

/// Gap 3: the person's page road to their files (src/server/owner-routes.json, row `@namespace`) is served by a
/// computer's account routes under `/a/<address>/work/api/files/<operation>`, admitted by the person's sign-in session there,
/// with the same operations and answers as the hosting app's page road. Before, it was 404 at a computer.
#[test]
#[ignore = "signs the person in through a passkey link, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_computers_door_serves_the_persons_files_page_road_to_their_signed_in_page() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, _state, address, key) = one_account_computer(dir.path(), "page");
    let app = computer.app();
    let account_app = computer.accounts()[0].app();
    let executor = two_threads();
    let base = format!("/a/{address}");
    let page = |cookie: Option<&str>, method: Method, path: &str, body: Option<&Value>| {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("{base}{path}"))
            .header(header::HOST, "computer.test");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        if body.is_some() {
            request = request
                .header(header::ORIGIN, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json");
        }
        let request = request
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        executor.block_on(async {
            let response = app.clone().oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap_or_default();
            (
                status,
                serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            )
        })
    };
    let summary = "/work/api/files/files_summary";

    // No session: 401, before any files call.
    let (status, unsigned) = page(None, Method::GET, summary, None);
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{unsigned}");

    // The person signs in with a passkey added through a passkey link, as at any computer's account routes.
    let (status, _, answer) = mcp_at(
        &executor,
        &account_app,
        "/mcp",
        "computer.test",
        &key,
        &tool(
            1,
            "@sign-in",
            "sign-in:passkey-link",
            "page-link-1",
            json!({}),
        ),
    );
    let code = answered(status, &answer)["link"]
        .as_str()
        .unwrap()
        .rsplit_once("link=")
        .unwrap()
        .1
        .to_owned();
    let (status, _, options) = post_with_cookie(
        &executor,
        &app,
        &format!("{base}/passkey/options"),
        &json!({"purpose": "register", "code": code}),
    );
    assert_eq!(status, StatusCode::OK, "{options}");
    let passkey = Authenticator::new(31);
    let mut added = passkey.registration(options["challenge"].as_str().unwrap(), "Page passkey");
    added["purpose"] = json!("register");
    added["code"] = json!(code);
    let (status, cookie, body) =
        post_with_cookie(&executor, &app, &format!("{base}/passkey/finish"), &added);
    assert_eq!(status, StatusCode::OK, "{body}");
    let cookie = cookie.unwrap().split(';').next().unwrap().to_owned();

    // Signed in: a page read answers what the same operation answers an AI's key.
    let (status, read) = page(
        Some(&cookie),
        Method::GET,
        &format!("{summary}?input=%7B%7D"),
        None,
    );
    assert_eq!(status, StatusCode::OK, "{read}");
    let (status, _, answer) = mcp_at(
        &executor,
        &account_app,
        "/mcp",
        "computer.test",
        &key,
        &tool(
            2,
            "@namespace",
            "files_summary",
            "page-summary-key",
            json!({}),
        ),
    );
    assert_eq!(
        read,
        answered(status, &answer),
        "the page road and the key answer the same"
    );
    // A write operation is a POST from the page's own origin; a read asked as a POST, an unknown operation and a
    // path the row does not name are refused.
    let (status, listed) = page(
        Some(&cookie),
        Method::POST,
        "/work/api/files/list_set_aside",
        Some(&json!({})),
    );
    assert_eq!(status, StatusCode::BAD_REQUEST, "a read is a GET: {listed}");
    let (status, unknown) = page(
        Some(&cookie),
        Method::GET,
        "/work/api/files/not_an_operation",
        None,
    );
    assert_eq!(status, StatusCode::BAD_REQUEST, "{unknown}");
    // A POST from another origin is refused before the call.
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{base}/work/api/files/set_file_facts"))
        .header(header::HOST, "computer.test")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, "https://elsewhere.test")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let status = executor.block_on(async { app.clone().oneshot(request).await.unwrap().status() });
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// Gap 4: every answer the forwarder gives for an account names the computer whose session answered it
/// (src/account/computers/settings.json `answered_by_header`): a carried `/a/<address>/...` request already did; an MCP
/// call at the forwarder's own `/mcp`, routed by its bearer, named none. Now both name it, and a computer's own answer
/// never sets it.
#[test]
fn an_mcp_answer_at_the_forwarders_own_mcp_names_the_computer_that_answered() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, _state, address, key) = one_account_computer(dir.path(), "named");
    let executor = two_threads();
    let forwarder = start_forwarder();
    connect(&computer, &address, forwarder.sessions);
    let header_name: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/account/computers/settings.json"
    )))
    .unwrap();
    let header_name = header_name["answered_by_header"]
        .as_str()
        .unwrap()
        .to_owned();
    call_when_up(&executor, &forwarder.http, &key, &read_computers());
    let (status, headers, answer) = mcp_at(
        &executor,
        &forwarder.http,
        "/mcp",
        FORWARDER_HOST,
        &key,
        &read_computers(),
    );
    answered(status, &answer);
    assert_eq!(
        headers
            .get(&header_name)
            .map(|value| value.to_str().unwrap().to_owned()),
        Some(computer.computer_id()),
        "the answer at /mcp names the computer that answered: {headers:?}"
    );
    assert!(headers.get("storage-work").is_none(), "ordinary forwarded replies add no measurement or trailer framing");
    assert!(headers.get(header::TRAILER).is_none(), "ordinary carried transport still receives no trailers");
    // An account's door alone sets no such header: the computer's listener does.
    let (_, own, _) = mcp_at(
        &executor,
        &computer.accounts()[0].app(),
        "/mcp",
        "computer.test",
        &key,
        &read_computers(),
    );
    assert!(own.get(&header_name).is_none(), "{own:?}");
    assert!(own.get("storage-work").is_none() && own.get(header::TRAILER).is_none());
    drop(forwarder.gateway);
}

/// A computer reached through another front (place-fsn1 is served through Caddy, not the forwarder) names itself on
/// every answer of its own listener (`answered_by_header`, its id): an MCP call under `/a/<address>`, a refusal for an
/// account it does not hold, and its sign-up page. Before, only the forwarder named the computer, so those answers
/// named none (measured on place-fsn1, 2026-11-04).
#[test]
fn every_answer_of_a_computers_own_listener_names_that_computer() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, _state, address, key) = one_account_computer(dir.path(), "own-name");
    let executor = two_threads();
    let listener = computer.app();
    let header_name: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/account/computers/settings.json"
    )))
    .unwrap();
    let header_name = header_name["answered_by_header"]
        .as_str()
        .unwrap()
        .to_owned();
    let named = |headers: &axum::http::HeaderMap| {
        headers
            .get(&header_name)
            .map(|value| value.to_str().unwrap().to_owned())
    };
    let (status, headers, answer) = mcp_at(
        &executor,
        &listener,
        &format!("/a/{address}/mcp"),
        "computer.test",
        &key,
        &read_computers(),
    );
    answered(status, &answer);
    assert_eq!(named(&headers), Some(computer.computer_id()), "{headers:?}");
    let (status, headers, _) = mcp_at(
        &executor,
        &listener,
        &format!("/a/{}/mcp", "b".repeat(64)),
        "computer.test",
        &key,
        &read_computers(),
    );
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        named(&headers),
        Some(computer.computer_id()),
        "a refusal names the computer too: {headers:?}"
    );
    let request = Request::builder()
        .method(Method::GET)
        .uri("/sign-up")
        .header(header::HOST, "computer.test")
        .body(Body::empty())
        .unwrap();
    let headers = executor.block_on(async {
        listener
            .clone()
            .oneshot(request)
            .await
            .unwrap()
            .headers()
            .clone()
    });
    assert_eq!(named(&headers), Some(computer.computer_id()), "{headers:?}");
}

/// A writer turn handed over between two whole computers (each its own `trillion-local serve` process, behind one
/// forwarder over verified TLS), not between copies in one process with a direct link (as
/// `a_second_computer_of_the_account_keeps_answering_reads_while_the_first_hands_its_writer_turn_over_for_a_release`).
/// Sign-up at A, whose config names A, B and C as the account's computers (all keep copies, may answer and vote). Writes
/// are acknowledged at A, the writer. A is stopped as its service manager stops it (SIGTERM): it hands its writer turn
/// over (`Computer::hand_over_on_stop`), so B or C takes writes before A's term would have run out, which a computer
/// that dies (SIGKILL) cannot do; no acknowledged write is lost.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_stopped_computer_hands_its_writer_turn_to_another_whole_computer_before_its_term_runs_out() {
    let numbers: Value =
        serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
    let term = Duration::from_millis(numbers["term_ms"].as_u64().unwrap());
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, wait: Duration, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + wait;
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(100));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 101, forwarder_host);
    let mut b = Peer::new(dir.path(), "b", 102, forwarder_host);
    let mut c = Peer::new(dir.path(), "c", 103, forwarder_host);
    let all = vec![a.id.clone(), b.id.clone(), c.id.clone()];
    let defaults = trillion_local::account::computers::DefaultComputers {
        keeps_copy: all.clone(),
        may_answer: all.clone(),
        kinds: Default::default(),
        voters: all,
    };
    a.set("default_places", serde_json::to_value(&defaults).unwrap());
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    c.start(&trust);
    let logs =
        |a: &Peer, b: &Peer, c: &Peer| format!("\nA: {}\nB: {}\nC: {}", a.log(), b.log(), c.log());

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(61).registration(&challenge, "Handed"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !(b.keeps(&owner) && c.keeps(&owner)) {
        assert!(
            Instant::now() < deadline,
            "B and C did not join the account{}",
            logs(&a, &b, &c)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    for peer in [&a, &b, &c] {
        installed_tools::install(&peer.account(&owner));
    }
    let first = sign_in_token(&address);
    let issue = tool(
        30,
        "@sign-in",
        "sign-in:issue-key",
        "handed-issue-key",
        json!({"name": "handed", "scopes": ["records", "sign-in"]}),
    );
    let (status, answer) = call_until(&first, &issue, Duration::from_secs(120), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "no key was issued at A: {answer}{}",
        logs(&a, &b, &c)
    );
    let key = answer["result"]["structuredContent"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let write = |n: u32| {
        tool(
            40 + u64::from(n),
            "@own-records",
            "records:write",
            &format!("handed-write-{n}"),
            json!({"records": [{"id": format!("handed-note-{n}"), "type": "note", "value": {"words": format!("HANDED_{n}")}}]}),
        )
    };
    let read = |n: u32, request: &str| {
        tool(
            80 + u64::from(n),
            "@own-records",
            "records:read",
            request,
            json!({"id": format!("handed-note-{n}")}),
        )
    };
    let words = |n: u32| {
        move |status: StatusCode, answer: &Value| {
            tool_ok(status, answer)
                && answer["result"]["structuredContent"]["value"]["words"]
                    == format!("HANDED_{n}").as_str()
        }
    };
    for n in 1..=3 {
        let (status, answer) = call_until(&key, &write(n), Duration::from_secs(120), &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "write {n} was not acknowledged: {answer}{}",
            logs(&a, &b, &c)
        );
    }
    assert!(
        a.log().contains("event=claimed"),
        "A took the writer turn: {}",
        a.log()
    );
    // B and C both answer, so a write lands on another computer only once it holds a term of its own.
    let deadline = Instant::now() + Duration::from_secs(60);
    while !(b.log().contains("event=door-composed") && c.log().contains("event=door-composed")) {
        assert!(
            Instant::now() < deadline,
            "B and C did not open their account routes{}",
            logs(&a, &b, &c)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }

    // A is stopped as its service manager stops it, and hands its writer turn over.
    a.ask_to_stop();
    let stopped = test_time::mark();
    let (status, answer) = call_until(&key, &write(4), term * 3, &tool_ok);
    let write_took = stopped.elapsed();
    assert!(
        tool_ok(status, &answer),
        "no write after A stopped: {answer}{}",
        logs(&a, &b, &c)
    );
    a.stop(false);
    eprintln!(
        "handover-measured write_after_stop_ms={} term_ms={}",
        write_took.as_millis(),
        term.as_millis()
    );
    assert!(
        a.log().contains("writer_turns_handed_over=1"),
        "A handed its writer turn over: {}",
        a.log()
    );
    assert!(write_took < term, "writes resumed {write_took:?} after the stop, not before A's term {term:?} would have run out{}",
        logs(&a, &b, &c));
    for n in 1..=4 {
        let (status, answer) = call_until(
            &key,
            &read(n, &format!("handed-read-{n}")),
            Duration::from_secs(30),
            &words(n),
        );
        assert!(
            words(n)(status, &answer),
            "acknowledged write {n} was lost: {answer}{}",
            logs(&a, &b, &c)
        );
    }
    b.stop(false);
    c.stop(false);
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// A loopback stand-in S3-compatible store: whole PUTs kept by path, every other request answered 404. It checks no
/// signature (src/account_files/objects.rs and examples/account_files_standin.rs prove signing apart).
fn put_keeping_store() -> (
    u16,
    Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
) {
    use std::io::{BufRead as _, Read as _, Write as _};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let kept: Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>> = Arc::default();
    let held = kept.clone();
    std::thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let held = held.clone();
            std::thread::spawn(move || {
                let mut reader = std::io::BufReader::new(client.try_clone().unwrap());
                let (mut first, mut length) = (String::new(), 0usize);
                reader.read_line(&mut first).unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap_or(0)
                        }
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                let mut words = first.split_whitespace();
                let (method, path) = (
                    words.next().unwrap_or("").to_owned(),
                    words.next().unwrap_or("").to_owned(),
                );
                let status = if method == "PUT" {
                    held.lock().unwrap().insert(path, body);
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let mut client = client;
                let _ = write!(
                    client,
                    "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                );
            });
        }
    });
    (port, kept)
}

/// Gap 1 of the re-proof (place-fsn1, 2026-11-04): a new account had a files store but no store that takes bytes, so
/// `write_file_piece` answered "the account has no store that takes new bytes". A computer whose config names a byte
/// store (`new_accounts.files`) gives every account it makes that store as its first origin, under the account's own
/// prefix, bound to the account's files, its secret in the account's vault as a signing root that no read gives back.
/// The account puts a file in through its door with no hand step; a config with no store makes an account as before.
#[test]
fn a_new_account_at_a_computer_that_names_a_byte_store_puts_a_file_in_from_the_start() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (port, kept) = put_keeping_store();
    let config_path = computer_config(&dir.path().join("bytes"), &shared_computer_key());
    let secret_file = dir.path().join("bytes/files-store.secret");
    fs::write(&secret_file, "synthetic-store-secret\n").unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["new_accounts"]["files"] = json!({"endpoint": format!("http://127.0.0.1:{port}"), "bucket": "synthetic-bucket",
        "region": "us-east-1", "key_id": "synthetic-key", "key_prefix": "accounts/", "secret_file": secret_file});
    fs::write(&config_path, config.to_string()).unwrap();
    let (owner, address) = create(&config_path);
    let state = dir.path().join("bytes/accounts").join(&owner);
    installed_tools::install(&state);
    let computer = Arc::new(
        Computer::start_with_clock(read_config(&config_path).unwrap(), clock())
            .unwrap_or_else(|error| panic!("{error}")),
    );
    let key = sign_in_token(&address);
    let executor = two_threads();
    let app = computer.accounts()[0].app();
    let call = |id: u64, operation: &str, input: Value| {
        let (status, _, answer) = mcp_at(
            &executor,
            &app,
            "/mcp",
            "computer.test",
            &key,
            &tool(id, "@namespace", operation, &format!("bytes-{id}"), input),
        );
        answered(status, &answer)
    };
    let upload_id = "0123456789abcdef0123456789abcdef";
    let bytes = b"synthetic bytes kept at the computer's store";
    use base64::Engine as _;
    call(
        1,
        "write_file_start",
        json!({"upload_id": upload_id, "name": "/kept.txt", "byte_length": bytes.len(), "media_type": "text/plain"}),
    );
    call(
        2,
        "write_file_piece",
        json!({"upload_id": upload_id, "name": "/kept.txt", "offset": 0,
        "content_base64": base64::engine::general_purpose::STANDARD.encode(bytes)}),
    );
    let finished = call(
        3,
        "write_file_finish",
        json!({"upload_id": upload_id, "name": "/kept.txt"}),
    );
    assert!(
        finished["identity"]
            .as_str()
            .is_some_and(|identity| identity.starts_with("1f:")),
        "{finished}"
    );
    let kept = kept.lock().unwrap();
    assert!(!kept.is_empty(), "the bytes reached the computer's store");
    assert!(
        kept.keys()
            .all(|path| path.contains(&format!("accounts/{owner}/"))),
        "under the account's own prefix: {:?}",
        kept.keys()
    );
    assert!(
        kept.values()
            .any(|body| body.windows(bytes.len()).any(|window| window == bytes)),
        "the bytes are the file's"
    );
    // The secret is held as a signing root: no read of the vault gives it back.
    let vault = trillion_local::secrets::open_home(&state, &owner).unwrap();
    let held = trillion_local::secrets::held_name("files-store", "secret").unwrap();
    assert!(
        vault.plain(&held).is_err(),
        "a signing root never leaves the vault"
    );
}

/// This test process composed as the binary is (src/main.rs `compose`): the platform binding the building target links.
fn compose_binding() {
    #[cfg(tool_sandbox = "landlock")]
    if let Some(binding) = computer_sandbox_landlock::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
    #[cfg(tool_sandbox = "sbpl")]
    if let Some(binding) = computer_sandbox_sbpl::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
}

/// Gap 2 of the re-proof (place-fsn1, 2026-11-04): a Linux computer started no tool process at all (`tool_sandbox` was
/// null there, so `workshop_tool_not_runnable_here`). With the Linux binding (crates/computer-sandbox-landlock), a
/// container tool run at a computer's door starts with its network contained: a run that declares no network answers,
/// and reaches no TCP socket; a run that declares records reaches its account's loopback door (#147) with its run
/// capability, and reads exactly the kind it declared.
#[cfg(all(target_os = "linux", tool_sandbox = "landlock"))]
#[test]
fn a_linux_computer_runs_container_tools_with_their_network_contained() {
    compose_binding();
    let Some(python) = ["/usr/local/bin/python3", "/usr/bin/python3"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
    else {
        return;
    };
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (computer, state, _address, _) = one_account_computer(dir.path(), "linux-tools");
    // A key that may run tools and read records.
    let issued = run(
        trillion_local::account::account_routes::command,
        &[
            "issue-key",
            state.to_str().unwrap(),
            "linux-tools",
            "records",
            "tools",
        ],
    );
    let key = issued.lines().next().unwrap().trim().to_owned();
    let read = trillion_local::record_value::account_routes::Door::shipped()
        .unwrap()
        .read_operation()
        .to_owned();
    // Two synthetic tools in the account's Workshop: one with no network that also tries a socket, one that declares
    // records and reads one through its door.
    let reads = format!(
        r#"
import json, os, urllib.request
door = json.loads(os.read(3, 65536))
call = {{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {{"name": "run_resource_operation",
  "arguments": {{"resource": door["resource"], "operation": "{read}", "request_key": "probe-read", "input": {{"id": "pursuit:none", "type": "pursuit"}}}}}}}}
asked = urllib.request.Request(door["url"], data=json.dumps(call).encode(), headers={{"Content-Type": "application/json",
  "Accept": "application/json, text/event-stream", "Authorization": "Bearer " + door["capability"]}})
answer = json.loads(urllib.request.urlopen(asked, timeout=10).read())
print(json.dumps({{"refused": "current_workspace_rights_refused" in json.dumps(answer), "answered": "result" in answer}}))
"#
    );
    let socket = r#"
import json, socket, errno
try:
    socket.create_connection(("127.0.0.1", 9), 2); said = "reached"
except OSError as e: said = errno.errorcode.get(e.errno, str(e.errno))
print(json.dumps({"socket": said}))
"#;
    let package = state.join("workshop/tools/linux-probe");
    fs::create_dir_all(&package).unwrap();
    let program = json!({"python3": {"at": python}});
    fs::write(package.join("tool-rows.json"), json!({"records": [
        {"payload": {"kind": "ai-tool-descriptor", "id": "probe-socket", "label": "Synthetic", "job": "synthetic",
            "invoke": {"kind": "container", "stdout": "json", "argv": ["python3", "-c", socket], "programs": program}, "result_selector": "$"}},
        {"payload": {"kind": "ai-tool-descriptor", "id": "probe-records", "label": "Synthetic", "job": "synthetic",
            "invoke": {"kind": "container", "stdout": "json", "argv": ["python3", "-c", reads], "programs": program,
                "records": {"fd": 3, "rights": [{"kind": "pursuit", "operations": [read]}]}}, "result_selector": "$"}},
    ]}).to_string()).unwrap();
    let executor = two_threads();
    let app = computer.accounts()[0].app();
    let run = |id: u64, tool: &str| {
        let body = json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "run_resource_operation",
            "arguments": {"address": "@workshop-tools", "method": "tools:run", "request_key": format!("linux-run-{id}"),
                "input": {"tool": tool, "input": {}}}}});
        let (status, _, answer) = mcp_at(&executor, &app, "/mcp", "computer.test", &key, &body);
        answered(status, &answer)
    };
    let socket = run(1, "probe-socket");
    assert_eq!(socket["exit_code"], 0, "{socket}");
    assert_eq!(
        socket["result"]["socket"], "EACCES",
        "a run with no network makes no TCP socket: {socket}"
    );
    let records = run(2, "probe-records");
    assert_eq!(records["exit_code"], 0, "{records}");
    assert_eq!(
        records["result"],
        json!({"refused": false, "answered": true}),
        "the run reached its door and read its kind: {records}"
    );
}

/// Item 1 of the J2 continuation (docs/placement-decision/stage-3-second-place.md): how fast a computer named in the row
/// fills an account from stamp 0 over the forwarder, with no file copy. Two `trillion-local serve` processes behind one
/// forwarder over verified TLS on loopback (not a real network: no latency, no bandwidth limit, both on one machine). A
/// alone is the first voter; `FILL_RECORDS` records of `FILL_WORDS` characters each are written at A; then B is added as
/// a computer that may answer and joins by itself; the test times until B's records store holds every record A wrote,
/// matched by count and identity, and prints `fill-measured`. Ignored by default (about a minute); run with
/// `cargo test --test computer_forwarder a_computer_added_to_an_account -- --ignored --nocapture`.
#[test]
#[ignore = "makes its account through the passkey sign-up routes, which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn a_computer_added_to_an_account_fills_it_from_stamp_0_over_the_forwarder_measured() {
    const FILL_RECORDS: u32 = 2_000;
    const FILL_WORDS: usize = 2_000;
    const PER_CALL: u32 = 20;
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let (_, identity) = localhost_tls(&tls);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str =
        Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    CALL_HOST.with(|host| host.set(forwarder_host));
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, real_clock()));
    let forwarder = gateway.http_route_table().unwrap();
    let serving =
        front_door::behind_tls(listener, identity, gateway.clone())
            .unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let until = shutdown.clone();
    std::thread::spawn(move || serving.serve(until));
    let rt = two_threads();
    let call_until =
        |key: &str, body: &Value, wait: Duration, done: &dyn Fn(StatusCode, &Value) -> bool| {
            let deadline = Instant::now() + wait;
            loop {
                let (status, _, answer) = mcp_call(&rt, &forwarder, key, body);
                if done(status, &answer) || Instant::now() > deadline {
                    return (status, answer);
                }
                clock().progress(deadline, Duration::from_millis(200));
            }
        };

    let mut a = Peer::new(dir.path(), "a", 95, forwarder_host).on_real_clock();
    let mut b = Peer::new(dir.path(), "b", 96, forwarder_host).on_real_clock();
    let mut new_accounts: Value =
        serde_json::from_str::<Value>(&fs::read_to_string(&a.config).unwrap()).unwrap()
            ["new_accounts"]
            .clone();
    new_accounts["copies"] = json!({"least_copy_keepers": 1, "least_voters": 1, "least_may_answer": 1, "least_always_on": 0});
    a.set("new_accounts", new_accounts);
    let trust = tls.join("ca.pem");
    a.start(&trust);
    b.start(&trust);
    let logs = |a: &Peer, b: &Peer| format!("\nA: {}\nB: {}", a.log(), b.log());

    let (status, given) = http(a.port, "POST", "/sign-up/options", ORIGIN, &json!({}));
    assert_eq!(status, 200, "{given}");
    let challenge = given["options"]["challenge"].as_str().unwrap().to_owned();
    let (status, done) = http(
        a.port,
        "POST",
        "/sign-up/finish",
        ORIGIN,
        &Authenticator::new(55).registration(&challenge, "Filled"),
    );
    assert_eq!(status, 200, "{done} {}", a.log());
    let address = done["address"].as_str().unwrap().to_owned();
    let owner = fs::read_dir(a.dir.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| !name.starts_with('.'))
        .unwrap();
    installed_tools::install(&a.account(&owner));
    let key = sign_in_token(&address);
    let mut id = 3_000;
    let mut next = || {
        id += 1;
        id
    };

    // A alone votes; the records go in at A.
    let first = tool(
        next(),
        "@sign-in",
        "sign-in:set-places",
        "fill-first",
        json!({"op": "set", "keeps_copy": [a.id], "may_answer": [a.id], "voters": [a.id]}),
    );
    let (status, answer) = call_until(&key, &first, Duration::from_secs(30), &tool_ok);
    assert!(tool_ok(status, &answer), "{answer}{}", logs(&a, &b));
    let words = "F".repeat(FILL_WORDS);
    let writing = Instant::now();
    for batch in 0..FILL_RECORDS / PER_CALL {
        let records: Vec<Value> = (0..PER_CALL).map(|n| {
            let k = batch * PER_CALL + n;
            json!({"id": format!("spread-note-{k:05}"), "type": "note", "value": {"words": format!("{k}{words}")}})
        }).collect();
        let body = tool(
            next(),
            "@own-records",
            "records:write",
            &format!("fill-write-{batch}"),
            json!({"records": records}),
        );
        let (status, answer) = call_until(&key, &body, Duration::from_secs(60), &tool_ok);
        assert!(
            tool_ok(status, &answer),
            "write {batch}: {answer}{}",
            logs(&a, &b)
        );
    }
    let write_ms = writing.elapsed().as_millis();
    let at_a = records_census(&a.account(&owner), None);
    assert_eq!(at_a.0, u64::from(FILL_RECORDS));
    let store_bytes = fs::metadata(a.account(&owner).join("records.sqlite"))
        .map(|meta| meta.len())
        .unwrap_or(0);

    // B is named: it joins by itself and fills from stamp 0 through the forwarder.
    let filling = Instant::now();
    let add = tool(
        next(),
        "@sign-in",
        "sign-in:set-places",
        "fill-add",
        json!({"op": "add-computer", "computer": b.id, "may_answer": true}),
    );
    let (status, answer) = call_until(&key, &add, Duration::from_secs(60), &tool_ok);
    assert!(
        tool_ok(status, &answer),
        "B was not added: {answer}{}",
        logs(&a, &b)
    );
    let added_ms = filling.elapsed().as_millis();
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut joined_ms = None;
    loop {
        if joined_ms.is_none() && b.keeps(&owner) {
            joined_ms = Some(filling.elapsed().as_millis());
        }
        if b.keeps(&owner)
            && b.account(&owner).join("records.sqlite").exists()
            && std::panic::catch_unwind(|| records_census(&b.account(&owner), None))
                .ok()
                .as_ref()
                == Some(&at_a)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "B did not fill the account; B's accounts folder: {:?}{}",
            fs::read_dir(b.dir.join("accounts"))
                .map(|entries| entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name())
                    .collect::<Vec<_>>())
                .ok(),
            logs(&a, &b)
        );
        clock().progress(deadline, Duration::from_millis(100));
    }
    let fill_ms = filling.elapsed().as_millis();
    let payload = u64::from(FILL_RECORDS) * (FILL_WORDS as u64 + 5);
    let parts = a.log().matches("op=\"places:relay\"").count()
        + b.log().matches("op=\"places:relay\"").count();
    eprintln!("fill-measured records={FILL_RECORDS} payload_bytes={payload} a_records_store_bytes={store_bytes} write_ms={write_ms} \
        b_added_ms={added_ms} b_folder_ms={} b_filled_ms={fill_ms} payload_mb_per_s={:.2} relayed_messages={parts}",
        joined_ms.unwrap_or(0), payload as f64 / 1_048_576.0 / (fill_ms as f64 / 1000.0));
    a.stop(false);
    b.stop(false);
    shutdown.store(true, std::sync::atomic::Ordering::Release);
}

/// The child harness supplies a clock explicitly; the production binary never reads these test variables.
#[test]
fn virtual_computer_process() {
    let Ok(address) = std::env::var("FORWARDER_TEST_CLOCK") else { return };
    let config = std::env::var_os("FORWARDER_TEST_CONFIG").unwrap();
    compose_binding();
    if std::env::var_os("FORWARDER_TEST_REAL_CLOCK").is_some() {
        let clock = std::sync::Arc::new(trillion_local::storage::time_source::RealClock);
        return trillion_local::native_entry::computer::run_with_clock(Path::new(&config), clock).unwrap();
    }
    let clock = test_time::FakeClock::child(&address);
    trillion_local::native_entry::computer::run_with_clock(Path::new(&config), clock).unwrap();
}
