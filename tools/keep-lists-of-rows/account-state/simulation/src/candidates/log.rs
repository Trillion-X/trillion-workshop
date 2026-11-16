//! S2's log module, shared by every candidate that keeps history as log rows
//! (S2, S3, S4, record store): per-owner sealing keys, generation tables
//! `log_g<n>` whose row shape is DATA (a [`LogShape`]), sealing inside the
//! write that fills a generation, and the bounded tail receipt scan.
//!
//! A generation seals inside the write that fills it: its rows are written to
//! an archive file (an R2 PUT on the provider), read back and BLAKE3-verified,
//! then the table is DROPPED (0 row writes). Sealed payload columns are
//! encrypted with the owner's key (ChaCha20-Poly1305), so destroying the key
//! erases every archived copy of that owner's history.

use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};
use content_crypto::advanced::blake3;
use rusqlite::{
    params, params_from_iter,
    types::{ToSql, ValueRef},
    Connection, OptionalExtension, Transaction,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use workload_simulation::{DetRng, Meters, StoreError};

use crate::meter::{err, schema_changed, ARCHIVE_BYTES, ARCHIVE_PUTS};

/// Row shape of one log family. `columns` is the column DDL after
/// `CREATE TABLE log_g<n>(`; `key` is its INTEGER PRIMARY KEY (the archive
/// order); `archived` are the columns written to the sealed archive.
pub struct LogShape {
    pub key: &'static str,
    pub columns: &'static str,
    pub archived: &'static [&'static str],
}

/// S2's change log: one row per change, forward diff, with the request key
/// that caused it (history attribution; retries are answered by the
/// receipt ring of the record's row, `receipts.rs`).
pub const CHANGE_LOG: LogShape = LogShape {
    key: "seq",
    columns: "seq INTEGER PRIMARY KEY, record_id TEXT NOT NULL, tx TEXT NOT NULL,
           actor TEXT NOT NULL, app_time TEXT NOT NULL, sys_time TEXT NOT NULL, key_id INTEGER, diff BLOB NOT NULL",
    archived: &[
        "seq",
        "record_id",
        "tx",
        "actor",
        "app_time",
        "key_id",
        "diff",
    ],
};

/// Write causes of the tables this module owns (`None` = not ours).
pub fn classify(table: &str) -> Option<&'static str> {
    match table {
        "owner_keys" | "generations" => Some("bookkeeping"),
        t if t.starts_with("log_g") => Some("history"),
        _ => None,
    }
}

pub struct Log {
    shape: &'static LogShape,
    archive: PathBuf,
    generation_rows: u64,
    gen: i64,
    gen_rows: u64,
}

impl Log {
    pub fn new(shape: &'static LogShape, archive: PathBuf, generation_rows: u64) -> Self {
        Self {
            shape,
            archive,
            generation_rows,
            gen: 1,
            gen_rows: 0,
        }
    }

    /// The open generation's table name.
    pub fn table(&self) -> String {
        format!("log_g{}", self.gen)
    }

    /// Create the key, generation and first log tables.
    pub fn create(&mut self, conn: &Connection) -> Result<(), StoreError> {
        conn.execute_batch(
            "CREATE TABLE owner_keys(key_id INTEGER PRIMARY KEY, owner TEXT NOT NULL UNIQUE, key BLOB NOT NULL);
             CREATE TABLE generations(gen INTEGER PRIMARY KEY, rows INTEGER NOT NULL, sealed INTEGER NOT NULL,
                       digest TEXT, bytes INTEGER);
             INSERT INTO generations(gen, rows, sealed) VALUES(1, 0, 0);",
        )
        .map_err(err)?;
        self.create_table(conn, 1)?;
        self.gen = 1;
        self.gen_rows = 0;
        Ok(())
    }

    fn create_table(&self, conn: &Connection, gen: i64) -> Result<(), StoreError> {
        conn.execute_batch(&format!("CREATE TABLE log_g{gen}({});", self.shape.columns))
            .map_err(err)
    }

