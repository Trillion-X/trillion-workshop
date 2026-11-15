// The door's workspace write's final result-chunk owner.
// Every last chunk recovers the SAME sealed original journal binding while
// the door's sign-in still admits its caller. Recovery is explicitly effect-free. The
// original protected result and its IMMEDIATE source reservation stay owned
// by the returned Bytes through SDK consumption or connection socket flush.
use super::workspace_write::{prepare_owned_workspace_write, PreparedOwnedWorkspaceWrite};
use crate::{
    ecma_json,
    local_account::record_writer::{self, native_command_context::OriginalWorkspaceOutputCustody},
    mcp::{FinalBodyCustody, Operation, Principal, RequestDisclosure},
    native_boot::{SelectedAccount,tool_screens::ToolLabelLocale},
    record_log::{CanonicalLogIds, LogIds},
    tool_label_locale::QualifiedLocale,
    workspace_session::owner_wait::OwnerWait,
};
use axum::body::{Body, Bytes};
use http_body::{Body as HttpBody, Frame as Chunk, SizeHint};
use std::{io,pin::Pin,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},task::{Context,Poll},time::Instant};
use zeroize::Zeroizing;

pub(crate) struct PreparedPersonalWrite {
    command: PreparedOwnedWorkspaceWrite,
    operation: Operation,
    caller: crate::account::account_routes::Caller,
    locale: Arc<QualifiedLocale>,
    expected: ecma_json::Value,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl PreparedPersonalWrite {
    fn expired(&self)->bool {self.cancel.load(Ordering::Acquire)||Instant::now()>=self.deadline}
    pub(crate) fn register(self,disclosure:&RequestDisclosure,owner:Arc<Mutex<SelectedAccount>>)->Result<(),crate::refusal_cause::CodedError<()>> {
        if !Arc::ptr_eq(&self.cancel,&disclosure.cancellation_flag()){return Err(crate::refusal_cause::CodedError::new(()));}
        disclosure.register(Box::new(WriteCustody{prepared:self,owner}))
    }
}
impl SelectedAccount {
    pub(crate) fn prepare_door_workspace_write_result(
        &mut self,caller:&crate::account::account_routes::Caller,operation:&Operation,
        cancel:Arc<AtomicBool>,deadline:Instant,
        ids:&mut dyn LogIds,
        run_current:&dyn Fn()->bool,
    )->record_writer::Result<(serde_json::Value,PreparedPersonalWrite)> {
        let original_cancel=cancel.clone();
        self.with_door_write(caller,operation,cancel,
            |owner,current,selection,sign_in,locale,request,context,cancel| {
                // A tool run's write (its capability, `account_rights::run_capability`) stands only while the run's
                // capability is live: asked with the caller's own check at every check the writer keeps, as the
                // account's own record write asks it (`door_records_write`). Every other caller's is always true.
                let mut current=|owner:&mut crate::local_account::LocalAccount|{
                    if !run_current(){return Err(crate::cause!(crate::account::AccountError::RightsRefused));}
                    current(owner)?;
                    if !run_current(){return Err(crate::cause!(crate::account::AccountError::RightsRefused));}
                    Ok(())
                };
                let current=&mut current;
                let command=prepare_owned_workspace_write(owner,operation,sign_in,locale,request,context)?;
                let selected=||{
                    selection.assert_current().map_err(|error| crate::carry_cause!(record_writer::Error::Source, error))?;
                    locale.assert_current().map_err(|error| crate::carry_cause!(record_writer::Error::Source, error))
                };
                let result=owner.execute_selected_workspace_write_checked(
                    &command.call(sign_in,cancel,deadline),ids,&selected,current,
                    &mut|a,b|locale.compare(a,b).map_err(|_|()),
                )?;
                let encoded=ecma_json::stringify(&result.value,Default::default()).map_err(|error| crate::carry_cause!(record_writer::Error::OutcomeUnknown, error))?;
                let value:serde_json::Value=serde_json::from_str(&encoded).map_err(|error| crate::carry_cause!(record_writer::Error::OutcomeUnknown, error))?;
                Ok((value,PreparedPersonalWrite{command,operation:operation.clone(),caller:caller.clone(),
                    locale:Arc::clone(locale),expected:result.value,cancel:original_cancel,deadline}))
            })
    }
    fn recover_door_workspace_write_result(
        &mut self,held:&PreparedPersonalWrite,
    )->record_writer::Result<OriginalWorkspaceOutputCustody> {
        if held.expired(){return Err(crate::cause!(record_writer::Error::Refused));}
        self.with_door_write(&held.caller,&held.operation,held.cancel.clone(),
            |owner,current,selection,sign_in,_locale,_,_,cancel| {
                // The retained command includes its original generation,
                // accepted time/context and exact input. No rebuilt retry ID.
                let selected=||{
                    selection.assert_current().map_err(|error| crate::carry_cause!(record_writer::Error::Source, error))?;
                    held.locale.assert_current().map_err(|error| crate::carry_cause!(record_writer::Error::Source, error))
                };
                let (result,custody)=owner.recover_selected_workspace_write_custody_checked(
                    &held.command.call(sign_in,cancel,held.deadline),&mut CanonicalLogIds::default(),&selected,current,
                    &mut|a,b|held.locale.compare(a,b).map_err(|_|()),
                )?;
                if !result.duplicate||result.value!=held.expected{return Err(crate::cause!(record_writer::Error::ProtectedResultUnavailable));}
                // Only comparison/ownership moves follow the writer's actual
                // final permit. No new account/source query reopens that check.
                Ok(custody)
            })
    }
}
struct WriteCustody {prepared:PreparedPersonalWrite,owner:Arc<Mutex<SelectedAccount>>}
impl FinalBodyCustody for WriteCustody {
    fn finish(self:Box<Self>,body:Body,principal:&Principal,bearer:Zeroizing<Vec<u8>>,ingress:Arc<dyn Send+Sync>)->Result<Body, crate::refusal_cause::CodedError<()>> {
        if principal!=&self.prepared.caller.principal{return Err(crate::refusal_cause::CodedError::new(()));}
        drop(bearer);
        Ok(Body::new(WriteBody{prepared:Some(self.prepared),owner:self.owner,ingress,inner:body,wait:OwnerWait::new(),failed:false}))
    }
}
struct KeptWriteChunk {
    bytes:Bytes,
    _original:Mutex<OriginalWorkspaceOutputCustody>,
    _owner:Arc<Mutex<SelectedAccount>>,
    _ingress:Arc<dyn Send+Sync>,
}
impl AsRef<[u8]> for KeptWriteChunk {fn as_ref(&self)->&[u8]{&self.bytes}}
struct WriteBody {
    prepared:Option<PreparedPersonalWrite>,owner:Arc<Mutex<SelectedAccount>>,
    ingress:Arc<dyn Send+Sync>,inner:Body,wait:OwnerWait,failed:bool,
}
impl HttpBody for WriteBody {
    type Data=Bytes;type Error=io::Error;
    fn poll_frame(mut self:Pin<&mut Self>,cx:&mut Context<'_>)->Poll<Option<Result<Chunk<Bytes>,io::Error>>> {
        if self.failed{return Poll::Ready(None);}
        let Some(prepared)=self.prepared.as_ref() else{return Poll::Ready(None)};
        if prepared.expired(){
            #[cfg(test)]
            crate::quiet_eprintln!("selected write last chunk expired: cancelled={}, deadline_elapsed={}",prepared.cancel.load(Ordering::Acquire),Instant::now()>=prepared.deadline);
            self.prepared.take();self.inner=Body::empty();self.failed=true;return Poll::Ready(Some(crate::io_operation!(Err(io::Error::from(io::ErrorKind::PermissionDenied)))));
        }
        let selected=self.owner.clone();
        let mut owner=match self.wait.poll(selected.as_ref(),false,cx){Poll::Pending=>return Poll::Pending,
            Poll::Ready(Err(error))=>{self.prepared.take();self.inner=Body::empty();self.failed=true;return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), error.cause()))));},
            Poll::Ready(Ok(owner))=>owner};
        let result=owner.recover_door_workspace_write_result(self.prepared.as_ref().expect("held original write"));
        let custody=match result {Ok(custody)=>custody,Err(_error)=>{
            #[cfg(test)]
            crate::quiet_eprintln!("selected write final recovery refused cause={}", _error.cause());
            self.prepared.take();self.inner=Body::empty();self.failed=true;return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), _error.cause()))));
        }};
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Pending=>Poll::Pending,
            Poll::Ready(None)=>{self.prepared.take();Poll::Ready(None)},
            Poll::Ready(Some(Err(error)))=>{self.prepared.take();self.failed=true;Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::Other), crate::refusal_cause::Caused::cause(&error)))))},
            Poll::Ready(Some(Ok(chunk)))=>match chunk.into_data(){
                Ok(bytes)=>{self.prepared.take();Poll::Ready(Some(Ok(Chunk::data(Bytes::from_owner(KeptWriteChunk{
                    bytes,_original:Mutex::new(custody),_owner:self.owner.clone(),_ingress:self.ingress.clone(),
                })))))},
                Err(_)=>{self.prepared.take();self.failed=true;Poll::Ready(Some(crate::io_operation!(Err(io::Error::from(io::ErrorKind::InvalidData)))))},
            },
        }
    }
    fn is_end_stream(&self)->bool{self.failed||self.prepared.is_none()}
    fn size_hint(&self)->SizeHint{SizeHint::default()}
}
