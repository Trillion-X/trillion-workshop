//! Benchmark: direct-read reply encoding seam.
//!
//! This isolates the current hot direct-read reply contract into explicit
//! encode families so we can answer:
//! - how much is the code-hex `String`
//! - how much is the output `Vec<u8>`
//! - what lower bound remains if the contract changes to borrowed vectored
//!   slices and/or raw multihash bytes

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use slot_protocol::{encode_direct_read_reply_parts, EnvelopeError, Hash};
use std::io::IoSlice;

fn encode_direct_read_reply_precomputed_hash_bytes(
    content_hash_code_hex: &str,
    payload: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let hash_bytes = content_hash_code_hex.as_bytes();
    let hash_len = u32::try_from(hash_bytes.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply content_hash too large".to_string())
    })?;
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply payload too large".to_string())
    })?;
    let mut bytes = Vec::with_capacity(8 + hash_bytes.len() + payload.len());
    bytes.extend_from_slice(&hash_len.to_le_bytes());
    bytes.extend_from_slice(hash_bytes);
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn prepare_direct_read_reply_code_hex_iovecs(
    content_hash_code_hex: &str,
    payload: &[u8],
) -> Result<usize, EnvelopeError> {
    let hash_bytes = content_hash_code_hex.as_bytes();
    let hash_len = u32::try_from(hash_bytes.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply content_hash too large".to_string())
    })?;
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply payload too large".to_string())
    })?;
    let hash_len_le = hash_len.to_le_bytes();
    let payload_len_le = payload_len.to_le_bytes();
    let slices = [
        IoSlice::new(&hash_len_le),
        IoSlice::new(hash_bytes),
        IoSlice::new(&payload_len_le),
        IoSlice::new(payload),
    ];
    Ok(slices.iter().map(|slice| slice.len()).sum())
}

fn prepare_direct_read_reply_binary_multihash_iovecs(
    content_hash: &Hash,
    payload: &[u8],
) -> Result<usize, EnvelopeError> {
    let hash_len = content_hash.0.encoded_len();
    let hash_len_u32 = u32::try_from(hash_len).map_err(|_| {
        EnvelopeError::CodecError("direct read reply binary hash too large".to_string())
    })?;
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply payload too large".to_string())
    })?;
    let mut hash_bytes = [0u8; 80];
    let encoded_len = content_hash.0.encode_into(&mut hash_bytes[..hash_len]);
    let hash_len_le = hash_len_u32.to_le_bytes();
    let payload_len_le = payload_len.to_le_bytes();
    let slices = [
        IoSlice::new(&hash_len_le),
        IoSlice::new(&hash_bytes[..encoded_len]),
        IoSlice::new(&payload_len_le),
        IoSlice::new(payload),
    ];
    Ok(slices.iter().map(|slice| slice.len()).sum())
}

fn encode_direct_read_reply_binary_multihash_vec(
    content_hash: &Hash,
    payload: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let hash_len = content_hash.0.encoded_len();
    let hash_len_u32 = u32::try_from(hash_len).map_err(|_| {
        EnvelopeError::CodecError("direct read reply binary hash too large".to_string())
    })?;
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply payload too large".to_string())
    })?;
    let mut bytes = Vec::with_capacity(8 + hash_len + payload.len());
    bytes.extend_from_slice(&hash_len_u32.to_le_bytes());
    let start = bytes.len();
    bytes.resize(start + hash_len, 0);
    let wrote = content_hash
        .0
        .encode_into(&mut bytes[start..start + hash_len]);
    debug_assert_eq!(wrote, hash_len);
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn bench_direct_read_reply(c: &mut Criterion) {
    let hash = Hash::blake3([0x5A; 32]);
    let hash_code_hex = hash.0.to_code_hex();
    let payload = vec![0xAB; 32];

    c.bench_function("direct_read_reply/current_code_hex_vec", |b| {
        b.iter(|| {
            black_box(encode_direct_read_reply_parts(
                black_box(&hash),
                black_box(payload.as_slice()),
            ))
            .expect("current encode")
        });
    });

    c.bench_function("direct_read_reply/hash_code_hex_only_probe", |b| {
        b.iter(|| black_box(hash.0.to_code_hex()));
    });

    c.bench_function("direct_read_reply/precomputed_code_hex_vec_probe", |b| {
        b.iter(|| {
            black_box(encode_direct_read_reply_precomputed_hash_bytes(
                black_box(hash_code_hex.as_str()),
                black_box(payload.as_slice()),
            ))
            .expect("precomputed hash vec encode")
        });
    });

    c.bench_function("direct_read_reply/precomputed_code_hex_iovecs_probe", |b| {
        b.iter(|| {
            black_box(prepare_direct_read_reply_code_hex_iovecs(
                black_box(hash_code_hex.as_str()),
                black_box(payload.as_slice()),
            ))
            .expect("precomputed code-hex iovecs")
        });
    });

    c.bench_function("direct_read_reply/binary_multihash_vec_probe", |b| {
        b.iter(|| {
            black_box(encode_direct_read_reply_binary_multihash_vec(
                black_box(&hash),
                black_box(payload.as_slice()),
            ))
            .expect("binary multihash vec encode")
        });
    });

    c.bench_function("direct_read_reply/binary_multihash_iovecs_probe", |b| {
        b.iter(|| {
            black_box(prepare_direct_read_reply_binary_multihash_iovecs(
                black_box(&hash),
                black_box(payload.as_slice()),
            ))
            .expect("binary multihash iovecs")
        });
    });
}

criterion_group!(benches, bench_direct_read_reply);
criterion_main!(benches);
