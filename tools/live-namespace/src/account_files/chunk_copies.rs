// src/account_files/chunk_copies.rs
//
// Purpose: A checked copy of each stored chunk on the computer this program runs on, kept between the person's byte store and every
// reader. A chunk object is one stored object keyed by its BLAKE3 (`@namespace/chunks`, id `1f:` and the digest of its bytes), so a
// copy is filed under that digest and a reader of any file, name or device that holds the chunk is served from the copy before the
// store is asked. This is what took a second device from 7.86 s to 2.4 s in the Oct 5 2026 measurements (streaming-bar.md B7, B8):
// the store is cold and costs egress on every request, the copy is a read of a local file.
//
// Non-Negotiable Invariants:
// - Checked before kept: a copy is written only from bytes whose BLAKE3 equals the identity it is filed under. A copy found in the
//   folder (made by an earlier run) is hashed once, the first time this process reads it, and a copy whose length or digest is wrong is
//   removed and the read goes to the store.
// - The copy never grants access. It sits below every access check (`read_range` is reached only after the call's rights and byte
//   admission); a hit only answers bytes the caller was already allowed to read, and the one extra store read a fill makes goes through
//   the same call's byte admission and is counted like any read.
// - No special host: the folder is in each program's own state folder, owner-only, derived per computer. Nothing is shared between
//   computers; each warms its own.
// - Every number is DATA (`settings.json` `chunk_copies`): the share of the free disk it may keep (read once when it opens), how many
//   times a chunk is asked before the rest of it is fetched, and how many extra bytes one call may fetch to fill. A failure to make or
//   write a copy (no folder, a full disk) is never a failure of the read: the read goes through to the store.
// - Only chunk objects are copied. A file kept as one object (no chunk identity) is never copied: nothing proves its bytes.
//
// Key Concepts:
// - `get`: the bytes of a range of a chunk, or None. `wants_fill`: whether this ask is the one that should fetch the whole chunk (a
//   chunk read once is not widened: a one-off range would otherwise cost the whole chunk's egress). `keep`: check and file a whole chunk.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::tool_runs::os::{Open, OwnerFiles, This};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

/// `settings.json` `chunk_copies`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// The folder in the state folder the copies are kept in.
    pub folder: String,
    /// The share, in percent, of the disk's free bytes (read once when the copies open) the copies may hold, counting what they already hold.
    pub keep_percent_of_free: u64,
    /// How many times a chunk is asked, by reads that miss, before the whole chunk is fetched and kept.
    pub touches_before_fill: u32,
    /// The most chunks whose asks are remembered (memory only; the oldest ask is forgotten first).
    pub touches_kept: usize,
    /// The most extra bytes one call fetches to fill chunks (a chunk larger than what is left is read as asked).
    pub fill_bytes_most_per_call: u64,
}

struct Entry {
    size: u64,
    seq: u64,
    /// Whether this process has hashed the file (a copy it just kept is).
    verified: bool,
}

#[derive(Default)]
struct State {
    held: HashMap<String, Entry>,
    /// Use order: sequence number to digest, the smallest is the oldest.
    order: BTreeMap<u64, String>,
    bytes: u64,
    seq: u64,
    touches: HashMap<String, (u32, u64)>,
    touch_order: BTreeMap<u64, String>,
}

/// The copies of one folder.
pub struct ChunkCopies {
    folder: PathBuf,
    settings: Settings,
    most_bytes: u64,
    state: Mutex<State>,
}

/// The digest of a chunk identity `1f:<64 lowercase hex>`, nothing else (it names a file, so it is checked).
fn digest_of(id: &str) -> Option<&str> {
    let digest = id.strip_prefix("1f:")?;
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).then_some(digest)
}

