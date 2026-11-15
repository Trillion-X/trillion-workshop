//! Opt-in integration with the official Workshop SDK checkout. Native proof construction, issuance, private pipes,
//! bearer authentication, HTTP/RMCP encoding, the actual native action handler and last-chunk memo checks are real.
//! Only the records value and physical binding are synthetic; no customer source or OS Trash action is reached.
use super::*;
use crate::{
    account::{account_routes::in_memory, signed_in::test_token},
    account_rights::run_capability::{self, Issued, Issuer, ParentKey, Refusal},
    mcp::http::{
        axum_adapter::{serve, Service},
        AuthenticationFailure, BearerAuthenticator,
    },
    tool_runs::tools::computer::{
        proof_controls::{with_proof, Fixture},
        ComputerRunProof,
    },
    tool_runs::{self, Bound, HeldInputs, NetworkPolicy, ToolCommand},
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

struct SourceIssuer<'a> {
    parent: ParentKey<'a>,
    proof: ComputerRunProof,
}
impl Issuer for SourceIssuer<'_> {
    fn issue(&self, records: &Value, lifetime: Duration) -> Result<Issued, Refusal> {
        self.parent.issue(records, lifetime)
    }
    fn issue_recordless(&self, declaration: &Value, lifetime: Duration) -> Result<Issued, Refusal> {
        self.parent.issue_recordless(declaration, lifetime)
    }
    fn computer_run_proof(&self) -> Option<ComputerRunProof> {
        Some(self.proof.clone())
    }
}
struct NativeAuth {
    inner: run_capability::Authenticator<account_routes::Authenticator>,
    parent: Arc<account_routes::SignIn>,
    fixture: Fixture,
    proof: ComputerRunProof,
    // Test-only boundary names; never bearer, descriptor, grant or source data.
    failures: std::sync::Mutex<Vec<&'static str>>,
}
impl BearerAuthenticator for NativeAuth {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        self.authenticate_current(bearer).ok()
    }
    fn authenticate_current(&self, bearer: &[u8]) -> Result<Principal, AuthenticationFailure> {
        self.fixture.choose_binding_for_this_thread();
        let answer = self.inner.authenticate_current(bearer);
        if answer.is_err() {
            let stage = match run_capability::held(bearer) {
                None => "request_not_a_run_capability",
                Some(Err(_)) => "run_not_live",
                Some(Ok(run)) if self.parent.authenticate(&run.parent).is_err() => {
                    "original_parent_authentication"
                }
                Some(Ok(run)) if run.current().is_err() => "native_run_proof_current",
                Some(Ok(_)) => "authentication_changed_during_check",
            };
            let mut failures = self.failures.lock().unwrap();
            failures.push(stage);
            if stage == "native_run_proof_current" {
                failures.extend(self.fixture.proof_failure_stages(&self.proof));
            }
        }
        answer
    }
}
struct NativeCalls {
    record_reads: AtomicUsize,
    fixture: Fixture,
}
impl CallAnswerer for NativeCalls {
    fn invoke(&self, _: &Principal, _: Operation) -> Result<Value, OperationFailure> {
        panic!("the real SDK must carry its authenticated request disclosure")
    }
    fn invoke_with_disclosure(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: Operation,
        disclosure: &crate::mcp::RequestDisclosure,
    ) -> Result<Value, OperationFailure> {
        self.fixture.choose_binding_for_this_thread();
        let run = run_capability::held(bearer)
            .ok_or_else(|| refusal("current_workspace_rights_refused", false))?
            .map_err(|_| refusal("current_workspace_rights_refused", false))?;
        let (resource, operation) = crate::tool_runs::tools::computer::shipped()
            .unwrap()
            .trash_source_route();
        if call.resource == resource && call.operation == operation {
            return LocalSelectedMcp::computer_action_at(
                principal,
                bearer,
                &call,
                Some(&run),
                disclosure,
                Arc::new(|| true),
                None,
            );
        }
        run.narrow(principal, &call)
            .map_err(|_| refusal("current_workspace_rights_refused", false))?;
        let door = crate::record_value::account_routes::Door::shipped().unwrap();
        if call.resource != door.resource()
            || call.operation != door.read_operation()
            || call.input != json!({"type":"note","id":"one"})
        {
            return Err(refusal("original_input_refused", false));
        }
        self.record_reads.fetch_add(1, Ordering::AcqRel);
        Ok(json!({"type":"note","value":{"text":"synthetic-record-from-fd3"}}))
    }
}
fn node() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH names the test Node runtime"))
        .map(|folder| folder.join("node"))
        .find(|path| path.is_file())
        .expect("Node is installed for the SDK integration")
}

