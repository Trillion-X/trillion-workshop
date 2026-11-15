// Included under connection_registration_controls, reusing its actual synthetic
// original APP_KV/policy/record fixture and explicitly synthetic enrollment witness.
use super::*;
use content_crypto::advanced::blake3;
use crate::{account_rights::resource_connection::credential::{self,Error,IssuedCredential},
    native_boot::mcp_credential::SelectedCredentialAdmission,scan::ReadWork};
use std::{sync::atomic::AtomicBool,time::{Duration,Instant}};

fn issued(admission:&SelectedCredentialAdmission,key:&str,request:&str,revision:u64,now:i64)->credential::Result<IssuedCredential> {
    admission.issue(key.as_bytes(),request,revision,60_000,now,Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(false)))
}
fn source(fixture:&Fixture,key:&str)->(Arc<Mutex<SelectedAccount>>,SelectedCredentialAdmission) {
    apply(fixture,&change(key,0,true,"synthetic-token-enroll")).unwrap();
    let selected=Arc::new(Mutex::new(fixture.selected()));
    let admission=SelectedCredentialAdmission::new(selected.clone());
    (selected,admission)
}
fn work(selected:&Arc<Mutex<SelectedAccount>>)->ReadWork {selected.lock().unwrap().sql_work().unwrap().work}
fn difference(before:&ReadWork,after:&ReadWork)->ReadWork {ReadWork {
    sql_statements:after.sql_statements-before.sql_statements,sqlite_scan_visits:after.sqlite_scan_visits-before.sqlite_scan_visits,
    fullscan_steps:after.fullscan_steps-before.fullscan_steps,vm_steps:after.vm_steps-before.vm_steps,
    rows_returned:after.rows_returned-before.rows_returned,rows_written:after.rows_written-before.rows_written,
}}
fn slot_count(fixture:&Fixture)->i64 {Connection::open(fixture.root.join("policy.sqlite")).unwrap().query_row(
    "SELECT count(*) FROM policy_directory WHERE name LIKE 'resource-connection-credential:%'",[],|r|r.get(0)).unwrap()}
fn cost(stage:&str,before:&ReadWork,after:&ReadWork) {println!("CONNECTION_CREDENTIAL_WORK {}",json!({"stage":stage,"actual_selected_account_work":difference(before,after),"provider_bill":"unmeasured"}));}

#[test]
fn actual_short_lived_issuer_keeps_only_one_digest_slot_and_exact_retry_is_read_only() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let business=state(&fixture);assert_eq!(admission.current_revision(key.as_bytes(),now).unwrap(),0);
    let before=work(&selected);
    let first=issued(&admission,&key,"synthetic-mint-original",0,now).unwrap();let after=work(&selected);
    cost("first_issuance",&before,&after);assert_eq!(difference(&before,&after).rows_written,1);
    assert_eq!(first.revision(),1);assert!(first.as_bytes().starts_with(b"trc_"));
    assert!(first.grant().admission_identity.is_some());assert_eq!(first.grant().expires_at_ms,now+60_000);
    assert!(!format!("{first:?}").contains("trc_"));assert!(!format!("{first:?}").contains(&key));
    let kept=policy_rows(&fixture);let raw=std::str::from_utf8(first.as_bytes()).unwrap();
    assert!(!kept.iter().any(|(_,value)|value.contains(raw)||value.contains(&key)),"no raw token or original key is persisted");
    assert_eq!(slot_count(&fixture),1);
    let before=work(&selected);let retry=issued(&admission,&key,"synthetic-mint-original",0,now+10).unwrap();let after=work(&selected);
    cost("exact_retry",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);
    assert_eq!(retry.as_bytes(),first.as_bytes());assert_eq!(retry.grant().expires_at_ms,first.grant().expires_at_ms);
    assert_eq!(policy_rows(&fixture),kept);assert_eq!(state(&fixture),business);
    let before=work(&selected);let grant=admission.admit(first.as_bytes(),now+20).unwrap();let after=work(&selected);
    cost("admission",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);
    assert!(admission.is_current(&grant,now+20));assert_eq!(grant.admission_identity,first.grant().admission_identity);
    assert!(admission.admit(key.as_bytes(),now).is_none(),"public connection adapter refuses long-lived tc credentials");
}

