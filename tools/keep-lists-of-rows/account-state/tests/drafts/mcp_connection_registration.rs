// Controls over original synthetic APP_KV, AccountControl directory and
// resource-identity header (own_records::identity). This fixture exercises the
// retained original tc_ registration owner directly. Production public connection
// admission uses SelectedCredentialAdmission and only short trc_ credentials;
// tests/drafts/mcp_connection_credential.rs verifies that actual boundary.
// The management witness below is explicitly a fixture capability. It checks
// physical policy custody and actual source rows, and never issues a real key.
use super::{directory, iso, millis, state, Fixture, OWNER};
use content_crypto::advanced::blake3;
use crate::{
    account::{AccountIdentity, NativeAccountOwner},
    account_rights::{self, resource_connection::{self as registration, Change, RegistrationOwner}, CanonicalPolicyOwner},
    native_boot::SelectedAccount,
    forwarder::session::{ConnectionAdmission, ConnectionGrant, MAX_SESSION_LIFE_MS},
    storage::{sqlite::{self, Access}, Read, Storage, Value as Stored},
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf, sync::{Arc, Mutex}};

pub(crate) struct RegistrationAdmissionFixture {
    selected:Arc<Mutex<SelectedAccount>>,
}
impl RegistrationAdmissionFixture {
    pub(crate) fn new(selected:Arc<Mutex<SelectedAccount>>) -> Self { Self {selected} }
}
impl ConnectionAdmission for RegistrationAdmissionFixture {
    fn admit(&self, credential:&[u8], now:i64) -> Option<ConnectionGrant> {
        let now=u64::try_from(now).ok().filter(|n|*n>0)?;
        let mut owner=self.selected.try_lock().ok()?;
        owner.assert_source_current().ok()?;
        let registration=owner.owner.resource_connection_for_key(credential,now).ok()?;
        let route=registration.route().ok()?;
        owner.assert_source_current().ok()?;
        Some(ConnectionGrant { admission_identity: None,route,expires_at_ms:i64::try_from(now).ok()?.checked_add(MAX_SESSION_LIFE_MS)?})
    }
    fn is_current(&self, grant:&ConnectionGrant, now:i64) -> bool {
        if grant.admission_identity.is_some() {return false};
        let Some(life)=grant.expires_at_ms.checked_sub(now) else {return false};
        if now<=0 || life<=0 || life>MAX_SESSION_LIFE_MS {return false};
        let Ok(mut owner)=self.selected.try_lock() else {return false};
        if owner.assert_source_current().is_err() {return false};
        let Ok(registration)=owner.owner.registered_resource_connection(&grant.route.device_id,now as u64) else {return false};
        registration.route().ok().as_ref()==Some(&grant.route) && owner.assert_source_current().is_ok()
    }
}

