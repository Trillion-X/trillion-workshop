use bytes::Bytes;
use serde_json::Value;
use slot_protocol::{Envelope, FactAddress, PartitionKey, ReplyDelivery};

use super::match_rules::{
    resolve_template_value_for_mutation, truthy, value_at_path, MutationContext,
};
use super::rule_record::{RuleDispatchDelivery, TriggerRule};

pub(super) struct DispatchResult {
    pub input: Value,
    pub receipt: Option<slot_protocol::SendLaterReceipt>,
}

// Shared by native and wasm dispatch paths. Never persist a target's response
// body: only the generic durable request identity is needed for outcome joins.
fn dispatch_result(
    input: Value,
    delivery: RuleDispatchDelivery,
    response: &[u8],
) -> Result<DispatchResult, String> {
    let receipt = if delivery == RuleDispatchDelivery::LaterWithDurableOutcome {
        let receipt: slot_protocol::SendLaterReceipt = serde_json::from_slice(response)
            .map_err(|_| "trigger-engine: invalid durable delivery receipt".to_string())?;
        let digest = receipt.request_hash.strip_prefix("1f:").unwrap_or("");
        if receipt.kind != "send-later-request"
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("trigger-engine: invalid durable delivery identity".to_string());
        }
        Some(receipt)
    } else {
        None
    };
    Ok(DispatchResult { input, receipt })
}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait TalkToOtherSlots: Send + Sync {
    #[cfg(not(target_arch = "wasm32"))]
    fn dispatch(&self, envelope: &Envelope, delivery: ReplyDelivery) -> Result<Vec<u8>, String>;

    #[cfg(target_arch = "wasm32")]
    async fn dispatch(
        &self,
        envelope: &Envelope,
        delivery: ReplyDelivery,
    ) -> Result<Vec<u8>, String>;
}

/// Normalize a content-hash string to the canonical `code:hex` form.
///
/// The delta wire carries hashes as hex-encoded multihash wire bytes
/// (`hex(multihash.encode())`), while the direct-read reply and the live-state
/// scan carry `code:hex` (`1f:<digest>`). Comparing the two raw strings would
/// NEVER match — every fallback direct read would false-positive as a
/// content-resolution failure. Strings that already contain `:` (or fail to
/// parse as multihash wire bytes) are returned lowercased unchanged.
pub(super) fn normalize_content_hash(hash: &str) -> String {
    if hash.contains(':') {
        return hash.to_ascii_lowercase();
    }
    let Ok(bytes) = hex::decode(hash) else {
        return hash.to_string();
    };
    match content_crypto::Multihash::decode(&bytes) {
        Ok(mh) => mh.to_code_hex(),
        Err(_) => hash.to_string(),
    }
}

