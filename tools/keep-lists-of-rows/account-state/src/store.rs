// src/store.rs
//
// Purpose: Implement the SQLite supply for scoped versioned records, durable retry receipts and bounded history pages.
//
// Non-Negotiable Invariants:
// - Commit record, history and stable retry state atomically.
// - Preserve account/resource boundaries and fresh admitted checks at the SQLite transaction boundary.
// - Use the maintained live-row index and serialized page limits without truncating record values.
//
// Key Concepts:
// - SQLite immediate transactions, version conflicts and recovery of original receipts.
// - Live-row traversal, explicit continuation and adapter-specific measured work.
//
// Security Considerations:
// - Refuse changed input under an existing request key and stale admission before disclosure or commitment.
// - This concrete adapter supplies records; it must not become the policy or account authority owner.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! SQLite supply for scoped versioned records, history and bounded page traversal.
//! Domain contracts live in `records`; transaction checks stay beside commitment.
use crate::{
    resource_authority::{AdmittedCall, Refusal},
    scan::{self, ReadWork},
};
use content_crypto::advanced::blake3;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, io, path::Path, time::Duration};

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error, crate::refusal_cause::Cause),
    Json(serde_json::Error, crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Invalid(&'static str, crate::refusal_cause::Cause),
    Refused(Refusal, crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Sql(_, cause) => cause,
            Self::Json(_, cause) => cause,
            Self::Conflict(cause) => cause,
            Self::Invalid(_, cause) => cause,
            Self::Refused(_, cause) => cause,
        }
    }
}