    /// Reload the open generation after a reopen.
    pub fn recover(&mut self, conn: &Connection) -> Result<(), StoreError> {
        let (gen, rows): (i64, i64) = conn
            .query_row(
                "SELECT gen, rows FROM generations WHERE sealed = 0 ORDER BY gen DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        self.gen = gen;
        self.gen_rows = rows as u64;
        Ok(())
    }

    /// Insert one row into the open generation; seal it when full. Returns
    /// whether this row sealed the generation.
    pub fn append(
        &mut self,
        tx: &Transaction,
        columns: &[&str],
        values: &[&dyn ToSql],
        meters: &mut Meters,
    ) -> Result<bool, StoreError> {
        let slots: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
        tx.prepare_cached(&format!(
            "INSERT INTO log_g{}({}) VALUES({})",
            self.gen,
            columns.join(", "),
            slots.join(", ")
        ))
        .map_err(err)?
        .execute(params_from_iter(values.iter()))
        .map_err(err)?;
        self.gen_rows += 1;
        if self.gen_rows >= self.generation_rows {
            self.seal(tx, meters)?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Archive, verify and drop the open generation; open the next one.
    fn seal(&mut self, tx: &Transaction, meters: &mut Meters) -> Result<(), StoreError> {
        let gen = self.gen;
        let mut lines = Vec::new();
        {
            let mut stmt = tx
                .prepare(&format!(
                    "SELECT {} FROM log_g{gen} ORDER BY {}",
                    self.shape.archived.join(", "),
                    self.shape.key
                ))
                .map_err(err)?;
            let n = self.shape.archived.len();
            let mut rows = stmt.query([]).map_err(err)?;
            while let Some(r) = rows.next().map_err(err)? {
                let row = (0..n)
                    .map(|i| r.get_ref(i).map(json_of).map_err(err))
                    .collect::<Result<Vec<Value>, _>>()?;
                lines.extend(serde_json::to_vec(&row).map_err(err)?);
                lines.push(b'\n');
            }
        }
        std::fs::create_dir_all(&self.archive).map_err(err)?;
        let file = self.archive.join(format!("gen-{gen}.ndjson"));
        std::fs::write(&file, &lines).map_err(err)?;
        let digest = blake3::hash(&lines).to_hex().to_string();
        let back = std::fs::read(&file).map_err(err)?;
        if blake3::hash(&back).to_hex().to_string() != digest {
            return Err(StoreError(
                "archive read-back differs; generation kept".into(),
            ));
        }
        meters.add(ARCHIVE_PUTS, 1);
        meters.add(ARCHIVE_BYTES, lines.len() as u64);
        tx.execute(
            "UPDATE generations SET rows = ?2, sealed = 1, digest = ?3, bytes = ?4 WHERE gen = ?1",
            params![gen, self.gen_rows as i64, digest, lines.len() as i64],
        )
        .map_err(err)?;
        tx.execute_batch(&format!("DROP TABLE log_g{gen};"))
            .map_err(err)?;
        self.create_table(tx, gen + 1)?;
        schema_changed(tx);
        tx.execute(
            "INSERT INTO generations(gen, rows, sealed) VALUES(?1, 0, 0)",
            [gen + 1],
        )
        .map_err(err)?;
        self.gen = gen + 1;
        self.gen_rows = 0;
        Ok(())
    }

    /// Sealed archive files, in order (erasure residue scan).
    pub fn files(&self) -> Vec<PathBuf> {
        match std::fs::read_dir(&self.archive) {
            Ok(dir) => {
                let mut f: Vec<PathBuf> = dir.filter_map(|e| e.ok().map(|e| e.path())).collect();
                f.sort();
                f
            }
            Err(_) => Vec::new(),
        }
    }
}

fn json_of(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(b.iter().map(|x| format!("{x:02x}")).collect()),
    }
}

/// One owner's sealing key: (key_id, key bytes).
pub type OwnerKey = (i64, Vec<u8>);

/// The owner's key, minted from the store's deterministic stream on first use.
pub fn owner_key(tx: &Transaction, rng: &mut DetRng, owner: &str) -> Result<OwnerKey, StoreError> {
    if let Some(k) = tx
        .prepare_cached("SELECT key_id, key FROM owner_keys WHERE owner = ?1")
        .map_err(err)?
        .query_row([owner], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(err)?
    {
        return Ok(k);
    }
    let key: Vec<u8> = (0..4).flat_map(|_| rng.next_u64().to_le_bytes()).collect();
    tx.prepare_cached("INSERT INTO owner_keys(owner, key) VALUES(?1, ?2)")
        .map_err(err)?
        .execute(params![owner, key])
        .map_err(err)?;
    Ok((tx.last_insert_rowid(), key))
}

/// The key with this id, or none once its owner was erased.
pub fn key_by_id(tx: &Connection, key_id: i64) -> Result<Option<Vec<u8>>, StoreError> {
    tx.prepare_cached("SELECT key FROM owner_keys WHERE key_id = ?1")
        .map_err(err)?
        .query_row([key_id], |r| r.get(0))
        .optional()
        .map_err(err)
}

/// Destroy the owner's key: every value sealed with it becomes unreadable.
pub fn destroy_owner_key(tx: &Transaction, owner: &str) -> Result<(), StoreError> {
    tx.execute("DELETE FROM owner_keys WHERE owner = ?1", [owner])
        .map_err(err)?;
    Ok(())
}

/// Nonce of a sealed log payload: the operation's sequence and attempt.
pub fn op_nonce(sequence: u64, attempt: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(&sequence.to_le_bytes());
    nonce[8..].copy_from_slice(&attempt.to_le_bytes());
    nonce
}

pub fn seal(key: &[u8], nonce: &[u8; 12], plain: &[u8]) -> Result<Vec<u8>, StoreError> {
    ChaCha20Poly1305::new_from_slice(key)
        .map_err(err)?
        .encrypt(Nonce::from_slice(nonce), plain)
        .map_err(|_| StoreError("history seal failed".into()))
}

pub fn open(key: &[u8], nonce: &[u8; 12], sealed: &[u8]) -> Result<Vec<u8>, StoreError> {
    ChaCha20Poly1305::new_from_slice(key)
        .map_err(err)?
        .decrypt(Nonce::from_slice(nonce), sealed)
        .map_err(|_| StoreError("sealed value does not open".into()))
}
