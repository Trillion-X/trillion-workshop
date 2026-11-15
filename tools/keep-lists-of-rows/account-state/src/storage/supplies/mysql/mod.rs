// src/storage/supplies/mysql/mod.rs
//
// Purpose: The MySQL-wire `Wire` for the shared relational supply. One implementation serves every server that speaks the
// MySQL protocol: MySQL, MariaDB, and the services built on them (TiDB, PlanetScale).
//
// Non-Negotiable Invariants:
// - The connection asks the server to count matched rows, not changed rows (`CLIENT_FOUND_ROWS`), so a compare-and-set
//   update that rewrites a value to itself still reports that the row matched.
// - A single statement is prepared once per connection (the statement cache is sized above the number of shapes) and
//   then costs one round trip; `rounds` counts the prepare too. Several statements are one text request of
//   statements joined by `;`, each parameter written in as a hex byte string or a number built from DATA, and the
//   server stops at the first one that fails. A request longer than `MAX_REQUEST` is split.
// - A driver error is mapped to a `storage::Error` here: duplicate key is `Conflict`; a lock wait that ran out or a
//   deadlock is `Busy`; data or key too long is `TooBig`; anything else is `Unavailable`.
// - The connection works in a database of its own (a store name), so one server holds many independent stores.
//
// Key Concepts:
// - `connect(url, store_name)`: opens the connection, makes the store name, detects MySQL or MariaDB.
//
// Security Considerations:
// - `place` never returns the password.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::sql::{inline, Answer, Cell, Dialect, Param, Shape, Step, Wire};
use local_engine::storage::{Error, Result};
use mysql::{
    consts::{CapabilityFlags, ColumnType},
    prelude::Queryable,
    Conn, Opts, OptsBuilder, Value,
};
use std::{cell::Cell as Counter, cell::RefCell, collections::HashSet};

/// The most text one request carries; a pipeline of statements longer than this goes in several requests.
const MAX_REQUEST: usize = 8 * 1024 * 1024;

pub struct MySql {
    conn: RefCell<Conn>,
    prepared: RefCell<HashSet<String>>,
    dialect: Dialect,
    rounds: Counter<u64>,
    place: String,
}

#[track_caller]
fn failure(error: mysql::Error) -> Error {
    let refusal = match error {
        mysql::Error::MySqlError(server) => match server.code {
            1062 => local_engine::cause!(caller: Error::Conflict),
            1205 | 1213 => local_engine::cause!(caller: Error::Busy),
            1406 | 1071 | 1074 | 1118 | 3150 => local_engine::cause!(caller: Error::TooBig),
            1317 | 3024 => local_engine::cause!(caller: Error::Interrupted),
            _ => local_engine::cause!(caller: Error::Unavailable),
        },
        _ => local_engine::cause!(caller: Error::Unavailable),
    };
    if std::env::var_os("STORAGE_SUPPLY_DEBUG").is_some() {
        crate::quiet_eprintln!("storage-refusal cause={}", refusal.cause());
    }
    refusal
}

impl MySql {
    /// Connect with a `mysql://user:password@host:port` URL and work in database `store_name` (created if missing).
    pub fn connect(url: &str, store_name: &str, lock_timeout_s: u32) -> Result<Self> {
        let opts = Opts::from_url(url).map_err(|_| local_engine::cause!(Error::Invalid))?;
        let place = format!(
            "mysql://{}@{}:{}/{store_name}",
            opts.get_user().unwrap_or("-"),
            opts.get_ip_or_hostname(),
            opts.get_tcp_port()
        );
        let opts = OptsBuilder::from_opts(opts)
            .additional_capabilities(CapabilityFlags::CLIENT_FOUND_ROWS)
            .stmt_cache_size(Some(4096));
        let mut conn = Conn::new(opts).map_err(|error| failure(error))?;
        let version: String = conn.query_first("SELECT VERSION()").map_err(|error| failure(error))?.ok_or(local_engine::cause!(Error::Unavailable))?;
        let dialect = if version.contains("MariaDB") { Dialect::MariaDb } else { Dialect::MySql };
        conn.query_drop(format!("CREATE DATABASE IF NOT EXISTS `{store_name}`")).map_err(|error| failure(error))?;
        conn.query_drop(format!("USE `{store_name}`")).map_err(|error| failure(error))?;
        conn.query_drop(format!("SET SESSION innodb_lock_wait_timeout = {lock_timeout_s}")).map_err(|error| failure(error))?;
        // MySQL 8 caches table statistics for a day by default; the byte total must be current. MariaDB has no such
        // variable and always reports live figures.
        if dialect == Dialect::MySql {
            conn.query_drop("SET SESSION information_schema_stats_expiry = 0").map_err(|error| failure(error))?;
        }
        Ok(Self { conn: RefCell::new(conn), prepared: RefCell::new(HashSet::new()), dialect, rounds: Counter::new(6), place })
    }