/// Verify the direct-read reply carries the SAME content the delta asserted.
///
/// The direct read serves the address's CURRENT bytes; under a recompute storm a
/// subsequent write can land between the assert and this read. Evaluating rules
/// against substituted bytes is the delta-delivery-integrity Task B defect: the
/// rule silently no-matches content that was never the asserted delta. A
/// mismatch is an explicit error the caller records durably — never a silent
/// skip, never silent substitution. Both hashes are normalized to `code:hex`
/// before comparing (the assert side arrives as wire-hex).
fn verify_direct_read_reply(
    reply: slot_protocol::DirectReadReply,
    address: &FactAddress,
    expected_content_hash: &str,
) -> Result<Vec<u8>, String> {
    let asserted = normalize_content_hash(expected_content_hash);
    let current = normalize_content_hash(&reply.content_hash);
    if current != asserted {
        return Err(format!(
            "trigger-engine: direct-read content mismatch at {address}: asserted={asserted} current={current}",
        ));
    }
    Ok(reply.payload)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn resolve_direct_read<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    address: &FactAddress,
    expected_content_hash: &str,
) -> Result<Vec<u8>, String>
where
    I: TalkToOtherSlots,
{
    let envelope = Envelope::dispatch(partition.clone(), address.clone(), None);
    let bytes = talk_to_other_slots.dispatch(&envelope, ReplyDelivery::Inline)?;
    let reply =
        crate::talk_to_other_slots::read_reply_bytes_from_other_slots::read_reply_from_other_slots(
            &bytes,
        )?;
    verify_direct_read_reply(reply, address, expected_content_hash)
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn resolve_direct_read<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    address: &FactAddress,
    expected_content_hash: &str,
) -> Result<Vec<u8>, String>
where
    I: TalkToOtherSlots,
{
    let envelope = Envelope::dispatch(partition.clone(), address.clone(), None);
    let bytes = talk_to_other_slots
        .dispatch(&envelope, ReplyDelivery::Inline)
        .await?;
    let reply =
        crate::talk_to_other_slots::read_reply_bytes_from_other_slots::read_reply_from_other_slots(
            &bytes,
        )?;
    verify_direct_read_reply(reply, address, expected_content_hash)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn match_with_optional_evaluator<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    rule: &TriggerRule,
    mutation: &MutationContext,
) -> Result<bool, String>
where
    I: TalkToOtherSlots,
{
    let Some(evaluator) = &rule.evaluator else {
        return Ok(true);
    };

    let request_value =
        resolve_template_value_for_mutation(&evaluator.request_template, mutation, None)?;
    let payload = serde_json::to_vec(&request_value)
        .map_err(|e| format!("trigger-engine: serialize evaluator request: {e}"))?;
    let envelope = Envelope::dispatch(
        partition.clone(),
        FactAddress::hash_from(&evaluator.address),
        Some(Bytes::from(payload)),
    );
    let response = talk_to_other_slots.dispatch(&envelope, ReplyDelivery::Inline)?;
    let response_value: Value = serde_json::from_slice(&response)
        .map_err(|e| format!("trigger-engine: evaluator reply parse failed: {e}"))?;

    let matched_value = evaluator
        .matched_path
        .as_deref()
        .and_then(|path| value_at_path(&response_value, path))
        .cloned()
        .unwrap_or_else(|| response_value.clone());
    Ok(truthy(&matched_value))
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn match_with_optional_evaluator<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    rule: &TriggerRule,
    mutation: &MutationContext,
) -> Result<bool, String>
where
    I: TalkToOtherSlots,
{
    let Some(evaluator) = &rule.evaluator else {
        return Ok(true);
    };

    let request_value =
        resolve_template_value_for_mutation(&evaluator.request_template, mutation, None)?;
    let payload = serde_json::to_vec(&request_value)
        .map_err(|e| format!("trigger-engine: serialize evaluator request: {e}"))?;
    let envelope = Envelope::dispatch(
        partition.clone(),
        FactAddress::hash_from(&evaluator.address),
        Some(Bytes::from(payload)),
    );
    let response = talk_to_other_slots
        .dispatch(&envelope, ReplyDelivery::Inline)
        .await?;
    let response_value: Value = serde_json::from_slice(&response)
        .map_err(|e| format!("trigger-engine: evaluator reply parse failed: {e}"))?;

    let matched_value = evaluator
        .matched_path
        .as_deref()
        .and_then(|path| value_at_path(&response_value, path))
        .cloned()
        .unwrap_or_else(|| response_value.clone());
    Ok(truthy(&matched_value))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn dispatch_match<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    rule: &TriggerRule,
    mutation: &MutationContext,
) -> Result<DispatchResult, String>
where
    I: TalkToOtherSlots,
{
    let output =
        resolve_template_value_for_mutation(&rule.dispatch.output_template, mutation, None)?;
    let payload = serde_json::to_vec(&output)
        .map_err(|e| format!("trigger-engine: serialize dispatch payload: {e}"))?;
    let envelope = Envelope::dispatch(
        partition.clone(),
        FactAddress::hash_from(&rule.dispatch.target),
        Some(Bytes::from(payload)),
    );
    let response = talk_to_other_slots.dispatch(&envelope, rule.dispatch.delivery.into())?;
    dispatch_result(output, rule.dispatch.delivery, &response)
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn dispatch_match<I>(
    talk_to_other_slots: &I,
    partition: &PartitionKey,
    rule: &TriggerRule,
    mutation: &MutationContext,
) -> Result<DispatchResult, String>
where
    I: TalkToOtherSlots,
{
    let output =
        resolve_template_value_for_mutation(&rule.dispatch.output_template, mutation, None)?;
    let payload = serde_json::to_vec(&output)
        .map_err(|e| format!("trigger-engine: serialize dispatch payload: {e}"))?;
    let envelope = Envelope::dispatch(
        partition.clone(),
        FactAddress::hash_from(&rule.dispatch.target),
        Some(Bytes::from(payload)),
    );
    let response = talk_to_other_slots
        .dispatch(&envelope, rule.dispatch.delivery.into())
        .await?;
    dispatch_result(output, rule.dispatch.delivery, &response)
}

#[cfg(test)]
mod durable_receipt_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_native_wasm_receipt_decoder_preserves_input_and_exact_outcome_identity() {
        let input =
            json!({"operation":"execute_definition", "input":{"request_id":"selected-run"}});
        let hash = slot_protocol::send_later_request_hash(b"synthetic encoded request");
        let receipt = slot_protocol::SendLaterReceipt::new(hash.clone());
        let result = dispatch_result(
            input.clone(),
            RuleDispatchDelivery::LaterWithDurableOutcome,
            &serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert_eq!(result.input, input);
        assert_eq!(result.receipt.unwrap().request_hash, hash);
    }

    #[test]
    fn malformed_later_receipt_refuses_and_inline_response_stays_unpersisted() {
        for response in [b"null".as_slice(), b"{}", b"not json",
            br#"{"kind":"wrong","request_hash":"1f:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            br#"{"kind":"send-later-request","request_hash":"invalid"}"#] {
            assert!(dispatch_result(json!({}), RuleDispatchDelivery::LaterWithDurableOutcome, response).is_err());
        }
        let result = dispatch_result(
            json!({"input":1}),
            RuleDispatchDelivery::Inline,
            b"private target response",
        )
        .unwrap();
        assert_eq!(result.input, json!({"input":1}));
        assert!(result.receipt.is_none());
    }
}
