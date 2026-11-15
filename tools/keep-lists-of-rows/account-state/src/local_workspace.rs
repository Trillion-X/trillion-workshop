// src/local_workspace.rs
//
// Purpose: Execute original workspace records and ordinary-browser viewer reads over the selected local account.
// Non-Negotiable Invariants: Admission and records use the same selected account Arc; retain current
// browser/generation/policy and request cancellation across the read and before disclosure. Unsupported
// operations refuse. No alternative store, schema, command journal, page or fabricated record is created.
// Key Concepts: Current WorkspaceSessions, @own-records, original selection, lossless ECMAScript JSON.
// Security Considerations: Never serialize credentials or private source errors; public program archives are
// unrelated to these private records. A read adapter is not a usable whole app or a mutation capability.
// AI Assistant Directive: Preserve the existing operation/state owners and exact UTF-16 values; do not turn
// unimplemented domain operations into generic CRUD, successful empty answers, or a second executor.

mod connection_management;
mod heads;
pub(crate) mod personal_read;
mod records;
mod show_rules;
mod tool_screens;
mod write;

use crate::account_files::account_routes::{Failure as FilesFailure, Files as FilesOwner};
use crate::account_rights::run_capability::Route;
use crate::{
    account::{self, AccountError, BrowserAdmission},
    ecma_json::{self, JsString, Object, Value as EcmaValue},
    native_boot::SelectedAccount,
    workspace::{SupplyFuture, WorkspaceError, WorkspaceSession},
    workspace_domain::{
        BrowserScope, CanonicalWorkspaceExecutor, DomainAnswer, DomainCommand, DomainContext,
    },
    workspace_session::WorkspaceSessions,
    workspace_startup,
    workspace_store::{self, Kind, Selection, Snapshot},
};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::Value;
use std::{
    fmt,
    sync::{Arc, Mutex},
};

const RESOURCE: &str = "@own-records";
const OPERATION: &str = "workspace:read";
// Internal Rust adapter name for the original direct browser GET /viewer.
// The original native-owner-routes DATA did not name this endpoint.
const VIEWER_OPERATION: &str = "viewer:read";

/// Partial canonical read composition. The constructor checks pointer identity,
/// not merely equal account labels, so session admission cannot come from a
/// different selected account. Native startup owns mounting this executor.
pub struct LocalWorkspace {
    owner: Arc<Mutex<SelectedAccount>>,
    /// At most one idle records-command context; an active command is taken out and owns no cache mutex.
    commands: Arc<Mutex<Option<SelectedAccount>>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    tool_screens: Option<Arc<tool_screens::Mount>>,
    show_rules: Option<Arc<show_rules::Mount>>,
    /// The account routes' own loopback address, where a tool run the page starts reaches the records routes with its
    /// capability; none where no loopback listener runs (a run of a row that declares records then does not start).
    route: Option<Route>,
}

impl LocalWorkspace {
    /// The account's own loopback route for the page's tool runs (`Route::loopback`; none where no loopback listener runs).
    pub fn with_route(mut self, route: Option<Route>) -> Self {
        self.route = route;
        self
    }
    pub fn with_show_rules(
        mut self,
        locale: Arc<crate::tool_label_locale::QualifiedLocale>,
    ) -> Self {
        self.show_rules = Some(Arc::new(show_rules::Mount { locale }));
        self
    }
}
impl fmt::Debug for LocalWorkspace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocalWorkspace([redacted])")
    }
}
impl LocalWorkspace {
    pub fn new(
        owner: Arc<Mutex<SelectedAccount>>,
        sessions: WorkspaceSessions<SelectedAccount>,
    ) -> Result<Self, WorkspaceError> {
        if !sessions.has_owner(&owner) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        Ok(Self {
            owner,
            commands: Arc::new(Mutex::new(None)),
            sessions,
            tool_screens: None,
            show_rules: None,
            route: None,
        })
    }
}

