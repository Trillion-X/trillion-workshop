// Existing CanonicalWorkspace/OwnerRoutes dispatches this explicit POST.
// No listener, credential, automatic enrollment or parallel route owner exists.
use super::{CancelReadOnDrop,LocalWorkspace};
use crate::{
    account_rights::{self,resource_connection::Change},
    native_boot::{SelectedAccount,connection_management::{BrowserConnectionChange,BrowserDomainTransferResult}},
    workspace::{SupplyFuture,WorkspaceError},
    workspace_domain::{DomainAnswer,DomainCommand,DomainContext,PAGE_STORE_HEADER,REQUEST_KEY_HEADER},
    workspace_session::owner_wait::{self,OwnerWait},
};
use axum::{body::{Body,Bytes},http::{header,HeaderValue,Method},response::Response};
use http_body::{Body as HttpBody,Frame,SizeHint};
use serde::Deserialize;
use serde_json::Value;
use std::{io,pin::Pin,sync::{Arc,Mutex},task::{Context,Poll},time::{Duration,Instant}};

pub(super) const OPERATION:&str="resource-connections:request";
pub(super) const PATH:&str="/resource-connections";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationInput {device_id:String,resource_address:String,resource_generation:u64,expected_registration_revision:u64,active:bool}
#[derive(Deserialize)]
#[serde(untagged)]
enum Input {Registration(RegistrationInput),Transfer(TransferInput),Inspect(InspectInput)}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferInput {transfer:crate::native_entry::computer::domain_transfer::Transfer}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectInput {inspect:crate::storage::record_store_resources::domains::Identity}
pub(super) fn request(input:&Value)->Result<(),WorkspaceError> {
    let fields=input.as_object().ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if fields.len()!=3 || input["path"]!=PATH || input["method"]!="POST" {return Err(crate::cause!(WorkspaceError::Invalid));}
    let _:Input=serde_json::from_value(input["body"].clone()).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    Ok(())
}
fn change(command:&DomainCommand)->Result<Change,WorkspaceError> {
    request(&command.input)?;
    if command.operation!=OPERATION || !command.key_carried {return Err(crate::cause!(WorkspaceError::Invalid));}
    let input:RegistrationInput=serde_json::from_value(command.input["body"].clone()).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    let value=Change {device_id:input.device_id,resource_address:input.resource_address,resource_generation:input.resource_generation,
        expected_registration_revision:input.expected_registration_revision,active:input.active,request_key:command.request_key.clone()};
    value.identity().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    Ok(value)
}
/// The answer to a failure of a transfer: `not_started` (retry the same key) when the cause is a lock another connection held
/// before the transfer began (`Retry::Busy`), else `unknown`.
fn outcome_of_failure(command:&DomainCommand,cause:crate::refusal_cause::Cause)->DomainAnswer {
    let retry=cause.retry();
    failure_answer(command,cause,retry)
}
/// A registration failure is `unknown` whatever its cause: a failure can follow the policy commit it made, so a lock is never
/// the answer to whether it applied.
fn registration_failure(command:&DomainCommand,cause:crate::refusal_cause::Cause)->DomainAnswer {
    failure_answer(command,cause,crate::refusal_cause::Retry::Other)
}
fn failure_answer(command:&DomainCommand,cause:crate::refusal_cause::Cause,retry:crate::refusal_cause::Retry)->DomainAnswer {
    let (error,outcome)=match retry {
        crate::refusal_cause::Retry::Busy=>("registration_not_started","not_started"),
        crate::refusal_cause::Retry::Other=>("registration_outcome_unknown","unknown"),
    };
    let mut headers=axum::http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE,HeaderValue::from_static("application/json"));
    DomainAnswer::Http {status:axum::http::StatusCode::SERVICE_UNAVAILABLE,headers,
        body:serde_json::to_vec(&serde_json::json!({"error":error,"outcome":outcome,"cause":cause.id(),
            "request_key":command.request_key,"next_call":{"operation":command.operation,"input":command.input,"request_key":command.request_key}}))
            .expect("fixed registration failure result")}
}
enum ManagementResult {Registration(BrowserConnectionChange),Transfer(BrowserDomainTransferResult)}
impl ManagementResult {fn expired(&self)->bool {match self {Self::Registration(held)=>held.expired(),Self::Transfer(held)=>held.expired()}}}
struct ResultBody {owner:Arc<Mutex<SelectedAccount>>,context:DomainContext,held:Option<ManagementResult>,wait:OwnerWait}
struct KeptChunk {bytes:Vec<u8>,_context:DomainContext}
impl AsRef<[u8]> for KeptChunk {fn as_ref(&self)->&[u8]{&self.bytes}}
impl HttpBody for ResultBody {
    type Data=Bytes;type Error=io::Error;
    fn poll_frame(mut self:Pin<&mut Self>,cx:&mut Context<'_>)->Poll<Option<Result<Frame<Bytes>,io::Error>>> {
        let Some(held)=self.held.as_ref() else{return Poll::Ready(None)};
        if held.expired()||self.context.permit.cancelled(){self.held.take();return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied),crate::cause!()))));}
        let selected=self.owner.clone();let cancelled=self.context.permit.cancelled();
        let mut owner=match self.wait.poll(selected.as_ref(),cancelled,cx){Poll::Pending=>return Poll::Pending,
            Poll::Ready(Err(error))=>{self.held.take();return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied),error.cause()))));},Poll::Ready(Ok(owner))=>owner};
        let held=self.held.take().expect("pending registration result");
        let result=match held {ManagementResult::Registration(held)=>owner.finish_browser_resource_connection(&held),ManagementResult::Transfer(held)=>owner.finish_browser_domain_transfer(&held)}.map_err(|error| crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied),error.cause()))
            .and_then(|value|serde_json::to_vec(&value).map_err(|_error| crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::InvalidData),crate::cause!())));
        Poll::Ready(Some(result.map(|bytes|Frame::data(Bytes::from_owner(KeptChunk{bytes,_context:self.context.clone()})))))
    }
    fn is_end_stream(&self)->bool{self.held.is_none()}
    fn size_hint(&self)->SizeHint{SizeHint::default()}
}
impl LocalWorkspace {
    pub(super) fn change_connection(&self,context:DomainContext,command:DomainCommand)->SupplyFuture<DomainAnswer> {
        let owner=self.owner.clone();let sessions=self.sessions.clone();
        Box::pin(async move {
            request(&command.input)?;
            if command.operation!=OPERATION||!command.key_carried {return Err(crate::cause!(WorkspaceError::Invalid));}
            if context.head.method!=Method::POST||context.head.uri.path()!="/work/api/resource-connections"||context.head.uri.query().is_some(){return Err(crate::cause!(WorkspaceError::Forbidden));}
            let scope=sessions.authorize(context.clone()).await?;
            // Both are mandatory for this new management action, including
            // callers using the executor directly rather than CanonicalWorkspace.
            for (name,expected) in [(header::ORIGIN,scope.origin.as_str()),(PAGE_STORE_HEADER,scope.page_store.as_str())] {
                let values=context.head.headers.get_all(name);let mut values=values.iter();
                if values.next().and_then(|v|v.to_str().ok())!=Some(expected)||values.next().is_some(){return Err(crate::cause!(WorkspaceError::Forbidden));}
            }
            if scope.read_only{return Err(crate::cause!(WorkspaceError::Forbidden));}
            let deadline=Instant::now()+Duration::from_secs(5);
            let mut cancellation=CancelReadOnDrop(Some(context.permit.clone()));
            let retained=context.clone();let pending=owner.clone();
            let management:Input=serde_json::from_value(command.input["body"].clone()).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            if !matches!(management,Input::Registration(_)) {
                if let Input::Transfer(input)=&management {input.transfer.identity(&command.request_key).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;}
                let transfer_guard=match &management {Input::Transfer(input)=>Some((input.transfer.scope.clone(),input.transfer.identity(&command.request_key).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?,input.transfer.target.clone())),_=>None};
                let session=retained.session.clone();let request_key=command.request_key.clone();
                let flag=retained.permit.cancellation_flag();let returned_session=session.clone();let returned_flag=flag.clone();
                let answer=crate::storage::request_work::spawn_blocking(move|| match management {
                    Input::Transfer(input)=>crate::native_entry::computer::domain_transfer::advance(pending,&session.session_id,&input.transfer,&request_key,flag,deadline),
                    Input::Inspect(input)=>crate::native_entry::computer::domain_transfer::inspect(pending,&session.session_id,&input.inspect,flag,deadline),
                    Input::Registration(_)=>Err(crate::cause!(crate::records::Error::Unavailable)),
                }).await;
                let value=match answer {
                    Ok(Ok(value))=>value,
                    Ok(Err(error))=>{cancellation.0.take();return Ok(outcome_of_failure(&command,error.cause()));},
                    Err(error)=>{let cause=crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(||crate::cause!());cancellation.0.take();return Ok(outcome_of_failure(&command,cause));},
                };
                let result=BrowserDomainTransferResult::new(returned_session,value,transfer_guard,returned_flag,deadline);
                let mut response=Response::new(Body::new(ResultBody {owner,context,held:Some(ManagementResult::Transfer(result)),wait:OwnerWait::new()}));
                response.headers_mut().insert(header::CONTENT_TYPE,HeaderValue::from_static("application/json"));
                response.headers_mut().insert(header::CACHE_CONTROL,HeaderValue::from_static("no-store"));
                response.headers_mut().insert(REQUEST_KEY_HEADER,HeaderValue::from_str(&command.request_key).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
                cancellation.0.take();return Ok(DomainAnswer::Response(response));
            }
            let input=change(&command)?;
            let attempt=crate::storage::request_work::spawn_blocking(move||{
                let mut owner=owner_wait::acquire(pending.as_ref(),||retained.permit.cancelled()||Instant::now()>=deadline)
                    .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
                owner.change_browser_resource_connection(retained.session.clone(),&input,retained.permit.cancellation_flag(),deadline)
            }).await;
            // A failed source check/response can follow the actual policy
            // commit. Preserve the same request key; never label it not-started.
            let held=match attempt {
                Ok(Ok(held))=>held,
                Ok(Err(account_rights::Error::Invalid(cause)))=>return Err(WorkspaceError::Invalid(cause)),
                Ok(Err(error))=>{cancellation.0.take();return Ok(registration_failure(&command,error.cause()));},
                Err(error)=>{let cause=crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(||crate::cause!());cancellation.0.take();return Ok(registration_failure(&command,cause));},
            };
            let mut response=Response::new(Body::new(ResultBody{owner,context,held:Some(ManagementResult::Registration(held)),wait:OwnerWait::new()}));
            response.headers_mut().insert(header::CONTENT_TYPE,HeaderValue::from_static("application/json"));
            response.headers_mut().insert(header::CACHE_CONTROL,HeaderValue::from_static("no-store"));
            response.headers_mut().insert(REQUEST_KEY_HEADER,HeaderValue::from_str(&command.request_key).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
            cancellation.0.take();Ok(DomainAnswer::Response(response))
        })
    }
}

#[cfg(test)]
mod failure_answer_tests {
    use super::*;

    fn command() -> DomainCommand {
        DomainCommand { operation: "transfer".into(), input: serde_json::json!({}), request_key: "synthetic-key".into(), key_carried: true }
    }

    fn answered(cause: crate::refusal_cause::Cause) -> (u16, Value) {
        let DomainAnswer::Http { status, body, .. } = outcome_of_failure(&command(), cause) else { panic!("an HTTP answer") };
        (status.as_u16(), serde_json::from_slice(&body).unwrap())
    }

    /// A lock another connection held before the transfer began is `not_started`: the same key may be retried.
    #[test]
    fn a_busy_cause_is_not_started_and_any_other_is_unknown() {
        let busy = crate::refusal_cause::Cause::from_caller().with_retry(crate::refusal_cause::Retry::Busy);
        let (status, body) = answered(busy);
        assert_eq!((status, body["error"].as_str(), body["outcome"].as_str()), (503, Some("registration_not_started"), Some("not_started")));
        let (status, body) = answered(crate::refusal_cause::Cause::from_caller());
        assert_eq!((status, body["error"].as_str(), body["outcome"].as_str()), (503, Some("registration_outcome_unknown"), Some("unknown")));
    }
}
