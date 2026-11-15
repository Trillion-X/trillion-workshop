use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
// `web_time::Instant` is `std::time::Instant` on native and wasi, and reads
// `performance.now()` on wasm32-unknown-unknown, where `std` time panics.
use web_time::Instant;

use base64::Engine;
use content_crypto::Multihash;
#[cfg(test)]
use execution_types::DEFAULT_PROCESS_TERMINATION_GRACE_MS;
use execution_types::{
    decode_process_result, ProductWordIds, ProcessContainmentRequest, ProcessDescriptor,
    ProcessInputMount, ProcessInputSource, ProcessNetworkAccess, ProcessTermination,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use slot_protocol::PartitionKey;
use ssrf_policy::is_private_ip;
use url::Url;
use zeroize::Zeroizing;

use crate::domain::types::{
    AddressedCallExternalBody, CallExternalBody, CallExternalRequest, CallExternalResponse,
    CredentialInjection, CredentialPlacement, OAuth2ClientCredentialUse, OAuth2RefreshedTokens,
    RequestAuthorization,
};
#[cfg(target_arch = "wasm32")]
use crate::slot_work::AsyncEnvelopeDispatch;
use crate::slot_work::EnvelopeDispatchFn;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Replaces every placed credential value a service echoes back in its reply.
const HELD_VALUE_TEXT: &str = "[held value]";
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpClientRuntimeConfig {
    /// The host's namespace word (its declared name), from which every process wire identity the transport
    /// encodes and decodes is derived. The host owns the word; this crate names no product.
    #[serde(deserialize_with = "execution_namespace_from_word")]
    pub execution_namespace: ProductWordIds,
    pub transport_target: String,
    pub transport_process: TransportProcessDescriptor,
    #[serde(default)]
    pub credential_resolver_target: Option<String>,
    #[serde(default)]
    pub credential_resolver_actor_id: Option<String>,
    #[serde(default)]
    pub url_grants: Vec<HttpClientUrlGrant>,
}

fn execution_namespace_from_word<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ProductWordIds, D::Error> {
    let word = String::deserialize(deserializer)?;
    ProductWordIds::new(&word).map_err(serde::de::Error::custom)
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HttpClientUrlGrant {
    pub id: String,
    pub context: Value,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allowed_schemes: Vec<String>,
    #[serde(default)]
    pub allow_loopback: bool,
    #[serde(default)]
    pub allow_private_networks: bool,
}

impl HttpClientRuntimeConfig {
    pub fn from_context(context: Option<&[u8]>) -> Result<Self, String> {
        let bytes = context.ok_or_else(|| {
            "http-client runtime config is required; transport target is not source-code law"
                .to_string()
        })?;
        let config: Self = serde_json::from_slice(bytes)
            .map_err(|e| format!("http-client runtime config decode failed: {e}"))?;
        if config.transport_target.trim().is_empty() {
            return Err("http-client runtime config transport_target cannot be empty".to_string());
        }
        config
            .transport_process
            .validate(&config.execution_namespace)?;
        if let Some(target) = &config.credential_resolver_target {
            if target.trim().is_empty() {
                return Err(
                    "http-client runtime config credential_resolver_target cannot be empty"
                        .to_string(),
                );
            }
        }
        validate_url_grant_config(&config.url_grants)?;
        Ok(config)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TransportProcessDescriptor {
    pub argv: Vec<String>,
    pub request_json_env_key: String,
    /// Optional relative file path used as response-file transport for the
    /// encoded request. When present, the request bytes are mounted here and
    /// the environment variable contains only `@file:<path>`. This avoids the
    /// operating-system argv/environment ceiling for large provider prompts.
    #[serde(default)]
    pub request_json_mount_path: Option<String>,
    /// Optional relative file path for a CAS-backed request body. When the
    /// request carries a `blob_ref`, the process owner mounts that hash here and
    /// the transport request contains only this path.
    #[serde(default)]
    pub body_mount_path: Option<String>,
    pub termination_grace_ms: u64,
    #[serde(default)]
    pub network_access: ProcessNetworkAccess,
    pub containment: ProcessContainmentRequest,
    pub capture_fds: Vec<u16>,
    #[serde(default)]
    pub timeout_padding_ms: u64,
}

impl TransportProcessDescriptor {
    fn validate(&self, execution_namespace: &ProductWordIds) -> Result<(), String> {
        if self.argv.is_empty() || self.argv.iter().any(|part| part.trim().is_empty()) {
            return Err("http-client transport process argv cannot be empty".to_string());
        }
        if self.request_json_env_key.trim().is_empty() {
            return Err(
                "http-client transport process request_json_env_key cannot be empty".to_string(),
            );
        }
        if self
            .request_json_mount_path
            .as_deref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err(
                "http-client transport process request_json_mount_path cannot be empty".to_string(),
            );
        }
        if self
            .body_mount_path
            .as_deref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err(
                "http-client transport process body_mount_path cannot be empty".to_string(),
            );
        }
        if self.body_mount_path.is_some() && self.body_mount_path == self.request_json_mount_path {
            return Err(
                "http-client transport process body_mount_path must differ from request_json_mount_path"
                    .to_string(),
            );
        }
        let validation_inputs = self
            .request_json_mount_path
            .as_ref()
            .map(|mount_path| ProcessInputMount {
                mount_path: mount_path.clone(),
                source: ProcessInputSource::Inline { bytes: Vec::new() },
                content_type: Some("application/json".to_string()),
                executable: false,
            })
            .into_iter()
            .collect();
        ProcessDescriptor {
            argv: self.argv.clone(),
            cwd: None,
            timeout_ms: 1,
            termination_grace_ms: self.termination_grace_ms,
            expected_termination: None,
            env: BTreeMap::new(),
            inputs: validation_inputs,
            input_trees: Vec::new(),
            outputs: Vec::new(),
            private_volume: None,
            readable_private_volumes: Vec::new(),
            network_access: self.network_access,
            containment: self.containment.clone(),
            capture_fds: self.capture_fds.clone(),
            collected_files: Vec::new(),
        }
        .validate(execution_namespace)
        .map_err(|error| format!("invalid http-client transport process template: {error}"))
    }
}

#[derive(Debug, Deserialize)]
struct VaultResolveResponse {
    success: bool,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Reply shape of the vault `read` op: mints an opaque handle from a stored key.
#[derive(Debug, Deserialize)]
struct VaultReadResponse {
    success: bool,
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Build the vault request payload for `read`/`resolve_handle` with the actor id.
fn vault_request_payload(
    operation: &str,
    key_field: &str,
    key_value: &str,
    config: &HttpClientRuntimeConfig,
) -> Result<Vec<u8>, String> {
    let mut request = serde_json::Map::new();
    request.insert(
        "operation".to_string(),
        serde_json::Value::String(operation.to_string()),
    );
    request.insert(
        key_field.to_string(),
        serde_json::Value::String(key_value.to_string()),
    );
    if let Some(actor_id) = &config.credential_resolver_actor_id {
        request.insert(
            "actor_id".to_string(),
            serde_json::Value::String(actor_id.clone()),
        );
    }
    serde_json::to_vec(&request)
        .map_err(|e| format!("http-client vault request encode failed: {e}"))
}

fn vault_resolver_target(config: &HttpClientRuntimeConfig) -> Result<&str, String> {
    config.credential_resolver_target.as_deref().ok_or_else(|| {
        "http-client request contained credential_injections but runtime config has no credential_resolver_target".to_string()
    })
}

#[derive(Debug, Serialize, Deserialize)]
struct TransportProcessRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_file: Option<String>,
    timeout_ms: u64,
    /// Carried through untouched. This slot never learns what delivering part
    /// of an answer means; the transport owner does.
    #[serde(skip_serializing_if = "Option::is_none")]
    deliver_parts_to: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct PreparedTransportBody {
    body_b64: Option<String>,
    body_file: Option<String>,
    input: Option<ProcessInputMount>,
}

#[derive(Debug, Deserialize)]
struct TransportProcessResponse {
    status_code: u16,
    #[serde(default)]
    headers: HashMap<String, String>,
    body_b64: String,
}

pub fn handle_call_external_request(
    payload: &[u8],
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<slot_protocol::QueryResult, String> {
    let request: CallExternalRequest = serde_json::from_slice(payload)
        .map_err(|e| format!("http-client request JSON parse failed: {e}"))?;
    let response = call_external(request, caller_context, partition_key, dispatch, config)?;
    let response_bytes = serde_json::to_vec(&response)
        .map_err(|e| format!("http-client response JSON serialize failed: {e}"))?;
    Ok(slot_protocol::QueryResult::read_only(Arc::from(
        response_bytes.into_boxed_slice(),
    )))
}

#[cfg(target_arch = "wasm32")]
pub async fn handle_call_external_request_async(
    payload: &[u8],
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<slot_protocol::QueryResult, String> {
    let request: CallExternalRequest = serde_json::from_slice(payload)
        .map_err(|e| format!("http-client request JSON parse failed: {e}"))?;
    let response =
        call_external_async(request, caller_context, partition_key, dispatch, config).await?;
    let response_bytes = serde_json::to_vec(&response)
        .map_err(|e| format!("http-client response JSON serialize failed: {e}"))?;
    Ok(slot_protocol::QueryResult::read_only(Arc::from(
        response_bytes.into_boxed_slice(),
    )))
}

fn call_external(
    request: CallExternalRequest,
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<CallExternalResponse, String> {
    let mut url = Url::parse(&request.url)
        .map_err(|e| format!("http-client invalid URL `{}`: {e}", request.url))?;
    validate_url_grant(&url, caller_context, config)?;

    let mut headers = request.headers.clone();
    // Each placed value is kept (zeroized on drop) only until the reply is
    // decoded, so an echo of it can be replaced before the reply leaves.
    let mut placed_values = Vec::with_capacity(request.credential_injections.len() + 1);
    let mut form_fields: Vec<(String, Zeroizing<String>)> = Vec::new();
    for injection in &request.credential_injections {
        let value = Zeroizing::new(resolve_injection_value(
            injection,
            partition_key,
            dispatch,
            config,
        )?);
        if let Some(field) = form_field(&injection.placement, &value)? {
            form_fields.push(field);
            placed_values.push(value);
            continue;
        }
        if let Some(token) =
            apply_credential_placement(&mut url, &mut headers, &injection.placement, &value)?
        {
            placed_values.push(token);
        }
        placed_values.push(value);
    }

    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let mut refreshed = None;
    if let Some(authorization) = &request.authorization {
        let context = RequestAuthorizationContext {
            caller_context,
            partition_key,
            dispatch,
            config,
            timeout_ms,
        };
        let (placed, tokens) =
            apply_request_authorization(&mut url, &mut headers, authorization, &context)?;
        placed_values.push(placed);
        refreshed = Some(tokens);
    }
    let prepared_body =
        prepare_transport_body(request.body.as_ref(), &form_fields, &headers, config)?;
    let transport_request = TransportProcessRequest {
        url: url.to_string(),
        method: request.method.to_string(),
        headers,
        body_b64: prepared_body.body_b64,
        body_file: prepared_body.body_file,
        timeout_ms,
        deliver_parts_to: request.deliver_parts_to.clone(),
    };

    execute_transport_process(
        transport_request,
        prepared_body.input,
        timeout_ms,
        partition_key,
        dispatch,
        config,
    )
    .map(|response| CallExternalResponse {
        refreshed,
        ..scrub_placed_values(response, &placed_values)
    })
    .map_err(|error| scrub_placed_text(&error, &placed_values))
}

#[cfg(target_arch = "wasm32")]
async fn call_external_async(
    request: CallExternalRequest,
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<CallExternalResponse, String> {
    let mut url = Url::parse(&request.url)
        .map_err(|e| format!("http-client invalid URL `{}`: {e}", request.url))?;
    validate_url_grant(&url, caller_context, config)?;

    let mut headers = request.headers.clone();
    // Each placed value is kept (zeroized on drop) only until the reply is
    // decoded, so an echo of it can be replaced before the reply leaves.
    let mut placed_values = Vec::with_capacity(request.credential_injections.len() + 1);
    let mut form_fields: Vec<(String, Zeroizing<String>)> = Vec::new();
    for injection in &request.credential_injections {
        let value = Zeroizing::new(
            resolve_injection_value_async(injection, partition_key, dispatch, config).await?,
        );
        if let Some(field) = form_field(&injection.placement, &value)? {
            form_fields.push(field);
            placed_values.push(value);
            continue;
        }
        if let Some(token) =
            apply_credential_placement(&mut url, &mut headers, &injection.placement, &value)?
        {
            placed_values.push(token);
        }
        placed_values.push(value);
    }

    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let mut refreshed = None;
    if let Some(authorization) = &request.authorization {
        let context = AsyncRequestAuthorizationContext {
            caller_context,
            partition_key,
            dispatch,
            config,
            timeout_ms,
        };
        let (placed, tokens) =
            apply_request_authorization_async(&mut url, &mut headers, authorization, &context)
                .await?;
        placed_values.push(placed);
        refreshed = Some(tokens);
    }
    let prepared_body =
        prepare_transport_body(request.body.as_ref(), &form_fields, &headers, config)?;
    let transport_request = TransportProcessRequest {
        url: url.to_string(),
        method: request.method.to_string(),
        headers,
        body_b64: prepared_body.body_b64,
        body_file: prepared_body.body_file,
        timeout_ms,
        deliver_parts_to: request.deliver_parts_to.clone(),
    };

    execute_transport_process_async(
        transport_request,
        prepared_body.input,
        timeout_ms,
        partition_key,
        dispatch,
        config,
    )
    .await
    .map(|response| CallExternalResponse {
        refreshed,
        ..scrub_placed_values(response, &placed_values)
    })
    .map_err(|error| scrub_placed_text(&error, &placed_values))
}

/// A `form_field` placement as one `(name, value)` pair for the request body;
/// every other placement is applied to the URL or headers instead.
fn form_field(
    placement: &CredentialPlacement,
    value: &str,
) -> Result<Option<(String, Zeroizing<String>)>, String> {
    let CredentialPlacement::FormField {
        name,
        prefix,
        suffix,
    } = placement
    else {
        return Ok(None);
    };
    if name.trim().is_empty() {
        return Err("http-client credential form field name cannot be empty".to_string());
    }
    Ok(Some((
        name.clone(),
        Zeroizing::new(format!("{prefix}{value}{suffix}")),
    )))
}

/// The inline body with the placed form fields appended. Refused unless the
/// request says its body is `application/x-www-form-urlencoded`.
fn body_with_form_fields(
    body: Option<&[u8]>,
    form_fields: &[(String, Zeroizing<String>)],
    headers: &HashMap<String, String>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let form = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type")
            && value
                .trim()
                .to_ascii_lowercase()
                .starts_with("application/x-www-form-urlencoded")
    });
    if !form {
        return Err(
            "http-client form_field placement needs content-type application/x-www-form-urlencoded"
                .to_string(),
        );
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in form_fields {
        serializer.append_pair(name, value);
    }
    let appended = Zeroizing::new(serializer.finish());
    let mut bytes = Zeroizing::new(body.map(<[u8]>::to_vec).unwrap_or_default());
    if !bytes.is_empty() {
        bytes.push(b'&');
    }
    bytes.extend_from_slice(appended.as_bytes());
    Ok(bytes)
}

fn prepare_transport_body(
    body: Option<&CallExternalBody>,
    form_fields: &[(String, Zeroizing<String>)],
    headers: &HashMap<String, String>,
    config: &HttpClientRuntimeConfig,
) -> Result<PreparedTransportBody, String> {
    if !form_fields.is_empty() {
        let inline = match body {
            None => None,
            Some(CallExternalBody::Inline(bytes)) => Some(bytes.as_slice()),
            Some(CallExternalBody::Addressed(_)) => {
                return Err(
                    "http-client form_field placement needs an inline body, not a blob_ref"
                        .to_string(),
                )
            }
        };
        let bytes = body_with_form_fields(inline, form_fields, headers)?;
        return Ok(PreparedTransportBody {
            body_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes.as_slice())),
            body_file: None,
            input: None,
        });
    }
    match body {
        None => Ok(PreparedTransportBody {
            body_b64: None,
            body_file: None,
            input: None,
        }),
        Some(CallExternalBody::Inline(bytes)) => Ok(PreparedTransportBody {
            body_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            body_file: None,
            input: None,
        }),
        Some(CallExternalBody::Addressed(AddressedCallExternalBody::BlobRef { hash })) => {
            Multihash::from_code_hex(hash)
                .map_err(|error| format!("http-client request body blob_ref invalid: {error}"))?;
            let mount_path = config
                .transport_process
                .body_mount_path
                .as_ref()
                .ok_or_else(|| {
                    "http-client request body used blob_ref but transport config has no body_mount_path"
                        .to_string()
                })?
                .clone();
            Ok(PreparedTransportBody {
                body_b64: None,
                body_file: Some(mount_path.clone()),
                input: Some(ProcessInputMount {
                    mount_path,
                    source: ProcessInputSource::BlobRef { hash: hash.clone() },
                    content_type: None,
                    executable: false,
                }),
            })
        }
    }
}

/// Resolve one injection to its plaintext value. When the injection carries a
/// `secret_name`, http-client mints a handle from it (vault `read`) then resolves
/// that handle — so a DATA caller never pre-mints. Otherwise the given handle is
/// resolved directly.
fn resolve_injection_value(
    injection: &CredentialInjection,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    if let Some(secret_name) = injection.secret_name.as_deref().filter(|s| !s.is_empty()) {
        let handle = mint_handle_from_secret(secret_name, partition_key, dispatch, config)?;
        resolve_credential_handle(&handle, partition_key, dispatch, config)
    } else {
        resolve_credential_handle(&injection.handle, partition_key, dispatch, config)
    }
}

/// Mint an opaque handle for a stored secret via the vault `read` op.
fn mint_handle_from_secret(
    secret_name: &str,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    let target = vault_resolver_target(config)?;
    let payload = vault_request_payload("read", "key", secret_name, config)?;
    let reply = dispatch(target, partition_key, Some(&payload))
        .map_err(|e| format!("http-client credential mint dispatch failed: {e}"))?;
    let response: VaultReadResponse = serde_json::from_slice(reply.as_ref())
        .map_err(|e| format!("http-client credential mint response decode failed: {e}"))?;
    if !response.success {
        return Err(format!(
            "http-client credential mint failed: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    response
        .handle
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "http-client credential mint returned no handle".to_string())
}

fn resolve_credential_handle(
    handle: &str,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    let target = config.credential_resolver_target.as_deref().ok_or_else(|| {
        "http-client request contained credential_injections but runtime config has no credential_resolver_target".to_string()
    })?;
    let mut request = serde_json::Map::new();
    request.insert(
        "operation".to_string(),
        serde_json::Value::String("resolve_handle".to_string()),
    );
    request.insert(
        "handle".to_string(),
        serde_json::Value::String(handle.to_string()),
    );
    if let Some(actor_id) = &config.credential_resolver_actor_id {
        request.insert(
            "actor_id".to_string(),
            serde_json::Value::String(actor_id.clone()),
        );
    }
    let payload = serde_json::to_vec(&request)
        .map_err(|e| format!("http-client credential resolve payload encode failed: {e}"))?;

    let reply = dispatch(target, partition_key, Some(&payload))
        .map_err(|e| format!("http-client credential resolve dispatch failed: {e}"))?;
    let response: VaultResolveResponse = serde_json::from_slice(reply.as_ref())
        .map_err(|e| format!("http-client credential resolve response decode failed: {e}"))?;
    if !response.success {
        return Err(format!(
            "http-client credential resolve failed: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    response
        .value
        .ok_or_else(|| "http-client credential resolve returned no value".to_string())
}

#[cfg(target_arch = "wasm32")]
async fn resolve_injection_value_async(
    injection: &CredentialInjection,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    if let Some(secret_name) = injection.secret_name.as_deref().filter(|s| !s.is_empty()) {
        let handle =
            mint_handle_from_secret_async(secret_name, partition_key, dispatch, config).await?;
        resolve_credential_handle_async(&handle, partition_key, dispatch, config).await
    } else {
        resolve_credential_handle_async(&injection.handle, partition_key, dispatch, config).await
    }
}

#[cfg(target_arch = "wasm32")]
async fn mint_handle_from_secret_async(
    secret_name: &str,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    let target = vault_resolver_target(config)?;
    let payload = vault_request_payload("read", "key", secret_name, config)?;
    let reply = dispatch
        .dispatch(target, partition_key, Some(&payload))
        .await
        .map_err(|e| format!("http-client credential mint dispatch failed: {e}"))?;
    let response: VaultReadResponse = serde_json::from_slice(reply.as_ref())
        .map_err(|e| format!("http-client credential mint response decode failed: {e}"))?;
    if !response.success {
        return Err(format!(
            "http-client credential mint failed: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    response
        .handle
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "http-client credential mint returned no handle".to_string())
}

#[cfg(target_arch = "wasm32")]
async fn resolve_credential_handle_async(
    handle: &str,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<String, String> {
    let target = config.credential_resolver_target.as_deref().ok_or_else(|| {
        "http-client request contained credential_injections but runtime config has no credential_resolver_target".to_string()
    })?;
    let mut request = serde_json::Map::new();
    request.insert(
        "operation".to_string(),
        serde_json::Value::String("resolve_handle".to_string()),
    );
    request.insert(
        "handle".to_string(),
        serde_json::Value::String(handle.to_string()),
    );
    if let Some(actor_id) = &config.credential_resolver_actor_id {
        request.insert(
            "actor_id".to_string(),
            serde_json::Value::String(actor_id.clone()),
        );
    }
    let payload = serde_json::to_vec(&request)
        .map_err(|e| format!("http-client credential resolve payload encode failed: {e}"))?;

    let reply = dispatch
        .dispatch(target, partition_key, Some(&payload))
        .await
        .map_err(|e| format!("http-client credential resolve dispatch failed: {e}"))?;
    let response: VaultResolveResponse = serde_json::from_slice(reply.as_ref())
        .map_err(|e| format!("http-client credential resolve response decode failed: {e}"))?;
    if !response.success {
        return Err(format!(
            "http-client credential resolve failed: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    response
        .value
        .ok_or_else(|| "http-client credential resolve returned no value".to_string())
}

/// Places `value` per `placement`. A placement that derives what it places
/// from the value (a signed token) returns the derived text, so an echo of it
/// can be scrubbed from the reply like the value itself.
fn apply_credential_placement(
    url: &mut Url,
    headers: &mut HashMap<String, String>,
    placement: &CredentialPlacement,
    value: &str,
) -> Result<Option<Zeroizing<String>>, String> {
    match placement {
        CredentialPlacement::Header {
            name,
            prefix,
            suffix,
        } => {
            if name.trim().is_empty() {
                return Err("http-client credential header name cannot be empty".to_string());
            }
            headers.insert(name.clone(), format!("{prefix}{value}{suffix}"));
        }
        CredentialPlacement::Query {
            name,
            prefix,
            suffix,
        } => {
            if name.trim().is_empty() {
                return Err("http-client credential query name cannot be empty".to_string());
            }
            let query_value = format!("{prefix}{value}{suffix}");
            url.query_pairs_mut().append_pair(name, &query_value);
        }
        CredentialPlacement::SignedToken {
            name,
            prefix,
            format,
            algorithm,
            key_id_separator,
            key_encoding,
            claims,
            lifetime_seconds,
        } => {
            if name.trim().is_empty() {
                return Err("http-client credential header name cannot be empty".to_string());
            }
            let now = web_time::SystemTime::now()
                .duration_since(web_time::UNIX_EPOCH)
                .map_err(|_| "http-client clock is before 1970".to_string())?
                .as_secs();
            let signed = Zeroizing::new(signed_token(
                value,
                format,
                algorithm,
                key_id_separator.as_deref(),
                key_encoding,
                claims,
                now,
                *lifetime_seconds,
            )?);
            headers.insert(name.clone(), format!("{prefix}{}", signed.as_str()));
            return Ok(Some(signed));
        }
        CredentialPlacement::FormField { .. } => {
            return Err(
                "http-client form_field placement goes into the request body; a token from an authorization step is placed in a header or query"
                    .to_string(),
            );
        }
    }
    Ok(None)
}

/// A JSON Web Token signed with HMAC-SHA256 over the held key, issued at `now`.
/// HMAC-SHA256 here is fixed by the token format the receiving service checks;
/// it is that protocol's signature, not an identity this system mints.
#[allow(clippy::too_many_arguments)]
fn signed_token(
    value: &str,
    format: &str,
    algorithm: &str,
    key_id_separator: Option<&str>,
    key_encoding: &str,
    claims: &serde_json::Map<String, Value>,
    now: u64,
    lifetime_seconds: u64,
) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    if format != "jwt" || algorithm != "HS256" {
        return Err(format!(
            "http-client can make a jwt signed with HS256; this placement asks for a {format} signed with {algorithm}"
        ));
    }
    let (key_id, key_text) = match key_id_separator {
        Some(separator) => value
            .split_once(separator)
            .map(|(id, key)| (Some(id), key))
            .ok_or_else(|| "the held value has no key id separator".to_string())?,
        None => (None, value),
    };
    let key = Zeroizing::new(match key_encoding {
        "hex" => hex::decode(key_text).map_err(|_| "the held key is not hex".to_string())?,
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(key_text)
            .map_err(|_| "the held key is not base64".to_string())?,
        "raw" => key_text.as_bytes().to_vec(),
        other => return Err(format!("unknown key_encoding `{other}`; use hex, base64 or raw")),
    });
    let url_b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let mut header = serde_json::Map::new();
    header.insert("alg".into(), serde_json::json!("HS256"));
    header.insert("typ".into(), serde_json::json!("JWT"));
    if let Some(id) = key_id {
        header.insert("kid".into(), serde_json::json!(id));
    }
    let mut payload = claims.clone();
    payload.insert("iat".into(), serde_json::json!(now));
    payload.insert("exp".into(), serde_json::json!(now + lifetime_seconds));
    let signing_input = format!(
        "{}.{}",
        url_b64(Value::Object(header).to_string().as_bytes()),
        url_b64(Value::Object(payload).to_string().as_bytes())
    );
    let mut mac = Hmac::<content_crypto::advanced::sha2::Sha256>::new_from_slice(&key)
        .map_err(|_| "the held key cannot be used for HMAC".to_string())?;
    mac.update(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", url_b64(&mac.finalize().into_bytes())))
}

struct RequestAuthorizationContext<'a> {
    caller_context: Option<&'a [u8]>,
    partition_key: &'a PartitionKey,
    dispatch: &'a EnvelopeDispatchFn,
    config: &'a HttpClientRuntimeConfig,
    timeout_ms: u64,
}

fn apply_request_authorization(
    url: &mut Url,
    headers: &mut HashMap<String, String>,
    authorization: &RequestAuthorization,
    context: &RequestAuthorizationContext<'_>,
) -> Result<(Zeroizing<String>, OAuth2RefreshedTokens), String> {
    match authorization {
        RequestAuthorization::OAuth2RefreshToken {
            token_url,
            client_id_handle,
            client_secret_handle,
            refresh_token_handle,
            required_scope_groups,
            granted_scopes_path,
            placement,
            client_credential_use,
        } => {
            let token_url = Url::parse(token_url)
                .map_err(|e| format!("http-client invalid OAuth2 token URL `{token_url}`: {e}"))?;
            validate_url_grant(&token_url, context.caller_context, context.config)?;

            let client_id = resolve_credential_handle(
                client_id_handle,
                context.partition_key,
                context.dispatch,
                context.config,
            )?;
            let client_secret = client_secret_handle
                .as_deref()
                .map(|handle| {
                    resolve_credential_handle(
                        handle,
                        context.partition_key,
                        context.dispatch,
                        context.config,
                    )
                })
                .transpose()?;
            let refresh_token = resolve_credential_handle(
                refresh_token_handle,
                context.partition_key,
                context.dispatch,
                context.config,
            )?;
            let (token_headers, body) = oauth2_refresh_token_parts(
                &client_id,
                client_secret.as_deref(),
                &refresh_token,
                client_credential_use,
            )?;
            drop(client_id);
            drop(client_secret);
            drop(refresh_token);

            let token_response = execute_transport_process(
                oauth2_refresh_token_request(token_url, token_headers, body, context.timeout_ms),
                None,
                context.timeout_ms,
                context.partition_key,
                context.dispatch,
                context.config,
            )?;
            let tokens = oauth2_tokens_from_response(
                &token_response,
                required_scope_groups,
                granted_scopes_path.as_deref(),
            )?;
            apply_credential_placement(url, headers, placement, &tokens.access_token)?;
            // The placed token is kept to scrub an echo of it from the reply;
            // the tokens themselves go back to the caller, who keeps them.
            Ok((Zeroizing::new(tokens.access_token.clone()), tokens))
        }
    }
}

#[cfg(target_arch = "wasm32")]
struct AsyncRequestAuthorizationContext<'a> {
    caller_context: Option<&'a [u8]>,
    partition_key: &'a PartitionKey,
    dispatch: &'a dyn AsyncEnvelopeDispatch,
    config: &'a HttpClientRuntimeConfig,
    timeout_ms: u64,
}

#[cfg(target_arch = "wasm32")]
async fn apply_request_authorization_async(
    url: &mut Url,
    headers: &mut HashMap<String, String>,
    authorization: &RequestAuthorization,
    context: &AsyncRequestAuthorizationContext<'_>,
) -> Result<(Zeroizing<String>, OAuth2RefreshedTokens), String> {
    match authorization {
        RequestAuthorization::OAuth2RefreshToken {
            token_url,
            client_id_handle,
            client_secret_handle,
            refresh_token_handle,
            required_scope_groups,
            granted_scopes_path,
            placement,
            client_credential_use,
        } => {
            let token_url = Url::parse(token_url)
                .map_err(|e| format!("http-client invalid OAuth2 token URL `{token_url}`: {e}"))?;
            validate_url_grant(&token_url, context.caller_context, context.config)?;

            let client_id = resolve_credential_handle_async(
                client_id_handle,
                context.partition_key,
                context.dispatch,
                context.config,
            )
            .await?;
            let client_secret = match client_secret_handle {
                Some(handle) => Some(
                    resolve_credential_handle_async(
                        handle,
                        context.partition_key,
                        context.dispatch,
                        context.config,
                    )
                    .await?,
                ),
                None => None,
            };
            let refresh_token = resolve_credential_handle_async(
                refresh_token_handle,
                context.partition_key,
                context.dispatch,
                context.config,
            )
            .await?;
            let (token_headers, body) = oauth2_refresh_token_parts(
                &client_id,
                client_secret.as_deref(),
                &refresh_token,
                client_credential_use,
            )?;
            drop(client_id);
            drop(client_secret);
            drop(refresh_token);

            let token_response = execute_transport_process_async(
                oauth2_refresh_token_request(token_url, token_headers, body, context.timeout_ms),
                None,
                context.timeout_ms,
                context.partition_key,
                context.dispatch,
                context.config,
            )
            .await?;
            let tokens = oauth2_tokens_from_response(
                &token_response,
                required_scope_groups,
                granted_scopes_path.as_deref(),
            )?;
            apply_credential_placement(url, headers, placement, &tokens.access_token)?;
            // The placed token is kept to scrub an echo of it from the reply;
            // the tokens themselves go back to the caller, who keeps them.
            Ok((Zeroizing::new(tokens.access_token.clone()), tokens))
        }
    }
}

fn oauth2_refresh_token_parts(
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    client_credential_use: &OAuth2ClientCredentialUse,
) -> Result<(HashMap<String, String>, Vec<u8>), String> {
    let mut headers = HashMap::from([
        ("accept".to_string(), "application/json".to_string()),
        (
            "content-type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ),
    ]);
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    match client_credential_use {
        OAuth2ClientCredentialUse::BodyFormFields => {
            form.append_pair("client_id", client_id);
            if let Some(client_secret) = client_secret {
                form.append_pair("client_secret", client_secret);
            }
        }
        OAuth2ClientCredentialUse::BasicAuthorizationHeader => {
            let client_secret = client_secret.ok_or_else(|| {
                "BHTTP_OAUTH2_CLIENT_SECRET_REQUIRED: basic_authorization_header requires client_secret_handle".to_string()
            })?;
            let credentials = format!("{client_id}:{client_secret}");
            let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
            headers.insert("authorization".to_string(), format!("Basic {encoded}"));
        }
    }
    form.append_pair("refresh_token", refresh_token);
    form.append_pair("grant_type", "refresh_token");
    Ok((headers, form.finish().into_bytes()))
}

fn oauth2_refresh_token_request(
    token_url: Url,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    timeout_ms: u64,
) -> TransportProcessRequest {
    TransportProcessRequest {
        url: token_url.to_string(),
        method: "POST".to_string(),
        headers,
        body_b64: Some(base64::engine::general_purpose::STANDARD.encode(body)),
        body_file: None,
        timeout_ms,
        // A token fetch is this slot's own errand and nobody is waiting to
        // read it, so it is never delivered in parts.
        deliver_parts_to: None,
    }
}

fn oauth2_tokens_from_response(
    response: &CallExternalResponse,
    required_scope_groups: &[Vec<String>],
    granted_scopes_path: Option<&[String]>,
) -> Result<OAuth2RefreshedTokens, String> {
    if response.status_code < 200 || response.status_code >= 300 {
        return Err(format!(
            "http-client OAuth2 refresh failed with status {}: {}",
            response.status_code,
            provider_body_preview(&response.body)
        ));
    }
    let body: Value = serde_json::from_slice(&response.body)
        .map_err(|e| format!("http-client OAuth2 refresh response JSON decode failed: {e}"))?;
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "http-client OAuth2 refresh response did not include access_token".to_string()
        })?
        .to_string();

    validate_oauth2_scope_groups(body.get("scope"), required_scope_groups)?;
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let expires_in = body.get("expires_in").and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
    });
    let granted_scopes = match granted_scopes_path {
        Some(path) => path
            .iter()
            .try_fold(&body, |at, part| at.get(part))
            .cloned(),
        None => body.get("scope").cloned(),
    };
    Ok(OAuth2RefreshedTokens {
        access_token,
        expires_in,
        refresh_token,
        granted_scopes,
    })
}

fn validate_oauth2_scope_groups(
    scope_value: Option<&Value>,
    required_scope_groups: &[Vec<String>],
) -> Result<(), String> {
    if required_scope_groups.is_empty() {
        return Ok(());
    }
    let granted_scopes: BTreeSet<String> = match scope_value {
        Some(Value::String(scope_text)) => scope_text
            .split_whitespace()
            .filter(|scope| !scope.trim().is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(Value::Array(scopes)) => scopes
            .iter()
            .filter_map(Value::as_str)
            .filter(|scope| !scope.trim().is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => BTreeSet::new(),
    };
    for group in required_scope_groups {
        if group.is_empty() {
            continue;
        }
        if !group.iter().any(|scope| granted_scopes.contains(scope)) {
            return Err(format!(
                "http-client OAuth2 refresh response missing required scope group: {}",
                group.join(" or ")
            ));
        }
    }
    Ok(())
}

fn provider_body_preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).replace(char::is_control, " ");
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() > 240 {
        format!("{}...", &collapsed[..240])
    } else {
        collapsed
    }
}

fn encode_transport_process_request(
    request_json: Vec<u8>,
    body_input: Option<ProcessInputMount>,
    timeout_ms: u64,
    config: &HttpClientRuntimeConfig,
) -> Result<Vec<u8>, String> {
    let (env_value, mut inputs) = match &config.transport_process.request_json_mount_path {
        Some(mount_path) => (
            format!("@file:{mount_path}"),
            vec![ProcessInputMount {
                mount_path: mount_path.clone(),
                source: ProcessInputSource::Inline {
                    bytes: request_json,
                },
                content_type: Some("application/json".to_string()),
                executable: false,
            }],
        ),
        None => (
            base64::engine::general_purpose::STANDARD.encode(request_json),
            Vec::new(),
        ),
    };
    if let Some(body_input) = body_input {
        inputs.push(body_input);
    }
    let descriptor = ProcessDescriptor {
        argv: config.transport_process.argv.clone(),
        cwd: None,
        timeout_ms: timeout_ms.saturating_add(config.transport_process.timeout_padding_ms),
        termination_grace_ms: config.transport_process.termination_grace_ms,
        // The retired ABI returned every exact exit/signal. The HTTP owner
        // preserves that receipt and translates nonzero termination below.
        expected_termination: None,
        env: BTreeMap::from([(
            config.transport_process.request_json_env_key.clone(),
            env_value,
        )]),
        inputs,
        input_trees: Vec::new(),
        outputs: Vec::new(),
        private_volume: None,
        readable_private_volumes: Vec::new(),
        network_access: config.transport_process.network_access,
        containment: config.transport_process.containment.clone(),
        capture_fds: config.transport_process.capture_fds.clone(),
        collected_files: Vec::new(),
    };
    execution_types::encode_process_descriptor(&config.execution_namespace, &descriptor)
        .map_err(|error| format!("http-client transport process payload encode failed: {error}"))
}

fn execute_transport_process(
    request: TransportProcessRequest,
    body_input: Option<ProcessInputMount>,
    timeout_ms: u64,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &HttpClientRuntimeConfig,
) -> Result<CallExternalResponse, String> {
    let request_json = serde_json::to_vec(&request)
        .map_err(|e| format!("http-client transport request encode failed: {e}"))?;
    let payload = encode_transport_process_request(request_json, body_input, timeout_ms, config)?;

    let start = Instant::now();
    let reply = dispatch(&config.transport_target, partition_key, Some(&payload))
        .map_err(|e| format!("http-client transport process dispatch failed: {e}"))?;
    let process_result = decode_process_result(&config.execution_namespace, reply.as_ref())
        .map_err(|e| format!("http-client transport process response decode failed: {e}"))?;
    if !matches!(
        process_result.termination,
        ProcessTermination::Exited { code: 0 }
    ) {
        return Err(format!(
            "http-client transport process failed: termination={:?} stderr={}",
            process_result.termination,
            String::from_utf8_lossy(
                process_result
                    .captured_fd(2)
                    .map(|capture| capture.bytes.as_slice())
                    .unwrap_or_default(),
            )
        ));
    }

    let stdout = process_result
        .captured_fd(1)
        .map(|capture| capture.bytes.as_slice())
        .unwrap_or_default();
    let process_response: TransportProcessResponse =
        serde_json::from_slice(stdout).map_err(|e| {
            format!(
                "http-client transport stdout decode failed: {e}; stdout preview={:?}",
                String::from_utf8_lossy(stdout)
                    .chars()
                    .take(256)
                    .collect::<String>()
            )
        })?;
    let body = base64::engine::general_purpose::STANDARD
        .decode(process_response.body_b64)
        .map_err(|e| format!("http-client transport body base64 decode failed: {e}"))?;

    Ok(CallExternalResponse {
        status_code: process_response.status_code,
        headers: process_response.headers,
        body,
        latency_ms: start.elapsed().as_millis() as u64,
        refreshed: None,
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
async fn execute_transport_process_async(
    request: TransportProcessRequest,
    body_input: Option<ProcessInputMount>,
    timeout_ms: u64,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<CallExternalResponse, String> {
    let request_json = serde_json::to_vec(&request)
        .map_err(|e| format!("http-client transport request encode failed: {e}"))?;
    let payload = encode_transport_process_request(request_json, body_input, timeout_ms, config)?;

    let start = Instant::now();
    let reply = dispatch
        .dispatch(&config.transport_target, partition_key, Some(&payload))
        .await
        .map_err(|e| format!("http-client transport process dispatch failed: {e}"))?;
    let process_result = decode_process_result(&config.execution_namespace, reply.as_ref())
        .map_err(|e| format!("http-client transport process response decode failed: {e}"))?;
    if !matches!(
        process_result.termination,
        ProcessTermination::Exited { code: 0 }
    ) {
        return Err(format!(
            "http-client transport process failed: termination={:?} stderr={}",
            process_result.termination,
            String::from_utf8_lossy(
                process_result
                    .captured_fd(2)
                    .map(|capture| capture.bytes.as_slice())
                    .unwrap_or_default(),
            )
        ));
    }

    let stdout = process_result
        .captured_fd(1)
        .map(|capture| capture.bytes.as_slice())
        .unwrap_or_default();
    let process_response: TransportProcessResponse =
        serde_json::from_slice(stdout).map_err(|e| {
            format!(
                "http-client transport stdout decode failed: {e}; stdout preview={:?}",
                String::from_utf8_lossy(stdout)
                    .chars()
                    .take(256)
                    .collect::<String>()
            )
        })?;
    let body = base64::engine::general_purpose::STANDARD
        .decode(process_response.body_b64)
        .map_err(|e| format!("http-client transport body base64 decode failed: {e}"))?;

    Ok(CallExternalResponse {
        status_code: process_response.status_code,
        headers: process_response.headers,
        body,
        latency_ms: start.elapsed().as_millis() as u64,
        refreshed: None,
    })
}

/// Web host (wasm32-unknown-unknown) transport. The host performs the request
/// itself (a Cloudflare Worker `fetch`), so no process runs and there is no
/// process descriptor or containment receipt to exchange. The host receives the
/// same `TransportProcessRequest` JSON the process transport script reads and
/// answers the same `TransportProcessResponse` JSON (`{status_code, headers,
/// body_b64}`) that script prints.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
async fn execute_transport_process_async(
    request: TransportProcessRequest,
    body_input: Option<ProcessInputMount>,
    _timeout_ms: u64,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &HttpClientRuntimeConfig,
) -> Result<CallExternalResponse, String> {
    if body_input.is_some() {
        return Err("http-client web host transport cannot send a blob_ref body: it needs a \
             content-store mount a web host does not have; send the body inline"
            .to_string());
    }
    let request_json = serde_json::to_vec(&request)
        .map_err(|e| format!("http-client transport request encode failed: {e}"))?;

    let start = Instant::now();
    let reply = dispatch
        .dispatch(&config.transport_target, partition_key, Some(&request_json))
        .await
        .map_err(|e| format!("http-client web host transport dispatch failed: {e}"))?;
    let transport_response: TransportProcessResponse = serde_json::from_slice(&reply)
        .map_err(|e| format!("http-client web host transport reply decode failed: {e}"))?;
    let body = base64::engine::general_purpose::STANDARD
        .decode(transport_response.body_b64)
        .map_err(|e| format!("http-client transport body base64 decode failed: {e}"))?;

    Ok(CallExternalResponse {
        status_code: transport_response.status_code,
        headers: transport_response.headers,
        body,
        latency_ms: start.elapsed().as_millis() as u64,
        refreshed: None,
    })
}

/// Every form a placed value can take when a service echoes it back: as placed,
/// and form-urlencoded (how a query placement travels). Longest first, so a
/// form that contains another is replaced whole.
fn held_value_forms(placed_values: &[Zeroizing<String>]) -> Vec<Zeroizing<Vec<u8>>> {
    let mut forms: Vec<Zeroizing<Vec<u8>>> = Vec::new();
    for value in placed_values.iter().filter(|value| !value.is_empty()) {
        let encoded = Zeroizing::new(
            url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>(),
        );
        for form in [
            Zeroizing::new(value.as_bytes().to_vec()),
            Zeroizing::new(encoded.as_bytes().to_vec()),
        ] {
            if !forms.iter().any(|known| known.as_slice() == form.as_slice()) {
                forms.push(form);
            }
        }
    }
    forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
    forms
}

fn replace_held_values(bytes: &[u8], forms: &[Zeroizing<Vec<u8>>]) -> Vec<u8> {
    let mut replaced = Vec::with_capacity(bytes.len());
    let mut index = 0;
    'scan: while index < bytes.len() {
        for form in forms {
            if bytes[index..].starts_with(form) {
                replaced.extend_from_slice(HELD_VALUE_TEXT.as_bytes());
                index += form.len();
                continue 'scan;
            }
        }
        replaced.push(bytes[index]);
        index += 1;
    }
    replaced
}

/// Replace every echo of a placed value in the reply body and header values.
fn scrub_placed_values(
    mut response: CallExternalResponse,
    placed_values: &[Zeroizing<String>],
) -> CallExternalResponse {
    let forms = held_value_forms(placed_values);
    if forms.is_empty() {
        return response;
    }
    response.body = replace_held_values(&response.body, &forms);
    for value in response.headers.values_mut() {
        *value = String::from_utf8_lossy(&replace_held_values(value.as_bytes(), &forms))
            .into_owned();
    }
    response
}

/// Replace every echo of a placed value in a failure message.
fn scrub_placed_text(text: &str, placed_values: &[Zeroizing<String>]) -> String {
    let forms = held_value_forms(placed_values);
    String::from_utf8_lossy(&replace_held_values(text.as_bytes(), &forms)).into_owned()
}

fn validate_url_grant_config(grants: &[HttpClientUrlGrant]) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    let mut context_hashes = BTreeSet::new();
    for grant in grants {
        let id = grant.id.trim();
        if id.is_empty() {
            return Err(
                "BHTTP_URL_GRANT_ID_EMPTY: http-client URL grant id cannot be empty".to_string(),
            );
        }
        if !ids.insert(id.to_string()) {
            return Err(format!(
                "BHTTP_URL_GRANT_ID_DUPLICATE: http-client URL grant id `{id}` is duplicated"
            ));
        }
        let context_hash = context_hash(&serde_json::to_vec(&grant.context).map_err(|e| {
            format!("BHTTP_URL_GRANT_CONTEXT_ENCODE_FAILED: http-client URL grant `{id}` context encode failed: {e}")
        })?);
        if !context_hashes.insert(context_hash) {
            return Err(format!(
                "BHTTP_URL_GRANT_CONTEXT_DUPLICATE: http-client URL grant `{id}` has a duplicated caller context"
            ));
        }
        for scheme in &grant.allowed_schemes {
            let scheme = scheme.trim().to_ascii_lowercase();
            match scheme.as_str() {
                "http" | "https" => {}
                "" => {
                    return Err(format!(
                        "BHTTP_URL_GRANT_SCHEME_EMPTY: http-client URL grant `{id}` has an empty scheme"
                    ));
                }
                other => {
                    return Err(format!(
                        "BHTTP_URL_GRANT_SCHEME_INVALID: http-client URL grant `{id}` has unsupported scheme `{other}`"
                    ));
                }
            }
        }
        for host in &grant.allowed_hosts {
            if normalize_host(host).is_empty() {
                return Err(format!(
                    "BHTTP_URL_GRANT_HOST_EMPTY: http-client URL grant `{id}` has an empty host"
                ));
            }
        }
    }
    Ok(())
}

fn validate_url_grant(
    url: &Url,
    caller_context: Option<&[u8]>,
    config: &HttpClientRuntimeConfig,
) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "BHTTP_URL_SCHEME_UNSUPPORTED: http-client unsupported URL scheme `{other}`"
            ));
        }
    }

    let host = url
        .host_str()
        .ok_or_else(|| format!("BHTTP_URL_HOST_MISSING: http-client URL has no host: {url}"))?;
    let host = normalize_host(host);

    let Some(caller_context) = caller_context else {
        return validate_default_url_guard(url, &host);
    };
    if caller_context.is_empty() {
        return Err(
            "BHTTP_CAPABILITY_CONTEXT_EMPTY: http-client caller context cannot be empty"
                .to_string(),
        );
    }

    let caller_context_hash = context_hash(caller_context);
    let grant = config
        .url_grants
        .iter()
        .find(|grant| {
            serde_json::to_vec(&grant.context)
                .map(|bytes| context_hash(&bytes) == caller_context_hash)
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            format!(
                "BHTTP_CAPABILITY_CONTEXT_UNDECLARED: http-client caller context `{caller_context_hash}` is not declared in URL grants"
            )
        })?;
    validate_selected_url_grant(url, &host, grant)
}

fn validate_default_url_guard(url: &Url, normalized_host: &str) -> Result<(), String> {
    if is_private_ip(url) || is_localhost_name(normalized_host) {
        return Err(format!(
            "BHTTP_URL_PRIVATE_BLOCKED: http-client default URL guard blocked private/internal host `{normalized_host}`"
        ));
    }

    Ok(())
}

fn validate_selected_url_grant(
    url: &Url,
    normalized_host: &str,
    grant: &HttpClientUrlGrant,
) -> Result<(), String> {
    if !grant.allowed_schemes.is_empty()
        && !grant
            .allowed_schemes
            .iter()
            .any(|scheme| scheme.eq_ignore_ascii_case(url.scheme()))
    {
        return Err(format!(
            "BHTTP_URL_GRANT_SCHEME_REJECTED: http-client URL grant `{}` does not admit scheme `{}`",
            grant.id,
            url.scheme()
        ));
    }

    if !grant.allowed_hosts.is_empty()
        && !grant
            .allowed_hosts
            .iter()
            .any(|allowed_host| normalize_host(allowed_host) == normalized_host)
    {
        return Err(format!(
            "BHTTP_URL_GRANT_HOST_REJECTED: http-client URL grant `{}` does not admit host `{normalized_host}`",
            grant.id
        ));
    }

    if is_private_ip(url) || is_localhost_name(normalized_host) {
        if grant.allow_loopback && is_loopback_host(normalized_host) {
            return Ok(());
        }
        if grant.allow_private_networks {
            return Ok(());
        }
        return Err(format!(
            "BHTTP_URL_GRANT_PRIVATE_REJECTED: http-client URL grant `{}` does not admit private/internal host `{normalized_host}`",
            grant.id
        ));
    }

    Ok(())
}

fn context_hash(bytes: &[u8]) -> String {
    Multihash::blake3(bytes).to_code_hex()
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

fn is_localhost_name(host: &str) -> bool {
    host == "localhost" || host == "localhost.localdomain" || host.ends_with(".localhost")
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "localhost.localdomain"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {

    #[test]
    fn form_field_placement_appends_the_value_to_a_form_body_and_nowhere_else() {
        let placement: crate::domain::types::CredentialPlacement = serde_json::from_value(
            serde_json::json!({ "kind": "form_field", "name": "refresh_token" }),
        )
        .unwrap();
        let field = super::form_field(&placement, "r&t=1").unwrap().expect("a form field");
        let mut headers = std::collections::HashMap::new();
        headers.insert(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        );
        let body = crate::domain::types::CallExternalBody::Inline(b"grant_type=refresh_token".to_vec());
        let config = test_runtime_config();
        let prepared =
            super::prepare_transport_body(Some(&body), &[field], &headers, &config).unwrap();
        let sent = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            prepared.body_b64.expect("an inline body"),
        )
        .unwrap();
        assert_eq!(sent, b"grant_type=refresh_token&refresh_token=r%26t%3D1");

        let mut url = url::Url::parse("https://auth.example/token").unwrap();
        assert!(
            super::apply_credential_placement(&mut url, &mut headers, &placement, "x").is_err(),
            "a form field never lands in the URL or headers"
        );
        assert_eq!(url.as_str(), "https://auth.example/token");

        let field = super::form_field(&placement, "v").unwrap().unwrap();
        let json = std::collections::HashMap::from([(
            "content-type".to_string(),
            "application/json".to_string(),
        )]);
        assert!(super::prepare_transport_body(None, &[field], &json, &config).is_err());

        let header: crate::domain::types::CredentialPlacement =
            serde_json::from_value(serde_json::json!({ "kind": "header", "name": "Authorization" }))
                .unwrap();
        assert!(super::form_field(&header, "v").unwrap().is_none());
    }

    #[test]
    fn signed_token_placement_makes_a_jwt_the_receiving_service_can_check() {
        let mut claims = serde_json::Map::new();
        claims.insert("aud".into(), serde_json::json!("/admin/"));
        let made = super::signed_token(
            "abc123:00112233445566778899aabbccddeeff",
            "jwt",
            "HS256",
            Some(":"),
            "hex",
            &claims,
            1_700_000_000,
            300,
        )
        .expect("a token");
        assert_eq!(
            made,
            "eyJhbGciOiJIUzI1NiIsImtpZCI6ImFiYzEyMyIsInR5cCI6IkpXVCJ9.eyJhdWQiOiIvYWRtaW4vIiwiZXhwIjoxNzAwMDAwMzAwLCJpYXQiOjE3MDAwMDAwMDB9.6n77Y_starTswZUUJj9jyW2amrVKtiuhdq72vDrlGN4"
        );
        assert!(super::signed_token("abc", "jwt", "RS256", None, "raw", &claims, 0, 1).is_err());
        assert!(super::signed_token("no-separator", "jwt", "HS256", Some(":"), "hex", &claims, 0, 1).is_err());
    }

    #[test]
    fn signed_token_placement_puts_only_the_token_in_the_header() {
        let mut url = url::Url::parse("https://site.example/ghost/api/admin/posts/").unwrap();
        let mut headers = std::collections::HashMap::new();
        let placement: crate::domain::types::CredentialPlacement = serde_json::from_value(serde_json::json!({
            "kind": "signed_token", "name": "Authorization", "prefix": "Ghost ", "format": "jwt", "algorithm": "HS256",
            "key_id_separator": ":", "key_encoding": "hex", "claims": { "aud": "/admin/" }, "lifetime_seconds": 300
        }))
        .unwrap();
        let placed = super::apply_credential_placement(&mut url, &mut headers, &placement, "abc123:00112233445566778899aabbccddeeff")
            .unwrap()
            .expect("the token is returned for scrubbing");
        let header = headers.get("Authorization").unwrap();
        assert_eq!(header, &format!("Ghost {}", placed.as_str()));
        assert!(!header.contains("00112233"));
    }
    use super::*;
    use crate::domain::types::{
        CredentialInjection, CredentialPlacement, OAuth2ClientCredentialUse, RequestAuthorization,
    };
    use execution_types::{
        seal_process_containment_receipt, NativeProcessContainmentReceipt, ProcessCapturedFd,
        ProcessCapturedFdIdentity, ProcessCodeIdentity, ProcessContainmentReceipt,
        ProcessFileGeneration, ProcessFileIdentity, ProcessResult, ProcessTermination,
        PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION,
    };

    const TEST_REQUEST_ENV: &str = "TRILLION_HTTP_CLIENT_REQUEST_B64";
    const TEST_REQUEST_MOUNT: &str = "trillion-http-client-request.json";

    fn successful_process_result(stdout: Vec<u8>) -> ProcessResult {
        // Every one of these is a DIFFERENT fact, so every one gets a DIFFERENT value. They were
        // two constants holding the identical all-zero string, reused across four distinct
        // fields, so any two could be swapped and no assertion here could tell. A fixture that
        // cannot distinguish the facts it stands for is not testing what it appears to test.
        const EXECUTABLE_CONTENT_HASH: &str =
            "1f:1111111111111111111111111111111111111111111111111111111111111111";
        const REQUEST_CONTENT_HASH: &str =
            "1f:2222222222222222222222222222222222222222222222222222222222222222";
        const ADMITTED_DESCRIPTOR_CONTENT_HASH: &str =
            "1f:3333333333333333333333333333333333333333333333333333333333333333";
        const SANDBOX_POLICY_CONTENT_HASH: &str =
            "1f:4444444444444444444444444444444444444444444444444444444444444444";
        const BOOT_SESSION_IDENTITY_CONTENT_HASH: &str =
            "1f:5555555555555555555555555555555555555555555555555555555555555555";

        let termination = ProcessTermination::Exited { code: 0 };
        let admitted_executable = ProcessFileIdentity {
            absolute_path: "/fixture/http-transport".to_string(),
            canonical_parent_path: "/fixture".to_string(),
            device_id: "1".to_string(),
            inode: "1".to_string(),
            generation: ProcessFileGeneration::Unavailable {
                platform: "fixture".to_string(),
                reason: "test evidence".to_string(),
            },
            link_count: "1".to_string(),
            byte_length: "1".to_string(),
            unix_mode: 0o755,
            birthtime_ns: "1".to_string(),
            ctime_ns: "1".to_string(),
            opened_no_follow: true,
            stable_readback: true,
            content_hash: EXECUTABLE_CONTENT_HASH.to_string(),
            code_identity: ProcessCodeIdentity::NotApplicable {
                reason: "test fixture".to_string(),
            },
        };
        let stdout_content_hash = Multihash::hash(&stdout).to_code_hex();
        let stderr_content_hash = Multihash::hash(&[]).to_code_hex();
        let captured_fds = vec![
            ProcessCapturedFd {
                fd: 1,
                bytes: stdout,
                content_hash: stdout_content_hash,
                eof_observed: true,
            },
            ProcessCapturedFd {
                fd: 2,
                bytes: Vec::new(),
                content_hash: stderr_content_hash,
                eof_observed: true,
            },
        ];
        let captured_fd_identities = captured_fds
            .iter()
            .map(|capture| ProcessCapturedFdIdentity {
                fd: capture.fd,
                byte_length: capture.bytes.len().to_string(),
                content_hash: capture.content_hash.clone(),
                eof_observed: capture.eof_observed,
            })
            .collect();

        let mut containment_receipt =
            ProcessContainmentReceipt::Native(Box::new(NativeProcessContainmentReceipt {
                schema: test_execution_namespace()
                    .containment_receipt_schema()
                    .to_string(),
                request_content_hash: REQUEST_CONTENT_HASH.to_string(),
                admitted_descriptor_content_hash: ADMITTED_DESCRIPTOR_CONTENT_HASH.to_string(),
                platform: "fixture".to_string(),
                enforcement_mechanism: "test-only".to_string(),
                full_computer_access: false,
                sandbox_policy_content_hash: SANDBOX_POLICY_CONTENT_HASH.to_string(),
                sandbox_applied_before_exec: true,
                network_denied: true,
                child_process_creation_denied: true,
                inherited_by_descendants: true,
                writable_roots: Vec::new(),
                direct_child_pid: 1,
                direct_child_start_seconds: "1".to_string(),
                direct_child_start_microseconds: "1".to_string(),
                boot_session_uuid: "00000000-0000-0000-0000-000000000000".to_string(),
                boot_session_identity_content_hash: BOOT_SESSION_IDENTITY_CONTENT_HASH.to_string(),
                admitted_executable,
                image_observations: Vec::new(),
                termination: termination.clone(),
                parent_reaped: true,
                captured_pipes_eof: true,
                captured_fds: captured_fd_identities,
                collected_file_identities: BTreeMap::new(),
                declared_output_integrity: BTreeMap::new(),
                immutable_publications: Vec::new(),
                checksum_canonicalization: PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION
                    .to_string(),
                checksum: String::new(),
            }));
        seal_process_containment_receipt(&test_execution_namespace(), &mut containment_receipt)
            .expect("seal fixture containment receipt");

        ProcessResult {
            termination: termination.clone(),
            captured_fds,
            outputs: Vec::new(),
            collected_files: Vec::new(),
            immutable_publications: Vec::new(),
            duration_ms: 0,
            containment_receipt,
        }
    }

    fn test_execution_namespace() -> ProductWordIds {
        ProductWordIds::new("example").expect("valid namespace word")
    }

    fn test_runtime_config() -> HttpClientRuntimeConfig {
        HttpClientRuntimeConfig {
            execution_namespace: test_execution_namespace(),
            transport_target: "compute.process".to_string(),
            transport_process: TransportProcessDescriptor {
                argv: vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    test_transport_script().to_string(),
                ],
                request_json_env_key: TEST_REQUEST_ENV.to_string(),
                request_json_mount_path: Some(TEST_REQUEST_MOUNT.to_string()),
                body_mount_path: Some("trillion-http-client-body.bin".to_string()),
                termination_grace_ms: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
                network_access: ProcessNetworkAccess::Allowed,
                containment: ProcessContainmentRequest::DescendantEffectContained {
                    pipe_eof_timeout_ms: 1_000,
                    publications: Vec::new(),
                },
                capture_fds: vec![1, 2],
                timeout_padding_ms: 5_000,
            },
            credential_resolver_target: Some("test-credential-resolver".to_string()),
            credential_resolver_actor_id: Some("test-http-client".to_string()),
            url_grants: Vec::new(),
        }
    }

    fn transport_request_from_process_descriptor(value: &Value) -> TransportProcessRequest {
        let descriptor: ProcessDescriptor =
            serde_json::from_value(value.clone()).expect("process descriptor");
        let request_bytes = if let Some(input) = descriptor
            .inputs
            .iter()
            .find(|input| input.mount_path == TEST_REQUEST_MOUNT)
        {
            assert_eq!(
                descriptor.env.get(TEST_REQUEST_ENV).map(String::as_str),
                Some("@file:trillion-http-client-request.json")
            );
            match &input.source {
                ProcessInputSource::Inline { bytes } => bytes.clone(),
                ProcessInputSource::BlobRef { .. }
                | ProcessInputSource::AddressedChunks { .. } => {
                    panic!("expected inline request file")
                }
            }
        } else {
            let encoded = descriptor
                .env
                .get(TEST_REQUEST_ENV)
                .expect("legacy request environment value");
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("legacy request base64")
        };
        serde_json::from_slice(&request_bytes).expect("transport request")
    }

    fn test_transport_script() -> &'static str {
        r#"
import base64
import json
import os
import sys
import urllib.error
import urllib.request

request_ref = os.environ["TRILLION_HTTP_CLIENT_REQUEST_B64"]
raw = open(request_ref[6:], "rb").read() if request_ref.startswith("@file:") else base64.b64decode(request_ref)
request = json.loads(raw.decode("utf-8"))
body_b64 = request.get("body_b64")
body_file = request.get("body_file")
body = open(body_file, "rb").read() if body_file is not None else (base64.b64decode(body_b64) if body_b64 is not None else None)
http_request = urllib.request.Request(
    request["url"],
    data=body,
    headers=request.get("headers") or {},
    method=request.get("method") or "GET",
)

try:
    response = urllib.request.urlopen(http_request, timeout=(request.get("timeout_ms") or 30000) / 1000)
except urllib.error.HTTPError as error:
    response = error
except Exception as error:
    sys.stderr.write(str(error))
    sys.exit(1)

with response:
    response_body = response.read()
    result = {
        "status_code": int(response.getcode()),
        "headers": dict(response.headers.items()),
        "body_b64": base64.b64encode(response_body).decode("ascii"),
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
"#
    }

    fn local_callback_context() -> Value {
        json!({
            "grant": "test.local-callback",
            "kind": "http-client-url-grant-context"
        })
    }

    fn context_bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("context should serialize")
    }

    #[test]
    fn runtime_config_requires_explicit_transport_target() {
        let error = HttpClientRuntimeConfig::from_context(None).expect_err("missing config");
        assert!(error.contains("runtime config is required"));

        let config = json!({
            "execution_namespace": "example",
            "transport_target": "",
            "transport_process": {
                "argv": ["python3", "-c", test_transport_script()],
                "request_json_env_key": TEST_REQUEST_ENV,
                "termination_grace_ms": 1000,
                "containment": {
                    "kind": "descendant_effect_contained",
                    "pipe_eof_timeout_ms": 1000,
                    "publications": []
                },
                "capture_fds": [1, 2],
                "timeout_padding_ms": 5000
            }
        });
        let bytes = serde_json::to_vec(&config).unwrap();
        let error = HttpClientRuntimeConfig::from_context(Some(&bytes)).expect_err("blank target");
        assert!(error.contains("transport_target"));

        let error = HttpClientRuntimeConfig::from_context(Some(
            br#"{"execution_namespace":"example","transport_target":"compute.process","transport_process":{"argv":[],"request_json_env_key":"REQ","termination_grace_ms":1000,"containment":{"kind":"descendant_effect_contained","pipe_eof_timeout_ms":1000,"publications":[]},"capture_fds":[1,2]}}"#,
        ))
        .expect_err("blank argv");
        assert!(error.contains("argv"));
    }

    #[test]
    fn large_transport_requests_use_response_file_instead_of_environment() {
        let config = test_runtime_config();
        let request_json = vec![b'x'; 1_048_576];
        let payload = encode_transport_process_request(request_json.clone(), None, 1_000, &config)
            .expect("encode large transport request");
        let descriptor: ProcessDescriptor =
            serde_json::from_slice(&payload).expect("process descriptor");

        assert_eq!(
            descriptor.env.get(TEST_REQUEST_ENV).map(String::as_str),
            Some("@file:trillion-http-client-request.json")
        );
        assert!(descriptor.env[TEST_REQUEST_ENV].len() < 64);
        assert_eq!(descriptor.inputs.len(), 1);
        assert_eq!(descriptor.inputs[0].mount_path, TEST_REQUEST_MOUNT);
        match &descriptor.inputs[0].source {
            ProcessInputSource::Inline { bytes } => assert_eq!(bytes, &request_json),
            ProcessInputSource::BlobRef { .. }
            | ProcessInputSource::AddressedChunks { .. } => {
                panic!("expected inline response file")
            }
        }
    }

    #[test]
    fn transport_result_uses_the_callers_namespace_and_refuses_a_different_one() {
        let mut config = test_runtime_config();
        let partition = PartitionKey::hash_from("test");
        let stdout = serde_json::to_vec(&json!({
            "status_code": 200, "headers": {}, "body_b64": ""
        })).unwrap();
        let result = successful_process_result(stdout);
        let reply = serde_json::to_vec(&result).unwrap();
        let dispatch = move |_target: &str, _partition: &PartitionKey, _payload: Option<&[u8]>|
            -> Result<Arc<[u8]>, String> { Ok(Arc::from(reply.clone().into_boxed_slice())) };
        let request = || TransportProcessRequest {
            url: "https://api.example.com/items".to_string(), method: "GET".to_string(),
            headers: HashMap::new(), body_b64: None, body_file: None,
            timeout_ms: 1000, deliver_parts_to: None,
        };
        assert_eq!(execute_transport_process(request(), None, 1000, &partition, &dispatch, &config)
            .expect("matching caller namespace").status_code, 200);
        config.execution_namespace = ProductWordIds::new("another").unwrap();
        let error = execute_transport_process(request(), None, 1000, &partition, &dispatch, &config)
            .expect_err("the same process result belongs to a different namespace");
        assert!(error.contains("response decode failed"), "{error}");
    }

    #[test]
    fn legacy_transport_config_without_mount_path_remains_decodable() {
        let mut config = test_runtime_config();
        config.transport_process.request_json_mount_path = None;
        let request_json = br#"{"legacy":true}"#.to_vec();
        let payload = encode_transport_process_request(request_json.clone(), None, 1_000, &config)
            .expect("encode legacy transport request");
        let descriptor: ProcessDescriptor =
            serde_json::from_slice(&payload).expect("process descriptor");

        assert!(descriptor.inputs.is_empty());
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&descriptor.env[TEST_REQUEST_ENV])
            .expect("legacy base64");
        assert_eq!(decoded, request_json);
    }

    #[test]
    fn resolves_header_credential_and_dispatches_configured_process_target() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request = CallExternalRequest {
            url: "https://api.example.com/models".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: vec![CredentialInjection {
                handle: "opaque".to_string(),
                secret_name: None,
                placement: CredentialPlacement::Header {
                    name: "Authorization".to_string(),
                    prefix: "Bearer ".to_string(),
                    suffix: String::new(),
                },
            }],
            authorization: None,
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = move |target: &str,
                             _partition: &PartitionKey,
                             payload: Option<&[u8]>|
              -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    assert_eq!(value["operation"], "resolve_handle");
                    assert_eq!(value["handle"], "opaque");
                    assert_eq!(value["actor_id"], "test-http-client");
                    Ok(Arc::from(
                        serde_json::to_vec(&json!({"success": true, "value": "secret"}))
                            .unwrap()
                            .into_boxed_slice(),
                    ))
                }
                "compute.process" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    assert_eq!(value["argv"][0], "python3");
                    assert_eq!(value["termination_grace_ms"], 1_000);
                    assert!(value["expected_termination"].is_null());
                    assert_eq!(value["network_access"], "allowed");
                    assert_eq!(
                        value["containment"],
                        json!({
                            "kind": "descendant_effect_contained",
                            "pipe_eof_timeout_ms": 1_000,
                            "publications": []
                        })
                    );
                    assert_eq!(value["capture_fds"], json!([1, 2]));
                    assert!(value.get("sandbox_profile").is_none());
                    assert!(value.get("capture_stdout").is_none());
                    assert!(value.get("capture_stderr").is_none());
                    let transport = transport_request_from_process_descriptor(&value);
                    assert_eq!(
                        transport.headers.get("Authorization").map(String::as_str),
                        Some("Bearer secret")
                    );
                    let stdout = serde_json::to_vec(&json!({
                        "status_code": 200,
                        "headers": {"content-type": "application/json"},
                        "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"ok":true}"#)
                    }))
                    .unwrap();
                    let result = successful_process_result(stdout);
                    Ok(Arc::from(
                        serde_json::to_vec(&result).unwrap().into_boxed_slice(),
                    ))
                }
                other => Err(format!("unexpected target {other}")),
            }
        };

        let result =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect("query");
        let response: CallExternalResponse =
            serde_json::from_slice(result.response.as_ref()).expect("response");
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, br#"{"ok":true}"#);
    }

    fn echo_test_request() -> CallExternalRequest {
        CallExternalRequest {
            url: "https://api.example.com/echo".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: vec![
                CredentialInjection {
                    handle: "header-handle".to_string(),
                    secret_name: None,
                    placement: CredentialPlacement::Header {
                        name: "Authorization".to_string(),
                        prefix: "Bearer ".to_string(),
                        suffix: String::new(),
                    },
                },
                CredentialInjection {
                    handle: "query-handle".to_string(),
                    secret_name: None,
                    placement: CredentialPlacement::Query {
                        name: "key".to_string(),
                        prefix: String::new(),
                        suffix: String::new(),
                    },
                },
            ],
            authorization: None,
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        }
    }

    fn resolve_echo_test_handle(payload: Option<&[u8]>) -> Result<Arc<[u8]>, String> {
        let value: serde_json::Value = serde_json::from_slice(payload.unwrap()).unwrap();
        let secret = match value["handle"].as_str() {
            Some("header-handle") => "sk_header_value_42",
            Some("query-handle") => "query value/+&=",
            other => return Err(format!("unexpected handle {other:?}")),
        };
        Ok(Arc::from(
            serde_json::to_vec(&json!({"success": true, "value": secret}))
                .unwrap()
                .into_boxed_slice(),
        ))
    }

    #[test]
    fn placed_value_echoed_by_the_service_is_replaced_in_the_reply() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request_bytes = serde_json::to_vec(&echo_test_request()).unwrap();
        let dispatch = move |target: &str,
                             _partition: &PartitionKey,
                             payload: Option<&[u8]>|
              -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => resolve_echo_test_handle(payload),
                "compute.process" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let transport = transport_request_from_process_descriptor(&value);
                    let authorization = transport.headers["Authorization"].clone();
                    assert_eq!(authorization, "Bearer sk_header_value_42");
                    assert!(transport.url.contains("key=query+value%2F%2B%26%3D"));
                    // The service echoes the whole request back: the URL (encoded
                    // query value), the header, and the raw query value.
                    let echoed_body = format!(
                        "url={} auth={} raw=query value/+&=",
                        transport.url, authorization
                    );
                    let stdout = serde_json::to_vec(&json!({
                        "status_code": 401,
                        "headers": {"x-echo-authorization": authorization},
                        "body_b64": base64::engine::general_purpose::STANDARD.encode(echoed_body)
                    }))
                    .unwrap();
                    Ok(Arc::from(
                        serde_json::to_vec(&successful_process_result(stdout))
                            .unwrap()
                            .into_boxed_slice(),
                    ))
                }
                other => Err(format!("unexpected target {other}")),
            }
        };

        let result =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect("query");
        let raw_reply = String::from_utf8(result.response.to_vec()).unwrap();
        let response: CallExternalResponse = serde_json::from_slice(result.response.as_ref())
            .expect("response");
        let body = String::from_utf8(response.body.clone()).unwrap();
        assert_eq!(response.status_code, 401);
        assert_eq!(
            body,
            "url=https://api.example.com/echo?key=[held value] auth=Bearer [held value] raw=[held value]"
        );
        assert_eq!(
            response.headers["x-echo-authorization"],
            "Bearer [held value]"
        );
        for form in ["sk_header_value_42", "query value/+&=", "query+value%2F%2B%26%3D"] {
            assert!(!raw_reply.contains(form), "reply still holds {form}");
            assert!(!body.contains(form), "body still holds {form}");
        }
    }

    #[test]
    fn placed_value_echoed_in_a_transport_failure_is_replaced_in_the_error() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request_bytes = serde_json::to_vec(&echo_test_request()).unwrap();
        let dispatch = move |target: &str,
                             _partition: &PartitionKey,
                             payload: Option<&[u8]>|
              -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => resolve_echo_test_handle(payload),
                "compute.process" => Err("refused Authorization: Bearer sk_header_value_42".into()),
                other => Err(format!("unexpected target {other}")),
            }
        };

        let error =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect_err("transport failure");
        assert!(error.contains("Bearer [held value]"), "{error}");
        assert!(!error.contains("sk_header_value_42"), "{error}");
    }

    #[test]
    fn blob_body_and_credential_compose_without_expanding_body_into_transport_json() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let body_hash = Multihash::blake3(b"provider request body").to_code_hex();
        let request = CallExternalRequest {
            url: "https://api.example.com/messages".to_string(),
            method: "POST".parse().unwrap(),
            headers: HashMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: Some(CallExternalBody::Addressed(
                AddressedCallExternalBody::BlobRef {
                    hash: body_hash.clone(),
                },
            )),
            credential_injections: vec![CredentialInjection {
                handle: "opaque".to_string(),
                secret_name: None,
                placement: CredentialPlacement::Header {
                    name: "x-api-key".to_string(),
                    prefix: String::new(),
                    suffix: String::new(),
                },
            }],
            authorization: None,
            timeout_ms: Some(1_000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = move |target: &str,
                             _partition: &PartitionKey,
                             payload: Option<&[u8]>|
              -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => Ok(Arc::from(
                    serde_json::to_vec(&json!({"success": true, "value": "secret"}))
                        .unwrap()
                        .into_boxed_slice(),
                )),
                "compute.process" => {
                    let descriptor: ProcessDescriptor =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let transport_value = serde_json::to_value(&descriptor).unwrap();
                    let transport = transport_request_from_process_descriptor(&transport_value);
                    assert_eq!(transport.body_b64, None);
                    assert_eq!(
                        transport.body_file.as_deref(),
                        Some("trillion-http-client-body.bin")
                    );
                    assert_eq!(
                        transport.headers.get("x-api-key").map(String::as_str),
                        Some("secret")
                    );
                    let body_mount = descriptor
                        .inputs
                        .iter()
                        .find(|input| input.mount_path == "trillion-http-client-body.bin")
                        .expect("CAS body mount");
                    assert_eq!(
                        body_mount.source,
                        ProcessInputSource::BlobRef {
                            hash: body_hash.clone()
                        }
                    );
                    let stdout = serde_json::to_vec(&json!({
                        "status_code": 200,
                        "headers": {"content-type": "application/json"},
                        "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"id":"provider-response"}"#)
                    }))
                    .unwrap();
                    Ok(Arc::from(
                        serde_json::to_vec(&successful_process_result(stdout))
                            .unwrap()
                            .into_boxed_slice(),
                    ))
                }
                other => Err(format!("unexpected target {other}")),
            }
        };

        let result =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect("query");
        let response: CallExternalResponse =
            serde_json::from_slice(result.response.as_ref()).expect("response");
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, br#"{"id":"provider-response"}"#);
    }

    #[test]
    fn oauth2_refresh_places_the_fresh_token_and_hands_back_what_the_exchange_gave() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request = CallExternalRequest {
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: Some(RequestAuthorization::OAuth2RefreshToken {
                token_url: "https://oauth2.googleapis.com/token".to_string(),
                client_id_handle: "client-id-handle".to_string(),
                client_secret_handle: Some("client-secret-handle".to_string()),
                refresh_token_handle: "refresh-token-handle".to_string(),
                required_scope_groups: vec![
                    vec![
                        "https://www.googleapis.com/auth/gmail.modify".to_string(),
                        "https://mail.google.com/".to_string(),
                    ],
                    vec![
                        "https://www.googleapis.com/auth/calendar.events".to_string(),
                        "https://www.googleapis.com/auth/calendar".to_string(),
                    ],
                ],
                granted_scopes_path: Some(vec!["scope".to_string()]),
                placement: CredentialPlacement::Header {
                    name: "Authorization".to_string(),
                    prefix: "Bearer ".to_string(),
                    suffix: String::new(),
                },
                client_credential_use: OAuth2ClientCredentialUse::BodyFormFields,
            }),
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |target: &str,
                        _partition: &PartitionKey,
                        payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let secret_value = match value["handle"].as_str().unwrap() {
                        "client-id-handle" => "client-id",
                        "client-secret-handle" => "client-secret",
                        "refresh-token-handle" => "refresh-token",
                        other => panic!("unexpected handle {other}"),
                    };
                    Ok(Arc::from(
                        serde_json::to_vec(&json!({"success": true, "value": secret_value}))
                            .unwrap()
                            .into_boxed_slice(),
                    ))
                }
                "compute.process" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let transport = transport_request_from_process_descriptor(&value);
                    if transport.url == "https://oauth2.googleapis.com/token" {
                        assert_eq!(transport.method, "POST");
                        assert_eq!(
                            transport.headers.get("content-type").map(String::as_str),
                            Some("application/x-www-form-urlencoded")
                        );
                        let body = String::from_utf8(
                            base64::engine::general_purpose::STANDARD
                                .decode(transport.body_b64.unwrap())
                                .unwrap(),
                        )
                        .unwrap();
                        assert!(body.contains("client_id=client-id"));
                        assert!(body.contains("client_secret=client-secret"));
                        assert!(body.contains("refresh_token=refresh-token"));
                        assert!(body.contains("grant_type=refresh_token"));
                        let stdout = serde_json::to_vec(&json!({
                            "status_code": 200,
                            "headers": {"content-type": "application/json"},
                            "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"access_token":"fresh-access-token","scope":"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events","token_type":"Bearer","expires_in":3600}"#)
                        }))
                        .unwrap();
                        let result = successful_process_result(stdout);
                        return Ok(Arc::from(
                            serde_json::to_vec(&result).unwrap().into_boxed_slice(),
                        ));
                    }
                    assert_eq!(
                        transport.headers.get("Authorization").map(String::as_str),
                        Some("Bearer fresh-access-token")
                    );
                    let stdout = serde_json::to_vec(&json!({
                        "status_code": 200,
                        "headers": {"content-type": "application/json"},
                        "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"messages":[]}"#)
                    }))
                    .unwrap();
                    let result = successful_process_result(stdout);
                    Ok(Arc::from(
                        serde_json::to_vec(&result).unwrap().into_boxed_slice(),
                    ))
                }
                other => Err(format!("unexpected target {other}")),
            }
        };

        let result =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect("query");
        let response: CallExternalResponse =
            serde_json::from_slice(result.response.as_ref()).expect("response");
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, br#"{"messages":[]}"#);
        // A service that does not rotate its refresh token gives none back.
        assert_eq!(
            response.refreshed,
            Some(OAuth2RefreshedTokens {
                access_token: "fresh-access-token".to_string(),
                expires_in: Some(3600),
                refresh_token: None,
                granted_scopes: Some(json!("https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events")),
            })
        );
    }

    #[test]
    fn oauth2_refresh_can_use_basic_client_authorization_header() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request = CallExternalRequest {
            url: "https://api.example.com/protected".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: Some(RequestAuthorization::OAuth2RefreshToken {
                token_url: "https://oauth2.example.com/token".to_string(),
                client_id_handle: "client-id-handle".to_string(),
                client_secret_handle: Some("client-secret-handle".to_string()),
                refresh_token_handle: "refresh-token-handle".to_string(),
                required_scope_groups: Vec::new(),
                granted_scopes_path: None,
                placement: CredentialPlacement::Header {
                    name: "Authorization".to_string(),
                    prefix: "Bearer ".to_string(),
                    suffix: String::new(),
                },
                client_credential_use: OAuth2ClientCredentialUse::BasicAuthorizationHeader,
            }),
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |target: &str,
                        _partition: &PartitionKey,
                        payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            match target {
                "test-credential-resolver" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let secret_value = match value["handle"].as_str().unwrap() {
                        "client-id-handle" => "client-id",
                        "client-secret-handle" => "client-secret",
                        "refresh-token-handle" => "refresh-token",
                        other => panic!("unexpected handle {other}"),
                    };
                    Ok(Arc::from(
                        serde_json::to_vec(&json!({"success": true, "value": secret_value}))
                            .unwrap()
                            .into_boxed_slice(),
                    ))
                }
                "compute.process" => {
                    let value: serde_json::Value =
                        serde_json::from_slice(payload.unwrap()).unwrap();
                    let transport = transport_request_from_process_descriptor(&value);
                    if transport.url == "https://oauth2.example.com/token" {
                        let expected = format!(
                            "Basic {}",
                            base64::engine::general_purpose::STANDARD
                                .encode(b"client-id:client-secret")
                        );
                        assert_eq!(
                            transport.headers.get("authorization").map(String::as_str),
                            Some(expected.as_str())
                        );
                        let body = String::from_utf8(
                            base64::engine::general_purpose::STANDARD
                                .decode(transport.body_b64.unwrap())
                                .unwrap(),
                        )
                        .unwrap();
                        assert!(!body.contains("client_id="));
                        assert!(!body.contains("client_secret="));
                        assert!(body.contains("refresh_token=refresh-token"));
                        let stdout = serde_json::to_vec(&json!({
                            "status_code": 200,
                            "headers": {"content-type": "application/json"},
                            "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"access_token":"fresh-access-token","refresh_token":"next-refresh-token","expires_in":"7200"}"#)
                        }))
                        .unwrap();
                        let result = successful_process_result(stdout);
                        return Ok(Arc::from(
                            serde_json::to_vec(&result).unwrap().into_boxed_slice(),
                        ));
                    }
                    assert_eq!(
                        transport.headers.get("Authorization").map(String::as_str),
                        Some("Bearer fresh-access-token")
                    );
                    let stdout = serde_json::to_vec(&json!({
                        "status_code": 200,
                        "headers": {},
                        "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"ok":true}"#)
                    }))
                    .unwrap();
                    let result = successful_process_result(stdout);
                    Ok(Arc::from(
                        serde_json::to_vec(&result).unwrap().into_boxed_slice(),
                    ))
                }
                other => Err(format!("unexpected target {other}")),
            }
        };

        let result =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect("query");
        let response: CallExternalResponse =
            serde_json::from_slice(result.response.as_ref()).expect("response");
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, br#"{"ok":true}"#);
        // A service that rotates refresh tokens (each works once) hands back
        // the one to use next, so the caller can keep it.
        assert_eq!(
            response.refreshed,
            Some(OAuth2RefreshedTokens {
                access_token: "fresh-access-token".to_string(),
                expires_in: Some(7200),
                refresh_token: Some("next-refresh-token".to_string()),
                granted_scopes: None,
            })
        );
    }

    #[test]
    fn rejects_localhost_before_process_dispatch() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request = CallExternalRequest {
            url: "http://localhost:3000".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: None,
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |_target: &str,
                        _partition: &PartitionKey,
                        _payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            panic!("dispatch must not run for SSRF-blocked URL")
        };

        let error =
            handle_call_external_request(&request_bytes, None, &partition, &dispatch, &config)
                .expect_err("localhost must be blocked");
        assert!(error.contains("BHTTP_URL_PRIVATE_BLOCKED"));
    }

    #[test]
    fn rejects_undeclared_caller_context_before_process_dispatch() {
        let partition = PartitionKey::hash_from("test");
        let config = test_runtime_config();
        let request = CallExternalRequest {
            url: "https://api.example.com/models".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: None,
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |_target: &str,
                        _partition: &PartitionKey,
                        _payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            panic!("dispatch must not run for undeclared caller context")
        };

        let context = context_bytes(&local_callback_context());
        let error = handle_call_external_request(
            &request_bytes,
            Some(&context),
            &partition,
            &dispatch,
            &config,
        )
        .expect_err("undeclared caller context must be blocked");
        assert!(error.contains("BHTTP_CAPABILITY_CONTEXT_UNDECLARED"));
    }

    #[test]
    fn declared_caller_context_allows_exact_loopback_host() {
        let partition = PartitionKey::hash_from("test");
        let mut config = test_runtime_config();
        let grant_context = local_callback_context();
        config.url_grants.push(HttpClientUrlGrant {
            id: "local-callback".to_string(),
            context: grant_context.clone(),
            allowed_hosts: vec!["127.0.0.1".to_string(), "localhost".to_string()],
            allowed_schemes: vec!["http".to_string()],
            allow_loopback: true,
            allow_private_networks: false,
        });
        let request = CallExternalRequest {
            url: "http://127.0.0.1:4321/callback".to_string(),
            method: "POST".parse().unwrap(),
            headers: HashMap::new(),
            body: Some(CallExternalBody::Inline(br#"{"ok":true}"#.to_vec())),
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |target: &str,
                        _partition: &PartitionKey,
                        payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            assert_eq!(target, "compute.process");
            let value: serde_json::Value = serde_json::from_slice(payload.unwrap()).unwrap();
            let transport = transport_request_from_process_descriptor(&value);
            assert_eq!(transport.url, "http://127.0.0.1:4321/callback");
            let stdout = serde_json::to_vec(&json!({
                "status_code": 201,
                "headers": {},
                "body_b64": base64::engine::general_purpose::STANDARD.encode(br#"{"delivered":true}"#)
            }))
            .unwrap();
            let result = successful_process_result(stdout);
            Ok(Arc::from(
                serde_json::to_vec(&result).unwrap().into_boxed_slice(),
            ))
        };

        let context = context_bytes(&grant_context);
        let result = handle_call_external_request(
            &request_bytes,
            Some(&context),
            &partition,
            &dispatch,
            &config,
        )
        .expect("query");
        let response: CallExternalResponse =
            serde_json::from_slice(result.response.as_ref()).expect("response");
        assert_eq!(response.status_code, 201);
        assert_eq!(response.body, br#"{"delivered":true}"#);
    }

    #[test]
    fn declared_caller_context_rejects_unlisted_private_host() {
        let partition = PartitionKey::hash_from("test");
        let mut config = test_runtime_config();
        let grant_context = local_callback_context();
        config.url_grants.push(HttpClientUrlGrant {
            id: "local-callback".to_string(),
            context: grant_context.clone(),
            allowed_hosts: vec!["127.0.0.1".to_string()],
            allowed_schemes: vec!["http".to_string()],
            allow_loopback: true,
            allow_private_networks: false,
        });
        let request = CallExternalRequest {
            url: "http://192.168.1.20:4321/callback".to_string(),
            method: "POST".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: Some(1000),
            deliver_parts_to: None,
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let dispatch = |_target: &str,
                        _partition: &PartitionKey,
                        _payload: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> {
            panic!("dispatch must not run for rejected private host")
        };

        let context = context_bytes(&grant_context);
        let error = handle_call_external_request(
            &request_bytes,
            Some(&context),
            &partition,
            &dispatch,
            &config,
        )
        .expect_err("unlisted private host must be blocked");
        assert!(error.contains("BHTTP_URL_GRANT_HOST_REJECTED"));
    }
}