impl ChunkCopies {
    /// The copies in `folder`, holding at most `keep_percent_of_free` of `free_bytes` (what is already there counts). None when the
    /// folder cannot be made owner-only: reads then go to the store.
    pub fn open(folder: &Path, settings: Settings, free_bytes: u64) -> Option<Arc<Self>> {
        This::make_folder(folder, 0o700, true).ok().or_else(|| folder.is_dir().then_some(()))?;
        let mut found: Vec<(std::time::SystemTime, String, u64)> = Vec::new();
        for item in std::fs::read_dir(folder).ok()?.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let Ok(meta) = item.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            if digest_of(&format!("1f:{name}")).is_none() {
                // Not a copy: a part left by a run that stopped.
                let _ = std::fs::remove_file(item.path());
                continue;
            }
            found.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), name, meta.len()));
        }
        found.sort();
        let mut state = State::default();
        for (_, name, size) in found {
            state.seq += 1;
            state.order.insert(state.seq, name.clone());
            state.bytes += size;
            state.held.insert(name, Entry { size, seq: state.seq, verified: false });
        }
        let most_bytes = (u128::from(free_bytes.saturating_add(state.bytes)) * u128::from(settings.keep_percent_of_free.min(100)) / 100) as u64;
        Some(Arc::new(Self { folder: folder.to_owned(), settings, most_bytes, state: Mutex::new(state) }))
    }

    /// The one set of copies of `folder` this process holds, opened with the shipped settings and the folder's own free bytes.
    pub fn shared(folder: &Path) -> Option<Arc<Self>> {
        static OPEN: OnceLock<Mutex<HashMap<PathBuf, Option<Arc<ChunkCopies>>>>> = OnceLock::new();
        let mut open = OPEN.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        open.entry(folder.to_owned())
            .or_insert_with(|| {
                let settings = super::settings::settings().chunk_copies.clone();
                let free = This::free_bytes(folder.parent().unwrap_or(folder)).unwrap_or(0);
                Self::open(folder, settings, free)
            })
            .clone()
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn forget(&self, state: &mut State, digest: &str) {
        if let Some(entry) = state.held.remove(digest) {
            state.order.remove(&entry.seq);
            state.bytes = state.bytes.saturating_sub(entry.size);
        }
        let _ = std::fs::remove_file(self.folder.join(digest));
    }

    /// `length` bytes from `from` of the chunk `id` of `size` bytes, from its copy. None when there is no copy, or the copy is not the
    /// chunk (wrong length, or its bytes do not hash to `id`): such a copy is removed.
    pub fn get(&self, id: &str, size: u64, from: u64, length: u64) -> Option<Vec<u8>> {
        let digest = digest_of(id)?;
        if length == 0 || from.checked_add(length)? > size {
            return None;
        }
        let verify = {
            let state = self.lock();
            let entry = state.held.get(digest)?;
            if entry.size != size {
                drop(state);
                let mut state = self.lock();
                self.forget(&mut state, digest);
                return None;
            }
            !entry.verified
        };
        let path = self.folder.join(digest);
        let file = This::open(std::fs::OpenOptions::new().read(true), &path, Open::NO_FOLLOW).ok();
        let bytes = file.as_ref().and_then(|file| {
            if verify {
                let mut whole = Vec::with_capacity(size as usize);
                (&*file).take(size + 1).read_to_end(&mut whole).ok()?;
                (whole.len() as u64 == size && blake3::hash(&whole).to_hex().as_str() == digest).then(|| whole[from as usize..(from + length) as usize].to_vec())
            } else {
                let mut part = vec![0u8; length as usize];
                This::read_exact_at(file, &mut part, from).ok()?;
                Some(part)
            }
        });
        let mut state = self.lock();
        match bytes {
            Some(bytes) => {
                state.seq += 1;
                let seq = state.seq;
                if let Some(entry) = state.held.get_mut(digest) {
                    let old = std::mem::replace(&mut entry.seq, seq);
                    entry.verified = true;
                    state.order.remove(&old);
                    state.order.insert(seq, digest.to_owned());
                }
                Some(bytes)
            }
            None => {
                self.forget(&mut state, digest);
                None
            }
        }
    }

    /// Count one ask that missed the copies for `id`; true when this ask should fetch the whole chunk and keep it.
    pub fn wants_fill(&self, id: &str, size: u64) -> bool {
        let Some(digest) = digest_of(id) else { return false };
        if size == 0 || size > self.most_bytes {
            return false;
        }
        let mut state = self.lock();
        state.seq += 1;
        let seq = state.seq;
        let (count, old) = state.touches.get(digest).copied().unwrap_or((0, 0));
        state.touch_order.remove(&old);
        state.touches.insert(digest.to_owned(), (count + 1, seq));
        state.touch_order.insert(seq, digest.to_owned());
        while state.touches.len() > self.settings.touches_kept.max(1) {
            let Some((_, oldest)) = state.touch_order.pop_first() else { break };
            state.touches.remove(&oldest);
        }
        count + 1 >= self.settings.touches_before_fill
    }

    /// Keep the whole chunk `id` as `bytes`, when they hash to `id` (they are then made room for by letting the oldest copies go).
    /// True when kept. A failure to write is not an error: the copy is simply not there.
    pub fn keep(&self, id: &str, bytes: &[u8]) -> bool {
        let Some(digest) = digest_of(id) else { return false };
        let size = bytes.len() as u64;
        if size == 0 || size > self.most_bytes || blake3::hash(bytes).to_hex().as_str() != digest {
            return false;
        }
        {
            let mut state = self.lock();
            if state.held.get(digest).is_some_and(|entry| entry.size == size) {
                return true;
            }
            self.forget(&mut state, digest);
            while state.bytes + size > self.most_bytes {
                let Some((_, oldest)) = state.order.pop_first() else { break };
                if let Some(entry) = state.held.remove(&oldest) {
                    state.bytes = state.bytes.saturating_sub(entry.size);
                }
                let _ = std::fs::remove_file(self.folder.join(&oldest));
            }
        }
        let part = self.folder.join(format!("{digest}.part"));
        let written = (|| {
            use std::io::Write;
            let mut file = This::open(std::fs::OpenOptions::new().write(true).create(true).truncate(true), &part, Open::owner_only(0o600)).ok()?;
            file.write_all(bytes).ok()?;
            file.sync_data().ok()?;
            std::fs::rename(&part, self.folder.join(digest)).ok()
        })();
        if written.is_none() {
            let _ = std::fs::remove_file(&part);
            return false;
        }
        let mut state = self.lock();
        state.seq += 1;
        let seq = state.seq;
        state.order.insert(seq, digest.to_owned());
        state.bytes += size;
        state.held.insert(digest.to_owned(), Entry { size, seq, verified: true });
        state.touches.remove(digest);
        true
    }
}

