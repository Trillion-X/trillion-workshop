//! The account routes' reads of the account's own records and their last-chunk custody,
//! allowed by the account routes' own sign-in (`account::account_routes::Caller`), checked again at
//! every check and before every chunk leaves. Reuses the canonical projection
//! reader, selection parser and HTTP serializer. No browser session/cookie,
//! alternate store, RPC server or renderer is created.
#[cfg(test)]
use crate::mcp::MAX_MESSAGE_BYTES;
use crate::{
    account::{account_routes::Caller, AccountError, AccountResult, NativeAccountOwner},
    local_account::{record_delivery::personal::PersonalProjectionWitness, LocalAccount},
    mcp::{FinalBodyCustody, Operation, OperationFailure, Principal, RequestDisclosure},
    native_boot::SelectedAccount,
    workspace_domain::DomainAnswer,
    workspace_session::owner_wait::OwnerWait,
    workspace_store::{self, Failure, Kind, Limits},
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::Instant,
};
use zeroize::Zeroizing;

/// One account-routes call on the person's wakes, read before the account is held: the call (a switch names its wake;
/// the causes read names at most the page it continues after) and the wakes the tool rows declare now. Reading every
/// tool row takes far longer than the book's own record operations, so none of it runs while the account is held.
pub(crate) struct PreparedWakeCall<'a> {
    asked: Option<crate::account_rights::run_cause::Switch<'a>>,
    after: Option<&'a str>,
    waker: &'static crate::wake::Waker,
    declared: Vec<crate::wake::Declared>,
    account: String,
    state_root: std::path::PathBuf,
}

impl PreparedWakeCall<'_> {
    /// The one wake-call implementation for any party that admitted it: the causes read, or the switch of one wake,
    /// written by the party whose cause name is `by` (`run_cause::switch`), which that wake's runs act as.
    /// Nothing else is kept: no key, no grant.
    pub(crate) fn answer(
        &self,
        owner: &mut LocalAccount,
        by: &str,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
    ) -> AccountResult<serde_json::Value> {
        use crate::account_rights::run_cause::{self, SwitchFailure, Wakes};
        current(owner)?;
        let mut held = owner
            .take_own_records()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let answer = (|| {
            let (store, book_account) = held.store_mut();
            let book_account = book_account.to_owned();
            let (declared, refused) = self
                .waker
                .with_person(
                    &book_account,
                    store,
                    self.declared.clone(),
                    &mut crate::wake::PersonKept::default(),
                )
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let Some(asked) = self.asked else {
                return self
                    .waker
                    .causes(
                        &book_account,
                        store,
                        &crate::storage::record_store::RealClock,
                        &declared,
                        &refused,
                        self.after,
                        &crate::mcp::tool_answer_fits,
                    )
                    .map_err(|failure| {
                        let cause = failure.cause();
                        match failure {
                            crate::wake::Failure::Data(_) if self.after.is_some() => AccountError::InvalidInput(cause),
                            _ => AccountError::SourceUnavailable(cause),
                        }
                    });
            };
            let wakes = Wakes {
                waker: self.waker,
                account: &book_account,
                declared: &declared,
            };
            // Check again immediately before changing the wake switch.
            current(owner)?;
            run_cause::switch(&wakes, store, asked, by).map_err(|failure| match failure {
                SwitchFailure::Input(_) => crate::cause!(AccountError::InvalidInput),
                SwitchFailure::Unavailable(_) => crate::cause!(AccountError::SourceUnavailable),
            })?;
            Ok(serde_json::json!({"tool": asked.tool, "id": asked.id, "on": asked.on}))
        })();
        owner.put_own_records(held);
        let answer = answer?;
        current(owner)?;
        Ok(answer)
    }
}

