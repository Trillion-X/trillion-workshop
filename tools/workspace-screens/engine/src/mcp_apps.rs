//! MCP Apps presentation adapter for the existing workspace and MCP SDK.
//!
//! This module owns no JSON-RPC transport, account, screen catalogue, renderer,
//! command journal or storage. The SDK supplies its authenticated request and
//! the canonical owner supplies the selected screen, workspace operation and
//! original renderer document. Missing supplies refuse; there are no successful
//! defaults. Program identities and wire tool names come from supplied DATA.
//!
//! An app-only tool is hidden from models by host metadata, not by an invented
//! authentication role. Every operation must still be authorized by its real
//! account owner. The bearer travels out of band and is never copied to headers,
//! page markup, tool output or a persistent session.

pub use crate::mcp::{FinalBodyCustody, RequestDisclosure};

use crate::mcp::{
    encode_bounded, encode_with_limit, Principal, MAX_MESSAGE_BYTES, MAX_RESOURCE_BYTES,
};
use content_crypto::advanced::blake3;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Uri};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

/// Tool identities belong to the actual composition, not a product-specific
/// branch in this generic presentation adapter.
pub struct Names {
    pub show: String,
    pub read: String,
    pub screen_key: String,
}

pub struct Config {
    names: Names,
    uri: String,
    words: Value,
    paths: Vec<String>,
    refused: Vec<String>,
    headers: BTreeSet<String>,
    text_types: Vec<String>,
}

/// One shared protocol adapter and its existing canonical owner. The SDK may
/// retain this binding; request credentials and account witnesses stay local
/// to each call, never in the binding itself.
pub struct Binding {
    pub config: Config,
    pub owner: Arc<dyn Owner>,
}

/// A transport failure may follow an actual effect, including one triggered
/// by a nominal GET. Preserve the owner's actual request key when available;
/// this layer never mints a second key or retries the operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    cause: crate::refusal_cause::Cause,
    pub code: &'static str,
    pub outcome_unknown: bool,
    pub request_key: Option<String>,
}
impl Failure {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause.clone() }
    pub fn invalid(cause: crate::refusal_cause::Cause) -> Self {
        Self {
            cause,
            code: "screen_input_invalid",
            outcome_unknown: false,
            request_key: None,
        }
    }
    pub fn unavailable(cause: crate::refusal_cause::Cause) -> Self {
        Self {
            cause,
            code: "screen_source_unavailable",
            outcome_unknown: false,
            request_key: None,
        }
    }
    pub fn unknown(request_key: Option<String>, cause: crate::refusal_cause::Cause) -> Self {
        Self {
            cause,
            code: "screen_outcome_unknown",
            outcome_unknown: true,
            request_key,
        }
    }
}
crate::impl_caused!(Failure);


/// Identity and credential are supplied only by the existing ingress. This DTO
/// does not confer authority: Owner must use the actual selected-account witness.
/// Deliberately no Debug/Serialize implementation: the bearer is private.
pub struct Context<'a> {
    pub principal: &'a Principal,
    pub bearer: &'a [u8],
    pub disclosure: &'a RequestDisclosure,
}
impl Context<'_> {
    pub fn cancellation_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.disclosure.cancellation_flag()
    }
    /// The consumer owns its existing work limit; this is only the fixed start.
    pub fn started_at(&self) -> std::time::Instant {
        self.disclosure.started_at()
    }
    pub fn retain_disclosure(&self, custody: Box<dyn FinalBodyCustody>) -> Result<(), Failure> {
        self.disclosure
            .register(custody)
            .map_err(|error| Failure::unavailable(error.cause()))
    }
}

/// Constructed only by the DATA filter below. No credential/header supplied by
/// an app can become the authenticated principal or the browser cookie.
pub struct WorkspaceRequest {
    path: String,
    method: Method,
    headers: HeaderMap,
    body: Vec<u8>,
    patchable: bool,
    have: Option<String>,
}
impl WorkspaceRequest {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn method(&self) -> &Method {
        &self.method
    }
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    pub fn patchable(&self) -> bool {
        self.patchable
    }
    pub fn have(&self) -> Option<&str> {
        self.have.as_deref()
    }
}

