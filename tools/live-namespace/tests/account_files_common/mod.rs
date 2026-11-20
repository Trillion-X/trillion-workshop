// tests/account_files_common/mod.rs
//
// Purpose: The account files over a record store in memory and a byte port in memory that serves only exact ranges,
// keeps every write and removal it was asked for, and can be told to refuse removals; shared by the byte release, name
// retirement and results tests. Synthetic data only.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
};
use live_namespace::{
    account_files::{
        objects::{Body, Listing, ObjectError, Objects, Stat},
        AccountFiles, CallControl, ORIGINS,
    },
    store::{Mutation, SqlStore, Store},
};

pub const ACCOUNT: &str = "account-a";
pub const ORIGIN: &str = "local-store";
pub const PREFIX: &str = "people/p/files/";

/// Objects in memory: (origin, key) -> bytes, with what was written and removed.
#[derive(Default)]
pub struct Held {
    pub objects: Mutex<HashMap<(String, String), Vec<u8>>>,
    pub removed: Mutex<Vec<(String, String)>>,
    pub refuse_removal: Mutex<bool>,
    pub writes: Mutex<u64>,
}
pub struct Port(pub Arc<Held>);
impl Objects for Port {
    fn set_control(&mut self, _: CallControl) {}
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        let objects = self.0.objects.lock().unwrap();
        let bytes = objects.get(&(origin.to_owned(), key.to_owned())).ok_or(ObjectError::Refused(404, live_namespace::cause!()))?;
        if length == 0 || offset + length > bytes.len() as u64 {
            return Err(ObjectError::Refused(416, live_namespace::cause!()));
        }
        Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
        *self.0.writes.lock().unwrap() += 1;
        self.0.objects.lock().unwrap().insert((origin.to_owned(), key.to_owned()), bytes.to_vec());
        Ok(())
    }
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> {
        let mut bytes = Vec::new();
        body.bytes.take(body.length).read_to_end(&mut bytes).map_err(|error| ObjectError::Unavailable(error.to_string(), live_namespace::cause!()))?;
        self.write(origin, key, &bytes, media_type)
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        Ok(self.0.objects.lock().unwrap().get(&(origin.to_owned(), key.to_owned())).map(|bytes| Stat { length: bytes.len() as u64, media_type: None }))
    }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
        Ok(Listing::default())
    }
    fn delete(&self, origin: &str, key: &str) -> Result<(), ObjectError> {
        if *self.0.refuse_removal.lock().unwrap() {
            return Err(ObjectError::Refused(503, live_namespace::cause!()));
        }
        self.0.objects.lock().unwrap().remove(&(origin.to_owned(), key.to_owned()));
        self.0.removed.lock().unwrap().push((origin.to_owned(), key.to_owned()));
        Ok(())
    }
}

/// A clock the test moves.
pub struct Clock(pub Arc<AtomicU64>);
impl Clock {
    pub fn later_minutes(&self, minutes: u64) {
        self.0.fetch_add(minutes * 60_000, Ordering::SeqCst);
    }
    pub fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// An origin record of a loopback stand-in store.
pub fn origin(takes_new_bytes: bool) -> Value {
    let value = |text: &str| json!({ "value": text });
    json!({
        "kind": live_namespace::account_files::ORIGIN_KIND, "rank": 1, "takes_new_bytes": takes_new_bytes, "file_key_prefix": PREFIX,
        "reach": { "key_id": value("k"), "secret": value("s"), "bucket": value("b"), "endpoint": value("http://127.0.0.1:9"), "region": value("r") },
    })
}

/// Empty account files with one loopback store, its bytes in `Held`, and a clock the test moves.
pub fn account_files() -> (AccountFiles, Arc<Held>, Clock) {
    account_files_over(Arc::new(SqlStore::memory().unwrap()))
}

/// Account files over the record store `store` (a counting or otherwise wrapped one), with the same origin, bytes and clock.
pub fn account_files_over(store: Store) -> (AccountFiles, Arc<Held>, Clock) {
    store.mutate(ORIGINS, Mutation { id: ORIGIN.into(), expected_version: 0, request_key: "origin".into(), deleted: false, value: origin(true) }).unwrap();
    let held = Arc::new(Held::default());
    let time = Arc::new(AtomicU64::new(1_790_000_000_000));
    let clock = time.clone();
    let files = AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone()))).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
    (files, held, Clock(time))
}

/// One tool call of the contract.
pub fn call(files: &mut AccountFiles, tool: &str, input: Value) -> Result<Value, live_namespace::account_files::AccountFilesError> {
    files.call(tool, &input).expect("an account files tool")
}

/// Write `bytes` under `name` whole; the answer is its identity.
pub fn write(files: &mut AccountFiles, name: &str, bytes: &[u8]) -> String {
    let origins = files.origins().unwrap();
    files.write_file(name, bytes, "text/plain", &origins).unwrap()["identity"].as_str().unwrap().to_owned()
}

/// Upload `bytes` under `name` in 32 KiB pieces as upload `upload` (one hex digit, repeated); the answer is its identity.
pub fn upload(files: &mut AccountFiles, upload: char, name: &str, bytes: &[u8]) -> String {
    let upload_id: String = std::iter::repeat_n(upload, 32).collect();
    files.write_file_start(&upload_id, name, bytes.len() as u64, "application/octet-stream", None).unwrap();
    for (at, piece) in bytes.chunks(32 * 1024).enumerate() {
        files.write_file_piece(&upload_id, name, (at * 32 * 1024) as u64, piece).unwrap();
    }
    files.write_file_finish(&upload_id, name).unwrap()["identity"].as_str().unwrap().to_owned()
}

/// The stored keys, sorted.
pub fn keys(held: &Held) -> Vec<String> {
    let mut keys: Vec<String> = held.objects.lock().unwrap().keys().map(|(_, key)| key.clone()).collect();
    keys.sort();
    keys
}
