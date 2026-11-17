// src/store/copy.rs
//
// Purpose: Copies the account owner's names index, the archive tables ns_name, ns_folder, ns_file, ns_chunk, ns_alias and ns_spans of a
// SQLite file, into the tables of this store's database, whichever database that is (SQLite or the person's Postgres). The mapping from an
// archive row to a row here is `copy-from-archive.sql`, one INSERT ... SELECT a table: this module reads each SELECT against the archive
// and writes its rows here a batch at a time.
//
// Non-Negotiable Invariants:
// - The archive is opened read-only (`Link::archive`) and is never written, journaled or given a permission.
// - A row already here under the same scope and id is left as it is, so a copy that stopped is run again and finishes.
// - Each batch is one statement, so a row is whole or absent, and a walk by id sees every archive row once.
//
// Key Concepts:
// - The archive's columns carry no types: a number may be stored as text. A value is read as the kind its column here declares.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{declared, link::Cell, Error, Kind, Link, SqlStore};

/// Rows read from the archive, and written here, in one step.
const BATCH: usize = 400;

/// One table's copy: its name here, its columns in order, and the archive SELECT that makes them.
struct Step {
    table: String,
    columns: Vec<String>,
    select: String,
}

fn steps() -> Vec<Step> {
    let statements = include_str!("copy-from-archive.sql").lines().filter(|line| !line.starts_with("--")).collect::<Vec<_>>().join("\n");
    statements
        .split(";\n")
        .filter_map(|text| {
            let body = text.trim().strip_prefix("INSERT INTO ")?;
            let (table, rest) = body.split_once(" (")?;
            let (columns, select) = rest.split_once(")\nSELECT")?;
            Some(Step {
                table: table.to_owned(),
                columns: columns.split(", ").map(|name| name.trim_matches('"').to_owned()).collect(),
                select: format!("SELECT{}", select.trim_end_matches(';').replace("archive.", "")),
            })
        })
        .collect()
}

/// The kind of a column here.
fn kind_of(table: &str, column: &str) -> Kind {
    match column {
        "version" => Kind::Int,
        "scope" | "id" | "extra" => Kind::Text,
        _ => declared().tables.iter().find(|candidate| candidate.table == table).and_then(|candidate| candidate.columns.iter().find(|held| held.name == column)).map_or(Kind::Text, |held| held.kind),
    }
}

impl SqlStore {
    /// How many rows each table of this store's database holds, in `copy-from-archive.sql` order: the readback of a copy. Only reads.
    pub fn table_counts(&self) -> Result<Vec<(String, u64)>, Error> {
        let mut link = self.link.lock().map_err(|_| crate::cause!(Error::Unavailable))?;
        let mut counts = Vec::new();
        for step in steps() {
            let rows = link.query(&format!("SELECT CAST(COUNT(*) AS BIGINT) FROM {}", step.table), &[])?;
            counts.push((step.table, rows.first().and_then(|row| row[0].as_int()).and_then(|count| u64::try_from(count).ok()).ok_or(crate::cause!(Error::Unavailable))?));
        }
        Ok(counts)
    }


    /// Copy every archive table into this store's database. `copied` is told the table and how many rows are in it so far, after each batch.
    /// Answers each table's name and the rows it had in the archive.
    pub fn copy_from_archive(&self, archive: &mut Link, copied: &mut dyn FnMut(&str, u64)) -> Result<Vec<(String, u64)>, Error> {
        let mut counts = Vec::new();
        for step in steps() {
            let kinds: Vec<Kind> = step.columns.iter().map(|column| kind_of(&step.table, column)).collect();
            let columns = step.columns.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
            let page = format!("SELECT * FROM ({}) AS copied WHERE id > ? ORDER BY id LIMIT {BATCH}", step.select);
            let (mut after, mut total) = (String::new(), 0u64);
            loop {
                let rows = archive.query(&page, &[Cell::text(&after)])?;
                let Some(last) = rows.last() else { break };
                after = last[1].as_text().ok_or_else(|| Error::Invalid("an archive row has no id", crate::cause!()))?;
                let marks = format!("({})", vec!["?"; step.columns.len()].join(", "));
                let sql = format!("INSERT INTO {} ({columns}) VALUES {} ON CONFLICT (scope, id) DO NOTHING", step.table, vec![marks; rows.len()].join(", "));
                let params: Vec<Cell> = rows
                    .iter()
                    .flatten()
                    .enumerate()
                    .map(|(at, cell)| match kinds[at % kinds.len()] {
                        Kind::Int => Cell::Int(cell.as_int()),
                        Kind::Text | Kind::Json => Cell::Text(cell.as_text()),
                    })
                    .collect();
                self.link.lock().map_err(|_| crate::cause!(Error::Unavailable))?.execute(&sql, &params)?;
                total += rows.len() as u64;
                copied(&step.table, total);
            }
            counts.push((step.table, total));
        }
        Ok(counts)
    }
}
