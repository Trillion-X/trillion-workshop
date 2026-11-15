// src/storage/supplies/postgres/mod.rs
//
// Purpose: The Postgres-wire `Wire` for the shared relational supply. One implementation serves every server that
// speaks the Postgres protocol: PostgreSQL itself, CockroachDB, and the hosted services built on them (Supabase, Neon,
// Aurora, AlloyDB, YugabyteDB).
//
// Non-Negotiable Invariants:
// - A pipeline of statements is one text request (the simple query protocol), each parameter written into its statement
//   as a hex byte string or a number built from DATA, so any number of statements, with a savepoint around them, costs
//   one round trip. A request longer than `MAX_REQUEST` is split. `rounds` counts requests.
// - A driver error is mapped to a `storage::Error` here: a unique violation is `Conflict`; a lock wait that ran out or a
//   serialization failure is `Busy`; an oversized index row is `TooBig`; anything else is `Unavailable`.
// - The connection works in its own schema (a store name), so one server holds many independent stores.
//
// Key Concepts:
// - `connect(url, store_name)`: opens the connection, makes the store name, detects PostgreSQL or CockroachDB.
//
// Security Considerations:
// - `place` never returns the password.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::sql::{inline, text_cell, Answer, Cell, Dialect, Shape, Step, Wire};
use local_engine::storage::{Error, Result};
use postgres::{error::SqlState, Client, NoTls, SimpleQueryMessage};
use std::{cell::{Cell as Counter, RefCell}, time::Instant};
use crate::provider_units::{self, Quantity, Recorder};

/// The most text one request carries; a pipeline of statements longer than this goes in several requests.
const MAX_REQUEST: usize = 16 * 1024 * 1024;

pub struct Postgres {
    client: RefCell<Client>,
    dialect: Dialect,
    rounds: Counter<u64>,
    place: String,
    measurements: Recorder,
}

#[track_caller]
fn failure(error: postgres::Error) -> Error {
    let refusal = match error.code() {
        Some(code) if *code == SqlState::UNIQUE_VIOLATION => local_engine::cause!(caller: Error::Conflict),
        Some(code) if *code == SqlState::LOCK_NOT_AVAILABLE || *code == SqlState::T_R_SERIALIZATION_FAILURE || *code == SqlState::T_R_DEADLOCK_DETECTED => local_engine::cause!(caller: Error::Busy),
        Some(code) if *code == SqlState::QUERY_CANCELED => local_engine::cause!(caller: Error::Interrupted),
        Some(code) if *code == SqlState::PROGRAM_LIMIT_EXCEEDED || *code == SqlState::STRING_DATA_RIGHT_TRUNCATION => local_engine::cause!(caller: Error::TooBig),
        Some(code) if code.code() == "40003" => local_engine::cause!(caller: Error::Busy),
        _ => local_engine::cause!(caller: Error::Unavailable),
    };
    if std::env::var_os("STORAGE_SUPPLY_DEBUG").is_some() {
        crate::quiet_eprintln!("storage-refusal cause={}", refusal.cause());
    }
    refusal
}

impl Postgres {
    /// Connect with a libpq-style URL or key=value string and work in schema `store_name` (created if missing).
    pub fn connect(url: &str, store_name: &str, lock_timeout_ms: u32) -> Result<Self> {
        let measurements = Recorder::default();
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        let mut client = match Client::connect(url, NoTls) {
            Ok(client) => client,
            Err(error) => {
                measurements.record("postgres", "postgres.connection_startup", "connection", started_unix_ms,
                    started.elapsed().as_millis() as u64, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown,
                    Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 1);
                return Err(failure(error));
            }
        };
        measurements.record("postgres", "postgres.connection_startup", "connection", started_unix_ms,
            started.elapsed().as_millis() as u64, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown,
            Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 0);
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        let version_query = "SELECT version()";
        let version_result = client.query_one(version_query, &[]);
        match &version_result {
            Ok(_) => measurements.record("postgres", "postgres.version_query", "connection", started_unix_ms,
                started.elapsed().as_millis() as u64, Quantity::Measured(version_query.len() as u64), Quantity::Unknown,
                Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 0),
            Err(_) => measurements.record("postgres", "postgres.version_query", "connection", started_unix_ms,
                started.elapsed().as_millis() as u64, Quantity::Measured(version_query.len() as u64), Quantity::Unknown,
                Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 1),
        }
        let version: String = version_result.map_err(|error| failure(error))?.get(0);
        let dialect = if version.contains("CockroachDB") { Dialect::Cockroach } else { Dialect::Postgres };
        let setup = format!("CREATE SCHEMA IF NOT EXISTS \"{store_name}\"; SET search_path TO \"{store_name}\"; SET lock_timeout = {lock_timeout_ms}");
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        if let Err(error) = client.batch_execute(&setup) {
            measurements.record("postgres", "postgres.connection_setup", "connection", started_unix_ms,
                started.elapsed().as_millis() as u64, Quantity::Measured(setup.len() as u64), Quantity::Unknown,
                Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 1);
            return Err(failure(error));
        }
        measurements.record("postgres", "postgres.connection_setup", "connection", started_unix_ms,
            started.elapsed().as_millis() as u64, Quantity::Measured(setup.len() as u64), Quantity::Unknown,
            Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 0);
        let place = url.split_whitespace().filter(|part| !part.starts_with("password=")).collect::<Vec<_>>().join(" ");
        Ok(Self {
            client: RefCell::new(client),
            dialect,
            rounds: Counter::new(3),
            place: format!("{place} schema={store_name}"),
            measurements,
        })
    }