fn account() -> AccountIdentity {
    AccountIdentity { user_id:"synthetic-user".into(), owner_id:OWNER.into() }
}
fn key() -> String {
    format!("tc_{}", blake3::hash(b"SYNTHETIC_RESOURCE_CONNECTION_COMPUTER_KEY").to_hex())
}
fn device(key:&str) -> String { blake3::hash(key.as_bytes()).to_hex().to_string() }
fn kv(fixture:&Fixture, name:&str, blob:&str, value:Value) {
    let root=fixture.root.join("storage/kv/trillion-local-app");
    fs::write(root.join("blobs").join(blob),value.to_string()).unwrap();
    Connection::open(root.join("current.sqlite")).unwrap()
        .execute("INSERT OR REPLACE INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",[name,blob]).unwrap();
}
fn issuer_fixture(fixture:&Fixture, key:&str) {
    let digest=device(key);
    let created=iso(millis()-86_400_000);
    kv(fixture,&format!("device-key:{digest}"),"cc",json!({"userId":"synthetic-user","name":"Synthetic source fixture","created_at":created}));
    kv(fixture,&format!("user-device:synthetic-user:{digest}"),"dd",json!({"name":"Synthetic source fixture","ending":&key[key.len()-4..],"created_at":created}));
}
fn setup() -> (Fixture,String) {
    let fixture=Fixture::new();
    let key=key();
    issuer_fixture(&fixture,&key);
    let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    directory(&db,"policy-source",json!({"from":"born","missing":[]}));
    directory(&db,"policy-source:account",json!({"lifecycle":{},"account_controls":{"owner_user_id":"synthetic-user"},"access":{}}));
    (fixture,key)
}
fn change(key:&str, expected:u64, active:bool, request:&str) -> Change {
    Change {device_id:device(key),resource_address:"@own-records".into(),resource_generation:1,
        expected_registration_revision:expected,active,request_key:request.into()}
}
fn policy_rows(fixture:&Fixture) -> Vec<(String,String)> {
    Connection::open(fixture.root.join("policy.sqlite")).unwrap()
        .prepare("SELECT name,value FROM policy_directory ORDER BY name").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap()
}
fn policy_value(store:&dyn Storage, name:&str) -> account_rights::Result<Value> {
    let row=store.get("policy_directory",&[Stored::from(name)],&[Read::at_most("value",8192)]).map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?;
    match row.map(|mut row|row.take(0)) {
        Some(Stored::Text(value))=>serde_json::from_str(&value).map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable)),
        None=>Ok(Value::Null), _=>Err(trillion_local::cause!(account_rights::Error::Unavailable)),
    }
}

struct ManagementWitness {
    policy:PathBuf, inode:(u64,u64), records:PathBuf, kv_root:PathBuf,
    request:String, identity:String, admission_checks:usize, withdraw_at:Option<usize>,
}
impl ManagementWitness {
    fn new(fixture:&Fixture, change:&Change) -> Self {
        let policy=fixture.root.join("policy.sqlite");
        let metadata=fs::metadata(&policy).unwrap();
        Self {policy,inode:(metadata.dev(),metadata.ino()),records:fixture.root.join("records.sqlite"),
            kv_root:fixture.root.join("storage/kv/trillion-local-app"),request:change.request_key.clone(),
            identity:change.identity().unwrap(),admission_checks:0,withdraw_at:None}
    }
}
impl CanonicalPolicyOwner for ManagementWitness {
    fn assert_current(&mut self, actual:&AccountIdentity, store:&dyn Storage) -> account_rights::Result<()> {
        let metadata=fs::metadata(&self.policy).map_err(|_|trillion_local::cause!(account_rights::Error::SourceChanged))?;
        if *actual!=account() || store.location()!=self.policy.to_str() || (metadata.dev(),metadata.ino())!=self.inode {
            return Err(trillion_local::cause!(account_rights::Error::SourceChanged));
        }
        Ok(())
    }
    fn assert_management_admission(&mut self, actual:&AccountIdentity, request:&str, identity:&str) -> account_rights::Result<()> {
        self.admission_checks+=1;
        if *actual!=account() || request!=self.request || identity!=self.identity || self.withdraw_at==Some(self.admission_checks) {
            return Err(trillion_local::cause!(account_rights::Error::NotAuthorized));
        }
        Ok(())
    }
}
impl RegistrationOwner for ManagementWitness {
    fn assert_resource_binding(&mut self, actual:&AccountIdentity, store:&dyn Storage, change:&Change) -> account_rights::Result<()> {
        self.assert_current(actual,store)?;
        if policy_value(store,"revision")?!=7 { return Err(trillion_local::cause!(account_rights::Error::SourceChanged)); }
        if !change.active { return Ok(()); }
        let records=Connection::open(&self.records).map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?;
        let header=crate::local_account::own_records::identity(&records,&actual.owner_id)
            .map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?.ok_or(trillion_local::cause!(account_rights::Error::Unavailable))?;
        let original=(header.owner,header.resource,header.generation,header.ready);
        if original!=(actual.owner_id.clone(),change.resource_address.clone(),change.resource_generation as i64,1) {
            return Err(trillion_local::cause!(account_rights::Error::NotAuthorized));
        }
        let db=Connection::open(self.kv_root.join("current.sqlite")).map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?;
        let blob:Option<String>=db.query_row("SELECT blob_id FROM _mf_entries WHERE key=?",[format!("device-key:{}",change.device_id)],|r|r.get(0))
            .optional().map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?;
        let blob=blob.ok_or(trillion_local::cause!(account_rights::Error::NotAuthorized))?;
        let saved:Value=serde_json::from_slice(&fs::read(self.kv_root.join("blobs").join(blob)).map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?)
            .map_err(|_|trillion_local::cause!(account_rights::Error::Unavailable))?;
        if saved["userId"]!=actual.user_id { return Err(trillion_local::cause!(account_rights::Error::NotAuthorized)); }
        Ok(())
    }
}
fn apply(fixture:&Fixture, change:&Change) -> account_rights::Result<registration::Registration> {
    let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    let store=sqlite::lend(&db,"account_policy",Access::Write).unwrap();
    registration::change(&store,&mut ManagementWitness::new(fixture,change),&account(),change)
}