/// Prepare one wake call of the account's routes (`Door::answers_wake`) for the account `account` whose state folder
/// is `state_root`, without holding the account.
pub(crate) fn prepare_wake_call<'a>(
    operation: &'a Operation,
    account: String,
    state_root: std::path::PathBuf,
) -> AccountResult<PreparedWakeCall<'a>> {
    use crate::account_rights::run_cause::Switch;
    let door = crate::record_value::account_routes::Door::shipped()
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let workshop =
        crate::tool_runs::tools::shipped().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    if !door.answers_wake(&operation.resource, &operation.operation)
        || operation.request_key.is_empty()
        || operation.request_key.encode_utf16().count() > 512
    {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let (asked, after) = if operation.operation == door.wake_switch_operation() {
        (
            Some(Switch::asked(&operation.input).ok_or(crate::cause!(AccountError::InvalidInput))?),
            None,
        )
    } else {
        // The causes read: `{}` for its first page, `{after}` (a page's `next`) for the page after it.
        let input = operation
            .input
            .as_object()
            .ok_or(crate::cause!(AccountError::InvalidInput))?;
        if input.keys().any(|field| field != "after") {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        match input.get("after") {
            None => (None, None),
            Some(after) => (
                None,
                Some(
                    after
                        .as_str()
                        .filter(|after| !after.is_empty())
                        .ok_or(crate::cause!(AccountError::InvalidInput))?,
                ),
            ),
        }
    };
    let waker = shipped_waker()?;
    let place = crate::tool_runs::tools::Place {
        account: &account,
        state_root: &state_root,
        door: None,
        origin: None,
    };
    let rows = crate::wake::tool_runner::wake_rows(workshop, &place)
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let declared = waker
        .declared(&rows)
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    Ok(PreparedWakeCall {
        asked,
        after,
        waker,
        declared,
        account,
        state_root,
    })
}

/// The shipped wake owner, read once per process.
fn shipped_waker() -> AccountResult<&'static crate::wake::Waker> {
    static SHIPPED: std::sync::OnceLock<Option<crate::wake::Waker>> = std::sync::OnceLock::new();
    SHIPPED
        .get_or_init(|| crate::wake::Waker::shipped().ok())
        .as_ref()
        .ok_or(crate::cause!(AccountError::SourceUnavailable))
}

fn failure(kind: Kind) -> Failure {
    Failure::new(kind, Default::default())
}

