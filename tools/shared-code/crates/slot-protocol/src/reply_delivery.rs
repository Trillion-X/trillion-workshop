//! Reply-delivery policy for the generic inter-slot request transport.
//!
//! The target still receives an ordinary opaque [`crate::Envelope`]. Delivery
//! controls only how the native router returns the target's response to the
//! caller. Large callers can request immutable content so the response body is
//! stored before it crosses a WASM boundary.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::{Envelope, EnvelopeError, FactAddress, Hash, PathSegment};

const OTHER_SLOT_REQUEST_VERSION: u8 = 1;
const SEND_LATER_REQUEST_ADDRESS_PREFIX: &str = "send-later::request::";
const SEND_LATER_OUTCOME_ADDRESS_PREFIX: &str = "send-later::outcome::";
const CURRENT_ITEM_PATH: &str = "current-item";
const SEND_LATER_REQUEST_PATH: &str = "send-later-request";
const SEND_LATER_OUTCOME_PATH: &str = "send-later-outcome";

/// How the native inter-slot router returns one target response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyDelivery {
    /// Return the target response bytes directly to the caller.
    #[default]
    Inline,
    /// Publish the target response in immutable CAS and return a fixed reference.
    ImmutableContent,
    /// Persist the exact target request before executing it outside the caller's hot
    /// path, then correlate a durable terminal outcome by request identity.
    ///
    /// This mode changes the router's submission contract, not the target envelope. The
    /// immediate response is a send-later receipt; target success must be read from the
    /// correlated durable outcome.
    LaterWithDurableOutcome,
}

/// Versioned request owned by the inter-slot transport boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OtherSlotRequest {
    version: u8,
    pub envelope: Envelope,
    #[serde(default)]
    pub reply_delivery: ReplyDelivery,
}

impl OtherSlotRequest {
    pub fn new(envelope: Envelope, reply_delivery: ReplyDelivery) -> Self {
        Self {
            version: OTHER_SLOT_REQUEST_VERSION,
            envelope,
            reply_delivery,
        }
    }
}

/// Durable current-item request for a later inter-slot execution.
///
/// `request_hash` is the Blake3 multihash of the complete encoded
/// [`OtherSlotRequest`] bytes. Those exact bytes are retained so restart recovery cannot
/// accidentally execute a re-encoded or partially reconstructed request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendLaterRequestRecord {
    pub kind: String,
    pub request_hash: String,
    pub request_bytes: String,
}

/// Terminal evidence for one durable send-later execution.
///
/// The response body is deliberately absent: callers that need a response use inline or
/// immutable-content delivery. This record proves only whether the one exact request
/// succeeded or failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendLaterOutcomeRecord {
    pub kind: String,
    pub request_hash: String,
    pub status: SendLaterOutcomeStatus,
    pub attempt: u16,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendLaterOutcomeStatus {
    Succeeded,
    Failed,
}

/// Immediate acknowledgement returned after the durable request is accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendLaterReceipt {
    pub kind: String,
    pub request_hash: String,
}

impl SendLaterRequestRecord {
    pub fn from_request_bytes(request_bytes: &[u8]) -> Self {
        Self {
            kind: "send-later-request".to_string(),
            request_hash: send_later_request_hash(request_bytes),
            request_bytes: base64::engine::general_purpose::STANDARD.encode(request_bytes),
        }
    }

    pub fn decode_request_bytes(&self) -> Result<Vec<u8>, EnvelopeError> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.request_bytes)
            .map_err(|error| {
                EnvelopeError::CodecError(format!("send-later request decode failed: {error}"))
            })
    }

    pub fn address(&self) -> FactAddress {
        send_later_request_address(&self.request_hash)
    }

    pub fn path() -> Vec<PathSegment> {
        send_later_request_path()
    }
}

impl SendLaterOutcomeRecord {
    pub fn new(
        request_hash: String,
        status: SendLaterOutcomeStatus,
        error: Option<String>,
    ) -> Self {
        Self {
            kind: "send-later-outcome".to_string(),
            request_hash,
            status,
            attempt: 1,
            error,
        }
    }

    pub fn address(&self) -> FactAddress {
        send_later_outcome_address(&self.request_hash)
    }

    pub fn path() -> Vec<PathSegment> {
        send_later_outcome_path()
    }
}

impl SendLaterReceipt {
    pub fn new(request_hash: String) -> Self {
        Self {
            kind: "send-later-request".to_string(),
            request_hash,
        }
    }
}

pub fn send_later_request_hash(request_bytes: &[u8]) -> String {
    Hash::blake3_hash(request_bytes)
        .as_multihash()
        .to_code_hex()
}

