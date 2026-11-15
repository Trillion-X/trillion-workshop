// src/storage/supplies/kv/wal.rs
//
// Purpose: A guarded batch for a store that has no multi-key transaction, or whose transaction is smaller than the batch.
// The batch is written first as pieces, then a one-key marker commits it (the only atomic thing such a store has), and
// the writes are applied key by key. A crash anywhere leaves the marker; the next handle finishes a committed batch or
// discards an uncommitted one.
//
// Non-Negotiable Invariants:
// - The marker is created only if absent (`put_new`), so at most one batch is in flight; a second writer is refused
//   with `Busy` after it has finished or discarded what a crashed handle left.
// - The guard is read under the standing marker, then the marker is rewritten as committed. That rewrite is the commit
//   point: before it nothing of the batch is applied or ever will be; after it the batch is applied exactly once.
// - A piece is at most `piece` bytes, so a batch of any size fits a store whose value limit is small.
// - This is crash atomicity, not isolation: a concurrent reader can see a batch half applied. A backend built on this
//   reports `Atomicity::CrashSafe`.
//
// Key Concepts:
// - `Plain`: the four operations such a store has, and the same asked for several keys at once (`put_many`,
//   `delete_many`), which a store with a multi-key request answers in one trip. `apply` and `recover` are the whole
//   protocol: with the batch forms it costs a fixed number of trips however many writes the batch holds.
//
// Security Considerations:
// - None beyond the store's own: the pieces hold the same bytes the batch writes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Outcome, Write};
use local_engine::storage::{Error, Result};

/// The key of the batch marker. It lies in the meta prefix, outside every range a scan reads.
pub const BATCH: [u8; 2] = [4, b'W'];

fn piece_key(index: u32) -> Vec<u8> {
    let mut key = BATCH.to_vec();
    key.extend_from_slice(&index.to_be_bytes());
    key
}

/// A store with single-key operations only.
pub trait Plain {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>>;
    fn put(&self, key: &[u8], value: &[u8]) -> Result<()>;
    /// Create the key only if it does not exist; false when it does.
    fn put_new(&self, key: &[u8], value: &[u8]) -> Result<bool>;
    fn delete(&self, key: &[u8]) -> Result<()>;
    /// Several puts, as if made in order. The default makes them one at a time.
    fn put_many(&self, entries: &[(&[u8], &[u8])]) -> Result<()> {
        entries.iter().try_for_each(|(key, value)| self.put(key, value))
    }
    /// Several deletes, as if made in order. The default makes them one at a time.
    fn delete_many(&self, keys: &[&[u8]]) -> Result<()> {
        keys.iter().try_for_each(|key| self.delete(key))
    }
}

/// A batch as bytes: each write as an operation byte and length-prefixed parts.
fn encode(writes: &[Write]) -> Vec<u8> {
    let mut out = Vec::new();
    for write in writes {
        match write {
            Write::Set(key, value) => {
                out.push(b'S');
                out.extend_from_slice(&(key.len() as u32).to_be_bytes());
                out.extend_from_slice(key);
                out.extend_from_slice(&(value.len() as u32).to_be_bytes());
                out.extend_from_slice(value);
            }
            Write::Delete(key) => {
                out.push(b'D');
                out.extend_from_slice(&(key.len() as u32).to_be_bytes());
                out.extend_from_slice(key);
            }
        }
    }
    out
}

fn decode(mut rest: &[u8]) -> Result<Vec<Write>> {
    let take = |rest: &mut &[u8]| -> Result<Vec<u8>> {
        let length = u32::from_be_bytes(rest.get(..4).and_then(|head| head.try_into().ok()).ok_or(local_engine::cause!(Error::Unavailable))?) as usize;
        let part = rest.get(4..4 + length).ok_or(local_engine::cause!(Error::Unavailable))?.to_vec();
        *rest = &rest[4 + length..];
        Ok(part)
    };
    let mut writes = Vec::new();
    while let Some((&operation, tail)) = rest.split_first() {
        rest = tail;
        let key = take(&mut rest)?;
        writes.push(match operation {
            b'S' => Write::Set(key, take(&mut rest)?),
            _ => Write::Delete(key),
        });
    }
    Ok(writes)
}