/// Internal prepared reply, never an unguarded browser Response or detached
/// public Vec. The only transport conversion retains its physical witness and
/// freshly checks the same original personal key at the actual chunk release.
pub(crate) struct PreparedPersonalRead {
    caller: Caller,
    body: Zeroizing<Vec<u8>>,
    status: StatusCode,
    headers: HeaderMap,
    request_key: String,
    witness: PersonalProjectionWitness,
    cancel: Arc<AtomicBool>,
}
impl SelectedAccount {
    /// Admit one workspace read for `caller`: validate the call, check the caller's access and the selected source
    /// and take the read's check, under the account. The read itself (`AdmittedWorkspaceRead::read`) holds no account
    /// owner; `finish_door_record_selection` admits again.
    ///
    /// A `request_key` makes the read a tool's: one page that fits one MCP answer; without one it is the whole read.
    pub(crate) fn admit_door_record_selection(
        &mut self,
        caller: &Caller,
        input: &serde_json::Value,
        request_key: Option<&str>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<AdmittedWorkspaceRead, Failure> {
        let operation = Operation {
            person_present: None,
            resource: "@own-records".into(),
            operation: "workspace:read".into(),
            request_key: request_key.unwrap_or_default().to_owned(),
            input: input.clone(),
        };
        let paged = request_key.is_some();
        if cancel.load(Ordering::Acquire) || !caller.stands() || Instant::now() >= deadline {
            return Err(failure(crate::cause!(Kind::Cancelled)));
        }
        let projection =
            crate::local_workspace::selection(input).map_err(|error| failure(crate::carry_cause!(Kind::Invalid, error)))?;
        // A tool's read is one page that fits one MCP answer; the page after it names this page's `next`.
        let page = paged
            .then(|| crate::local_workspace::tool_page(input))
            .transpose()
            .map_err(|error| failure(crate::carry_cause!(Kind::Invalid, error)))?;
        let after_byte =
            crate::local_workspace::tool_after_byte(input).map_err(|error| failure(crate::carry_cause!(Kind::Invalid, error)))?;
        if self.owner.account().owner_id != caller.principal.account_id {
            return Err(failure(crate::cause!(Kind::SourceChanged)));
        }
        self.assert_source_current()
            .map_err(|error| failure(crate::carry_cause!(Kind::SourceChanged, error)))?;
        let deadline = deadline.min(Instant::now() + Limits::default().elapsed);
        let selection = &self.selection;
        let mut current = |_: &mut LocalAccount| -> AccountResult<()> {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
        };
        let admission =
            self.owner
                .admit_personal_record_projection(&mut current, &cancel, deadline)?;
        current(&mut self.owner).map_err(|error| failure(crate::carry_cause!(Kind::SourceChanged, error)))?;
        if !caller.stands() {
            return Err(failure(crate::cause!(Kind::SourceChanged)));
        }
        Ok(AdmittedWorkspaceRead {
            admission,
            projection,
            page,
            after_byte,
            request_key: request_key.map(str::to_owned),
            paged,
            operation,
            caller: caller.clone(),
            cancel,
            deadline,
        })
    }
    /// The check that allowed `admitted` still stands after the read of `snapshot` (the caller and the selected source
    /// checked again, the record book unchanged), and the prepared answer.
    pub(crate) fn finish_door_record_selection(
        &mut self,
        admitted: AdmittedWorkspaceRead,
        snapshot: workspace_store::Snapshot,
    ) -> Result<PreparedPersonalRead, Failure> {
        let AdmittedWorkspaceRead {
            admission,
            after_byte,
            request_key,
            paged,
            caller,
            cancel,
            deadline,
            ..
        } = admitted;
        if !caller.stands() {
            return Err(failure(crate::cause!(Kind::SourceChanged)));
        }
        let selection = &self.selection;
        let mut current = |_: &mut LocalAccount| -> AccountResult<()> {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
        };
        let (snapshot, witness) = self.owner.finish_personal_record_projection(
            &mut current,
            admission,
            snapshot,
            cancel.clone(),
            deadline,
        )?;
        current(&mut self.owner).map_err(|error| failure(crate::carry_cause!(Kind::SourceChanged, error)))?;
        if !caller.stands() {
            return Err(failure(crate::cause!(Kind::SourceChanged)));
        }
        let DomainAnswer::Http {
            status,
            headers,
            body,
        } = match request_key.as_deref().filter(|_| paged) {
            Some(key) => crate::local_workspace::tool_answer_in_bytes(snapshot, key, after_byte),
            None => crate::local_workspace::answer(snapshot),
        }
        .map_err(|error| {
            failure(match error {
                crate::workspace::WorkspaceError::TooLarge(_) => crate::carry_cause!(Kind::Bounds, error),
                _ => crate::carry_cause!(Kind::SourceUnavailable, error),
            })
        })?
        else {
            return Err(failure(crate::cause!(Kind::SourceUnavailable)));
        };
        Ok(PreparedPersonalRead {
            caller,
            body: Zeroizing::new(body),
            status,
            headers,
            request_key: request_key.unwrap_or_default(),
            witness,
            cancel,
        })
    }
    /// Admit one call of the account routes' generic read of the account's own records (`record_value::door`, product DATA
    /// records-routes.json) for `caller`: one record, one page of a kind or one record's history. The read itself runs
    /// after the account is released (`AdmittedRecordsRead::read`), and `confirm_door_records_read` checks it again
    /// before the answer leaves; the caller's access is checked at every one of the read's checks.
    pub(crate) fn admit_door_records_read(
        &mut self,
        caller: &Caller,
        operation: &Operation,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> AccountResult<AdmittedRecordsRead> {
        let door = crate::record_value::account_routes::Door::shipped()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !door.answers(&operation.resource, &operation.operation)
            || operation.request_key.is_empty()
            || operation.request_key.encode_utf16().count() > 512
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let mut read = self.admit_door_instruction_read(caller, cancel, deadline)?;
        read.bind_domain(&mut self.owner, operation)?;
        Ok(read)
    }

    /// Admit a read of the account's own records for `caller` with no records-route operation of its own (the
    /// instruction renderer's reads, a projection a tool run or the account files routes answer beside).
    pub(crate) fn admit_door_instruction_read(
        &mut self,
        caller: &Caller,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> AccountResult<AdmittedRecordsRead> {
        if self.owner.account().owner_id != caller.principal.account_id || !caller.stands() {
            return Err(crate::cause!(AccountError::RightsRefused));
        }
        self.assert_source_current()?;
        let mut read = AdmittedRecordsRead::for_checked_owner(
            &mut self.owner,
            cancel,
            deadline,
            caller.current.clone(),
        )?;
        read.cursor_scope = record_cursor_scope(&read.owner_id, Some(&caller.principal.sign_in));
        Ok(read)
    }

    /// Admit one page call of the account routes' generic records read (`record_value::account_routes::Door::page_call`) for the account's
    /// own page. The caller has admitted the page's browser session on this account (`account::current_browser`) and
    /// checks it again after the read; here the selection is current and the read is bound to the account's own
    /// records file, as `admit_personal_records_read` binds an AI's key call. No key is involved.
    pub(crate) fn admit_page_records_read(
        &mut self,
        operation: &Operation,
        browser: crate::account::BrowserAdmission,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> AccountResult<AdmittedRecordsRead> {
        let door = crate::record_value::account_routes::Door::shipped()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !door.answers(&operation.resource, &operation.operation) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let admitted = AdmittedRecordsRead {
            door,
            domain: None,
            readers: None,
            routes: None,
            book: None,
            key_reads: Mutex::new(Default::default()),
            original_result: None,
            owner_id: String::new(),
            cursor_scope: String::new(),
            state_root: self.owner.state_root().to_owned(),
            cancel,
            deadline,
            parent_connection_current: browser.current,
        };
        if admitted.stopped() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.assert_source_current()?;
        let (readers, routes) = self
            .owner
            .own_read_context()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let book = self.owner.record_book_check()?;
        let owner_id = self.owner.account().owner_id;
        let mut admitted = AdmittedRecordsRead {
            readers: Some(readers),
            routes,
            book: Some(book),
            cursor_scope: record_cursor_scope(&owner_id, None),
            owner_id,
            ..admitted
        };
        admitted.bind_domain(&mut self.owner, operation)?;
        Ok(admitted)
    }

    /// The check that allowed a page call `admitted` still stands after its read: the same selected source and the same
    /// own-records file, the call not cancelled or past its deadline (the caller checks the session again).
    pub(crate) fn confirm_page_records_read(
        &mut self,
        admitted: &AdmittedRecordsRead,
    ) -> AccountResult<()> {
        self.assert_source_current()?;
        admitted.confirm_checked_owner(&mut self.owner)
    }

    /// The check that allowed `admitted` still stands after its read: the caller (checked inside, at the read's check), the
    /// same selected source and the same own-records file, the call not cancelled or past its deadline.
    pub(crate) fn confirm_door_records_read(
        &mut self,
        admitted: &AdmittedRecordsRead,
    ) -> AccountResult<()> {
        self.assert_source_current()?;
        admitted.confirm_checked_owner(&mut self.owner)
    }
    /// One of the account routes' operations on the person's wakes for `caller`, prepared by `prepare_wake_call` before the
    /// account was held: the causes screen's read (`wake::Waker::causes`), or the switch of one wake written by the
    /// caller's party, whose cause name is `by` (`account_rights::run_cause::switch`), on the wake book in the
    /// account's own records store. The account and state folder the preparation read are checked to be this
    /// account's. Whether the caller still stands was asked before the account was taken (`caller.stands()` reads the
    /// sign-in alone), and is asked again by the caller after it is released.
    pub(crate) fn door_wake_call(
        &mut self,
        caller: &Caller,
        by: &str,
        prepared: &PreparedWakeCall<'_>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> AccountResult<serde_json::Value> {
        let stopped = || cancel.load(Ordering::Acquire) || Instant::now() >= deadline;
        if stopped() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        if self.tool_place() != (prepared.account.clone(), prepared.state_root.clone())
            || self.owner.account().owner_id != caller.principal.account_id
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.assert_source_current()?;
        let selection = &self.selection;
        let mut current = |_: &mut LocalAccount| -> AccountResult<()> {
            selection
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            if stopped() {
                return Err(crate::cause!(AccountError::RightsRefused));
            }
            Ok(())
        };
        prepared.answer(&mut self.owner, by, &mut current)
    }
    fn personal_workspace_read_chunk_current(
        &mut self,
        prepared: &PreparedPersonalRead,
    ) -> AccountResult<()> {
        if prepared.witness.expired() || !prepared.caller.stands() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.assert_source_current()?;
        if self.owner.account().owner_id != prepared.caller.principal.account_id
            || !prepared.caller.stands()
        {
            return Err(crate::cause!(AccountError::RightsRefused));
        }
        // Last source read before releasing the chunk: SAME physical
        // connection's post-rollback data_version, not a new handle/mtime.
        self.owner
            .personal_record_projection_current(&prepared.witness)
    }
}
struct PersonalReadCustody {
    prepared: PreparedPersonalRead,
    owner: Arc<Mutex<SelectedAccount>>,
}
impl FinalBodyCustody for PersonalReadCustody {
    fn finish(
        self: Box<Self>,
        body: Body,
        principal: &Principal,
        bearer: Zeroizing<Vec<u8>>,
        ingress: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        if &self.prepared.caller.principal != principal {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        let response = self
            .prepared
            .into_guarded_mcp_body(self.owner, bearer, ingress, body)
            .map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
        Ok(response.into_body())
    }
}
impl PreparedPersonalRead {
    /// Return the canonical HTTP answer wrapper for `run_resource_operation`
    /// without parsing its JSON body into serde's scalar-string domain. The
    /// body stays exact UTF-8 text, so escaped lone UTF-16 surrogates remain
    /// available to the canonical ECMAScript JSON consumer.
    pub(crate) fn into_mcp_value(
        self,
        disclosure: &RequestDisclosure,
        owner: Arc<Mutex<SelectedAccount>>,
    ) -> Result<serde_json::Value, OperationFailure> {
        if !Arc::ptr_eq(&self.cancel, &disclosure.cancellation_flag()) {
            return Err(OperationFailure { cause: (crate::cause!()).into(),
                code: "original_read_request_changed".into(),
                outcome_unknown: true,
                detail: None,
            });
        }
        let status = self.status.as_u16();
        let content_type = self
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let value = crate::mcp_apps::WorkspaceAnswer::structured_content(
            status,
            &content_type,
            self.body.as_slice(),
            Some(&self.request_key),
            true,
            true,
            true,
        )
        .map_err(|error| OperationFailure { cause: error.cause(),
            code: "original_read_output_unavailable".into(),
            outcome_unknown: true,
            detail: None,
        })?;
        disclosure
            .register(Box::new(PersonalReadCustody {
                prepared: self,
                owner,
            }))
            .map_err(|error| OperationFailure { cause: error.cause(),
                code: "original_read_output_unavailable".into(),
                outcome_unknown: true,
                detail: None,
            })?;
        Ok(value)
    }

    #[cfg(test)]
    /// The existing MCP adapter supplies its final envelope encoder here. This
    /// child does not own or reproduce JSON-RPC/Apps formatting. The callback
    /// receives exact canonical HTTP bytes and original key; no guarded browser
    /// body is collected. The final encoded envelope retains the SAME witness.
    pub(crate) fn into_guarded_mcp_response(
        self,
        owner: Arc<Mutex<SelectedAccount>>,
        bearer: Zeroizing<Vec<u8>>,
        ingress_permit: Arc<dyn Send + Sync>,
        encode: impl FnOnce(StatusCode, &HeaderMap, &[u8], &str) -> Option<Vec<u8>>,
    ) -> Result<Response, Failure> {
        let mut encoded = Zeroizing::new(
            encode(self.status, &self.headers, &self.body, &self.request_key)
                .ok_or_else(|| failure(crate::cause!(Kind::Bounds)))?,
        );
        if encoded.len() > MAX_MESSAGE_BYTES {
            return Err(failure(crate::cause!(Kind::Bounds)));
        }
        let body = Body::from(std::mem::take(&mut *encoded));
        self.into_guarded_mcp_body(owner, bearer, ingress_permit, body)
    }

    /// Custody consumes the exact already-bounded SDK body. No re-encoding,
    /// collection or clone occurs at this boundary.
    pub(crate) fn into_guarded_mcp_body(
        self,
        owner: Arc<Mutex<SelectedAccount>>,
        bearer: Zeroizing<Vec<u8>>,
        ingress_permit: Arc<dyn Send + Sync>,
        body: Body,
    ) -> Result<Response, Failure> {
        drop(bearer);
        let mut response = Response::new(Body::new(PersonalReadBody {
            prepared: Some(self),
            owner,
            ingress_permit,
            wait: OwnerWait::new(),
            inner: body,
            checked: false,
            failed: false,
        }));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }
}
struct PersonalReadBody {
    prepared: Option<PreparedPersonalRead>,
    owner: Arc<Mutex<SelectedAccount>>,
    ingress_permit: Arc<dyn Send + Sync>,
    wait: OwnerWait,
    inner: Body,
    checked: bool,
    failed: bool,
}
struct KeptPersonalChunk {
    bytes: Bytes,
    _source: PersonalProjectionWitness,
    _ingress: Arc<dyn Send + Sync>,
    _owner: Arc<Mutex<SelectedAccount>>,
}
impl AsRef<[u8]> for KeptPersonalChunk {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for PersonalReadBody {
    fn drop(&mut self) {
        if let Some(p) = &self.prepared {
            p.cancel.store(true, Ordering::Release);
        }
    }
}
impl HttpBody for PersonalReadBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.failed {
            return Poll::Ready(None);
        }
        if !self.checked {
            let expired = self.prepared.as_ref().is_none_or(|p| p.witness.expired());
            if expired {
                self.prepared.take();
                self.inner = Body::empty();
                self.failed = true;
                return Poll::Ready(Some(crate::io_operation!(Err(io::Error::from(io::ErrorKind::PermissionDenied)))));
            }
            let selected = self.owner.clone();
            let checked = match self.wait.poll(selected.as_ref(), expired, cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => Err(error.cause()),
                Poll::Ready(Ok(mut selected)) => selected
                    .personal_workspace_read_chunk_current(
                        self.prepared.as_ref().expect("pending personal read"),
                    )
                    .map_err(|error| error.cause()),
            };
            if let Err(cause) = checked {
                self.prepared.take();
                self.inner = Body::empty();
                self.failed = true;
                return Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), cause))));
            }
            self.checked = true;
        }
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(None) => {
                self.prepared.take();
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(error))) => {
                self.prepared.take();
                self.inner = Body::empty();
                self.failed = true;
                Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::new(
                    io::ErrorKind::Other,
                    "MCP response body unavailable",
                ), crate::refusal_cause::Caused::cause(&error)))))
            }
            Poll::Ready(Some(Ok(chunk))) => match chunk.into_data() {
                Ok(bytes) => {
                    let prepared = self.prepared.take().expect("checked personal chunk");
                    Poll::Ready(Some(Ok(Frame::data(Bytes::from_owner(
                        KeptPersonalChunk {
                            bytes,
                            _source: prepared.witness,
                            _ingress: self.ingress_permit.clone(),
                            _owner: self.owner.clone(),
                        },
                    )))))
                }
                Err(chunk) => Poll::Ready(Some(Ok(chunk))),
            },
        }
    }
    fn is_end_stream(&self) -> bool {
        self.failed || self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        if self.checked && !self.failed {
            self.inner.size_hint()
        } else {
            // Do not reveal even the final envelope length before the same
            // source/key/right check that authorizes its first chunk.
            SizeHint::default()
        }
    }
}

