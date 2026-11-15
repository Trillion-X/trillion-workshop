// src/workspace_page.rs
//
// Purpose: Produce the original workspace shell and first-answer stream from selected current supplies.
// Non-Negotiable Invariants: Consume pinned shared-renderer output and actual route/read owners; never invent a layout, default account, successful empty answer or native credential.
// Key Concepts: Typed canonical-origin marker position, original offered screen DATA, verified cookie kept key, lazy canonical reads and same-permit retention.
// Security Considerations: No new browser authority, source execution, raw-token persistence, cross-account copy or arbitrary HTML template substitution.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod address;
mod captured_resource;
pub use address::{ScreenRequest, ScreenRoutes, ScreenSelection, ScreenSelectionPolicy};
pub use captured_resource::{BoundCapturedMcpResource, CapturedMcpResource, ResourceOrigin};

use crate::{
    workspace::{
        workspace_json_limits, CurrentSession, SupplyFuture, WorkspaceAnswerEnvelope,
        WorkspaceAssets, WorkspaceError, WorkspacePermit, WorkspaceOperations, WorkspacePage,
        WorkspacePageResponse, WorkspaceRequest, WorkspaceRequestHead, WorkspaceSession,
        WorkspaceStreamingPage,
    },
    workspace_domain::{DomainContext, StartupContract, WorkspacePageOwner},
    workspace_session::{browser_token, WorkspaceSessionSettings},
    workspace_stream::{ReadSpec, RetentionFuture, StreamLimits, WorkspaceReadBatch},
};
use content_crypto::advanced::blake3;
use axum::{
    body::{to_bytes, Bytes},
    http::{header, Method, Uri},
    response::IntoResponse,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap, fs, io::Read, net::SocketAddr, path::Path,
    sync::Arc,
};
use tokio::sync::OnceCell;
use zeroize::Zeroizing;
use crate::tool_runs::os::{Open, OwnerFiles, This};

const MAX_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_SHELL_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
const KEY_CONTEXT: &str = "trillion 2026-09-30 kept answers key";