impl From<rusqlite::Error> for Error {
    #[track_caller]
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e, crate::cause!(caller_site: Self::Sql))
    }
}
impl From<serde_json::Error> for Error {
    #[track_caller]
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e, crate::cause!(caller_site: Self::Json))
    }
}
impl From<Refusal> for Error {
    fn from(e: Refusal) -> Self {
        { let cause = e.cause(); Self::Refused(e, cause) }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(e, _) => write!(f, "{e}"),
            Self::Json(e, _) => write!(f, "{e}"),
            Self::Conflict(_) => write!(f, "record version or request identity conflicts"),
            Self::Invalid(e, _) => write!(f, "{e}"),
            Self::Refused(e, _) => write!(f, "remote operation refused: {e:?}"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
crate::impl_caused!(Error);
pub use crate::records::{
    Change, CommitContext, Mutation, Record, MAX_PAGE_BYTES, MAX_PAGE_ITEMS, MAX_RECORD_BYTES,
};
pub type Read = crate::records::Read<ReadWork>;
pub type Page<T, C> = crate::records::Page<T, C, ReadWork>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmittedMutation {
    id: String,
    expected_version: i64,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    value: Value,
}

pub struct Store {
    db: Connection,
}

impl Store {
    /// Read a journal that already exists. The storage owner opens the actual
    /// read-only connection; this does not initialize tables or claim work.
    pub fn read_existing(path: impl AsRef<Path>) -> Result<Self, Error> {
        let db = crate::storage::sqlite::read_existing_connection(path.as_ref())
            .map_err(|_| Error::Invalid("the existing journal could not be read", crate::cause!()))?;
        Ok(Self { db })
    }

    pub fn read_existing_current(&self) -> Result<(), Error> {
        crate::storage::sqlite::read_existing_current(&self.db)
            .map_err(|_| Error::Invalid("the existing journal moved", crate::cause!()))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS records(account TEXT NOT NULL,resource TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),body BLOB,PRIMARY KEY(account,resource,id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,resource TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,deleted INTEGER NOT NULL,body BLOB,request_key TEXT NOT NULL,input_identity TEXT NOT NULL,UNIQUE(account,resource,request_key));
        CREATE INDEX IF NOT EXISTS changes_scope ON changes(account,resource,sequence);
        CREATE INDEX IF NOT EXISTS records_live ON records(account,resource,id) WHERE deleted=0;")?;
        Ok(Self { db })
    }
    pub fn get(&self, account: &str, resource: &str, id: &str) -> Result<Read, Error> {
        validate(account, resource, id)?;
        let (row, work) = scan::point_read(&self.db, account, resource, id)?;
        let record = row
            .map(|(version, body)| -> Result<Record, Error> {
                Ok(Record {
                    id: id.into(),
                    version,
                    value: serde_json::from_slice(&body)?,
                })
            })
            .transpose()?;
        Ok(Read { record, work })
    }
    /// A tombstone still owns this scoped identity, although `get` hides its value. The declared storage
    /// reader makes a bounded key lookup without creating or changing the existing receipt store.
    pub(crate) fn has_record(&self, account: &str, resource: &str, id: &str) -> Result<bool, Error> {
        use crate::storage::{Storage, Read as Field};
        validate(account, resource, id)?;
        let read = || -> crate::storage::Result<bool> {
            let storage = crate::storage::sqlite::lend(&self.db, "scoped_records", crate::storage::sqlite::Access::Read)?;
            Ok(storage.get("records", &[account.into(), resource.into(), id.into()], &[Field::whole("version")])?.is_some())
        };
        read().map_err(|_| Error::Invalid("the existing record identity could not be read", crate::cause!()))
    }
    pub fn mutate(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
    ) -> Result<Change, Error> {
        self.mutate_with_check(account, resource, input, || Ok(()))
    }

    /// Remote writes use the immutable admitted input and client-owned retry
    /// key. The check runs inside the same transaction as bytes and receipt.
    pub fn mutate_admitted(
        &mut self,
        call: &AdmittedCall,
        context: &dyn CommitContext,
    ) -> Result<Change, Error> {
        if call.scope().operation != "record.mutate" {
            return Err(Error::Invalid(
                "the admitted operation is not record.mutate",
             crate::cause!()));
        }
        let input: AdmittedMutation = serde_json::from_value(call.input().clone())?;
        let mutation = Mutation {
            id: input.id,
            expected_version: input.expected_version,
            request_key: call.owned_request_key().into(),
            deleted: input.deleted,
            value: input.value,
        };
        let scope = call.scope();
        self.mutate_with_check(&scope.account_id, &scope.resource_address, mutation, || {
            let route = context
                .current_route(scope)
                .ok_or_else(|| { let refused = crate::cause!(Refusal::RouteChanged); let cause = refused.cause(); Error::Refused(refused, cause) })?;
            call.assert_current(&route, context.now_ms())?;
            Ok(())
        })
    }

    pub fn mutate_once(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
    ) -> Result<(Change, bool), Error> {
        self.mutate_once_with_check(account, resource, input, || Ok(()))
    }

    fn mutate_with_check(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
        check: impl FnMut() -> Result<(), Error>,
    ) -> Result<Change, Error> {
        self.mutate_once_with_check(account, resource, input, check)
            .map(|(change, _)| change)
    }

    fn mutate_once_with_check(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<(Change, bool), Error> {
        validate(account, resource, &input.id)?;
        if input.expected_version < 0
            || input.expected_version == i64::MAX
            || input.request_key.is_empty()
            || input.request_key.len() > 1024
        {
            return Err(Error::Invalid(
                "a bounded stable request key and valid expected version are required",
             crate::cause!()));
        }
        let encoded = serde_json::to_vec(&input.value)?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(Error::Invalid("record exceeds one MiB", crate::cause!()));
        }
        let identity = blake3::hash(&serde_json::to_vec(&(
            account,
            resource,
            &input.id,
            input.expected_version,
            input.deleted,
            &input.value,
        ))?)
        .to_hex()
        .to_string();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check()?;
        let prior=tx.query_row("SELECT sequence,id,version,deleted,body,input_identity FROM changes WHERE account=? AND resource=? AND request_key=?",params![account,resource,input.request_key],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,bool>(3)?,r.get::<_,Option<Vec<u8>>>(4)?,r.get::<_,String>(5)?))).optional()?;
        if let Some((sequence, id, version, deleted, body, old_identity)) = prior {
            if old_identity != identity {
                return Err(crate::cause!(Error::Conflict));
            }
            check()?;
            return Ok((
                Change {
                    sequence,
                    id,
                    version,
                    deleted,
                    value: body.map(|b| serde_json::from_slice(&b)).transpose()?,
                },
                false,
            ));
        }
        let deleted = input.deleted;
        if deleted && !input.value.is_null() {
            return Err(Error::Invalid("a delete must not include a new value", crate::cause!()));
        }
        let body = if deleted {
            None
        } else {
            Some(serde_json::to_vec(&input.value)?)
        };
        let version = input.expected_version + 1;
        let modified = if input.expected_version == 0 {
            if deleted {
                return Err(crate::cause!(Error::Conflict));
            }
            tx.execute(
                "INSERT INTO records VALUES(?,?,?,?,0,?) ON CONFLICT DO NOTHING",
                params![account, resource, input.id, version, body],
            )?
        } else {
            tx.execute("UPDATE records SET version=?,deleted=?,body=? WHERE account=? AND resource=? AND id=? AND version=?",params![version,deleted,body,account,resource,input.id,input.expected_version])?
        };
        if modified != 1 {
            return Err(crate::cause!(Error::Conflict));
        }
        tx.execute("INSERT INTO changes(account,resource,id,version,deleted,body,request_key,input_identity) VALUES(?,?,?,?,?,?,?,?)",params![account,resource,input.id,version,deleted,body,input.request_key,identity])?;
        let sequence = tx.last_insert_rowid();
        check()?;
        tx.commit()?;
        Ok((
            Change {
                sequence,
                id: input.id,
                version,
                deleted,
                value: if deleted { None } else { Some(input.value) },
            },
            true,
        ))
    }
    /// Compatibility consumer: resume after the last returned ID even when a
    /// byte-limited page contains fewer items than requested. Prefer list_page
    /// when the consumer needs an explicit continuation and measured work.
    pub fn list(
        &self,
        account: &str,
        resource: &str,
        after: &str,
        limit: usize,
    ) -> Result<Vec<Record>, Error> {
        Ok(self.list_page(account, resource, after, limit)?.items)
    }

    pub fn list_page(
        &self,
        account: &str,
        resource: &str,
        after: &str,
        limit: usize,
    ) -> Result<Page<Record, String>, Error> {
        validate(account, resource, "page")?;
        if after.len() > 4096 || after.contains('\0') || !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid record cursor or page size", crate::cause!()));
        }
        // The maintained partial index contains only live IDs. Tombstones and
        // historical changes remain intact, but are never visited by this walk.
        let mut query = scan::PageQuery::new(&self.db,
            c"SELECT id,version,body FROM records INDEXED BY records_live WHERE account=?1 AND resource=?2 AND id>?3 AND deleted=0 ORDER BY id LIMIT ?4",
            [account, resource, after], (limit + 1) as i64)?;
        let mut items = Vec::new();
        let mut bytes = 2;
        let mut more = false;
        while let Some(row) = query.next()? {
            if items.len() == limit {
                more = true;
                break;
            }
            let body = bounded_body(row.bytes(2))?;
            // Refuse before parsing/retaining another body when its source bytes
            // alone exceed the remaining page. Store-owned JSON is canonical.
            if !items.is_empty() && body.len() > MAX_PAGE_BYTES - bytes {
                more = true;
                break;
            }
            let item = Record {
                id: bounded_id(row.bytes(0))?,
                version: row.integer(1),
                value: serde_json::from_slice(body)?,
            };
            if !append_bounded(&mut items, &mut bytes, item)? {
                more = true;
                break;
            }
        }
        let next = if more {
            items.last().map(|r| r.id.clone())
        } else {
            None
        };
        Ok(Page {
            items,
            next,
            serialized_item_bytes: bytes,
            work: query.work(),
        })
    }

