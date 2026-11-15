// src/server.rs
//
// Purpose: Adapt one host-configured record scope to authenticated loopback HTTP using an injected record supply.
//
// Non-Negotiable Invariants:
// - Reject client account/resource overrides and browser-origin admission.
// - Keep authentication and connection adaptation independent of SQL/provider implementation.
// - Run blocking supplied operations away from asynchronous workers and preserve page continuation.
//
// Key Concepts:
// - Owner-private bearer token, loopback Host and no-store responses.
// - Injected Records contract and bounded body/page responses.
//
// Security Considerations:
// - Require the configured private token and accepted loopback host before dispatch.
// - This trusted OS-user surface does not replace signed native-account rights.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Authenticated HTTP access to one configured account and resource.
//! Purpose: adapt fixed-scope record operations to authenticated loopback HTTP.
//! Invariants: no provider imports, client scope overrides, browser admission or
//! SQL in authentication. Blocking supplied operations stay off async workers.
//! Key concepts: the host injects Records; pages carry explicit continuation.
//! Security: owner-private bearer, loopback Host and no-store responses. This
//! OS-user surface does not issue or replace authenticated native account rights.
pub(crate) mod tool_http_response;

use crate::records::{Change, Error, Mutation, Page, Records};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{self, Read},
    path::Path as FilePath,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;

pub const MAX_BODY_BYTES: usize = 1024 * 1024 + 16 * 1024;
const MAX_PAGE_SIZE: usize = 100;

// Deliberately no Debug/Serialize: the bearer must never enter diagnostics.
pub struct ServerConfig {
    account: String,
    resource: String,
    bearer: Vec<u8>,
}

impl ServerConfig {
    pub fn from_token_file(
        account: impl Into<String>,
        resource: impl Into<String>,
        path: impl AsRef<FilePath>,
    ) -> io::Result<Self> {
        let account = account.into();
        let resource = resource.into();
        if [&account, &resource]
            .iter()
            .any(|v| v.is_empty() || v.len() > 4096 || v.contains('\0'))
        {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid fixed record scope",
            )));
        }
        let file = crate::io_operation!((File::open(path)).map_err(std::io::Error::from))?;
        let metadata = crate::io_operation!((file.metadata()).map_err(std::io::Error::from))?;
        if !metadata.is_file() || metadata.len() > 514 {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid bearer file",
            )));
        }
        // A computer without owner-only files cannot say the file is private (src/tool_runs/os.rs `OwnerFiles`).
        use crate::tool_runs::os::{OwnerFiles, This};
        if crate::io_operation!((This::mode_of(&metadata.permissions())).map_err(std::io::Error::from))? & 0o077 != 0 {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "bearer file must be private to its owner",
            )));
        }
        let mut bytes = Vec::new();
        crate::io_operation!((file.take(515).read_to_end(&mut bytes)).map_err(std::io::Error::from))?;
        if bytes.ends_with(b"\n") {
            bytes.pop();
            if bytes.ends_with(b"\r") {
                bytes.pop();
            }
        }
        if !(32..=512).contains(&bytes.len()) || !bytes.iter().all(|b| b.is_ascii_graphic()) {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bearer must contain 32..512 visible ASCII bytes",
            )));
        }
        Ok(Self {
            account,
            resource,
            bearer: bytes,
        })
    }
}

struct AppState {
    store: Mutex<Box<dyn Records>>,
    config: ServerConfig,
}
type Shared = Arc<AppState>;

pub fn route_table(store: impl Records + 'static, config: ServerConfig) -> Router {
    let state = Arc::new(AppState {
        store: Mutex::new(Box::new(store)),
        config,
    });
    Router::new()
        .route("/v1/records", get(list))
        .route("/v1/records/{id}", get(read).put(put).delete(delete))
        .route("/v1/changes", get(changes))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            authenticate,
        ))
        .with_state(state)
}