/// One admitted workspace read (`SelectedAccount::admit_door_record_selection`): who it was admitted for and the
/// read-only handles of the account's own records file. Its read holds no account owner.
pub(crate) struct AdmittedWorkspaceRead {
    admission: crate::local_account::record_delivery::personal::PersonalAdmission,
    projection: Option<workspace_store::Selection>,
    page: Option<workspace_store::Page>,
    after_byte: Option<u64>,
    request_key: Option<String>,
    paged: bool,
    #[allow(dead_code, reason = "kept with the read for the last chunk's custody")]
    operation: Operation,
    caller: Caller,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl AdmittedWorkspaceRead {
    /// The projection, read in one read transaction on one read-only handle of the account's own records file: no
    /// account owner is held and no writer of the file is waited on.
    pub(crate) fn read(&self) -> Result<workspace_store::Snapshot, Failure> {
        if self.cancel.load(Ordering::Acquire) || !self.caller.stands() {
            return Err(failure(crate::cause!(Kind::Cancelled)));
        }
        self.admission.read(
            self.projection.as_ref(),
            self.page.as_ref(),
            self.cancel.clone(),
            self.deadline,
        )
    }
}

/// One admitted call of the account routes' generic records read (`SelectedAccount::admit_door_records_read`): the check that
/// its caller's access still stands and the read-only handles of the account's own records file. Its read holds
/// no account owner.
struct AdmittedDomain {
    identity: crate::storage::record_store_resources::domains::Identity,
    readers: Arc<crate::storage::record_store_resources::Readers>,
    book: crate::local_account::record_delivery::BookCheck,
    authority: crate::local_account::NativeDomainAuthority,
    physical: String,
    // This is a native admission permit, never the broader source/target
    // maintenance fence. It remains owned by final HTTP/MCP bytes.
    _permit: crate::local_account::NativeAuthorityPermit,
}

pub(crate) struct AdmittedRecordsRead {
    door: &'static crate::record_value::account_routes::Door,
    domain: Option<AdmittedDomain>,
    readers: Option<Arc<crate::storage::record_store_resources::Readers>>,
    /// The selected account's immutable route owner/generation snapshot, retained so routed reads and their final
    /// key checks use the same physical resource mapping.
    routes: Option<crate::local_account::own_records::OwnReadRoutes>,
    book: Option<crate::local_account::record_delivery::BookCheck>,
    /// Union across every projection read (including instruction fills). Only key-owner IDs and in-memory
    /// identities are kept, never key material, and conflicting observations cannot be combined into one answer.
    key_reads: Mutex<crate::local_account::own_records::KeyReads>,
    /// One original command result's exact native read evidence. The existing
    /// body custody owns this beside its normal field-key observations.
    original_result: Option<
        crate::local_account::record_writer::native_command_context::OriginalRecordsResultReadProof,
    >,
    owner_id: String,
    /// Account and admitted sign-in, used only as authenticated cursor context (never cursor plaintext).
    cursor_scope: String,
    /// The account's state folder: its installed tools' record model is the one its reads open through.
    state_root: std::path::PathBuf,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    parent_connection_current: crate::account::account_routes::Current,
}

/// Keep the account and sign-in as distinct cursor fields; concatenation would let typed identities containing
/// separators collide. Browser reads carry the selected account with no API sign-in of their own.
fn record_cursor_scope(account: &str, sign_in: Option<&str>) -> String {
    serde_json::json!({"account":account,"sign_in":sign_in}).to_string()
}

#[cfg(test)]
mod reference_cursor_tests {
    use super::record_cursor_scope;
    #[test]
    fn reference_cursor_context_keeps_account_and_sign_in_boundaries() {
        assert_ne!(
            record_cursor_scope("account:a", Some("b:c")),
            record_cursor_scope("account", Some("a:b:c"))
        );
        assert_ne!(
            record_cursor_scope("account", None),
            record_cursor_scope("account", Some(""))
        );
    }
}

impl AdmittedRecordsRead {
    /// Bind the generic reader to an owner already admitted by its credential
    /// witness. This supplies no permission: OAuth and page callers retain and
    /// recheck their own original authority before releasing its answer.
    pub(crate) fn for_checked_owner(
        owner: &mut crate::local_account::LocalAccount,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        parent_connection_current: crate::account::account_routes::Current,
    ) -> AccountResult<Self> {
        let read = Self {
            door: crate::record_value::account_routes::Door::shipped()
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?,
            domain: None,
            readers: None,
            routes: None,
            book: Some(owner.record_book_check()?),
            key_reads: Mutex::new(Default::default()),
            original_result: None,
            owner_id: owner.account().owner_id,
            cursor_scope: record_cursor_scope(&owner.account().owner_id, None),
            state_root: owner.state_root().to_owned(),
            cancel,
            deadline,
            parent_connection_current,
        };
        let (readers, routes) = owner
            .own_read_context()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let read = Self {
            readers: Some(readers),
            routes,
            ..read
        };
        read.confirm_checked_owner(owner)?;
        Ok(read)
    }

