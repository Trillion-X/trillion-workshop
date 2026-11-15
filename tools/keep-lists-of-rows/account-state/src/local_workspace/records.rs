//! Actual raw /records first-chunk boundary. Reuse the existing account mutex,
//! OwnerWait, request permit and heads' zeroizing permit-chunk owner. Never
//! detach a generic Vec HTTP body or treat preparation as delivery authority.
use super::{heads::PermitChunk, CancelReadOnDrop, LocalWorkspace};
use crate::{
    local_account::record_delivery::{Delivery, RecordDeliveryWitness},
    native_boot::SelectedAccount,
    workspace::{SupplyFuture, WorkspaceError},
    workspace_domain::{DomainAnswer, DomainContext},
    workspace_store::{Limits, Selection},
    workspace_session::owner_wait::{self, OwnerWait},
};
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};
use zeroize::Zeroizing;

/// A refusal of the page's records read, named by the stage that refused and its cause, on one stderr line: the Mac
/// app copies it into its log beside `native-workspace-refused`, which names only the status. Nothing of the request,
/// a label, a record or a key is written.
fn refused(stage: &'static str, error: WorkspaceError) -> WorkspaceError {
    crate::quiet_eprintln!("native-records-read-refused stage={stage} cause={}", error.cause());
    error
}
/// `refused` for a read store's failure: the kind it names is the cause.
fn refused_kind(stage: &'static str, failure: crate::workspace_store::Failure) -> WorkspaceError {
    refused(stage, super::snapshot_error(failure.kind))
}

/// The generic page read retains its admitted domain, keys and authority all
/// the way to the actual byte owner. Preparing a JSON value is not disclosure.
/// The canonical workspace serializer still owns the HTTP shape and headers.
pub(super) fn guarded_door_answer(
    owner: Arc<Mutex<SelectedAccount>>,
    context: DomainContext,
    read: crate::native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead,
    answer: DomainAnswer,
) -> Result<DomainAnswer, WorkspaceError> {
    let response = crate::workspace_domain::response(answer)?;
    let (parts, inner) = response.into_parts();
    Ok(DomainAnswer::Response(Response::from_parts(parts, Body::new(DoorReadBody {
        owner,
        context: Some(context),
        read: Some(read),
        inner,
        ready: None,
        owner_wait: OwnerWait::new(),
    }))))
}

struct DoorReadBody {
    owner: Arc<Mutex<SelectedAccount>>,
    context: Option<DomainContext>,
    read: Option<crate::native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead>,
    inner: Body,
    ready: Option<Bytes>,
    owner_wait: OwnerWait,
}
struct KeptDoorRead {
    bytes: Bytes,
    _read: crate::native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead,
    _context: DomainContext,
    _owner: Arc<Mutex<SelectedAccount>>,
}
impl AsRef<[u8]> for KeptDoorRead {
    fn as_ref(&self) -> &[u8] { &self.bytes }
}
impl HttpBody for DoorReadBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let Some(context) = &self.context else { return Poll::Ready(None); };
        let fail = |this: &mut Self, cause: crate::refusal_cause::Cause| {
            this.context.take();
            this.read.take();
            this.ready.take();
            this.inner = Body::empty();
            Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))))
        };
        if context.permit.cancelled() { return fail(&mut self, crate::cause!()); }
        if self.ready.is_none() {
            self.ready = match Pin::new(&mut self.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                    Ok(bytes) if bytes.len() <= crate::mcp::MAX_MESSAGE_BYTES => Some(bytes),
                    Ok(_) => return fail(&mut self, crate::cause!()),
                    Err(_) => return fail(&mut self, crate::cause!()),
                },
                Poll::Ready(Some(Err(error))) => return fail(&mut self, crate::refusal_cause::Caused::cause(&error)),
                Poll::Ready(None) => return fail(&mut self, crate::cause!()),
            };
        }
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(None) => {},
            Poll::Ready(Some(Err(error))) => return fail(&mut self, crate::refusal_cause::Caused::cause(&error)),
            Poll::Ready(Some(Ok(_))) => return fail(&mut self, crate::cause!()),
        }
        let owner = self.owner.clone();
        let mut selected = match self.owner_wait.poll(owner.as_ref(), false, cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Ok(selected)) => selected,
            Poll::Ready(Err(error)) => return fail(&mut self, error.cause()),
        };
        let context = self.context.as_ref().expect("retained page read");
        // The real current browser check precedes the physical domain/key
        // check. No callback can run after the final key custody check.
        let current = crate::account::current_browser_read_only(&mut *selected, &context.session.session_id)
            .map_err(super::account_error)
            .and_then(|admitted| super::same_admission(&admitted, &context.session));
        if let Err(error) = current {
            return fail(&mut self, error.cause());
        }
        if let Err(error) = selected.confirm_page_records_read(self.read.as_ref().expect("retained admission")) {
            return fail(&mut self, error.cause());
        }
        if context.permit.cancelled() { return fail(&mut self, crate::cause!()); }
        let read = self.read.take().expect("confirmed page read");
        let context = self.context.take().expect("confirmed page context");
        let bytes = self.ready.take().expect("bounded page bytes");
        Poll::Ready(Some(Ok(Frame::data(Bytes::from_owner(KeptDoorRead {
            bytes,
            _read: read,
            _context: context,
            _owner: self.owner.clone(),
        })))))
    }
    fn is_end_stream(&self) -> bool { self.context.is_none() }
    fn size_hint(&self) -> SizeHint { SizeHint::default() }
}