#[test]
fn same_time_rotation_changes_exact_admission_identity_without_more_rows_or_route_changes() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let first=issued(&admission,&key,"synthetic-mint-first",0,now).unwrap();
    let grant=admission.admit(first.as_bytes(),now).unwrap();let route=grant.route.clone();let expires=grant.expires_at_ms;
    let before=work(&selected);let second=issued(&admission,&key,"synthetic-mint-second",1,now).unwrap();let after=work(&selected);
    cost("same_time_rotation",&before,&after);assert_eq!(difference(&before,&after).rows_written,1);
    assert_eq!(second.grant().route,route);assert_eq!(second.grant().expires_at_ms,expires);
    assert_ne!(second.as_bytes(),first.as_bytes());assert_ne!(second.grant().admission_identity,grant.admission_identity);
    assert!(admission.admit(first.as_bytes(),now).is_none());assert!(!admission.is_current(&grant,now));
    assert!(admission.admit(second.as_bytes(),now).is_some());assert_eq!(slot_count(&fixture),1);
    assert_eq!(issued(&admission,&key,"synthetic-mint-first",0,now).unwrap_err(),trillion_local::cause!(Error::Conflict));
    assert_eq!(admission.current_revision(key.as_bytes(),now).unwrap(),2);
    let third=issued(&admission,&key,"synthetic-mint-third",2,now).unwrap();assert_eq!(third.revision(),3);
    assert_eq!(slot_count(&fixture),1,"rotation overwrites the constant slot, never appends issuance rows");
}

#[test]
fn expired_exact_retry_never_renews_and_stale_or_changed_issuance_is_refused() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let first=issued(&admission,&key,"synthetic-expiry-original",0,now).unwrap();let kept=policy_rows(&fixture);
    let before=work(&selected);assert!(admission.admit(first.as_bytes(),now+60_000).is_none());let after=work(&selected);
    cost("expired_admission_denial",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);
    assert_eq!(issued(&admission,&key,"synthetic-expiry-original",0,now+60_000).unwrap_err(),trillion_local::cause!(Error::Expired));
    assert_eq!(admission.current_revision(key.as_bytes(),now+60_000).unwrap(),1);
    assert_eq!(policy_rows(&fixture),kept);
    let changed=admission.issue(key.as_bytes(),"synthetic-expiry-original",0,30_000,now,Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(false)));
    assert_eq!(changed.unwrap_err(),trillion_local::cause!(Error::Conflict));
    assert_eq!(issued(&admission,&key,"synthetic-stale-cas",0,now).unwrap_err(),trillion_local::cause!(Error::Conflict));
    let other=format!("tc_{}",blake3::hash(b"SYNTHETIC_WRONG_COMPUTER").to_hex());
    assert_eq!(issued(&admission,&other,"synthetic-expiry-original",0,now).unwrap_err(),trillion_local::cause!(Error::Unauthorized));
    assert_eq!(policy_rows(&fixture),kept);
}

#[test]
fn original_device_withdrawal_registration_revoke_and_actual_resource_checks_revoke_tokens() {
    for reason in ["key","registration","generation","ready","lifecycle"] {
        let (fixture,key)=setup();let (_selected,admission)=source(&fixture,&key);let now=millis() as i64;
        let first=issued(&admission,&key,"synthetic-current-token",0,now).unwrap();let grant=admission.admit(first.as_bytes(),now).unwrap();
        match reason {
            "key"=>{Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();},
            "registration"=>{apply(&fixture,&change(&key,1,false,"synthetic-revoke-token-parent")).unwrap();},
            "generation"=>crate::local_account::own_records::identity_fixture::change(&Connection::open(fixture.root.join("records.sqlite")).unwrap(),OWNER,crate::local_account::own_records::identity_fixture::header(OWNER,2,1)),
            "ready"=>crate::local_account::own_records::identity_fixture::change(&Connection::open(fixture.root.join("records.sqlite")).unwrap(),OWNER,crate::local_account::own_records::identity_fixture::header(OWNER,1,0)),
            "lifecycle"=>{directory(&Connection::open(fixture.root.join("policy.sqlite")).unwrap(),"policy-source:account",json!({"lifecycle":{"disconnected_at":iso(now as u64)},"account_controls":{"owner_user_id":"synthetic-user"}}));},
            _=>unreachable!(),
        }
        assert!(admission.admit(first.as_bytes(),now).is_none(),"{reason}");assert!(!admission.is_current(&grant,now),"{reason}");
        assert!(issued(&admission,&key,"synthetic-current-token",0,now).is_err(),"{reason}");assert_eq!(slot_count(&fixture),1);
    }
}

