// packages/http-client/source/src/run_in_a_web_worker/mod.rs
//
//! # Request sender in a web host (wasm32-unknown-unknown)
//!
//! Purpose: run the unchanged `call_external` path in a plain wasm-bindgen
//! module (a Cloudflare Worker Durable Object): URL grant check, credential
//! resolve by name through the vault target, placement, drop, transport, and
//! the echo scrub of placed values in the reply.
//!
//! Non-negotiable invariants:
//! - No request logic lives here; it is `slot_work::call_external`.
//! - Every outward call (vault `read` / `resolve_handle`, transport) goes
//!   through the host function installed with `slot_protocol::web_host`, which
//!   decides which targets exist.
//! - The reply is `CallExternalResponse` JSON with every placed value already
//!   replaced by `[held value]`.
//!
//! Security: the placed values exist only inside this module between resolve
//! and scrub; the host sees them only in the transport request it must send.

use std::sync::Arc;

use js_sys::{Function, Promise, Uint8Array};
use slot_protocol::PartitionKey;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::slot_work::call_external::HttpClientRuntimeConfig;
use crate::slot_work::{handle_http_client_request_with_async_dispatch, AsyncEnvelopeDispatch};

/// `AsyncEnvelopeDispatch` answered by the host function.
struct WebHostDispatch;

#[async_trait::async_trait(?Send)]
impl AsyncEnvelopeDispatch for WebHostDispatch {
    async fn dispatch(
        &self,
        target_address: &str,
        partition_key: &PartitionKey,
        payload: Option<&[u8]>,
    ) -> Result<Arc<[u8]>, String> {
        slot_protocol::web_host::dispatch(target_address, partition_key, payload).await
    }
}

/// One person's request sender inside a web host.
#[wasm_bindgen]
pub struct HttpClientInWebWorker {
    config: Arc<HttpClientRuntimeConfig>,
    partition: PartitionKey,
}

#[wasm_bindgen]
impl HttpClientInWebWorker {
    /// - `host_dispatch(target, partition, payload)` answers the vault target
    ///   (`credential_resolver_target`) and the transport target.
    /// - `partition_label` names the partition (BLAKE3 of the label).
    /// - `slot_config` is `HttpClientRuntimeConfig` JSON (transport target,
    ///   credential resolver, URL grants).
    #[wasm_bindgen(constructor)]
    pub fn new(
        host_dispatch_function: Function,
        partition_label: String,
        slot_config: Vec<u8>,
    ) -> Result<HttpClientInWebWorker, JsError> {
        let config = HttpClientRuntimeConfig::from_context(Some(&slot_config))
            .map_err(|error| JsError::new(&error))?;
        slot_protocol::web_host::install_host_dispatch(host_dispatch_function);
        Ok(Self {
            config: Arc::new(config),
            partition: PartitionKey::hash_from(&partition_label),
        })
    }

    /// Send one `CallExternalRequest` (JSON bytes). Resolves to the
    /// `CallExternalResponse` JSON bytes; rejects with the request's error.
    pub fn call(&self, request: Vec<u8>, caller_context: Option<Vec<u8>>) -> Promise {
        let config = Arc::clone(&self.config);
        let partition = self.partition.clone();
        future_to_promise(async move {
            let result = handle_http_client_request_with_async_dispatch(
                &request,
                caller_context.as_deref(),
                &partition,
                &WebHostDispatch,
                &config,
            )
            .await
            .map_err(|error| JsValue::from(JsError::new(&error)))?;
            Ok(Uint8Array::from(result.response.as_ref()).into())
        })
    }
}
