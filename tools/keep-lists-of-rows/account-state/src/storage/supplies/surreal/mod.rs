// src/storage/supplies/surreal/mod.rs
//
// Purpose: The SurrealDB `Backend` for the shared key-value supply, spoken over SurrealDB's HTTP `/sql` endpoint with
// SurrealQL. A key is a record in table `kv` whose id is the lowercase hex of the key's bytes, so the database's record
// id order is byte order and a forward range of the contract is a record-id range that stops at its limit. A reverse
// range is not: `ORDER BY id DESC` over a record-id range reads the whole range and sorts it. So each key also has a
// record in table `kvr` named by its reversed hex (`kv::names`) that links to it, and a reverse range is a forward range
// of `kvr`; both records are written and deleted in the same transaction.
//
// Non-Negotiable Invariants:
// - A batch is one `BEGIN ... COMMIT` request: the guard is read inside the transaction and a mismatch `THROW`s, which
//   cancels the whole transaction. All writes land together or none do, for every reader (`Atomicity::Full`).
// - Statement text is built only from hex and base64 characters, so no key or value can end a literal.
//
// Key Concepts:
// - `Surreal::connect(url, store_name)`: `http://user:password@host:port`; one database per store name in store name `supply`.
//
// Security Considerations:
// - Basic credentials come from the caller's URL; `place` omits them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{
    names::{hex, reversed, unhex},
    Ask, Atomicity, Backend, Entries, Fetched, Limits, Outcome, Write,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use local_engine::storage::{Error, Result};
use serde_json::Value;
use std::{cell::Cell, fmt::Write as _};

pub struct Surreal {
    agent: ureq::Agent,
    url: String,
    authorization: String,
    database: String,
    rounds: Cell<u64>,
    place: String,
}

impl Surreal {
    /// Connect with `http://user:password@host:port` and keep the store name's keys in a database of its own.
    pub fn connect(url: &str, store_name: &str) -> Result<Self> {
        let rest = url.strip_prefix("http://").ok_or(local_engine::cause!(Error::Invalid))?;
        let (credentials, host) = rest.split_once('@').ok_or(local_engine::cause!(Error::Invalid))?;
        let surreal = Self {
            agent: ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(120)).build(),
            url: format!("http://{host}/sql"),
            authorization: format!("Basic {}", BASE64.encode(credentials)),
            database: store_name.to_owned(),
            rounds: Cell::new(0),
            place: format!("http://{host} database={store_name}"),
        };
        // Defining a store name or database while another connection defines one conflicts; the definitions are idempotent.
        let mut attempt = 0;
        loop {
            let defined = surreal.query(&format!("DEFINE NAMESPACE IF NOT EXISTS supply; USE NS supply; DEFINE DATABASE IF NOT EXISTS {store_name};"))?;
            // SurrealDB refuses a read of a table that was never defined, so the tables are defined once the database exists.
            let tables = surreal.query("DEFINE TABLE IF NOT EXISTS kv SCHEMALESS; DEFINE TABLE IF NOT EXISTS kvr SCHEMALESS;")?;
            if defined.iter().chain(&tables).all(|result| result["status"] == "OK") {
                break;
            }
            attempt += 1;
            if attempt >= 8 {
                return Err(local_engine::cause!(Error::Unavailable));
            }
            std::thread::sleep(std::time::Duration::from_millis(100 * attempt));
        }
        Ok(surreal)
    }

    /// Run SurrealQL; the answer is one result per statement.
    fn query(&self, text: &str) -> Result<Vec<Value>> {
        self.rounds.set(self.rounds.get() + 1);
        let response = self
            .agent
            .post(&self.url)
            .set("Authorization", &self.authorization)
            .set("Accept", "application/json")
            .set("surreal-ns", "supply")
            .set("surreal-db", &self.database)
            .send_string(text);
        let reply: Value = match response {
            Ok(response) => response.into_json().map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?,
            Err(_) => return Err(local_engine::cause!(Error::Unavailable)),
        };
        reply.as_array().cloned().ok_or(local_engine::cause!(Error::Unavailable))
    }

    /// The rows of the result at `index`, failing if that statement did not succeed.
    fn rows(results: &[Value], index: usize) -> Result<Vec<Value>> {
        let result = results.get(index).ok_or(local_engine::cause!(Error::Unavailable))?;
        if result["status"] != "OK" {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        Ok(result["result"].as_array().cloned().unwrap_or_default())
    }
}

impl Backend for Surreal {
    fn atomicity(&self) -> Atomicity {
        Atomicity::Full
    }

