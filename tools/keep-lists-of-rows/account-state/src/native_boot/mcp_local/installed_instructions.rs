//! The caller's installed instructions, read for a caller the door's own
//! sign-in admits (any current sign-in of the account may read them), and the
//! last-chunk custody of every door read: the admission and the account's own
//! records file are checked again before a chunk leaves. The same renderer
//! serves the connection; no instruction words or account copies live here.
use super::*;
use crate::{
    mcp::{instructions, FinalBodyCustody, RequestDisclosure},
    native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead,
    tool_runs::tools::Place,
    workspace_session::owner_wait::OwnerWait,
};
use axum::body::{Body, Bytes};
use http_body::{Body as HttpBody, Frame as Chunk, SizeHint};
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use zeroize::Zeroizing;

struct Prepared {
    caller: Caller,
    read: AdmittedRecordsRead,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    deadline: Instant,
}
impl Prepared {
    fn locally_stopped(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= self.deadline
    }
    fn stopped(&self) -> bool {
        self.locally_stopped() || !self.caller.stands()
    }
}

/// The time an answer that is ready has to leave: the records bound counted from `ready`, the moment its owner
/// finished, and no later than the caller's own deadline. Counted from the start of the request it would be spent by
/// any tool run that lasts as long as the bound, and the finished answer would be refused after its work was done.
pub(super) fn answer_deadline(ready: Instant, deadline_override: Option<Instant>) -> Instant {
    let limit = ready + crate::legacy_records::Bounds::default().elapsed;
    deadline_override.map_or(limit, |deadline| deadline.min(limit))
}