#[test]
fn malformed_unicode_and_invalid_bytes_never_panic_or_disclose_a_credential() {
    let (fixture,key)=setup();let (_selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let first=issued(&admission,&key,"synthetic-parser-token",0,now).unwrap();
    let mut malformed=vec![b'a';133];malformed[..4].copy_from_slice(b"trc_");malformed[67]=0xc3;malformed[68]=0xa9;
    assert!(admission.admit(&malformed,now).is_none());
    for length in [0,3,4,68,132,133,134,8193] {let value=vec![0xff;length];assert!(admission.admit(&value,now).is_none());}
    let mut changed=first.as_bytes().to_vec();changed[132]=if changed[132]==b'0'{b'1'}else{b'0'};
    assert!(admission.admit(&changed,now).is_none());assert!(admission.is_current(first.grant(),now));
}

#[test]
fn cancelled_or_unenrolled_issuance_creates_no_slot_or_business_write() {
    let (fixture,key)=setup();let selected=Arc::new(Mutex::new(fixture.selected()));let admission=SelectedCredentialAdmission::new(selected.clone());let now=millis() as i64;
    assert_eq!(issued(&admission,&key,"synthetic-unenrolled",0,now).unwrap_err(),trillion_local::cause!(Error::Unauthorized));assert_eq!(slot_count(&fixture),0);
    apply(&fixture,&change(&key,0,true,"synthetic-later-enroll")).unwrap();let business=state(&fixture);
    let cancelled=Arc::new(AtomicBool::new(true));
    assert_eq!(admission.issue(key.as_bytes(),"synthetic-cancelled",0,60_000,now,Instant::now()+Duration::from_secs(5),cancelled).unwrap_err(),trillion_local::cause!(Error::Unauthorized));
    assert_eq!(slot_count(&fixture),0);assert_eq!(state(&fixture),business);
}

#[test]
fn outer_selection_withdrawal_inside_the_credential_transaction_rolls_back_slot() {
    let (fixture,key)=setup();let (selected,_admission)=source(&fixture,&key);let now=millis();let before=state(&fixture);
    let checks=std::cell::Cell::new(0u32);
    let current=||{let next=checks.get()+1;checks.set(next);if next>=3{Err(trillion_local::cause!(crate::account::AccountError::SourceChanged))}else{Ok(())}};
    let mut selected=selected.lock().unwrap();
    let result=selected.owner.issue_resource_connection_credential(key.as_bytes(),"synthetic-selection-changed-at-commit",0,60_000,now,
        Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(false)),&current);
    assert_eq!(result.unwrap_err(),trillion_local::cause!(Error::Unavailable));assert_eq!(checks.get(),3);
    assert_eq!(slot_count(&fixture),0,"the selected descriptor is checked inside the write transaction before commit");assert_eq!(state(&fixture),before);
}

#[test]
fn authenticated_recovery_reuses_exact_current_token_and_same_time_successor_without_writes() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let before=work(&selected);assert!(admission.recover_current(key.as_bytes(),now).unwrap().is_none());let after=work(&selected);
    cost("recover_known_absent",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);assert_eq!(slot_count(&fixture),0);
    let first=issued(&admission,&key,"synthetic-recovery-original",0,now).unwrap();let rows=policy_rows(&fixture);
    let before=work(&selected);let recovered=admission.recover_current(key.as_bytes(),now+1).unwrap().unwrap();let after=work(&selected);
    cost("recover_current",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);
    assert_eq!(recovered.as_bytes(),first.as_bytes());assert_eq!(recovered.grant().expires_at_ms,first.grant().expires_at_ms);
    assert_eq!(recovered.grant().admission_identity,first.grant().admission_identity);assert_eq!(recovered.revision(),1);
    assert!(recovered.matches_issue("synthetic-recovery-original",0));assert!(!recovered.matches_issue("synthetic-another-request",0));assert!(!recovered.matches_issue("synthetic-recovery-original",1));
    assert_eq!(policy_rows(&fixture),rows);
    let second=issued(&admission,&key,"synthetic-recovery-successor",1,now).unwrap();let rows=policy_rows(&fixture);
    assert_eq!(first.grant().expires_at_ms,second.grant().expires_at_ms);assert!(!admission.is_current(first.grant(),now));
    let before=work(&selected);let current=admission.recover_current(key.as_bytes(),now).unwrap().unwrap();let after=work(&selected);
    cost("recover_same_expiry_successor",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);
    assert_eq!(current.as_bytes(),second.as_bytes());assert_eq!(current.revision(),2);assert!(current.matches_issue("synthetic-recovery-successor",1));
    assert!(current.revision()>0,"positive current successor makes the original pending expected-revision zero CAS stale");
    assert_eq!(policy_rows(&fixture),rows);assert_eq!(slot_count(&fixture),1);
}

