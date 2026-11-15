// src/storage/supplies/mongo/mod.rs
//
// Purpose: The Mongo-wire `Backend` for the shared key-value supply. One implementation serves every server that speaks
// the MongoDB wire protocol: MongoDB itself, FerretDB, DocumentDB and Cosmos DB for MongoDB.
//
// Non-Negotiable Invariants:
// - A key is a document whose `_id` is the lowercase hex of the key's bytes, a string, so the server's default
//   (binary) string order is byte order. BSON binary values are not used as ids: Mongo orders them by length first.
// - On a replica set a batch is one multi-document transaction (the guard is read inside it). On a server with no
//   transactions (a standalone FerretDB) the batch is the crash-atomic record protocol of `kv::wal`, and the backend
//   says so through `atomicity`.
// - Writes go to the server as the `update` and `delete` commands, which carry many operations, so a batch of any size
//   is a few round trips (a command is split only to stay under the server's command size).
// - Which of the two is used is read from the server (`hello` names a replica set or not), never configured.
//
// Key Concepts:
// - `Mongo::connect(uri, store_name)`: one database per store name, one collection `kv`.
//
// Security Considerations:
// - Credentials, if any, are part of the caller's URI and are never returned by `place`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{
    names::{hex, unhex},
    wal::{self, Plain},
    Atomicity, Backend, Limits, Outcome, Write,
};
use local_engine::storage::{Error, Result};
use mongodb::{
    bson::{doc, spec::BinarySubtype, Binary, Bson, Document},
    error::{ErrorKind, WriteFailure},
    sync::{Client, ClientSession, Collection, Database},
};
use std::cell::Cell;

pub struct Mongo {
    client: Client,
    database: Database,
    kv: Collection<Document>,
    transactions: bool,
    rounds: Cell<u64>,
    place: String,
}

#[track_caller]
fn failure(error: mongodb::error::Error) -> Error {
    if error.contains_label("TransientTransactionError") || error.contains_label("UnknownTransactionCommitResult") {
        return local_engine::cause!(caller: Error::Busy);
    }
    match *error.kind {
        ErrorKind::Write(WriteFailure::WriteError(ref write)) if write.code == 11000 => local_engine::cause!(caller: Error::Conflict),
        ErrorKind::Command(ref command) if command.code == 112 => local_engine::cause!(caller: Error::Busy),
        _ => local_engine::cause!(caller: Error::Unavailable),
    }
}

/// The most operations one `update` or `delete` command carries on a replica set, and the most bytes of values.
const COMMAND_OPERATIONS: usize = 1000;
const COMMAND_BYTES: usize = 8 * 1024 * 1024;
/// The most operations one command carries on a server with no transactions. FerretDB holds a database connection for
/// every operation of an `update` command until the command ends, and has 100 of them: a command of more operations
/// waits for a connection it holds itself and never answers.
const STANDALONE_OPERATIONS: usize = 50;

/// The sizes of a list of entries cut into commands: runs that stay under both limits (an entry too large alone is a
/// run of its own).
fn runs(weights: impl Iterator<Item = usize>, operations: usize) -> Vec<std::ops::Range<usize>> {
    let mut runs = Vec::new();
    let (mut from, mut bytes, mut at) = (0, 0, 0);
    for weight in weights {
        if at > from && (at - from >= operations || bytes + weight > COMMAND_BYTES) {
            runs.push(from..at);
            (from, bytes) = (at, 0);
        }
        bytes += weight;
        at += 1;
    }
    if at > from {
        runs.push(from..at);
    }
    runs
}

fn payload(value: &[u8]) -> Bson {
    Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: value.to_vec() })
}

fn value_of(document: &Document) -> Result<Vec<u8>> {
    match document.get("v") {
        Some(Bson::Binary(binary)) => Ok(binary.bytes.clone()),
        _ => Err(local_engine::cause!(Error::Unavailable)),
    }
}

impl Mongo {
    /// Connect to `uri` (`mongodb://host:port`) and keep the store name's keys in a database of its own.
    pub fn connect(uri: &str, store_name: &str) -> Result<Self> {
        let client = Client::with_uri_str(uri).map_err(|error| failure(error))?;
        let database = client.database(store_name);
        let hello = database.run_command(doc! {"hello": 1}).run().map_err(|error| failure(error))?;
        let transactions = hello.contains_key("setName");
        let mongo = Self {
            kv: database.collection::<Document>("kv"),
            database,
            client,
            transactions,
            rounds: Cell::new(2),
            place: format!("{} store_name={store_name}", uri.rsplit('@').next().unwrap_or(uri)),
        };
        if !transactions {
            wal::recover(&mongo)?;
        }
        Ok(mongo)
    }

    fn round(&self) {
        self.rounds.set(self.rounds.get() + 1);
    }

    /// Run one write command (`update` or `delete`), in `session` when given; a per-operation error is a failure.
    fn command(&self, command: Document, session: Option<&mut ClientSession>) -> Result<()> {
        self.round();
        let run = self.database.run_command(command);
        let reply = match session {
            Some(session) => run.session(session).run(),
            None => run.run(),
        }
        .map_err(|error| failure(error))?;
        match reply.get_array("writeErrors") {
            Ok(errors) if !errors.is_empty() => Err(local_engine::cause!(Error::Unavailable)),
            _ => Ok(()),
        }
    }

