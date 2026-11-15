// src/storage/supplies/lib.rs
//
// Purpose: Supplies of the `Storage` contract (src/storage/mod.rs) for databases other than SQLite and memory, so the
// record store can be shown to depend on the contract and on no database. One shared codec, one shared relational
// supply (`sql`), one shared ordered key-value supply (`kv`), and one folder per wire protocol that provides only the
// driver seam. Each protocol sits behind its own Cargo feature, so the default build pulls in no driver.
//
// Non-Negotiable Invariants:
// - The engine (src/storage/record_store) and the contract (src/storage/mod.rs) are not changed to fit any supply. A supply that
//   cannot honor a part of the contract says so in its README and answers `Unavailable` or `Invalid`; it never fakes it.
// - A supply names no family, field or order of its own: every table, key and index comes from the DATA declarations.
// - This crate is the only place a database driver is named for storage.
//
// Key Concepts:
// - `codec`: the contract's value order as bytes. `layout`: which fields are ordered. `sql`: relational servers over a
//   `Wire`. Folders named for a protocol: `postgres`, `mysql`, ...
//
// Security Considerations:
// - No credentials are stored or logged here; a server address comes from the caller.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod codec;
pub mod kv;
pub mod layout;
pub mod sql;
pub mod provider_units;

#[cfg(feature = "postgres")]
pub mod postgres;
#[cfg(feature = "mysql")]
pub mod mysql;
#[cfg(feature = "redis")]
pub mod redis;
#[cfg(feature = "libsql")]
pub mod libsql;
#[cfg(feature = "dynamodb")]
pub mod dynamodb;
#[cfg(feature = "s3")]
pub mod s3;
#[cfg(feature = "mongo")]
pub mod mongo;
#[cfg(feature = "couchdb")]
pub mod couchdb;
#[cfg(feature = "surreal")]
pub mod surreal;

use local_engine::storage::{Intent, Query, Range, Read, Reply, Result, Row, Schema, Storage, Value, When, Write};

/// The schema every supply here is opened for: the record store's.
pub const SCHEMA: &str = "record_store";

/// Any supply of this crate behind one type, so a test or a tool chooses the server by name at run time.
pub struct Dynamic(pub Box<dyn Supplied>);

/// A supply that counts the network round trips it has made.
pub trait Supplied: Storage + Send {
    fn rounds(&self) -> u64;
    fn measurements(&self) -> Vec<provider_units::Observation> { Vec::new() }
    fn measurement_count(&self) -> usize { self.measurements().len() }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { self.measurements().into_iter().skip(index).collect() }
}
impl<W: sql::Wire + Send> Supplied for sql::Supply<W> {
    fn rounds(&self) -> u64 {
        sql::Supply::rounds(self)
    }
    fn measurements(&self) -> Vec<provider_units::Observation> { sql::Supply::measurements(self) }
    fn measurement_count(&self) -> usize { sql::Supply::measurement_count(self) }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { sql::Supply::measurements_since(self, index) }
}
impl<B: kv::Backend + Send> Supplied for kv::Kv<B> {
    fn rounds(&self) -> u64 {
        kv::Kv::rounds(self)
    }
    fn measurements(&self) -> Vec<provider_units::Observation> { kv::Kv::measurements(self) }
    fn measurement_count(&self) -> usize { kv::Kv::measurement_count(self) }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { kv::Kv::measurements_since(self, index) }
}

impl Dynamic {
    /// Network round trips this supply's connection has made so far.
    pub fn rounds(&self) -> u64 {
        self.0.rounds()
    }

    /// Provider-unit observations captured by the underlying storage adapter.
    pub fn measurements(&self) -> Vec<provider_units::Observation> { self.0.measurements() }
    pub fn measurement_count(&self) -> usize { self.0.measurement_count() }
    pub fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { self.0.measurements_since(index) }
}