    fn limits(&self) -> Limits {
        Limits { max_key: 512, max_value: 6 * 1024 * 1024, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let results = self.query(&format!("SELECT VALUE v FROM ONLY kv:⟨{}⟩;", hex(key)))?;
        let result = results.first().ok_or(local_engine::cause!(Error::Unavailable))?;
        if result["status"] != "OK" {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        result["result"].as_str().map(|text| BASE64.decode(text).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))).transpose()
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        Ok(self.read_many(keys, &[])?.0)
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Entries> {
        let ask = Ask { lo: lo.to_vec(), hi: hi.map(<[u8]>::to_vec), reverse, limit, values };
        self.read_many(&[], std::slice::from_ref(&ask))?.1.pop().ok_or(local_engine::cause!(Error::Unavailable))
    }

    /// The keys' select and each range's select as the statements of one query, answered in order: one round trip.
    fn read_many(&self, keys: &[Vec<u8>], asks: &[Ask]) -> Result<Fetched> {
        let mut text = String::new();
        if !keys.is_empty() {
            let ids: Vec<String> = keys.iter().map(|key| format!("kv:⟨{}⟩", hex(key))).collect();
            let _ = write!(text, "SELECT k, v FROM [{}];", ids.join(","));
        }
        for ask in asks {
            let limit = ask.limit.min(1_000_000);
            let (lo, hi, values) = (&ask.lo, ask.hi.as_deref(), ask.values);
            if ask.reverse {
                // Keys in `[lo, hi)` are reverse names in `(name(hi), name(lo)]`, read forward.
                let begin = hi.map_or(String::new(), |hi| format!("⟨{}⟩>", reversed(hi)));
                let columns = if values { "t.k AS k, t.v AS v" } else { "t.k AS k" };
                let _ = write!(text, "SELECT {columns} FROM kvr:{begin}..=⟨{}⟩ LIMIT {limit};", reversed(lo));
            } else {
                let end = hi.map_or(String::new(), |hi| format!("⟨{}⟩", hex(hi)));
                let _ = write!(text, "SELECT {} FROM kv:⟨{}⟩..{end} LIMIT {limit};", if values { "k, v" } else { "k" }, hex(lo));
            }
        }
        if text.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let results = self.query(&text)?;
        let found = if keys.is_empty() {
            Vec::new()
        } else {
            let mut found = std::collections::HashMap::new();
            for row in Self::rows(&results, 0)? {
                if let (Some(k), Some(v)) = (row["k"].as_str(), row["v"].as_str()) {
                    found.insert(k.to_owned(), BASE64.decode(v).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?);
                }
            }
            keys.iter().map(|key| found.get(&hex(key)).cloned()).collect()
        };
        let first = usize::from(!keys.is_empty());
        let ranges = asks
            .iter()
            .enumerate()
            .map(|(at, ask)| {
                Self::rows(&results, first + at)?
                    .into_iter()
                    .map(|row| {
                        let key = unhex(row["k"].as_str().ok_or(local_engine::cause!(Error::Unavailable))?).ok_or(local_engine::cause!(Error::Unavailable))?;
                        let value = if ask.values { BASE64.decode(row["v"].as_str().ok_or(local_engine::cause!(Error::Unavailable))?).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))? } else { Vec::new() };
                        Ok((key, value))
                    })
                    .collect()
            })
            .collect::<Result<_>>()?;
        Ok((found, ranges))
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        let expected = guard.1.map_or("NONE".to_owned(), |value| format!("\"{}\"", BASE64.encode(value)));
        let mut text = format!(
            "BEGIN; LET $c = (SELECT VALUE v FROM ONLY kv:⟨{}⟩); IF $c != {expected} {{ THROW \"guard\" }};",
            hex(guard.0)
        );
        for write in writes {
            match write {
                Write::Set(key, value) => {
                    let _ = write!(
                        text,
                        " UPSERT kv:⟨{0}⟩ SET k = \"{0}\", v = \"{1}\"; UPSERT kvr:⟨{2}⟩ SET t = kv:⟨{0}⟩;",
                        hex(key),
                        BASE64.encode(value),
                        reversed(key)
                    );
                }
                Write::Delete(key) => {
                    let _ = write!(text, " DELETE kv:⟨{}⟩; DELETE kvr:⟨{}⟩;", hex(key), reversed(key));
                }
            }
        }
        text.push_str(" COMMIT;");
        let results = self.query(&text)?;
        if results.iter().all(|result| result["status"] == "OK") {
            return Ok(Outcome::Applied);
        }
        let failures: Vec<&str> = results.iter().filter_map(|result| result["result"].as_str()).collect();
        if failures.iter().any(|message| message.contains("guard")) {
            Ok(Outcome::Refused)
        } else if failures.iter().any(|message| message.contains("conflict")) {
            Err(local_engine::cause!(Error::Busy))
        } else {
            Err(local_engine::cause!(Error::Unavailable))
        }
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
