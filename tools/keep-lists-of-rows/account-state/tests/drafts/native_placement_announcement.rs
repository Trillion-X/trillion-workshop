    /// The selected request owner can be busy while a new account tells its placement. This uses an actual native
    /// account, vault, SignIn and Copies, not a boolean stand-in for the bounded owner acquisition. The separate
    /// exact test process preserves the native source/report owners' once-per-process contract in the full suite.
    #[test]
    fn a_new_accounts_signed_placement_remains_available_while_its_request_owner_is_held() {
        use base64::Engine as _;
        use crate::{account::computers::{ComputerSigner, DefaultComputers}, secrets::secrets_key::ComputerKey};
        if !std::env::args().any(|arg| arg == "--exact") {
            let name = std::thread::current().name().unwrap().to_owned();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--nocapture", "--test-threads=1"]).output().unwrap();
            assert!(output.status.success(), "isolated native placement fixture failed: {}{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            return;
        }
        assert!(std::env::var_os("CREDENTIAL_HOME_STORE").is_none(), "the synthetic fixture cannot open a redirected vault");
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let accounts = root.join("accounts");
        fs::create_dir(&accounts).unwrap();
        let key_file = root.join("computer.key");
        fs::write(&key_file, base64::engine::general_purpose::STANDARD.encode([29u8; 32])).unwrap();
        let key = ComputerKey::read(&key_file).unwrap();
        let me = ComputerSigner::of(&key).unwrap().computer_id();
        let peer_key = ComputerKey::from_bytes(vec![30u8; 32]).unwrap();
        let peer = ComputerSigner::of(&peer_key).unwrap().computer_id();
        let config_file = root.join("computer.json");
        fs::write(&config_file, serde_json::json!({
            "listen":"127.0.0.1:7199", "accounts":accounts, "place_key_file":key_file,
            "public_origin":"https://computer.test", "tools_at_start":false,
            "report":{"storage":{"keep_free_bytes":0},"reach":"https://computer.test",
                "cost_per_month_cents":0,"contained_tools":false,"takes_new_accounts":false},
            "sign_in":{"relying_party_drop_labels":1,"max_body_bytes":16384,"expired_rows_per_write":100},
            "new_accounts":crate::account::rows::StartingRows::for_tests(),
        }).to_string()).unwrap();
        let config = super::super::read_config(&config_file).unwrap();
        computers::choose_this_computer(config.report.clone()).unwrap();
        let made = create::create_named(&accounts, &key, config.starting_rows().unwrap()).unwrap();
        let state = accounts.join(&made.owner_id);
        let secrets_key = crate::secrets::secrets_key::open_sealed_with(&state, &key).unwrap();
        let vault = crate::secrets::open_with_secrets_key(&state, &made.owner_id, &secrets_key).unwrap();
        let account_key = computers::kept_account_key(&vault).unwrap();
        let raw = rows::open(&state).unwrap();
        computers::land_new_account_in(&Store::new(&*raw), &made.user_id, &DefaultComputers {
            keeps_copy:vec![me.clone(),peer.clone()], may_answer:vec![me.clone()], voters:vec![me.clone(),peer.clone()],
            kinds: Default::default(),
        }, &account_key).unwrap();
        drop(vault);
        let computer = Arc::new(Computer::start(config).unwrap());
        let account = computer.find(&made.address).unwrap();
        assert!(account.copies().is_some(), "the actual native account runs copies");
        assert!(account.idle(), "no foreground request or timer supplies a later notification");
        let before = computer.current_row(&made.address).unwrap();
        assert!(before.believed(&made.address));
        assert!(before.row.copy_keepers.contains(&peer));
        let _held = account.owner.lock().unwrap();
        assert!(crate::native_boot::forwarder_connection::told(&account.owner, &me).is_empty(),
            "the existing bounded selected-owner read really cannot acquire this owner");
        let during = computer.current_row(&made.address).expect("placement cannot disappear with request-owner contention");
        assert_eq!(during, before, "the announcement keeps the same signed row and genuine account public key");
        assert!(during.believed(&made.address));
    }

    /// A sign-up can land after the wide session froze its initial list but before registration is admitted. Its
    /// first, genuine signed announcement is refused then. Admission must reconcile the new account before dispatch,
    /// without a timer, request, sleep, fabricated placement or wider wait.
    #[test]
    fn a_new_idle_account_is_announced_after_its_initial_session_snapshot_is_admitted() {
        use std::{io::{Read, Write}, net::{Shutdown, TcpListener, TcpStream}, sync::{mpsc, atomic::{AtomicBool, AtomicUsize}}, time::Duration};
        use tower::ServiceExt as _;
        if !std::env::args().any(|arg| arg == "--exact") {
            let name = std::thread::current().name().unwrap().to_owned();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--nocapture", "--test-threads=1"]).output().unwrap();
            assert!(output.status.success(), "isolated admission placement fixture failed: {}{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            return;
        }
        let (_temporary, computer, key, accounts) = empty_placement_computer();
        let me = computer.computer_id();
        let gateway = Arc::new(crate::forwarder::gateway::Gateway::with_computers("forwarder.test", std::sync::Arc::new(crate::storage::time_source::RealClock)));
        let http = gateway.http_route_table().unwrap();
        fn announce(computer: &Arc<Computer>, address: &str, http: &axum::Router) -> axum::http::StatusCode {
            let told = computer.current_row(address).expect("the actual account retains its signed row");
            assert!(told.believed(address));
            let settings = computers::settings();
            let body = serde_json::to_vec(&computers::messages::TellAgain { told, catching_up: false }).unwrap();
            let proof = computer.signer.message_credential(address, super::super::now_ms());
            let request = axum::http::Request::builder().method("POST")
                .uri(format!("/a/{address}/{}/{}", settings.message_path, settings.tell_again_path))
                .header("host", "forwarder.test").header("authorization", format!("Bearer {proof}"))
                .header("content-type", "application/json").body(axum::body::Body::from(body)).unwrap();
            let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
            runtime.block_on(async { http.clone().oneshot(request).await.unwrap().status() })
        }

        // This wrapper only observes frame boundaries. The server still admits the genuine computer credential and
        // the actual initially empty kept list through Gateway::admit_mac_connection.
        struct AroundAck {
            stream: TcpStream,
            snapshot: Option<mpsc::Sender<()>>,
            dispatch: Option<mpsc::Sender<()>>,
            ack: Vec<u8>,
            ack_complete: bool,
        }
        impl Read for AroundAck {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if let Some(snapshot) = self.snapshot.take() { snapshot.send(()).unwrap(); }
                if self.ack_complete {
                    if let Some(dispatch) = self.dispatch.take() { dispatch.send(()).unwrap(); }
                }
                let count = self.stream.read(bytes)?;
                if !self.ack_complete {
                    self.ack.extend_from_slice(&bytes[..count]);
                    if self.ack.len() >= 4 {
                        let length = u32::from_be_bytes(self.ack[..4].try_into().unwrap()) as usize;
                        self.ack_complete = self.ack.len() == 4 + length;
                    }
                }
                Ok(count)
            }
        }
        impl Write for AroundAck {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.stream.write(bytes) }
            fn flush(&mut self) -> std::io::Result<()> { self.stream.flush() }
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let wire = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let close = wire.try_clone().unwrap();
        let (allow, admitted) = mpsc::channel();
        let accepting = gateway.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            admitted.recv().unwrap();
            accepting.admit_mac_connection(stream).unwrap()
        });
        let (snapshot, snapshotted) = mpsc::channel();
        let (dispatch, dispatching) = mpsc::channel();
        let announced = Arc::new(AtomicUsize::new(0));
        let seen = announced.clone();
        let serving = computer.clone();
        let stop = Box::leak(Box::new(AtomicBool::new(false)));
        let callback_http = http.clone();
        let client = std::thread::spawn(move || {
            serving.serve_computer_session_announcing(AroundAck {
                stream: wire, snapshot: Some(snapshot), dispatch: Some(dispatch), ack: Vec::new(), ack_complete: false,
            }, stop, |computer, address| {
                assert_eq!(announce(computer, address, &callback_http), axum::http::StatusCode::OK);
                seen.fetch_add(1, Ordering::AcqRel);
            })
        });
        snapshotted.recv_timeout(Duration::from_secs(30)).unwrap();

        let (_account, address) = add_idle_placement_account(&computer, &accounts, &key);
        assert_eq!(announce(&computer, &address, &http), axum::http::StatusCode::CONFLICT,
            "the first valid announcement really precedes session admission");
        assert!(computer.told_rows.lock().unwrap().get(&address).is_none());
        allow.send(()).unwrap();
        dispatching.recv_timeout(Duration::from_secs(30)).unwrap();
        let count = announced.load(Ordering::Acquire);
        close.shutdown(Shutdown::Both).unwrap();
        server.join().unwrap();
        client.join().unwrap().unwrap();
        assert_eq!(count, 1, "an idle account created after the frozen list is announced after admission");
        assert_eq!(computer.background().timer_steps, 0, "registration reconciliation needed no timer");
        assert_eq!(me, computer.computer_id());
    }

    fn empty_placement_computer() -> (tempfile::TempDir, Arc<Computer>, crate::secrets::secrets_key::ComputerKey, PathBuf) {
        use base64::Engine as _;
        use crate::secrets::secrets_key::ComputerKey;
        assert!(std::env::var_os("CREDENTIAL_HOME_STORE").is_none());
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let accounts = root.join("accounts");
        fs::create_dir(&accounts).unwrap();
        let key_file = root.join("computer.key");
        fs::write(&key_file, base64::engine::general_purpose::STANDARD.encode([31u8; 32])).unwrap();
        let key = ComputerKey::read(&key_file).unwrap();
        let config_file = root.join("computer.json");
        fs::write(&config_file, serde_json::json!({
            "listen":"127.0.0.1:7199", "accounts":accounts, "place_key_file":key_file,
            "public_origin":"https://computer.test", "tools_at_start":false,
            "report":{"storage":{"keep_free_bytes":0},"reach":"https://computer.test",
                "cost_per_month_cents":0,"contained_tools":false,"takes_new_accounts":false},
            "sign_in":{"relying_party_drop_labels":1,"max_body_bytes":16384,"expired_rows_per_write":100},
            "new_accounts":crate::account::rows::StartingRows::for_tests(),
        }).to_string()).unwrap();
        let config = super::super::read_config(&config_file).unwrap();
        let computer = Arc::new(Computer::start(config).unwrap());
        assert!(computer.accounts().is_empty());
        (temporary, computer, key, accounts)
    }

    fn add_idle_placement_account(computer: &Arc<Computer>, accounts: &Path, key: &crate::secrets::secrets_key::ComputerKey)
        -> (Arc<super::super::ComputerAccount>, String)
    {
        let made = create::create_named(accounts, key, computer.config.starting_rows().unwrap()).unwrap();
        let state = accounts.join(&made.owner_id);
        let local = super::super::open_account(&state).unwrap();
        let account = Arc::new(super::super::compose_account(&computer.config, &state, local).unwrap());
        computer.accounts.lock().unwrap().push(account.clone());
        computer.start_copies(&account);
        assert!(account.copies().is_none(), "the account is alone, with no voter timer");
        assert!(account.idle());
        (account, made.address)
    }

    #[test]
    fn an_idle_account_without_copies_keeps_its_signed_placement_while_its_request_owner_is_held() {
        if !std::env::args().any(|arg| arg == "--exact") {
            let name = std::thread::current().name().unwrap().to_owned();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--nocapture", "--test-threads=1"]).output().unwrap();
            assert!(output.status.success(), "isolated voter-free placement fixture failed: {}{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            return;
        }
        let (_temporary, computer, key, accounts) = empty_placement_computer();
        let (account, address) = add_idle_placement_account(&computer, &accounts, &key);
        let before = computer.current_row(&address).unwrap();
        assert!(before.believed(&address));
        let _held = account.owner.lock().unwrap();
        assert!(crate::native_boot::forwarder_connection::told(&account.owner, &computer.computer_id()).is_empty(),
            "the foreground selected owner really cannot be acquired");
        let during = computer.current_row(&address).expect("the signed voter-free placement cannot disappear with request contention");
        assert_eq!(during, before);
        assert!(during.believed(&address));
        assert!(account.copies().is_none());
        assert_eq!(computer.background().timer_steps, 0);
    }


    /// The sender's own publication can fail after registration has already finished. Its existing peer
    /// bootstrap worker must recover that prerequisite even when the new account is idle and no timer runs.
    /// This uses the genuine native account/key, native wire admission and authenticated forwarder routes;
    /// the first HTTP 503 is a controlled transport refusal, never a fabricated successful acknowledgement.
    #[test]
    fn an_idle_copy_bootstrap_retries_a_refused_own_announcement() {
        check_idle_bootstrap_announcement_recovery(true);
    }

    #[test]
    fn an_idle_account_without_copies_retries_a_refused_own_announcement() {
        check_idle_bootstrap_announcement_recovery(false);
    }

    fn check_idle_bootstrap_announcement_recovery(with_peers: bool) {
        use std::{net::{Shutdown, TcpListener, TcpStream}, sync::{mpsc, atomic::AtomicBool}, time::Duration};
        use tower::ServiceExt as _;
        use crate::{account::computers::{ComputerSigner, DefaultComputers}, secrets::secrets_key::ComputerKey};
        if !std::env::args().any(|arg| arg == "--exact") {
            let name = std::thread::current().name().unwrap().to_owned();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--nocapture", "--test-threads=1"]).output().unwrap();
            assert!(output.status.success(), "isolated announcement recovery fixture failed: {}{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            return;
        }
        let (_temporary, computer, key, accounts) = empty_placement_computer();
        let me = computer.computer_id();
        let peer = ComputerSigner::of(&ComputerKey::from_bytes(vec![33u8; 32]).unwrap()).unwrap().computer_id();
        let gateway = Arc::new(crate::forwarder::gateway::Gateway::with_computers("forwarder.test", std::sync::Arc::new(crate::storage::time_source::RealClock)));
        let http = gateway.http_route_table().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let wire = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let close = wire.try_clone().unwrap();
        let accepting = gateway.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            accepting.admit_mac_connection(stream).unwrap()
        });
        let serving = computer.clone();
        let client = std::thread::spawn(move || {
            let now = super::super::now_ms();
            let credential = serving.signer.session_credential(&serving.computer_id(), now);
            let (route, _) = crate::forwarder::remote_connection_check::computer_route(&credential, now).unwrap();
            let owner = serving.clone();
            let messages: crate::native_boot::forwarder_connection::ComputerMessages = Arc::new(move |bytes| {
                let sent = crate::resource_authority::decode_message(bytes).ok()?;
                owner.computer_message(&sent.account_id, bytes)
            });
            crate::native_boot::forwarder_connection::connect_door_less_session(
                wire, credential.as_bytes(), &route, &[], std::sync::Arc::new(crate::storage::time_source::RealClock), messages, "not_served_here")
        });
        assert_eq!(server.join().unwrap().device_id, me, "the real empty wide session is published before this account exists");

        let made = create::create_named(&accounts, &key, computer.config.starting_rows().unwrap()).unwrap();
        let state = accounts.join(&made.owner_id);
        let secrets_key = crate::secrets::secrets_key::open_sealed_with(&state, &key).unwrap();
        let vault = crate::secrets::open_with_secrets_key(&state, &made.owner_id, &secrets_key).unwrap();
        let account_key = computers::kept_account_key(&vault).unwrap();
        let raw = rows::open(&state).unwrap();
        computers::land_new_account_in(&Store::new(&*raw), &made.user_id, &DefaultComputers {
            keeps_copy:if with_peers { vec![me.clone(),peer.clone()] } else { vec![me.clone()] },
            may_answer:vec![me.clone()],
            voters:if with_peers { vec![me.clone(),peer] } else { Vec::new() },
            kinds: Default::default(),
        }, &account_key).unwrap();
        drop(vault);
        let local = super::super::open_account(&state).unwrap();
        let account = Arc::new(super::super::compose_account(&computer.config, &state, local).unwrap());
        computer.accounts.lock().unwrap().push(account.clone());
        computer.start_copies(&account);
        assert_eq!(account.copies().is_some(), with_peers);
        assert!(account.idle());
        let address = made.address;
        let told = computer.current_row(&address).unwrap();
        assert!(told.believed(&address));

        fn post(computer: &Arc<Computer>, address: &str, http: &axum::Router, tail: &str, body: serde_json::Value)
            -> (axum::http::StatusCode, Vec<u8>)
        {
            let proof = computer.signer.message_credential(address, super::super::now_ms());
            let request = axum::http::Request::builder().method("POST")
                .uri(format!("/a/{address}/{}/{tail}", computers::settings().message_path))
                .header("host", "forwarder.test").header("authorization", format!("Bearer {proof}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap())).unwrap();
            let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
            runtime.block_on(async {
                let response = http.clone().oneshot(request).await.unwrap();
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), computers::settings().message_body_bytes).await.unwrap();
                (status, body.to_vec())
            })
        }
        let message = computers::messages::Post { message: Message::Holding };
        assert_eq!(post(&computer, &address, &http, &me, serde_json::to_value(&message).unwrap()).0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE, "an admitted computer alone supplies no account route");
        let unavailable = axum::Router::new().fallback(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE });
        let first = computers::messages::TellAgain { told, catching_up: computer.catching_up(&address) };
        assert_eq!(post(&computer, &address, &unavailable, &http_path(), serde_json::to_value(first).unwrap()).0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE, "the first publication is actually refused");
        assert!(computer.told_rows.lock().unwrap().get(&address).is_none());
        fn http_path() -> String { computers::settings().tell_again_path.clone() }

        let stop = Box::leak(Box::new(AtomicBool::new(false)));
        let stop: &'static AtomicBool = stop;
        computer.forwarder_stop.set(stop).unwrap();
        let (published, publication) = mpsc::channel();
        let retry_http = http.clone();
        let worker = computer.tell_copy_keepers_announcing(&address, move |computer, address| {
            let told = computer.current_row(address).unwrap();
            assert!(told.believed(address));
            let body = computers::messages::TellAgain { told, catching_up: computer.catching_up(address) };
            let status = post(computer, address, &retry_http, &http_path(), serde_json::to_value(body).unwrap()).0;
            published.send(status).unwrap();
            stop.store(true, Ordering::Release);
            status == axum::http::StatusCode::OK
        });
        let announced = if worker.is_some() { publication.recv_timeout(Duration::from_secs(3)).ok() } else { None };
        stop.store(true, Ordering::Release);
        let worker_result = worker.map(|worker| worker.join());
        let (status, answer) = post(&computer, &address, &http, &me, serde_json::to_value(&message).unwrap());
        close.shutdown(Shutdown::Both).unwrap();
        let client_result = client.join();
        assert!(client_result.is_ok());
        assert!(worker_result.is_some_and(|result| result.is_ok()),
            "the same bootstrap lifetime must publish with or without peers; routed readback was {status}");
        assert_eq!(announced, Some(axum::http::StatusCode::OK),
            "the existing worker must retry the sender publication; actual routed readback was {status}");
        assert_eq!(status, axum::http::StatusCode::OK, "the same real forwarder now routes the signed row to the native account");
        let Answer::Holding { holding } = serde_json::from_slice::<Answer>(&answer).unwrap() else {
            panic!("the native account owner did not return its signed placement")
        };
        assert!(holding.row.believed(&address));
        assert_eq!(holding.row.row, computer.current_row(&address).unwrap().row);
        assert_eq!(computer.background().timer_steps, 0, "recovery uses no account timer or foreground request");
    }
