pub mod call_external;

use std::sync::Arc;

use slot_protocol::PartitionKey;

pub type EnvelopeDispatchFn =
    dyn Fn(&str, &PartitionKey, Option<&[u8]>) -> Result<Arc<[u8]>, String> + Send + Sync;

#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AsyncEnvelopeDispatch: Send + Sync {
    async fn dispatch(
        &self,
        target_address: &str,
        partition_key: &PartitionKey,
        payload: Option<&[u8]>,
    ) -> Result<Arc<[u8]>, String>;
}

pub fn handle_http_client_request_with_dispatch(
    payload: &[u8],
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &EnvelopeDispatchFn,
    config: &call_external::HttpClientRuntimeConfig,
) -> Result<slot_protocol::QueryResult, String> {
    call_external::handle_call_external_request(
        payload,
        caller_context,
        partition_key,
        dispatch,
        config,
    )
}

#[cfg(target_arch = "wasm32")]
pub async fn handle_http_client_request_with_async_dispatch(
    payload: &[u8],
    caller_context: Option<&[u8]>,
    partition_key: &PartitionKey,
    dispatch: &dyn AsyncEnvelopeDispatch,
    config: &call_external::HttpClientRuntimeConfig,
) -> Result<slot_protocol::QueryResult, String> {
    call_external::handle_call_external_request_async(
        payload,
        caller_context,
        partition_key,
        dispatch,
        config,
    )
    .await
}