    pub fn changes(
        &self,
        account: &str,
        resource: &str,
        after: i64,
        limit: usize,
    ) -> Result<Vec<Change>, Error> {
        Ok(self.changes_page(account, resource, after, limit)?.items)
    }

    pub fn changes_page(
        &self,
        account: &str,
        resource: &str,
        after: i64,
        limit: usize,
    ) -> Result<Page<Change, i64>, Error> {
        validate(account, resource, "changes")?;
        if after < 0 || !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid change cursor or limit", crate::cause!()));
        }
        let cursor = after.to_string();
        let mut query = scan::PageQuery::new(&self.db,
            c"SELECT sequence,id,version,deleted,body FROM changes INDEXED BY changes_scope WHERE account=?1 AND resource=?2 AND sequence>CAST(?3 AS INTEGER) ORDER BY sequence LIMIT ?4",
            [account, resource, &cursor], (limit + 1) as i64)?;
        let mut items = Vec::new();
        let mut bytes = 2;
        let mut more = false;
        while let Some(row) = query.next()? {
            if items.len() == limit {
                more = true;
                break;
            }
            let body = row
                .bytes(4)
                .map(|body| bounded_body(Some(body)))
                .transpose()?;
            if !items.is_empty() && body.is_some_and(|body| body.len() > MAX_PAGE_BYTES - bytes) {
                more = true;
                break;
            }
            let item = Change {
                sequence: row.integer(0),
                id: bounded_id(row.bytes(1))?,
                version: row.integer(2),
                deleted: row.integer(3) != 0,
                value: body.map(serde_json::from_slice).transpose()?,
            };
            if !append_bounded(&mut items, &mut bytes, item)? {
                more = true;
                break;
            }
        }
        let next = if more {
            items.last().map(|r| r.sequence)
        } else {
            None
        };
        Ok(Page {
            items,
            next,
            serialized_item_bytes: bytes,
            work: query.work(),
        })
    }
}
fn validate(account: &str, resource: &str, id: &str) -> Result<(), Error> {
    if [account, resource, id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
    {
        return Err(Error::Invalid(
            "record scope and ID must be nonempty, NUL-free and bounded",
         crate::cause!()));
    }
    Ok(())
}

fn bounded_body(body: Option<&[u8]>) -> Result<&[u8], Error> {
    match body {
        Some(body) if !body.is_empty() && body.len() <= MAX_RECORD_BYTES => Ok(body),
        _ => Err(Error::Invalid(
            "stored record exceeds one MiB or has no body",
         crate::cause!())),
    }
}
fn bounded_id(id: Option<&[u8]>) -> Result<String, Error> {
    let id = id.ok_or(Error::Invalid("stored record ID is missing", crate::cause!()))?;
    if id.is_empty() || id.len() > 4096 || id.contains(&0) {
        return Err(Error::Invalid("stored record ID is invalid", crate::cause!()));
    }
    Ok(std::str::from_utf8(id)
        .map_err(|_| Error::Invalid("stored record ID is not UTF-8", crate::cause!()))?
        .into())
}

/// Counts serialization without allocating another copy of any record body.
struct SerializedBytes(usize);
impl io::Write for SerializedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = crate::io_operation!((self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("serialized page length overflow"))).map_err(std::io::Error::from))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn append_bounded<T: Serialize>(
    items: &mut Vec<T>,
    total: &mut usize,
    item: T,
) -> Result<bool, Error> {
    let mut count = SerializedBytes(0);
    serde_json::to_writer(&mut count, &item)?;
    let added = count
        .0
        .checked_add(usize::from(!items.is_empty()))
        .ok_or(Error::Invalid("serialized item exceeds page bound", crate::cause!()))?;
    if added > MAX_PAGE_BYTES - *total {
        if items.is_empty() {
            return Err(Error::Invalid(
                "one complete item exceeds the page byte bound",
             crate::cause!()));
        }
        return Ok(false);
    }
    *total += added;
    items.push(item);
    Ok(true)
}

