//! WASM entry point for `slot::http-client`.

#[cfg(target_arch = "wasm32")]
use slot_protocol::PartitionKey;

#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({
    path: "../../../../trillion-rust/crates/slot-protocol/wit",
    world: "query-handler",
    async: true,
});

#[cfg(target_arch = "wasm32")]
pub mod wit_imports {
    pub use super::slots::handler::talk_to_other_slots;
}

#[cfg(target_arch = "wasm32")]
struct HttpClientGuest;

#[cfg(target_arch = "wasm32")]
struct WitDispatch;

#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
impl crate::slot_work::AsyncEnvelopeDispatch for WitDispatch {
    async fn dispatch(
        &self,
        target_address: &str,
        partition_key: &PartitionKey,
        payload: Option<&[u8]>,
    ) -> Result<std::sync::Arc<[u8]>, String> {
        crate::talk_to_other_slots::dispatch_to_other_slot(target_address, partition_key, payload)
            .await
    }
}

#[cfg(target_arch = "wasm32")]
impl Guest for HttpClientGuest {
    async fn handle_query(env: EnvelopeIn) -> Result<QueryResult, String> {
        let partition_mh = content_crypto::Multihash::decode(&env.partition)
            .map_err(|e| format!("http-client envelope-in.partition invalid multihash: {e}"))?;
        let partition_key = PartitionKey::from_multihash(partition_mh);
        let context_parts = slot_protocol::split_query_context(env.context.as_deref());
        let config = crate::slot_work::call_external::HttpClientRuntimeConfig::from_context(
            context_parts.slot_context.as_deref(),
        )?;
        crate::slot_work::handle_http_client_request_with_async_dispatch(
            &env.payload,
            context_parts.caller_context.as_deref(),
            &partition_key,
            &WitDispatch,
            &config,
        )
        .await
        .map(to_wit_query_result)
    }

    async fn handle_query_batch(envs: Vec<EnvelopeIn>) -> Result<QueryBatchResult, String> {
        let mut responses = Vec::with_capacity(envs.len());
        let mut writes = Vec::new();
        for env in envs {
            let result = Self::handle_query(env).await?;
            let decoded_writes = slot_protocol::decode_write_batch(&result.writes_blob)
                .map_err(|e| format!("http-client write batch decode failed: {e}"))?;
            responses.push(result.response);
            writes.extend(decoded_writes);
        }
        Ok(QueryBatchResult {
            responses,
            writes_blob: slot_protocol::encode_write_batch(&writes)
                .expect("http-client write batch encode should succeed"),
        })
    }
}

#[cfg(target_arch = "wasm32")]
export!(HttpClientGuest);

#[cfg(target_arch = "wasm32")]
fn to_wit_query_result(result: slot_protocol::QueryResult) -> QueryResult {
    QueryResult {
        response: result.response.to_vec(),
        writes_blob: slot_protocol::encode_write_batch(&result.writes)
            .expect("http-client write batch encode should succeed"),
    }
}
