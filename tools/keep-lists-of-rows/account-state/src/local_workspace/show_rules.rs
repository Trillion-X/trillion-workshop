//! The fatal-bootstrap `/work/api/show-rules` read over the retained selected
//! account. Native startup supplies the already-qualified ICU locale; this
//! child adds no route table, executor, source reader, or successful fallback.

use super::CancelReadOnDrop;
use crate::workspace_session::owner_wait::{self, OwnerWait};
use crate::{
    local_account::ShowRulesDeliveryWitness,
    native_boot::SelectedAccount,
    tool_label_locale::QualifiedLocale,
    workspace::{SupplyFuture, WorkspaceError, WorkspacePermit},
    workspace_domain::{DomainAnswer, DomainContext},
    workspace_session::WorkspaceSessions,
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

pub(super) const OPERATION: &str = "show-rules:request";

/// The single original request envelope admitted by the canonical native
/// route. The route layer normalizes this to `/show-rules` before dispatch.
pub(super) fn request(input: &serde_json::Value) -> Result<(), WorkspaceError> {
    if input.as_object().is_some_and(|object| {
        object.len() == 3
            && object.get("path").and_then(serde_json::Value::as_str) == Some("/show-rules")
            && object.get("method").and_then(serde_json::Value::as_str) == Some("GET")
            && object.get("body").is_some_and(serde_json::Value::is_object)
            && object["body"]
                .as_object()
                .is_some_and(|body| body.is_empty())
    }) {
        Ok(())
    } else {
        Err(crate::cause!(WorkspaceError::Invalid))
    }
}

pub(super) struct Mount {
    /// QualifiedLocale is the existing ICU owner selected at native startup.
    pub(super) locale: Arc<QualifiedLocale>,
}

/// The chunk retains the request permit until the consumer drops its bytes.
struct PermitChunk {
    bytes: Zeroizing<Vec<u8>>,
    _permit: WorkspacePermit,
}
impl AsRef<[u8]> for PermitChunk {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

struct ShowRulesBody {
    bytes: Option<Zeroizing<Vec<u8>>>,
    owner: Arc<Mutex<SelectedAccount>>,
    context: DomainContext,
    witness: ShowRulesDeliveryWitness,
    failed: bool,
    owner_wait: OwnerWait,
}
impl HttpBody for ShowRulesBody {
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
                    .assert_show_rules_delivery_current(
                        &self.context.session.session_id,
                        self.context.permit.cancellation_flag(),
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
            self.bytes.take();
            self.failed = true;
            return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))));
        }
        let bytes = self.bytes.take().expect("checked pending show-rules chunk");
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

/// The executor parent dispatches this only after canonical admission and
/// supplies its existing account/session owners and mounted locale.
pub(super) fn read_show_rules(
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    context: DomainContext,
    mount: Arc<Mount>,
) -> SupplyFuture<DomainAnswer> {
    let locale = mount.locale.clone();
    Box::pin(async move {
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
        let retained = context.clone();
        let current = owner.clone();
        let qualified = crate::storage::request_work::spawn_blocking(move || {
            let mut selected = owner_wait::acquire(current.as_ref(), || retained.permit.cancelled())
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            selected
                .current_show_rules(
                    &retained.session.session_id,
                    locale.as_ref(),
                    retained.permit.cancellation_flag(),
                )
                .map_err(super::account_error)
        })
        .await
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let bytes = qualified.1.encoded_body(&qualified.0).map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
        let mut response = Response::new(Body::new(ShowRulesBody {
            bytes: Some(bytes),
            owner,
            context,
            witness: qualified.1,
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
