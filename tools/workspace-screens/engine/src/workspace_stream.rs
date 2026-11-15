// src/workspace_stream.rs
//
// Purpose: Stream a workspace document prefix, independently-ready first answers, and its original suffix.
//
// Non-Negotiable Invariants: Emit the document prefix before starting reads; share one fresh-session gate; run
// revision before current reads; give every read one batch-relative deadline; omit late or failed answers.
//
// Key Concepts: Lazy read factories, independently timed first answers, document-close deadline, retention tail.
//
// Security Considerations: The parent supplies authorized factories, permit, page bytes, and bounded escaping
// serializer. This module invents no account identity, shell, operation, response, or fallback behavior.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Typed body mechanics for the current workspace page's first-answer stream.
//!
//! The host owns page authorization, canonical read suppliers, the exact shared
//! shell, escaping, response headers, and any durable copy-refresh owner. This
//! module only schedules supplied bounded futures and interleaves their exact
//! [`FirstAnswer`] values between the supplied document prefix and suffix.

use crate::workspace::{
    FirstAnswer, SupplyFuture, WorkspaceAnswerEnvelope, WorkspaceError, WorkspacePermit,
};
use axum::body::Bytes;
use http_body::{Body, Frame, SizeHint};
use std::{
    collections::BTreeSet,
    future::{poll_fn, Future},
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{sleep_until, Instant, Sleep};

const MAX_READS: usize = 1024;
const MAX_PREFIX_SUFFIX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ANSWER_CHUNK_BYTES: usize = MAX_PREFIX_SUFFIX_BYTES;

/// Lazily create a shared current-session confirmation. The factory itself is
/// not called until after the first prefix chunk has been yielded.
pub type ConfirmationFactory = Box<dyn FnOnce() -> SupplyFuture<()> + Send + 'static>;

/// Lazily create one answer read. `None` and failures are omitted from the page.
/// The scheduler never turns a timeout into a synthetic pending/503 answer.
pub type ReadFactory =
    Box<dyn FnOnce() -> SupplyFuture<Option<WorkspaceAnswerEnvelope>> + Send + 'static>;

/// The existing host's actual retention owner may accept the unfinished bounded
/// tail after a normal document EOF and retain the same workspace permit while it
/// completes. The tail future holds a permit clone while it is polled; the owner
/// decides whether to spawn/poll it, and an abandoned tail is simply dropped.
pub type RetentionFuture = Pin<Box<dyn Future<Output = Vec<FirstAnswer>> + Send + 'static>>;
pub type RetentionOwner = Box<dyn FnOnce(WorkspacePermit, RetentionFuture) + Send + 'static>;

/// One answer. `copy` remains independent from the current answer at the
/// same path and is serialized by the host with its normal `data-page-copy` form.
pub struct ReadSpec {
    pub path: String,
    pub copy: bool,
    pub start: ReadFactory,
}

impl ReadSpec {
    pub fn new(path: impl Into<String>, copy: bool, start: ReadFactory) -> Self {
        Self {
            path: path.into(),
            copy,
            start,
        }
    }
}

/// All inputs for one page response. `revision` is itself serialized as an
/// ordinary answer; current reads remain lazy until that prerequisite settles.
pub struct WorkspaceReadBatch {
    pub confirm_session: ConfirmationFactory,
    pub revision: ReadSpec,
    pub current: Vec<ReadSpec>,
    pub copies: Vec<ReadSpec>,
    pub permit: WorkspacePermit,
    pub retention: Option<RetentionOwner>,
}

/// Independently injectable scheduler clocks and byte ceilings. Deadlines are
/// captured when [`WorkspaceStream::new`] constructs the batch, not when a
/// queued factory eventually runs.
#[derive(Clone, Copy, Debug)]
pub struct StreamLimits {
    pub read_timeout: Duration,
    pub document_timeout: Duration,
    pub response_bytes: usize,
    pub answer_chunk_bytes: usize,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            read_timeout: Duration::from_secs(15),
            document_timeout: Duration::from_millis(2500),
            response_bytes: MAX_PREFIX_SUFFIX_BYTES,
            answer_chunk_bytes: MAX_ANSWER_CHUNK_BYTES,
        }
    }
}

/// Parent-supplied bounded serializer for the exact first-answer tuple.
/// Implementations must escape script data and preserve the path/copy markers.
pub type AnswerSerializer =
    Arc<dyn Fn(&FirstAnswer) -> Result<Bytes, WorkspaceError> + Send + Sync + 'static>;