impl Storage for Dynamic {
    fn schema(&self) -> &'static Schema {
        self.0.schema()
    }
    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        self.0.get(family, key, read)
    }
    fn read_many(&self, queries: &[Query<'_>]) -> Result<Vec<Reply>> {
        self.0.read_many(queries)
    }
    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        self.0.scan(family, range, read)
    }
    fn write_many(&self, writes: &[Write<'_>]) -> Result<Vec<u64>> {
        self.0.write_many(writes)
    }
    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        self.0.put(family, row, when)
    }
    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        self.0.count(family, range)
    }
    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        self.0.erase(family, range)
    }
    fn present(&self, family: &str) -> Result<bool> {
        self.0.present(family)
    }
    fn custody(&self) -> Result<()> {
        self.0.custody()
    }
    fn location(&self) -> Option<&str> {
        self.0.location()
    }
    fn scoped(&self) -> bool {
        self.0.scoped()
    }
    fn writing(&self) -> Result<bool> {
        self.0.writing()
    }
    fn changes(&self) -> u64 {
        self.0.changes()
    }
    fn mark(&self) -> Result<i64> {
        self.0.mark()
    }
    fn schema_mark(&self) -> Result<i64> {
        self.0.schema_mark()
    }
    fn allocated_bytes(&self) -> Result<u64> {
        self.0.allocated_bytes()
    }
    fn reclaim(&self) -> Result<()> {
        self.0.reclaim()
    }
    fn reclaim_step(&self, pages: u64) -> Result<u64> {
        self.0.reclaim_step(pages)
    }
    fn vacuum_state(&self) -> Result<Option<local_engine::storage::VacuumState>> {
        self.0.vacuum_state()
    }
    fn overwrites_removed(&self) -> Result<bool> {
        self.0.overwrites_removed()
    }
    fn open_scope(&self, intent: Intent) -> Result<()> {
        self.0.open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> Result<()> {
        self.0.close_scope(commit)
    }
}

/// Open the supply named `kind` on the server at `url`, in `store_name` (a schema or database of its own). A kind whose
/// feature is not compiled in is `Unavailable`.
pub fn open(kind: &str, url: &str, store_name: &str) -> Result<Dynamic> {
    open_schema(kind, url, store_name, SCHEMA)
}

/// Open the supply named `kind` for another declared schema than the record store's (the differential suite runs
/// every family shape the contract declares).
pub fn open_schema(kind: &str, url: &str, store_name: &str, schema_name: &str) -> Result<Dynamic> {
    match kind {
        #[cfg(feature = "postgres")]
        "postgres" | "cockroach" => {
            let wire = postgres::Postgres::connect(url, store_name, 3000)?;
            Ok(Dynamic(Box::new(sql::Supply::open(wire, schema_name)?)))
        }
        #[cfg(feature = "mysql")]
        "mysql" | "mariadb" => {
            let wire = mysql::MySql::connect(url, store_name, 3)?;
            Ok(Dynamic(Box::new(sql::Supply::open(wire, schema_name)?)))
        }
        #[cfg(feature = "libsql")]
        "libsql" => {
            // `url` is the query endpoint; the admin endpoint is named after a `|`: `http://host:8080|http://host:9090`.
            let (query, admin) = url.split_once('|').ok_or(local_engine::cause!(local_engine::storage::Error::Invalid))?;
            let wire = libsql::LibSql::connect(query, admin, store_name)?;
            Ok(Dynamic(Box::new(sql::Supply::open(wire, schema_name)?)))
        }
        #[cfg(feature = "redis")]
        "redis" | "valkey" => {
            let backend = redis::Redis::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        #[cfg(feature = "dynamodb")]
        "dynamodb" => {
            let backend = dynamodb::DynamoDb::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        #[cfg(feature = "s3")]
        "s3" | "minio" => {
            let backend = s3::S3::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        #[cfg(feature = "mongo")]
        "mongo" | "ferretdb" => {
            let backend = mongo::Mongo::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        #[cfg(feature = "couchdb")]
        "couchdb" => {
            let backend = couchdb::CouchDb::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        #[cfg(feature = "surreal")]
        "surreal" => {
            let backend = surreal::Surreal::connect(url, store_name)?;
            Ok(Dynamic(Box::new(kv::Kv::open(backend, schema_name)?)))
        }
        _ => {
            let _ = (url, store_name);
            Err(local_engine::cause!(local_engine::storage::Error::Unavailable))
        }
    }
}