    /// Resolve only the complete context supplied to this admitted operation.
    /// The base account remains an authority witness; it never supplies scoped
    /// record bodies, keys or cursor state.
    fn bind_domain(&mut self, owner: &mut LocalAccount, operation: &Operation) -> AccountResult<()> {
        let selected = crate::storage::record_store_resources::domains::Selection::from_input(&operation.input)
            .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
        let Some(selected) = selected else { return Ok(()); };
        if selected.create || self.domain.is_some() { return Err(crate::cause!(AccountError::InvalidInput)); }
        let generation = owner.original_records_read_generation().map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        let bound = owner.selected_command_domain(&operation.input, &self.owner_id, generation)
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?.ok_or(crate::cause!(AccountError::InvalidInput))?;
        let readers = bound.readers().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let book = owner.record_file_check(readers.path().to_owned())?;
        let identity = selected.identity();
        // A restored physical copy can contain a self-consistent logical
        // header. Only the independent canonical authority can admit its token.
        let physical = readers.read(|store| crate::local_account::own_records::domain_authority(&store, &self.owner_id, &identity))
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        let current = self.parent_connection_current.clone();
        let cancel = self.cancel.clone();
        let deadline = self.deadline;
        let account = self.owner_id.clone();
        let mut admitted_current = |owner: &mut LocalAccount| {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline
                || owner.account().owner_id != account || !current() {
                return Err(crate::cause!(AccountError::RightsRefused));
            }
            // The factory rechecks original source ownership itself. This
            // callback contributes the actual browser/personal admission.
            Ok(())
        };
        let authority = owner.native_domain_authority(&identity, self.cancel.clone(), self.deadline, &mut admitted_current)
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        let permit = authority.hold_native(&physical).map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        book.assert_same_file()?;
        self.cursor_scope = serde_json::json!({"caller":self.cursor_scope,"scope":identity}).to_string();
        self.domain = Some(AdmittedDomain { identity, readers, book, authority, physical, _permit: permit });
        self.confirm_checked_owner(owner)
    }