    /// Send statements joined into one text request and take each statement's answer from the replies: a statement
    /// ends with its command-complete message, after the rows it returned.
    fn send(&self, text: &str, shapes: &[Shape], answers: &mut Vec<Answer>) -> Result<()> {
        self.rounds.set(self.rounds.get() + 1);
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        let messages = match self.client.borrow_mut().simple_query(text) {
            Ok(messages) => messages,
            Err(error) => {
                self.measurements.record("postgres", "postgres.pipeline", "connection", started_unix_ms,
                    started.elapsed().as_millis() as u64, Quantity::Measured(text.len() as u64), Quantity::Unknown,
                    Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 1);
                return Err(failure(error));
            }
        };
        self.measurements.record("postgres", "postgres.pipeline", "connection", started_unix_ms,
            started.elapsed().as_millis() as u64, Quantity::Measured(text.len() as u64), Quantity::Unknown,
            Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 0);
        let mut shapes = shapes.iter();
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        for message in messages {
            match message {
                SimpleQueryMessage::Row(row) => rows.push((0..row.len()).map(|at| text_cell(row.get(at))).collect::<Result<_>>()?),
                SimpleQueryMessage::CommandComplete(changed) => answers.push(match shapes.next().ok_or(local_engine::cause!(Error::Unavailable))? {
                    Shape::Rows => Answer::Rows(std::mem::take(&mut rows)),
                    Shape::Changed => Answer::Changed(changed),
                }),
                _ => {}
            }
        }
        if shapes.next().is_some() {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        Ok(())
    }

    /// Transport observations for actual PostgreSQL requests. `elapsed_ms` is
    /// client wall time; PostgreSQL server execution time and capacity remain
    /// `Unknown` unless a protocol-level source supplies them.
    pub fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }
}

impl Wire for Postgres {
    fn dialect(&self) -> Dialect {
        self.dialect
    }

    fn pipeline(&self, steps: &[Step]) -> Result<Vec<Answer>> {
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
        // A maintenance statement cannot run inside the implicit transaction of a multi-statement message.
        let alone = statements.iter().any(|statement| statement.starts_with("VACUUM"));
        let batches: Vec<String> = if alone { statements.to_vec() } else { vec![statements.join(";")] };
        for batch in batches {
            self.rounds.set(self.rounds.get() + 1);
            let started_unix_ms = provider_units::now_unix_ms();
            let started = Instant::now();
            match self.client.borrow_mut().batch_execute(&batch) {
                Ok(()) => self.measurements.record("postgres", "postgres.script", "connection", started_unix_ms,
                    started.elapsed().as_millis() as u64, Quantity::Measured(batch.len() as u64), Quantity::Unknown,
                    Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 0),
                Err(error) => {
                    self.measurements.record("postgres", "postgres.script", "connection", started_unix_ms,
                        started.elapsed().as_millis() as u64, Quantity::Measured(batch.len() as u64), Quantity::Unknown,
                        Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, Quantity::Unknown, 1);
                    return Err(failure(error));
                }
            }
        }
        Ok(())
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }
    fn measurement_count(&self) -> usize { self.measurements.len() }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { self.measurements.snapshot_since(index) }

    fn place(&self) -> String {
        self.place.clone()
    }
}
