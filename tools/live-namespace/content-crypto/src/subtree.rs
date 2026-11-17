//! Resumable BLAKE3 hashing from verified, aligned subtrees.
//!
//! A caller can receive bounded pieces, persist this checkpoint, and continue
//! after a restart without serializing BLAKE3's private `Hasher` internals or
//! rereading bytes already accepted by a remote store. Each non-final piece is
//! exactly 32 KiB and starts at a 32 KiB boundary. The piece CV is computed
//! from its actual bytes here; callers cannot supply a CV. The final digest is
//! the ordinary BLAKE3 digest of the concatenated bytes.
//!
//! This module uses `blake3::hazmat`, so its tree shape is part of the tested
//! contract. Do not change the piece size or merge ordering without expanding
//! the conformance cases against one-shot `blake3::hash`.
//!
//! Checkpoints are trusted server state, never caller assertions. Persist them
//! only in the account-scoped account files upload record written by this owner;
//! do not accept a serialized checkpoint, CV, or final digest from a phone,
//! browser, tool, or other request input. The checkpoint validates format and
//! tree shape on reopen, not authenticity against arbitrary database edits.

use crate::advanced::blake3::{
    self,
    hazmat::{self, HasherExt, Mode},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Wire pieces fit inside a bounded JSON request after base64 encoding.
pub const SUBTREE_BYTES: usize = 32 * 1024;
const CHECKPOINT_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Node {
    offset: u64,
    length: u64,
    cv: [u8; 32],
}

/// Persist this value in the same account scope as the upload it belongs to.
/// Fields are private so callers cannot manufacture chaining values; JSON
/// deserialization still validates their complete tree shape on resume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    version: u8,
    total_bytes: u64,
    next_offset: u64,
    full_subtrees: u64,
    prefix: Vec<Node>,
    pending: Option<Node>,
    small_digest: Option<[u8; 32]>,
}

/// A malformed piece or checkpoint. These errors contain no payload bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum Error {
    #[error("piece offset does not continue the upload")]
    Offset,
    #[error("piece is outside the bounded subtree size")]
    PieceSize,
    #[error("piece does not fit the declared file length")]
    Total,
    #[error("the upload checkpoint is malformed or unsupported")]
    Checkpoint,
    #[error("the upload does not yet contain its declared length")]
    Incomplete,
}

/// An incremental, restartable BLAKE3 content identity computation.
#[derive(Debug, Clone)]
pub struct Accumulator {
    checkpoint: Checkpoint,
}

impl Accumulator {
    /// Start an accumulator for one declared byte length.
    pub fn new(total_bytes: u64) -> Self {
        Self {
            checkpoint: Checkpoint {
                version: CHECKPOINT_VERSION,
                total_bytes,
                next_offset: 0,
                full_subtrees: 0,
                prefix: Vec::new(),
                pending: None,
                small_digest: None,
            },
        }
    }

    /// Reopen a persisted checkpoint after validating its version and tree.
    pub fn resume(checkpoint: Checkpoint) -> Result<Self, Error> {
        validate(&checkpoint)?;
        Ok(Self { checkpoint })
    }

    /// Return a clone suitable for storing beside the upload cursor.
    pub fn checkpoint(&self) -> Checkpoint {
        self.checkpoint.clone()
    }

    /// The byte offset expected by the next piece.
    pub fn next_offset(&self) -> u64 {
        self.checkpoint.next_offset
    }

