//! Private, bounded reuse of explicitly deterministic reads on ONE retained
//! readonly snapshot. This does not cache account rights or survive finish.
use super::{wipe_rows, QueryRows};
use rusqlite::types::Value;
use zeroize::Zeroize;

const MAX_ENTRIES: usize = 128;
const MAX_BYTES: usize = 4 * 1024 * 1024;

struct Entry {
    sql: String,
    params: Vec<Value>,
    rows: QueryRows,
    result_bytes: usize,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.sql.zeroize();
        for param in &mut self.params {
            match param {
                Value::Text(v) => v.zeroize(),
                Value::Blob(v) => v.zeroize(),
                _ => {}
            }
        }
        wipe_rows(&mut self.rows);
    }
}
#[derive(Default)]
pub(crate) struct Memo {
    entries: Vec<Entry>,
    tables: Vec<Table>,
    held_bytes: usize,
}
struct Table {
    name: String,
    exists: Option<bool>,
}
impl Drop for Table {
    fn drop(&mut self) {
        self.name.zeroize();
    }
}
impl Memo {
    pub(super) fn table(&self, name: &str) -> Option<Option<bool>> {
        self.tables
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.exists)
    }
    pub(super) fn retain_table(&mut self, name: &str, exists: Option<bool>) {
        let size = name.len().saturating_add(64);
        if self.entries.len() + self.tables.len() >= MAX_ENTRIES
            || size > MAX_BYTES.saturating_sub(self.held_bytes)
        {
            return;
        }
        self.held_bytes += size;
        self.tables.push(Table {
            name: name.into(),
            exists,
        });
    }
    pub(crate) fn find(
        &self,
        sql: &str,
        params: &[Value],
        rows: usize,
        bytes: usize,
    ) -> Option<QueryRows> {
        let entry = self.entries.iter().find(|e| {
            e.sql == sql
                && e.params.len() == params.len()
                && e.params
                    .iter()
                    .zip(params)
                    .all(|(left, right)| match (left, right) {
                        // SQLite values retain raw IEEE754 bits in this program.
                        // Rust f64 equality would conflate -0.0 and +0.0 here.
                        (Value::Real(left), Value::Real(right)) => {
                            left.to_bits() == right.to_bits()
                        }
                        _ => left == right,
                    })
        })?;
        if entry.rows.rows.len() > rows || entry.result_bytes > bytes {
            return None;
        }
        let mut result = entry.rows.clone();
        // These VM steps were already counted on the original SQL execution.
        result.progress_callbacks = 0;
        Some(result)
    }
    pub(crate) fn retain(
        &mut self,
        sql: &str,
        params: &[Value],
        rows: &QueryRows,
        result_bytes: usize,
    ) {
        let Some(size) = params
            .iter()
            .try_fold(sql.len().saturating_add(result_bytes), |n, p| {
                n.checked_add(match p {
                    Value::Text(v) => v.len(),
                    Value::Blob(v) => v.len(),
                    _ => 8,
                })
            })
        else {
            return;
        };
        // Account vector/row/cell overhead as well as exact payload. This is a
        // bounded estimate, not an allocator/RSS claim. Never evict and refetch
        // just to make room for a new query: skipping reuse is always correct.
        let overhead = rows
            .columns
            .len()
            .saturating_mul(64)
            .saturating_add(
                rows.rows
                    .iter()
                    .map(|r| 32usize.saturating_add(r.len().saturating_mul(64)))
                    .sum::<usize>(),
            )
            .saturating_add(params.len().saturating_mul(64))
            .saturating_add(256);
        let Some(size) = size.checked_add(overhead) else {
            return;
        };
        if self.entries.len() + self.tables.len() >= MAX_ENTRIES
            || size > MAX_BYTES.saturating_sub(self.held_bytes)
        {
            return;
        }
        self.held_bytes += size;
        self.entries.push(Entry {
            sql: sql.into(),
            params: params.to_vec(),
            rows: rows.clone(),
            result_bytes,
        });
    }
}
