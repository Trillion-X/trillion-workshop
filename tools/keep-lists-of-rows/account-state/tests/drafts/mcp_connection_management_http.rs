// Actual original workspace forwarder, saved browser, selected account, canonical
// OwnerRoutes DATA, LocalWorkspace and original policy commit; synthetic only.
use super::*;
use content_crypto::advanced::blake3;
use tower::ServiceExt;
use axum::{body::{Body,to_bytes},http::{Request,StatusCode}};

const ORIGIN:&str="http://127.0.0.1:7189";
fn routes()->&'static [u8]{crate::workspace_domain::ROUTES_DATA}
fn managed_fixture()->(Fixture,crate::native_boot::SelectedAccount,String) {
    let (fixture,owner,_)=browser_fixture();
    let policy=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    directory(&policy,"policy-source",json!({"from":"born","missing":[]}));
    directory(&policy,"policy-source:account",json!({"lifecycle":{"browser_session_generation":0},
        "account_controls":{"owner_user_id":"synthetic-user"},"access":{}}));
    let device=blake3::hash(b"SYNTHETIC_REGISTERED_COMPUTER_ONLY").to_hex().to_string();
    let kv_root=fixture.root.join("storage/kv/trillion-local-app");
    fs::write(kv_root.join("blobs/cc"),json!({"userId":"synthetic-user","name":"Synthetic browser Mac","created_at":iso(millis()-1_000)}).to_string()).unwrap();
    Connection::open(kv_root.join("current.sqlite")).unwrap().execute("INSERT INTO _mf_entries VALUES(?,'cc',NULL)",[format!("device-key:{device}")]).unwrap();
    (fixture,owner,device)
}
fn input_for(device:&str,revision:u64,active:bool)->Value {
    json!({"device_id":device,"resource_address":"@own-records","resource_generation":1,"expected_registration_revision":revision,"active":active})
}
fn page_store()->String {
    let source=br#"{"kept":{"store_prefix":"trillion-kept-"}}"#;
    crate::workspace_session::WorkspaceSessionSettings::from_source(source,blake3::hash(source).to_hex().as_str()).unwrap().page_store("synthetic-user").unwrap()
}
fn request(key:Option<&str>,origin:Option<&str>,page:Option<&str>,body:Value)->Request<Body> {
    let mut request=Request::builder().method("POST").uri("/work/api/resource-connections")
        .header("host","127.0.0.1:7189").header("cookie",format!("nm_session={}","b".repeat(64)))
        .header("content-type","application/json");
    if let Some(key)=key {request=request.header("idempotency-key",key);}
    if let Some(origin)=origin {request=request.header("origin",origin);}
    if let Some(page)=page {request=request.header("x-trillion-page-store",page);}
    request.body(Body::from(body.to_string())).unwrap()
}
fn policy_rows(f:&Fixture)->Vec<(String,String)> {
    let database=Connection::open(f.root.join("policy.sqlite")).unwrap();
    let mut statement=database.prepare("SELECT name,value FROM policy_directory ORDER BY name").unwrap();
    let rows=statement.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    rows
}

#[tokio::test]
async fn actual_browser_registration_lost_body_retry_and_revocation_keep_same_policy_owner() {
    let (f,owner,device)=managed_fixture();let before=state(&f);let before_policy=policy_rows(&f);
    let (app,_selected)=browser_http_observed_with_routes(&f,owner,ORIGIN,routes());
    let page=page_store();let body=input_for(&device,0,true);
    let response=app.clone().oneshot(request(Some("http-explicit-enroll"),Some(ORIGIN),Some(&page),body.clone())).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    drop(response); // An effect committed; the first client lost its result.
    let enrolled=policy_rows(&f);assert_eq!(enrolled.len(),before_policy.len()+1);assert_eq!(state(&f),before);
    let response=app.clone().oneshot(request(Some("http-explicit-enroll"),Some(ORIGIN),Some(&page),body)).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    let value:Value=serde_json::from_slice(&to_bytes(response.into_body(),65_536).await.unwrap()).unwrap();
    assert_eq!(value["active"],true);assert_eq!(value["registration_revision"],1);assert_eq!(value["request_key"],"http-explicit-enroll");
    assert_eq!(policy_rows(&f),enrolled);assert_eq!(state(&f),before);
    Connection::open(f.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap()
        .execute("DELETE FROM _mf_entries WHERE key=?",[format!("device-key:{device}")]).unwrap();
    let response=app.oneshot(request(Some("http-explicit-revoke"),Some(ORIGIN),Some(&page),input_for(&device,1,false))).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    let value:Value=serde_json::from_slice(&to_bytes(response.into_body(),65_536).await.unwrap()).unwrap();
    assert_eq!(value["active"],false);assert_eq!(value["registration_revision"],2);assert_eq!(state(&f),before);
}

#[tokio::test]
async fn actual_browser_management_requires_origin_current_page_account_and_original_key() {
    let (f,owner,device)=managed_fixture();let before=policy_rows(&f);
    let (app,_selected)=browser_http_observed_with_routes(&f,owner,ORIGIN,routes());let page=page_store();
    for (key,origin,store) in [
        (Some("wrong-origin"),Some("https://another.example"),Some(page.as_str())),
        (Some("missing-origin"),None,Some(page.as_str())),
        (Some("missing-page"),Some(ORIGIN),None),
        (Some("wrong-page"),Some(ORIGIN),Some("another-account-page")),
        (None,Some(ORIGIN),Some(page.as_str())),
    ] {
        let response=app.clone().oneshot(request(key,origin,store,input_for(&device,0,true))).await.unwrap();
        assert!(!response.status().is_success(),"management prerequisite accepted: key={key:?}, origin={origin:?}, page={store:?}");
        assert_eq!(policy_rows(&f),before);
    }
}

#[tokio::test]
async fn actual_browser_withdrawal_before_first_registration_result_chunk_withholds_without_reexecution() {
    let (f,owner,device)=managed_fixture();let before=state(&f);
    let (app,_selected)=browser_http_observed_with_routes(&f,owner,ORIGIN,routes());let page=page_store();
    let response=app.clone().oneshot(request(Some("withhold-enroll"),Some(ORIGIN),Some(&page),input_for(&device,0,true))).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);let committed=policy_rows(&f);
    withdraw_browser(&f);
    assert!(to_bytes(response.into_body(),65_536).await.is_err());
    let response=app.oneshot(request(Some("withhold-enroll"),Some(ORIGIN),Some(&page),input_for(&device,0,true))).await.unwrap();
    assert!(!response.status().is_success());assert_eq!(policy_rows(&f),committed);assert_eq!(state(&f),before);
}

#[tokio::test]
async fn absent_management_route_data_refuses_instead_of_enrolling_on_startup() {
    let (f,owner,device)=managed_fixture();let before=policy_rows(&f);let app=browser_http_app(&f,owner);let page=page_store();
    let response=app.oneshot(request(Some("not-mounted"),Some(ORIGIN),Some(&page),input_for(&device,0,true))).await.unwrap();
    assert!(!response.status().is_success());assert_eq!(policy_rows(&f),before);
}