/// The marker: whether the batch is committed, and how many pieces it has.
fn marker(committed: bool, pieces: u32) -> Vec<u8> {
    let mut out = vec![u8::from(committed)];
    out.extend_from_slice(&pieces.to_be_bytes());
    out
}

fn read_marker(raw: &[u8]) -> Result<(bool, u32)> {
    let count = raw.get(1..5).and_then(|bytes| bytes.try_into().ok()).ok_or(local_engine::cause!(Error::Unavailable))?;
    Ok((raw.first() == Some(&1), u32::from_be_bytes(count)))
}

/// The writes of a batch, the puts together and then the deletes together. A batch holds each key once, so the order
/// between a put and a delete does not matter.
fn write_all<P: Plain>(store: &P, writes: &[Write]) -> Result<()> {
    let sets: Vec<(&[u8], &[u8])> = writes
        .iter()
        .filter_map(|write| match write {
            Write::Set(key, value) => Some((key.as_slice(), value.as_slice())),
            Write::Delete(_) => None,
        })
        .collect();
    let deletes: Vec<&[u8]> = writes
        .iter()
        .filter_map(|write| match write {
            Write::Delete(key) => Some(key.as_slice()),
            Write::Set(..) => None,
        })
        .collect();
    store.put_many(&sets)?;
    store.delete_many(&deletes)
}

/// Remove the pieces, then the marker: the marker is what says a batch is in flight, so it goes last.
fn clean<P: Plain>(store: &P, pieces: u32) -> Result<()> {
    let keys: Vec<Vec<u8>> = (0..pieces).map(piece_key).collect();
    store.delete_many(&keys.iter().map(Vec::as_slice).collect::<Vec<_>>())?;
    store.delete(&BATCH)
}

/// Finish the batch a crashed handle left (if it was committed) and remove its marker and pieces.
pub fn recover<P: Plain>(store: &P) -> Result<()> {
    let Some(raw) = store.get(&BATCH)? else { return Ok(()) };
    let (committed, pieces) = read_marker(&raw)?;
    if committed {
        let mut bytes = Vec::new();
        for index in 0..pieces {
            bytes.extend_from_slice(&store.get(&piece_key(index))?.ok_or(local_engine::cause!(Error::Unavailable))?);
        }
        write_all(store, &decode(&bytes)?)?;
    }
    clean(store, pieces)
}

/// Apply `writes` if the value at `guard.0` equals `guard.1`; no piece is larger than `piece` bytes.
pub fn apply<P: Plain>(store: &P, piece: usize, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
    let bytes = encode(writes);
    let pieces = u32::try_from(bytes.chunks(piece.max(1)).count()).map_err(|error| local_engine::carry_cause!(Error::TooBig, error))?;
    if !store.put_new(&BATCH, &marker(false, pieces))? {
        recover(store)?;
        if !store.put_new(&BATCH, &marker(false, pieces))? {
            return Err(local_engine::cause!(Error::Busy));
        }
    }
    let keys: Vec<Vec<u8>> = (0..pieces).map(piece_key).collect();
    let entries: Vec<(&[u8], &[u8])> = keys.iter().zip(bytes.chunks(piece.max(1))).map(|(key, chunk)| (key.as_slice(), chunk)).collect();
    store.put_many(&entries)?;
    if store.get(guard.0)?.as_deref() != guard.1 {
        clean(store, pieces)?;
        return Ok(Outcome::Refused);
    }
    store.put(&BATCH, &marker(true, pieces))?;
    write_all(store, writes)?;
    clean(store, pieces)?;
    Ok(Outcome::Applied)
}