/// Private response extension for the outer workspace body wrapper. The parent
/// may use it to delegate cancellation to this body's drop/EOF state while
/// preserving ordinary-operation cancellation, including ordinary 101 replies.
#[derive(Clone, Copy, Debug)]
pub(crate) struct WorkspaceStreamMarker;

pub(crate) fn mark_response(response: &mut axum::response::Response) {
    response.extensions_mut().insert(WorkspaceStreamMarker);
}

pub(crate) fn has_marker(response: &axum::response::Response) -> bool {
    response
        .extensions()
        .get::<WorkspaceStreamMarker>()
        .is_some()
}

/// A bounded HTTP body that emits prefix first, ready answers as they settle,
/// then the supplied suffix at the separate document deadline.
pub struct WorkspaceStream {
    prefix: Option<Bytes>,
    suffix: Option<Bytes>,
    scheduler: Scheduler,
    serializer: AnswerSerializer,
    permit: WorkspacePermit,
    retention: Option<RetentionOwner>,
    document_deadline: Instant,
    document_timer: Option<Pin<Box<Sleep>>>,
    limits: StreamLimits,
    emitted_bytes: usize,
    retained_answer_bytes: usize,
    retained_answers: Vec<FirstAnswer>,
    started: bool,
    ended: bool,
    failed: bool,
    eof: bool,
}