impl super::AccountFiles {
    /// Keep the checked copies of chunks in `copies` (the state folder's, `ChunkCopies::shared`): reads of a chunk are then answered
    /// from its copy when it has one, and the store is asked only for what is missing.
    pub fn with_chunk_copies(mut self, copies: Option<Arc<ChunkCopies>>) -> Self {
        self.copies = copies;
        self
    }

    /// One window of `wanted` (`(origin, key, offset in the chunk, length)`, one per piece of `pieces`, whose chunk records are
    /// `chunks`), written to `out` in order (`read_pieces`): each piece from its copy when there is one, the rest from the store. A
    /// piece that covers its whole chunk is kept as it is read; a chunk asked a second time without a copy is read whole, within the
    /// call's fill budget, kept, and the part asked is cut from it: the first ask of a chunk is never widened, so a one-off range costs
    /// what it always cost.
    pub(super) fn read_chunks_into(&self, pieces: &[(u64, u64, String)], chunks: &[Option<super::Record>], wanted: &[(&str, &str, u64, u64)],
        out: &mut (dyn std::io::Write + Send)) -> super::Answer<()> {
        let Some(copies) = self.copies.as_deref() else { return self.read_pieces(wanted.iter().copied().map(super::Piece::store).collect(), out) };
        let mut planned = Vec::with_capacity(wanted.len());
        let mut budget = copies.settings().fill_bytes_most_per_call;
        for (at, ((_, span, id), want)) in pieces.iter().zip(wanted).enumerate() {
            let size = chunks.get(at).and_then(Option::as_ref).and_then(|chunk| chunk.value.get("byte_length")).and_then(serde_json::Value::as_u64);
            let Some(size) = size.filter(|size| size == span) else {
                planned.push(super::Piece::store(*want));
                continue;
            };
            if let Some(bytes) = copies.get(id, size, want.2, want.3) {
                planned.push(super::Piece::InHand(bytes));
            } else if want.2 == 0 && want.3 == size {
                planned.push(super::Piece::Read(super::Read { read: *want, keep: Some((id.as_str(), 0, size as usize)) }));
            } else if size <= budget && copies.wants_fill(id, size) {
                budget -= size;
                planned.push(super::Piece::Read(super::Read { read: (want.0, want.1, 0, size), keep: Some((id.as_str(), want.2 as usize, want.3 as usize)) }));
            } else {
                planned.push(super::Piece::store(*want));
            }
        }
        self.read_pieces(planned, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings { folder: "chunk-copies".into(), keep_percent_of_free: 100, touches_before_fill: 2, touches_kept: 4, fill_bytes_most_per_call: 1 << 20 }
    }
    fn id_of(bytes: &[u8]) -> String {
        format!("1f:{}", blake3::hash(bytes).to_hex())
    }
    fn copies(free: u64) -> (tempfile::TempDir, Arc<ChunkCopies>) {
        let dir = tempfile::tempdir().unwrap();
        let copies = ChunkCopies::open(&dir.path().join("c"), settings(), free).unwrap();
        (dir, copies)
    }

    #[test]
    fn a_kept_chunk_answers_any_range_of_it_and_nothing_else() {
        let (_dir, copies) = copies(1000);
        let bytes: Vec<u8> = (0..100u8).collect();
        let id = id_of(&bytes);
        assert!(copies.get(&id, 100, 0, 10).is_none());
        assert!(copies.keep(&id, &bytes));
        assert_eq!(copies.get(&id, 100, 10, 5).unwrap(), &bytes[10..15]);
        assert_eq!(copies.get(&id, 100, 0, 100).unwrap(), bytes);
        assert!(copies.get(&id, 100, 99, 2).is_none(), "past the end");
        assert!(copies.get(&id, 99, 0, 1).is_none(), "another length is another chunk");
    }

    #[test]
    fn bytes_that_do_not_hash_to_the_identity_are_never_kept() {
        let (_dir, copies) = copies(1000);
        let id = id_of(b"right");
        assert!(!copies.keep(&id, b"wrong"));
        assert!(copies.get(&id, 5, 0, 5).is_none());
        assert!(!copies.keep("1f:../../x", b"x"), "an identity that is not a digest names no file");
    }

    #[test]
    fn a_copy_changed_on_disk_is_refused_and_removed_whatever_its_length() {
        let (dir, copies) = copies(1000);
        let bytes = vec![7u8; 64];
        let id = id_of(&bytes);
        assert!(copies.keep(&id, &bytes));
        // A new run finds the file and has not hashed it.
        let path = dir.path().join("c").join(&id[3..]);
        std::fs::write(&path, vec![8u8; 64]).unwrap();
        let again = ChunkCopies::open(&dir.path().join("c"), settings(), 1000).unwrap();
        assert!(again.get(&id, 64, 0, 4).is_none());
        assert!(!path.exists(), "removed");
        // The same, a copy that was cut short.
        assert!(again.keep(&id, &bytes));
        std::fs::write(&path, vec![7u8; 10]).unwrap();
        let cut = ChunkCopies::open(&dir.path().join("c"), settings(), 1000).unwrap();
        assert!(cut.get(&id, 64, 0, 4).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn the_oldest_copies_go_first_when_the_bound_is_reached_and_a_read_is_a_use() {
        let (dir, copies) = copies(0);
        // 250 bytes may be kept: the bound is the share of what is free plus what is held (nothing here), so open with room.
        drop(copies);
        let copies = ChunkCopies::open(&dir.path().join("c2"), Settings { keep_percent_of_free: 100, ..settings() }, 250).unwrap();
        let chunks: Vec<Vec<u8>> = (1..=3u8).map(|n| vec![n; 100]).collect();
        let ids: Vec<String> = chunks.iter().map(|chunk| id_of(chunk)).collect();
        assert!(copies.keep(&ids[0], &chunks[0]));
        assert!(copies.keep(&ids[1], &chunks[1]));
        assert!(copies.get(&ids[0], 100, 0, 1).is_some(), "the first is used again, so the second is now the oldest");
        assert!(copies.keep(&ids[2], &chunks[2]));
        assert!(copies.get(&ids[1], 100, 0, 1).is_none(), "the oldest went");
        assert!(copies.get(&ids[0], 100, 0, 1).is_some());
        assert!(copies.get(&ids[2], 100, 0, 1).is_some());
        assert!(!copies.keep(&id_of(&vec![9u8; 300]), &vec![9u8; 300]), "a chunk over the whole bound is not kept");
    }

    #[test]
    fn a_chunk_is_filled_on_its_second_miss_and_forgotten_asks_do_not_count() {
        let (_dir, copies) = copies(1000);
        let id = id_of(b"a");
        assert!(!copies.wants_fill(&id, 10));
        assert!(copies.wants_fill(&id, 10));
        for n in 0..6u8 {
            copies.wants_fill(&id_of(&[n, 1]), 10);
        }
        assert!(!copies.wants_fill(&id, 10), "its first ask was forgotten, so this counts once");
    }

    #[test]
    fn a_folder_that_cannot_be_made_gives_no_copies() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(ChunkCopies::open(&file.join("c"), settings(), 1000).is_none());
    }
}