#[derive(Deserialize)]
struct OriginSlot {
    offset: usize,
    length: usize,
    expected: String,
}
#[derive(Deserialize)]
struct CapturedFile {
    bytes: usize,
    blake3: String,
    canonical_origin_slot: Option<OriginSlot>,
}
#[derive(Deserialize)]
struct Capture {
    schema: String,
    canonical_origin_marker: String,
    artifacts: BTreeMap<String, CapturedFile>,
    early_socket: Option<EarlySocketSupply>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EarlySocketSupply {
    kind: String,
}
struct ShellTemplate {
    source: String,
    slot: OriginSlot,
}

fn pinned(bytes: &[u8], identity: &str, max: usize) -> Result<(), WorkspaceError> {
    if bytes.len() > max {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    if identity.len() != 64 || blake3::hash(bytes).to_hex().as_str() != identity {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    Ok(())
}
fn bounded_file(path: &Path, max: usize) -> Result<Vec<u8>, WorkspaceError> {
    let file = This::open(fs::OpenOptions::new().read(true), &path, Open::NO_FOLLOW)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    let metadata = file.metadata().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if bytes.len() > max {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    Ok(bytes)
}
fn file(
    root: &Path,
    name: &str,
    captured: &CapturedFile,
    max: usize,
) -> Result<Vec<u8>, WorkspaceError> {
    // Names are fixed by this owner, never supplied by the capture or browser.
    let path = root.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if !metadata.is_file() || metadata.len() != captured.bytes as u64 || metadata.len() > max as u64
    {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let bytes = bounded_file(&path, max)?;
    if bytes.len() != captured.bytes {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    pinned(&bytes, &captured.blake3, max)?;
    Ok(bytes)
}
impl ShellTemplate {
    fn new(bytes: Vec<u8>, slot: OriginSlot, marker: &str) -> Result<Self, WorkspaceError> {
        let source = String::from_utf8(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let end = slot
            .offset
            .checked_add(slot.length)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        // The source-owned capture records the one canonical href marker position. Check
        // exact context and offsets; never search-and-replace arbitrary markup.
        if slot.expected != marker
            || slot.length != marker.len()
            || source.as_bytes().get(slot.offset..end) != Some(marker.as_bytes())
            || !source
                .get(..slot.offset)
                .is_some_and(|v| v.ends_with("<link rel=\"canonical\" href=\""))
            || !source.get(end..).is_some_and(|v| v.starts_with("/\"/>"))
            || source.matches(marker).count() != 1
            || source.matches("id=\"root\"").count() != 1
            || source.matches("</body>").count() != 1
            || source.matches("<body>").count() != 1
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(Self { source, slot })
    }
    /// The page at `origin`: the local listener (`http://` a loopback address), or the account's public origin
    /// (`https://` a host), the address the session owner admitted the request by.
    fn render(&self, origin: &str) -> Result<String, WorkspaceError> {
        let uri: Uri = origin.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        let authority = uri.authority().ok_or(crate::cause!(WorkspaceError::Invalid))?;
        let local = || {
            authority.as_str().parse::<SocketAddr>().is_ok_and(|address| address.ip().is_loopback() && address.port() != 0)
                && origin == format!("http://{authority}")
        };
        let public = || origin == format!("https://{authority}") && !authority.as_str().contains('@');
        if !(match uri.scheme_str() { Some("http") => local(), Some("https") => public(), _ => false })
            || origin.contains(['<', '>', '&', '"', '\''])
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let mut html = String::with_capacity(self.source.len() + origin.len());
        html.push_str(&self.source[..self.slot.offset]);
        html.push_str(origin);
        html.push_str(&self.source[self.slot.offset + self.slot.length..]);
        Ok(html)
    }
}

/// Output of the EXISTING shared htmlPage/Screen Look/thread-cover renderer and
/// existing screens DATA producers. V1 supplies its original earlySocketScript;
/// V2 explicitly has none when the compiled client owns its socket. No Rust layout or palette.
pub struct CapturedWorkspaceShell {
    opening: ShellTemplate,
    repaint: ShellTemplate,
    early_socket: Option<String>,
    routes: ScreenRoutes,
}
impl CapturedWorkspaceShell {
    pub fn open(root: impl AsRef<Path>, capture_identity: &str) -> Result<Self, WorkspaceError> {
        let root = root.as_ref();
        let receipt = bounded_file(&root.join("capture.json"), MAX_CAPTURE_BYTES)?;
        pinned(&receipt, capture_identity, MAX_CAPTURE_BYTES)?;
        let mut capture: Capture =
            serde_json::from_slice(&receipt).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let has_early_socket = match capture.schema.as_str() {
            "trillion.workspace-shell-capture/v1" if capture.early_socket.is_none() => true,
            "trillion.workspace-shell-capture/v2"
                if capture
                    .early_socket
                    .as_ref()
                    .is_some_and(|supply| supply.kind == "not_produced")
                    && capture.artifacts.len() == 3
                    && !capture.artifacts.contains_key("early-socket.txt") =>
            {
                false
            }
            _ => return Err(crate::cause!(WorkspaceError::Integrity)),
        };
        let mut templates = Vec::new();
        for name in ["opening.html", "repaint.html"] {
            let mut metadata = capture
                .artifacts
                .remove(name)
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let bytes = file(root, name, &metadata, MAX_SHELL_BYTES)?;
            templates.push(ShellTemplate::new(
                bytes,
                metadata
                    .canonical_origin_slot
                    .take()
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?,
                &capture.canonical_origin_marker,
            )?);
        }
        let early_socket = if has_early_socket {
            let early = capture
                .artifacts
                .remove("early-socket.txt")
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let script = String::from_utf8(file(root, "early-socket.txt", &early, 16 * 1024)?)
                .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
            // Refuse incompatible source until its actual producer/escaping is adopted.
            if script.to_ascii_lowercase().contains("</script") {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
            Some(script)
        } else {
            None
        };
        let surfaces = capture
            .artifacts
            .remove("surfaces.json")
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let routes = ScreenRoutes::from_source(
            &file(root, "surfaces.json", &surfaces, 2 * 1024 * 1024)?,
            &surfaces.blake3,
        )?;
        let repaint = templates.pop().ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let opening = templates.pop().ok_or(crate::cause!(WorkspaceError::Integrity))?;
        Ok(Self {
            opening,
            repaint,
            early_socket,
            routes,
        })
    }
    pub fn document(&self, origin: &str, repaint: bool) -> Result<String, WorkspaceError> {
        let mut html = if repaint {
            self.repaint.render(origin)?
        } else {
            self.opening.render(origin)?
        };
        if let Some(script) = self.early_socket.as_ref().filter(|_| !repaint) {
            let at = html.find("<body>").ok_or(crate::cause!(WorkspaceError::Integrity))? + "<body>".len();
            html.insert_str(at, &format!("<script>{script}</script>"));
        }
        Ok(html)
    }
}

/// The actual original per-sign-in encrypted copy owner supplies opened copies
/// and owns retained refresh work. Implementations MUST authenticate/decrypt the
/// original copy under that session token, recheck current rights before reads
/// and writes, preserve copy revision/merge/no-write rules and retention bounds.
/// Missing owner means no copied answers or detached refresh, never an empty
/// successful copy or a substitute cache. Item reads are never offered here.
pub trait WorkspacePageCopies: Send + Sync {
    fn read(
        &self,
        context: DomainContext,
    ) -> SupplyFuture<Option<BTreeMap<String, WorkspaceAnswerEnvelope>>>;
    fn retain(
        &self,
        context: DomainContext,
        copied_paths: Vec<String>,
        revision_path: String,
        permit: WorkspacePermit,
        answers: RetentionFuture,
    );
}

#[derive(Clone)]
pub struct WorkspacePageProducer {
    shell: Arc<CapturedWorkspaceShell>,
    assets: Arc<WorkspaceAssets>,
    sessions: Arc<dyn CurrentSession>,
    api: Arc<dyn WorkspaceOperations>,
    copies: Option<Arc<dyn WorkspacePageCopies>>,
    settings: WorkspaceSessionSettings,
    kept_id: String,
    origin: String,
    limits: StreamLimits,
}

fn same_session(left: &WorkspaceSession, right: &WorkspaceSession) -> bool {
    left.account_id == right.account_id && left.session_id == right.session_id
}
fn session_copy(value: &WorkspaceSession) -> WorkspaceSession {
    WorkspaceSession {
        account_id: value.account_id.clone(),
        session_id: value.session_id.clone(),
    }
}
async fn confirm(
    sessions: Arc<dyn CurrentSession>,
    context: DomainContext,
) -> Result<(), WorkspaceError> {
    if context.permit.cancelled() {
        return Err(crate::cause!(WorkspaceError::Conflict));
    }
    let fresh = sessions
        .current(context.head.clone(), context.permit.clone())
        .await?;
    if !same_session(&fresh, &context.session) || context.permit.cancelled() {
        return Err(crate::cause!(WorkspaceError::Conflict));
    }
    Ok(())
}
fn repaint(head: &WorkspaceRequestHead) -> bool {
    head.headers
        .get("sec-fetch-dest")
        .is_some_and(|v| v == "empty")
        && !head
            .headers
            .get("sec-fetch-mode")
            .is_some_and(|v| v == "navigate")
        && !head
            .headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .contains("application/xhtml+xml")
}

impl WorkspacePageProducer {
    pub fn new(
        shell: Arc<CapturedWorkspaceShell>,
        assets: Arc<WorkspaceAssets>,
        origin: &str,
        first_answers: &[u8],
        first_identity: &str,
        sessions: Arc<dyn CurrentSession>,
        api: Arc<dyn WorkspaceOperations>,
        copies: Option<Arc<dyn WorkspacePageCopies>>,
        limits: StreamLimits,
    ) -> Result<Self, WorkspaceError> {
        let settings = WorkspaceSessionSettings::from_source(first_answers, first_identity)?;
        let data: Value =
            serde_json::from_slice(first_answers).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let kept_id = data
            .pointer("/kept/element_id")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            })
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .to_owned();
        shell.opening.render(origin)?;
        Ok(Self {
            shell,
            assets,
            origin: origin.into(),
            sessions,
            api,
            copies,
            settings,
            kept_id,
            limits,
        })
    }

    fn read(&self, context: DomainContext, path: String) -> ReadSpec {
        let api = self.api.clone();
        let sessions = self.sessions.clone();
        ReadSpec::new(
            path.clone(),
            false,
            Box::new(move || {
                Box::pin(async move {
                    if context.permit.cancelled() {
                        return Err(crate::cause!(WorkspaceError::Conflict));
                    }
                    let mut head = context.head.clone();
                    head.method = Method::GET;
                    head.uri = path.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
                    let response = api
                        .invoke(
                            session_copy(&context.session),
                            WorkspaceRequest {
                                head,
                                body: Bytes::new(),
                            },
                            context.permit.clone(),
                        )
                        .await
                        .unwrap_or_else(WorkspaceError::into_response);
                    let status = response.status().as_u16();
                    let next = response
                        .headers()
                        .get("x-trillion-next-before")
                        .map(|v| {
                            v.to_str()
                                .map(str::to_owned)
                                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
                        })
                        .transpose()?;
                    let coverage = response
                        .headers()
                        .get("x-trillion-collection-coverage")
                        .map(|v| {
                            crate::ecma_json::parse(
                                v.as_bytes(),
                                workspace_json_limits(MAX_READ_BYTES),
                            )
                            .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
                        })
                        .transpose()?;
                    let bytes = to_bytes(response.into_body(), MAX_READ_BYTES)
                        .await
                        .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
                    if context.permit.cancelled() {
                        return Err(crate::cause!(WorkspaceError::Conflict));
                    }
                    confirm(sessions, context.clone()).await?;
                    let body = match crate::ecma_json::parse(
                        &bytes,
                        workspace_json_limits(MAX_READ_BYTES),
                    ) {
                        Ok(value) => value,
                        Err(crate::ecma_json::Error::InvalidJson(_)) => crate::ecma_json::Value::Null,
                        Err(_) => return Err(crate::cause!(WorkspaceError::TooLarge)),
                    };
                    let mut value = crate::ecma_json::Object::new();
                    value.insert(
                        "status".into(),
                        crate::ecma_json::Value::Number(f64::from(status)),
                    );
                    value.insert("body".into(), body);
                    if let Some(next) = next {
                        value.insert(
                            "next_before".into(),
                            crate::ecma_json::Value::String(next.into()),
                        );
                    }
                    if let Some(coverage) = coverage {
                        value.insert("collection_coverage".into(), coverage);
                    }
                    Ok(Some(WorkspaceAnswerEnvelope::Ecma(
                        crate::ecma_json::Value::Object(value),
                    )))
                })
            }),
        )
    }

    async fn produce(
        self,
        context: DomainContext,
        startup: Arc<StartupContract>,
    ) -> Result<WorkspacePageResponse, WorkspaceError> {
        if context.head.method != Method::GET && context.head.method != Method::HEAD {
            return Err(crate::cause!(WorkspaceError::NotFound));
        }
        confirm(self.sessions.clone(), context.clone()).await?;
        // The Worker passes pathname only to screenAt for startup reads. The
        // browser's richer query-driven pane resolution remains its own owner.
        let screen = self
            .shell
            .routes
            .resolve(context.head.uri.path(), "")?
            .ok_or(crate::cause!(WorkspaceError::NotFound))?;
        let is_repaint = repaint(&context.head);
        let origin = self.sessions.origin_of(&context.head).unwrap_or_else(|| self.origin.clone());
        let document = self.shell.document(&origin, is_repaint)?;
        if is_repaint {
            return Ok(WorkspacePageResponse::Complete(WorkspacePage {
                document,
                screen_entry: screen.entry,
                listed_reads: vec![],
                item_reads: vec![],
                known: vec![],
                answers: vec![],
            }));
        }
        let plan = startup.plan(screen.startup_screen.as_deref(), &screen.input)?;
        let token = browser_token(&context.head).inspect_err(|error| {
            crate::quiet_eprintln!("workspace-refusal path={} cause={}", context.head.uri.path(), error.cause());
        })?;
        if blake3::hash(token.as_bytes()).to_hex().as_str() != context.session.session_id {
            return Err(crate::cause!(WorkspaceError::Unauthorized));
        }
        let raw_key = Zeroizing::new(blake3::derive_key(KEY_CONTEXT, token.as_bytes()));
        let key = Zeroizing::new(URL_SAFE_NO_PAD.encode(&raw_key[..]));
        let known = vec![
            (
                self.kept_id.clone(),
                json!({"store":self.settings.page_store(&context.session.account_id)?,"key":key.as_str()}),
            ),
            (
                "trillion-module-downloads".into(),
                self.assets
                    .manifest()
                    .get("module_downloads")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
        ];
        let revision = self.read(context.clone(), plan.revision.clone());
        let current = plan
            .listed_reads
            .iter()
            .filter(|path| *path != &plan.revision)
            .map(|path| self.read(context.clone(), path.clone()))
            .collect();
        let mut copied = Vec::new();
        let retention = if let Some(source) = self.copies.clone() {
            let opened =
                Arc::new(OnceCell::<Option<BTreeMap<String, WorkspaceAnswerEnvelope>>>::new());
            for path in &plan.copied_reads {
                let source = source.clone();
                let opened = opened.clone();
                let context = context.clone();
                let path = path.clone();
                let sessions = self.sessions.clone();
                copied.push(ReadSpec::new(
                    path.clone(),
                    true,
                    Box::new(move || {
                        Box::pin(async move {
                            let copy = opened
                                .get_or_init(|| async {
                                    source.read(context.clone()).await.ok().flatten()
                                })
                                .await;
                            confirm(sessions, context).await?;
                            Ok(copy
                                .as_ref()
                                .and_then(|map| map.get(&path))
                                .filter(|value| value.status() == Some(200) && value.has_body())
                                .cloned())
                        })
                    }),
                ));
            }
            let copied_paths = plan.copied_reads.clone();
            let revision_path = plan.revision.clone();
            let context = context.clone();
            Some(Box::new(move |permit, answers| {
                source.retain(context, copied_paths, revision_path, permit, answers)
            }) as crate::workspace_stream::RetentionOwner)
        } else {
            None
        };
        let sessions = self.sessions.clone();
        let confirm_context = context.clone();
        Ok(WorkspacePageResponse::Stream(WorkspaceStreamingPage {
            page: WorkspacePage {
                document,
                screen_entry: screen.entry,
                listed_reads: plan.listed_reads,
                item_reads: plan.item_reads,
                known,
                answers: vec![],
            },
            reads: WorkspaceReadBatch {
                confirm_session: Box::new(move || Box::pin(confirm(sessions, confirm_context))),
                revision,
                current,
                copies: copied,
                permit: context.permit,
                retention,
            },
            limits: self.limits,
        }))
    }
}

impl WorkspacePageOwner for WorkspacePageProducer {
    fn page_response(
        &self,
        context: DomainContext,
        startup: Arc<StartupContract>,
    ) -> SupplyFuture<WorkspacePageResponse> {
        let producer = self.clone();
        Box::pin(async move { producer.produce(context, startup).await })
    }
    fn page(&self, _: DomainContext, _: Arc<StartupContract>) -> SupplyFuture<WorkspacePage> {
        // A caller must use the typed streaming seam; collecting here would
        // reintroduce the head-behind-all-reads defect the original owner avoids.
        Box::pin(async { Err(crate::cause!(WorkspaceError::Unavailable)) })
    }
}