#[test]
#[ignore = "requires WORKSHOP_SDK_TEST_ROOT pointing at the official Workshop checkout and its Node runtime"]
fn official_sdk_consumes_native_action_pipe_and_composed_record_pipe() {
    let sdk = PathBuf::from(
        std::env::var_os("WORKSHOP_SDK_TEST_ROOT").expect("explicit official SDK source checkout"),
    );
    assert!(sdk
        .join("tools/records-door/do-work/run-an-export.mjs")
        .is_file());
    for combined in [false, true] {
        let sdk = sdk.clone();
        with_proof(move |proof, fixture| {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let parent_key = test_token(fixture.account);
                let sign_in = in_memory("synthetic-sdk-native-parent",fixture.account);
                assert!(sign_in.authenticate(parent_key.as_bytes()).is_ok(),
                    "the original addressed parent must authenticate before issuing SDK pipes");
                let auth = Arc::new(NativeAuth {inner:run_capability::Authenticator::new(account_routes::Authenticator(sign_in.clone())),
                    parent:sign_in,fixture:fixture.clone(),proof:proof.clone(),failures:std::sync::Mutex::new(Vec::new())});
                let calls = Arc::new(NativeCalls {record_reads:AtomicUsize::new(0),fixture:fixture.clone()});
                let service = Service::new(address.to_string(),auth.clone(),calls.clone()).unwrap();
                let server = tokio::spawn(async move { serve(listener,service).await });
                let issuer = SourceIssuer { parent:ParentKey {address:"synthetic-address",account:fixture.account,bearer:parent_key.as_bytes(),door:address,cause:None},proof };
                let actions = issuer.issue_computer_run(&json!({"fd":if combined {7} else {3}}),Duration::from_secs(60),fixture.of.clone()).unwrap();
                let records = combined.then(|| issuer.issue_run(&json!({"fd":3,"rights":[{"kind":"note","id":"one","operations":[crate::record_value::account_routes::Door::shipped().unwrap().read_operation()]}]}),Duration::from_secs(60),fixture.of.clone()).unwrap());
                assert!(auth.authenticate_current(actions.capability.token().as_bytes()).is_ok(),
                    "action pipe preflight failed: {:?}", auth.failures.lock().unwrap());
                if let Some(records) = &records {
                    assert!(auth.authenticate_current(records.capability.token().as_bytes()).is_ok(),
                        "record pipe preflight failed: {:?}", auth.failures.lock().unwrap());
                }
                let files = tempfile::tempdir().unwrap();
                let export = if combined {
                    let module = files.path().join("both.mjs");
                    std::fs::write(&module,"export async function both(input,{door,parentActions}) { const value=await door.read('note','one'); const first=await parentActions.trashSource(input); const retry=await parentActions.trashSource(input); return {value,first,retry}; }\n").unwrap(); module
                } else { sdk.join("tools/records-door/test/sample-tool.mjs") };
                let mut descriptors=vec![(actions.fd,actions.descriptor.clone())];
                if let Some(records)=&records { descriptors.push((records.fd,records.descriptor.clone())); }
                let command=ToolCommand {request_key:format!("synthetic-sdk-dual-{combined}"),executable:node(),
                    args:vec![sdk.join("tools/records-door/do-work/run-an-export.mjs").to_string_lossy().into_owned(),
                        export.to_string_lossy().into_owned(),if combined {"both"} else {"trashOne"}.into(),
                        "--parent-actions-fd".into(),actions.fd.to_string()],
                    cwd:files.path().to_owned(),deadline_ms:60_000,until_ms:None,max_output_bytes:64*1024,
                    max_memory_bytes:None,memory_read_every_ms:None,open_ended:false,network:NetworkPolicy::Door,
                    containment:None,local_doors:Vec::new(),environment:BTreeMap::new(),
                    stdin:Some(json!({"path":fixture.source,"expected_generation":fixture.generation}).to_string()),
                    held:HeldInputs {environment:Vec::new(),descriptors},bound:Bound {door:Some(address.port()),..Bound::default()},
                    withhold_input:false,warm:None};
                let report=tokio::task::spawn_blocking(move || tool_runs::execute(&command)).await.unwrap().unwrap();
                let stdout=String::from_utf8(STANDARD_NO_PAD.decode(&report.stdout_b64).unwrap()).unwrap();
                let stderr=String::from_utf8(STANDARD_NO_PAD.decode(&report.stderr_b64).unwrap()).unwrap();
                assert_eq!(report.exit_code,Some(0),
                    "SDK combined={combined}; stdout={stdout}; stderr={stderr}; native_auth_failures={:?}",
                    auth.failures.lock().unwrap());
                let result:Value=serde_json::from_str(stdout.trim()).unwrap();
                if combined {
                    assert_eq!(result,json!({"result":{"value":{"text":"synthetic-record-from-fd3"},"first":{"outcome":"moved"},"retry":{"outcome":"moved"}}}));
                    assert_eq!(calls.record_reads.load(Ordering::Acquire),1);
                } else { assert_eq!(result,json!({"result":{"outcome":"moved"}})); }
                assert_eq!(fixture.calls(),1,"exact SDK retry reads the saved memo without a second effect");
                assert!(fixture.source.is_file(),"the synthetic physical binding never moves or deletes the source");
                drop(records);drop(actions);server.abort();
            });
        });
    }
}
