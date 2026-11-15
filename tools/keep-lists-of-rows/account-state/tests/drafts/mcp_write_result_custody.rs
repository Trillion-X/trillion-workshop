// Opposing last-chunk controls over the real synthetic selected account,
// original SDK adapter, key issuer, workspace writer and canonical journal.
use super::*;
use std::sync::Mutex;
use tower::ServiceExt;

#[tokio::test]
async fn mcp_write_result_key_withdrawn_after_handler_before_first_chunk_is_withheld() {
    let fixture=Fixture::new();
    let owner=Arc::new(Mutex::new(fixture.selected()));
    let app=crate::native_boot::mcp_local::route_table(owner,"127.0.0.1:28788".into()).unwrap();
    let response=app.oneshot(local_http_request(&fixture,"write-output-withdraw-key","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);
    let committed=state(&fixture);assert_eq!(committed.2,1);assert!(committed.1>0);
    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap()
        .execute("DELETE FROM _mf_entries WHERE key LIKE 'personal-key:%'",[]).unwrap();
    let bytes=axum::body::to_bytes(response.into_body(),65_536).await;
    assert!(bytes.is_err(),"a committed write result escaped after its original personal key was withdrawn");
    assert_eq!(state(&fixture),committed,"withholding must not undo/repeat the original effect");
}

#[tokio::test]
async fn mcp_write_result_rights_withdrawn_after_handler_before_first_chunk_is_withheld() {
    let fixture=Fixture::new();
    let owner=Arc::new(Mutex::new(fixture.selected()));
    let app=crate::native_boot::mcp_local::route_table(owner,"127.0.0.1:28788".into()).unwrap();
    let response=app.oneshot(local_http_request(&fixture,"write-output-withdraw-rights","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);
    let committed=state(&fixture);assert_eq!(committed.2,1);
    change_gate(&fixture,"own.sqlite",|state|{
        state["sign_ins"][&fixture.signin]["chosen"]=json!({"private":false,"spaces":[]});
    });
    let bytes=axum::body::to_bytes(response.into_body(),65_536).await;
    assert!(bytes.is_err(),"a committed write result escaped after current private rights were withdrawn");
    assert_eq!(state(&fixture),committed);
}

#[tokio::test]
async fn mcp_write_result_lost_body_original_key_retry_recovers_one_effect() {
    let fixture=Fixture::new();
    let owner=Arc::new(Mutex::new(fixture.selected()));
    let app=crate::native_boot::mcp_local::route_table(owner,"127.0.0.1:28788".into()).unwrap();
    let response=app.clone().oneshot(local_http_request(&fixture,"write-output-lost-body","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);drop(response);
    let committed=state(&fixture);assert_eq!(committed.2,1);
    let response=app.oneshot(local_http_request(&fixture,"write-output-lost-body","2026-07-28")).await.unwrap();
    let bytes=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();
    let value:Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(value["result"]["structuredContent"]["written"],1);
    assert_eq!(state(&fixture),committed,"result recovery must use the exact original command");
}

#[tokio::test]
async fn mcp_write_result_erased_original_key_before_first_chunk_is_withheld() {
    let fixture=Fixture::new();
    let app=crate::native_boot::mcp_local::route_table(Arc::new(Mutex::new(fixture.selected())),"127.0.0.1:28788".into()).unwrap();
    let response=app.oneshot(local_http_request(&fixture,"write-output-result-erased","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);let committed=state(&fixture);
    let db=Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let permit:String=db.query_row("SELECT permit_id FROM resource_behavior_commands",[],|row|row.get(0)).unwrap();
    // The original key decoder honors this actual erasure tombstone even
    // when the original key lived in the canonical key/record projection.
    db.execute_batch("BEGIN IMMEDIATE;UPDATE record_log SET keys=NULL WHERE keys IS NOT NULL;").unwrap();
    db.execute("INSERT OR REPLACE INTO record_erasable_keys VALUES(?,NULL,'erased','[\"value\"]')",
        [format!("resource-command-result:{permit}")]).unwrap();
    db.execute_batch("COMMIT").unwrap();
    assert!(axum::body::to_bytes(response.into_body(),65_536).await.is_err());
    assert_eq!(state(&fixture),committed);
}

#[tokio::test]
async fn mcp_write_result_missing_original_journal_never_dispatches_a_replacement_effect() {
    let fixture=Fixture::new();
    let app=crate::native_boot::mcp_local::route_table(Arc::new(Mutex::new(fixture.selected())),"127.0.0.1:28788".into()).unwrap();
    let response=app.oneshot(local_http_request(&fixture,"write-output-journal-erased","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);
    assert_eq!(Connection::open(fixture.root.join("records.sqlite")).unwrap().execute("DELETE FROM resource_behavior_commands",[]).unwrap(),1);
    let erased=state(&fixture);assert_eq!(erased.2,0);
    assert!(axum::body::to_bytes(response.into_body(),65_536).await.is_err());
    assert_eq!(state(&fixture),erased,"chunk recovery cannot restage missing execution or a new command");
}

#[tokio::test]
async fn mcp_write_result_original_source_reservation_lives_until_chunk_owner_drops() {
    use http_body::Body as HttpBody;
    let fixture=Fixture::new();
    let app=crate::native_boot::mcp_local::route_table(Arc::new(Mutex::new(fixture.selected())),"127.0.0.1:28788".into()).unwrap();
    let response=app.oneshot(local_http_request(&fixture,"write-output-retained-frame","2026-07-28")).await.unwrap();
    let mut body=response.into_body();
    let chunk=std::future::poll_fn(|cx|std::pin::Pin::new(&mut body).poll_frame(cx)).await.unwrap().unwrap();
    let bytes=chunk.into_data().unwrap();drop(body);
    let value:Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(value["result"]["structuredContent"]["written"],1);
    let writer=Connection::open(fixture.root.join("records.sqlite")).unwrap();writer.busy_timeout(Duration::ZERO).unwrap();
    assert!(writer.execute("UPDATE workspace_records SET written_at=written_at WHERE label='saved-board'",[]).is_err(),
        "actual source reservation was dropped before the transport finished with its chunk");
    drop(bytes);
    assert_eq!(writer.execute("UPDATE workspace_records SET written_at=written_at WHERE label='saved-board'",[]).unwrap(),1);
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn mcp_write_result_original_source_is_held_through_actual_connection_flush() {
    use std::io::{self,Read,Write};
    use std::sync::atomic::Ordering;
    struct FlushProbe {input:io::Cursor<Vec<u8>>,path:std::path::PathBuf,flushes:usize,held:Arc<AtomicBool>}
    impl Read for FlushProbe {fn read(&mut self,b:&mut[u8])->io::Result<usize>{self.input.read(b)}}
    impl Write for FlushProbe {
        fn write(&mut self,b:&[u8])->io::Result<usize>{Ok(b.len())}
        fn flush(&mut self)->io::Result<()> {
            self.flushes+=1;
            if self.flushes==2 {
                let db=Connection::open(&self.path).unwrap();db.busy_timeout(Duration::ZERO).unwrap();
                self.held.store(db.execute("UPDATE workspace_records SET written_at=written_at WHERE label='saved-board'",[]).is_err(),Ordering::Release);
            }
            Ok(())
        }
    }
    let fixture=Fixture::new();let route=Route{account_id:OWNER.into(),device_id:"synthetic-flush-device".into(),resource_address:"@own-records".into(),generation:"synthetic-flush-route".into()};
    let now=millis() as i64;
    let ack=serde_json::to_vec(&json!({"version":"trillion.resource-connection-admitted/v1","route":route,"expires_at_ms":now+30_000})).unwrap();
    let invoke=serde_json::to_vec(&crate::resource_authority::InvokeChunk { person_present: None,operation_resource:None,request_id:"synthetic-flush-request".into(),account_id:OWNER.into(),device_id:route.device_id.clone(),resource_address:route.resource_address.clone(),generation:route.generation.clone(),operation:"workspace:write".into(),input:input(),request_key:"write-output-carrier-flush".into(),client_authorization:fixture.token.clone(),deadline_at_ms:now+30_000}).unwrap();
    let mut inbound=Vec::new();for chunk in [ack,invoke] {inbound.extend_from_slice(&(chunk.len() as u32).to_be_bytes());inbound.extend_from_slice(&chunk);}
    let held=Arc::new(AtomicBool::new(false));let stream=FlushProbe{input:io::Cursor::new(inbound),path:fixture.root.join("records.sqlite"),flushes:0,held:held.clone()};
    let selected=Arc::new(Mutex::new(fixture.selected()));let handle=tokio::runtime::Handle::current();
    std::thread::spawn(move||crate::native_boot::forwarder_connection::connect_selected_mac_session(stream,b"synthetic-device-credential",&route,selected,||millis() as i64,&handle)).join().unwrap().unwrap();
    assert!(held.load(Ordering::Acquire),"the original source reservation must survive the connection's physical flush");
    assert_eq!(state(&fixture).2,1);
}

#[test]
fn mcp_write_result_without_request_disclosure_cannot_execute_or_release_a_value() {
    use crate::mcp::{CallAnswerer,http::BearerAuthenticator};
    let fixture=Fixture::new();let before=state(&fixture);let selected=Arc::new(Mutex::new(fixture.selected()));
    let auth=crate::mcp_personal_key::SelectedPersonalKeyAuthenticator::new(selected.clone());
    let principal=auth.authenticate_current(fixture.token.as_bytes()).unwrap();
    let operation=Operation{ person_present: None,resource:"@own-records".into(),operation:"workspace:write".into(),request_key:"no-output-custody".into(),input:input()};
    let forwarder=crate::native_boot::mcp_local::LocalSelectedMcp::new(selected);
    assert!(forwarder.invoke_with_bearer(&principal,fixture.token.as_bytes(),operation).is_err());
    assert_eq!(state(&fixture),before);
}