    /// Keep exactly one native result proof in this same read/body owner.
    pub(crate) fn retain_original_result(
        &mut self,
        proof: crate::local_account::record_writer::native_command_context::OriginalRecordsResultReadProof,
    ) -> AccountResult<()> {
        if self.original_result.is_some() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.original_result = Some(proof);
        Ok(())
    }

    /// The same account and physical readers still own this admitted read.
    /// The caller's access is checked here too, through the check the read was admitted with.
    pub(crate) fn confirm_checked_owner(
        &self,
        owner: &mut crate::local_account::LocalAccount,
    ) -> AccountResult<()> {
        let (readers, routes) = owner
            .own_read_context()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if self.owner_id != owner.account().owner_id
            || self
                .readers
                .as_ref()
                .is_none_or(|held| held.path() != readers.path())
            || !match (self.routes.as_ref(), routes.as_ref()) {
                (None, None) => true,
                (Some(expected), Some(current)) => expected.same_context(current),
                _ => false,
            }
            || self.stopped()
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.book
            .as_ref()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .assert_same_file()?;
        let keys = self
            .key_reads
            .lock()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let current = if let Some(domain) = &self.domain {
            // Preserve the original permit while checking current canonical
            // admission again. Starting a fence stops newly disclosed bytes;
            // the old permit then drains when this body is dropped/refused.
            let _current_authority = domain.authority.hold_native(&domain.physical)
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            domain.book.assert_same_file()?;
            let base_current = readers.read(|store|
                crate::local_account::own_records::original_command_source_matches(&store, &self.owner_id, domain.identity.generation))
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let keys_current = crate::local_account::own_records::domain_keys_unchanged(
                &domain.readers, &self.owner_id, &domain.identity, &domain.physical, &keys)
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            domain.book.assert_same_file()?;
            base_current && keys_current
        } else {
            crate::local_account::own_records::keys_unchanged(&readers, &self.owner_id, self.routes.as_ref(), &keys)
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
        };
        if !current {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        drop(keys);
        self.book
            .as_ref()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .assert_same_file()?;
        // All caller/parent callbacks ran above. Check the journal, protected
        // result and its keys together on the native proof's fresh read, with
        // no callback or command execution after this point.
        if let Some(proof) = &self.original_result {
            if !proof
                .unchanged(&readers, &self.owner_id, self.routes.as_ref())
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
            {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
        }
        // The parent check above may consult a remote issuer or share owner.
        // After the exact key check, only local cancellation/time checks may
        // run; another parent callback could erase a key before release.
        if self.cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(AccountError::Cancelled));
        }
        if Instant::now() >= self.deadline {
            return Err(crate::cause!(AccountError::DeadlineElapsed));
        }
        Ok(())
    }

    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
            || !(self.parent_connection_current)()
    }