/// The supplied listener must already be bound to loopback. No provider is used.
pub async fn serve(
    listener: TcpListener,
    store: impl Records + 'static,
    config: ServerConfig,
) -> io::Result<()> {
    if !crate::io_operation!((listener.local_addr()).map_err(std::io::Error::from))?.ip().is_loopback() {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "record server requires a loopback listener",
        )));
    }
    crate::io_operation!(axum::serve(listener, route_table(store, config))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await)
}

fn local_host(request: &Request) -> Result<(), crate::refusal_cause::Cause> {
    let all_values = request.headers().get_all(header::HOST);
    let mut values = all_values.iter();
    let Some(value) = values.next() else {
        return Err(crate::cause!(condition: missing_local_host));
    };
    if values.next().is_some() {
        return Err(crate::cause!(condition: duplicate_local_host));
    }
    let Ok(host) = value.to_str() else {
        return Err(crate::cause!(condition: local_host_not_text));
    };
    let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
        return Err(crate::cause!(condition: local_host_not_authority));
    };
    if matches!(authority.host(), "127.0.0.1" | "[::1]" | "::1")
        || authority.host().eq_ignore_ascii_case("localhost") {
        Ok(())
    } else {
        Err(crate::cause!(condition: host_is_not_loopback))
    }
}

async fn authenticate(State(state): State<Shared>, request: Request, next: Next) -> Response {
    // Refuse browser origins and DNS-rebinding hosts, with no permissive CORS.
    if let Err(cause) = local_host(&request) {
        return ApiError(StatusCode::FORBIDDEN, "local native requests only", cause).into_response();
    }
    if request.headers().contains_key(header::ORIGIN) {
        return ApiError(StatusCode::FORBIDDEN, "local native requests only", crate::cause!(condition: browser_origin_present)).into_response();
    }
    let all_values = request.headers().get_all(header::AUTHORIZATION);
    let mut values = all_values.iter();
    let token = values
        .next()
        .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "));
    let refused = if values.next().is_some() {
        Some(crate::cause!(condition: duplicate_authorization))
    } else if let Some(token) = token {
        if token.len() != state.config.bearer.len() {
            Some(crate::cause!(condition: bearer_length_mismatch))
        } else if token.iter().zip(&state.config.bearer)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b)) != 0 {
            Some(crate::cause!(condition: bearer_bytes_mismatch))
        } else { None }
    } else {
        Some(crate::cause!(condition: bearer_missing_or_wrong_scheme))
    };
    if let Some(cause) = refused {
        let mut response = ApiError(StatusCode::UNAUTHORIZED, "bearer authentication required", cause).into_response();
        response.headers_mut().insert(header::WWW_AUTHENTICATE, axum::http::HeaderValue::from_static("Bearer"));
        return response;
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

struct ApiError(StatusCode, &'static str, crate::refusal_cause::Cause);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        crate::quiet_eprintln!("http-refusal status={} cause={}", self.0.as_u16(), self.2);
        (self.0, Json(json!({"error":self.1, "cause":self.2.id()}))).into_response()
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let cause = error.cause();
        match error {
            Error::Conflict(_) => Self(
                StatusCode::CONFLICT,
                "record version or request identity conflicts",
                cause,
            ),
            Error::Invalid(message, _) => Self(StatusCode::BAD_REQUEST, message, cause),
            Error::Refused(refusal, _) => {
                use crate::resource_authority::Refusal;
                let status = match refusal {
                    Refusal::InvalidMessage(_) => StatusCode::BAD_REQUEST,
                    Refusal::RouteChanged(_) | Refusal::DeadlineExpired(_) => StatusCode::CONFLICT,
                    Refusal::AuthorityUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
                    Refusal::ClientRevoked(_) => StatusCode::FORBIDDEN,
                    Refusal::DiskPressure(_) => StatusCode::INSUFFICIENT_STORAGE,
                };
                Self(status, "operation not admitted", cause)
            }
            Error::Unavailable(_) => {
                Self(StatusCode::SERVICE_UNAVAILABLE, "record supply unavailable", cause)
            }
            Error::OutcomeUnknown(cause) => Self(
                StatusCode::INTERNAL_SERVER_ERROR,
                "record outcome unknown; retry original request key",
                cause,
            ),
        }
    }
}

