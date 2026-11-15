// src/workspace_domain.rs
//
// Purpose: Adapt the existing canonical workspace route DATA to its actual domain capability owner.
//
// Non-Negotiable Invariants: Preserve current browser/resource authority, original request identities,
// operation inputs, native response envelopes and unknown-effect recovery. No physical storage,
// Node forwarding, fake account, fallback page or guessed domain result belongs in this adapter.
//
// Key Concepts: Original family route DATA, selected resource, supplied capability executor,
// distinct transport-only heads, exact startup read plan and original browser write guards.
//
// Security Considerations: Identity fields are not authority. The actual executor must recheck
// current sign-in, resource reach and generation at execution/commit and before result disclosure.
// Private native keys never enter this adapter's page or command values.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::workspace::{
    SupplyFuture, WorkspaceError, WorkspaceOperations, WorkspacePage, WorkspacePageResponse,
    WorkspacePermit, WorkspaceRequest, WorkspaceRequestHead, WorkspaceSession,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use content_crypto::advanced::blake3;
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
};

/// Original browser wire names belong to this product HTTP adapter. Generic
/// capabilities reuse these names without defining their own protocol copy.
pub(crate) const PAGE_STORE_HEADER: ::axum::http::header::HeaderName =
    ::axum::http::header::HeaderName::from_static("x-trillion-page-store");
pub(crate) const REQUEST_KEY_HEADER: ::axum::http::header::HeaderName =
    ::axum::http::header::HeaderName::from_static("x-trillion-request-key");

/// Original admitted browser request, retained through the actual capability work.
/// No Debug/Serialize: headers may contain private browser credentials. This DTO
/// carries identity to the supplied authority owner; constructing it grants nothing.
#[derive(Clone)]
pub struct DomainContext {
    pub session: Arc<WorkspaceSession>,
    pub head: WorkspaceRequestHead,
    pub permit: WorkspacePermit,
}

/// Current browser facts returned by the actual account owner, never route DATA.
/// The kept-store name binds old-tab writes; it is not the native bearer or a key.
pub struct BrowserScope {
    pub origin: String,
    pub page_store: String,
    pub read_only: bool,
}

/// The original native operation/input/key shape used for both resource selection
/// and execution. The adapter captures one key, executes once, and never retries
/// uncertain work by minting another identity.
#[derive(Clone)]
pub struct DomainCommand {
    pub operation: String,
    pub input: Value,
    pub request_key: String,
    pub key_carried: bool,
}

/// Native values and HTTP envelopes remain different. HTTP bodies are the exact
/// original bytes; JSON collection arrays keep continuation/coverage in headers.
pub enum DomainAnswer {
    Json {
        body: Value,
        next_before: Option<String>,
        collection_coverage: Option<Value>,
    },
    Http {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    },
    /// A current guarded body; converting it to a byte vector loses its lifetime.
    Response(Response),
}

/// Actual canonical capability owner, independent of storage or transport. The
/// implementation must retain `context.permit` for detached work, observe its
/// cancellation, preserve complete domain semantics and enforce fresh rights at
/// the real execution/commit boundary and before recovered receipts are shown.
/// Missing implementations refuse; these methods are not default-success stubs.
pub trait CanonicalWorkspaceExecutor: Send + Sync {
    fn authorize(&self, context: DomainContext) -> SupplyFuture<BrowserScope>;
    /// Capture the original request identity once when the transport has no key.
    fn request_key(
        &self,
        context: DomainContext,
        operation: String,
        input: Value,
    ) -> SupplyFuture<String>;
    fn select_resource(
        &self,
        context: DomainContext,
        command: DomainCommand,
    ) -> SupplyFuture<String>;
    fn execute(
        &self,
        context: DomainContext,
        resource: String,
        command: DomainCommand,
    ) -> SupplyFuture<DomainAnswer>;
    /// presentation:heads is a transport read, not a journaled domain command.
    fn heads(&self, context: DomainContext) -> SupplyFuture<DomainAnswer>;
}

const MAX_DATA_BYTES: usize = 1024 * 1024;
fn pinned<T: serde::de::DeserializeOwned>(bytes: &[u8], pin: &str) -> Result<T, WorkspaceError> {
    if bytes.len() > MAX_DATA_BYTES
        || pin.len() != 64
        || blake3::hash(bytes).to_hex().as_str() != pin
    {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))
}
fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}
fn local_path(value: &str) -> bool {
    bounded(value) && value.starts_with('/') && !value.contains(['?', '#'])
}
fn encode(text: &str, form: bool) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-._*".contains(&b) || (!form && b"!~'()".contains(&b)) {
            out.push(b as char);
        } else if form && b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