/// Enroll the existing synthetic OAuth fixture through this same original
/// registration management witness, for concrete standing-parent consumers.
/// This creates no production issuer and never substitutes a route callback.
pub(super) fn enroll_for_parent_test(fixture: &Fixture) -> crate::resource_authority::Route {
    let key = key();
    issuer_fixture(fixture, &key);
    let db = Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    directory(&db, "policy-source", json!({"from":"born","missing":[]}));
    let text: String = db.query_row("SELECT value FROM policy_directory WHERE name='policy-source:account'", [], |row| row.get(0)).unwrap();
    let mut source: Value = serde_json::from_str(&text).unwrap();
    source["account_controls"] = json!({"owner_user_id":"synthetic-user"});
    directory(&db, "policy-source:account", source);
    drop(db);
    apply(fixture, &change(&key, 0, true, "synthetic-standing-parent-enroll")).unwrap().route().unwrap()
}
fn selected(fixture:&Fixture) -> (Arc<Mutex<SelectedAccount>>,RegistrationAdmissionFixture) {
    let selected=Arc::new(Mutex::new(fixture.selected()));
    let admission=RegistrationAdmissionFixture::new(selected.clone());
    (selected,admission)
}
fn enrolled(fixture:&Fixture, key:&str) -> (Arc<Mutex<SelectedAccount>>,RegistrationAdmissionFixture,ConnectionGrant) {
    apply(fixture,&change(key,0,true,"synthetic-enroll-one")).unwrap();
    let (owner,admission)=selected(fixture);
    let now=millis() as i64;
    let grant=admission.admit(key.as_bytes(),now).expect("concrete original-source device admission");
    assert!(admission.is_current(&grant,now));
    (owner,admission,grant)
}

#[test]
fn original_computer_key_without_explicit_host_enrollment_is_not_a_route() {
    let (fixture,key)=setup();
    let before=state(&fixture);
    let policy_before=policy_rows(&fixture);
    let (_owner,admission)=selected(&fixture);
    assert!(admission.admit(key.as_bytes(),millis() as i64).is_none());
    assert!(admission.admit(fixture.token.as_bytes(),millis() as i64).is_none(),"client keys do not become device credentials");
    assert_eq!(state(&fixture),before);
    assert_eq!(policy_rows(&fixture),policy_before,"refusal never enrolls or mints");
}