async fn database<T: Send + 'static>(
    state: Shared,
    operation: impl FnOnce(&mut dyn Records, &ServerConfig) -> Result<T, Error> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(move || {
        let mut store = state.store.lock().map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "record store unavailable",
                crate::cause!(tokens: record_store_lock),
            )
        })?;
        operation(store.as_mut(), &state.config).map_err(ApiError::from)
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "record worker unavailable",
            crate::cause!(tokens: record_worker_join),
        )
    })?
}

async fn read(State(state): State<Shared>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let result = database(state, move |store, config| {
        store.get(&config.account, &config.resource, &id)
    })
    .await?;
    let status = if result.record.is_some() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(result)).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutBody {
    expected_version: i64,
    request_key: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteBody {
    expected_version: i64,
    request_key: String,
}

async fn put(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(body): Json<PutBody>,
) -> Result<Json<Change>, ApiError> {
    database(state, move |store, config| {
        store.mutate(
            &config.account,
            &config.resource,
            Mutation {
                id,
                expected_version: body.expected_version,
                request_key: body.request_key,
                deleted: false,
                value: body.value,
            },
        )
    })
    .await
    .map(Json)
}
async fn delete(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(body): Json<DeleteBody>,
) -> Result<Json<Change>, ApiError> {
    database(state, move |store, config| {
        store.mutate(
            &config.account,
            &config.resource,
            Mutation {
                id,
                expected_version: body.expected_version,
                request_key: body.request_key,
                deleted: true,
                value: Value::Null,
            },
        )
    })
    .await
    .map(Json)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ListQuery {
    after: String,
    limit: Option<usize>,
    page: bool,
}
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ChangeQuery {
    after: i64,
    limit: Option<usize>,
    page: bool,
}
fn page_limit(limit: Option<usize>) -> Result<usize, ApiError> {
    let limit = limit.unwrap_or(50);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "page size must be 1..100",
            crate::cause!(tokens: page_limit_outside_bounds),
        ));
    }
    Ok(limit)
}
/// Existing callers retain array bodies. Every response exposes an explicit
/// JSON-encoded next cursor and item-byte count in headers; `page=true` opts in
/// to the complete page envelope, including supplied work observations.
fn page_response<T: Serialize, C: Serialize>(
    page: Page<T, C>,
    envelope: bool,
) -> Result<Response, ApiError> {
    let cursor = serde_json::to_string(&page.next).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid page continuation",
            crate::cause!(tokens: page_continuation_json),
        )
    })?;
    let cursor = axum::http::HeaderValue::from_bytes(cursor.as_bytes()).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid page continuation",
            crate::cause!(tokens: page_continuation_header),
        )
    })?;
    let bytes = axum::http::HeaderValue::from_str(&page.serialized_item_bytes.to_string())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "invalid page byte count", crate::cause!(tokens: page_bytes_header)))?;
    let mut response = if envelope {
        Json(page).into_response()
    } else {
        Json(page.items).into_response()
    };
    response
        .headers_mut()
        .insert("x-trillion-next-cursor", cursor);
    response
        .headers_mut()
        .insert("x-trillion-item-bytes", bytes);
    Ok(response)
}
async fn list(
    State(state): State<Shared>,
    Query(query): Query<ListQuery>,
) -> Result<Response, ApiError> {
    let limit = page_limit(query.limit)?;
    let page = database(state, move |store, config| {
        store.list_page(&config.account, &config.resource, &query.after, limit)
    })
    .await?;
    page_response(page, query.page)
}
async fn changes(
    State(state): State<Shared>,
    Query(query): Query<ChangeQuery>,
) -> Result<Response, ApiError> {
    let limit = page_limit(query.limit)?;
    let page = database(state, move |store, config| {
        store.changes_page(&config.account, &config.resource, query.after, limit)
    })
    .await?;
    page_response(page, query.page)
}