pub(crate) fn decode(text: &str, form: bool) -> Result<String, WorkspaceError> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let digits = bytes.get(i + 1..i + 3).ok_or(crate::cause!(WorkspaceError::Invalid))?;
            let n = std::str::from_utf8(digits)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or(crate::cause!(WorkspaceError::Invalid))?;
            out.push(n);
            i += 3;
        } else {
            out.push(if form && bytes[i] == b'+' {
                b' '
            } else {
                bytes[i]
            });
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
}
/// queryOf groups repeated values, preserving first-key order; the original
/// ownerRouteCommand then serializes array values as comma-joined form values.
fn family_query(query: &str) -> Result<String, WorkspaceError> {
    if query.len() > 64 * 1024 {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let mut rows: Vec<(String, Vec<String>)> = Vec::new();
    for pair in query.split('&').filter(|v| !v.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(k, true)?;
        let value = decode(v, true)?;
        if let Some((_, values)) = rows.iter_mut().find(|(k, _)| *k == key) {
            values.push(value);
        } else {
            rows.push((key, vec![value]));
        }
        if rows.len() > 256 {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
    }
    Ok(rows
        .into_iter()
        .map(|(k, v)| format!("{}={}", encode(&k, true), encode(&v.join(","), true)))
        .collect::<Vec<_>>()
        .join("&"))
}

#[derive(Deserialize)]
struct RouteData {
    families: Vec<Family>,
}
/// One route row. Every row names an owner this process mounts; there is no
/// placement field, because a row for an owner that runs elsewhere would only
/// resolve to an operation nothing here answers (NoOwner). The shipped rows are
/// checked against the mounted owners by
/// local_workspace::tests::every_route_row_names_an_owner_this_executor_mounts.
#[derive(Deserialize)]
struct Family {
    family: String,
    exact: Vec<String>,
    prefix: Vec<String>,
    methods: Option<Vec<String>>,
    #[serde(default)]
    browser: bool,
    /// When true, a path a `prefix` of this row admits carries the rest of the path after that prefix, as it was
    /// asked (not decoded), in its input's `rest` field (old trillion src/native-owner-routes.json `rest_field`):
    /// the generic screen host reads one screen's id from it.
    #[serde(default)]
    rest: bool,
}
/// The Workshop route table (`src/server/tool-routes.json`): each row a page route answered by running one
/// Workshop tool, as the operation `<family>:request` with input {tool, request: {path, method, query, body, browser}}.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkshopRouteData {
    #[serde(rename = "_what")]
    _what: String,
    family: String,
    rows: Vec<WorkshopRoute>,
}
/// One Workshop route: the methods and paths it admits and the tool that answers it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkshopRoute {
    methods: Vec<String>,
    #[serde(default)]
    exact: Vec<String>,
    #[serde(default)]
    prefix: Vec<String>,
    /// Paths at the site's root this route also answers, as itself under /work/api (`workshop_root_target`): an
    /// address an outside service holds from before the routes lived under /work/api.
    #[serde(default)]
    root: Vec<String>,
    tool: String,
}
/// Whether a Workshop route row's root paths are well formed: each local and outside /work (it is moved under
/// /work/api, so a /work path there would name a second address for one route).
fn valid_root_paths(row: &WorkshopRoute) -> bool {
    row.root.iter().all(|p| local_path(p) && p != "/work" && !p.starts_with("/work/"))
}
/// The address under /work/api a request at the site's root reaches when a Workshop route row names its path in `root`
/// for its method, with its query kept; `None` when no row names it.
pub fn workshop_root_target(method: &Method, uri: &axum::http::Uri) -> Result<Option<axum::http::Uri>, WorkspaceError> {
    let path = uri.path();
    let named = workshop_routes()?
        .rows
        .iter()
        .any(|row| row.root.iter().any(|p| p == path) && row.methods.iter().any(|m| m == method.as_str()));
    if !named {
        return Ok(None);
    }
    let target = uri.query().map_or_else(|| format!("/work/api{path}"), |query| format!("/work/api{path}?{query}"));
    target.parse().map(Some).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
}
/// The bytes of the Workshop route table, compiled in beside the route table.
pub const WORKSHOP_ROUTES_DATA: &[u8] = include_bytes!("server/tool-routes.json");
/// The Workshop route table, read and checked once.
fn workshop_routes() -> Result<&'static WorkshopRouteData, WorkspaceError> {
    static TABLE: std::sync::OnceLock<Option<WorkshopRouteData>> = std::sync::OnceLock::new();
    TABLE
        .get_or_init(|| {
            let data: WorkshopRouteData = serde_json::from_slice(WORKSHOP_ROUTES_DATA).ok()?;
            let valid = bounded(&data.family)
                && !data.family.contains(['/', ':'])
                && data.rows.len() <= 256
                && data.rows.iter().all(|row| {
                    !row.methods.is_empty()
                        && row
                            .methods
                            .iter()
                            .all(|m| Method::from_bytes(m.as_bytes()).is_ok())
                        && !(row.exact.is_empty() && row.prefix.is_empty())
                        && row.exact.iter().chain(&row.prefix).all(|p| local_path(p))
                        && valid_root_paths(row)
                        && bounded(&row.tool)
                });
            valid.then_some(data)
        })
        .as_ref()
        .ok_or(crate::cause!(WorkspaceError::Integrity))
}
/// The operation the Workshop route table's rows resolve to (`<family>:request`), so its owner knows its own family.
pub fn workshop_route_operation() -> Result<String, WorkspaceError> {
    Ok(format!("{}:request", workshop_routes()?.family))
}
/// The account routes' route table: one copy, the account routes' own setting
/// (`src/server/owner-routes.json`, compiled in beside the account routes' owner).
/// No launch selection names another table. This table declares family
/// wrappers, not the full handwritten compatibility API.
pub struct OwnerRoutes {
    rows: Vec<Family>,
}
/// The bytes of the one route table.
pub const ROUTES_DATA: &[u8] = include_bytes!("server/owner-routes.json");
/// One concrete request a route row admits: its path and method. Used to check
/// every row against the owners this process mounts.
pub struct RouteSample {
    pub path: String,
    pub method: String,
}
pub struct ResolvedCall {
    pub operation: String,
    pub input: Value,
}
impl OwnerRoutes {
    /// The account routes' own route table, compiled in.
    pub fn from_product() -> Result<Self, WorkspaceError> {
        let bytes = ROUTES_DATA;
        if bytes.len() > MAX_DATA_BYTES {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Self::checked(serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?)
    }
    pub fn from_source(bytes: &[u8], pin: &str) -> Result<Self, WorkspaceError> {
        Self::checked(pinned(bytes, pin)?)
    }
    fn checked(data: RouteData) -> Result<Self, WorkspaceError> {
        if data.families.is_empty() || data.families.len() > 256 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let mut names = BTreeSet::new();
        let mut paths = 0;
        for row in &data.families {
            paths += row.exact.len() + row.prefix.len();
            if !bounded(&row.family)
                || !names.insert(&row.family)
                || row.family.contains(['/', ':'])
                || !row.exact.iter().chain(&row.prefix).all(|p| local_path(p))
                || row.methods.as_ref().is_some_and(|v| {
                    v.is_empty() || !v.iter().all(|m| Method::from_bytes(m.as_bytes()).is_ok())
                })
            {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
        }
        if paths > 4096 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        // The Workshop route table's family is its own name, never one of this table's.
        if names.contains(&workshop_routes()?.family) {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(Self {
            rows: data.families,
        })
    }
    pub fn resolve(
        &self,
        path: &str,
        method: &str,
        query: &str,
        body: Option<Value>,
        browser: Option<Value>,
    ) -> Result<Option<ResolvedCall>, WorkspaceError> {
        if !local_path(path) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        // A Workshop route is matched before every row here (src/server/tool-routes.json).
        let workshop = workshop_routes()?;
        if let Some(route) = workshop.rows.iter().find(|row| {
            row.methods.iter().any(|m| m == method)
                && (row.exact.iter().any(|p| p == path)
                    || row.prefix.iter().any(|p| path.starts_with(p)))
        }) {
            // The query as Object.fromEntries(URLSearchParams) reads it: each name once, its last value.
            let mut named = serde_json::Map::new();
            for pair in query.split('&').filter(|v| !v.is_empty()) {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                named.insert(decode(k, true)?, Value::String(decode(v, true)?));
                if named.len() > 256 {
                    return Err(crate::cause!(WorkspaceError::TooLarge));
                }
            }
            let request = json!({"path":path,"method":method,"query":named,"body":body.unwrap_or_else(||json!({})),
                "browser":browser.ok_or(crate::cause!(WorkspaceError::Unavailable))?});
            return Ok(Some(ResolvedCall {
                operation: format!("{}:request", workshop.family),
                input: json!({"tool":route.tool,"request":request}),
            }));
        }
        let row = self.rows.iter().find(|row| {
            row.methods
                .as_ref()
                .is_none_or(|v| v.iter().any(|m| m == method))
                && (row.exact.iter().any(|p| p == path)
                    || row.prefix.iter().any(|p| path.starts_with(p)))
        });
        let Some(row) = row else {
            return Ok(None);
        };
        let query = family_query(query)?;
        let mut input = json!({"path":format!("{path}{}{}",if query.is_empty(){""}else{"?"},query),"method":method,"body":body.unwrap_or_else(||json!({}))});
        if row.browser {
            input["browser"] = browser.ok_or(crate::cause!(WorkspaceError::Unavailable))?;
        }
        if row.rest && !row.exact.iter().any(|p| p == path) {
            if let Some(rest) = row
                .prefix
                .iter()
                .find_map(|p| path.strip_prefix(p.as_str()))
            {
                input["rest"] = Value::String(rest.to_owned());
            }
        }
        Ok(Some(ResolvedCall {
            operation: format!("{}:request", row.family),
            input,
        }))
    }
    /// Every path and method the rows admit: each exact path, and each prefix
    /// with one more segment, under each declared method (GET and POST when a
    /// row declares none).
    pub fn samples(&self) -> Vec<RouteSample> {
        let mut out = Vec::new();
        for row in &self.rows {
            let methods = row
                .methods
                .clone()
                .unwrap_or_else(|| vec!["GET".into(), "POST".into()]);
            let paths = row
                .exact
                .iter()
                .cloned()
                .chain(row.prefix.iter().map(|p| format!("{p}sample")));
            for path in paths {
                for method in &methods {
                    out.push(RouteSample {
                        path: path.clone(),
                        method: method.clone(),
                    });
                }
            }
        }
        out
    }
    /// Every path and method the Workshop route table's rows admit, as `samples` makes them.
    pub fn workshop_samples(&self) -> Result<Vec<RouteSample>, WorkspaceError> {
        let mut out = Vec::new();
        for row in &workshop_routes()?.rows {
            for path in row
                .exact
                .iter()
                .cloned()
                .chain(row.prefix.iter().map(|p| format!("{p}sample")))
            {
                for method in &row.methods {
                    out.push(RouteSample {
                        path: path.clone(),
                        method: method.clone(),
                    });
                }
            }
        }
        Ok(out)
    }
}

fn ordered_values<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    struct Values;
    impl<'de> Visitor<'de> for Values {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("ordered startup path object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some((_, v)) = map.next_entry::<String, String>()? {
                out.push(v);
            }
            Ok(out)
        }
    }
    d.deserialize_map(Values)
}
#[derive(Deserialize)]
struct FirstAnswers {
    #[serde(deserialize_with = "ordered_values")]
    paths: Vec<String>,
    workspace_records_path: String,
    startup_record_inputs: Vec<String>,
    #[serde(default)]
    startup_preferences: Vec<String>,
    screen_revision: String,
    screens: BTreeMap<String, Vec<String>>,
    item_reads: ItemReads,
}
#[derive(Deserialize)]
struct ItemReads {
    screens: BTreeMap<String, Vec<ItemPath>>,
}
#[derive(Deserialize)]
struct ItemPath {
    path: Vec<Value>,
}
/// A read plan only: it does not perform queries, build a default page, or claim
/// the current complete-page transport preserves incremental response timing.
pub struct StartupPlan {
    pub revision: String,
    pub listed_reads: Vec<String>,
    pub copied_reads: Vec<String>,
    pub item_reads: Vec<String>,
}
pub struct StartupContract {
    data: FirstAnswers,
    records_path: String,
}
impl StartupContract {
    pub fn from_sources(
        first: &[u8],
        first_pin: &str,
        inputs: &[u8],
        inputs_pin: &str,
    ) -> Result<Self, WorkspaceError> {
        let data: FirstAnswers = pinned(first, first_pin)?;
        let inputs: Value = pinned(inputs, inputs_pin)?;
        if data.startup_record_inputs.len() + data.startup_preferences.len() > 256
            || !local_path(&data.workspace_records_path)
            || !local_path(&data.screen_revision)
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let mut labels = Vec::new();
        for name in &data.startup_record_inputs {
            labels.push(
                inputs
                    .get(name)
                    .and_then(|v| v.get("address"))
                    .and_then(Value::as_str)
                    .filter(|v| bounded(v))
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?
                    .to_owned(),
            );
        }
        for key in &data.startup_preferences {
            if !bounded(key) {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
            labels.push(format!("workspace-preference:{key}"));
        }
        let records_path = format!(
            "{}?{}",
            data.workspace_records_path,
            labels
                .iter()
                .map(|l| format!("label={}", encode(l, false)))
                .collect::<Vec<_>>()
                .join("&")
        );
        Ok(Self { data, records_path })
    }
    pub fn plan(
        &self,
        screen: Option<&str>,
        input: &BTreeMap<String, String>,
    ) -> Result<StartupPlan, WorkspaceError> {
        let mut copied = self.data.paths.clone();
        copied.push(self.records_path.clone());
        if let Some(paths) = screen.and_then(|s| self.data.screens.get(s)) {
            copied.extend(paths.iter().cloned());
        }
        let mut seen = BTreeSet::new();
        copied.retain(|p| seen.insert(p.clone()));
        let mut items = Vec::new();
        for spec in screen
            .and_then(|s| self.data.item_reads.screens.get(s))
            .into_iter()
            .flatten()
        {
            let mut out = String::new();
            let mut complete = true;
            for part in &spec.path {
                if let Some(text) = part.as_str() {
                    out.push_str(text);
                } else if let Some(name) = part.get("input").and_then(Value::as_str) {
                    if let Some(value) = input.get(name) {
                        out.push_str(&encode(value, false));
                    } else {
                        complete = false;
                        break;
                    }
                } else {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                }
            }
            if complete {
                items.push(out);
            }
        }
        let mut listed = vec![self.data.screen_revision.clone()];
        listed.extend(copied.iter().cloned());
        listed.extend(items.iter().cloned());
        let mut seen = BTreeSet::new();
        listed.retain(|p| seen.insert(p.clone()));
        if listed.len() > 512
            || listed
                .iter()
                .any(|p| !p.starts_with("/work/api/") || p.len() > 64 * 1024)
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(StartupPlan {
            revision: self.data.screen_revision.clone(),
            listed_reads: listed,
            copied_reads: copied,
            item_reads: items,
        })
    }
}

/// Real shared shell/screen resolver owner. The adapter supplies only the pinned
/// read contract; it does not manufacture a page or pick a screen by path guesses.
/// This complete-page seam does not yet provide original incremental HTML timing.
pub trait WorkspacePageOwner: Send + Sync {
    fn page_response(
        &self,
        context: DomainContext,
        startup: Arc<StartupContract>,
    ) -> SupplyFuture<WorkspacePageResponse> {
        let page = self.page(context, startup);
        Box::pin(async move { page.await.map(WorkspacePageResponse::Complete) })
    }
    fn page(
        &self,
        context: DomainContext,
        startup: Arc<StartupContract>,
    ) -> SupplyFuture<WorkspacePage>;
}
pub struct CanonicalWorkspace {
    routes: Arc<OwnerRoutes>,
    startup: Arc<StartupContract>,
    executor: Arc<dyn CanonicalWorkspaceExecutor>,
    page: Option<Arc<dyn WorkspacePageOwner>>,
}
impl CanonicalWorkspace {
    /// Share the already pinned route/startup DATA and the exact same executor
    /// with an API-only adapter used by the page's own reads. No reparsing,
    /// second capability owner or recursive page invocation is introduced.
    pub fn with_page(&self, page: Arc<dyn WorkspacePageOwner>) -> Self {
        Self {
            routes: self.routes.clone(),
            startup: self.startup.clone(),
            executor: self.executor.clone(),
            page: Some(page),
        }
    }
    pub fn new(
        routes: OwnerRoutes,
        startup: StartupContract,
        executor: Arc<dyn CanonicalWorkspaceExecutor>,
        page: Option<Arc<dyn WorkspacePageOwner>>,
    ) -> Self {
        Self {
            routes: Arc::new(routes),
            startup: Arc::new(startup),
            executor,
            page,
        }
    }
}
fn field(head: &WorkspaceRequestHead, name: &str) -> Result<Option<String>, WorkspaceError> {
    let mut values = head.headers.get_all(name).iter();
    let value = values
        .next()
        .map(|v| {
            v.to_str()
                .map(str::to_owned)
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
        })
        .transpose()?;
    if values.next().is_some() {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(value)
}
fn browser(scope: &BrowserScope, head: &WorkspaceRequestHead) -> Result<Value, WorkspaceError> {
    let cookie = field(head, "cookie")?.unwrap_or_default();
    let visitor = cookie
        .split(';')
        .map(str::trim)
        .filter_map(|v| v.strip_prefix("nm_visitor="))
        .find(|v| {
            v.len() == 32
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .unwrap_or("");
    Ok(
        json!({"user_agent":field(head,"user-agent")?.unwrap_or_default(),"origin":scope.origin,"visitor":visitor}),
    )
}
fn query_object(query: &str) -> Result<serde_json::Map<String, Value>, WorkspaceError> {
    if query.len() > 64 * 1024 {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let mut out = serde_json::Map::new();
    for pair in query.split('&').filter(|v| !v.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(k, true)?;
        let value = Value::String(decode(v, true)?);
        match out.remove(&key) {
            None => {
                out.insert(key, value);
            }
            Some(Value::Array(mut values)) => {
                values.push(value);
                out.insert(key, Value::Array(values));
            }
            Some(old) => {
                out.insert(key, Value::Array(vec![old, value]));
            }
        }
        if out.len() > 256 {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
    }
    Ok(out)
}
pub(crate) fn specialized(
    path: &str,
    method: &str,
    query: &str,
    body: &Option<Value>,
    origin: &str,
) -> Result<Option<ResolvedCall>, WorkspaceError> {
    // Explicit read-check semantics: no immutable write receipt is promised.
    if path == "/show-rules" && method == "GET" {
        return Ok(Some(ResolvedCall {
            operation: "show-rules:request".into(),
            input: json!({"path":"/show-rules","method":"GET","body":{}}),
        }));
    }
    // The original viewer GET ignores query text; this is an internal Rust envelope.
    if path == "/viewer" && method == "GET" {
        return Ok(Some(ResolvedCall {
            operation: "viewer:read".into(),
            input: json!({}),
        }));
    }
    let mut q = query_object(query)?;
    // Home feeds (activity, message canvas, new work, waiting on you, AI work) and pursuits have no owner in the
    // engine (the page lists their records through the account's routes), so their paths answer NoOwner.
    if let Some(value) = q
        .get_mut("limit")
        .filter(|v| !v.as_str().is_some_and(str::is_empty))
    {
        if let Some(text) = value.as_str() {
            let n = text.parse::<f64>().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            *value = serde_json::Number::from_f64(n)
                .map(Value::Number)
                .ok_or(crate::cause!(WorkspaceError::Invalid))?;
        }
    }
    // The tool-screen reader answers only the screens list; every other
    // /workshop and /workflows request has no owner here. A tool's describe is
    // the tools' tool:describe-a-tool, run at the account routes' tools:run.
    let call = if method == "GET" && path == "/workshop/screens" {
        Some((
            "presentation:request",
            json!({"path":format!("/work/api{path}{}{}",if query.is_empty(){""}else{"?"},query),"origin":origin,"method":method,"body":body.clone().unwrap_or_else(||json!({}))}),
        ))
    } else if path == "/records" && method == "GET" {
        let labels = match q.remove("label") {
            None => vec![],
            Some(Value::Array(values)) => values,
            Some(value) => vec![value],
        };
        Some((
            "workspace:read",
            if labels.is_empty() {
                json!({})
            } else {
                json!({"selection":{"labels":labels}})
            },
        ))
    } else if path == "/records" && method == "POST" {
        body.as_ref().and_then(|value| {
            if value.get("records").is_some_and(Value::is_array) {
                Some(("records:write", value.clone()))
            } else if value.get("writes").is_some_and(Value::is_array)
                || value
                    .get("resolve_conflict")
                    .is_some_and(|v| !v.is_null() && v != false)
            {
                Some(("workspace:write", value.clone()))
            } else {
                None
            }
        })
    } else if path == "/records" && method == "DELETE" {
        body.as_ref().and_then(|v|v.get("ids")).and_then(Value::as_array).map(|ids|("records:write",json!({"records":ids.iter().map(|id|json!({"id":id,"value":null})).collect::<Vec<_>>()})))
    } else {
        None
    };
    Ok(call.map(|(operation, input)| ResolvedCall {
        operation: operation.into(),
        input,
    }))
}
/// What a refused `/work/api` request was and why, kept while it runs and reported once it is answered: one stderr
/// line, `native-workspace-refused operation=<word> status=<code> cause=<word>`, which the Mac app copies into its log
/// (macos/Shared/StartupPreparationDiagnostics.swift). The operation is the DATA-declared operation name and the cause
/// is the refusal's own code (`failure_code`) or the `WorkspaceError` variant; nothing from the request, the account,
/// its ids or its keys is ever written.
struct Refusal {
    cause: crate::refusal_cause::Cause,
    reported: std::sync::OnceLock<crate::refusal_cause::Cause>,
    operation: std::sync::OnceLock<String>,
    code: std::sync::OnceLock<String>,
    /// The shape of the requested `/work/api` path (`route_shape`), named in place of the operation when no route
    /// resolved it, so an unowned path is visible in the log without its ids or query.
    shape: std::sync::OnceLock<String>,
}
impl Default for Refusal {
    #[track_caller]
    fn default() -> Self {
        Self { cause: crate::refusal_cause::Cause::from_caller(), reported: Default::default(),
            operation: Default::default(), code: Default::default(), shape: Default::default() }
    }
}
impl Refusal {
    fn report(&self, outcome: &Result<Response, WorkspaceError>) {
        if let Some(line) = self.line(outcome) {
            crate::quiet_eprintln!("{line}");
        }
    }
    fn line(&self, outcome: &Result<Response, WorkspaceError>) -> Option<String> {
        let (status, code, cause) = match outcome {
            Ok(reply)
                if !(reply.status().is_client_error() || reply.status().is_server_error()) =>
            {
                return None
            }
            Ok(reply) => (
                reply.status(),
                self.code
                    .get()
                    .map_or("answered", String::as_str)
                    .to_owned(),
                reply.extensions().get::<crate::refusal_cause::Cause>().or_else(|| self.reported.get()).unwrap_or(&self.cause).clone(),
            ),
            Err(error) => (error.clone().into_response().status(), "workspace_error".to_owned(), error.cause()),
        };
        let operation = self
            .operation
            .get()
            .or(self.shape.get())
            .map_or("unresolved", String::as_str);
        Some(format!(
            "native-workspace-refused operation={} status={} code={} cause={}",
            closed_word(operation),
            status.as_u16(),
            closed_word(&code),
            cause
        ))
    }
}
/// A `/work/` request refused before it reached its operation owner (`WorkspaceOperations::invoke`, which reports its
/// own): its admission to a request slot or its session's admission failed. The same line as `Refusal`, the path's
/// shape as its operation and `admission.<variant>` as its cause, so no refusal of a page request goes unnamed.
pub(crate) fn report_unadmitted(path: &str, error: &WorkspaceError) {
    let shape = route_shape(work_path(path));
    let cause = error.cause();
    crate::quiet_eprintln!(
        "native-workspace-refused operation={} status={} code=admission cause={}",
        closed_word(&shape),
        error.clone().into_response().status().as_u16(),
        cause
    );
}
/// The request path relative to the workspace root, before matching declared
/// diagnostic literals. A suffix of a declared prefix remains undisclosed.
fn work_path(path: &str) -> &str {
    path.strip_prefix("/work/api")
        .or_else(|| path.strip_prefix("/work"))
        .unwrap_or(path)
}
/// A refusal names only literals from the existing compiled route DATA. A
/// request's suffix is never a log word, even when it looks like a route word.
/// An undeclared path has no safe literal to disclose.
fn route_shape(path: &str) -> String {
    // These tables are compiled constants. Share their derived diagnostic
    // literals without reparsing the route owner on each request.
    static LITERALS: std::sync::OnceLock<Vec<(String, bool)>> = std::sync::OnceLock::new();
    let literals = LITERALS.get_or_init(|| {
        let owners = OwnerRoutes::from_product().ok();
        let owner_paths = owners
            .iter()
            .flat_map(|routes| &routes.rows)
            .flat_map(|row| {
                row.exact
                    .iter()
                    .map(|path| (path.as_str(), false))
                    .chain(row.prefix.iter().map(|path| (path.as_str(), true)))
            });
        let tool_paths = workshop_routes()
            .ok()
            .into_iter()
            .flat_map(|routes| &routes.rows)
            .flat_map(|row| {
                row.exact
                    .iter()
                    .map(|path| (path.as_str(), false))
                    .chain(row.prefix.iter().map(|path| (path.as_str(), true)))
            });
        owner_paths
            .chain(tool_paths)
            .map(|(path, prefix)| (path.to_owned(), prefix))
            .collect()
    });
    route_shape_from_literals(
        path,
        literals
            .iter()
            .map(|(path, prefix)| (path.as_str(), *prefix)),
    )
}

fn route_shape_from_literals<'a>(
    path: &str,
    declared: impl Iterator<Item = (&'a str, bool)>,
) -> String {
    let Some((literal, prefix)) = declared
        .filter(|(literal, prefix)| {
            if *prefix {
                path.starts_with(*literal)
            } else {
                path == *literal
            }
        })
        .max_by_key(|(literal, prefix)| (literal.len(), !*prefix))
    else {
        return "path.unresolved".into();
    };
    let mut shape = String::from("path");
    for segment in literal.split('/').filter(|segment| !segment.is_empty()) {
        let kept =
            segment.len() <= 32 && segment.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
        let word = if kept { segment } else { "_" };
        if shape.len() + 1 + word.len() > 64 {
            break;
        }
        shape.push('.');
        shape.push_str(word);
    }
    if prefix && shape.len() + "._".len() <= 64 {
        shape.push_str("._");
    }
    shape
}
/// A word fit for the log: short, and only letters, digits and `@:._-`; anything else is reported as `unnamed`. `@`
/// is the first letter of a family named after a resource (`@own-records:request`, the page's road to the records
/// the account's routes), so the account routes' refusals are named like every other operation's.
fn closed_word(word: &str) -> &str {
    if !word.is_empty()
        && word.len() <= 64
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@:._-".contains(&b))
    {
        word
    } else {
        "unnamed"
    }
}

pub(crate) fn response(answer: DomainAnswer) -> Result<Response, WorkspaceError> {
    let mut response = match answer {
        DomainAnswer::Response(response) => response,
        DomainAnswer::Http {
            status,
            headers,
            body,
        } => {
            let mut r = Response::new(Body::from(body));
            *r.status_mut() = status;
            *r.headers_mut() = headers;
            r
        }
        DomainAnswer::Json {
            body,
            next_before,
            collection_coverage,
        } => {
            let mut r = axum::Json(body).into_response();
            if let Some(next) = next_before {
                r.headers_mut().insert(
                    "x-trillion-next-before",
                    HeaderValue::from_str(&next).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?,
                );
            }
            if let Some(coverage) = collection_coverage {
                r.headers_mut().insert(
                    "x-trillion-collection-coverage",
                    HeaderValue::from_str(
                        &serde_json::to_string(&coverage).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?,
                    )
                    .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?,
                );
            }
            r
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
fn guard(
    scope: &BrowserScope,
    head: &WorkspaceRequestHead,
) -> Result<Option<Response>, WorkspaceError> {
    if !bounded(&scope.origin) || !bounded(&scope.page_store) {
        return Err(crate::cause!(WorkspaceError::Unavailable));
    }
    let safe = matches!(head.method, Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe
        && (field(head, "sec-fetch-site")?.is_some_and(|s| s != "same-origin" && s != "none")
            || field(head, "origin")?.is_some_and(|s| s != scope.origin))
    {
        return Err(crate::cause!(WorkspaceError::Forbidden));
    }
    if scope.read_only && !matches!(head.method, Method::GET | Method::HEAD) {
        return Err(crate::cause!(WorkspaceError::Forbidden));
    }
    if matches!(
        head.method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && head.uri.path().starts_with("/work/api/")
        && field(head, PAGE_STORE_HEADER.as_str())?
            .is_some_and(|s| !s.is_empty() && s != scope.page_store)
    {
        let cause = crate::cause!(condition: browser_account_changed_before_send);
        let mut response = (StatusCode::CONFLICT, axum::Json(json!({"status":409,
            "error":"This was not sent because the account signed in on this browser changed. Reload the page and try again.",
            "failure_code":"request-refused", "cause": cause.id()}))).into_response();
        response.extensions_mut().insert(cause);
        return Ok(Some(response));
    }
    Ok(None)
}
impl WorkspaceOperations for CanonicalWorkspace {
    fn page_response(
        &self,
        session: WorkspaceSession,
        head: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePageResponse> {
        let executor = self.executor.clone();
        let page = self.page.clone();
        let startup = self.startup.clone();
        Box::pin(async move {
            let ctx = DomainContext {
                session: Arc::new(session),
                head,
                permit,
            };
            let scope = executor.authorize(ctx.clone()).await?;
            if guard(&scope, &ctx.head)?.is_some() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            page.ok_or(crate::cause!(WorkspaceError::Unavailable))?
                .page_response(ctx, startup)
                .await
        })
    }
    fn page(
        &self,
        session: WorkspaceSession,
        head: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        let executor = self.executor.clone();
        let page = self.page.clone();
        let startup = self.startup.clone();
        Box::pin(async move {
            let ctx = DomainContext {
                session: Arc::new(session),
                head,
                permit,
            };
            let scope = executor.authorize(ctx.clone()).await?;
            if guard(&scope, &ctx.head)?.is_some() {
                return Err(crate::cause!(WorkspaceError::Conflict));
            }
            page.ok_or(crate::cause!(WorkspaceError::Unavailable))?
                .page(ctx, startup)
                .await
        })
    }
    fn invoke(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        let executor = self.executor.clone();
        let routes = self.routes.clone();
        let seen = Arc::new(Refusal::default());
        let noted = seen.clone();
        let answer = async move {
            let ctx = DomainContext {
                session: Arc::new(session),
                head: request.head,
                permit,
            };
            // Named before admission, so a request refused while it is admitted is named by its path too.
            let _ = noted.shape.set(route_shape(work_path(ctx.head.uri.path())));
            // A `/work/` path outside `/work/api/` (the old Worker's device-copy `/work/records/settle`) has no owner
            // here: its answer is final, never busy, so the page stops asking instead of retrying a 503.
            let path = ctx
                .head
                .uri
                .path()
                .strip_prefix("/work/api/")
                .map(|tail| format!("/{tail}"))
                .ok_or(crate::cause!(WorkspaceError::NoOwner))?;
            if ctx.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Unavailable));
            }
            let scope = executor.authorize(ctx.clone()).await?;
            if let Some(refusal) = guard(&scope, &ctx.head)? {
                return Ok(refusal);
            }
            let is_head = ctx.head.method == Method::HEAD;
            let method = if is_head {
                "GET"
            } else {
                ctx.head.method.as_str()
            };
            let body = if method == "GET" {
                None
            } else {
                if field(&ctx.head, "origin")?.as_deref() != Some(scope.origin.as_str()) {
                    return Err(crate::cause!(WorkspaceError::Forbidden));
                }
                if request.body.len() > 1_000_000 {
                    return Err(crate::cause!(WorkspaceError::TooLarge));
                }
                let value: Value = if request.body.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&request.body).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?
                };
                if !value.is_object() {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                Some(value)
            };
            let answer = if path == "/screen-revision" && method == "GET" {
                executor.heads(ctx.clone()).await?
            } else {
                let query = ctx.head.uri.query().unwrap_or("");
                let resolved = match specialized(&path, method, query, &body, &scope.origin)? {
                    Some(call) => Some(call),
                    None => routes.resolve(
                        &path,
                        method,
                        query,
                        body,
                        Some(browser(&scope, &ctx.head)?),
                    )?,
                }
                // No fixed route and no route row names it: final, never busy.
                .ok_or(crate::cause!(WorkspaceError::NoOwner))?;
                let _ = noted.operation.set(resolved.operation.clone());
                let carried = field(&ctx.head, "idempotency-key")?
                    .or(field(&ctx.head, REQUEST_KEY_HEADER.as_str())?);
                let key_carried = carried.is_some();
                let key = match carried {
                    Some(key) => key,
                    None => {
                        executor
                            .request_key(
                                ctx.clone(),
                                resolved.operation.clone(),
                                resolved.input.clone(),
                            )
                            .await?
                    }
                };
                if !bounded(&key) {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                let command = DomainCommand {
                    operation: resolved.operation,
                    input: resolved.input,
                    request_key: key,
                    key_carried,
                };
                let resource = executor
                    .select_resource(ctx.clone(), command.clone())
                    .await?;
                if !bounded(&resource) || ctx.permit.cancelled() {
                    return Err(crate::cause!(WorkspaceError::Unavailable));
                }
                let answer = executor.execute(ctx.clone(), resource, command).await?;
                if let DomainAnswer::Http { status, body, .. } = &answer {
                    if status.is_client_error() || status.is_server_error() {
                        let parsed = serde_json::from_slice::<Value>(body).ok();
                        if let Some(code) = parsed.as_ref().and_then(|body| body.get("failure_code")?.as_str()) {
                            let _ = noted.code.set(code.to_owned());
                        }
                        let cause = parsed.as_ref().and_then(|body| body.get("cause")?.as_str())
                            .and_then(crate::refusal_cause::Cause::from_wire)
                            .unwrap_or_else(|| crate::cause!(condition: domain_http_failure_without_reported_source));
                        let _ = noted.reported.set(cause);
                    }
                }
                answer
            };
            if ctx.permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Unavailable));
            }
            let mut reply = response(answer)?;
            if is_head {
                *reply.body_mut() = Body::empty();
            }
            Ok(reply)
        };
        Box::pin(async move {
            let outcome = answer.await;
            seen.report(&outcome);
            outcome
        })
    }
}

#[cfg(test)]
mod refusal_tests {
    use super::*;

    fn answered(status: StatusCode) -> Result<Response, WorkspaceError> {
        let mut reply = Response::new(Body::empty());
        *reply.status_mut() = status;
        Ok(reply)
    }

    #[test]
    fn a_refused_write_names_its_operation_status_and_code_and_nothing_else() {
        let seen = Refusal::default();
        seen.operation.set("notes.change".into()).unwrap();
        seen.code
            .set("original_workspace_source_unavailable".into())
            .unwrap();
        assert_eq!(
            seen.line(&answered(StatusCode::SERVICE_UNAVAILABLE)).as_deref(),
            Some(format!("native-workspace-refused operation=notes.change status=503 code=original_workspace_source_unavailable cause={}", seen.cause).as_str())
        );
    }

    #[test]
    fn an_error_before_resolution_names_its_variant_and_an_answer_is_never_reported() {
        let seen = Refusal::default();
        let error = crate::cause!(WorkspaceError::Unauthorized);
        let expected = format!("native-workspace-refused operation=unresolved status=401 code=workspace_error cause={}", error.cause());
        assert_eq!(seen.line(&Err(error)).as_deref(), Some(expected.as_str()));
        assert_eq!(seen.line(&answered(StatusCode::OK)), None);
    }

    #[test]
    fn a_word_that_could_carry_request_content_is_never_written() {
        let seen = Refusal::default();
        seen.operation
            .set("notes.change label=some place".into())
            .unwrap();
        seen.code.set("x".repeat(65)).unwrap();
        assert_eq!(
            seen.line(&answered(StatusCode::CONFLICT)).as_deref(),
            Some(format!("native-workspace-refused operation=unnamed status=409 code=unnamed cause={}", seen.cause).as_str())
        );
    }

    #[test]
    fn unresolved_path_diagnostics_use_only_declared_route_literals() {
        let seen = Refusal::default();
        seen.shape
            .set(route_shape("/screens/alice/people"))
            .unwrap();
        let error = crate::cause!(WorkspaceError::NoOwner);
        let expected = format!("native-workspace-refused operation=path.screens._ status=404 code=workspace_error cause={}", error.cause());
        assert_eq!(seen.line(&Err(error)).as_deref(), Some(expected.as_str()));
        assert_eq!(route_shape("/calendar/tasks"), "path.calendar.tasks");
        assert_eq!(
            route_shape("/namespace/contents/private-note"),
            "path.namespace.contents._"
        );
        assert_eq!(route_shape("/private-name/alice"), "path.unresolved");
        for suffix in ["alice/people", "secret-key", "calendar/tasks"] {
            assert_eq!(
                route_shape_from_literals(
                    &format!("/spaces/{suffix}"),
                    [("/spaces/", true), ("/calendar/tasks", false)].into_iter()
                ),
                "path.spaces._",
                "request words never become literals by matching another route"
            );
        }
        assert!(route_shape(&"/abcdefghij".repeat(20)).len() <= 64);
        // A resolved operation is named, not the path.
        seen.operation.set("fixture-read".into()).unwrap();
        assert!(seen
            .line(&Err(crate::cause!(WorkspaceError::NoOwner)))
            .unwrap()
            .contains("operation=fixture-read"));
    }

    /// A change a browser sent from a page of another origin is refused 403 before any operation runs, a Workshop
    /// route's POST or PUT included (old trillion src/change-from-elsewhere.mjs changeFromElsewhere, judged once at the
    /// signed-in entry, src/worker.mjs work()): Sec-Fetch-Site other than same-origin or none, or an Origin naming
    /// another origin. A read is never refused here.
    #[test]
    fn a_change_from_another_site_is_refused_and_a_read_is_not() {
        let scope = BrowserScope {
            origin: "http://127.0.0.1:1".into(),
            page_store: "store".into(),
            read_only: false,
        };
        let head = |method: Method, site: Option<&str>, origin: Option<&str>| {
            let mut headers = axum::http::HeaderMap::new();
            if let Some(site) = site {
                headers.insert("sec-fetch-site", HeaderValue::from_str(site).unwrap());
            }
            if let Some(origin) = origin {
                headers.insert("origin", HeaderValue::from_str(origin).unwrap());
            }
            WorkspaceRequestHead {
                method,
                uri: "/work/api/x".parse().unwrap(),
                headers,
            }
        };
        for method in [Method::POST, Method::PUT] {
            for (site, origin) in [
                (Some("cross-site"), None),
                (Some("same-site"), Some("http://127.0.0.1:1")),
                (None, Some("https://elsewhere.example")),
            ] {
                let refused = guard(&scope, &head(method.clone(), site, origin));
                assert!(
                    matches!(refused, Err(WorkspaceError::Forbidden(_))),
                    "{method} {site:?} {origin:?}"
                );
                assert_eq!(
                    crate::cause!(WorkspaceError::Forbidden).into_response().status(),
                    StatusCode::FORBIDDEN
                );
            }
            assert!(guard(
                &scope,
                &head(
                    method.clone(),
                    Some("same-origin"),
                    Some("http://127.0.0.1:1")
                )
            )
            .unwrap()
            .is_none());
        }
        assert!(guard(
            &scope,
            &head(
                Method::GET,
                Some("cross-site"),
                Some("https://elsewhere.example")
            )
        )
        .unwrap()
        .is_none());
    }

    /// Ported from old trillion test/screen-revision-worker-negative.test.mjs (tag old-trillion-before-worker-retire,
    /// b6ae0ebf81), deleted by Trillion-X/trillion #243: "actual Worker refuses a current viewer's Workshop run as read
    /// only, before any gate, native work or former owner". A read-only browser scope (`BrowserScope::read_only`, the old
    /// view-as look) is refused 403 for a Workshop run's POST at the signed-in entry, before any operation runs, and may
    /// still read. (The old body words, view-as.json `words.read_only`, are not this refusal's body; named in the port
    /// report. No running sign-in issues a read-only scope today: the old view-as issuer is parked in
    /// trillion-workshop tools/let-someone-look-at-my-trillion-read/from-old-trillion.)
    #[test]
    fn old_screen_revision_worker_negative_a_read_only_scopes_workshop_run_is_refused_before_any_operation(
    ) {
        let scope = BrowserScope {
            origin: "http://127.0.0.1:1".into(),
            page_store: "store".into(),
            read_only: true,
        };
        let head = |method: Method| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:1"));
            WorkspaceRequestHead {
                method,
                uri: "/work/api/workshop/run-tool/tool%3Atell-the-person"
                    .parse()
                    .unwrap(),
                headers,
            }
        };
        assert!(
            matches!(
                guard(&scope, &head(Method::POST)),
                Err(WorkspaceError::Forbidden(_))
            ),
            "a look refuses every change"
        );
        assert_eq!(
            crate::cause!(WorkspaceError::Forbidden).into_response().status(),
            StatusCode::FORBIDDEN
        );
        assert!(
            guard(&scope, &head(Method::GET)).unwrap().is_none(),
            "a look still reads"
        );
    }

    #[test]
    fn the_records_doors_page_road_is_named() {
        let seen = Refusal::default();
        seen.operation.set("@own-records:request".into()).unwrap();
        let error = crate::cause!(WorkspaceError::Unavailable);
        let expected = format!("native-workspace-refused operation=@own-records:request status=503 code=workspace_error cause={}", error.cause());
        assert_eq!(seen.line(&Err(error)).as_deref(), Some(expected.as_str()));
    }
}
#[cfg(test)]
mod root_path_tests {
    use super::*;

    fn target(method: &str, uri: &str) -> Option<String> {
        workshop_root_target(&Method::from_bytes(method.as_bytes()).unwrap(), &uri.parse().unwrap())
            .unwrap()
            .map(|uri| uri.to_string())
    }

    /// A Workshop route row's `root` paths are answered at the site's root as that row's own route under /work/api (an
    /// address an outside service was given before the routes lived under /work/api, as old trillion src/worker.mjs
    /// served `${PRIMARY}${acquire.redirect.path}`): the path keeps its query, only the row's own methods reach it, and
    /// a path no row names, or one already under /work/, is not moved.
    #[test]
    fn a_route_rows_root_paths_reach_that_route_with_their_query() {
        let rows = &workshop_routes().unwrap().rows;
        assert!(rows.iter().any(|row| !row.root.is_empty()), "the product table names at least one root path");
        for row in rows {
            for path in &row.root {
                for method in &row.methods {
                    assert_eq!(target(method, &format!("{path}?state=s&code=c")), Some(format!("/work/api{path}?state=s&code=c")));
                    assert_eq!(target(method, path), Some(format!("/work/api{path}")));
                }
                for other in ["GET", "POST", "PUT", "DELETE"].into_iter().filter(|m| !row.methods.iter().any(|own| own == m)) {
                    assert_eq!(target(other, path), None, "{other} {path} is not one of its row's methods");
                }
            }
        }
        assert_eq!(target("GET", "/a-path-no-row-names"), None);
        assert_eq!(target("GET", "/work/api/a-path-no-row-names"), None);
    }

    #[test]
    fn a_root_path_under_work_or_with_a_query_mark_is_refused_as_data() {
        let row = |root: &str| WorkshopRoute { methods: vec!["GET".into()], exact: vec!["/x".into()], prefix: vec![], root: vec![root.into()], tool: "tool:x".into() };
        assert!(valid_root_paths(&row("/x")));
        for refused in ["/work/x", "/work", "x", "/x?y", ""] {
            assert!(!valid_root_paths(&row(refused)), "{refused:?} is refused");
        }
    }
}
