// source-code-to-sign/content-crypto/src/varint.rs
//
//! LEB128 variable-length integer encoding for Multihash wire format.
//!
//! Standard IETF multicodec encoding: big-endian, continue bit in MSB.

use crate::MultihashError;

/// Encode a u64 as LEB128 variable-length bytes.
pub fn encode_varint(mut value: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80; // Set continue bit
        }
        buf.push(byte);
        if value == 0 {
            break;
        }
    }
    buf
}

/// Encode a u64 as LEB128 into a caller-provided buffer.
/// Returns the number of bytes written.
#[inline]
pub fn encode_varint_into(mut value: u64, buf: &mut [u8]) -> usize {
    let mut pos = 0usize;
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        buf[pos] = byte;
        pos += 1;
        if value == 0 {
            break;
        }
    }
    pos
}

/// Return the number of bytes required to encode a u64 as LEB128.
#[inline]
pub fn encoded_varint_len(mut value: u64) -> usize {
    let mut len = 1usize;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}

/// Decode a LEB128 variable-length integer from bytes.
/// Returns (value, bytes_consumed).
pub fn decode_varint(bytes: &[u8]) -> Result<(u64, usize), MultihashError> {
    let mut value = 0u64;
    let mut shift = 0u32;
    let mut pos = 0;

    for &byte in bytes {
        pos += 1;

        let bits = (byte & 0x7F) as u64;
        // 10th byte sits at shift 63: only bit 0 of the value fits in u64.
        if shift == 63 && bits > 1 {
            return Err(MultihashError::InvalidVarint);
        }
        value |= bits << shift;

        if byte & 0x80 == 0 {
            return Ok((value, pos));
        }

        shift += 7;
        if shift > 63 {
            return Err(MultihashError::InvalidVarint);
        }
    }

    Err(MultihashError::InvalidVarint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_varint_single_byte() {
        assert_eq!(encode_varint(0), vec![0x00]);
        assert_eq!(encode_varint(1), vec![0x01]);
        assert_eq!(encode_varint(127), vec![0x7F]);
    }

    #[test]
    fn test_varint_multi_byte() {
        assert_eq!(encode_varint(128), vec![0x80, 0x01]);
        assert_eq!(encode_varint(300), vec![0xAC, 0x02]);
    }

    #[test]
    fn test_varint_large() {
        assert_eq!(
            encode_varint(u32::MAX as u64),
            vec![0xFF, 0xFF, 0xFF, 0xFF, 0x0F]
        );
        assert_eq!(
            encode_varint(u64::MAX),
            vec![0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01]
        );
    }

    #[test]
    fn test_varint_roundtrip() {
        for value in &[0u64, 1, 127, 128, 300, u32::MAX as u64, u64::MAX] {
            let encoded = encode_varint(*value);
            let (decoded, consumed) = decode_varint(&encoded).unwrap();
            assert_eq!(*value, decoded);
            assert_eq!(encoded.len(), consumed);
        }
    }

    #[test]
    fn test_decode_invalid_varint() {
        // All bytes have continue bit set — incomplete encoding
        assert!(
            decode_varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]).is_err()
        );

        // Empty buffer
        assert!(decode_varint(&[]).is_err());
    }

    #[test]
    fn test_decode_varint_tenth_byte_overflow_rejected() {
        // 10th byte carries bit 63; only 0 or 1 fit in u64.
        assert!(
            decode_varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x02]).is_err()
        );
        assert!(
            decode_varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F]).is_err()
        );
    }

    #[test]
    fn test_decode_varint_eleventh_byte_rejected() {
        assert!(decode_varint(&[
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01
        ])
        .is_err());
    }
}