#[test]
fn recovery_expiry_is_known_none_but_withdrawn_key_or_changed_registration_is_an_error() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let _first=issued(&admission,&key,"synthetic-expired-recovery",0,now).unwrap();let rows=policy_rows(&fixture);
    let before=work(&selected);assert!(admission.recover_current(key.as_bytes(),now+60_000).unwrap().is_none());let after=work(&selected);
    cost("recover_known_expired",&before,&after);assert_eq!(difference(&before,&after).rows_written,0);assert_eq!(policy_rows(&fixture),rows);
    let wrong=format!("tc_{}",blake3::hash(b"SYNTHETIC_RECOVERY_WRONG_DEVICE").to_hex());
    assert_eq!(admission.recover_current(wrong.as_bytes(),now).unwrap_err(),trillion_local::cause!(Error::Unauthorized));
    apply(&fixture,&change(&key,1,false,"synthetic-recovery-revoke")).unwrap();
    assert_eq!(admission.recover_current(key.as_bytes(),now).unwrap_err(),trillion_local::cause!(Error::Unauthorized));
    apply(&fixture,&change(&key,2,true,"synthetic-recovery-reenroll")).unwrap();
    assert_eq!(admission.recover_current(key.as_bytes(),now).unwrap_err(),trillion_local::cause!(Error::Conflict),"a stale slot for an earlier registration is not absence");
    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();
    assert_eq!(admission.recover_current(key.as_bytes(),now).unwrap_err(),trillion_local::cause!(Error::Unauthorized));assert_eq!(slot_count(&fixture),1);
}