pub struct Screen {
    pub id: String,
    pub label: String,
    /// A valid screen need not have a browser route. Preserve the canonical
    /// screenFor null address instead of inventing a destination.
    pub address: Option<String>,
    pub input: Value,
    pub whole: bool,
    pub focused: bool,
}

/// Exact HTTP body bytes, not a parsed/reencoded record value. The canonical
/// owner retains its cancellation/current-source check through disclosure.
pub struct WorkspaceAnswer {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub request_key: Option<String>,
}
impl WorkspaceAnswer {
    /// The shared structured-content owner for workspace HTTP answers. Direct
    /// selected reads choose strict UTF-8 because their canonical JSON source
    /// is already valid UTF-8; ordinary HTTP reads retain their established
    /// lossy text behavior for arbitrary response bytes.
    pub(crate) fn structured_content(
        status: u16,
        content_type: &str,
        bytes: &[u8],
        request_key: Option<&str>,
        include_body: bool,
        textual: bool,
        strict_text: bool,
    ) -> Result<Value, Failure> {
        let mut body = json!({"status":status,"content_type":content_type});
        if let Some(key) = request_key {
            body["request_key"] = json!(key);
        }
        if include_body && status != 204 && status != 304 {
            if textual {
                let text = if strict_text {
                    std::str::from_utf8(bytes)
                        .map_err(|_| Failure::unavailable(crate::cause!(mcp_apps unavailable)))?
                        .to_owned()
                } else {
                    String::from_utf8_lossy(bytes).into_owned()
                };
                body["text"] = json!(text);
            } else {
                body["base64"] = json!(STANDARD.encode(bytes));
            }
        }
        Ok(body)
    }
}

/// The original shared-renderer output, already captured by its real frontend
/// owner. Checking a hash proves byte identity, not safe provenance or mounting;
/// the selected frontend owner must supply the actual protected capture pin.
pub struct Document {
    text: String,
    meta: Value,
}
impl Document {
    pub fn from_pinned(bytes: &[u8], pin: &str, meta: Value) -> Result<Self, Failure> {
        if bytes.len() > MAX_RESOURCE_BYTES
            || pin.len() != 64
            || blake3::hash(bytes).to_hex().as_str() != pin
            || !meta.is_object()
            || encode_bounded(&meta).is_none()
        {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?
            .to_owned();
        Ok(Self { text, meta })
    }
}

/// Each method is a required join to the current account/frontend owner. It
/// must retain the same actual source/rights witness through the operation and
/// result disclosure. This adapter adds no duplicate pre/post storage reads:
/// consistency belongs at that owner, under its held snapshot or commitment.
pub trait Owner: Send + Sync {
    /// Current account admission for private workspace presentation, through
    /// its canonical sign-in-use and resource-gate owners. Discovery and guessed
    /// calls both require it afresh; it must not dispatch the requested workspace
    /// operation. Canonical admission may register or renew its own gate state.
    /// The owner must refuse shared-only or withdrawn/unknown view reach;
    /// screen/workspace/document still retain their operation/disclosure checks.
    fn admit_view(&self, context: &Context<'_>) -> Result<(), Failure>;
    fn screen(&self, context: &Context<'_>, asked: &str, input: Value) -> Result<Screen, Failure>;
    fn workspace(
        &self,
        context: &Context<'_>,
        request: WorkspaceRequest,
    ) -> Result<WorkspaceAnswer, Failure>;
    fn document(&self, context: &Context<'_>) -> Result<Document, Failure>;
}

fn strings(value: &Value) -> Result<Vec<String>, Failure> {
    value
        .as_array()
        .ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))
        })
        .collect()
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, Failure> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))
}

