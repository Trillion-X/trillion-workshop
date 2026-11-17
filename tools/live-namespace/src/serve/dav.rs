// src/serve/dav.rs
//
// Purpose: The person's files as a WebDAV folder on a loopback port, so Finder (Go, Connect to Server), a file browser or an editor
// mounts them by the names they were given and opens files where they are. Each request is one call of the door's `dav`
// operation (OPTIONS, PROPFIND, GET, HEAD: reads) or `dav_write` operation (PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK), so
// every rule of the folder (src/account_files/dav.rs, dav_write.rs) is the account files' own; this file carries the HTTP.
//
// Non-Negotiable Invariants:
// - It listens on 127.0.0.1 only. A request names that address or `localhost` as its Host, and a request a browser page sent
//   (it carries an Origin) is refused, so no web page can read or change the files through this port.
// - A body is read to at most the folder's own PUT bound (settings.json `dav.put_most_bytes`), never into an unbounded buffer.
// - A GET of a file larger than one answer carries is the file's bytes in order: the listener asks the folder for each range
//   in turn and sends it on, so a client that does not ask by range still gets the whole file, and no more than one range is
//   held at a time.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{settings::Dav, Namespace};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse as _, Response},
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use live_namespace::account_files::{settings::settings, READ_MAX_BYTES};
use serde_json::{json, Value};
use std::sync::Arc;

/// The request headers that become fields of the folder's operation, with the field each is.
const HEADER_FIELDS: [(&str, &str); 9] = [
    ("depth", "depth"),
    ("range", "range"),
    ("destination", "destination"),
    ("overwrite", "overwrite"),
    ("if-match", "if_match"),
    ("if-none-match", "if_none_match"),
    ("if", "if"),
    ("lock-token", "lock_token"),
    ("timeout", "timeout"),
];

/// The methods the folder answers by reading.
const READS: [&str; 4] = ["OPTIONS", "PROPFIND", "GET", "HEAD"];

struct App {
    namespace: Arc<Namespace>,
    prefix: String,
    port: u16,
}

/// Listen on `dav.port` of the loopback address until the process ends.
pub async fn serve(namespace: Arc<Namespace>, dav: &Dav) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", dav.port))
        .await
        .map_err(|error| format!("the WebDAV port {} does not open: {error}", dav.port))?;
    let app = Arc::new(App { namespace, prefix: dav.prefix.clone(), port: dav.port });
    let router = Router::new().fallback(handle).with_state(app);
    axum::serve(listener, router).await.map_err(|error| error.to_string())
}

fn plain(status: StatusCode, words: &'static str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], words).into_response()
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if parts.headers.contains_key(header::ORIGIN) {
        return plain(StatusCode::FORBIDDEN, "A page of a web site may not reach these files.");
    }
    let host_ok = parts.headers.get(header::HOST).and_then(|host| host.to_str().ok()).is_some_and(|host| {
        host == format!("127.0.0.1:{}", app.port) || host == format!("localhost:{}", app.port)
    });
    if !host_ok {
        return plain(StatusCode::MISDIRECTED_REQUEST, "These files answer at 127.0.0.1 only.");
    }
    let Some(below) = parts.uri.path().strip_prefix(app.prefix.as_str()).filter(|below| below.is_empty() || below.starts_with('/')) else {
        return plain(StatusCode::NOT_FOUND, "No such folder.");
    };
    let most = settings().dav.put_most_bytes;
    let Ok(body) = axum::body::to_bytes(body, most + 1).await else {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "The body is larger than one PUT keeps.");
    };
    if body.len() > most {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "The body is larger than one PUT keeps.");
    }
    let method = parts.method.as_str().to_ascii_uppercase();
    let mut input = json!({"prefix": app.prefix, "method": method, "path": below});
    for (header, field) in HEADER_FIELDS {
        if let Some(value) = parts.headers.get(header).and_then(|value| value.to_str().ok()) {
            input[field] = json!(value);
        }
    }
    if let Some(media) = parts.headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()) {
        input["content_type"] = json!(media);
    }
    if !body.is_empty() {
        input["body_base64"] = json!(BASE64.encode(&body));
    }
    let read = READS.contains(&method.as_str());
    let operation = if read { "dav" } else { "dav_write" };
    let answered = door(&app, operation, input.clone()).await;
    // A file larger than one answer carries, asked for whole: the folder answers it by range only, so the listener reads it
    // by range, in order.
    if (method == "GET" || method == "HEAD") && !parts.headers.contains_key(header::RANGE) {
        if let Ok(answer) = &answered {
            if answer["status"] == 416 {
                input["method"] = json!("GET");
                return whole_file(app, input, method == "HEAD").await;
            }
        }
    }
    match answered {
        Ok(answer) => response_of(&answer),
        Err(refusal) => refusal,
    }
}

