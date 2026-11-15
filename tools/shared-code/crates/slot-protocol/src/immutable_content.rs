//! Generic immutable content-addressed byte transport.
//!
//! Storage remains owned by the Envelope engine. WASM slots reach this owner
//! through the existing opaque `talk-to-other-slots` Envelope path; this module
//! defines only its Physics request/reply bytes.

use crate::{EnvelopeError, Hash};

pub const IMMUTABLE_CONTENT_ADDRESS: &str = "runtime::immutable-content";
const STORE_TAG: u8 = 1;
const READ_TAG: u8 = 2;
const BLAKE3_MULTIHASH_WIRE_LEN: usize = 34;

/// Fixed-width immutable CAS reference.
///
/// General Envelope hashes remain crypto-agile. This transport intentionally
/// accepts only Blake3-256 so a reference is always exactly 34 multihash wire
/// bytes and cannot become an unbounded metadata lane.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ImmutableContentRef(Hash);

impl ImmutableContentRef {
    pub const WIRE_LEN: usize = BLAKE3_MULTIHASH_WIRE_LEN;

    pub fn from_hash(hash: Hash) -> Result<Self, EnvelopeError> {
        if hash.algo_code() != content_crypto::Multihash::BLAKE3_CODE || hash.digest().len() != 32
        {
            return Err(EnvelopeError::CodecError(
                "immutable content ref requires Blake3-256".to_string(),
            ));
        }
        Ok(Self(hash))
    }

    pub fn from_code_hex(value: &str) -> Result<Self, EnvelopeError> {
        let multihash = content_crypto::Multihash::from_code_hex(value).map_err(|error| {
            EnvelopeError::CodecError(format!("immutable content ref decode failed: {error}"))
        })?;
        Self::from_hash(Hash::from_multihash(multihash))
    }

    pub fn hash(&self) -> &Hash {
        &self.0
    }

    pub fn to_code_hex(&self) -> String {
        self.0.as_multihash().to_code_hex()
    }

    pub fn encode_fixed(&self, bytes: &mut Vec<u8>) {
        let start = bytes.len();
        bytes.resize(start + Self::WIRE_LEN, 0);
        self.0
            .as_multihash()
            .encode_into(&mut bytes[start..start + Self::WIRE_LEN]);
    }

    pub fn decode_fixed(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        if bytes.len() != Self::WIRE_LEN {
            return Err(EnvelopeError::CodecError(
                "immutable content ref has invalid fixed width".to_string(),
            ));
        }
        let multihash = content_crypto::Multihash::decode(bytes).map_err(|error| {
            EnvelopeError::CodecError(format!("immutable content ref decode failed: {error}"))
        })?;
        Self::from_hash(Hash::from_multihash(multihash))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImmutableContentRequest {
    Store(Vec<u8>),
    Read(ImmutableContentRef),
}

pub fn encode_immutable_content_request(
    request: &ImmutableContentRequest,
) -> Result<Vec<u8>, EnvelopeError> {
    match request {
        ImmutableContentRequest::Store(content) => encode_immutable_content_store_request(content),
        ImmutableContentRequest::Read(reference) => {
            let mut bytes = Vec::with_capacity(1 + ImmutableContentRef::WIRE_LEN);
            bytes.push(READ_TAG);
            reference.encode_fixed(&mut bytes);
            Ok(bytes)
        }
    }
}

/// Encode a borrowed immutable-content body without first cloning it into an
/// owned request enum.
///
/// Large byte producers commonly already own their bytes behind an `Arc`.
/// This borrowed form keeps the cross-slot request to one required contiguous
/// binary frame instead of adding an otherwise redundant full-body clone.
pub fn encode_immutable_content_store_request(content: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let len = u64::try_from(content.len()).map_err(|_| {
        EnvelopeError::CodecError("immutable content request too large".to_string())
    })?;
    let mut bytes = Vec::with_capacity(1 + 8 + content.len());
    bytes.push(STORE_TAG);
    bytes.extend_from_slice(&len.to_le_bytes());
    bytes.extend_from_slice(content);
    Ok(bytes)
}

pub fn decode_immutable_content_request(
    bytes: &[u8],
) -> Result<ImmutableContentRequest, EnvelopeError> {
    let Some(tag) = bytes.first().copied() else {
        return Err(EnvelopeError::CodecError(
            "immutable content request is empty".to_string(),
        ));
    };
    match tag {
        STORE_TAG => {
            if bytes.len() < 9 {
                return Err(EnvelopeError::CodecError(
                    "immutable content store request is truncated".to_string(),
                ));
            }
            let len = u64::from_le_bytes(bytes[1..9].try_into().expect("eight-byte length"));
            let len = usize::try_from(len).map_err(|_| {
                EnvelopeError::CodecError(
                    "immutable content store request length exceeds platform".to_string(),
                )
            })?;
            if bytes.len() != 9usize.saturating_add(len) {
                return Err(EnvelopeError::CodecError(
                    "immutable content store request length mismatch".to_string(),
                ));
            }
            Ok(ImmutableContentRequest::Store(bytes[9..].to_vec()))
        }
        READ_TAG => {
            if bytes.len() != 1 + ImmutableContentRef::WIRE_LEN {
                return Err(EnvelopeError::CodecError(
                    "immutable content read request has invalid width".to_string(),
                ));
            }
            Ok(ImmutableContentRequest::Read(
                ImmutableContentRef::decode_fixed(&bytes[1..])?,
            ))
        }
        other => Err(EnvelopeError::CodecError(format!(
            "unsupported immutable content request tag {other}"
        ))),
    }
}

pub fn encode_immutable_content_store_reply(reference: &ImmutableContentRef) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(ImmutableContentRef::WIRE_LEN);
    reference.encode_fixed(&mut bytes);
    bytes
}

pub fn decode_immutable_content_store_reply(
    bytes: &[u8],
) -> Result<ImmutableContentRef, EnvelopeError> {
    ImmutableContentRef::decode_fixed(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_read_requests_round_trip_without_json_or_base64() {
        let content = vec![0, 255, 7, 42];
        let store =
            encode_immutable_content_request(&ImmutableContentRequest::Store(content.clone()))
                .unwrap();
        assert_eq!(
            store,
            encode_immutable_content_store_request(&content).unwrap(),
            "owned and borrowed store encoders share one wire contract",
        );
        assert_eq!(
            decode_immutable_content_request(&store).unwrap(),
            ImmutableContentRequest::Store(content.clone())
        );

        let reference = ImmutableContentRef::from_hash(Hash::blake3_hash(&content)).unwrap();
        let read =
            encode_immutable_content_request(&ImmutableContentRequest::Read(reference.clone()))
                .unwrap();
        assert_eq!(
            decode_immutable_content_request(&read).unwrap(),
            ImmutableContentRequest::Read(reference.clone())
        );
        assert_eq!(
            decode_immutable_content_store_reply(&encode_immutable_content_store_reply(&reference))
                .unwrap(),
            reference
        );
    }

    #[test]
    fn malformed_requests_fail_closed() {
        assert!(decode_immutable_content_request(&[]).is_err());
        assert!(decode_immutable_content_request(&[STORE_TAG]).is_err());
        assert!(decode_immutable_content_request(&[READ_TAG]).is_err());
        assert!(decode_immutable_content_request(&[99]).is_err());
    }
}
