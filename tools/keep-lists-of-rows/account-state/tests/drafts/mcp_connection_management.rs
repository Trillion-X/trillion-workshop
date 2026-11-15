// Included beneath local_account::current_record_tests: reuse its actual
// LocalAccount/browser fixture instead of a synthetic management witness.
use super::*;
use content_crypto::advanced::blake3;
use crate::{account, account_rights::resource_connection::Change};
use std::time::{Duration, Instant};

fn registration_fixture() -> (Fixture, String) {
    let fixture = Fixture::new();
    let policy = Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    fixture.set_policy("policy-source", json!({"from":"born","missing":[]}));
    fixture.set_policy("policy-source:account", json!({"lifecycle":{"browser_session_generation":1},
        "account_controls":{"owner_user_id":fixture.user},"access":{}}));
    // Current ordinary browser admission needs the actual full chosen reach;
    // no admission is inferred merely from the protected session file.
    let full = json!({"private":true,"spaces":"all"});
    policy.execute("INSERT INTO policy_directory VALUES(?,?)", [
        format!("policy-source:sign-in:session:{}", fixture.session),
        json!({"made":full,"ceiling":full,"chosen":full}).to_string(),
    ]).unwrap();
    drop(policy);
    let owner = "a".repeat(64);
    crate::local_account::own_records::identity_fixture::put(&fixture.root.join("records.sqlite"), &owner, crate::local_account::own_records::identity_fixture::header(&owner, 1, 1));
    let device = blake3::hash(b"SYNTHETIC_EXISTING_COMPUTER_CREDENTIAL").to_hex().to_string();
    let at = chrono::Utc::now().to_rfc3339();
    let key_record = json!({"userId":fixture.user,"name":"Synthetic Mac","created_at":at});
    fs::write(fixture.kv.parent().unwrap().join("blobs/cc"), key_record.to_string()).unwrap();
    Connection::open(&fixture.kv).unwrap().execute("INSERT INTO _mf_entries VALUES(?,'cc',NULL)",
        [format!("device-key:{device}")]).unwrap();
    (fixture, device)
}
fn change(device: &str) -> Change {
    Change { device_id:device.into(), resource_address:"@own-records".into(), resource_generation:1,
        expected_registration_revision:0, active:true, request_key:"synthetic-explicit-browser-enrollment".into() }
}
fn apply(owner:&mut LocalAccount, session:&str, input:&Change) -> crate::account_rights::Result<crate::account_rights::resource_connection::Registration> {
    owner.change_resource_connection(session,input,Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(false)),&||Ok(()))
}
fn rows(fixture:&Fixture)->Vec<(String,String)> {
    let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    let mut statement=db.prepare("SELECT name,value FROM policy_directory ORDER BY name").unwrap();
    let result=statement.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    result
}

#[test]
fn current_own_browser_enrolls_original_policy_and_exact_retry_changes_nothing() {
    let (fixture,device)=registration_fixture();
    let mut owner=fixture.open();
    let input=change(&device);
    let before=rows(&fixture);
    let enrolled=apply(&mut owner,&fixture.session,&input).unwrap();
    assert!(enrolled.active);
    assert_eq!(enrolled.registration_revision,1);
    let after=rows(&fixture);
    assert_eq!(after.len(),before.len()+1);
    assert!(apply(&mut owner,&fixture.session,&input).unwrap()==enrolled);
    assert_eq!(rows(&fixture),after);
    assert_eq!(owner.source.policy.connection.query_row("PRAGMA query_only",[],|r|r.get::<_,i64>(0)).unwrap(),1,
        "the actual original observer remains read-only");
    assert_eq!(account::current_browser(&mut owner,&fixture.session).unwrap().account.user_id,fixture.user);
}
#[test]
fn changed_input_under_original_request_key_cannot_renew_registration() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let mut input=change(&device);
    apply(&mut owner,&fixture.session,&input).unwrap();let before=rows(&fixture);
    input.active=false;input.expected_registration_revision=1;
    assert!(apply(&mut owner,&fixture.session,&input).is_err());
    assert_eq!(rows(&fixture),before);
}
#[test]
fn current_browser_can_revoke_after_original_device_credential_is_removed() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let mut input=change(&device);
    apply(&mut owner,&fixture.session,&input).unwrap();
    Connection::open(&fixture.kv).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{device}")]).unwrap();
    input.active=false;input.expected_registration_revision=1;input.request_key="synthetic-explicit-browser-revocation".into();
    let revoked=apply(&mut owner,&fixture.session,&input).unwrap();assert!(!revoked.active);assert_eq!(revoked.registration_revision,2);
}
#[test]
fn absent_or_foreign_browser_never_changes_original_policy() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let before=rows(&fixture);
    assert!(apply(&mut owner,&"c".repeat(64),&change(&device)).is_err());assert_eq!(rows(&fixture),before);
    fixture.end_window();
    assert!(apply(&mut owner,&fixture.session,&change(&device)).is_err());assert_eq!(rows(&fixture),before);
}
#[test]
fn checked_policy_or_wrong_resource_generation_cannot_enroll() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let before=rows(&fixture);
    let mut wrong=change(&device);wrong.resource_generation=2;
    assert!(apply(&mut owner,&fixture.session,&wrong).is_err());assert_eq!(rows(&fixture),before);
    fixture.set_policy("revision",json!(2));
    let db=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    db.execute("INSERT INTO policy_directory VALUES('update','\"peer-policy-change\"')",[]).unwrap();
    let paused=rows(&fixture);assert!(apply(&mut owner,&fixture.session,&change(&device)).is_err());assert_eq!(rows(&fixture),paused);
}
#[test]
fn withdrawn_or_other_account_device_is_not_hosting_authority() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let before=rows(&fixture);
    let path=fixture.kv.parent().unwrap().join("blobs/cc");
    let mut saved:serde_json::Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["userId"]=json!("another-user");fs::write(&path,saved.to_string()).unwrap();
    assert!(apply(&mut owner,&fixture.session,&change(&device)).is_err());assert_eq!(rows(&fixture),before);
    Connection::open(&fixture.kv).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{device}")]).unwrap();
    assert!(apply(&mut owner,&fixture.session,&change(&device)).is_err());assert_eq!(rows(&fixture),before);
}
#[test]
fn cancelled_expired_or_changed_selected_source_cannot_open_management_work() {
    let (fixture,device)=registration_fixture();let mut owner=fixture.open();let before=rows(&fixture);let input=change(&device);
    assert!(owner.change_resource_connection(&fixture.session,&input,Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(true)),&||Ok(())).is_err());
    assert!(owner.change_resource_connection(&fixture.session,&input,Instant::now(),Arc::new(AtomicBool::new(false)),&||Ok(())).is_err());
    assert!(owner.change_resource_connection(&fixture.session,&input,Instant::now()+Duration::from_secs(5),Arc::new(AtomicBool::new(false)),
        &||Err(trillion_local::cause!(crate::account_rights::Error::SourceChanged))).is_err());
    assert_eq!(rows(&fixture),before);
}