impl Config {
    /// Consume the canonical screen-view DATA without physical includes or a
    /// hardcoded fallback catalogue. Names are the existing protocol composition.
    pub fn from_data(bytes: &[u8], pin: &str, names: Names) -> Result<Self, Failure> {
        if bytes.len() > MAX_MESSAGE_BYTES
            || pin.len() != 64
            || blake3::hash(bytes).to_hex().as_str() != pin
            || names.show.is_empty()
            || names.read.is_empty()
            || names.screen_key.is_empty()
            || names.show == names.read
            || [&names.show, &names.read, &names.screen_key]
                .iter()
                .any(|s| s.len() > 256 || s.bytes().any(|b| b < 32))
        {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let data: Value = serde_json::from_slice(bytes).map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
        let uri = data
            .pointer("/view/uri")
            .and_then(Value::as_str)
            .filter(|s| s.starts_with("ui://") && s.len() <= 1024)
            .ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?
            .to_owned();
        let words = data
            .get("words")
            .filter(|v| v.is_object())
            .ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?
            .clone();
        for key in [
            "title",
            "invoking",
            "invoked",
            "read_said",
            "request_refused",
            "outcome_unknown",
        ] {
            field(&words, key)?;
        }
        let reads = data.get("reads").ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
        let paths = strings(reads.get("paths").ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)?;
        let refused = strings(reads.get("refused_paths").ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)?;
        if paths.is_empty()
            || paths
                .iter()
                .chain(&refused)
                .any(|p| !p.starts_with('/') || p.starts_with("//") || !p.ends_with('/'))
        {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let headers: BTreeSet<_> = strings(reads.get("headers").ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)?
            .into_iter()
            .collect();
        // Program DATA can narrow presentation headers, never turn them into
        // a second credential or transport-authority channel.
        if headers.iter().any(|h| {
            !matches!(
                h.as_str(),
                "accept" | "content-type" | "range" | "x-time-zone" | "idempotency-key"
            )
        }) {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let text_types = strings(reads.get("text_types").ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)?;
        Ok(Self {
            names,
            uri,
            words,
            paths,
            refused,
            headers,
            text_types,
        })
    }

    pub fn tools(&self) -> Value {
        json!([
            {"name":self.names.show,"title":self.words["title"],
             "description":"Open the selected workspace screen in this chat.",
             "inputSchema":{"type":"object","required":["screen"],"additionalProperties":false,
                "properties":{"screen":{"type":"string"},"input":{"type":"object"}}},
             "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true},
             "_meta":{"ui":{"resourceUri":self.uri},"openai/outputTemplate":self.uri,
                 "openai/toolInvocation/invoking":self.words["invoking"],"openai/toolInvocation/invoked":self.words["invoked"]}},
            {"name":self.names.read,"description":"Read or change the selected workspace through the embedded app.",
             "inputSchema":{"type":"object","required":["path"],"additionalProperties":false,
                "properties":{"path":{"type":"string"},"method":{"type":"string"},"text":{"type":"string"},
                    "base64":{"type":"string"},"headers":{"type":"object","additionalProperties":{"type":"string"}},
                    "patchable":{"type":"boolean"},"have":{"type":"string"}}},
             "_meta":{"ui":{"visibility":["app"]},"openai/visibility":"private","openai/widgetAccessible":true}}
        ])
    }

    pub fn resources(&self) -> Value {
        json!([{"uri":self.uri,"name":self.words["title"],"mimeType":"text/html;profile=mcp-app"}])
    }

    /// GET is not assumed effect-free: the original waiting routes can write
    /// or hand work off while being read. The actual owner retains custody.
    pub fn is_workspace_tool(&self, name: &str) -> bool {
        name == self.names.read
    }

    /// None means the SDK should continue to its existing unrelated tool owner.
    /// Pass the SDK's request permit into detached work just as its resource call
    /// already does; this synchronous function does not spawn or retry work.
    pub fn call_tool(
        &self,
        owner: &dyn Owner,
        context: &Context<'_>,
        name: &str,
        input: Value,
    ) -> Option<Result<Value, Failure>> {
        if name != self.names.show && name != self.names.read {
            return None;
        }
        let result = self.call_known(owner, context, name, input);
        // The real shared bridge throws away isError results and classifies
        // throws as unreached. A known workspace outcome must instead travel
        // as its HTTP answer, so neither bridge nor API retry replays a POST.
        Some(match result {
            Err(failure) if self.is_workspace_tool(name) => Ok(self.failure_result(failure)),
            other => other,
        })
    }

    /// Used by this adapter and by the SDK's final-envelope/panic fallback.
    /// HTTP409 is final in the existing shared retry DATA. It preserves unknown
    /// custody without disguising an executed request as an unreachable call.
    pub fn failure_result(&self, failure: Failure) -> Value {
        crate::quiet_eprintln!("screen-refusal code={} cause={}", failure.code, failure.cause());
        let status = if failure.code == "screen_input_invalid" {
            400
        } else {
            409
        };
        let mut payload = json!({"error":self.words[if failure.outcome_unknown {"outcome_unknown"} else {"request_refused"}],
            "failure_code":failure.code,"cause":failure.cause().id(),"outcome":if failure.outcome_unknown {"unknown"} else {"not_started"}});
        if let Some(key) = &failure.request_key {
            payload["request_key"] = json!(key);
        }
        let mut answer =
            json!({"status":status,"content_type":"application/json","text":payload.to_string()});
        if let Some(key) = failure.request_key {
            answer["request_key"] = json!(key);
        }
        json!({"content":[{"type":"text","text":self.words["read_said"].as_str().unwrap_or("").replace("{status}",&status.to_string())}],
            "structuredContent":answer,"isError":false})
    }

    fn call_known(
        &self,
        owner: &dyn Owner,
        context: &Context<'_>,
        name: &str,
        input: Value,
    ) -> Result<Value, Failure> {
        if encode_bounded(&input).is_none() {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let fields = input.as_object().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
        if name == self.names.show {
            if fields
                .keys()
                .any(|k| !matches!(k.as_str(), "screen" | "input"))
            {
                return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
            }
            let asked = field(&input, "screen")?;
            let given = input.get("input").cloned().unwrap_or_else(|| json!({}));
            if !given.is_object() {
                return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
            }
            let screen = owner.screen(context, asked, given)?;
            if screen.id.is_empty()
                || screen.label.is_empty()
                || !screen.input.is_object()
                || screen.id.len() > 1024
                || screen.label.len() > 4096
                || encode_bounded(&screen.input).is_none()
                || screen.address.as_deref().is_some_and(|address| {
                    address.len() > 8192
                        || !address.starts_with('/')
                        || address.starts_with("//")
                        || address.contains(['\\', '\r', '\n'])
                })
            {
                return Err(Failure::unavailable(crate::cause!(mcp_apps unavailable)));
            }
            let mut descriptor = json!({"id":screen.id,"label":screen.label,"address":screen.address,"input":screen.input});
            if screen.whole {
                descriptor["whole"] = json!(true);
            }
            if screen.focused {
                descriptor["presentation"] = json!("focused");
            }
            let mut meta = serde_json::Map::new();
            meta.insert(self.names.screen_key.clone(), descriptor);
            let result = json!({"content":[{"type":"text","text":screen.label}],
                "structuredContent":{"shown":screen.label,"screen":screen.id,"address":screen.address,"open_path":screen.address},
                "_meta":meta,"isError":false});
            if encode_bounded(&result).is_none() {
                return Err(Failure::unavailable(crate::cause!(mcp_apps unavailable)));
            }
            return Ok(result);
        }
        let request = self.request(input)?;
        let head = request.method == Method::HEAD;
        let answer = owner.workspace(context, request)?;
        if !(200..=599).contains(&answer.status)
            || (!head
                && answer.status != 204
                && answer.status != 304
                && answer.body.len() > MAX_MESSAGE_BYTES)
            || answer.content_type.len() > 1024
        {
            return Err(Failure::unknown(answer.request_key, crate::cause!(mcp_apps outcome_unknown)));
        }
        let textual = answer.content_type.is_empty()
            || self
                .text_types
                .iter()
                .any(|s| answer.content_type.starts_with(s));
        // A full body is always a valid response to a patchable request. Do not
        // invent an identity or compute a second view-patch cache in this layer.
        // Keep actual command custody even on success: the SDK may still need
        // to replace this result when its full JSON-RPC envelope is too large.
        let body = WorkspaceAnswer::structured_content(
            answer.status,
            &answer.content_type,
            &answer.body,
            answer.request_key.as_deref(),
            !head,
            textual,
            false,
        )?;
        let said = field(&self.words, "read_said")?.replace("{status}", &answer.status.to_string());
        let result = json!({"content":[{"type":"text","text":said}],"structuredContent":body,"isError":false});
        if encode_bounded(&result).is_none() {
            return Err(Failure::unknown(answer.request_key, crate::cause!(mcp_apps outcome_unknown)));
        }
        Ok(result)
    }

    pub fn read_resource(
        &self,
        owner: &dyn Owner,
        context: &Context<'_>,
        uri: &str,
    ) -> Option<Result<Value, Failure>> {
        if uri != self.uri {
            return None;
        }
        Some(owner.document(context).and_then(|document| {
            let result = json!({"resultType":"complete","contents":[{"uri":self.uri,"mimeType":"text/html;profile=mcp-app","text":document.text,"_meta":document.meta}]});
            if encode_with_limit(&result, MAX_RESOURCE_BYTES).is_none() { return Err(Failure::unavailable(crate::cause!(mcp_apps unavailable))); }
            Ok(result)
        }))
    }

    fn request(&self, input: Value) -> Result<WorkspaceRequest, Failure> {
        let fields = input.as_object().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
        if fields.keys().any(|k| {
            !matches!(
                k.as_str(),
                "path" | "method" | "headers" | "text" | "base64" | "patchable" | "have"
            )
        }) {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let path = field(&input, "path")?;
        let uri: Uri = path.parse().map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
        if path.len() > 8192
            || !path.starts_with('/')
            || path.starts_with("//")
            || uri.scheme().is_some()
            || uri.authority().is_some()
            || path.contains(['\\', '#', '\r', '\n'])
        {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        // Decode only for policy validation, never rewrite the owner's request.
        // Reject routing ambiguities instead of authorizing a spelling which a
        // downstream route could interpret differently. Query bytes stay exact.
        let decoded = decoded_path(uri.path())?;
        if !self.paths.iter().any(|p| decoded.starts_with(p))
            || self.refused.iter().any(|p| decoded.starts_with(p))
        {
            return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
        }
        let method = match input.get("method") {
            None => Method::GET,
            Some(Value::String(s)) => Method::from_bytes(s.to_ascii_uppercase().as_bytes())
                .map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?,
            _ => return Err(Failure::invalid(crate::cause!(mcp_apps invalid))),
        };
        let mut headers = HeaderMap::new();
        if let Some(given) = input.get("headers") {
            for (name, value) in given.as_object().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))? {
                let name = name.to_ascii_lowercase();
                if self.headers.contains(&name) {
                    headers.insert(
                        HeaderName::from_bytes(name.as_bytes()).map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?,
                        HeaderValue::from_str(value.as_str().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)
                            .map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?,
                    );
                }
            }
        }
        if !headers.contains_key("accept") {
            headers.insert("accept", HeaderValue::from_static("application/json"));
        }
        let mut body = Vec::new();
        if method != Method::GET && method != Method::HEAD {
            if let Some(v) = input.get("base64") {
                body = STANDARD
                    .decode(v.as_str().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?)
                    .map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
            } else if let Some(v) = input.get("text") {
                body = v.as_str().ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?.as_bytes().to_vec();
            }
        }
        let patchable = match input.get("patchable") {
            None => false,
            Some(Value::Bool(v)) => *v,
            _ => return Err(Failure::invalid(crate::cause!(mcp_apps invalid))),
        };
        let have = input
            .get("have")
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid))))
            .transpose()?;
        Ok(WorkspaceRequest {
            path: path.to_owned(),
            method,
            headers,
            body,
            patchable,
            have,
        })
    }
}

fn decoded_path(path: &str) -> Result<String, Failure> {
    let mut out = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3).ok_or_else(|| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
            let hex = std::str::from_utf8(hex).map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
            let value = u8::from_str_radix(hex, 16).map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
            // Decode only unreserved route characters for the policy check.
            // Encoded separators/percent remain opaque argument bytes, as in
            // URL.pathname and the existing files filename route. They
            // must not become new routing segments in this adapter.
            if value.is_ascii_alphanumeric() || matches!(value, b'-' | b'.' | b'_' | b'~') {
                out.push(value);
            } else {
                out.extend_from_slice(&bytes[at..at + 3]);
            }
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    let out = String::from_utf8(out).map_err(|_| Failure::invalid(crate::cause!(mcp_apps invalid)))?;
    // One final slash is a normal collection route. Multiple trailing slashes
    // remain ambiguous, just like an empty interior segment.
    if out
        .strip_suffix('/')
        .unwrap_or(&out)
        .split('/')
        .skip(1)
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(Failure::invalid(crate::cause!(mcp_apps invalid)));
    }
    Ok(out)
}