// The concrete adapter owns translation of provider failures. Core admission
// sees only the record contract; SQLite never leaks into its dependency graph.
impl crate::records::Records for Store {
    fn get(
        &self,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<crate::records::Read, crate::records::Error> {
        let read = Store::get(self, account, resource, id).map_err(contract_error)?;
        let work =
            serde_json::to_value(&read.work).map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(read.map_work(|_| work))
    }
    fn mutate(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
    ) -> Result<Change, crate::records::Error> {
        Store::mutate(self, account, resource, input).map_err(contract_error)
    }
    fn list_page(
        &self,
        account: &str,
        resource: &str,
        after: &str,
        limit: usize,
    ) -> Result<crate::records::Page<Record, String>, crate::records::Error> {
        let page =
            Store::list_page(self, account, resource, after, limit).map_err(contract_error)?;
        let work =
            serde_json::to_value(&page.work).map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(page.map_work(|_| work))
    }
    fn changes_page(
        &self,
        account: &str,
        resource: &str,
        after: i64,
        limit: usize,
    ) -> Result<crate::records::Page<Change, i64>, crate::records::Error> {
        let page =
            Store::changes_page(self, account, resource, after, limit).map_err(contract_error)?;
        let work =
            serde_json::to_value(&page.work).map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(page.map_work(|_| work))
    }
    fn mutate_admitted(
        &mut self,
        call: &AdmittedCall,
        context: &dyn CommitContext,
    ) -> Result<Change, crate::records::Error> {
        Store::mutate_admitted(self, call, context).map_err(contract_error)
    }
}
fn contract_error(error: Error) -> crate::records::Error {
    let cause = error.cause();
    match error {
        Error::Conflict(_) => crate::records::Error::Conflict(cause),
        Error::Invalid(reason, _) => crate::records::Error::Invalid(reason, cause),
        Error::Refused(reason, _) => crate::records::Error::Refused(reason, cause),
        Error::Json(_, _) => crate::records::Error::Invalid("invalid record request", cause),
        Error::Sql(_, _) => crate::records::Error::OutcomeUnknown(cause),
    }
}

#[cfg(test)]
mod bounded_work_regression {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn existing_read_never_creates_a_missing_journal() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("journal.sqlite");
        assert!(Store::read_existing(&path).is_err());
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn existing_read_resolves_parent_aliases_but_refuses_a_final_symlink() {
        let folder = tempfile::tempdir().unwrap();
        let real = folder.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let path = real.join("journal.sqlite");
        drop(Store::open(&path).unwrap());
        let alias = folder.path().join("parent-alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert!(Store::read_existing(alias.join("journal.sqlite")).is_ok());
        let link = real.join("final-link.sqlite");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(Store::read_existing(&link).is_err());
    }

    #[test]
    fn existing_read_refuses_a_moved_current_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("journal.sqlite");
        drop(Store::open(&path).unwrap());
        let reader = Store::read_existing(&path).unwrap();
        reader.read_existing_current().unwrap();
        std::fs::rename(&path, folder.path().join("retired.sqlite")).unwrap();
        assert!(reader.read_existing_current().is_err());
    }

