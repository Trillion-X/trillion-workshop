// A second supplied TCP connection uses the existing session framing and the
// SAME selected owner. Device credentials/proof are explicitly synthetic test
// supplies; no production issuer or public connection is qualified here.
use super::*;
use crate::{
    forwarder::{
        self,
        session::{self, ConnectionAdmission, ConnectionGrant, ForwarderConnection},
        ComputerConnections, RouteDirectory,
    },
    record_log::CanonicalLogIds,
    resource_authority::InvokeMessage,
};
use std::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
    thread,
};

struct Directory(Route);
impl RouteDirectory for Directory {
    fn current_route(&self, account: &str, resource: &str) -> Option<Route> {
        (account == self.0.account_id && resource == self.0.resource_address)
            .then(|| self.0.clone())
    }
}
struct SuppliedRegistration(Route);
impl ConnectionAdmission for SuppliedRegistration {
    fn admit(&self, credential: &[u8], now: i64) -> Option<ConnectionGrant> {
        (credential == b"SYNTHETIC_DEVICE_CONNECTION_ONLY").then(|| ConnectionGrant { admission_identity: None,
            route: self.0.clone(),
            expires_at_ms: now + 30_000,
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, now: i64) -> bool {
        grant.route == self.0 && now < grant.expires_at_ms
    }
}
fn clock() -> i64 {
    i64::try_from(millis()).unwrap()
}
fn supplied_tcp(
    owner: Arc<Mutex<crate::native_boot::SelectedAccount>>,
    token: String,
    principal: Principal,
    route: Route,
    discard_reply: bool,
) -> (
    ForwarderConnection<TcpStream>,
    thread::JoinHandle<std::io::Result<()>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let device_route = route.clone();
    let worker = thread::spawn(move || {
        let stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let token = zeroize::Zeroizing::new(token);
        let mut ids = CanonicalLogIds::default();
        session::connect_mac_session(
            stream,
            b"SYNTHETIC_DEVICE_CONNECTION_ONLY",
            &device_route,
            clock,
            |bytes| {
                let message: InvokeMessage = serde_json::from_slice(bytes).map_err(|_| ())?;
                if message.client_authorization != "SYNTHETIC_ORIGINAL_KEY_PROOF_ONLY"
                    || clock() >= message.deadline_at_ms
                {
                    return Err(());
                }
                let call = Operation { person_present: None,
                    resource: message.resource_address,
                    operation: message.operation,
                    request_key: message.request_key,
                    input: message.input,
                };
                let result = owner
                    .lock()
                    .map_err(|_| ())?
                    .execute_personal_local_workspace_write(
                        token.as_bytes(),
                        &principal,
                        &call,
                        Arc::new(AtomicBool::new(false)),
                        Instant::now() + Duration::from_secs(3),
                        &mut ids,
                    )
                    .map_err(|_| ())?;
                if discard_reply {
                    return Err(());
                }
                let value: Value = serde_json::from_str(
                    &ecma_json::stringify(&result.value, Default::default()).map_err(|_| ())?,
                )
                .map_err(|_| ())?;
                serde_json::to_vec(
                    &json!({"state":"completed","request_id":message.request_id,"value":value}),
                )
                .map_err(|_| ())
            },
        )
    });
    let (stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let connection =
        ForwarderConnection::admit_from_stream(stream, Arc::new(SuppliedRegistration(route)), clock)
            .unwrap();
    connection.acknowledge().unwrap();
    (connection, worker)
}

#[tokio::test]
async fn sdk_and_second_tcp_connection_recover_one_original_key_after_lost_reply() {
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let selected = Arc::new(Mutex::new(fixture.selected()));
    let app =
        crate::native_boot::mcp_local::route_table(selected.clone(), "127.0.0.1:28788".into()).unwrap();
    let key = "actual-two-carrier-original";
    let response = app
        .oneshot(local_http_request(&fixture, key, "2026-07-28"))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    drop(response);
    let committed = state(&fixture);
    assert_eq!(committed.2, 1);
    let principal = fixture.principal();
    let call = operation(key, input());
    let mut current_route = route();
    current_route.generation = "synthetic-carrier-one".into();
    for discard_reply in [true, false] {
        let directory = Directory(current_route.clone());
        let (connection, worker) = supplied_tcp(
            selected.clone(),
            fixture.token.clone(),
            principal.clone(),
            current_route.clone(),
            discard_reply,
        );
        let result = forwarder::invoke_with_admission(
            &directory,
            &connection,
            clock,
            &principal,
            call.clone(),
            |actual, message| {
                assert_eq!(message.request_key, key);
                let mut owner = selected.lock().unwrap();
                let mut witness = owner
                    .authorize_personal_mcp_call(
                        fixture.token.as_bytes(),
                        &principal,
                        actual,
                        &call,
                    )
                    .map_err(|_| crate::mcp::OperationFailure { cause: (trillion_local::cause!()).into(),
                        code: "synthetic_source_refused".into(),
                        outcome_unknown: false,
                        detail: None,
                    })?;
                witness
                    .assert_current()
                    .map_err(|_| crate::mcp::OperationFailure { cause: (trillion_local::cause!()).into(),
                        code: "synthetic_source_changed".into(),
                        outcome_unknown: false,
                        detail: None,
                    })?;
                Ok(Some("SYNTHETIC_ORIGINAL_KEY_PROOF_ONLY".into()))
            },
        );
        if discard_reply {
            assert!(result.unwrap_err().outcome_unknown);
        } else {
            assert_eq!(result.unwrap(), json!({"written":1}));
        }
        assert_eq!(state(&fixture), committed);
        drop(connection);
        let terminal = worker.join().unwrap();
        if discard_reply {
            assert!(terminal.is_err());
        } else {
            terminal.unwrap();
        }
        current_route.generation = "synthetic-carrier-two".into();
    }
}