/// One call of the door on a blocking thread: the folder's reads and writes wait on stores and the record file.
async fn door(app: &Arc<App>, operation: &'static str, input: Value) -> Result<Value, Response> {
    let namespace = app.namespace.clone();
    let ran = tokio::task::spawn_blocking(move || {
        namespace.call(operation, &input, Arc::new(|| true), &|_| true)
    })
    .await;
    match ran {
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(failure)) => {
            let (code, _) = failure.code();
            live_namespace::quiet_eprintln!("namespace-refusal code={code} cause={}", failure.cause());
            Err((StatusCode::SERVICE_UNAVAILABLE, [(header::CONTENT_TYPE, "application/json")], json!({"error": code}).to_string()).into_response())
        }
        Err(_) => Err(plain(StatusCode::SERVICE_UNAVAILABLE, "The call did not finish.")),
    }
}

/// The HTTP answer of the folder's answer: its status, headers and body.
fn response_of(answer: &Value) -> Response {
    let status = answer["status"].as_u64().and_then(|status| u16::try_from(status).ok()).and_then(|status| StatusCode::from_u16(status).ok());
    let body = answer["body_base64"].as_str().and_then(|encoded| BASE64.decode(encoded).ok());
    let (Some(status), Some(body)) = (status, body) else {
        return plain(StatusCode::BAD_GATEWAY, "The folder answered in a shape this listener does not know.");
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    for pair in answer["headers"].as_array().into_iter().flatten() {
        let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) else { continue };
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(value)) {
            response.headers_mut().append(name, value);
        }
    }
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A GET (or HEAD) with no range of a file larger than one answer carries: the folder answers 416 and names the file's length, so the
/// listener reads the first range (whose answer names the file's type and identity), answers 200 with the whole length, and
/// sends each later range as it is read.
async fn whole_file(app: Arc<App>, mut input: Value, head_only: bool) -> Response {
    let first = ranged(&app, &mut input, 0, READ_MAX_BYTES - 1).await;
    let Some((piece, total, headers)) = first else {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "The file could not be read.");
    };
    let mut response = Response::new(Body::empty());
    for name in ["content-type", "etag"] {
        if let Some(value) = headers.iter().find(|(known, _)| known.eq_ignore_ascii_case(name)).and_then(|(_, value)| HeaderValue::from_str(value).ok()) {
            response.headers_mut().insert(HeaderName::from_static(name), value);
        }
    }
    response.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(total));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if head_only {
        return response;
    }
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(1);
    tokio::spawn(async move {
        let mut at = piece.len() as u64;
        if sender.send(Ok(piece)).await.is_err() {
            return;
        }
        while at < total {
            let end = (at + READ_MAX_BYTES).min(total) - 1;
            let Some((piece, _, _)) = ranged(&app, &mut input, at, end).await else {
                let _ = sender.send(Err(std::io::Error::other("a range of the file did not read"))).await;
                return;
            };
            at += piece.len() as u64;
            if sender.send(Ok(piece)).await.is_err() {
                return;
            }
        }
    });
    *response.body_mut() = Body::from_stream(tokio_stream_of(receiver));
    response
}

/// One range of the file: its bytes, the file's whole length (from the answer's content-range) and the answer's headers.
async fn ranged(app: &Arc<App>, input: &mut Value, start: u64, end: u64) -> Option<(Vec<u8>, u64, Vec<(String, String)>)> {
    input["range"] = json!(format!("bytes={start}-{end}"));
    let answer = door(app, "dav", input.clone()).await.ok()?;
    if answer["status"] != 206 {
        return None;
    }
    let headers: Vec<(String, String)> = answer["headers"].as_array()?.iter().filter_map(|pair| Some((pair[0].as_str()?.to_owned(), pair[1].as_str()?.to_owned()))).collect();
    let total = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-range"))?.1.rsplit('/').next()?.parse::<u64>().ok()?;
    let piece = BASE64.decode(answer["body_base64"].as_str()?).ok()?;
    (!piece.is_empty()).then_some((piece, total, headers))
}

/// The ranges of a channel as a stream of body parts.
fn tokio_stream_of(mut receiver: tokio::sync::mpsc::Receiver<Result<Vec<u8>, std::io::Error>>) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures_util::stream::poll_fn(move |context| receiver.poll_recv(context))
}