    /// Hash and accept the next piece. A piece of at most 32 KiB is accepted
    /// for files no larger than that; otherwise every piece before the final
    /// one must be exactly 32 KiB. The supplied bytes, not caller metadata,
    /// produce both the piece CV and the content identity state.
    pub fn push(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Error> {
        let state = &mut self.checkpoint;
        if state.version != CHECKPOINT_VERSION || offset != state.next_offset {
            return Err(Error::Offset);
        }
        if bytes.is_empty() || bytes.len() > SUBTREE_BYTES {
            return Err(Error::PieceSize);
        }
        let end = offset.checked_add(bytes.len() as u64).ok_or(Error::Total)?;
        if end > state.total_bytes {
            return Err(Error::Total);
        }
        if state.total_bytes == 0
            || (state.total_bytes > SUBTREE_BYTES as u64 && offset % SUBTREE_BYTES as u64 != 0)
        {
            return Err(Error::Offset);
        }
        let is_final = end == state.total_bytes;
        if state.total_bytes > SUBTREE_BYTES as u64 && !is_final && bytes.len() != SUBTREE_BYTES {
            return Err(Error::PieceSize);
        }
        if state.total_bytes <= SUBTREE_BYTES as u64 {
            if offset != 0 || !is_final || state.small_digest.is_some() {
                return Err(Error::Offset);
            }
            state.small_digest = Some(*blake3::hash(bytes).as_bytes());
            state.next_offset = end;
            return Ok(());
        }

        let mut hasher = blake3::Hasher::new();
        hasher.set_input_offset(offset);
        hasher.update(bytes);
        let node = Node {
            offset,
            length: bytes.len() as u64,
            cv: hasher.finalize_non_root(),
        };

        if let Some(previous) = state.pending.take() {
            if previous.length != SUBTREE_BYTES as u64 {
                state.pending = Some(previous);
                return Err(Error::PieceSize);
            }
            push_full_subtree(state, previous)?;
        }
        state.pending = Some(node);
        state.next_offset = end;
        validate(state)?;
        Ok(())
    }

    /// Finalize only after every declared byte has been accepted.
    pub fn finalize(&self) -> Result<[u8; 32], Error> {
        let state = &self.checkpoint;
        validate(state)?;
        if state.next_offset != state.total_bytes {
            return Err(Error::Incomplete);
        }
        if let Some(digest) = state.small_digest {
            return Ok(digest);
        }
        if state.total_bytes == 0 {
            return Ok(*blake3::hash(b"").as_bytes());
        }
        let right = state.pending.as_ref().ok_or(Error::Incomplete)?.clone();
        let mut prefix = state.prefix.iter().rev();
        let mut left = prefix.next().ok_or(Error::Incomplete)?;
        let mut right_cv = right.cv;
        let mut right_offset = right.offset;
        loop {
            if left.offset.checked_add(left.length) != Some(right_offset) {
                return Err(Error::Checkpoint);
            }
            let is_root = prefix.len() == 0;
            if is_root {
                let root = hazmat::merge_subtrees_root(&left.cv, &right_cv, Mode::Hash);
                return Ok(*root.as_bytes());
            }
            let cv = hazmat::merge_subtrees_non_root(&left.cv, &right_cv, Mode::Hash);
            right_offset = left.offset;
            right_cv = cv;
            left = prefix.next().ok_or(Error::Checkpoint)?;
        }
    }
}

fn push_full_subtree(state: &mut Checkpoint, mut node: Node) -> Result<(), Error> {
    if node.length != SUBTREE_BYTES as u64 || node.offset % SUBTREE_BYTES as u64 != 0 {
        return Err(Error::Checkpoint);
    }
    let mut completed = state.full_subtrees.checked_add(1).ok_or(Error::Total)?;
    while completed & 1 == 0 {
        let left = state.prefix.pop().ok_or(Error::Checkpoint)?;
        if left.length != node.length || left.offset.checked_add(left.length) != Some(node.offset) {
            return Err(Error::Checkpoint);
        }
        node = Node {
            offset: left.offset,
            length: left.length.checked_add(node.length).ok_or(Error::Total)?,
            cv: hazmat::merge_subtrees_non_root(&left.cv, &node.cv, Mode::Hash),
        };
        completed >>= 1;
    }
    state.full_subtrees += 1;
    state.prefix.push(node);
    Ok(())
}

fn validate(state: &Checkpoint) -> Result<(), Error> {
    if state.version != CHECKPOINT_VERSION || state.prefix.len() > u64::BITS as usize {
        return Err(Error::Checkpoint);
    }
    if state.small_digest.is_some() {
        if state.total_bytes == 0
            || state.total_bytes > SUBTREE_BYTES as u64
            || state.next_offset != state.total_bytes
            || state.pending.is_some()
            || !state.prefix.is_empty()
            || state.full_subtrees != 0
        {
            return Err(Error::Checkpoint);
        }
        return Ok(());
    }
    if state.total_bytes <= SUBTREE_BYTES as u64 && state.next_offset != 0 {
        return Err(Error::Checkpoint);
    }
    let mut offset = 0u64;
    let mut expected_chunks = 0u64;
    let mut previous_length = u64::MAX;
    for node in &state.prefix {
        if node.offset != offset
            || node.length < SUBTREE_BYTES as u64
            || node.length % SUBTREE_BYTES as u64 != 0
            || !node.length.is_power_of_two()
            || node.length >= previous_length
        {
            return Err(Error::Checkpoint);
        }
        let chunks = node.length / SUBTREE_BYTES as u64;
        if !chunks.is_power_of_two() {
            return Err(Error::Checkpoint);
        }
        offset = offset.checked_add(node.length).ok_or(Error::Checkpoint)?;
        expected_chunks = expected_chunks
            .checked_add(chunks)
            .ok_or(Error::Checkpoint)?;
        previous_length = node.length;
    }
    if expected_chunks != state.full_subtrees {
        return Err(Error::Checkpoint);
    }
    if let Some(pending) = &state.pending {
        if pending.offset != offset
            || pending.length == 0
            || pending.length > SUBTREE_BYTES as u64
            || (pending.length < SUBTREE_BYTES as u64 && state.next_offset != state.total_bytes)
            || pending.offset.checked_add(pending.length) != Some(state.next_offset)
        {
            return Err(Error::Checkpoint);
        }
        offset = state.next_offset;
    }
    if state.total_bytes > SUBTREE_BYTES as u64 && state.next_offset > 0 && state.pending.is_none()
    {
        return Err(Error::Checkpoint);
    }
    if offset != state.next_offset || state.next_offset > state.total_bytes {
        return Err(Error::Checkpoint);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(input: &[u8], cuts: &[usize]) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        let mut offset = 0;
        for size in cuts {
            if offset == input.len() {
                break;
            }
            let end = (offset + size).min(input.len());
            result.push(input[offset..end].to_vec());
            offset = end;
        }
        if offset < input.len() {
            result.push(input[offset..].to_vec());
        }
        result
    }

    fn compare(input: &[u8]) {
        let mut acc = Accumulator::new(input.len() as u64);
        let mut offset = 0;
        for part in pieces(input, &[SUBTREE_BYTES; 1000]) {
            acc.push(offset, &part).unwrap();
            offset += part.len() as u64;
            let checkpoint = acc.checkpoint();
            acc = Accumulator::resume(checkpoint).unwrap();
        }
        assert_eq!(
            acc.finalize().unwrap(),
            *blake3::hash(input).as_bytes(),
            "length {}",
            input.len()
        );
    }

    #[test]
    fn streamed_subtree_root_matches_one_shot_across_tree_shapes_and_tails() {
        for len in [
            0,
            1,
            1023,
            1024,
            32 * 1024 - 1,
            32 * 1024,
            32 * 1024 + 1,
            2 * 32 * 1024,
            3 * 32 * 1024,
            4 * 32 * 1024,
            5 * 32 * 1024 + 17,
            8 * 32 * 1024,
            16 * 32 * 1024,
            32 * 32 * 1024,
            16 * 32 * 1024 + 999,
            31 * 32 * 1024 + 32 * 1024 - 1,
        ] {
            let input: Vec<u8> = (0usize..len)
                .map(|i| (i.wrapping_mul(31) ^ (i >> 3)) as u8)
                .collect();
            compare(&input);
        }
        for piece_count in 0..=64usize {
            for tail in [0, 1, 1023, SUBTREE_BYTES - 1] {
                let len = piece_count * SUBTREE_BYTES + tail;
                let input: Vec<u8> = (0usize..len)
                    .map(|i| (i.wrapping_mul(31) ^ (i >> 3)) as u8)
                    .collect();
                compare(&input);
            }
        }
    }

    #[test]
    fn hostile_piece_boundaries_and_wrong_lengths_are_refused() {
        let mut acc = Accumulator::new((SUBTREE_BYTES * 2 + 3) as u64);
        assert_eq!(acc.push(1, b"x"), Err(Error::Offset));
        assert_eq!(
            acc.push(0, &vec![0; SUBTREE_BYTES + 1]),
            Err(Error::PieceSize)
        );
        assert_eq!(
            acc.push(0, &vec![0; SUBTREE_BYTES - 1]),
            Err(Error::PieceSize)
        );
        acc.push(0, &vec![0; SUBTREE_BYTES]).unwrap();
        assert_eq!(acc.push(SUBTREE_BYTES as u64 + 1, b"x"), Err(Error::Offset));
        assert_eq!(
            acc.push(SUBTREE_BYTES as u64, b"1234"),
            Err(Error::PieceSize)
        );
        assert_eq!(acc.finalize(), Err(Error::Incomplete));

        let mut too_long = Accumulator::new((SUBTREE_BYTES * 2 - 1) as u64);
        too_long.push(0, &vec![0; SUBTREE_BYTES]).unwrap();
        assert_eq!(
            too_long.push(SUBTREE_BYTES as u64, &vec![0; SUBTREE_BYTES]),
            Err(Error::Total)
        );
    }

    #[test]
    fn corrupted_or_inconsistent_checkpoints_are_refused() {
        let mut acc = Accumulator::new((SUBTREE_BYTES * 3 + 1) as u64);
        acc.push(0, &vec![0; SUBTREE_BYTES]).unwrap();
        let mut checkpoint = acc.checkpoint();
        checkpoint.next_offset += 1;
        assert!(matches!(
            Accumulator::resume(checkpoint),
            Err(Error::Checkpoint)
        ));
        let mut checkpoint = acc.checkpoint();
        checkpoint.version += 1;
        assert!(matches!(
            Accumulator::resume(checkpoint),
            Err(Error::Checkpoint)
        ));
    }

    #[test]
    fn retry_after_checkpoint_reuses_same_offset_and_digest() {
        let input = vec![0x5a; SUBTREE_BYTES * 2 + 17];
        let mut acc = Accumulator::new(input.len() as u64);
        acc.push(0, &input[..SUBTREE_BYTES]).unwrap();
        let saved = acc.checkpoint();
        let mut resumed = Accumulator::resume(saved).unwrap();
        resumed
            .push(
                SUBTREE_BYTES as u64,
                &input[SUBTREE_BYTES..2 * SUBTREE_BYTES],
            )
            .unwrap();
        resumed
            .push((2 * SUBTREE_BYTES) as u64, &input[2 * SUBTREE_BYTES..])
            .unwrap();
        assert_eq!(
            resumed.finalize().unwrap(),
            *blake3::hash(&input).as_bytes()
        );
    }

    #[test]
    fn checkpoint_can_be_serialized_and_resumed_between_piece_boundaries() {
        let input = vec![0x35; SUBTREE_BYTES * 9 + 4097];
        let mut acc = Accumulator::new(input.len() as u64);
        for index in 0..5 {
            let offset = index * SUBTREE_BYTES;
            acc.push(offset as u64, &input[offset..offset + SUBTREE_BYTES])
                .unwrap();
        }
        let stored = serde_json::to_vec(&acc.checkpoint()).unwrap();
        let checkpoint: Checkpoint = serde_json::from_slice(&stored).unwrap();
        let mut resumed = Accumulator::resume(checkpoint).unwrap();
        let mut offset = resumed.next_offset() as usize;
        while offset < input.len() {
            let end = (offset + SUBTREE_BYTES).min(input.len());
            resumed.push(offset as u64, &input[offset..end]).unwrap();
            offset = end;
        }
        assert_eq!(
            resumed.finalize().unwrap(),
            *blake3::hash(&input).as_bytes()
        );
    }

    #[test]
    fn checkpoint_with_equal_prefix_subtrees_is_rejected_as_noncanonical() {
        let input = vec![0x71; SUBTREE_BYTES * 3 + 1];
        let mut acc = Accumulator::new(input.len() as u64);
        for index in 0..3 {
            let offset = index * SUBTREE_BYTES;
            acc.push(offset as u64, &input[offset..offset + SUBTREE_BYTES])
                .unwrap();
        }
        let mut checkpoint = acc.checkpoint();
        assert_eq!(checkpoint.prefix.len(), 1);
        checkpoint.prefix.push(checkpoint.prefix[0].clone());
        assert!(matches!(
            Accumulator::resume(checkpoint),
            Err(Error::Checkpoint)
        ));
    }

    #[test]
    fn checkpoint_cv_integrity_depends_on_the_trusted_persistence_owner() {
        let input = vec![0x19; SUBTREE_BYTES * 2 + 9];
        let mut acc = Accumulator::new(input.len() as u64);
        acc.push(0, &input[..SUBTREE_BYTES]).unwrap();
        let mut checkpoint = acc.checkpoint();
        checkpoint.pending.as_mut().unwrap().cv[0] ^= 1;
        let mut reopened = Accumulator::resume(checkpoint).expect(
            "tree shape is valid; record store persistence, not this parser, authenticates saved state",
        );
        reopened
            .push(
                SUBTREE_BYTES as u64,
                &input[SUBTREE_BYTES..2 * SUBTREE_BYTES],
            )
            .unwrap();
        reopened
            .push((2 * SUBTREE_BYTES) as u64, &input[2 * SUBTREE_BYTES..])
            .unwrap();
        assert_ne!(
            reopened.finalize().unwrap(),
            *blake3::hash(&input).as_bytes(),
            "the persisted state owner must be trusted; this parser does not authenticate it"
        );
    }
}
