//! Admitted bounded transfer between two actual computers of one account.
//! Ports placed-lists.mjs:10-41's whole selected home and one live authority.
//! The existing browser management route is the caller; Copies is the sealed
//! transport and writer owner. No path, placement catalogue or new credential
//! crosses this boundary. Native policy replication remains its original owner.
use crate::{
    account::computers::{self,copies::{self,Copies,ComputerStore,DomainMaintenance}},
    native_boot::{SelectedAccount,connection_management::NativeTransferAdmission},
    records::Error,
    storage::{self,Intent,Storage,record_store::{RecordStore,RealClock},record_store_resources::{domains::Identity,carry::{commit_log,live_adopt::{self as adoption,portable,Plan,Progress}}}},
    workspace_session::owner_wait,
};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{collections::HashMap,sync::{Arc,Mutex,Weak,OnceLock,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};

#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Transfer {pub scope:Identity,pub target:String,pub move_id:String,pub expected_revision:u64}
impl Transfer {
    pub(crate) fn identity(&self,request:&str)->Result<String,Error> {
        let bounds=storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?;
        if self.target.len()!=64 || !self.target.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte))
            || self.move_id.trim().is_empty() || self.move_id.len()>bounds.identity_text_bytes || self.move_id.chars().any(char::is_control)
            || request.trim().is_empty() || request.len()>bounds.identity_text_bytes || self.expected_revision==0 {return Err(Error::Invalid("invalid transfer", crate::cause!()));}
        self.scope.resource("admitted-account")?;
        let bytes=serde_json::to_vec(&("native-domain-transfer/v1",request,self)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(content_crypto::advanced::blake3::hash(&bytes).to_hex().to_string())
    }
}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {account:String,session:String,request:String,transfer:Transfer,plan:Plan,step:Step}
#[derive(Serialize,Deserialize)]
#[serde(tag="step",rename_all="snake_case",deny_unknown_fields)]
enum Step {Inspect,Prepare,Accept {response:Vec<u8>},Activate {seal:Vec<u8>,head:Head}}
#[derive(Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Head {through:i64,digest:Option<String>,key:Option<commit_log::opaque_map::WrappedKey>}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {request:Option<Vec<u8>>,await_seal:bool,ready:bool,active:bool,installing:bool}
fn limits()->Result<adoption::Limits,Error> {storage::record_store::settings::shipped().map(|settings|settings.live_adoption).ok_or(crate::cause!(Error::Unavailable))}
fn current(admitted:&NativeTransferAdmission)->Result<(),Error> {if (admitted.current)(){Ok(())}else{Err(crate::cause!(Error::Unavailable))}}
fn admit(owner:&Arc<Mutex<SelectedAccount>>,session:&str,scope:&Identity,cancel:Arc<AtomicBool>,deadline:Instant)->Result<NativeTransferAdmission,Error> {
    let mut held=owner_wait::acquire_background(owner,||cancel.load(Ordering::Acquire)||Instant::now()>=deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
    held.admit_browser_domain_transfer(session,scope,cancel,deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))
}
fn plan_current(context:&Context,admitted:&NativeTransferAdmission)->Result<(),Error> {
    current(admitted)?;
    if context.account!=admitted.account || context.transfer.scope!=admitted.domain.selection().identity()
        || context.transfer.identity(&context.request)?!=context.plan.move_id {return Err(crate::cause!(Error::Conflict));}
    let staged=admitted.authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Conflict))?;
    if staged.move_id!=context.plan.move_id || staged.source_incarnation!=context.plan.source_incarnation
        || staged.target_incarnation!=context.plan.target_incarnation {return Err(crate::cause!(Error::Conflict));}
    Ok(())
}
fn reply(store:&dyn Storage,plan:&Plan,admitted:&NativeTransferAdmission,await_seal:bool)->Result<Reply,Error> {
    current(admitted)?;
    let progress=adoption::recover(store,plan,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
    let ready=matches!(progress,Progress::Ready {..});let active=matches!(progress,Progress::Active {..});
    let request=if ready||active {None}else{portable::request(store,plan,limits()?,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?};
    Ok(Reply {request,await_seal,ready,active,installing:false})
}
struct Install {
    store:RecordStore<ComputerStore>,cursor:Option<commit_log::MaterializedBaselineCursor>,
    plan:Plan,head:Head,seal:Vec<u8>,source:String,term:u64,at:Instant,identity:String,
}
impl Drop for Install {fn drop(&mut self){let _=self.store.storage().close_scope(false);}}
pub(crate) struct Handler {owner:Weak<Mutex<SelectedAccount>>,copies:OnceLock<Weak<Copies>>,installs:Mutex<HashMap<String,Arc<Mutex<Install>>>>}
/// Compose the existing Copies and original selected native account owners.
/// Embedders use this same composition as Computer::start_copies; it creates
/// no account, session, root or management permission.
pub fn bind(copies:Copies,owner:&Arc<Mutex<SelectedAccount>>)->Result<Arc<Copies>,Error> {
    use crate::account::NativeAccountOwner;
    if owner.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?.account().owner_id!=copies.owner() {return Err(crate::cause!(Error::Conflict));}
    let handler=Arc::new(Handler::new(owner));let copies=Arc::new(copies.with_domain_maintenance(handler.clone()));
    handler.attach(&copies)?;Ok(copies)
}
impl Handler {
    pub(crate) fn new(owner:&Arc<Mutex<SelectedAccount>>)->Self {Self {owner:Arc::downgrade(owner),copies:OnceLock::new(),installs:Mutex::new(HashMap::new())}}
    pub(crate) fn attach(&self,copies:&Arc<Copies>)->Result<(),Error> {self.copies.set(Arc::downgrade(copies)).map_err(|_| crate::cause!(Error::Unavailable))}
}
impl Handler {
    fn answer_turn(&self,from:&str,term:u64,scope:&Identity,plaintext:&[u8])->Result<Vec<u8>,Error> {
        if plaintext.len()>computers::settings().carried_bytes {return Err(crate::cause!(Error::Unavailable));}
        let context:Context=serde_json::from_slice(plaintext).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        if context.transfer.scope!=*scope {return Err(crate::cause!(Error::Conflict));}
        let owner=self.owner.upgrade().ok_or(crate::cause!(Error::Unavailable))?;let cancel=Arc::new(AtomicBool::new(false));
        let deadline=Instant::now()+Duration::from_millis(computers::settings().message_wait_ms);
        let admitted=admit(&owner,&context.session,scope,cancel.clone(),deadline)?;plan_current(&context,&admitted)?;
        let copies=self.copies.get().and_then(Weak::upgrade).ok_or(crate::cause!(Error::Unavailable))?;
        if copies.owner()!=admitted.account || context.transfer.target!=copies.computer() {return Err(crate::cause!(Error::Conflict));}
        if matches!(context.step,Step::Inspect) {
            let stage=admitted.authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Conflict))?;
            if !stage.activated || copies.holding()!=Some(term) || copies.writer_row().is_none_or(|(writer,number,_)|writer!=copies.computer()||number!=term) {return Err(crate::cause!(Error::Conflict));}
            let store=copies.open_domain_records(scope)?;
            if adoption::complete_domain_plan(&**store.storage(),context.plan.slot.clone(),context.plan.move_id.clone(),context.plan.source_incarnation.clone(),context.plan.target_incarnation.clone())!=context.plan
                || !matches!(adoption::recover(&**store.storage(),&context.plan,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?,Progress::Active {..}) {return Err(crate::cause!(Error::Conflict));}
            current(&admitted)?;
            return serde_json::to_vec(&Reply {request:None,await_seal:false,ready:true,active:true,installing:false}).map_err(|error| crate::carry_cause!(Error::Unavailable,error));
        }
        if copies.writer_row().is_none_or(|(writer,number,_)|writer!=from||number!=term) {return Err(crate::cause!(Error::Conflict));}
        {
            let mut sessions=self.installs.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            sessions.retain(|_,slot|slot.try_lock().map_or(true,|held|held.at.elapsed()<=Duration::from_millis(computers::settings().part_hold_ms as u64)));
        }
        let store=copies.open_domain_records(scope)?;
        if adoption::complete_domain_plan(&**store.storage(),context.plan.slot.clone(),context.plan.move_id.clone(),
            context.plan.source_incarnation.clone(),context.plan.target_incarnation.clone())!=context.plan {return Err(crate::cause!(Error::Conflict));}
        let answer=match &context.step {
            Step::Inspect=>return Err(crate::cause!(Error::Conflict)),
            Step::Prepare=>{
                if let Some(slot)=self.installs.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?.get(&context.plan.slot).cloned() {
                    let install=slot.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                    if install.source!=from || install.term!=term || install.plan!=context.plan {return Err(crate::cause!(Error::Conflict));}
                    current(&admitted)?;
                    return serde_json::to_vec(&Reply {request:None,await_seal:false,ready:true,active:false,installing:true}).map_err(|error| crate::carry_cause!(Error::Unavailable,error));
                }
                let storage=&**store.storage();storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                let prepared=(|| {
                    if !adoption::target_prepared(storage,&context.plan).map_err(|error| crate::carry_cause!(Error::Unavailable,error))? {
                        let baseline=copies.qualify_domain_replica(storage,from,term,scope)?;
                        adoption::prepare_replica(storage,&context.plan,limits()?,&admitted.authority,&baseline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                    }
                    current(&admitted)
                })();
                storage.close_scope(prepared.is_ok()).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;prepared?;
                reply(storage,&context.plan,&admitted,false)?
            },
            Step::Accept {response}=>{
                let outcome=portable::accept(&**store.storage(),&context.plan,response,limits()?,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                reply(&**store.storage(),&context.plan,&admitted,matches!(outcome,portable::Accepted::AwaitSeal {..}))?
            },
            Step::Activate {seal,head}=>{
                let progress=adoption::recover(&**store.storage(),&context.plan,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                if matches!(progress,Progress::Active {..}) {reply(&**store.storage(),&context.plan,&admitted,false)?} else {
                    if !matches!(progress,Progress::Ready {..}) || admitted.authority.current_incarnation()!=context.plan.target_incarnation {return Err(crate::cause!(Error::Conflict));}
                    let identity=content_crypto::advanced::blake3::hash(&serde_json::to_vec(&(&context.request,&context.transfer,&context.plan,head,seal)).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?).to_hex().to_string();
                    let slot={let mut sessions=self.installs.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                        sessions.retain(|_,slot|slot.try_lock().map_or(true,|held|held.at.elapsed()<=Duration::from_millis(computers::settings().part_hold_ms as u64)));
                        if let Some(slot)=sessions.get(&context.plan.slot) {slot.clone()}else{
                            if sessions.len()>=computers::settings().limits.most_admitted_computers as usize {return Err(crate::cause!(Error::Unavailable));}
                            store.storage().open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                            if let Some(key)=&head.key {
                                if let Err(error)=commit_log::opaque_map::bind_wrapped_key(&**store.storage(),&context.plan.slot,key,limits()?) {
                                    let _=store.storage().close_scope(false);return Err(crate::carry_cause!(Error::Unavailable,error));
                                }
                            }
                            let cursor=match commit_log::MaterializedBaselineCursor::begin(&**store.storage(),&context.plan.slot,head.through,head.digest.clone(),limits()?) {Ok(cursor)=>cursor,Err(error)=>{let _=store.storage().close_scope(false);return Err(crate::carry_cause!(Error::Unavailable,error));}};
                            let slot=Arc::new(Mutex::new(Install {store,cursor:Some(cursor),plan:context.plan.clone(),head:head.clone(),seal:seal.clone(),source:from.into(),term,at:Instant::now(),identity:identity.clone()}));
                            sessions.insert(context.plan.slot.clone(),slot.clone());slot
                        }};
                    let mut install=slot.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                    if install.identity!=identity || install.source!=from || install.term!=term || install.plan!=context.plan || install.head!=*head {return Err(crate::cause!(Error::Conflict));}
                    current(&admitted)?;
                    let activation_seal=install.seal.clone();
                    let Install {store:installed,cursor,..}=&mut *install;
                    let storage=&**installed.storage();
                    let done=cursor.as_mut().ok_or(crate::cause!(Error::Unavailable))?.step(storage).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                    if !done {Reply {request:None,await_seal:false,ready:true,active:false,installing:true}}else{
                        cursor.take().ok_or(crate::cause!(Error::Unavailable))?.finish(storage).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                        let record_limits=installed.limits();
                        let native_permit=admitted.authority.hold_native(&context.plan.target_incarnation).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                        portable::activate(storage,&context.plan,&activation_seal,limits()?,&admitted.authority,|target| {
                            let mut records=RecordStore::new(target,Box::new(RealClock),record_limits).map_err(|error|crate::carry_cause!(storage::Error::Unavailable,error))?;
                            crate::local_account::own_records::replace_domain_authority(&mut records,&admitted.account,scope,&context.plan.source_incarnation,&context.plan.target_incarnation,&context.plan.move_id).map_err(|error|crate::carry_cause!(storage::Error::Moved,error))?;
                            records.take_term(&admitted.account,&scope.resource(&admitted.account).map_err(|error|crate::carry_cause!(storage::Error::Invalid,error))?,term,head.through).map_err(|error|crate::carry_cause!(storage::Error::Moved,error))
                        }).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
                        current(&admitted)?;storage.close_scope(true).map_err(|error| {native_permit.mark_outcome_unknown();crate::carry_cause!(Error::Unavailable,error)})?;
                        drop(install);self.installs.lock().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?.remove(&context.plan.slot);
                        Reply {request:None,await_seal:false,ready:false,active:true,installing:false}
                    }
                }
            },
        };
        current(&admitted)?;serde_json::to_vec(&answer).map_err(|error| crate::carry_cause!(Error::Unavailable,error))
    }
}

impl DomainMaintenance for Handler {
    fn replica_authority(&self,scope:&Identity)->Result<Option<crate::local_account::NativeDomainAuthority>,Error> {
        let owner=self.owner.upgrade().ok_or(crate::cause!(Error::Unavailable))?;
        let cancel=Arc::new(AtomicBool::new(false));
        let deadline=Instant::now()+Duration::from_millis(computers::settings().part_hold_ms as u64);
        let mut held=owner_wait::acquire_background(&owner,||Instant::now()>=deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        held.current_replica_domain_authority(scope,cancel,deadline).map(Some).map_err(|error| crate::carry_cause!(Error::Unavailable,error))
    }
    fn answer(&self,from:&str,term:u64,scope:&Identity,plaintext:&[u8])->Result<Vec<u8>,Error> {
        let result=self.answer_turn(from,term,scope,plaintext);
        if result.is_err() {
            // A failed decoder, authority withdrawal or uncertain step abandons
            // the ONE unpublished activation transaction. The exact durable
            // Ready target remains the restart point; no cursor survives fault.
            if let Ok(context)=serde_json::from_slice::<Context>(plaintext) {
                if context.transfer.scope==*scope {
                    if let Ok(mut sessions)=self.installs.lock() {
                        let removable=sessions.get(&context.plan.slot).is_some_and(|slot|slot.try_lock().is_ok_and(|held|held.source==from&&held.term==term));
                        if removable {sessions.remove(&context.plan.slot);}
                    }
                }
            }
        }
        result
    }
}

fn exchange(copies:&Copies,session:&str,request:&str,input:&Transfer,source:&crate::local_account::record_writer::native_command_context::NativeRemoteDomainSource,step:Step)->Result<Reply,Error> {
    let context=Context {account:copies.owner().into(),session:session.into(),request:request.into(),transfer:input.clone(),plan:source.plan.clone(),step};
    let bytes=serde_json::to_vec(&context).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
    let reply=copies.maintenance_exchange(&input.target,&input.scope,&bytes)?;
    serde_json::from_slice(&reply).map_err(|error| crate::carry_cause!(Error::Unavailable,error))
}

/// Inspect the existing original registration through the same current own
/// browser management route. A caller can obtain the actual CAS revision;
/// it never guesses a revision or reads an internal policy database directly.
pub(crate) fn inspect(owner:Arc<Mutex<SelectedAccount>>,session:&str,scope:&Identity,cancel:Arc<AtomicBool>,deadline:Instant)->Result<Value,Error> {
    let admitted=admit(&owner,session,scope,cancel,deadline)?;
    let registration=admitted.authority.registration();current(&admitted)?;
    Ok(json!({"scope":scope,"registration_revision":registration.revision,
        "staged":registration.staged.as_ref().map(|stage|json!({"move_id":stage.move_id,"activated":stage.activated}))}))
}

/// One public retry is one bounded source/target turn. Network calls hold no
/// account owner, domain writer, native lease or canonical drain. The exact
/// request remains the retry identity until the selected writer is observed.
pub(crate) fn advance(owner:Arc<Mutex<SelectedAccount>>,session:&str,input:&Transfer,request:&str,cancel:Arc<AtomicBool>,deadline:Instant)->Result<Value,Error> {
    let move_id=input.identity(request)?;
    let first=admit(&owner,session,&input.scope,cancel.clone(),deadline)?;
    let copies=copies::running_for(&first.account).ok_or(crate::cause!(Error::Unavailable))?;
    // An exact retry routed to the activated target reads its real persisted
    // state. It cannot recreate another source or start a reverse transfer.
    if copies.computer()==input.target {
        let store=copies.open_domain_records(&input.scope)?;
        let stage=first.authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Conflict))?;
        if stage.move_id!=move_id || !stage.activated {return Err(crate::cause!(Error::Conflict));}
        let plan=adoption::complete_domain_plan(&**store.storage(),adoption::command_slot(&first.account,&serde_json::to_value(&input.scope).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?,move_id.clone(),stage.source_incarnation.clone(),stage.target_incarnation.clone());
        if !matches!(adoption::recover(&**store.storage(),&plan,&first.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?,Progress::Active {..})
            || copies.holding().is_none() {return Err(crate::cause!(Error::Unavailable));}
        current(&first)?;return Ok(json!({"state":"active","move_id":input.move_id,"scope":input.scope,"computer":input.target,"request_key":request}));
    }
    if let Some(stage)=first.authority.registration().staged.as_ref().filter(|stage|stage.activated&&stage.move_id==move_id) {
        if copies.writer_row().is_some_and(|(writer,_,_)|writer==input.target) {
            let store=copies.open_domain_records(&input.scope)?;
            let slot=adoption::command_slot(&first.account,&serde_json::to_value(&input.scope).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            let plan=adoption::complete_domain_plan(&**store.storage(),slot,move_id.clone(),stage.source_incarnation.clone(),stage.target_incarnation.clone());
            let context=Context {account:first.account.clone(),session:session.into(),request:request.into(),transfer:input.clone(),plan,step:Step::Inspect};
            let bytes=serde_json::to_vec(&context).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            let result=copies.maintenance_query(&input.target,&input.scope,&bytes)?;
            let reply:Reply=serde_json::from_slice(&result).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            if !reply.active {return Err(crate::cause!(Error::Unavailable));}current(&first)?;
            return Ok(json!({"state":"active","move_id":input.move_id,"scope":input.scope,"computer":input.target,"request_key":request}));
        }
    }
    let control=if first.authority.registration().staged.as_ref().is_some_and(|stage|stage.move_id==move_id) {None}else{Some(first.authority.drain_native().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?)};
    let mut source={let mut held=owner_wait::acquire_background(&owner,||cancel.load(Ordering::Acquire)||Instant::now()>=deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        held.prepare_browser_domain_source(session,&input.scope,&move_id,request,input.expected_revision,cancel.clone(),deadline,control).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?};
    let admitted=admit(&owner,session,&input.scope,cancel.clone(),deadline)?;
    source.prepare(&admitted.authority,cancel.clone(),deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;current(&admitted)?;
    let copied=copies.account_stores_step();if copied.refused {return Err(crate::cause!(Error::Unavailable));}
    let mut answer=exchange(&copies,session,request,input,&source,Step::Prepare)?;
    if let Some(next)=answer.request.take() {
        let held=source.writer.lend(cancel.clone(),deadline)?;let storage=held.storage().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        let response=portable::export(&storage,&source.plan,&next,limits()?,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        drop(storage);drop(held);current(&admitted)?;
        answer=exchange(&copies,session,request,input,&source,Step::Accept {response})?;
    }
    if answer.await_seal {
        let held=source.writer.lend(cancel.clone(),deadline)?;let storage=held.storage().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        portable::seal_reply(&storage,&source.plan,limits()?,&admitted.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
    }
    if answer.ready {
        // The final source seal is reopened by SealedSourceProof. Canonical
        // retirement cannot be granted by the remote target's status or text.
        let drained=admitted.authority.drain_native().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        {let mut held=owner_wait::acquire_background(&owner,||cancel.load(Ordering::Acquire)||Instant::now()>=deadline).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            held.activate_browser_domain_source(session,&source,cancel.clone(),deadline,drained).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;}
        if copies.account_stores_step().refused {return Err(crate::cause!(Error::Unavailable));}
        let fresh=admit(&owner,session,&input.scope,cancel.clone(),deadline)?;
        let held=source.writer.lend(cancel.clone(),deadline)?;let storage=held.storage().map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        let seal=portable::seal_reply(&storage,&source.plan,limits()?,&fresh.authority).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
        let head=(|| {let front=commit_log::frontiers(&storage,&source.plan.slot,limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;
            if front.stored!=front.materialized {return Err(crate::cause!(Error::Conflict));}Ok(Head {through:front.materialized,digest:commit_log::last_digest(&storage,&source.plan.slot,limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?,
                key:commit_log::opaque_map::wrapped_key(&storage,&source.plan.slot,limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?})})();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable,error))?;let head=head?;drop(storage);drop(held);
        answer=exchange(&copies,session,request,input,&source,Step::Activate {seal,head})?;
        current(&fresh)?;
    }
    let handed_over=if answer.active {copies.hand_over_domain_to(&input.scope,&input.target)?}else{false};
    current(&admitted)?;
    Ok(json!({"state":if handed_over {"active"}else if answer.active {"handover_pending"}else if answer.installing {"activating"}else if answer.ready {"ready"}else{"copying"},
        "move_id":input.move_id,"scope":input.scope,"computer":input.target,"request_key":request}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfer_identity_binds_target_request_revision_and_complete_history() {
        let transfer=Transfer {scope:Identity {id:"synthetic-history".into(),incarnation:"first".into(),generation:1},target:"1".repeat(64),move_id:"synthetic-move".into(),expected_revision:1};
        let original=transfer.identity("original-request").unwrap();
        assert_eq!(original,transfer.identity("original-request").unwrap());
        assert_ne!(original,transfer.identity("another-request").unwrap());
        let mut changed=transfer.clone();changed.target="2".repeat(64);assert_ne!(original,changed.identity("original-request").unwrap());
        let mut changed=transfer.clone();changed.scope.generation=2;assert_ne!(original,changed.identity("original-request").unwrap());
        let mut changed=transfer.clone();changed.scope.incarnation="recreated".into();assert_ne!(original,changed.identity("original-request").unwrap());
        let mut changed=transfer.clone();changed.expected_revision=2;assert_ne!(original,changed.identity("original-request").unwrap());
        let mut changed=transfer.clone();changed.scope.id.clear();assert!(changed.identity("original-request").is_err());
    }
}