fn account_error(error: AccountError) -> WorkspaceError {
    let cause = error.cause();
    match error {
        AccountError::BrowserInactive(_)
        | AccountError::RightsRefused(_)
        | AccountError::KeyWithdrawn(_) => WorkspaceError::Unauthorized(cause),
        AccountError::InvalidInput(_) => WorkspaceError::Invalid(cause),
        AccountError::RightsChanging(_) | AccountError::SourceChanged(_) => WorkspaceError::Conflict(cause),
        _ => WorkspaceError::Unavailable(cause),
    }
}
fn snapshot_error(kind: Kind) -> WorkspaceError {
    let cause = kind.cause();
    match kind {
        Kind::Invalid(_) => WorkspaceError::Invalid(cause),
        Kind::Bounds(_) => WorkspaceError::TooLarge(cause),
        Kind::Cancelled(_) | Kind::SourceChanged(_) => WorkspaceError::Conflict(cause),
        Kind::SourceUnavailable(_) => WorkspaceError::Unavailable(cause),
        Kind::Schema(_) | Kind::Corrupt(_) => WorkspaceError::Integrity(cause),
    }
}
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 4096 && !key.chars().any(char::is_control)
}
fn labels(value: Option<&Value>) -> Result<Vec<String>, WorkspaceError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let rows = value.as_array().ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if rows.len() > workspace_store::MAX_SELECTION {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    rows.iter().map(label).collect()
}
fn label(value: &Value) -> Result<String, WorkspaceError> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.encode_utf16().count() <= workspace_store::MAX_LABEL_UNITS)
        .map(str::to_owned)
        .ok_or(crate::cause!(WorkspaceError::Invalid))
}
/// The page a workspace read continues after: its input's `after`, a page's `next` (a label), when present.
fn after(input: &Value) -> Result<Option<String>, WorkspaceError> {
    let input = input.as_object().ok_or(crate::cause!(WorkspaceError::Invalid))?;
    match input.get("after") {
        None => Ok(None),
        Some(after) => label(after).map(Some),
    }
}
/// The stored text one page of a tool's workspace read takes: half of one MCP message, because the answer's text
/// leaves twice in the tool result (its JSON text and its structured content). A page whose answer still does not
/// fit is cut by `tool_answer`.
const TOOL_PAGE_BYTES: usize = crate::mcp::MAX_MESSAGE_BYTES / 2;
/// The page a tool's workspace read asks for: after its input's `after`, as many records as fit one MCP answer.
pub(crate) fn tool_page(input: &Value) -> Result<workspace_store::Page, WorkspaceError> {
    Ok(workspace_store::Page {
        after: after(input)?,
        bytes: TOOL_PAGE_BYTES,
    })
}
/// The answer of a tool's workspace read: the most records of `snapshot` (see `fitting_answer`) whose tool result,
/// the MCP structured content `request_key` names, fits one MCP message.
pub(crate) fn tool_answer(
    snapshot: Snapshot,
    request_key: &str,
) -> Result<DomainAnswer, WorkspaceError> {
    fitting_answer(snapshot, tool_fits(request_key))
}
/// Whether an answer, as the tool result MCP carries it, fits one message.
fn tool_fits(request_key: &str) -> impl Fn(&DomainAnswer) -> bool + '_ {
    move |answer| {
        let DomainAnswer::Http {
            status,
            headers,
            body,
        } = answer
        else {
            return false;
        };
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        crate::mcp_apps::WorkspaceAnswer::structured_content(
            status.as_u16(),
            content_type,
            body,
            Some(request_key),
            true,
            true,
            true,
        )
        .is_ok_and(|value| crate::mcp::tool_answer_fits(&value))
    }
}
/// The byte a tool's workspace read continues after, its input's `after_byte` (a byte page's `next_after_byte`).
pub(crate) fn tool_after_byte(input: &Value) -> Result<Option<u64>, WorkspaceError> {
    match input
        .as_object()
        .ok_or(crate::cause!(WorkspaceError::Invalid))?
        .get("after_byte")
    {
        None | Some(Value::Null) => Ok(None),
        Some(after) => after.as_u64().map(Some).ok_or(crate::cause!(WorkspaceError::Invalid)),
    }
}
/// `tool_answer`, except a first record too big for one message is delivered as pages of its own bytes
/// (`mcp::byte_page`): the answer `{"byte_page": ..}` for that record's one-record answer, and with `after_byte` the
/// page from there. No record is refused for its size.
pub(crate) fn tool_answer_in_bytes(
    snapshot: Snapshot,
    request_key: &str,
    after_byte: Option<u64>,
) -> Result<DomainAnswer, WorkspaceError> {
    let fits = tool_fits(request_key);
    let first = snapshot.records.first().cloned().map(|record| {
        (
            record,
            snapshot.records.len() > 1 || snapshot.next.is_some(),
        )
    });
    if after_byte.is_none() {
        match fitting_answer(snapshot, &fits) {
            Err(WorkspaceError::TooLarge(_)) => {}
            answered => return answered,
        }
    }
    let ((label, value), more) = first.ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let bytes = body([(label.clone(), value)], more.then_some(label.as_str()))?;
    let page_fits = |page: &Value| serde_json::to_vec(page).is_ok_and(|page| fits(&http(page)));
    let page = crate::mcp::byte_page(&bytes, after_byte.unwrap_or(0), &page_fits)
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    Ok(http(
        serde_json::to_vec(&page).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?,
    ))
}
/// Preserve NativeWorkspaceRecords.workspaceRecords: omitted selection means
/// all; a present empty/null/scalar selection means no records; legacy arrays
/// mean labels. Object labels/prefixes are combined before de-duplication.
pub(crate) fn selection(input: &Value) -> Result<Option<Selection>, WorkspaceError> {
    let input = input.as_object().ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let Some(value) = input.get("selection") else {
        return Ok(None);
    };
    let selected = if value.is_array() {
        Selection {
            labels: labels(Some(value))?,
            prefixes: Vec::new(),
        }
    } else {
        Selection {
            labels: labels(value.get("labels"))?,
            prefixes: labels(value.get("prefixes"))?,
        }
    };
    if selected.labels.len() + selected.prefixes.len() > workspace_store::MAX_SELECTION {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(Some(selected))
}
enum ReadInput {
    ConnectionManagement,
    WorkspaceWrite,
    Records(Option<Selection>),
    Viewer,
    /// A page call of the records routes' generic read: its operation and input (record_value::account_routes::Door::page_call).
    DoorRead(String, Value),
    /// A page call of the tools owner: its method and input (tool_runs::tools::Workshop::page_call).
    ToolCall(String, Value),
    /// A page call of the person's files: its operation and input (`FilesOwner::page_call`).
    FilesCall(String, Value),
    ToolScreens(String),
    /// One screen of the generic screen host (`/screens/<id>`, the screen-host row's `rest`): the screen asked for, or
    /// none when the id names no screen (404), as old trillion src/screen-host.mjs answered it.
    Screen(Option<crate::tool_runs::page_routes::ScreenAsk>),
    /// A page route answered by running one Workshop tool (src/server/tool-routes.json): the tool and the
    /// request it is given as its input ({path, method, query, body, browser}).
    WorkshopRoute(String, Value),
    ShowRules,
}
/// The one screen a screen-host request with a `rest` asks for (old trillion src/screen-host.mjs:39-52): GET only,
/// its id the rest of the path decoded, its query the address's own, and the asking browser's own facts.
fn screen_ask(input: &Value) -> Result<ReadInput, WorkspaceError> {
    use crate::tool_runs::page_routes;
    if input.get("method").and_then(Value::as_str) != Some("GET") {
        return Err(crate::cause!(WorkspaceError::NoOwner));
    }
    let settings = page_routes::settings()?;
    let target = input
        .get("path")
        .and_then(Value::as_str)
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if target.len() > 32 * 1024 {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let query = target.split_once('?').map_or("", |(_, query)| query);
    let rest = input
        .get("rest")
        .and_then(Value::as_str)
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let browser = input
        .get("browser")
        .filter(|browser| browser.is_object())
        .cloned()
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let query = page_routes::query_pairs(query)?;
    Ok(ReadInput::Screen(
        page_routes::screen_tool_id(settings, rest).map(|tool_id| page_routes::ScreenAsk {
            tool_id,
            query,
            browser,
            account_id: String::new(),
        }),
    ))
}
/// A Workshop route's call ({tool, request}, workspace_domain::OwnerRoutes::resolve): never one of the engine's own
/// rows, which run only by their wakes.
fn workshop_route(input: &Value) -> Result<ReadInput, WorkspaceError> {
    let tool = input
        .get("tool")
        .and_then(Value::as_str)
        .filter(|tool| !tool.is_empty())
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let request = input
        .get("request")
        .filter(|request| request.is_object())
        .cloned()
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if crate::tool_runs::tools::shipped().is_ok_and(|workshop| workshop.engine_row(tool)) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(ReadInput::WorkshopRoute(tool.to_owned(), request))
}
fn read_input(operation: &str, input: &Value) -> Result<ReadInput, WorkspaceError> {
    match operation {
        connection_management::OPERATION => {
            connection_management::request(input)?;
            Ok(ReadInput::ConnectionManagement)
        }
        write::OPERATION => {
            write::request(input)?;
            Ok(ReadInput::WorkspaceWrite)
        }
        // The account's own record write: its name is product DATA.
        records if crate::record_write_model::write_command::Command::is_shipped(records) => {
            write::request(input)?;
            Ok(ReadInput::WorkspaceWrite)
        }
        OPERATION => selection(input).map(ReadInput::Records),
        tool_screens::OPERATION if input.get("rest").is_some() => screen_ask(input),
        route
            if crate::workspace_domain::workshop_route_operation()
                .is_ok_and(|family| family == route) =>
        {
            workshop_route(input)
        }
        tool_screens::OPERATION => tool_screens::request(input).map(ReadInput::ToolScreens),
        // The frontend's `/work/api/workshop/screens` arrives as
        // presentation:request. Bind only this exact GET to the already
        // admitted selected tool-screen reader; the generic presentation
        // family remains unsupported here.
        tool_screens::PRESENTATION_OPERATION => {
            tool_screens::presentation_request(input).map(|request| match request {
                tool_screens::PresentationRequest::Screens(after) => ReadInput::ToolScreens(after),
            })
        }
        show_rules::OPERATION => {
            show_rules::request(input)?;
            Ok(ReadInput::ShowRules)
        }
        VIEWER_OPERATION if input.as_object().is_some_and(|v| v.is_empty()) => {
            Ok(ReadInput::Viewer)
        }
        VIEWER_OPERATION => Err(crate::cause!(WorkspaceError::Invalid)),
        // The page's road to the tools owner's page calls (src/server/owner-routes.json, the row named after the
        // tools' address): a list, or a run whose pass comes from the page's session, admitted here by that session.
        page if crate::tool_runs::tools::shipped()
            .is_ok_and(|workshop| workshop.page_call(page, input).is_some()) =>
        {
            let workshop =
                crate::tool_runs::tools::shipped().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            let (method, input) = workshop
                .page_call(page, input)
                .ok_or(crate::cause!(WorkspaceError::NoOwner))?
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            Ok(ReadInput::ToolCall(method, input))
        }
        // The page's road to the person's files (src/server/owner-routes.json, the row named after their resource):
        // the same operations an AI's key reaches, let in here by the page's session.
        page if FilesOwner::shipped()
            .is_some_and(|files| files.page_call(page, input).is_some()) =>
        {
            let files = FilesOwner::shipped().ok_or(crate::cause!(WorkspaceError::Unavailable))?;
            let (operation, input) = files
                .page_call(page, input)
                .ok_or(crate::cause!(WorkspaceError::NoOwner))?
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            Ok(ReadInput::FilesCall(operation, input))
        }
        // The page's road to the records routes' generic read (src/server/owner-routes.json, the row named after the
        // routes' resource): the read, list or history these routes answer an AI's key, admitted here by the page's session.
        page if crate::record_value::account_routes::Door::shipped()
            .is_ok_and(|door| door.page_call(page, input).is_some()) =>
        {
            let door = crate::record_value::account_routes::Door::shipped()
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            let (operation, input) = door
                .page_call(page, input)
                .ok_or(crate::cause!(WorkspaceError::NoOwner))?
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            Ok(ReadInput::DoorRead(operation, input))
        }
        // An operation no mount here answers.
        _ => Err(crate::cause!(WorkspaceError::NoOwner)),
    }
}
/// The operation a page request (`method`, `/work/api/...` with its query) reaches in trillion-local, by the resolution
/// every `/work/api` request takes: the screen revision, the fixed routes, the product route table, then the operations
/// this executor mounts. `None` when nothing here answers it (the page gets 404 failure_code no-owner). A request whose
/// input a mounted operation refuses still has an owner; a write is asked with an empty JSON object body. The Mac
/// release proof asks this for every route the built web client names (`trillion-local route-owners`).
pub fn route_owner(
    routes: &crate::workspace_domain::OwnerRoutes,
    method: &str,
    target: &str,
) -> Option<String> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = format!("/{}", path.strip_prefix("/work/api/")?);
    // The screen revision is the transport read of the heads (CanonicalWorkspace::invoke); its owner is the path.
    if path == "/screen-revision" && method == "GET" {
        return Some(path);
    }
    let body = (!matches!(method, "GET" | "HEAD")).then(|| serde_json::json!({}));
    let call =
        match crate::workspace_domain::specialized(&path, method, query, &body, "http://127.0.0.1")
        {
            Ok(Some(call)) => call,
            Ok(None) => routes
                .resolve(&path, method, query, body, Some(serde_json::json!({})))
                .ok()??,
            Err(_) => return None,
        };
    match read_input(&call.operation, &call.input) {
        Err(WorkspaceError::NoOwner(_)) => None,
        _ => Some(call.operation),
    }
}
/// One page call of the records routes' generic read (`ReadInput::DoorRead`): the page's session is admitted on the
/// selected account, the call is admitted on the account's own records file, the read runs with no account owner
/// held (`AdmittedRecordsRead::read`, the read an AI's key reaches over MCP), and the session and the admission are
/// checked again before the answer leaves.
/// One record of the primary by id, read as a page read is (admitted on the page's session, then confirmed), answering
/// its value: the `home:` row of a kind (records-routes.json `_homes`, Door::to_home), for the page's reads and writes.
pub(super) fn read_home_row(
    owner: &Arc<Mutex<SelectedAccount>>,
    retained: &DomainContext,
    deadline: std::time::Instant,
    id: &str,
) -> Result<Value, WorkspaceError> {
    let door = crate::record_value::account_routes::Door::shipped()
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    let call = crate::mcp::Operation {
        person_present: None,
        resource: door.resource().to_owned(),
        operation: door.read_operation().to_owned(),
        request_key: String::new(),
        input: serde_json::json!({"id": id}),
    };
    let mut selected = crate::workspace_session::owner_wait::acquire(owner, || retained.permit.cancelled())
        .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
    let browser = account::current_browser_read_only(&mut *selected, &retained.session.session_id)
        .map_err(account_error)?;
    same_admission(&browser, &retained.session)?;
    let admitted = selected
        .admit_page_records_read(&call, browser, retained.permit.cancellation_flag(), deadline)
        .map_err(account_error)?;
    drop(selected);
    let body = admitted.read(&call, false).map_err(account_error)?;
    let mut selected = crate::workspace_session::owner_wait::acquire(owner, || retained.permit.cancelled())
        .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
    selected.confirm_page_records_read(&admitted).map_err(account_error)?;
    Ok(body.get("value").cloned().unwrap_or(Value::Null))
}

fn read_door(
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    context: DomainContext,
    operation: String,
    input: Value,
) -> SupplyFuture<DomainAnswer> {
    Box::pin(async move {
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
        let retained = context.clone();
        let result = crate::storage::request_work::spawn_blocking(move || {
            let door = crate::record_value::account_routes::Door::shipped()
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            let deadline = std::time::Instant::now() + workspace_store::Limits::default().elapsed;
            // A kind kept in a home of its own is read there (records-routes.json `_homes`, Door::to_home); its `home:`
            // row is read like any page read, under this session's admission and its confirmation.
            let mut input = input;
            let mut read_home = |id: &str| read_home_row(&owner, &retained, deadline, id);
            if !door.to_home(&operation, &mut input, false, &mut read_home)? {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
            let call = crate::mcp::Operation {
                person_present: None,
                resource: door.resource().to_owned(),
                operation,
                request_key: String::new(),
                input,
            };
            let admitted = {
                let mut selected = crate::workspace_session::owner_wait::acquire(&owner, || {
                    retained.permit.cancelled()
                })
                .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
                let browser = account::current_browser_read_only(&mut *selected, &retained.session.session_id)
                    .map_err(account_error)?;
                same_admission(&browser, &retained.session)?;
                selected
                    .admit_page_records_read(&call, browser, retained.permit.cancellation_flag(), deadline)
                    .map_err(account_error)?
            };
            let body = admitted.read(&call, false).map_err(account_error)?;
            let mut selected = crate::workspace_session::owner_wait::acquire(&owner, || {
                retained.permit.cancelled()
            })
            .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
            selected
                .confirm_page_records_read(&admitted)
                .map_err(account_error)?;
            same_admission(
                &account::current_browser_read_only(&mut *selected, &retained.session.session_id)
                    .map_err(account_error)?,
                &retained.session,
            )?;
            drop(selected);
            records::guarded_door_answer(owner, retained, admitted, DomainAnswer::Json {
                body,
                next_before: None,
                collection_coverage: None,
            })
        })
        .await;
        cancellation.0.take();
        let answer = result.map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        Ok(answer)
    })
}
/// One page call of the tools owner (`ReadInput::ToolCall`): the page's session is admitted on the selected account
/// before and after, and the call runs with no account owner held (`Workshop::call`, the same list and run an AI's key
/// reaches over MCP). A run needs the request key the page carried (never one derived from its content, which would
/// answer a past run); the tools' run journal answers a repeated key with its first run. A run of a row that
/// declares records gets its capability from its live cause, the party the page is signed in as (`run_cause::CauseIssuer`,
/// `page_cause`): that party's rights ∩ the row's declaration, minted now, with nothing kept ahead of time, and stopped
/// at its next call once the party no longer stands here. A refusal answers the tools' own code.
fn call_tool(
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    context: DomainContext,
    route: Option<Route>,
    call: (String, Value),
    command: DomainCommand,
) -> SupplyFuture<DomainAnswer> {
    use crate::{
        account_rights::{run_capability::Issuer, run_cause::CauseIssuer},
        tool_runs::tools::{shipped, HomeVault, Place},
    };
    Box::pin(async move {
        let workshop = shipped().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        let (method, input) = call;
        let recovery = method == workshop.run_method() && input.as_object().is_some_and(|fields| fields.contains_key("after_byte"));
        let tool =
            (method == workshop.run_method()).then(|| input["tool"].as_str().map(str::to_owned));
        if tool.is_some() && !command.key_carried {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        if recovery { sessions.authorize_read_only(context.clone()).await?; }
        else { sessions.authorize(context.clone()).await?; }
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
        let retained = context.clone();
        let task_admission = sessions.admission();
        let result = crate::storage::request_work::spawn_blocking(move || {
            let admitted = || -> Result<crate::workspace_session::owner_wait::Held<'_, SelectedAccount>, WorkspaceError> {
                let mut selected = crate::workspace_session::owner_wait::acquire(&owner, || retained.permit.cancelled())
                    .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
                let browser = account::current_browser_read_only(&mut *selected, &retained.session.session_id)
                    .map_err(account_error)?;
                same_admission(&browser, &retained.session)?;
                Ok(selected)
            };
            let (account, state_root) = admitted()?.tool_place();
            // The run's cause is the page's party, only where a loopback listener runs: a run of a row that
            // declares records reaches the account's routes through it.
            let cause = page_cause(&retained);
            let issuer = route.as_ref().map(|route| CauseIssuer { account: &account, sign_in: &cause, cause: None, route, root: None });
            let parent = issuer.as_ref().map(|issuer| issuer as &dyn Issuer);
            let issuer = crate::tool_runs::tools::task_context::ContextIssuer {
                parent, context: page_task_context(&retained, &account),
            };
            let place = Place { account: &account, state_root: &state_root, door: Some(&issuer),
                origin: Some(workshop.page_origin()) };
            let (ran, proof) = crate::tool_runs::tools::with_recovery_receipt(|| workshop.call(
                &method, &command.request_key, &input, &place, &HomeVault { place: &place },
                &retained.permit.cancellation_flag())).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            drop(admitted()?);
            let answer = match ran {
                Ok(body) => DomainAnswer::Json { body, next_before: None, collection_coverage: None },
                Err(failure) => tool_refusal(failure)?,
            };
            let mut guards = Vec::new();
            if let Some(proof) = proof {
                #[cfg(not(host = "module"))]
                guards.push(page_recovery(workshop, task_admission.clone(), retained.clone(), account.clone(),
                    state_root.clone(), route.clone(), proof));
                #[cfg(host = "module")]
                return Err(crate::cause!(WorkspaceError::Unavailable));
            }
            guarded_page_answer(answer, guards)
        })
        .await;
        cancellation.0.take();
        let answer = result.map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        if recovery { sessions.authorize_read_only(context.clone()).await?; }
        else { sessions.authorize(context.clone()).await?; }
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        Ok(answer)
    })
}
/// The runs one page request makes of the account's Workshop tools (`page_tool_runs`), each the same run a page's
/// POST /work/api/door/tools:run takes (`call_tool`): admitted on the page's session, a row that declares records
/// issued from that session as its live cause (`run_cause::CauseIssuer`), its task's origin the page's own.
type PageCurrent = Arc<dyn Fn() -> bool + Send + Sync>;
struct PageRecovery {
    admission: PageCurrent,
    receipt: PageCurrent,
}
struct NoRecoveryValues;
impl crate::tool_runs::tools::Held for NoRecoveryValues {
    fn plain(&self, _: &str) -> Result<zeroize::Zeroizing<String>, crate::tool_runs::tools::Failure> {
        Err(crate::cause!(crate::tool_runs::tools::Failure::Credential))
    }
}

/// Retain the page's party as the run's cause, with the page's browser session still admitted; reconstruct only its
/// read-only query at disclosure.
#[cfg(not(host = "module"))]
fn page_recovery(
    workshop: &'static crate::tool_runs::tools::Workshop,
    owner: Arc<Mutex<SelectedAccount>>,
    context: DomainContext,
    account: String,
    state_root: std::path::PathBuf,
    route: Option<Route>,
    proof: crate::tool_runs::tools::RecoveryReceipt,
) -> PageRecovery {
    use crate::{account_rights::{run_capability::Issuer, run_cause::CauseIssuer},
        tool_runs::tools::{Held, Place}};
    let keeper = proof.read_only_held();
    let primary = proof.clone();
    let admission = Arc::new(move || {
        if context.permit.cancelled() { return false; }
        {
            let Ok(mut selected) = crate::workspace_session::owner_wait::acquire(&owner, || context.permit.cancelled()) else { return false; };
            let Ok(browser) = account::current_browser_read_only(&mut *selected, &context.session.session_id) else { return false; };
            let actual = selected.tool_place();
            if same_admission(&browser, &context.session).is_err() || actual.0 != account || actual.1 != state_root { return false; }
        }
        let cause = page_cause(&context);
        let grant = route.as_ref().map(|route| CauseIssuer { account: &account, sign_in: &cause, cause: None, route, root: None });
        let parent = grant.as_ref().map(|grant| grant as &dyn Issuer);
        let issuer = crate::tool_runs::tools::task_context::ContextIssuer {
            parent, context: page_task_context(&context, &account),
        };
        let place = Place { account: &account, state_root: &state_root, door: Some(&issuer), origin: Some(workshop.page_origin()) };
        let held: &dyn Held = keeper.as_deref().map_or(&NoRecoveryValues as &dyn Held, |keeper| keeper as &dyn Held);
        proof.recheck_kind(workshop, &place, held, &context.permit.cancellation_flag(), None)
    });
    PageRecovery { admission, receipt: Arc::new(move || primary.current()) }
}
fn guarded_page_answer(answer: DomainAnswer, guards: Vec<PageRecovery>) -> Result<DomainAnswer, WorkspaceError> {
    if guards.is_empty() { return Ok(answer); }
    let mut response = crate::workspace_domain::response(answer)?;
    for guard in guards { crate::workspace::retain_response_custody(&mut response, guard.admission, guard.receipt); }
    Ok(DomainAnswer::Response(response))
}
struct PageRuns<'a> {
    owner: &'a Arc<Mutex<SelectedAccount>>,
    admission: Arc<Mutex<SelectedAccount>>,
    context: &'a DomainContext,
    route: Option<Route>,
    account: String,
    state_root: std::path::PathBuf,
    recovery: std::cell::RefCell<Vec<PageRecovery>>,
}

/// The cause name of a page request's run: the party the page is signed in as, this account's own
/// (`party:<account address>`, `SignIn::party_of`), read from the account's open routes. Empty when the account has
/// no open routes, which stands nowhere, so the run gets nothing.
fn page_cause(context: &DomainContext) -> String {
    crate::account::account_routes::opened_for(&context.session.account_id)
        .map(|sign_in| format!("{}{}", crate::account::account_routes::PARTY_SIGN_IN, sign_in.address()))
        .unwrap_or_default()
}

/// The page's task facts, from its live cause: the page's party, asked of the account's routes by its name
/// (`SignIn::standing`) without the account owner, so a run asking while the owner is held never waits on itself. A
/// party that no longer stands, an account that changed or a cancelled request makes the same evidence unusable by a
/// nested run; no page input supplies identity.
fn page_task_context(context: &DomainContext, account: &str) -> crate::tool_runs::tools::task_context::Context {
    let cause = page_cause(context);
    let (person, permit) = (context.session.account_id.clone(), context.permit.clone());
    let stands = {
        let (cause, person, permit) = (cause.clone(), person.clone(), permit.clone());
        move || !permit.cancelled() && crate::account::account_routes::cause_stands(&person, &cause)
    };
    let recovery = Arc::new(move || {
        use crate::account_rights::run_capability::Refusal;
        if permit.cancelled() { return Err(crate::cause!(Refusal::NotGranted)); }
        let sign_in = crate::account::account_routes::opened_for(&person).ok_or(crate::cause!(Refusal::NotGranted))?;
        let source = sign_in.recovery_source_for_standing(&cause).map_err(|error| crate::carry_cause!(Refusal::NotGranted, error))?;
        if permit.cancelled() { return Err(crate::cause!(Refusal::NotGranted)); }
        Ok(source)
    });
    crate::tool_runs::tools::task_context::Context::account_at(account, Arc::new(stands)).with_recovery_source(recovery)
}
impl PageRuns<'_> {
    /// The selected account, held, with the page's session admitted on it again.
    fn admitted(
        &self,
    ) -> Result<crate::workspace_session::owner_wait::Held<'_, SelectedAccount>, WorkspaceError>
    {
        let mut selected = crate::workspace_session::owner_wait::acquire(self.owner, || {
            self.context.permit.cancelled()
        })
        .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
        same_admission(
            &account::current_browser_read_only(&mut *selected, &self.context.session.session_id)
                .map_err(account_error)?,
            &self.context.session,
        )?;
        Ok(selected)
    }
    /// One run of `tool` under `request_key` with `input`: its answer (src/tool_runs/tools.rs `Ran::answer`), or the
    /// tools' refusal.
    fn run(
        &self,
        tool: &str,
        request_key: &str,
        input: &Value,
    ) -> Result<Result<Value, crate::tool_runs::tools::Failure>, WorkspaceError> {
        use crate::{
            account_rights::{run_capability::Issuer, run_cause::CauseIssuer},
            tool_runs::tools::{shipped, HomeVault, Place},
        };
        let workshop = shipped().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        if workshop.engine_row(tool) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let cause = page_cause(self.context);
        let grant = self.route.as_ref().map(|route| CauseIssuer { account: &self.account, sign_in: &cause, cause: None, route, root: None });
        let parent = grant.as_ref().map(|issuer| issuer as &dyn Issuer);
        let issuer = crate::tool_runs::tools::task_context::ContextIssuer {
            parent,
            context: page_task_context(self.context, &self.account),
        };
        let place = Place {
            account: &self.account,
            state_root: &self.state_root,
            door: Some(&issuer),
            origin: Some(workshop.page_origin()),
        };
        let (ran, proof) = crate::tool_runs::tools::with_recovery_receipt(|| workshop.run_answer(
            request_key,
            tool,
            input,
            &Value::Null,
            &place,
            &HomeVault { place: &place },
            &self.context.permit.cancellation_flag(),
            &|| Ok(()),
        )).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        drop(self.admitted()?);
        if let Some(proof) = proof {
            #[cfg(not(host = "module"))]
            self.recovery.borrow_mut().push(page_recovery(workshop, self.admission.clone(), self.context.clone(),
                self.account.clone(), self.state_root.clone(), self.route.clone(), proof));
            #[cfg(host = "module")]
            return Err(crate::cause!(WorkspaceError::Unavailable));
        }
        Ok(ran)
    }
}
/// Answer one page request by Workshop tool runs (`work` over `PageRuns`): the page's session is admitted on the
/// selected account before and after, and the runs go with no account owner held, as `call_tool` runs one.
fn page_tool_runs(
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    context: DomainContext,
    route: Option<Route>,
    work: impl FnOnce(&PageRuns<'_>) -> Result<DomainAnswer, WorkspaceError> + Send + 'static,
) -> SupplyFuture<DomainAnswer> {
    Box::pin(async move {
        sessions.authorize_read_only(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
        let retained = context.clone();
        let task_admission = sessions.admission();
        let result = crate::storage::request_work::spawn_blocking(move || {
            let mut runs = PageRuns {
                owner: &owner,
                admission: task_admission,
                context: &retained,
                route,
                account: String::new(),
                state_root: std::path::PathBuf::new(),
                recovery: std::cell::RefCell::new(Vec::new()),
            };
            let (account, state_root) = runs.admitted()?.tool_place();
            (runs.account, runs.state_root) = (account, state_root);
            let answer = work(&runs)?;
            guarded_page_answer(answer, runs.recovery.into_inner())
        })
        .await;
        cancellation.0.take();
        let answer = result.map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        sessions.authorize_read_only(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        Ok(answer)
    })
}
/// One screen of the generic screen host (old trillion src/screen-host.mjs handleScreenHost, `/screens/<id>`): the
/// account's Workshop row whose id is the screen's tool id. A `reads` screen runs each of its reads as that tool's run
/// (under the request's key and the read's place, one run per read) and is drawn from what they answered
/// (`page_routes::describe`); any other screen answers its row of the screen catalogue (the same rows GET /screens
/// pages through), as {surface}; a screen in neither answers 404.
fn screen(
    runs: &PageRuns<'_>,
    ask: Option<crate::tool_runs::page_routes::ScreenAsk>,
    mount: Option<Arc<tool_screens::Mount>>,
    request_key: &str,
) -> Result<DomainAnswer, WorkspaceError> {
    use crate::tool_runs::page_routes;
    let settings = page_routes::settings()?;
    let Some(mut ask) = ask else {
        return page_answer(page_routes::not_found(settings));
    };
    // The page's admitted account, which each read's input may bind (Round 2 contract B).
    ask.account_id = runs.account.clone();
    let workshop = crate::tool_runs::tools::shipped().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    let rows = workshop
        .installed_rows(&runs.state_root)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    let row = rows.as_ref().and_then(|rows| {
        rows.iter()
            .find(|row| row["id"] == ask.tool_id.as_str())
            .cloned()
    });
    if let Some(screen) = row
        .as_ref()
        .and_then(|row| page_routes::reads_screen(settings, row))
    {
        let mut index = 0usize;
        let mut refused = None;
        let mut read = |tool: &str, input: &Value| -> Result<Value, crate::refusal_cause::CodedError<String>> {
            index += 1;
            match runs.run(tool, &format!("{request_key}-{index}"), input) {
                Ok(Ok(answer)) => page_routes::run_result(settings, &answer),
                Ok(Err(failure)) => Err(crate::refusal_cause::CodedError::with_cause(failure.code().to_owned(), failure.cause())),
                Err(error) => {
                    let cause = error.cause();
                    refused = Some(error);
                    Err(crate::refusal_cause::CodedError::with_cause(String::new(), cause))
                }
            }
        };
        let answer = page_routes::describe(settings, screen, &ask, &mut read);
        if let Some(error) = refused {
            return Err(error);
        }
        return page_answer(answer);
    }
    // Any other screen is its row of the screen catalogue, found by its id a page at a time.
    let mount = mount.ok_or(crate::cause!(WorkspaceError::Unavailable))?;
    let mut after = String::new();
    for _ in 0..settings.most_catalogue_pages {
        let page = {
            let mut held = runs.admitted()?;
            tool_screens::read(
                &mut held,
                &runs.context.session.session_id,
                after,
                &mount,
                runs.context.permit.cancellation_flag(),
            )?
        };
        let DomainAnswer::Http { body, .. } = tool_screens::answer(page)? else {
            return Err(crate::cause!(WorkspaceError::Integrity));
        };
        let page: Value = serde_json::from_slice(&body).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let surfaces = page
            .get("surfaces")
            .and_then(Value::as_array)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if let Some(surface) = surfaces.iter().find(|surface| {
            surface.get(&settings.surface_id).and_then(Value::as_str) == Some(ask.tool_id.as_str())
        }) {
            return page_answer(page_routes::surface_answer(settings, Some(surface.clone())));
        }
        match page.get("next").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => after = next.to_owned(),
            _ => break,
        }
    }
    page_answer(page_routes::surface_answer(settings, None))
}
/// A page route's answer as the page reads it: its status, and its body as JSON (`http`).
fn page_answer(
    answer: crate::tool_runs::page_routes::Answer,
) -> Result<DomainAnswer, WorkspaceError> {
    let status = StatusCode::from_u16(answer.status).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    let DomainAnswer::Http { headers, body, .. } =
        http(serde_json::to_vec(&answer.body).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?)
    else {
        return Err(crate::cause!(WorkspaceError::Integrity));
    };
    Ok(DomainAnswer::Http {
        status,
        headers,
        body,
    })
}
/// One page call of the person's files (`ReadInput::FilesCall`): the page's session is checked on the selected
/// account before and after, and the call runs with no account owner held through `FilesOwner::call_while`, the
/// same call an AI's key makes (the same operations, inputs, bytes let in and answers), stopping at
/// the request's cancellation or the read's elapsed bound. A refusal answers the files' own code.
fn call_files(
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    context: DomainContext,
    operation: String,
    input: Value,
) -> SupplyFuture<DomainAnswer> {
    Box::pin(async move {
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
        let retained = context.clone();
        let result = crate::storage::request_work::spawn_blocking(move || {
            let files = FilesOwner::shipped().ok_or(crate::cause!(WorkspaceError::Unavailable))?;
            let admitted = || -> Result<(String, std::path::PathBuf), WorkspaceError> {
                let mut selected = crate::workspace_session::owner_wait::acquire(&owner, || {
                    retained.permit.cancelled()
                })
                .map_err(|error| crate::carry_cause!(WorkspaceError::Conflict, error))?;
                same_admission(
                    &account::current_browser_read_only(&mut *selected, &retained.session.session_id)
                        .map_err(account_error)?,
                    &retained.session,
                )?;
                Ok(selected.tool_place())
            };
            let (account, state_root) = admitted()?;
            let deadline = std::time::Instant::now() + workspace_store::Limits::default().elapsed;
            let cancelled = retained.permit.cancellation_flag();
            let current: Arc<dyn Fn() -> bool + Send + Sync> =
                Arc::new(move || !cancelled.load(std::sync::atomic::Ordering::Acquire));
            let answer =
                files.call_while(&state_root, &account, &operation, &input, deadline, current);
            // The session is checked again before the answer leaves; a refusal here after a write leaves its outcome
            // as the files' own unknown-effect answer would.
            admitted()?;
            match answer {
                Ok(body) => Ok(DomainAnswer::Json {
                    body,
                    next_before: None,
                    collection_coverage: None,
                }),
                Err(failure) => files_refusal(failure),
            }
        })
        .await;
        cancellation.0.take();
        let answer = result.map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        sessions.authorize(context.clone()).await?;
        if context.permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        Ok(answer)
    })
}
/// A refusal of the person's files as the page reads it: its own code as `failure_code` and `error`, whether the call
/// may have had an effect, and the refusal's detail, under the status its kind takes.
fn files_refusal(failure: FilesFailure) -> Result<DomainAnswer, WorkspaceError> {
    use crate::account_files::AccountFilesError;
    let (code, unknown) = failure.code();
    let status = match &failure {
        FilesFailure::AccountFiles(AccountFilesError::NotFound(_), _) => StatusCode::NOT_FOUND,
        FilesFailure::AccountFiles(AccountFilesError::Invalid(_, _), _) => StatusCode::BAD_REQUEST,
        FilesFailure::NotBound { .. } => StatusCode::CONFLICT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    let body = serde_json::json!({"error": code, "failure_code": code, "outcome_unknown": unknown, "detail": failure.detail(), "cause": failure.cause().id()});
    let DomainAnswer::Http { headers, body, .. } =
        http(serde_json::to_vec(&body).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?)
    else {
        return Err(crate::cause!(WorkspaceError::Integrity));
    };
    Ok(DomainAnswer::Http {
        status,
        headers,
        body,
    })
}
/// A tools refusal as the page reads it: the tools' own code as `failure_code` (and as the words, which the
/// page's own words owner turns into a sentence), under the status its kind takes.
fn tool_refusal(failure: crate::tool_runs::tools::Failure) -> Result<DomainAnswer, WorkspaceError> {
    use crate::tool_runs::tools::Failure;
    crate::quiet_eprintln!("door-refusal code={} cause={}", failure.code(), failure.cause());
    let status = match failure {
        Failure::Invalid(_) | Failure::UnknownTool(_) | Failure::NotRunnableHere(_) | Failure::KeyReused(_) => {
            StatusCode::BAD_REQUEST
        }
        Failure::NotGranted(_) | Failure::Credential(_) => StatusCode::FORBIDDEN,
        Failure::Busy(_) => StatusCode::CONFLICT,
        // An erased run is gone, as old trillion src/tool-run-owner.mjs:82 answered it.
        Failure::Erased(_) => StatusCode::GONE,
        Failure::OutcomeUnknown(_) => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    let mut body = serde_json::json!({"error": failure.code(), "failure_code": failure.code(), "cause": failure.cause().id()});
    if let Some(words) = failure.detail() {
        body["detail"] = serde_json::Value::String(words);
    }
    // The same JSON answer every read here gives (`http`), under the refusal's own status.
    let DomainAnswer::Http { headers, body, .. } =
        http(serde_json::to_vec(&body).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?)
    else {
        return Err(crate::cause!(WorkspaceError::Integrity));
    };
    Ok(DomainAnswer::Http {
        status,
        headers,
        body,
    })
}
fn command_input(command: &DomainCommand) -> Result<ReadInput, WorkspaceError> {
    if !valid_key(&command.request_key) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    read_input(&command.operation, &command.input)
}
fn same_admission(
    current: &BrowserAdmission,
    session: &WorkspaceSession,
) -> Result<(), WorkspaceError> {
    if current.account.user_id != session.account_id {
        return Err(crate::cause!(WorkspaceError::Conflict));
    }
    Ok(())
}
pub(crate) fn answer(snapshot: Snapshot) -> Result<DomainAnswer, WorkspaceError> {
    Ok(http(body(snapshot.records, snapshot.next.as_deref())?))
}
/// One page of a read whose answer must fit: the whole snapshot when `fits` admits its answer, else the most of its
/// records (in the read's order) whose answer `fits` admits, its `next` the last one's label. A first record that does
/// not fit alone refuses (`TooLarge`).
pub(crate) fn fitting_answer(
    snapshot: Snapshot,
    fits: impl Fn(&DomainAnswer) -> bool,
) -> Result<DomainAnswer, WorkspaceError> {
    let records = snapshot.records;
    let page =
        |shown: usize, next: Option<&str>| body(records[..shown].iter().cloned(), next).map(http);
    let whole = page(records.len(), snapshot.next.as_deref())?;
    if fits(&whole) {
        return Ok(whole);
    }
    // The most records that fit: `low` fits (or is none yet), `high` does not.
    let (mut low, mut high) = (0, records.len());
    let mut shown = None;
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        let candidate = page(middle, Some(&records[middle - 1].0))?;
        if fits(&candidate) {
            (low, shown) = (middle, Some(candidate));
        } else {
            high = middle;
        }
    }
    shown.ok_or(crate::cause!(WorkspaceError::TooLarge))
}
/// The read's body: `{"records": {label: value}}`, and `next` when a page has one.
fn body(
    snapshot_records: impl IntoIterator<Item = (String, EcmaValue)>,
    next: Option<&str>,
) -> Result<Vec<u8>, WorkspaceError> {
    let mut records = Object::new();
    for (label, value) in snapshot_records {
        if records.insert(JsString::from(label), value).is_some() {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
    }
    // Serialize each original value with the existing codec before adding the
    // envelope. This preserves its full admitted depth rather than spending
    // two of the codec's original depth levels on transport wrapper objects.
    let limits = ecma_json::Limits {
        input_bytes: workspace_store::MAX_READ_BYTES,
        output_bytes: workspace_store::MAX_EXPANDED_BYTES,
        depth: ecma_json::HARD_DEPTH,
        nodes: ecma_json::HARD_NODES,
        string_units: workspace_store::MAX_READ_BYTES,
        total_string_units: workspace_store::MAX_EXPANDED_BYTES,
        container_entries: ecma_json::HARD_NODES,
        number_bytes: ecma_json::HARD_NUMBER_BYTES,
    };
    let mut body = zeroize::Zeroizing::new(Vec::new());
    let mut append = |piece: &[u8]| -> Result<(), WorkspaceError> {
        if body
            .len()
            .checked_add(piece.len())
            .is_none_or(|n| n > workspace_store::MAX_EXPANDED_BYTES + 64)
        {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        body.extend_from_slice(piece);
        Ok(())
    };
    append(b"{\"records\":{")?;
    for (index, (key, value)) in records.property_entries().into_iter().enumerate() {
        if index != 0 {
            append(b",")?;
        }
        let key = ecma_json::stringify(&EcmaValue::String(key.clone()), limits)
            .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
        append(key.as_bytes())?;
        append(b":")?;
        let value = ecma_json::stringify(value, limits).map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
        append(value.as_bytes())?;
    }
    append(b"}")?;
    if let Some(next) = next {
        append(b",\"next\":")?;
        let next =
            ecma_json::stringify(&EcmaValue::String(JsString::from(next.to_owned())), limits)
                .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
        append(next.as_bytes())?;
    }
    append(b"}")?;
    Ok(std::mem::take(&mut *body))
}
fn http(body: Vec<u8>) -> DomainAnswer {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    DomainAnswer::Http {
        status: StatusCode::OK,
        headers,
        body,
    }
}

/// Cancelling a caller while the blocking read is queued/running signals the
/// original permit; the physical reader already consumes that exact flag.
struct CancelReadOnDrop(Option<crate::workspace::WorkspacePermit>);
impl Drop for CancelReadOnDrop {
    fn drop(&mut self) {
        if let Some(permit) = &self.0 {
            permit.cancel();
        }
    }
}
impl CanonicalWorkspaceExecutor for LocalWorkspace {
    fn authorize(&self, context: DomainContext) -> SupplyFuture<BrowserScope> {
        self.sessions.authorize(context)
    }
    fn request_key(
        &self,
        context: DomainContext,
        operation: String,
        input: Value,
    ) -> SupplyFuture<String> {
        Box::pin(async move {
            let read = read_input(&operation, &input)?;
            if matches!(read, ReadInput::ConnectionManagement) {
                // Management requires the original carried retry identity.
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
            // A random request key carries no account authority or private
            // data. Admission already ran in CanonicalWorkspace; actual read
            // execution still rechecks the current selected account. Repeating
            // policy SQL solely to generate random bytes adds no protection.
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            let mut nonce = [0_u8; 16];
            SystemRandom::new()
                .fill(&mut nonce)
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            let mut key = String::from(match read {
                ReadInput::ConnectionManagement => return Err(crate::cause!(WorkspaceError::Invalid)),
                ReadInput::WorkspaceWrite => "workspace-write:",
                ReadInput::Records(_) => "workspace-read:",
                ReadInput::Viewer => "viewer-read:",
                ReadInput::DoorRead(..) => "page-records-read-",
                ReadInput::ToolCall(..) => "page-tool-call-",
                ReadInput::FilesCall(..) => "page-files-call-",
                ReadInput::ToolScreens(_) => "tool-screens-read:",
                ReadInput::Screen(_) => "page-screen-read-",
                ReadInput::WorkshopRoute(..) => "page-workshop-route-",
                ReadInput::ShowRules => "show-rules-read:",
            });
            for byte in nonce {
                use std::fmt::Write;
                write!(&mut key, "{byte:02x}").map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            }
            Ok(key)
        })
    }
    fn select_resource(
        &self,
        context: DomainContext,
        command: DomainCommand,
    ) -> SupplyFuture<String> {
        Box::pin(async move {
            command_input(&command)?;
            // Every admitted read here has the same public resource address.
            // Returning this constant grants nothing: execute performs fresh
            // account/source authorization before reading and before return.
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            Ok(RESOURCE.to_owned())
        })
    }
    fn execute(
        &self,
        context: DomainContext,
        resource: String,
        command: DomainCommand,
    ) -> SupplyFuture<DomainAnswer> {
        let selected = match command_input(&command) {
            Ok(selected) => selected,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        // Records retain their SAME read source until the first body chunk.
        // Their fresh final authorization runs there, after any queue wait.
        let selected = match selected {
            ReadInput::ConnectionManagement => {
                if resource != RESOURCE {
                    return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
                }
                return self.change_connection(context, command);
            }
            ReadInput::WorkspaceWrite => {
                if resource != RESOURCE {
                    return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
                }
                return self.write_workspace(context, command);
            }
            ReadInput::Records(selection) => {
                if resource != RESOURCE {
                    return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
                }
                return self.read_records(context, selection);
            }
            other => other,
        };
        if let ReadInput::DoorRead(operation, input) = selected {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            return read_door(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                operation,
                input,
            );
        }
        if let ReadInput::FilesCall(operation, input) = selected {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            return call_files(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                operation,
                input,
            );
        }
        if let ReadInput::ToolCall(method, input) = selected {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            return call_tool(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                self.route.clone(),
                (method, input),
                command,
            );
        }
        if let ReadInput::Screen(ask) = selected {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            let mount = self.tool_screens.clone();
            return page_tool_runs(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                self.route.clone(),
                move |runs| screen(runs, ask, mount, &command.request_key),
            );
        }
        if let ReadInput::WorkshopRoute(tool, request) = selected {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            return page_tool_runs(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                self.route.clone(),
                move |runs| {
                    let settings = crate::tool_runs::page_routes::settings()?;
                    // The page's admitted account reaches the route tool (Round 2 contract B).
                    let request = crate::tool_runs::page_routes::with_account(
                        settings,
                        request,
                        &runs.account,
                    );
                    let answer = match runs.run(&tool, &command.request_key, &request)? {
                        Ok(answer) => crate::tool_runs::page_routes::run_result(settings, &answer),
                        Err(failure) => return tool_refusal(failure),
                    };
                    crate::server::tool_http_response::answer(answer, |answer, invalid_cause| {
                        page_answer(crate::tool_runs::page_routes::route_answer(settings, answer, invalid_cause))
                    })
                },
            );
        }
        if matches!(&selected, ReadInput::ShowRules) {
            if resource != RESOURCE {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Forbidden)) });
            }
            let Some(mount) = self.show_rules.clone() else {
                return Box::pin(async { Err(crate::cause!(WorkspaceError::Unavailable)) });
            };
            return show_rules::read_show_rules(
                self.owner.clone(),
                self.sessions.clone(),
                context,
                mount,
            );
        }
        let owner = self.owner.clone();
        let sessions = self.sessions.clone();
        let tool_screens = self.tool_screens.clone();
        Box::pin(async move {
            if resource != RESOURCE {
                return Err(crate::cause!(WorkspaceError::Forbidden));
            }
            sessions.authorize(context.clone()).await?;
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            let retained = context.clone();
            let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
            let result = crate::storage::request_work::spawn_blocking(move || {
                // The original request permit is held throughout the selected
                // read and response construction. Its flag interrupts reads;
                // no fresh request/key or detached authority is created.
                if retained.permit.cancelled() {
                    return Err(crate::cause!(WorkspaceError::Conflict));
                }
                enum ReadAnswer {
                    Viewer(Value),
                    ToolScreens(crate::workspace_tool_screens::ToolScreenPage),
                }
                let read = {
                    let mut owner = crate::workspace_session::owner_wait::acquire(&owner, || {
                        retained.permit.cancelled()
                    })
                    .map_err(|error| match error {
                        crate::workspace_session::owner_wait::Error::Cancelled(cause) => WorkspaceError::Conflict(cause),
                        crate::workspace_session::owner_wait::Error::Unavailable(cause) => WorkspaceError::Unavailable(cause),
                    })?;
                    same_admission(
                        &account::current_browser_read_only(&mut *owner, &retained.session.session_id)
                            .map_err(account_error)?,
                        &retained.session,
                    )?;
                    let read = match selected {
                        ReadInput::ConnectionManagement
                        | ReadInput::WorkspaceWrite
                        | ReadInput::Records(_) => {
                            return Err(crate::cause!(WorkspaceError::Integrity));
                        }
                        ReadInput::Viewer => {
                            let programs = owner.viewer_program_data().map_err(account_error)?;
                            let mut body = workspace_startup::viewer(
                                &mut *owner,
                                &programs,
                                &retained.session.session_id,
                                retained.permit.cancellation_flag().as_ref(),
                            )
                            .map_err(account_error)?;
                            // The original HTTP route adds session.userId to
                            // the audience it reads. Use only this already
                            // admitted same-owner identity, never request data.
                            let fields = body.as_object_mut().ok_or(crate::cause!(WorkspaceError::Integrity))?;
                            let user_id = Value::String(retained.session.account_id.clone());
                            if fields.get("user_id").is_some_and(|value| value != &user_id) {
                                return Err(crate::cause!(WorkspaceError::Integrity));
                            }
                            fields.insert("user_id".into(), user_id);
                            ReadAnswer::Viewer(body)
                        }
                        ReadInput::ToolScreens(after) => {
                            let mount = tool_screens.as_ref().ok_or(crate::cause!(WorkspaceError::Unavailable))?;
                            ReadAnswer::ToolScreens(tool_screens::read(
                                &mut owner,
                                &retained.session.session_id,
                                after,
                                mount,
                                retained.permit.cancellation_flag(),
                            )?)
                        }
                        ReadInput::DoorRead(..)
                        | ReadInput::ToolCall(..)
                        | ReadInput::FilesCall(..)
                        | ReadInput::Screen(_)
                        | ReadInput::WorkshopRoute(..) => return Err(crate::cause!(WorkspaceError::Integrity)),
                        ReadInput::ShowRules => return Err(crate::cause!(WorkspaceError::Unavailable)),
                    };
                    same_admission(
                        &account::current_browser_read_only(&mut *owner, &retained.session.session_id)
                            .map_err(account_error)?,
                        &retained.session,
                    )?;
                    read
                };
                let result = match read {
                    ReadAnswer::ToolScreens(page) => tool_screens::answer(page)?,
                    ReadAnswer::Viewer(body) => DomainAnswer::Json {
                        body,
                        next_before: None,
                        collection_coverage: None,
                    },
                };
                if retained.permit.cancelled() {
                    return Err(crate::cause!(WorkspaceError::Conflict));
                }
                Ok(result)
            })
            .await;
            cancellation.0.take();
            let answer = result.map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
            sessions.authorize(context.clone()).await?;
            if context.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            Ok(answer)
        })
    }
    fn heads(&self, context: DomainContext) -> SupplyFuture<DomainAnswer> {
        self.read_heads(context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every path and method a shipped route row admits reaches an owner this
    /// executor mounts. A row naming an owner that is not mounted here (the old
    /// JavaScript records resource, an edge host) fails this test, and so does
    /// a row path its owner does not serve; such requests are answered NoOwner.
    #[test]
    fn every_route_row_names_an_owner_this_executor_mounts() {
        let bytes = crate::workspace_domain::ROUTES_DATA;
        let routes = crate::workspace_domain::OwnerRoutes::from_source(
            bytes,
            content_crypto::advanced::blake3::hash(bytes)
                .to_hex()
                .as_str(),
        )
        .unwrap();
        let browser = json!({"user_agent":"fixture","origin":"http://127.0.0.1:1","visitor":""});
        let samples = routes.samples();
        assert!(!samples.is_empty());
        for sample in samples {
            let body = (sample.method != "GET").then(|| json!({}));
            let call = routes
                .resolve(
                    &sample.path,
                    &sample.method,
                    "",
                    body,
                    Some(browser.clone()),
                )
                .unwrap()
                .unwrap_or_else(|| panic!("{} {} resolves to nothing", sample.method, sample.path));
            assert!(
                !matches!(
                    read_input(&call.operation, &call.input),
                    Err(WorkspaceError::NoOwner(_))
                ),
                "{} {} names {}, which no mount here answers",
                sample.method,
                sample.path,
                call.operation
            );
        }
    }

    /// Every path and method a row of the Workshop route table (src/server/tool-routes.json) admits resolves to
    /// the Workshop routes' owner here, with its tool and the request the tool is given.
    #[test]
    fn every_workshop_route_row_names_an_owner_this_executor_mounts() {
        let routes = crate::workspace_domain::OwnerRoutes::from_product().unwrap();
        let browser = json!({"user_agent":"fixture","origin":"http://127.0.0.1:1","visitor":""});
        for sample in routes.workshop_samples().unwrap() {
            let body = (sample.method != "GET").then(|| json!({}));
            let call = routes
                .resolve(
                    &sample.path,
                    &sample.method,
                    "",
                    body,
                    Some(browser.clone()),
                )
                .unwrap()
                .unwrap_or_else(|| panic!("{} {} resolves to nothing", sample.method, sample.path));
            assert_eq!(
                call.operation,
                crate::workspace_domain::workshop_route_operation().unwrap()
            );
            assert!(
                matches!(
                    read_input(&call.operation, &call.input),
                    Ok(ReadInput::WorkshopRoute(..))
                ),
                "{} {} names {}, which no mount here answers",
                sample.method,
                sample.path,
                call.operation
            );
        }
    }

    /// A Workshop route's request carries what the shared contract names, and only that: its path after /work/api
    /// without the query, its method, its query as Object.fromEntries reads it, its body and the browser's facts.
    #[test]
    fn a_workshop_route_runs_its_tool_with_the_contracts_input() {
        let tool = format!(
            "{}answer-a-route",
            crate::tool_runs::page_routes::settings()
                .unwrap()
                .tool_prefix
        );
        let path = "/x";
        let input = json!({"tool":tool,"request":{"path":path,"method":"GET","query":{"a":"2"},"body":{},"browser":{}}});
        let operation = crate::workspace_domain::workshop_route_operation().unwrap();
        match read_input(&operation, &input) {
            Ok(ReadInput::WorkshopRoute(tool, request)) => {
                assert_eq!(tool, input["tool"]);
                assert_eq!(request, input["request"]);
            }
            _ => panic!("a Workshop route reaches its owner"),
        }
        assert!(matches!(
            read_input(&operation, &json!({"request":{}})),
            Err(WorkspaceError::Invalid(_))
        ));
    }

    /// GET /screens is the catalogue and GET /screens/<id> one screen of it, for any id under the prefix (Look, a
    /// tool id, an encoded one); any other method has no owner.
    #[test]
    fn one_screen_of_the_catalogue_is_the_screen_hosts_for_any_id() {
        let routes = crate::workspace_domain::OwnerRoutes::from_product().unwrap();
        let browser = json!({"user_agent":"fixture","origin":"http://127.0.0.1:1","visitor":""});
        let catalogue = routes
            .resolve("/screens", "GET", "after=x", None, Some(browser.clone()))
            .unwrap()
            .unwrap();
        assert!(
            matches!(read_input(&catalogue.operation, &catalogue.input), Ok(ReadInput::ToolScreens(after)) if after == "x")
        );
        let prefix = &crate::tool_runs::page_routes::settings()
            .unwrap()
            .tool_prefix;
        let encoded = prefix.replace(':', "%3A");
        for (path, tool) in [
            ("/screens/look".to_owned(), format!("{prefix}look")),
            (
                format!("/screens/{encoded}drives"),
                format!("{prefix}drives"),
            ),
            (
                format!("/screens/{prefix}get-started"),
                format!("{prefix}get-started"),
            ),
        ] {
            let path = path.as_str();
            let call = routes
                .resolve(path, "GET", "show_row=a", None, Some(browser.clone()))
                .unwrap()
                .unwrap();
            match read_input(&call.operation, &call.input) {
                Ok(ReadInput::Screen(Some(ask))) => {
                    assert_eq!(ask.tool_id, tool, "{path}");
                    assert_eq!(ask.query, vec![("show_row".to_owned(), "a".to_owned())]);
                    assert_eq!(ask.browser, browser);
                }
                _ => panic!("{path} is one screen"),
            }
        }
        let nested = routes
            .resolve("/screens/a%2Fb", "GET", "", None, Some(browser.clone()))
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                read_input(&nested.operation, &nested.input),
                Ok(ReadInput::Screen(None))
            ),
            "a nested id is 404"
        );
        assert!(routes
            .resolve("/screens/look", "POST", "", Some(json!({})), Some(browser))
            .unwrap()
            .is_none());
    }

    #[test]
    fn original_missing_and_present_empty_selection_stay_distinct() {
        assert!(selection(&json!({})).unwrap().is_none());
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!(false),
            json!(3),
            json!("ignored"),
        ] {
            let selected = selection(&json!({"selection":value})).unwrap().unwrap();
            assert!(selected.labels.is_empty() && selected.prefixes.is_empty());
        }
        let selected = selection(&json!({"selection":["one","two"]}))
            .unwrap()
            .unwrap();
        assert_eq!(selected.labels, ["one", "two"]);
        assert!(selected.prefixes.is_empty());
        let selected = selection(&json!({"selection":{"labels":["one"],"prefixes":["prefix:"],"unused":true},"unused":true})).unwrap().unwrap();
        assert_eq!(selected.labels, ["one"]);
        assert_eq!(selected.prefixes, ["prefix:"]);
        let selected = selection(&json!({"selection":{"labels":null,"prefixes":null}}))
            .unwrap()
            .unwrap();
        assert!(selected.labels.is_empty() && selected.prefixes.is_empty());
    }

    #[test]
    fn selection_bounds_count_before_dedup_and_use_utf16_units() {
        assert!(selection(&json!({"selection":vec!["same";64]})).is_ok());
        assert!(selection(&json!({"selection":vec!["same";65]})).is_err());
        assert!(selection(
            &json!({"selection":{"labels":vec!["same";32],"prefixes":vec!["same";33]}})
        )
        .is_err());
        assert!(selection(&json!({"selection":["😀".repeat(150)]})).is_ok());
        assert!(selection(&json!({"selection":["😀".repeat(151)]})).is_err());
        for value in [
            json!([""]),
            json!([null]),
            json!({"labels":"one"}),
            json!({"prefixes":3}),
        ] {
            assert!(selection(&json!({"selection":value})).is_err());
        }
    }

    fn words(label: &str) -> (String, EcmaValue) {
        (
            label.into(),
            EcmaValue::String(JsString::from("w".repeat(100))),
        )
    }
    fn body_len(answer: &DomainAnswer) -> usize {
        let DomainAnswer::Http { body, .. } = answer else {
            panic!("exact HTTP bytes required")
        };
        body.len()
    }
    fn page_of(labels: &[&str], next: Option<&str>) -> Snapshot {
        Snapshot {
            records: labels.iter().map(|label| words(label)).collect(),
            input_bytes: 0,
            expanded_bytes: 0,
            next: next.map(str::to_owned),
            work: Default::default(),
        }
    }

    #[test]
    fn a_page_that_does_not_fit_is_cut_to_the_records_that_do_and_names_the_last_one_shown() {
        let labels = ["a", "b", "c", "d", "e"];
        let whole = body_len(&answer(page_of(&labels, None)).unwrap());
        // What fits whole is answered whole, with the read's own `next`.
        let kept = fitting_answer(page_of(&labels, Some("e")), |answer| {
            body_len(answer) <= whole + 20
        })
        .unwrap();
        assert!(String::from_utf8_lossy(match &kept {
            DomainAnswer::Http { body, .. } => body,
            _ => panic!(),
        })
        .ends_with(r#","next":"e"}"#));
        // Cut: at most three records of 100 bytes fit; `next` is the last label shown.
        let cut = fitting_answer(page_of(&labels, None), |answer| body_len(answer) <= 360).unwrap();
        let DomainAnswer::Http { body, .. } = &cut else {
            panic!("exact HTTP bytes required")
        };
        let text = std::str::from_utf8(body).unwrap();
        assert!(
            text.len() <= 360 && text.contains(r#""c":"#) && !text.contains(r#""d":"#),
            "{text}"
        );
        assert!(text.ends_with(r#","next":"c"}"#), "{text}");
        // One record that does not fit alone refuses.
        assert!(matches!(
            fitting_answer(page_of(&labels, None), |answer| body_len(answer) <= 60),
            Err(WorkspaceError::TooLarge(_))
        ));
    }

    #[test]
    fn a_tool_read_continues_after_a_label_and_refuses_one_that_is_not_text() {
        assert_eq!(tool_page(&json!({})).unwrap().after, None);
        assert_eq!(
            tool_page(&json!({"after": "r02"}))
                .unwrap()
                .after
                .as_deref(),
            Some("r02")
        );
        assert_eq!(
            tool_page(&json!({})).unwrap().bytes,
            crate::mcp::MAX_MESSAGE_BYTES / 2
        );
        for bad in [
            json!({"after": ""}),
            json!({"after": 3}),
            json!({"after": ["r"]}),
        ] {
            assert!(tool_page(&bad).is_err());
        }
    }

    /// One record whose answer is `size` bytes of text, as a one-record snapshot.
    fn one_big_record(size: usize) -> Snapshot {
        Snapshot {
            records: vec![(
                "big".into(),
                EcmaValue::String(JsString::from("w".repeat(size))),
            )],
            input_bytes: 0,
            expanded_bytes: 0,
            next: None,
            work: Default::default(),
        }
    }
    /// The bytes of a page answer: its `byte_page` object, parsed.
    fn page_of_answer(answer: &DomainAnswer) -> Value {
        let DomainAnswer::Http { body, .. } = answer else {
            panic!("exact HTTP bytes required")
        };
        serde_json::from_slice::<Value>(body).unwrap()["byte_page"].clone()
    }

    #[test]
    fn a_record_that_fits_one_answer_is_answered_whole_not_as_bytes() {
        let whole = tool_answer_in_bytes(page_of(&["a"], None), "key-1", None).unwrap();
        let DomainAnswer::Http { body, .. } = &whole else {
            panic!("exact HTTP bytes required")
        };
        let parsed: Value = serde_json::from_slice(body).unwrap();
        assert!(parsed.get("byte_page").is_none(), "{parsed}");
        assert!(parsed["records"]["a"].is_string());
    }

    #[test]
    fn a_record_too_big_for_one_answer_comes_as_byte_pages_that_assemble_and_verify() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let size = 100_000;
        let expected = body(
            [(
                "big".to_string(),
                EcmaValue::String(JsString::from("w".repeat(size))),
            )],
            None,
        )
        .unwrap();
        let fits = tool_fits("key-1");
        let (mut joined, mut after, mut pages) = (Vec::new(), None::<u64>, 0);
        loop {
            // Every call names the same request key; only `after_byte` moves.
            let answer = tool_answer_in_bytes(one_big_record(size), "key-1", after).unwrap();
            assert!(fits(&answer), "page {pages} fits one MCP answer");
            let page = page_of_answer(&answer);
            assert_eq!(page["total"].as_u64(), Some(expected.len() as u64));
            assert_eq!(
                page["offset"].as_u64(),
                Some(joined.len() as u64),
                "pages follow each other"
            );
            assert_eq!(
                page["blake3"].as_str(),
                Some(
                    content_crypto::advanced::blake3::hash(&expected)
                        .to_hex()
                        .as_str()
                ),
                "every page names the hash of the whole"
            );
            let piece = STANDARD.decode(page["base64"].as_str().unwrap()).unwrap();
            assert_eq!(piece.len() as u64, page["length"].as_u64().unwrap());
            joined.extend(piece);
            pages += 1;
            match page["next_after_byte"].as_u64() {
                Some(next) => after = Some(next),
                None => {
                    assert!(page["next_after_byte"].is_null());
                    break;
                }
            }
            assert!(pages < 100, "the pages end");
        }
        assert!(pages >= 4, "{pages} pages");
        assert_eq!(
            joined, expected,
            "the pages assemble the whole answer exactly"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&joined).unwrap()["records"]["big"]
                .as_str()
                .unwrap()
                .len(),
            size
        );
    }

    #[test]
    fn a_byte_page_continues_only_inside_the_answer_and_a_bad_position_refuses() {
        let size = 50_000;
        let total = body(
            [(
                "big".to_string(),
                EcmaValue::String(JsString::from("w".repeat(size))),
            )],
            None,
        )
        .unwrap()
        .len() as u64;
        // The first page holds the start; the last byte is the last page's own position.
        let last = tool_answer_in_bytes(one_big_record(size), "key-1", Some(total - 1)).unwrap();
        let page = page_of_answer(&last);
        assert_eq!(page["offset"].as_u64(), Some(total - 1));
        assert!(page["next_after_byte"].is_null());
        // At the end of the answer, or past it, there is no page.
        assert!(matches!(
            tool_answer_in_bytes(one_big_record(size), "key-1", Some(total)),
            Err(WorkspaceError::Invalid(_))
        ));
        assert!(matches!(
            tool_answer_in_bytes(one_big_record(size), "key-1", Some(total + 10)),
            Err(WorkspaceError::Invalid(_))
        ));
    }

    #[test]
    fn an_after_byte_input_is_a_whole_number_or_absent() {
        assert_eq!(tool_after_byte(&json!({})).unwrap(), None);
        assert_eq!(tool_after_byte(&json!({"after_byte": null})).unwrap(), None);
        assert_eq!(
            tool_after_byte(&json!({"after_byte": 4096})).unwrap(),
            Some(4096)
        );
        for bad in [
            json!({"after_byte": -1}),
            json!({"after_byte": 1.5}),
            json!({"after_byte": "4"}),
            json!({"after_byte": []}),
        ] {
            assert!(tool_after_byte(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn exact_encoded_response_preserves_original_values_and_property_order() {
        let source = br#"{"z":1,"2":"two","1":"one","a":"\ud800","n":1.0}"#;
        let value = ecma_json::parse(source, ecma_json::Limits::default()).unwrap();
        let snapshot = Snapshot {
            records: vec![
                ("z".into(), value),
                ("2".into(), EcmaValue::Bool(true)),
                ("1".into(), EcmaValue::Null),
            ],
            input_bytes: 0,
            expanded_bytes: 0,
            next: None,
            work: Default::default(),
        };
        let DomainAnswer::Http {
            status,
            headers,
            body,
        } = answer(snapshot).unwrap()
        else {
            panic!("exact HTTP bytes required")
        };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            r#"{"records":{"1":null,"2":true,"z":{"1":"one","2":"two","z":1,"a":"\ud800","n":1}}}"#
        );
    }

    #[test]
    fn envelope_keeps_full_admitted_value_depth_and_rejects_duplicate_labels() {
        let source = format!(
            "{}0{}",
            "[".repeat(ecma_json::HARD_DEPTH),
            "]".repeat(ecma_json::HARD_DEPTH)
        );
        let value = ecma_json::parse(
            source.as_bytes(),
            ecma_json::Limits {
                depth: ecma_json::HARD_DEPTH,
                ..Default::default()
            },
        )
        .unwrap();
        let snapshot = Snapshot {
            records: vec![("deep".into(), value)],
            input_bytes: 0,
            expanded_bytes: 0,
            next: None,
            work: Default::default(),
        };
        let DomainAnswer::Http { body, .. } = answer(snapshot).unwrap() else {
            panic!("exact HTTP bytes required")
        };
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            format!("{{\"records\":{{\"deep\":{source}}}}}")
        );
        let duplicate = Snapshot {
            records: vec![
                ("same".into(), EcmaValue::Null),
                ("same".into(), EcmaValue::Null),
            ],
            input_bytes: 0,
            expanded_bytes: 0,
            next: None,
            work: Default::default(),
        };
        assert!(matches!(answer(duplicate), Err(WorkspaceError::Integrity(_))));
    }
}