struct RecordsBody {
    bytes: Option<Zeroizing<Vec<u8>>>,
    owner: Arc<Mutex<SelectedAccount>>,
    context: DomainContext,
    witness: RecordDeliveryWitness,
    owner_wait: OwnerWait,
    failed: bool,
}
impl HttpBody for RecordsBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.failed || self.bytes.is_none() {
            return Poll::Ready(None);
        }
        if self.context.permit.cancelled() || self.witness.expired() {
            let cause = crate::cause!();
            crate::quiet_eprintln!("native-records-read-refused stage=delivery cause={cause}");
            self.bytes.take();
            self.failed = true;
            return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))));
        }
        let selected = self.owner.clone();
        let cancelled = self.context.permit.cancelled();
        let checked = match self.owner_wait.poll(selected.as_ref(), cancelled, cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(error)) => Err(error.cause()),
            Poll::Ready(Ok(mut owner)) => {
                let checked = owner
                    .workspace_store_delivery_current(
                        &self.context.session,
                        &self.context.permit,
                        &self.witness,
                    )
                    .map_err(|error| error.cause());
                if self.context.permit.cancelled() || self.witness.expired() {
                    Err(crate::cause!())
                } else {
                    checked
                }
            }
        };
        if let Err(cause) = checked {
            crate::quiet_eprintln!("native-records-read-refused stage=delivery cause={cause}");
            self.bytes.take(); // Wipe the refused chunk before reporting error.
            self.failed = true;
            return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))));
        }
        let bytes = self.bytes.take().expect("checked pending record chunk");
        Poll::Ready(Some(Ok(Frame::data(Bytes::from_owner(PermitChunk {
            bytes,
            _permit: self.context.permit.clone(),
        })))))
    }
    fn is_end_stream(&self) -> bool {
        self.failed || self.bytes.is_none()
    }
    fn size_hint(&self) -> SizeHint {
        let mut hint = SizeHint::default();
        if let Some(bytes) = &self.bytes {
            hint.set_exact(bytes.len() as u64);
        }
        hint
    }
}
impl LocalWorkspace {
    pub(super) fn read_records(
        &self,
        context: DomainContext,
        selection: Option<Selection>,
    ) -> SupplyFuture<DomainAnswer> {
        // The page's records read is admitted, read and delivered on the admission owner, which holds no writer: a
        // boot's thirty-odd writes queue at the account, and a read behind them past its two seconds was refused.
        let owner = self.sessions.admission();
        let sessions = self.sessions.clone();
        Box::pin(async move {
            // Fixed at this consumer entry, never renewed by body polling or
            // OwnerWait. All old reader limits remain; delivery is also bounded.
            let deadline = Instant::now() + Limits::default().elapsed;
            sessions.authorize(context.clone()).await.map_err(|error| refused("authorize", error))?;
            if context.permit.cancelled() {
                return Err(refused("lease", crate::cause!(WorkspaceError::Conflict)));
            }
            let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
            let retained = context.clone();
            let current = owner.clone();
            let prepared = crate::storage::request_work::spawn_blocking(move || {
                let stopped = || retained.permit.cancelled() || Instant::now() >= deadline;
                // The owner is held to admit the read and again to check the admission after it; the read between
                // holds none (a read-only handle of the account's file in one read transaction).
                let admission = owner_wait::acquire(current.as_ref(), stopped)
                    .map_err(|error| refused("admit-wait", crate::carry_cause!(WorkspaceError::Conflict, error)))?
                    .admit_workspace_store(&retained.session, &retained.permit, deadline)
                    .map_err(|failure| refused_kind("admit", failure))?;
                let snapshot = admission
                    .read(selection.as_ref(), retained.permit.cancellation_flag(), deadline)
                    .map_err(|failure| refused_kind("read", failure))?;
                let (snapshot, witness) = owner_wait::acquire(current.as_ref(), stopped)
                    .map_err(|error| refused("finish-wait", crate::carry_cause!(WorkspaceError::Conflict, error)))?
                    .finish_workspace_store(&retained.session, &retained.permit, admission, snapshot, deadline, Delivery::Snapshot)
                    .map_err(|failure| refused_kind("finish", failure))?;
                // The canonical serializer remains the sole byte owner. Its
                // parent buffer is zeroizing while errors can still refuse.
                let DomainAnswer::Http {
                    status,
                    headers,
                    body,
                } = super::answer(snapshot)?
                else {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                };
                Ok::<_, WorkspaceError>((status, headers, Zeroizing::new(body), witness))
            })
            .await
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
            if context.permit.cancelled() {
                return Err(refused("lease", crate::cause!(WorkspaceError::Conflict)));
            }
            // The old extra execute-tail authorization is replaced by the
            // mandatory fresh body check, after any wait/withdrawal/update.
            let (status, headers, bytes, witness) = prepared;
            let mut response = Response::new(Body::new(RecordsBody {
                bytes: Some(bytes),
                owner,
                context,
                witness,
                owner_wait: OwnerWait::new(),
                failed: false,
            }));
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            cancellation.0.take();
            Ok(DomainAnswer::Response(response))
        })
    }
}
