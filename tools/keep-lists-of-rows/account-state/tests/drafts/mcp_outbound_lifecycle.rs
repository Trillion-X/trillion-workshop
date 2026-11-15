// Child of existing connection-credential controls. Uses the SAME real
// selected LocalAccount, APP_KV issuer and canonical registration fixture.
use super::*;
use crate::{native_boot::mcp_outbound::CredentialState,record_log::LogIds};

#[derive(Default)]
struct NoMintIds(usize);
impl LogIds for NoMintIds {
    fn next_log_id(&mut self)->Option<String> { self.0+=1; None }
}
fn maintain(state:&mut CredentialState,admission:&SelectedCredentialAdmission,key:&str,now:i64,ids:&mut NoMintIds) {
    state.maintain(admission,key.as_bytes(),now,now,Instant::now()+Duration::from_secs(5),
        Arc::new(AtomicBool::new(false)),ids);
}

#[test]
fn native_lifecycle_recovers_startup_and_reconnect_without_mint_or_write() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let original=issued(&admission,&key,"synthetic-lifecycle-original",0,now).unwrap();
    let kept=policy_rows(&fixture);let before=work(&selected);
    let mut state=CredentialState::default();let mut ids=NoMintIds::default();
    maintain(&mut state,&admission,&key,now,&mut ids);
    assert_eq!(state.active().unwrap().as_bytes(),original.as_bytes());assert!(state.pending().is_none());
    maintain(&mut state,&admission,&key,now,&mut ids);
    assert_eq!(state.active().unwrap().as_bytes(),original.as_bytes());assert_eq!(ids.0,0);
    assert_eq!(difference(&before,&work(&selected)).rows_written,0);assert_eq!(policy_rows(&fixture),kept);
}

#[test]
fn native_lifecycle_adopts_same_time_rotation_without_old_expiry_wait() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let first=issued(&admission,&key,"synthetic-lifecycle-first",0,now).unwrap();
    let mut state=CredentialState::default();let mut ids=NoMintIds::default();
    maintain(&mut state,&admission,&key,now,&mut ids);
    let next=issued(&admission,&key,"synthetic-lifecycle-next",1,now).unwrap();
    assert_eq!(first.grant().expires_at_ms,next.grant().expires_at_ms);
    assert!(!admission.is_current(state.active().unwrap().grant(),now));
    let before=work(&selected);let kept=policy_rows(&fixture);
    maintain(&mut state,&admission,&key,now,&mut ids);
    assert_eq!(state.active().unwrap().as_bytes(),next.as_bytes());assert_eq!(ids.0,0);
    assert!(admission.is_current(state.active().unwrap().grant(),now));
    assert_eq!(difference(&before,&work(&selected)).rows_written,0);assert_eq!(policy_rows(&fixture),kept);
}

#[test]
fn native_lifecycle_busy_recovery_keeps_unknown_identity_then_recovers_committed_result() {
    let (fixture,key)=setup();let (selected,admission)=source(&fixture,&key);let now=millis() as i64;
    let original=issued(&admission,&key,"synthetic-lifecycle-unknown",0,now).unwrap();
    let mut state=CredentialState::with_pending("synthetic-lifecycle-unknown",0);let mut ids=NoMintIds::default();
    let before=work(&selected);let kept=policy_rows(&fixture);
    let held=selected.lock().unwrap();
    maintain(&mut state,&admission,&key,now,&mut ids);
    assert_eq!(state.pending(),Some(("synthetic-lifecycle-unknown",0)));assert!(state.active().is_none());assert_eq!(ids.0,0);
    drop(held);
    maintain(&mut state,&admission,&key,now,&mut ids);
    assert!(state.pending().is_none());assert_eq!(state.active().unwrap().as_bytes(),original.as_bytes());assert_eq!(ids.0,0);
    assert_eq!(difference(&before,&work(&selected)).rows_written,0);assert_eq!(policy_rows(&fixture),kept);
}