#[test]
fn recovery_busy_or_source_withdrawal_does_not_become_absence_or_new_issuance() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let first=issued(&admission,&key,"synthetic-recovery-source",0,now).unwrap();let rows=policy_rows(&fixture);
    {
        let mut held=selected.lock().unwrap();
        assert_eq!(admission.recover_current(key.as_bytes(),now).unwrap_err(),trillion_local::cause!(Error::Unavailable));
        let checks=std::cell::Cell::new(0u32);
        let current=||{let next=checks.get()+1;checks.set(next);if next>=2{Err(trillion_local::cause!(crate::account::AccountError::SourceChanged))}else{Ok(())}};
        assert_eq!(held.owner.recover_current_resource_connection_credential(key.as_bytes(),now as u64,&current).unwrap_err(),trillion_local::cause!(Error::Unavailable));
        assert_eq!(checks.get(),2);
    }
    assert_eq!(policy_rows(&fixture),rows);assert_eq!(slot_count(&fixture),1);assert!(admission.is_current(first.grant(),now));
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn actual_sdk_gateway_connection_uses_only_short_token_and_rotation_retires_same_expiry_session() {
    use std::{os::unix::net::UnixStream,thread,sync::atomic::{AtomicI64,Ordering}};
    use crate::{mcp_personal_key::{PersonalKeyForwarder,SelectedPersonalKeyAuthenticator},forwarder::{gateway::Gateway,session}};
    use tower::ServiceExt;
    static CLOCK:AtomicI64=AtomicI64::new(0);
    fn now()->i64{CLOCK.load(Ordering::SeqCst)}
    fn pair()->(UnixStream,UnixStream){
        let (public,mac)=UnixStream::pair().unwrap();
        for stream in [&public,&mac]{stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();}
        (public,mac)
    }
    struct GatewayIo(UnixStream);
    impl std::io::Read for GatewayIo {
        fn read(&mut self,bytes:&mut [u8])->std::io::Result<usize>{
            let result=std::io::Read::read(&mut self.0,bytes);
            if let Err(error)=&result{eprintln!("synthetic-short-token-gateway-read-error:{:?}",error.kind());}
            result
        }
    }
    impl std::io::Write for GatewayIo {
        fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{
            let result=std::io::Write::write(&mut self.0,bytes);
            if let Err(error)=&result{eprintln!("synthetic-short-token-gateway-write-error:{:?}",error.kind());}
            result
        }
        fn flush(&mut self)->std::io::Result<()>{
            let result=std::io::Write::flush(&mut self.0);
            if let Err(error)=&result{eprintln!("synthetic-short-token-gateway-flush-error:{:?}",error.kind());}
            result
        }
    }
    let (fixture,key)=setup();let fixture=Arc::new(fixture);let (selected,admission)=source(&fixture,&key);let admission=Arc::new(admission);
    CLOCK.store(millis() as i64,Ordering::SeqCst);
    let first=issued(&admission,&key,"synthetic-wire-token-first",0,now()).unwrap();
    let first_grant=admission.admit(first.as_bytes(),now()).unwrap();
    let gateway=Arc::new(Gateway::new("127.0.0.1:28788",Arc::new(SelectedPersonalKeyAuthenticator::new(selected.clone())),Arc::new(PersonalKeyForwarder),admission.clone(),now));
    // Even the authentic original tc_ credential is not accepted on the public
    // resource-connection path. It is used only by the local explicit issuer.
    let (public,mac)=pair();let tc=zeroize::Zeroizing::new(key.clone());let rejected_route=first_grant.route.clone();
    let refused=thread::spawn(move||session::connect_mac_session(mac,tc.as_bytes(),&rejected_route,now,|_|panic!("a long-lived computer key cannot dispatch")));
    assert!(gateway.admit_mac_connection(public).is_err());assert!(refused.join().unwrap().is_err());
    let connect=|token:&IssuedCredential|{
        let (public,mac)=pair();let raw=zeroize::Zeroizing::new(token.as_bytes().to_vec());let route=token.grant().route.clone();let owner=selected.clone();let runtime=tokio::runtime::Handle::current();
        let worker=thread::spawn(move||{
            let result=crate::native_boot::forwarder_connection::connect_selected_mac_session(mac,&raw,&route,owner,now,&runtime);
            if let Err(error)=&result{eprintln!("synthetic-short-token-mac-error:{:?}: connection session ended",error.kind());}
            result
        });
        assert_eq!(gateway.admit_mac_connection(GatewayIo(public)).unwrap(),token.grant().route);worker
    };
    let first_worker=connect(&first);
    let app=crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
    let before=state(&fixture);
    let response=app.clone().oneshot(super::super::local_http_request(&fixture,"synthetic-short-token-original-write","2026-07-28")).await.unwrap();
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["isError"],false,"short-token gateway structured result: {}",reply["result"]["structuredContent"]);assert_eq!(reply["result"]["structuredContent"]["written"],1);
    let committed=state(&fixture);assert_eq!(committed.2,before.2+1);
    assert!(!String::from_utf8_lossy(&body).contains(&key));assert!(!String::from_utf8_lossy(&body).contains(std::str::from_utf8(first.as_bytes()).unwrap()));
    let second=issued(&admission,&key,"synthetic-wire-token-second",1,now()).unwrap();
    assert_eq!(first.grant().expires_at_ms,second.grant().expires_at_ms);assert_eq!(first.grant().route,second.grant().route);
    assert!(!admission.is_current(&first_grant,now()));assert!(admission.admit(first.as_bytes(),now()).is_none());
    let response=app.clone().oneshot(super::super::local_http_request(&fixture,"synthetic-old-token-cannot-write","2026-07-28")).await.unwrap();
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["structuredContent"]["code"],"resource_route_unavailable");assert_eq!(state(&fixture),committed);
    first_worker.join().unwrap().unwrap();
    let second_worker=connect(&second);
    let response=app.clone().oneshot(super::super::local_http_request(&fixture,"synthetic-short-token-original-write","2026-07-28")).await.unwrap();
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["isError"],false);assert_eq!(state(&fixture),committed,"transport rotation preserves original command identity");
    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();
    let response=app.clone().oneshot(super::super::local_http_request(&fixture,"synthetic-withdrawn-token-cannot-write","2026-07-28")).await.unwrap();
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["structuredContent"]["code"],"resource_route_unavailable");assert_eq!(state(&fixture),committed);
    assert!(!admission.is_current(second.grant(),now()));assert!(admission.admit(second.as_bytes(),now()).is_none());
    drop(app);drop(connect);drop(gateway);second_worker.join().unwrap().unwrap();
}

mod outbound_lifecycle_controls {
 include!(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/drafts/mcp_outbound_lifecycle.rs"));
}

mod oauth_registered_connection_controls {
 include!(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/drafts/oauth_registered_connection.rs"));
}