impl LocalSelectedMcp {
    /// Hold the account's own-records source check for a projection whose own operation does not read records
    /// (Workshop, computer grants, account files), so the answer leaves only while the same file and caller stand.
    pub(super) fn admit_private_projection(
        &self,
        caller: &Caller,
        disclosure: &RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<AdmittedRecordsRead, OperationFailure> {
        self.personal_on(
            &self.admission,
            disclosure,
            crate::legacy_records::Bounds::default().elapsed,
            deadline_override,
            |selected, cancel, deadline| {
                selected.admit_door_instruction_read(caller, cancel, deadline)
            },
        )
    }

    pub(super) fn register_private_projection_custody(
        &self,
        caller: &Caller,
        call: &Operation,
        admitted: AdmittedRecordsRead,
        disclosure: &RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<(), OperationFailure> {
        self.register_personal_read_custody(
            caller,
            call,
            admitted,
            disclosure,
            answer_deadline(Instant::now(), deadline_override),
            &self.admission,
        )
    }

    /// None belongs to another operation owner. A recognized instruction read is admitted for any current sign-in of
    /// this account and confirmed exactly as a records read.
    pub(super) fn instructions_at(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: &Operation,
        disclosure: &RequestDisclosure,
        parent_current: account_routes::Current,
        deadline_override: Option<Instant>,
    ) -> Option<Result<serde_json::Value, OperationFailure>> {
        let limit = disclosure.started_at() + crate::workspace_store::Limits::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let stopped =
            || cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline;
        // The account and its state folder only, read on the admission owner: every call passes here before its
        // own door, so a call that is not an instruction read never waits on the account's writer.
        let (account, state_root) = match owner_wait::acquire(&self.admission, stopped) {
            Ok(selected) => selected.tool_place(),
            Err(_) => return Some(Err(refusal("selected_owner_unavailable", false))),
        };
        let workshop = match crate::tool_runs::tools::shipped() {
            Ok(workshop) => workshop,
            Err(_) => return None,
        };
        let place = Place {
            account: &account,
            state_root: &state_root,
            door: None,
            origin: None,
        };
        // Only the declared instruction list is read here (`instructions::DECLARED_LIST`).
        let file = |folder: &str, file: &str| {
            ((folder, file) == instructions::DECLARED_LIST)
                .then(|| workshop.instruction_file(&place))
                .flatten()
        };
        if !instructions::answers(call, &file) {
            return None;
        }
        if call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
            return Some(Err(refusal("original_input_refused", false)));
        }
        Some((|| {
            let caller = self
                .sign_in
                .signed_in(bearer, principal)
                .map_err(account_routes::Refusal::failure)?
                .also(parent_current);
            let read = self.personal_on(
                &self.admission,
                disclosure,
                crate::workspace_store::Limits::default().elapsed,
                deadline_override,
                |selected, cancel, deadline| {
                    selected.admit_door_instruction_read(&caller, cancel, deadline)
                },
            )?;
            let answer = instructions::projection(call, &file, &|operation| {
                read.read(&operation, true).map_err(personal_refusal)
            })
            .unwrap_or_else(|| Err(refusal("original_input_refused", false)))?;
            self.personal_on(
                &self.admission,
                disclosure,
                crate::workspace_store::Limits::default().elapsed,
                deadline_override,
                |selected, _, _| selected.confirm_door_records_read(&read),
            )?;
            self.register_personal_read_custody(
                &caller,
                call,
                read,
                disclosure,
                deadline,
                &self.admission,
            )?;
            Ok(answer)
        })())
    }

    /// One last-chunk guard for every door read and its instruction projection: the chunk leaves only while the
    /// caller's admission stands and the account's own records file is the one the read was admitted on.
    /// `confirmed_on` is the owner the read was admitted and confirmed on, so its last confirmation waits on nothing
    /// else: records, instructions and private projections all use the same account's admission owner.
    pub(super) fn register_personal_read_custody(
        &self,
        caller: &Caller,
        _call: &Operation,
        read: AdmittedRecordsRead,
        disclosure: &RequestDisclosure,
        deadline: Instant,
        confirmed_on: &Arc<Mutex<SelectedAccount>>,
    ) -> Result<(), OperationFailure> {
        disclosure
            .register(Box::new(Custody {
                owner: confirmed_on.clone(),
                prepared: Prepared {
                    caller: caller.clone(),
                    read,
                    cancel: disclosure.cancellation_flag(),
                    deadline,
                },
            }))
            .map_err(|error| OperationFailure { cause: error.cause(), ..refusal("original_read_output_unavailable", false) })
    }
}

struct Custody {
    owner: Arc<Mutex<SelectedAccount>>,
    prepared: Prepared,
}
impl FinalBodyCustody for Custody {
    fn finish(
        self: Box<Self>,
        inner: Body,
        principal: &Principal,
        bearer: Zeroizing<Vec<u8>>,
        ingress: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        if principal != &self.prepared.caller.principal {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        drop(bearer);
        Ok(Body::new(Guarded {
            owner: self.owner,
            prepared: Some(self.prepared),
            inner,
            ready: None,
            wait: OwnerWait::new(),
            ingress,
        }))
    }
}
struct Guarded {
    owner: Arc<Mutex<SelectedAccount>>,
    prepared: Option<Prepared>,
    inner: Body,
    ready: Option<Bytes>,
    wait: OwnerWait,
    ingress: Arc<dyn Send + Sync>,
}
struct Kept {
    bytes: Bytes,
    _prepared: Prepared,
    _owner: Arc<Mutex<SelectedAccount>>,
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
        let Some(prepared) = self.prepared.as_ref() else {
            return Poll::Ready(None);
        };
        let fail = |this: &mut Self, cause: crate::refusal_cause::Cause| {
            this.prepared.take();
            this.ready.take();
            this.inner = Body::empty();
            Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))))
        };
        if prepared.stopped() {
            return fail(&mut self, crate::cause!());
        }
        if self.ready.is_none() {
            self.ready = match Pin::new(&mut self.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(chunk))) => match chunk.into_data() {
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
            Poll::Ready(None) => {}
            Poll::Ready(Some(Err(error))) => return fail(&mut self, crate::refusal_cause::Caused::cause(&error)),
            Poll::Ready(Some(Ok(_))) => return fail(&mut self, crate::cause!()),
        }
        let selected = self.owner.clone();
        let mut owner = match self.wait.poll(selected.as_ref(), false, cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Ok(owner)) => owner,
            Poll::Ready(Err(error)) => return fail(&mut self, error.cause()),
        };
        let prepared = self.prepared.as_ref().expect("held instruction read");
        if let Err(error) = owner.confirm_door_records_read(&prepared.read) {
            return fail(&mut self, error.cause());
        }
        // The physical field-key check above is last: only memory checks follow it.
        if prepared.locally_stopped() { return fail(&mut self, crate::cause!()); }
        let prepared = self.prepared.take().expect("confirmed instruction read");
        let bytes = self.ready.take().expect("bounded chunk");
        Poll::Ready(Some(Ok(Chunk::data(Bytes::from_owner(Kept {
            bytes,
            _prepared: prepared,
            _owner: self.owner.clone(),
            _ingress: self.ingress.clone(),
        })))))
    }
    fn is_end_stream(&self) -> bool {
        self.prepared.is_none()
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A request that began `ran_for` before its answer was ready: the run's own length.
    fn request_started(ready: Instant, ran_for: Duration) -> Instant {
        ready - ran_for
    }

    #[test]
    fn an_answer_ready_after_the_records_bound_has_passed_since_the_request_began_still_leaves() {
        let bound = crate::legacy_records::Bounds::default().elapsed;
        let ready = Instant::now();
        let started = request_started(ready, bound + Duration::from_secs(3));
        // Counted from the request's start, the answer's time was spent before it was ready (the refusal this fixes).
        assert!(started + bound < ready);
        assert!(answer_deadline(ready, None) > ready, "the answer still has its time");
    }

    #[test]
    fn a_caller_past_its_own_deadline_still_stops_the_answer() {
        let ready = Instant::now();
        let past = ready - Duration::from_millis(1);
        assert!(answer_deadline(ready, Some(past)) <= ready, "the caller's deadline caps the answer");
        let earlier = ready + Duration::from_millis(40);
        assert_eq!(answer_deadline(ready, Some(earlier)), earlier);
        let later = ready + Duration::from_secs(600);
        assert_eq!(answer_deadline(ready, Some(later)), ready + crate::legacy_records::Bounds::default().elapsed);
    }
}