#[test]
fn explicit_original_source_enrollment_has_exact_route_and_short_session_lifetime() {
    let (fixture,key)=setup();
    let business_before=state(&fixture);
    let (owner,admission,grant)=enrolled(&fixture,&key);
    let now=millis() as i64;
    assert_eq!(grant.route.account_id,OWNER);
    assert_eq!(grant.route.device_id,device(&key));
    assert_eq!(grant.route.resource_address,"@own-records");
    assert!(grant.route.generation.starts_with("connection:"));
    assert!(grant.expires_at_ms>now && grant.expires_at_ms-now<=MAX_SESSION_LIFE_MS);
    assert!(!admission.is_current(&grant,grant.expires_at_ms));
    assert!(!admission.is_current(&grant,grant.expires_at_ms-MAX_SESSION_LIFE_MS-1),"rollback cannot extend a grant");
    let mut wrong=grant.clone(); wrong.route.account_id="b".repeat(64);
    assert!(!admission.is_current(&wrong,now));
    let mut wrong=grant.clone(); wrong.route.resource_address="@another-resource".into();
    assert!(!admission.is_current(&wrong,now));
    let mut wrong=grant.clone(); wrong.route.generation="caller-supplied-generation".into();
    assert!(!admission.is_current(&wrong,now));
    let held=owner.lock().unwrap();
    assert!(admission.admit(key.as_bytes(),now).is_none(),"busy owner is unavailable, never a cached grant");
    drop(held);
    assert_eq!(state(&fixture),business_before);
}

#[test]
fn original_device_withdrawal_and_key_substitution_refuse_existing_sessions() {
    let (fixture,key)=setup();
    let (_owner,admission,grant)=enrolled(&fixture,&key);
    let now=millis() as i64;
    let other=format!("tc_{}",blake3::hash(b"SYNTHETIC_UNENROLLED_OTHER_COMPUTER").to_hex());
    kv(&fixture,&format!("device-key:{}",device(&other)),"ee",json!({"userId":"synthetic-user","created_at":iso(millis()-1000)}));
    assert!(admission.admit(other.as_bytes(),now).is_none());
    kv(&fixture,&format!("device-key:{}",device(&key)),"ff",json!({"userId":"different-synthetic-user","created_at":iso(millis()-1000)}));
    assert!(admission.admit(key.as_bytes(),now).is_none());
    assert!(!admission.is_current(&grant,now));
    issuer_fixture(&fixture,&key);
    assert!(admission.is_current(&grant,millis() as i64));
    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap()
        .execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();
    assert!(admission.admit(key.as_bytes(),millis() as i64).is_none());
    assert!(!admission.is_current(&grant,millis() as i64));
}

#[test]
fn current_account_lifecycle_updates_erasure_and_record_checks_refuse() {
    for reason in ["disconnect","retirement","deletion","erased","policy-update","erasure-continuation","record-generation","record-not-ready"] {
        let (fixture,key)=setup();
        let (_owner,admission,grant)=enrolled(&fixture,&key);
        let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
        match reason {
            "disconnect"=>directory(&db,"policy-source:account",json!({"lifecycle":{"disconnected_at":iso(millis())},"account_controls":{"owner_user_id":"synthetic-user"}})),
            "retirement"=>directory(&db,"policy-source:account",json!({"lifecycle":{"retired_into":"synthetic-successor"},"account_controls":{"owner_user_id":"synthetic-user"}})),
            "deletion"=>directory(&db,"policy-source:account",json!({"lifecycle":{"deleting_since":iso(millis())},"account_controls":{"owner_user_id":"synthetic-user"}})),
            "erased"=>directory(&db,"policy-source:account",json!({"lifecycle":{"erased_at":iso(millis())},"account_controls":{"owner_user_id":"synthetic-user"}})),
            "policy-update"=>directory(&db,"update",json!("synthetic-current-policy-update")),
            "erasure-continuation"=>directory(&db,"account-erasure-continuation",json!({"id":"synthetic-erasure"})),
            "record-generation"=>crate::local_account::own_records::identity_fixture::change(&Connection::open(fixture.root.join("records.sqlite")).unwrap(),OWNER,crate::local_account::own_records::identity_fixture::header(OWNER,2,1)),
            "record-not-ready"=>crate::local_account::own_records::identity_fixture::change(&Connection::open(fixture.root.join("records.sqlite")).unwrap(),OWNER,crate::local_account::own_records::identity_fixture::header(OWNER,1,0)),
            _=>unreachable!(),
        }
        assert!(admission.admit(key.as_bytes(),millis() as i64).is_none(),"{reason}");
        assert!(!admission.is_current(&grant,millis() as i64),"{reason}");
    }
}

