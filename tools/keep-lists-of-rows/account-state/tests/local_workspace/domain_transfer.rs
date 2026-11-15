//! Actual public management route, original browser admission, two native
//! SQLite stores and the production Copies/domain-transfer composition.
use super::*;
use std::{collections::HashMap,sync::{Weak,atomic::{AtomicI64,Ordering}}};
use trillion_local::{account::{computers::{AccountKey,ComputerSigner,ComputersRow,copies::{self,Copies,CopiesConfig,Link},messages::{Message,Answer}},},secrets::secrets_key::{self,ComputerKey},storage::record_store_resources::domains};

struct Network {from:String,peers:Arc<Mutex<HashMap<String,Weak<Copies>>>>}
impl Link for Network {
    fn send(&self,to:&str,message:&Message)->Option<Answer> {
        let peer=self.peers.lock().unwrap().get(to).and_then(Weak::upgrade)?;
        Some(peer.answer(&self.from,message.clone()))
    }
}
/// Runs each computer's timer (`Copies::tick`) every 3 s (the shipped renew_every_ms) until dropped, as the computer's own timer does: a
/// write that asks for the writer turn waits for it (`write_at`), and no real computer runs without a timer.
struct Timer {stop:Arc<std::sync::atomic::AtomicBool>,handle:Option<std::thread::JoinHandle<()>>}
impl Timer {
    fn start(nodes:&[Arc<Copies>]) -> Timer {
        let stop=Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (flag,nodes)=(stop.clone(),nodes.to_vec());
        let every=std::time::Duration::from_millis(3000);
        let handle=std::thread::spawn(move||{
            while !flag.load(Ordering::Acquire) {
                for node in &nodes {node.tick();}
                std::thread::sleep(every);
            }
        });
        Timer {stop,handle:Some(handle)}
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        self.stop.store(true,Ordering::Release);
        if let Some(handle)=self.handle.take() {handle.join().unwrap();}
    }
}
fn snapshot(source:&Path,target:&Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry=entry.unwrap();let name=entry.file_name();let name=name.to_str().unwrap();
        if name.ends_with("-wal")||name.ends_with("-shm") {continue;}
        let to=target.join(name);
        if entry.file_type().unwrap().is_dir() {snapshot(&entry.path(),&to);} else if name.ends_with(".sqlite") {
            let db=Connection::open(entry.path()).unwrap();db.execute("VACUUM INTO ?",[to.to_str().unwrap()]).unwrap();
        } else {fs::copy(entry.path(),to).unwrap();}
    }
}
fn management(key:&str,body:&Value,user:&str)->Request<Body> {
    let mut post=request("POST","/work/api/resource-connections",Some(&body.to_string()));
    post.headers_mut().insert(header::ORIGIN,ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE,"application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key",key.parse().unwrap());
    let settings=WorkspaceSessionSettings::from_source(SETTINGS,content_crypto::advanced::blake3::hash(SETTINGS).to_hex().as_str()).unwrap();
    post.headers_mut().insert("x-trillion-page-store",settings.page_store(user).unwrap().parse().unwrap());post
}
async fn answer(f:&Fixture,key:&str,body:&Value)->(StatusCode,Value) {
    let response=f.app.clone().oneshot(management(key,body,&f.user)).await.unwrap();let status=response.status();
    let bytes=to_bytes(response.into_body(),1<<20).await.unwrap();(status,serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn public_transfer_inspects_denies_and_recovers_a_dropped_response_on_two_real_computers() {
    TRANSFER_ROUTES.with(|flag|flag.set(true));ADMIT_APART.with(|flag|flag.set(true));
    let test_owner="5".repeat(64);let test_owner=test_owner.as_str();
    let f=records_write_controls::canonical_started_fixture_for_owner(test_owner);let peer=tempfile::tempdir().unwrap();let source=f.records.parent().unwrap();
    snapshot(source,peer.path());
    let state=SelectedLocalState {root:peer.path().into(),receipt:FilePin {bytes:fs::metadata(peer.path().join("restore-receipt.json")).unwrap().len(),blake3:content_crypto::advanced::blake3::hash(&fs::read(peer.path().join("restore-receipt.json")).unwrap()).to_hex().to_string()},
        app_kv_sqlite:"current-kv.sqlite".into(),app_kv_store:trillion_local::local_account::EXISTING_APP_KV_STORE.into(),prior_processes:vec![]};
    let opened=LocalAccount::open_selected_after_handoff(SelectedLocalState {root:state.root.clone(),receipt:FilePin {bytes:state.receipt.bytes,blake3:state.receipt.blake3.clone()},app_kv_sqlite:state.app_kv_sqlite.clone(),app_kv_store:state.app_kv_store.clone(),prior_processes:vec![]}).unwrap();
    let peer_owner=Arc::new(Mutex::new(SelectedAccount::chosen(opened,trillion_local::native_boot::Chosen::computer(state,ORIGIN.into())).unwrap()));
    let keys=[Arc::new(ComputerKey::from_bytes(vec![150;32]).unwrap()),Arc::new(ComputerKey::from_bytes(vec![151;32]).unwrap())];
    let ids=keys.iter().map(|key|ComputerSigner::of(key).unwrap().computer_id()).collect::<Vec<_>>();
    let account=AccountKey::generate().unwrap();let address=account.address();let row=ComputersRow::sign_with_voters(&address,1,&ids,&ids,&ids,&account).unwrap();
    let peers=Arc::new(Mutex::new(HashMap::new()));let now=Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));let root=secrets_key::generate().unwrap();let mut nodes=Vec::new();
    for at in 0..2 {
        let folder=if at==0 {source.to_path_buf()}else{peer.path().to_path_buf()};let clock=now.clone();
        secrets_key::write_sealed(&folder,&root,&keys[at]).unwrap();
        let held_root=secrets_key::open_sealed_with(&folder,&keys[at]).unwrap();
        let copies=Copies::new(CopiesConfig {address:address.clone(),owner:test_owner.into(),user:f.user.clone(),computer:ids[at].clone(),row:row.clone(),records:folder.join("records.sqlite"),limits:None,sign_in:copies::sign_in_rows(&folder).unwrap(),stores:None},
            Arc::new(Network {from:ids[at].clone(),peers:peers.clone()}),Arc::new(move||clock.load(Ordering::Acquire))).unwrap()
            .with_state(folder.clone()).with_secrets_key(keys[at].clone(),folder.clone(),Some(held_root)).with_account_stores(folder,"policy.sqlite".into());
        let owner=if at==0 {&f.owner}else{&peer_owner};let copies=trillion_local::native_entry::computer::domain_transfer::bind(copies,owner).unwrap();
        peers.lock().unwrap().insert(ids[at].clone(),Arc::downgrade(&copies));nodes.push(copies);
    }
    let _timer=Timer::start(&nodes);
    nodes[0].write(|store|store.mutate_local_with_check(test_owner,"own-records",trillion_local::records::Mutation {id:"synthetic-http-prime".into(),expected_version:0,request_key:"synthetic-http-prime".into(),deleted:false,value:json!({"synthetic":true})},||Ok(())).map(|_|())).unwrap();
    copies::register(&nodes[0]);
    let scope=json!({"id":"synthetic-http-history","incarnation":"original","generation":1});
    let mut create_scope=scope.clone();create_scope["create"]=json!(true);
    let body=json!({"scope":create_scope,"records":[{"id":"list:proof","type":"list","value":{"id":"proof","label":"Synthetic proof","row_type":"proof","title_field":"text","fields":[{"id":"text","label":"Text","kind":"text"}]}},{"id":"record:proof:row","type":"record:proof","value":{"text":"retained"}}]});
    let response=f.app.clone().oneshot(records_write_controls::post("synthetic-http-create",&body)).await.unwrap();
    let status=response.status();let bytes=to_bytes(response.into_body(),1<<20).await.unwrap();assert_eq!(status,StatusCode::OK,"{}",String::from_utf8_lossy(&bytes));
    let inspect=json!({"inspect":scope});let (status,registration)=answer(&f,"synthetic-http-inspect",&inspect).await;assert_eq!(status,StatusCode::OK,"{registration}");
    assert!(registration["registration_revision"].as_u64().unwrap()>0);
    for removed in [header::ORIGIN.as_str(),"x-trillion-page-store","x-trillion-request-key"] {
        let mut denied=management("synthetic-http-denied",&inspect,&f.user);denied.headers_mut().remove(removed);
        let response=f.app.clone().oneshot(denied).await.unwrap();assert_ne!(response.status(),StatusCode::OK,"management must require {removed}");
    }
    let transfer=json!({"transfer":{"scope":scope,"target":ids[1],"move_id":"synthetic-http-transfer","expected_revision":registration["registration_revision"]}});
    let first=f.app.clone().oneshot(management("synthetic-http-move",&transfer,&f.user)).await.unwrap();
    assert_eq!(first.status(),StatusCode::OK);drop(first); // Real completed turn, deliberately unread response.
    let mut active=false;
    for turn in 0..500 {
        let (status,result)=answer(&f,"synthetic-http-move",&transfer).await;assert_eq!(status,StatusCode::OK,"turn {turn}: {result}");
        assert_eq!(result["request_key"],"synthetic-http-move");
        if result["state"]=="active" {active=true;break;}
    }
    assert!(active,"exact public retry must reach actual target authority and writer");
    let lost=f.app.clone().oneshot(management("synthetic-http-move",&transfer,&f.user)).await.unwrap();
    assert_eq!(lost.status(),StatusCode::OK);drop(lost);
    let (status,recovered)=answer(&f,"synthetic-http-move",&transfer).await;
    assert_eq!(status,StatusCode::OK,"{recovered}");assert_eq!(recovered["state"],"active","the same original endpoint can recover a lost final handoff result");
    assert_eq!(nodes[1].writer_row().unwrap().0,ids[1]);assert!(nodes[1].holding().is_some());
    let history:domains::Identity=serde_json::from_value(scope).unwrap();
    let resources=Arc::new(trillion_local::storage::record_store_resources::StateResources::new(peer.path(),trillion_local::sqlite_work::WorkMeter::new()).unwrap());
    let selection:domains::Selection=serde_json::from_value(serde_json::to_value(history).unwrap()).unwrap();
    let target=domains::Bound::new(resources,test_owner,selection,1).unwrap();
    target.readers().unwrap().read::<_,trillion_local::records::Error>(|store| {
        assert!(store.current_record(test_owner,"own-records","record:proof:row")?.unwrap().value.to_string().contains("retained"));Ok(())
    }).unwrap();
}