    /// The puts, then the deletes, as `update` and `delete` commands: one round trip per command.
    fn write_commands(&self, sets: &[(&[u8], &[u8])], deletes: &[&[u8]], mut session: Option<&mut ClientSession>) -> Result<()> {
        let operations = if self.transactions { COMMAND_OPERATIONS } else { STANDALONE_OPERATIONS };
        for run in runs(sets.iter().map(|(key, value)| key.len() + value.len()), operations) {
            let updates: Vec<Document> = sets[run]
                .iter()
                .map(|(key, value)| {
                    let id = hex(key);
                    doc! {"q": {"_id": &id}, "u": {"_id": &id, "v": payload(value)}, "upsert": true}
                })
                .collect();
            self.command(doc! {"update": "kv", "updates": updates, "ordered": true}, session.as_deref_mut())?;
        }
        for run in runs(deletes.iter().map(|key| key.len()), operations) {
            let removals: Vec<Document> = deletes[run].iter().map(|key| doc! {"q": {"_id": hex(key)}, "limit": 1}).collect();
            self.command(doc! {"delete": "kv", "deletes": removals, "ordered": true}, session.as_deref_mut())?;
        }
        Ok(())
    }
}

impl Plain for Mongo {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.round();
        self.kv.find_one(doc! {"_id": hex(key)}).run().map_err(|error| failure(error))?.map(|found| value_of(&found)).transpose()
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<()> {
        self.round();
        let id = hex(key);
        self.kv.replace_one(doc! {"_id": &id}, doc! {"_id": &id, "v": payload(value)}).upsert(true).run().map_err(|error| failure(error))?;
        Ok(())
    }

    fn put_new(&self, key: &[u8], value: &[u8]) -> Result<bool> {
        self.round();
        match self.kv.insert_one(doc! {"_id": hex(key), "v": payload(value)}).run() {
            Ok(_) => Ok(true),
            Err(error) => match failure(error) {
                Error::Conflict(_) => Ok(false),
                other => Err(other),
            },
        }
    }

    fn delete(&self, key: &[u8]) -> Result<()> {
        self.round();
        self.kv.delete_one(doc! {"_id": hex(key)}).run().map_err(|error| failure(error))?;
        Ok(())
    }

    fn put_many(&self, entries: &[(&[u8], &[u8])]) -> Result<()> {
        self.write_commands(entries, &[], None)
    }

    fn delete_many(&self, keys: &[&[u8]]) -> Result<()> {
        self.write_commands(&[], keys, None)
    }
}

impl Backend for Mongo {
    fn atomicity(&self) -> Atomicity {
        if self.transactions {
            Atomicity::Full
        } else {
            Atomicity::CrashSafe
        }
    }

    fn limits(&self) -> Limits {
        // A document is at most 16 MiB; the id is the hex of the key.
        Limits { max_key: 512, max_value: 15 * 1024 * 1024, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Plain::get(self, key)
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        self.round();
        let ids: Vec<String> = keys.iter().map(|key| hex(key)).collect();
        let mut found = std::collections::HashMap::new();
        for document in self.kv.find(doc! {"_id": {"$in": &ids}}).batch_size(10_000).run().map_err(|error| failure(error))? {
            let document = document.map_err(|error| failure(error))?;
            if let Ok(id) = document.get_str("_id") {
                found.insert(id.to_owned(), value_of(&document)?);
            }
        }
        Ok(ids.iter().map(|id| found.get(id).cloned()).collect())
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        self.round();
        let mut bounds = doc! {"$gte": hex(lo)};
        if let Some(hi) = hi {
            bounds.insert("$lt", hex(hi));
        }
        let projection = if values { doc! {"v": 1} } else { doc! {"_id": 1} };
        let cursor = self
            .kv
            .find(doc! {"_id": bounds})
            .sort(doc! {"_id": if reverse { -1 } else { 1 }})
            // A negative limit asks for one batch and no cursor left open on the server: FerretDB keeps a database
            // connection for every open cursor and runs out of them.
            .limit(-(limit.clamp(1, 10_000) as i64))
            .batch_size(limit.clamp(1, 10_000) as u32)
            .projection(projection)
            .run()
            .map_err(|error| failure(error))?;
        let mut entries = Vec::new();
        for document in cursor {
            let document = document.map_err(|error| failure(error))?;
            let key = unhex(document.get_str("_id").map_err(|_| local_engine::cause!(Error::Unavailable))?).ok_or(local_engine::cause!(Error::Unavailable))?;
            entries.push((key, if values { value_of(&document)? } else { Vec::new() }));
        }
        Ok(entries)
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        if !self.transactions {
            return wal::apply(self, 4 * 1024 * 1024, guard, writes);
        }
        let mut session = self.client.start_session().run().map_err(|error| failure(error))?;
        session.start_transaction().run().map_err(|error| failure(error))?;
        let outcome = (|| -> Result<Outcome> {
            self.round();
            let current = self.kv.find_one(doc! {"_id": hex(guard.0)}).session(&mut session).run().map_err(|error| failure(error))?;
            let current = current.map(|found| value_of(&found)).transpose()?;
            if current.as_deref() != guard.1 {
                return Ok(Outcome::Refused);
            }
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
            self.write_commands(&sets, &deletes, Some(&mut session))?;
            Ok(Outcome::Applied)
        })();
        match outcome {
            Ok(Outcome::Applied) => {
                self.round();
                session.commit_transaction().run().map_err(|error| failure(error))?;
                Ok(Outcome::Applied)
            }
            Ok(Outcome::Refused) => {
                self.round();
                session.abort_transaction().run().map_err(|error| failure(error))?;
                Ok(Outcome::Refused)
            }
            Err(error) => {
                let _ = session.abort_transaction().run();
                Err(error)
            }
        }
    }

    fn reclaim(&self) -> Result<()> {
        // `compact` rewrites the collection's files so deleted documents' bytes leave them.
        self.round();
        self.database.run_command(doc! {"compact": "kv"}).run().map(|_| ()).map_err(|error| failure(error))
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