    /// The call's answer, read in one read transaction on one read-only handle of the account's own records file
    /// (`own_records::read_own`): no account owner is held and no writer of the file is waited on.
    ///
    /// `remote` says the caller is not a tool run of this computer: a kind that stays on this computer is refused to it
    /// before anything of it is read (`Door::device_only_asked`).
    pub(crate) fn read(
        &self,
        operation: &Operation,
        remote: bool,
    ) -> AccountResult<serde_json::Value> {
        self.read_interposed(operation, remote, || {})
    }

    #[cfg(test)]
    pub(crate) fn read_with_kind_interpose(
        &self,
        operation: &Operation,
        remote: bool,
        interpose: impl FnOnce(),
    ) -> AccountResult<serde_json::Value> {
        self.read_interposed(operation, remote, interpose)
    }

    fn read_interposed(
        &self,
        operation: &Operation,
        remote: bool,
        interpose: impl FnOnce(),
    ) -> AccountResult<serde_json::Value> {
        let selected = crate::storage::record_store_resources::domains::Selection::from_input(&operation.input)
            .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
        if selected.as_ref().map(|selected| selected.identity()) != self.domain.as_ref().map(|domain| domain.identity.clone()) {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        let readers = self.domain.as_ref().map(|domain| domain.readers.as_ref())
            .or(self.readers.as_deref())
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let open = crate::record_model_policy::installed(&self.state_root)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut limits = crate::record_value::Limits::default();
        limits.elapsed = limits
            .elapsed
            .min(self.deadline.saturating_duration_since(Instant::now()));
        if limits.elapsed.is_zero() || self.stopped() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.book
            .as_ref()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .assert_same_file()?;
        // Base reads use this transaction; repeated routed point reads memoize their first stored form in `OwnRead`.
        // A same-id kind change therefore cannot pass the device-only precheck and expose a later routed version.
        if let Some(domain) = &self.domain { domain.book.assert_same_file()?; }
        // This network boundary is outside the account owner and precedes the
        // physical snapshot. A replica must match that exact committed head;
        // a prepared tail or reused sequence alone cannot qualify disclosure.
        let expected_head=self.domain.as_ref().map(|domain|crate::account::computers::copies::current_domain_head(&self.owner_id,&domain.identity))
            .transpose().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.flatten();
        let (answer, used) = crate::local_account::own_records::read_bound_with_keys(
            readers,
            &self.owner_id,
            if self.domain.is_some() { None } else { self.routes.clone() },
            self.domain.as_ref().map(|domain| &domain.identity),
            &open,
            |view| {
                if let Some(head)=&expected_head {view.assert_domain_head(head)?;}
                Ok::<_, crate::records::Error>((|| {
                    if remote
                        && self
                            .door
                            .device_only_asked(
                                &operation.operation,
                                &operation.input,
                                view,
                                &open,
                                limits,
                            )
                            .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?
                            .is_some()
                    {
                        // A new account can answer MCP before its first Workshop install finishes. A kind whose
                        // policy is unavailable stays closed without a false permanent local-only refusal. A
                        // verified absent record has no kind to protect and keeps its existing absent answer.
                        return Err(if open.device_policy_available() {
                            crate::cause!(AccountError::DeviceOnly)
                        } else {
                            crate::cause!(AccountError::SourceUnavailable)
                        });
                    }
                    interpose();
                    self.door
                        .answer_scoped(
                            &operation.operation,
                            &operation.input,
                            view,
                            &open,
                            limits,
                            &crate::mcp::tool_answer_fits,
                            remote,
                            &self.cursor_scope,
                        )
                        .map_err(|error| match error {
                            // A page the account routes cannot cut to fit (one record, or a first row, larger than one answer) is the caller's
                            // request to change, not an unknown outcome.
                            crate::record_value::Error::Invalid(_)
                            | crate::record_value::Error::Bounds(_) => crate::cause!(AccountError::InvalidInput),
                            crate::record_value::Error::Scan(_) => crate::cause!(AccountError::WholeKind),
                            _ => crate::cause!(AccountError::SourceUnavailable),
                        })
                })())
            },
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut answer = answer?;
        // A list from a copy that is still catching up says so: it may leave out records it has not fetched yet.
        if operation.operation == self.door.list_operation() && crate::account::computers::copies::still_filling(&self.owner_id) {
            if let Some(object) = answer.as_object_mut() {
                object.insert("filling".into(), serde_json::json!(true));
            }
        }
        let mut retained = self
            .key_reads
            .lock()
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        for (id, key) in used {
            if retained.get(&id).is_some_and(|earlier| earlier != &key) {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            retained.insert(id, key);
        }
        Ok(answer)
    }
}