impl WorkspaceStream {
    /// Validate explicit bounds and capture all per-read deadlines before any
    /// factory can run. The first `poll_frame` only returns the prefix.
    pub fn new(
        prefix: Bytes,
        suffix: Bytes,
        batch: WorkspaceReadBatch,
        serializer: AnswerSerializer,
        limits: StreamLimits,
    ) -> Result<Self, WorkspaceError> {
        if limits.read_timeout.is_zero()
            || limits.document_timeout.is_zero()
            || limits.read_timeout > Duration::from_secs(15)
            || limits.document_timeout > Duration::from_millis(2500)
            || limits.document_timeout > limits.read_timeout
            || limits.response_bytes == 0
            || limits.answer_chunk_bytes == 0
            || limits.answer_chunk_bytes > MAX_ANSWER_CHUNK_BYTES
            || limits.response_bytes > MAX_PREFIX_SUFFIX_BYTES
            || prefix
                .len()
                .checked_add(suffix.len())
                .is_none_or(|n| n > limits.response_bytes)
        {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let count = batch
            .current
            .len()
            .checked_add(batch.copies.len())
            .and_then(|n| n.checked_add(1))
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        if count > MAX_READS {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let mut identities = BTreeSet::new();
        for read in std::iter::once(&batch.revision)
            .chain(batch.current.iter())
            .chain(batch.copies.iter())
        {
            if read.path.len() > 8192 {
                return Err(crate::cause!(WorkspaceError::TooLarge));
            }
            if !read.path.starts_with("/work/api/")
                || read.path.chars().any(char::is_control)
                || !identities.insert((read.path.as_str(), read.copy))
            {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
        }
        if batch.revision.copy
            || batch.copies.iter().any(|read| !read.copy)
            || batch.current.iter().any(|read| read.copy)
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let now = Instant::now();
        let read_deadline = now + limits.read_timeout;
        let document_deadline = now + limits.document_timeout;
        let scheduler = Scheduler::new(
            batch.confirm_session,
            batch.revision,
            batch.current,
            batch.copies,
            read_deadline,
            batch.permit.clone(),
        );
        Ok(Self {
            prefix: Some(prefix),
            suffix: Some(suffix),
            scheduler,
            serializer,
            permit: batch.permit,
            retention: batch.retention,
            document_deadline,
            document_timer: None,
            limits,
            emitted_bytes: 0,
            retained_answer_bytes: 0,
            retained_answers: Vec::new(),
            started: false,
            ended: false,
            failed: false,
            eof: false,
        })
    }

    /// True only after the body has emitted the suffix and completed its normal
    /// EOF. The parent wrapper should let the body own premature-drop cancel.
    pub fn completed(&self) -> bool {
        self.eof
    }

    fn poll_document_deadline(&mut self, cx: &mut Context<'_>) -> Poll<()> {
        let timer = self
            .document_timer
            .get_or_insert_with(|| Box::pin(sleep_until(self.document_deadline)));
        timer.as_mut().poll(cx).map(|_| ())
    }

    fn emit_answer(&mut self, answer: &FirstAnswer) -> Result<Bytes, WorkspaceError> {
        let bytes = (self.serializer)(answer)?;
        if bytes.len() > self.limits.answer_chunk_bytes {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let total = self
            .emitted_bytes
            .checked_add(bytes.len())
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        if total
            .checked_add(self.suffix.as_ref().map_or(0, Bytes::len))
            .is_none_or(|n| n > self.limits.response_bytes)
        {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        self.emitted_bytes = total;
        Ok(bytes)
    }

    fn finish(&mut self) -> Result<Bytes, WorkspaceError> {
        let suffix = self.suffix.take().unwrap_or_default();
        let total = self
            .emitted_bytes
            .checked_add(suffix.len())
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        if total > self.limits.response_bytes {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        self.emitted_bytes = total;
        self.ended = true;
        Ok(suffix)
    }

    fn transfer_retention(&mut self) {
        let Some(owner) = self.retention.take() else {
            self.permit.cancel();
            return;
        };
        self.scheduler.discard_if_never_started();
        let scheduler =
            std::mem::replace(&mut self.scheduler, Scheduler::empty(self.permit.clone()));
        let permit = self.permit.clone();
        let tail_permit = permit.clone();
        let answers = std::mem::take(&mut self.retained_answers);
        let serializer = self.serializer.clone();
        let max_chunk = self.limits.answer_chunk_bytes;
        let max_answer_bytes = self.limits.response_bytes;
        let retained_answer_bytes = self.retained_answer_bytes;
        let abandoned = CancelAbandonedTail(Some(permit.clone()));
        let tail: RetentionFuture = Box::pin(async move {
            let mut abandoned = abandoned;
            let answers = scheduler
                .finish_tail(
                    tail_permit,
                    answers,
                    serializer,
                    max_chunk,
                    max_answer_bytes,
                    retained_answer_bytes,
                )
                .await;
            // The actual retention owner still holds the permit while applying
            // its current-rights/copy-write check after these reads completed.
            abandoned.0 = None;
            answers
        });
        owner(permit, tail);
    }
}

struct CancelAbandonedTail(Option<WorkspacePermit>);
impl Drop for CancelAbandonedTail {
    fn drop(&mut self) {
        if let Some(permit) = &self.0 {
            permit.cancel();
        }
    }
}

impl Drop for WorkspaceStream {
    fn drop(&mut self) {
        if !self.eof {
            self.permit.cancel();
        }
    }
}

impl Body for WorkspaceStream {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.ended {
            if !self.eof && !self.failed {
                self.transfer_retention();
                self.eof = true;
            }
            return Poll::Ready(None);
        }
        if !self.started {
            self.started = true;
            let prefix = self.prefix.take().unwrap_or_default();
            self.emitted_bytes = prefix.len();
            return Poll::Ready(Some(Ok(Frame::data(prefix))));
        }
        if self.poll_document_deadline(cx).is_ready() {
            return match self.finish() {
                Ok(suffix) => Poll::Ready(Some(Ok(Frame::data(suffix)))),
                Err(error) => {
                    self.permit.cancel();
                    self.ended = true;
                    self.failed = true;
                    Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::other("workspace stream byte bound"), error.cause()))))
                }
            };
        }
        match self.scheduler.poll_answer(cx) {
            Poll::Ready(Some(answer)) => match self.emit_answer(&answer) {
                Ok(bytes) => {
                    if self.retention.is_some() {
                        self.retained_answer_bytes =
                            self.retained_answer_bytes.saturating_add(bytes.len());
                        self.retained_answers.push(FirstAnswer {
                            path: answer.path.clone(),
                            envelope: answer.envelope.clone(),
                            copy: answer.copy,
                        });
                    }
                    Poll::Ready(Some(Ok(Frame::data(bytes))))
                }
                // A serialization failure belongs to this answer. It is omitted
                // just like a failed source read; it must not become fake HTML.
                Err(_) => {
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            },
            Poll::Ready(None) => match self.finish() {
                Ok(suffix) => Poll::Ready(Some(Ok(Frame::data(suffix)))),
                Err(error) => {
                    self.permit.cancel();
                    self.ended = true;
                    self.failed = true;
                    Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::other("workspace stream byte bound"), error.cause()))))
                }
            },
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.eof
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::new()
    }
}

struct Slot {
    path: String,
    copy: bool,
    deadline: Instant,
    factory: Option<ReadFactory>,
    future: Option<SupplyFuture<Option<WorkspaceAnswerEnvelope>>>,
    done: bool,
}

