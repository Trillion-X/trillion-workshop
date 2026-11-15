//! Actual HTTP /screen-revision consumer over the existing selected account.
//! The private bounded chunk stays zeroizing until body poll rechecks the SAME
//! selection, physical resource incarnation, typed session, permit and deadline.
//! This is a child of LocalWorkspace, not a second route table or executor.

use super::{CancelReadOnDrop, LocalWorkspace};
use crate::workspace_session::owner_wait::{self, OwnerWait};
use crate::{
    local_account::DeliveryWitness,
    native_boot::SelectedAccount,
    workspace::{SupplyFuture, WorkspaceError, WorkspacePermit},
    workspace_domain::{DomainAnswer, DomainContext},
    workspace_heads::Error,
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderValue, StatusCode},
    response::Response,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use zeroize::Zeroizing;

fn failure(error: Error) -> WorkspaceError {
    let cause = error.cause();
    match error {
        Error::Invalid(_) => WorkspaceError::Invalid(cause),
        Error::Bounds(_) => WorkspaceError::TooLarge(cause),
        Error::NotAuthorized(_) => WorkspaceError::Unauthorized(cause),
        Error::SourceChanged(_) | Error::Unresolved(_) => WorkspaceError::Conflict(cause),
        Error::Unavailable(_) | Error::Sql(_, _) => WorkspaceError::Unavailable(cause),
    }
}

/// Keep the actual request permit through the framework's last chunk reference,
/// including socket buffering. The owner wipes the chunk storage when dropped.
pub(super) struct PermitChunk {
    pub(super) bytes: Zeroizing<Vec<u8>>,
    pub(super) _permit: WorkspacePermit,
}
impl AsRef<[u8]> for PermitChunk {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

struct HeadsBody {
    bytes: Option<Zeroizing<Vec<u8>>>,
    owner: Arc<Mutex<SelectedAccount>>,
    context: DomainContext,
    witness: DeliveryWitness,
    failed: bool,
    owner_wait: OwnerWait,
}
impl HttpBody for HeadsBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.failed || self.bytes.is_none() {
            return Poll::Ready(None);
        }
        // Retain the same prepared chunk while another admitted read owns
        // the selected account. OwnerWait arranges a wake without blocking this
        // executor thread; current rights/source/deadline are checked AFTER it.
        let selected = self.owner.clone();
        let cancelled = self.context.permit.cancelled();
        let checked = match self.owner_wait.poll(selected.as_ref(), cancelled, cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(error)) => Err(error.cause()),
            Poll::Ready(Ok(mut owner)) => {
                let current = owner
                    .workspace_heads_delivery_current(
                        &self.context.session,
                        &self.context.permit,
                        &self.witness,
                    )
                    .map_err(|error| error.cause());
                if self.context.permit.cancelled() {
                    Err(crate::cause!())
                } else {
                    current
                }
            }
        };
        if let Err(cause) = checked {
            self.bytes.take(); // Drop/wipe unsent bytes before reporting failure.
            self.failed = true;
            return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))));
        }
        let bytes = self.bytes.take().expect("checked pending heads chunk");
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
    pub(super) fn read_heads(&self, context: DomainContext) -> SupplyFuture<DomainAnswer> {
        let owner = self.owner.clone();
        let sessions = self.sessions.clone();
        Box::pin(async move {
            sessions.authorize(context.clone()).await?;
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
            let retained = context.clone();
            let current = owner.clone();
            let prepared: crate::native_boot::PreparedHeads =
                crate::storage::request_work::spawn_blocking(move || {
                    let mut selected =
                        owner_wait::acquire(current.as_ref(), || retained.permit.cancelled())
                            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
                    selected
                        .prepare_workspace_heads(&retained.session, retained.permit.clone())
                        .map_err(failure)
                })
                .await
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
            sessions.authorize(context.clone()).await?;
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            let mut response = Response::new(Body::new(HeadsBody {
                bytes: Some(prepared.bytes),
                owner,
                context,
                witness: prepared.witness,
                failed: false,
                owner_wait: OwnerWait::new(),
            }));
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            cancellation.0.take();
            Ok(DomainAnswer::Response(response))
        })
    }
}