    #[test]
    fn existing_read_is_readonly_and_observes_the_actual_live_wal() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("journal.sqlite");
        let mut writer = Store::open(&path).unwrap();
        writer
            .mutate(
                "a",
                "r",
                Mutation {
                    id: "kept".into(),
                    expected_version: 0,
                    request_key: "first".into(),
                    deleted: false,
                    value: serde_json::json!({"answer": "first"}),
                },
            )
            .unwrap();
        let mut reader = Store::read_existing(&path).unwrap();
        assert!(reader.db.is_readonly(rusqlite::DatabaseName::Main).unwrap());
        assert_eq!(
            reader.get("a", "r", "kept").unwrap().record.unwrap().value["answer"],
            "first"
        );
        assert!(reader
            .mutate(
                "a",
                "r",
                Mutation {
                    id: "forbidden".into(),
                    expected_version: 0,
                    request_key: "no-write".into(),
                    deleted: false,
                    value: Value::Null,
                }
            )
            .is_err());
        writer
            .mutate(
                "a",
                "r",
                Mutation {
                    id: "kept".into(),
                    expected_version: 1,
                    request_key: "second".into(),
                    deleted: false,
                    value: serde_json::json!({"answer": "second"}),
                },
            )
            .unwrap();
        assert_eq!(
            reader.get("a", "r", "kept").unwrap().record.unwrap().value["answer"],
            "second"
        );
        assert!(reader.get("a", "r", "forbidden").unwrap().record.is_none());
    }

    // This exact control also compiles against the pre-repair Store. It calls
    // the original public list API rather than the new Page API or copied SQL.
    #[test]
    fn actual_list_vm_work_does_not_grow_with_deleted_prefix_or_all_deleted() {
        let mut observations = Vec::new();
        for count in [10, 10_000] {
            let mut store = Store::open(":memory:").unwrap();
            for n in 0..count {
                let id = format!("a-{n:06}");
                store
                    .mutate(
                        "a",
                        "r",
                        Mutation {
                            id: id.clone(),
                            expected_version: 0,
                            request_key: format!("create-{n}"),
                            deleted: false,
                            value: Value::Null,
                        },
                    )
                    .unwrap();
                store
                    .mutate(
                        "a",
                        "r",
                        Mutation {
                            id,
                            expected_version: 1,
                            request_key: format!("delete-{n}"),
                            deleted: true,
                            value: Value::Null,
                        },
                    )
                    .unwrap();
            }
            let steps = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&steps);
            store.db.progress_handler(
                1,
                Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            );
            assert!(store.list("a", "r", "", 1).unwrap().is_empty());
            store.db.progress_handler(0, None::<fn() -> bool>);
            let empty = steps.load(Ordering::Relaxed);
            store
                .mutate(
                    "a",
                    "r",
                    Mutation {
                        id: "z-live".into(),
                        expected_version: 0,
                        request_key: "create-live".into(),
                        deleted: false,
                        value: Value::Null,
                    },
                )
                .unwrap();
            steps.store(0, Ordering::Relaxed);
            let observed = Arc::clone(&steps);
            store.db.progress_handler(
                1,
                Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            );
            let page = store.list("a", "r", "", 1).unwrap();
            store.db.progress_handler(0, None::<fn() -> bool>);
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].id, "z-live");
            let live = steps.load(Ordering::Relaxed);
            crate::quiet_println!("actual Store::list tombstones={count} empty_vm_callbacks={empty} live_vm_callbacks={live}");
            observations.push((empty, live));
        }
        let (small, large) = (observations[0], observations[1]);
        assert!(
            large.0 <= small.0 + 10 && large.0 < 80,
            "all-deleted VM work grew: {observations:?}"
        );
        assert!(
            large.1 <= small.1 + 10 && large.1 < 80,
            "live-page VM work grew: {observations:?}"
        );
    }
}
