//! The forwarder's own disclosure check, after the resource has released its
//! result to this forwarder. The original authenticated principal and actual
//! routed generation remain attached to the HTTP response. As old trillion's
//! public route did (its src/public-resource-route.mjs at
//! 665bd69b25: authorize once :105, read the route once :117-123, refuse an
//! answer whose generation changed :155), the client and the registration were
//! read before the chunk left; release asks no one again. It withholds the
//! response when the route that answered is gone or replaced, or the request
//! was cancelled or ran out of time, and never repeats the resource operation.
use super::super::{invoke_with_admission, RouteDirectory, DEADLINE_WINDOW_MS};
use super::*;
use crate::mcp::{FinalBodyCustody, RequestDisclosure, MAX_MESSAGE_BYTES};
use crate::resource_authority::Route;
use axum::body::{Body, Bytes};
use http_body::{Body as HttpBody, Frame as Chunk, SizeHint};
use std::{
    io,
    pin::Pin,
    sync::atomic::AtomicBool,
    task::{Context, Poll},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

struct BodyPermit {
    principal: Principal,
    route: Route,
    connected_computers: Arc<ConnectedComputers>,
    cancel: Arc<AtomicBool>,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    issued_at_ms: i64,
    deadline_at_ms: i64,
    deadline: Instant,
}
impl BodyPermit {
    fn stopped(&self) -> bool {
        let now = self.now_ms.now_ms();
        self.cancel.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
            || now < self.issued_at_ms
            || now >= self.deadline_at_ms
    }
    /// The route that answered is still the live one (equal account/address alone cannot borrow a replacement
    /// generation), read from local list of connected computers only.
    fn current(&self) -> bool {
        !self.stopped()
            && self.connected_computers
                .current_route(&self.route.account_id, &self.route.resource_address)
                .as_ref()
                == Some(&self.route)
            && !self.stopped()
    }
}

impl Gateway {
    pub(super) fn invoke_guarded(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: Operation,
        disclosure: &RequestDisclosure,
    ) -> Result<Value, OperationFailure> {
        let mut routed = None;
        let value = invoke_with_admission(
            self.connected_computers.as_ref(),
            self.connected_computers.as_ref(),
            self.now_ms.clone(),
            principal,
            call,
            |route, chunk| {
                routed = Some((route.clone(), chunk.deadline_at_ms));
                Ok(self.issuer.issue_with_bearer(principal, bearer, chunk))
            },
        )?;
        let unknown = |cause: crate::refusal_cause::Cause| OperationFailure { cause: cause.into(),
            code: "resource_outcome_unknown".into(),
            outcome_unknown: true,
            detail: None,
        };
        let (route, deadline_at_ms) = routed.ok_or_else(|| unknown(crate::cause!()))?;
        // The computer whose session answered, named on the HTTP answer (`answered_by_header`) as `forward_http` names
        // it for a request carried under `/a/<address>`: before, an answer at the forwarder's own /mcp named none.
        disclosure.answer_header(&computers::settings().answered_by_header, &route.device_id);
        let deadline = disclosure
            .started_at()
            .checked_add(Duration::from_millis(DEADLINE_WINDOW_MS as u64))
            .ok_or_else(|| unknown(crate::cause!()))?;
        let permit = BodyPermit {
            principal: principal.clone(),
            route,
            connected_computers: self.connected_computers.clone(),
            cancel: disclosure.cancellation_flag(),
            now_ms: self.now_ms.clone(),
            issued_at_ms: deadline_at_ms
                .checked_sub(DEADLINE_WINDOW_MS)
                .ok_or_else(|| unknown(crate::cause!()))?,
            deadline_at_ms,
            deadline,
        };
        disclosure
            .register(Box::new(Custody { permit }))
            .map_err(|error| unknown(error.cause()))?;
        Ok(value)
    }
}

struct Custody {
    permit: BodyPermit,
}
impl FinalBodyCustody for Custody {
    fn finish(
        self: Box<Self>,
        inner: Body,
        principal: &Principal,
        _bearer: Zeroizing<Vec<u8>>,
        ingress: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        if principal != &self.permit.principal {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        Ok(Body::new(Guarded {
            permit: Some(self.permit),
            inner,
            ready: None,
            ingress,
        }))
    }
}
struct Guarded {
    permit: Option<BodyPermit>,
    inner: Body,
    ready: Option<Bytes>,
    ingress: Arc<dyn Send + Sync>,
}
struct Kept {
    bytes: Bytes,
    _permit: BodyPermit,
    _ingress: Arc<dyn Send + Sync>,
}
impl AsRef<[u8]> for Kept {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl HttpBody for Guarded {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Chunk<Bytes>, io::Error>>> {
        let Some(permit) = self.permit.as_ref() else {
            return Poll::Ready(None);
        };
        let fail = |this: &mut Self, cause: crate::refusal_cause::Cause| {
            this.permit.take();
            this.ready.take();
            this.inner = Body::empty();
            Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))))
        };
        if permit.stopped() {
            return fail(&mut self, crate::cause!());
        }
        if self.ready.is_none() {
            self.ready = match Pin::new(&mut self.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(chunk))) => match chunk.into_data() {
                    Ok(bytes) if bytes.len() <= MAX_MESSAGE_BYTES => Some(bytes),
                    Ok(_) => return fail(&mut self, crate::cause!()),
                    Err(_) => return fail(&mut self, crate::cause!()),
                },
                Poll::Ready(Some(Err(error))) => return fail(&mut self, crate::refusal_cause::Caused::cause(&error)),
                Poll::Ready(None) => return fail(&mut self, crate::cause!()),
            };
        }
        // Read the inner EOF before the route check, so the check sits beside
        // release and Pending polls never consume a ready chunk. Trailers or a
        // second chunk fail closed.
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(None) => {}
            Poll::Ready(Some(Err(error))) => return fail(&mut self, crate::refusal_cause::Caused::cause(&error)),
            Poll::Ready(Some(Ok(_))) => return fail(&mut self, crate::cause!()),
        }
        if !self
            .permit
            .as_ref()
            .expect("retained route")
            .current()
        {
            return fail(&mut self, crate::cause!());
        }
        let permit = self.permit.take().expect("confirmed route");
        let bytes = self.ready.take().expect("bounded chunk");
        Poll::Ready(Some(Ok(Chunk::data(Bytes::from_owner(Kept {
            bytes,
            _permit: permit,
            _ingress: self.ingress.clone(),
        })))))
    }
    fn is_end_stream(&self) -> bool {
        self.permit.is_none()
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

#[cfg(test)]
mod tests;