    fn count(&self, sql: &str) {
        let first = self.prepared.borrow_mut().insert(sql.to_owned());
        self.rounds.set(self.rounds.get() + 1 + u64::from(first));
    }
}

fn bound(params: &[Param]) -> Vec<Value> {
    params
        .iter()
        .map(|param| match param {
            Param::Bytes(bytes) => Value::Bytes(bytes.clone()),
            Param::Int(number) => Value::Int(*number),
        })
        .collect()
}

/// A result cell: the prepared protocol answers numbers as numbers; the text protocol answers everything as bytes, so
/// a number is told by its column's type.
fn cell(value: Value, number: bool) -> Result<Cell> {
    Ok(match value {
        Value::NULL => Cell::Null,
        Value::Bytes(bytes) if number => {
            Cell::Int(std::str::from_utf8(&bytes).ok().and_then(|text| text.parse().ok()).ok_or(local_engine::cause!(Error::Unavailable))?)
        }
        Value::Bytes(bytes) => Cell::Bytes(bytes),
        Value::Int(number) => Cell::Int(number),
        Value::UInt(number) => Cell::Int(i64::try_from(number).unwrap_or(i64::MAX)),
        _ => Cell::Null,
    })
}

fn integer(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_TINY
            | ColumnType::MYSQL_TYPE_SHORT
            | ColumnType::MYSQL_TYPE_INT24
            | ColumnType::MYSQL_TYPE_LONG
            | ColumnType::MYSQL_TYPE_LONGLONG
    )
}

impl MySql {
    /// One statement through the prepared protocol.
    fn single(&self, step: &Step) -> Result<Answer> {
        self.count(&step.sql);
        let mut conn = self.conn.borrow_mut();
        match step.shape {
            Shape::Rows => {
                let rows: Vec<mysql::Row> = conn.exec(&step.sql, bound(&step.params)).map_err(|error| failure(error))?;
                Ok(Answer::Rows(
                    rows.into_iter().map(|row| row.unwrap().into_iter().map(|value| cell(value, false)).collect()).collect::<Result<_>>()?,
                ))
            }
            Shape::Changed => {
                conn.exec_drop(&step.sql, bound(&step.params)).map_err(|error| failure(error))?;
                Ok(Answer::Changed(conn.affected_rows()))
            }
        }
    }

    /// Statements joined into one text request: each leaves a result set, in order, and a failure ends the request.
    fn send(&self, text: &str, shapes: &[Shape], answers: &mut Vec<Answer>) -> Result<()> {
        self.rounds.set(self.rounds.get() + 1);
        let mut conn = self.conn.borrow_mut();
        let mut result = conn.query_iter(text).map_err(|error| failure(error))?;
        let mut shapes = shapes.iter();
        while let Some(set) = result.iter() {
            let shape = shapes.next().ok_or(local_engine::cause!(Error::Unavailable))?;
            let changed = set.affected_rows();
            let numbers: Vec<bool> = set.columns().as_ref().iter().map(|column| integer(column.column_type())).collect();
            let mut rows: Vec<Vec<Cell>> = Vec::new();
            for row in set {
                let row = row.map_err(|error| failure(error))?;
                rows.push(row.unwrap().into_iter().enumerate().map(|(at, value)| cell(value, numbers.get(at).copied().unwrap_or(false))).collect::<Result<_>>()?);
            }
            answers.push(match shape {
                Shape::Rows => Answer::Rows(rows),
                Shape::Changed => Answer::Changed(changed),
            });
        }
        if shapes.next().is_some() {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        Ok(())
    }
}

impl Wire for MySql {
    fn dialect(&self) -> Dialect {
        self.dialect
    }

    fn pipeline(&self, steps: &[Step]) -> Result<Vec<Answer>> {
        // A data statement with parameters is prepared once and reused; scope control (no parameters) is not always
        // allowed as a prepared statement, so it travels as text.
        if let [step] = steps {
            if !step.params.is_empty() {
                return Ok(vec![self.single(step)?]);
            }
        }
        let mut answers = Vec::with_capacity(steps.len());
        let (mut text, mut shapes) = (String::new(), Vec::new());
        for step in steps {
            let one = inline(self.dialect, step);
            if !text.is_empty() && text.len() + one.len() >= MAX_REQUEST {
                self.send(&text, &shapes, &mut answers)?;
                (text, shapes) = (String::new(), Vec::new());
            }
            if !text.is_empty() {
                text.push(';');
            }
            text.push_str(&one);
            shapes.push(step.shape);
        }
        if !shapes.is_empty() {
            self.send(&text, &shapes, &mut answers)?;
        }
        Ok(answers)
    }

    fn script(&self, statements: &[String]) -> Result<()> {
        for statement in statements {
            self.rounds.set(self.rounds.get() + 1);
            self.conn.borrow_mut().query_drop(statement).map_err(|error| failure(error))?;
        }
        Ok(())
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
