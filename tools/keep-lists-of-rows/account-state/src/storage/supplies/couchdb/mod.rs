// src/storage/supplies/couchdb/mod.rs
//
// Purpose: The CouchDB-HTTP `Backend` for the shared key-value supply. One implementation serves CouchDB and the servers
// that speak its replication-friendly HTTP API (Cloudant, PouchDB Server).
//
// Non-Negotiable Invariants:
// - A key is a document id, the lowercase hex of the key's bytes; `_all_docs` lists ids in raw byte order, so a range of
//   the contract is a range of ids. CouchDB has no multi-document transaction (`_bulk_docs` is not all-or-nothing), so
//   a batch is the crash-atomic record protocol of `kv::wal`; `atomicity` says `CrashSafe`.
// - A write needs the document's current revision. The backend keeps the revisions it has read and re-reads one when
//   the server says it moved; a stale revision is never forced. Several writes are one `_bulk_docs` request after one
//   `_all_docs` request for the revisions not yet known; the documents the server answers `conflict` are asked again.
// - A deleted document leaves a tombstone (its id) until the database is purged; `reclaim` compacts, which removes
//   revisions' bodies but not tombstones. The README states this for custody.
//
// Key Concepts:
// - `CouchDb::connect(url, store_name)`: `http://user:password@host:port`; one database per store name.
//
// Security Considerations:
// - Basic credentials come from the caller's URL and are sent in the Authorization header; `place` omits them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{
    names::{hex, unhex},
    wal::{self, Plain},
    Ask, Atomicity, Backend, Entries, Fetched, Limits, Outcome, Write,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use local_engine::storage::{Error, Result};
use serde_json::{json, Value};
use std::{cell::Cell, cell::RefCell, collections::HashMap};

pub struct CouchDb {
    agent: ureq::Agent,
    base: String,
    authorization: String,
    revisions: RefCell<HashMap<String, String>>,
    rounds: Cell<u64>,
    place: String,
}

/// A reply: the status and the JSON body (Null when there is none).
struct Reply {
    status: u16,
    body: Value,
    etag: Option<String>,
}

impl CouchDb {
    /// Connect with `http://user:password@host:port` and keep the store name's keys in a database of its own.
    pub fn connect(url: &str, store_name: &str) -> Result<Self> {
        let rest = url.strip_prefix("http://").ok_or(local_engine::cause!(Error::Invalid))?;
        let (credentials, host) = rest.split_once('@').ok_or(local_engine::cause!(Error::Invalid))?;
        let couch = Self {
            agent: ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(120)).build(),
            base: format!("http://{host}/{store_name}"),
            authorization: format!("Basic {}", BASE64.encode(credentials)),
            revisions: RefCell::new(HashMap::new()),
            rounds: Cell::new(0),
            place: format!("http://{host}/{store_name}"),
        };
        let made = couch.send("PUT", "", None)?;
        if !matches!(made.status, 201 | 202 | 412) {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        wal::recover(&couch)?;
        Ok(couch)
    }