impl Slot {
    fn new(spec: ReadSpec, deadline: Instant) -> Self {
        Self {
            path: spec.path,
            copy: spec.copy,
            deadline,
            factory: Some(spec.start),
            future: None,
            done: false,
        }
    }
    fn start(&mut self, now: Instant) {
        if self.done || self.future.is_some() || now >= self.deadline {
            self.done = true;
            self.factory.take();
            return;
        }
        if let Some(factory) = self.factory.take() {
            self.future = Some(factory());
        }
    }
    fn poll(&mut self, cx: &mut Context<'_>, now: Instant) -> Poll<Option<FirstAnswer>> {
        if self.done {
            return Poll::Ready(None);
        }
        if now >= self.deadline {
            self.done = true;
            self.future.take();
            self.factory.take();
            return Poll::Ready(None);
        }
        let Some(future) = self.future.as_mut() else {
            return Poll::Pending;
        };
        match future.as_mut().poll(cx) {
            Poll::Ready(Ok(Some(envelope))) => {
                self.future.take();
                self.done = true;
                Poll::Ready(Some(FirstAnswer {
                    path: self.path.clone(),
                    envelope,
                    copy: self.copy,
                }))
            }
            Poll::Ready(Ok(None) | Err(_)) => {
                self.future.take();
                self.done = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

struct Scheduler {
    permit: WorkspacePermit,
    confirmation_deadline: Instant,
    confirmation_factory: Option<ConfirmationFactory>,
    confirmation: Option<SupplyFuture<()>>,
    confirmation_done: bool,
    revision: Slot,
    revision_done: bool,
    current: Vec<Slot>,
    copies: Vec<Slot>,
    current_started: bool,
    started: bool,
    deadline_timer: Option<Pin<Box<Sleep>>>,
    finished: bool,
}

impl Scheduler {
    fn new(
        confirm: ConfirmationFactory,
        revision: ReadSpec,
        current: Vec<ReadSpec>,
        copies: Vec<ReadSpec>,
        deadline: Instant,
        permit: WorkspacePermit,
    ) -> Self {
        let confirmation_deadline = deadline;
        Self {
            permit,
            confirmation_deadline,
            confirmation_factory: Some(confirm),
            confirmation: None,
            confirmation_done: false,
            revision: Slot::new(revision, deadline),
            revision_done: false,
            current: current
                .into_iter()
                .map(|spec| Slot::new(spec, deadline))
                .collect(),
            copies: copies
                .into_iter()
                .map(|spec| Slot::new(spec, deadline))
                .collect(),
            current_started: false,
            started: false,
            deadline_timer: None,
            finished: false,
        }
    }

    fn empty(permit: WorkspacePermit) -> Self {
        let deadline = Instant::now();
        Self::new(
            Box::new(|| Box::pin(async { Err(crate::cause!(WorkspaceError::Unavailable)) })),
            ReadSpec::new("", false, Box::new(|| Box::pin(async { Ok(None) }))),
            Vec::new(),
            Vec::new(),
            deadline,
            permit,
        )
    }

    fn discard_if_never_started(&mut self) {
        if self.started {
            return;
        }
        self.confirmation_factory.take();
        self.confirmation_done = true;
        self.revision.factory.take();
        self.revision.done = true;
        for slot in self.current.iter_mut().chain(self.copies.iter_mut()) {
            slot.factory.take();
            slot.done = true;
        }
        self.revision_done = true;
        self.finished = true;
    }

    fn start_after_prefix(&mut self) {
        if self.started {
            return;
        }
        self.started = true;
        for copy in &mut self.copies {
            copy.start(Instant::now());
        }
        if Instant::now() < self.confirmation_deadline {
            self.confirmation = self.confirmation_factory.take().map(|factory| factory());
        } else {
            self.confirmation_factory.take();
            self.confirmation_done = true;
            self.revision_done = true;
            self.revision.factory.take();
            self.revision.done = true;
            for slot in &mut self.current {
                slot.factory.take();
                slot.done = true;
            }
        }
    }

    fn poll_answer(&mut self, cx: &mut Context<'_>) -> Poll<Option<FirstAnswer>> {
        if self.finished {
            return Poll::Ready(None);
        }
        if self.permit.cancelled() {
            self.discard_if_never_started();
            self.finished = true;
            return Poll::Ready(None);
        }
        self.start_after_prefix();
        let now = Instant::now();

        if !self.confirmation_done {
            if now >= self.confirmation_deadline {
                self.confirmation.take();
                self.confirmation_factory.take();
                self.confirmation_done = true;
                self.revision_done = true;
                self.revision.factory.take();
                self.revision.future.take();
                self.revision.done = true;
                for slot in &mut self.current {
                    slot.factory.take();
                    slot.future.take();
                    slot.done = true;
                }
            } else if let Some(future) = self.confirmation.as_mut() {
                match future.as_mut().poll(cx) {
                    Poll::Ready(Ok(())) => {
                        self.confirmation.take();
                        self.confirmation_done = true;
                        self.revision.start(now);
                    }
                    Poll::Ready(Err(_)) => {
                        self.confirmation.take();
                        self.confirmation_done = true;
                        self.revision_done = true;
                        self.revision.factory.take();
                        self.revision.future.take();
                        self.revision.done = true;
                        for slot in &mut self.current {
                            slot.factory.take();
                            slot.future.take();
                            slot.done = true;
                        }
                    }
                    Poll::Pending => {}
                }
            }
        }

        if self.confirmation_done && !self.revision_done {
            match self.revision.poll(cx, now) {
                Poll::Ready(Some(answer)) => {
                    self.revision_done = true;
                    self.current_started = true;
                    return Poll::Ready(Some(answer));
                }
                Poll::Ready(None) => {
                    self.revision_done = true;
                    self.current_started = true;
                }
                Poll::Pending => {}
            }
        }

        if self.revision_done && self.current_started {
            for slot in &mut self.current {
                if slot.future.is_none() && !slot.done {
                    slot.start(now);
                }
            }
        }

        // Copies are separate from current reads and can settle independently.
        let mut ready_answer = None;
        for slot in self.copies.iter_mut().chain(self.current.iter_mut()) {
            match slot.poll(cx, now) {
                Poll::Ready(Some(answer)) => {
                    ready_answer = Some(answer);
                    break;
                }
                Poll::Ready(None) => {}
                Poll::Pending => {}
            }
        }
        if let Some(answer) = ready_answer {
            return Poll::Ready(Some(answer));
        }

        let reads_done = self.confirmation_done
            && self.revision_done
            && self.revision.done
            && self.current.iter().all(|slot| slot.done)
            && self.copies.iter().all(|slot| slot.done);
        if reads_done {
            self.finished = true;
            return Poll::Ready(None);
        }

        // Completed siblings do not remove the pending siblings' timer wake.
        {
            let next_deadline = self.next_deadline();
            if let Some(deadline) = next_deadline {
                let timer = self
                    .deadline_timer
                    .get_or_insert_with(|| Box::pin(sleep_until(deadline)));
                match timer.as_mut().poll(cx) {
                    Poll::Ready(()) => {
                        self.deadline_timer = None;
                        cx.waker().wake_by_ref();
                    }
                    Poll::Pending => {}
                }
            }
        }
        Poll::Pending
    }

    fn next_deadline(&self) -> Option<Instant> {
        let mut deadlines = Vec::new();
        if !self.confirmation_done {
            deadlines.push(self.confirmation_deadline);
        }
        if self.confirmation_done && !self.revision_done {
            deadlines.push(self.revision.deadline);
        }
        if self.revision_done {
            deadlines.extend(
                self.current
                    .iter()
                    .filter(|slot| !slot.done)
                    .map(|slot| slot.deadline),
            );
        }
        deadlines.extend(
            self.copies
                .iter()
                .filter(|slot| !slot.done)
                .map(|slot| slot.deadline),
        );
        deadlines.into_iter().min()
    }

    async fn finish_tail(
        mut self,
        _permit: WorkspacePermit,
        mut answers: Vec<FirstAnswer>,
        serializer: AnswerSerializer,
        max_chunk: usize,
        max_answer_bytes: usize,
        mut retained_bytes: usize,
    ) -> Vec<FirstAnswer> {
        poll_fn(|cx| match self.poll_answer(cx) {
            Poll::Ready(Some(answer)) => {
                if let Ok(bytes) = (serializer)(&answer) {
                    let total = retained_bytes.checked_add(bytes.len());
                    if bytes.len() <= max_chunk && total.is_some_and(|n| n <= max_answer_bytes) {
                        retained_bytes = total.unwrap_or(max_answer_bytes);
                        answers.push(answer);
                    }
                }
                cx.waker().wake_by_ref();
                Poll::Pending
            }
            Poll::Ready(None) => Poll::Ready(()),
            Poll::Pending => Poll::Pending,
        })
        .await;
        answers
    }
}