pub fn send_later_request_address(request_hash: &str) -> FactAddress {
    FactAddress::hash_from(&format!(
        "{SEND_LATER_REQUEST_ADDRESS_PREFIX}{request_hash}"
    ))
}

pub fn send_later_outcome_address(request_hash: &str) -> FactAddress {
    FactAddress::hash_from(&format!(
        "{SEND_LATER_OUTCOME_ADDRESS_PREFIX}{request_hash}"
    ))
}

pub fn send_later_request_path() -> Vec<PathSegment> {
    vec![
        PathSegment::hash_from(CURRENT_ITEM_PATH),
        PathSegment::hash_from(SEND_LATER_REQUEST_PATH),
    ]
}

pub fn send_later_outcome_path() -> Vec<PathSegment> {
    vec![
        PathSegment::hash_from(CURRENT_ITEM_PATH),
        PathSegment::hash_from(SEND_LATER_OUTCOME_PATH),
    ]
}

pub fn encode_other_slot_request(request: &OtherSlotRequest) -> Result<Vec<u8>, EnvelopeError> {
    let mut bytes = Vec::new();
    ciborium::into_writer(request, &mut bytes).map_err(|error| {
        EnvelopeError::CodecError(format!("other-slot request bytes encode failed: {error}"))
    })?;
    Ok(bytes)
}

pub fn decode_other_slot_request(bytes: &[u8]) -> Result<OtherSlotRequest, EnvelopeError> {
    let request: OtherSlotRequest = ciborium::from_reader(bytes).map_err(|error| {
        EnvelopeError::CodecError(format!("other-slot request bytes decode failed: {error}"))
    })?;
    if request.version != OTHER_SLOT_REQUEST_VERSION {
        return Err(EnvelopeError::CodecError(format!(
            "unsupported other-slot request version {}",
            request.version
        )));
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use crate::{FactAddress, PartitionKey};

    #[test]
    fn reply_delivery_round_trips_without_inspecting_target_payload() {
        let envelope = Envelope::dispatch(
            PartitionKey::hash_from("partition"),
            FactAddress::hash_from("target"),
            Some(Bytes::from_static(&[0, 255, 7, 42])),
        );
        for delivery in [
            ReplyDelivery::Inline,
            ReplyDelivery::ImmutableContent,
            ReplyDelivery::LaterWithDurableOutcome,
        ] {
            let request = OtherSlotRequest::new(envelope.clone(), delivery);
            assert_eq!(
                decode_other_slot_request(&encode_other_slot_request(&request).unwrap()).unwrap(),
                request
            );
        }
    }

    #[test]
    fn unknown_versions_fail_closed() {
        let envelope = Envelope::dispatch(
            PartitionKey::hash_from("partition"),
            FactAddress::hash_from("target"),
            None,
        );
        let mut request = OtherSlotRequest::new(envelope, ReplyDelivery::Inline);
        request.version = OTHER_SLOT_REQUEST_VERSION + 1;
        let bytes = encode_other_slot_request(&request).unwrap();
        assert!(decode_other_slot_request(&bytes).is_err());
    }

    #[test]
    fn send_later_record_keeps_exact_request_bytes_and_deterministic_addresses() {
        let envelope = Envelope::dispatch(
            PartitionKey::hash_from("partition"),
            FactAddress::hash_from("target"),
            Some(Bytes::from_static(&[1, 2, 3])),
        );
        let request = OtherSlotRequest::new(envelope, ReplyDelivery::LaterWithDurableOutcome);
        let request_bytes = encode_other_slot_request(&request).unwrap();
        let record = SendLaterRequestRecord::from_request_bytes(&request_bytes);

        assert_eq!(record.kind, "send-later-request");
        assert_eq!(record.request_hash, send_later_request_hash(&request_bytes));
        assert_eq!(record.decode_request_bytes().unwrap(), request_bytes);
        assert_eq!(
            record.address(),
            send_later_request_address(&record.request_hash)
        );
        assert_eq!(SendLaterRequestRecord::path(), send_later_request_path());
        assert_ne!(
            record.address(),
            send_later_outcome_address(&record.request_hash)
        );
    }

    #[test]
    fn send_later_outcome_is_one_terminal_attempt() {
        let record = SendLaterOutcomeRecord::new(
            send_later_request_hash(b"request"),
            SendLaterOutcomeStatus::Failed,
            Some("target rejected request".to_string()),
        );
        assert_eq!(record.kind, "send-later-outcome");
        assert_eq!(record.attempt, 1);
        assert_eq!(SendLaterOutcomeRecord::path(), send_later_outcome_path());
        let encoded = serde_json::to_vec(&record).unwrap();
        let decoded: SendLaterOutcomeRecord = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, record);
    }
}