    fn send(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Reply> {
        self.rounds.set(self.rounds.get() + 1);
        let call = self.agent.request(method, &format!("{}{path}", self.base)).set("Authorization", &self.authorization).set("Accept", "application/json");
        let response = match body {
            Some(body) => call.set("Content-Type", "application/json").send_string(&body.to_string()),
            None => call.call(),
        };
        let (status, response) = match response {
            Ok(response) => (response.status(), response),
            Err(ureq::Error::Status(status, response)) => (status, response),
            Err(_) => return Err(local_engine::cause!(Error::Unavailable)),
        };
        let etag = response.header("ETag").map(|tag| tag.trim_matches('"').to_owned());
        let text = response.into_string().map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?;
        Ok(Reply { status, body: serde_json::from_str(&text).unwrap_or(Value::Null), etag })
    }

    fn remember(&self, id: &str, document: &Value) {
        if let Some(revision) = document.get("_rev").and_then(Value::as_str) {
            self.revisions.borrow_mut().insert(id.to_owned(), revision.to_owned());
        }
    }

    fn value_of(document: &Value) -> Result<Vec<u8>> {
        BASE64.decode(document.get("v").and_then(Value::as_str).ok_or(local_engine::cause!(Error::Unavailable))?).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))
    }

    /// Remember the current revision of every document in `ids` that exists, in one request for those not known yet.
    fn learn_revisions(&self, ids: &[String]) -> Result<()> {
        let unknown: Vec<&String> = {
            let known = self.revisions.borrow();
            ids.iter().filter(|id| !known.contains_key(*id)).collect()
        };
        if unknown.is_empty() {
            return Ok(());
        }
        let reply = self.send("POST", "/_all_docs", Some(&json!({"keys": unknown})))?;
        if reply.status != 200 {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        for row in reply.body["rows"].as_array().into_iter().flatten() {
            // A missing or deleted document has no revision to give.
            if let (Some(id), Some(revision), false) = (row["key"].as_str(), row["value"]["rev"].as_str(), row["value"]["deleted"] == json!(true)) {
                self.revisions.borrow_mut().insert(id.to_owned(), revision.to_owned());
            }
        }
        Ok(())
    }

    /// Write `documents` (`_id`, `_rev` when the document exists, and either `v` or `_deleted`) in one `_bulk_docs`
    /// request each time, asking again for the ones the server answered `conflict`, up to three times. `ids` and
    /// `build` make the document of one entry from its id and the revision known for it.
    fn bulk<T>(&self, mut entries: Vec<(String, T)>, build: impl Fn(&str, &T, Option<&String>) -> Option<Value>) -> Result<()> {
        for _ in 0..3 {
            let ids: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
            self.learn_revisions(&ids)?;
            let documents: Vec<(usize, Value)> = {
                let known = self.revisions.borrow();
                entries.iter().enumerate().filter_map(|(at, (id, one))| build(id, one, known.get(id)).map(|document| (at, document))).collect()
            };
            if documents.is_empty() {
                return Ok(());
            }
            let reply = self.send("POST", "/_bulk_docs", Some(&json!({"docs": documents.iter().map(|(_, document)| document).collect::<Vec<_>>()})))?;
            if !matches!(reply.status, 201 | 202) {
                return Err(local_engine::cause!(Error::Unavailable));
            }
            let results = reply.body.as_array().ok_or(local_engine::cause!(Error::Unavailable))?;
            let mut again = Vec::new();
            for ((at, document), result) in documents.iter().zip(results) {
                let id = document["_id"].as_str().unwrap_or_default().to_owned();
                match (result["rev"].as_str(), result["error"].as_str()) {
                    (Some(revision), None) if document["_deleted"] != json!(true) => {
                        self.revisions.borrow_mut().insert(id, revision.to_owned());
                    }
                    (Some(_), None) => {
                        self.revisions.borrow_mut().remove(&id);
                    }
                    (_, Some("conflict")) => {
                        self.revisions.borrow_mut().remove(&id);
                        again.push(*at);
                    }
                    _ => return Err(local_engine::cause!(Error::Unavailable)),
                }
            }
            if again.is_empty() {
                return Ok(());
            }
            let mut keep = vec![false; entries.len()];
            again.into_iter().for_each(|at| keep[at] = true);
            let mut at = 0;
            entries.retain(|_| {
                at += 1;
                keep[at - 1]
            });
        }
        Err(local_engine::cause!(Error::Busy))
    }

    /// The current revision of a document, or None when it does not exist.
    fn revision(&self, id: &str) -> Result<Option<String>> {
        if let Some(revision) = self.revisions.borrow().get(id) {
            return Ok(Some(revision.clone()));
        }
        let head = self.send("HEAD", &format!("/{id}"), None)?;
        match head.status {
            200 => Ok(head.etag),
            404 => Ok(None),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }
}

impl Plain for CouchDb {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let id = hex(key);
        let reply = self.send("GET", &format!("/{id}"), None)?;
        match reply.status {
            200 => {
                self.remember(&id, &reply.body);
                Ok(Some(Self::value_of(&reply.body)?))
            }
            404 => {
                self.revisions.borrow_mut().remove(&id);
                Ok(None)
            }
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<()> {
        let id = hex(key);
        for _ in 0..3 {
            let mut document = json!({"v": BASE64.encode(value)});
            if let Some(revision) = self.revision(&id)? {
                document["_rev"] = json!(revision);
            }
            let reply = self.send("PUT", &format!("/{id}"), Some(&document))?;
            match reply.status {
                201 | 202 => {
                    if let Some(revision) = reply.body.get("rev").and_then(Value::as_str) {
                        self.revisions.borrow_mut().insert(id, revision.to_owned());
                    }
                    return Ok(());
                }
                409 => {
                    self.revisions.borrow_mut().remove(&id);
                }
                _ => return Err(local_engine::cause!(Error::Unavailable)),
            }
        }
        Err(local_engine::cause!(Error::Busy))
    }

    fn put_new(&self, key: &[u8], value: &[u8]) -> Result<bool> {
        let id = hex(key);
        let reply = self.send("PUT", &format!("/{id}"), Some(&json!({"v": BASE64.encode(value)})))?;
        match reply.status {
            201 | 202 => {
                if let Some(revision) = reply.body.get("rev").and_then(Value::as_str) {
                    self.revisions.borrow_mut().insert(id, revision.to_owned());
                }
                Ok(true)
            }
            409 => Ok(false),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn put_many(&self, entries: &[(&[u8], &[u8])]) -> Result<()> {
        for run in entries.chunks(500) {
            let entries: Vec<(String, &[u8])> = run.iter().map(|(key, value)| (hex(key), *value)).collect();
            self.bulk(entries, |id, value, revision| {
                let mut document = json!({"_id": id, "v": BASE64.encode(value)});
                if let Some(revision) = revision {
                    document["_rev"] = json!(revision);
                }
                Some(document)
            })?;
        }
        Ok(())
    }

    fn delete_many(&self, keys: &[&[u8]]) -> Result<()> {
        for run in keys.chunks(500) {
            let entries: Vec<(String, ())> = run.iter().map(|key| (hex(key), ())).collect();
            // A document that does not exist has nothing to delete.
            self.bulk(entries, |id, _, revision| revision.map(|revision| json!({"_id": id, "_rev": revision, "_deleted": true})))?;
        }
        Ok(())
    }

    fn delete(&self, key: &[u8]) -> Result<()> {
        let id = hex(key);
        for _ in 0..3 {
            let Some(revision) = self.revision(&id)? else { return Ok(()) };
            let reply = self.send("DELETE", &format!("/{id}?rev={revision}"), None)?;
            match reply.status {
                200 | 202 => {
                    self.revisions.borrow_mut().remove(&id);
                    return Ok(());
                }
                409 => {
                    self.revisions.borrow_mut().remove(&id);
                }
                404 => return Ok(()),
                _ => return Err(local_engine::cause!(Error::Unavailable)),
            }
        }
        Err(local_engine::cause!(Error::Busy))
    }
}

impl Backend for CouchDb {
    fn atomicity(&self) -> Atomicity {
        Atomicity::CrashSafe
    }

    fn limits(&self) -> Limits {
        // The default document limit is 8 MB, and the value travels as base64.
        Limits { max_key: 256, max_value: 5 * 1024 * 1024, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Plain::get(self, key)
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        Ok(self.read_many(keys, &[])?.0)
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Entries> {
        let ask = Ask { lo: lo.to_vec(), hi: hi.map(<[u8]>::to_vec), reverse, limit, values };
        self.read_many(&[], std::slice::from_ref(&ask))?.1.pop().ok_or(local_engine::cause!(Error::Unavailable))
    }

    /// The keys and each range as the queries of one `_all_docs/queries` request, answered in order.
    fn read_many(&self, keys: &[Vec<u8>], asks: &[Ask]) -> Result<Fetched> {
        let ids: Vec<String> = keys.iter().map(|key| hex(key)).collect();
        let mut queries = Vec::new();
        if !ids.is_empty() {
            queries.push(json!({"keys": ids, "include_docs": true}));
        }
        for ask in asks {
            let (low, high) = (hex(&ask.lo), ask.hi.as_deref().map(hex));
            // Ascending: `[lo, hi)`. Descending starts at the upper end, which the server includes, so it is skipped below.
            let limit = ask.limit.saturating_add(usize::from(ask.reverse && high.is_some())).min(1_000_000);
            queries.push(if ask.reverse {
                json!({"include_docs": ask.values, "limit": limit, "descending": true, "startkey": high.as_deref().unwrap_or("g"), "endkey": low})
            } else if let Some(high) = &high {
                json!({"include_docs": ask.values, "limit": limit, "startkey": low, "endkey": high, "inclusive_end": false})
            } else {
                json!({"include_docs": ask.values, "limit": limit, "startkey": low})
            });
        }
        if queries.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let reply = self.send("POST", "/_all_docs/queries", Some(&json!({"queries": queries})))?;
        if reply.status != 200 {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        let results = reply.body["results"].as_array().ok_or(local_engine::cause!(Error::Unavailable))?;
        if results.len() != queries.len() {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        let found = if ids.is_empty() {
            Vec::new()
        } else {
            let mut found = HashMap::new();
            for row in results[0]["rows"].as_array().into_iter().flatten() {
                if let (Some(id), Some(document)) = (row["id"].as_str(), row.get("doc").filter(|doc| !doc.is_null())) {
                    self.remember(id, document);
                    found.insert(id.to_owned(), Self::value_of(document)?);
                }
            }
            ids.iter().map(|id| found.get(id).cloned()).collect()
        };
        let first = usize::from(!ids.is_empty());
        let ranges = asks
            .iter()
            .enumerate()
            .map(|(at, ask)| {
                let upper = ask.hi.as_deref().map(hex);
                let mut entries = Vec::new();
                for row in results[first + at]["rows"].as_array().into_iter().flatten() {
                    let id = row["id"].as_str().ok_or(local_engine::cause!(Error::Unavailable))?;
                    if ask.reverse && upper.as_deref() == Some(id) {
                        continue;
                    }
                    let value = if ask.values {
                        let document = &row["doc"];
                        self.remember(id, document);
                        Self::value_of(document)?
                    } else {
                        Vec::new()
                    };
                    entries.push((unhex(id).ok_or(local_engine::cause!(Error::Unavailable))?, value));
                }
                entries.truncate(ask.limit);
                Ok(entries)
            })
            .collect::<Result<_>>()?;
        Ok((found, ranges))
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        wal::apply(self, 1024 * 1024, guard, writes)
    }

    fn reclaim(&self) -> Result<()> {
        let started = self.send("POST", "/_compact", Some(&json!({})))?;
        if !matches!(started.status, 202) {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        for _ in 0..600 {
            let info = self.send("GET", "", None)?;
            if info.body["compact_running"] == json!(false) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(local_engine::cause!(Error::Interrupted))
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