#[test]
fn revoked_registration_tombstone_and_reenrollment_do_not_revive_old_route() {
    let (fixture,key)=setup();
    let (_owner,admission,old)=enrolled(&fixture,&key);
    let revoked=apply(&fixture,&change(&key,1,false,"synthetic-revoke-one")).unwrap();
    assert!(!revoked.active);
    assert_eq!(revoked.registration_revision,2);
    assert!(revoked.route().is_err());
    assert!(!admission.is_current(&old,millis() as i64));
    assert!(admission.admit(key.as_bytes(),millis() as i64).is_none());
    let revived=apply(&fixture,&change(&key,2,true,"synthetic-reenroll-one")).unwrap();
    assert_eq!(revived.registration_revision,3);
    assert_eq!(revived.resource_generation,1);
    let new=admission.admit(key.as_bytes(),millis() as i64).unwrap();
    assert_ne!(new.route.generation,old.route.generation);
    assert!(!admission.is_current(&old,millis() as i64),"same device and raw resource generation cannot resurrect a revoked session");
    assert!(admission.is_current(&new,millis() as i64));
}

#[test]
fn registration_compare_and_swap_retry_changed_input_and_withdrawal_are_atomic() {
    let (fixture,key)=setup();
    let first=change(&key,0,true,"synthetic-original-registration-request");
    let saved=apply(&fixture,&first).unwrap();
    let after_first=policy_rows(&fixture);
    let retry=apply(&fixture,&first).unwrap();
    assert_eq!(serde_json::to_value(&saved).unwrap(),serde_json::to_value(&retry).unwrap());
    assert_eq!(policy_rows(&fixture),after_first);
    let mut changed=first.clone(); changed.active=false;
    assert!(matches!(apply(&fixture,&changed),Err(account_rights::Error::DifferentChange(_))));
    assert_eq!(policy_rows(&fixture),after_first);
    let stale=change(&key,0,false,"synthetic-stale-compare-and-swap");
    assert!(matches!(apply(&fixture,&stale),Err(account_rights::Error::SourceChanged(_))));
    assert_eq!(policy_rows(&fixture),after_first);
    let next=change(&key,1,false,"synthetic-withdraw-during-transaction");
    let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    let store=sqlite::lend(&db,"account_policy",Access::Write).unwrap();
    let mut witness=ManagementWitness::new(&fixture,&next);
    witness.withdraw_at=Some(2);
    assert!(matches!(registration::change(&store,&mut witness,&account(),&next),Err(account_rights::Error::NotAuthorized(_))));
    assert_eq!(policy_rows(&fixture),after_first,"second admission failure rolls back tombstone write");
    let mut wrong=next.clone(); wrong.active=true; wrong.resource_generation=2;
    assert!(matches!(apply(&fixture,&wrong),Err(account_rights::Error::NotAuthorized(_))));
    assert_eq!(policy_rows(&fixture),after_first);
}

