// Purpose: The account's own files as where kept record history lives (`storage::record_store::history_archive`):
// a kept archive is written as one file of the account (`/<folder>/<resource>/<first version>.jsonl`, media type
// `application/gzip`), and read back through the same file list and byte owner any other file uses. Ported from old
// trillion `src/record-history.mjs` `keepRecordHistoryArchive` :352, which kept the archive in the person's file bucket
// with its BLAKE3 and encoding as metadata; here the file's own identity (`1f:` BLAKE3 of its bytes) and media type are
// those labels, so no second store and no extra metadata row exists.
//
// Non-Negotiable Invariants:
// - A read back is the file the account's files hold under that name, its declared size from its file record, its
//   bytes read in bounded ranges as the check pulls them (never the whole object at once).
// - The labels a read back carries are the file record's own: its identity (BLAKE3) and its media type (`gzip` only
//   for `application/gzip`), so a file replaced by anything else fails the check.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{AccountFiles, Origin};
use crate::storage::record_store::history_chain::{HistoryError, KeptObject, Keeper};
use crate::storage::Storage;

/// The bytes one read-back range pulls.
const RANGE_BYTES: u64 = 256 * 1024;

/// The account's files as a history keeper; `origins` are the stores new bytes may go to.
pub struct HistoryKeeper<'a, S: Storage + Send> {
    pub files: &'a mut AccountFiles<S>,
    pub origins: Vec<(String, Origin)>,
}

fn named(name: &str) -> String {
    if name.starts_with('/') { name.to_string() } else { format!("/{name}") }
}

impl<S: Storage + Send> Keeper for HistoryKeeper<'_, S> {
    fn put(&mut self, name: &str, bytes: &[u8], _blake3_hex: &str, encoding: &str) -> Result<(), HistoryError> {
        let media_type = if encoding == "gzip" { "application/gzip" } else { "application/octet-stream" };
        self.files.write_file(&named(name), bytes, media_type, &self.origins).map(|_| ()).map_err(|error| HistoryError::with_cause(format!("{error:?}"), error.cause()))
    }
    fn get(&mut self, name: &str) -> Result<Option<KeptObject<'_>>, HistoryError> {
        let found = match self.files.resolve(&named(name)) {
            Ok(found) => found,
            Err(super::AccountFilesError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(HistoryError::with_cause("The record history file did not read back.".to_string(), error.cause())),
        };
        let file = found.file;
        let size = file.value.get("byte_length").and_then(serde_json::Value::as_u64).ok_or_else(|| HistoryError::new("The kept file has no size.".to_string()))?;
        let blake3 = file.id.strip_prefix("1f:").map(str::to_owned);
        let encoding = (file.value.get("media_type").and_then(serde_json::Value::as_str) == Some("application/gzip")).then(|| "gzip".to_string());
        let files: &AccountFiles<S> = self.files;
        let mut offset = 0u64;
        let body = std::iter::from_fn(move || {
            if offset >= size {
                return None;
            }
            let length = RANGE_BYTES.min(size - offset);
            let piece = files.read_range(&file, offset, length).map_err(|error| HistoryError::with_cause(format!("{error:?}"), error.cause()));
            offset += length;
            Some(piece)
        });
        Ok(Some(KeptObject { size, blake3, encoding, body: Box::new(body) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_files::objects::{Body, Listing, ObjectError, Objects, Stat};
    use crate::records::{Mutation, Records};
    use crate::storage::memory::Memory;
    use crate::storage::record_store::{history_chain::{decode_archive, history_identity, keep_archive}, settings, RecordStore, RealClock};
    use serde_json::json;
    use std::{collections::HashMap, io::Read as _, sync::{Arc, Mutex}};

    #[derive(Default)]
    struct Held(Mutex<HashMap<String, Vec<u8>>>);
    struct Port(Arc<Held>);
    impl Objects for Port {
        fn set_control(&mut self, _: crate::account_files::CallControl) {}
        fn read(&self, _: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
            let objects = self.0 .0.lock().unwrap();
            let bytes = objects.get(key).ok_or(ObjectError::Refused(404, crate::cause!()))?;
            Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
        }
        fn write(&self, _: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
            self.0 .0.lock().unwrap().insert(key.to_owned(), bytes.to_vec());
            Ok(())
        }
        fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> {
            let mut bytes = Vec::new();
            body.bytes.take(body.length).read_to_end(&mut bytes).map_err(|error| ObjectError::Unavailable(error.to_string(), crate::cause!()))?;
            self.write(origin, key, &bytes, media_type)
        }
        fn stat(&self, _: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
            Ok(self.0 .0.lock().unwrap().get(key).map(|bytes| Stat { length: bytes.len() as u64, media_type: None }))
        }
        fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
            Ok(Listing::default())
        }
    }

    /// A kept history page goes into the account's own files, reads back through them, and its chain identity is the
    /// identity of the JSONL bytes the archive holds.
    #[test]
    fn a_kept_history_page_is_a_file_of_the_account_and_reads_back_exactly() {
        let store = Memory::open(crate::storage::record_store::SCHEMA).unwrap();
        let mut records = RecordStore::new(store.reopen(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
        let origin = json!({ "kind": "namespace-origin", "rank": 1, "file_key_prefix": "p/", "reach": {
            "key_id": {"value": "k"}, "secret": {"value": "s"}, "bucket": {"value": "b"}, "endpoint": {"value": "http://127.0.0.1:9"}, "region": {"value": "r"} } });
        records.mutate("a", super::super::ORIGINS, Mutation { id: "local".into(), expected_version: 0, request_key: "fill-origin".into(), deleted: false, value: origin }).unwrap();
        let mut files = AccountFiles::with_objects(records, "a", Box::new(Port(Arc::new(Held::default()))));
        let origins = files.origins().unwrap();
        let mut keeper = HistoryKeeper { files: &mut files, origins };
        let page = b"{\"history_chain\":{\"previous\":null}}\n{\"id\":\"n1\",\"version\":1}\n".repeat(50);
        let kept = keep_archive(&mut keeper, "record-history/notes/00000000000000000001-n1.jsonl", &page, &mut |_, _, _, _| {}, &mut || 0.0).unwrap();
        assert!(kept > 0);
        let found = files.find_file("/record-history/notes/00000000000000000001-n1.jsonl").unwrap();
        assert_eq!(found["media_type"], "application/gzip");
        {
            let mut keeper = HistoryKeeper { files: &mut files, origins: Vec::new() };
            let object = keeper.get("record-history/notes/00000000000000000001-n1.jsonl").unwrap().unwrap();
            let archived: Vec<u8> = object.body.map(Result::unwrap).flatten().collect();
            assert_eq!(history_identity(&decode_archive(&archived).unwrap()), history_identity(&page));
        }
        let mut keeper = HistoryKeeper { files: &mut files, origins: Vec::new() };
        assert!(keeper.get("record-history/notes/none.jsonl").unwrap().is_none());
    }
}