#[test]
fn management_can_revoke_a_checked_resource_after_its_original_device_key_is_deleted() {
    let (fixture,key)=setup();
    let (_owner,admission,old)=enrolled(&fixture,&key);
    let business_before=state(&fixture);
    crate::local_account::own_records::identity_fixture::change(&Connection::open(fixture.root.join("records.sqlite")).unwrap(),OWNER,crate::local_account::own_records::identity_fixture::header(OWNER,1,0));
    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap()
        .execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();
    assert!(admission.admit(key.as_bytes(),millis() as i64).is_none());
    assert!(!admission.is_current(&old,millis() as i64));
    let revoked=apply(&fixture,&change(&key,1,false,"synthetic-offline-revocation")).unwrap();
    assert!(!revoked.active);
    assert_eq!(revoked.registration_revision,2);
    assert!(revoked.route().is_err());
    assert!(!admission.is_current(&old,millis() as i64));
    assert_eq!(state(&fixture),business_before,"connection revocation adds no record or command-journal write");
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn gateway_and_unix_connection_keep_original_registration_with_synthetic_transport() {
    use std::{os::unix::net::UnixStream,thread,time::Duration};
    use crate::{mcp_personal_key::{PersonalKeyForwarder,SelectedPersonalKeyAuthenticator},forwarder::gateway::Gateway};
    use tower::ServiceExt;
    fn now() -> i64 { millis() as i64 }
    let (fixture,key)=setup();
    let fixture=Arc::new(fixture);
    apply(&fixture,&change(&key,0,true,"synthetic-real-adapter-gateway-enrollment")).unwrap();
    let (selected,admission)=selected(&fixture);
    let admission=Arc::new(admission);
    let grant=admission.admit(key.as_bytes(),now()).unwrap();
    let gateway=Arc::new(Gateway::new(
        "127.0.0.1:28788",
        Arc::new(SelectedPersonalKeyAuthenticator::new(selected.clone())),
        Arc::new(PersonalKeyForwarder),
        admission.clone(),
        now,
    ));
    let (public,mac)=UnixStream::pair().unwrap();
    for stream in [&public,&mac] {
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    let runtime=tokio::runtime::Handle::current();
    let mac_selected=selected.clone();
    let mac_route=grant.route.clone();
    let mac_key=key.clone();
    let mac_thread=thread::spawn(move || {
        crate::native_boot::forwarder_connection::connect_selected_mac_session(
            mac,mac_key.as_bytes(),&mac_route,mac_selected,now,&runtime,
        )
    });
    assert_eq!(gateway.admit_mac_connection(public).unwrap(),grant.route);
    let app=crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
    let before=state(&fixture);
    let response=app.clone().oneshot(super::local_http_request(&fixture,"synthetic-real-adapter-write","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();
    let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["isError"],false);
    assert_eq!(reply["result"]["structuredContent"]["written"],1);
    assert!(!String::from_utf8_lossy(&body).contains(&fixture.token));
    assert!(!String::from_utf8_lossy(&body).contains(&key));
    let committed=state(&fixture);
    assert!(committed.0.contains("written"));
    assert!(committed.1>before.1);
    assert_eq!(committed.2,before.2+1,"one original canonical journal command");

    Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap()
        .execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{}",device(&key))]).unwrap();
    let response=app.clone().oneshot(super::local_http_request(&fixture,"synthetic-real-adapter-withdrawn-write","2026-07-28")).await.unwrap();
    assert_eq!(response.status(),axum::http::StatusCode::OK);
    let body=axum::body::to_bytes(response.into_body(),65_536).await.unwrap();
    let reply:Value=serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["result"]["isError"],true);
    assert_eq!(reply["result"]["structuredContent"],json!({"code":"resource_route_unavailable","outcome":"not_started","request_key":"synthetic-real-adapter-withdrawn-write"}));
    assert_eq!(state(&fixture),committed,"withdrawn device cannot dispatch another write");
    assert!(!admission.is_current(&grant,now()));
    assert!(!String::from_utf8_lossy(&body).contains(&fixture.token));
    assert!(!String::from_utf8_lossy(&body).contains(&key));
    drop(app);
    drop(gateway);
    mac_thread.join().unwrap().unwrap();
}

mod credential_controls {
 include!(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/drafts/mcp_connection_credential.rs"));
}
