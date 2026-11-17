// src/store/link.rs
//
// Purpose: The one connection the names index talks to its database over, SQLite (a file of the person's own) or Postgres (the person's
// own database), behind the same four calls: `query`, `execute`, `batch` and the transaction brackets. The statements are written once with `?`
// for each value; Postgres numbers them as it sends them. Nothing here knows a table, a scope or a record.
//
// Non-Negotiable Invariants:
// - A value is a `Cell` and travels as a bound parameter, never inside statement text.
// - A database error is answered as `Error::Unavailable` with its cause site, never its message: a message can name a host, a user or
//   a path. A commit whose outcome is unknown is `Error::OutcomeUnknown`.
// - The password of a Postgres connection arrives as an argument of `postgres`, read by the caller from the descriptor the engine
//   attached; it is never kept in a field that prints.
//
// Key Concepts:
// - `Dialect` is the only place the two databases differ: a transaction's first statement, the lock a read takes inside one, how a
//   column holding an id compares, and the type names of a bound parameter.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::Error;
use std::path::Path;

/// One value of a row or of a statement's parameters. A null carries the kind of the column it is for, because Postgres types each
/// parameter.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Int(Option<i64>),
    Text(Option<String>),
}
impl Cell {
    pub fn text(value: &str) -> Self {
        Cell::Text(Some(value.to_owned()))
    }
    pub fn int(value: i64) -> Self {
        Cell::Int(Some(value))
    }
    /// The cell as text, whichever kind it was read as.
    pub fn as_text(&self) -> Option<String> {
        match self {
            Cell::Text(text) => text.clone(),
            Cell::Int(number) => number.map(|number| number.to_string()),
        }
    }
    /// The cell as a whole number, whichever kind it was read as.
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Cell::Int(number) => *number,
            Cell::Text(text) => text.as_deref().and_then(|text| text.trim().parse().ok()),
        }
    }
}

/// Which database a link is to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Sqlite,
    Postgres,
}
impl Dialect {
    /// The column type of an id: Postgres compares text by the database's language rules unless told bytes, and a page's order must
    /// be the same in both.
    pub fn id_type(self) -> &'static str {
        match self {
            Dialect::Sqlite => "TEXT",
            Dialect::Postgres => "TEXT COLLATE \"C\"",
        }
    }
    /// What follows a read inside a transaction whose row the transaction will change.
    pub fn lock_read(self) -> &'static str {
        match self {
            Dialect::Sqlite => "",
            Dialect::Postgres => " FOR UPDATE",
        }
    }
    /// The parameter marker of the nth value (counted from 1), with its type named where Postgres needs it.
    fn marker(self, nth: usize, cell: &Cell) -> String {
        match (self, cell) {
            (Dialect::Sqlite, _) => "?".to_owned(),
            (Dialect::Postgres, Cell::Int(_)) => format!("CAST(${nth} AS BIGINT)"),
            (Dialect::Postgres, Cell::Text(_)) => format!("CAST(${nth} AS TEXT)"),
        }
    }
}

enum Inner {
    Sqlite(rusqlite::Connection),
    Postgres(Box<postgres::Client>),
}

/// One open connection.
pub struct Link {
    inner: Inner,
    place: String,
}

fn unavailable<E>(_: E) -> Error {
    crate::cause!(Error::Unavailable)
}

impl Link {
    /// A SQLite file, made when it is not there. Only the owner can read it.
    pub fn sqlite(path: &Path) -> Result<Self, Error> {
        let connection = rusqlite::Connection::open(path).map_err(unavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Self::sqlite_over(connection, path.display().to_string())
    }

    /// A SQLite file that is only read: opened read-only, with no pragma, no permission change and no journal of its own, so a file in use
    /// by another program (the account owner's archive) is left exactly as it is.
    pub fn archive(path: &Path) -> Result<Self, Error> {
        let connection = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(unavailable)?;
        Ok(Self { inner: Inner::Sqlite(connection), place: path.display().to_string() })
    }

    /// A SQLite database that lives only as long as the link (tests).
    pub fn memory() -> Result<Self, Error> {
        Self::sqlite_over(rusqlite::Connection::open_in_memory().map_err(unavailable)?, ":memory:".to_owned())
    }

    fn sqlite_over(connection: rusqlite::Connection, place: String) -> Result<Self, Error> {
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;")
            .map_err(unavailable)?;
        Ok(Self { inner: Inner::Sqlite(connection), place })
    }

    /// The person's Postgres database, from the connection string the engine attached to the run (`postgresql://user:password@host:port/database`).
    /// Only a database on this computer's own loopback may be reached without encryption.
    pub fn postgres(connection: &str) -> Result<Self, Error> {
        let mut config: postgres::Config = connection.parse().map_err(|_| Error::Invalid("the database connection is not a Postgres connection string", crate::cause!()))?;
        // The server's own error text can carry the connection string's parts; none of it is kept.
        config.application_name("live-namespace");
        let loopback = !config.get_hosts().is_empty()
            && config.get_hosts().iter().all(|host| matches!(host, postgres::config::Host::Tcp(name) if matches!(name.as_str(), "127.0.0.1" | "localhost" | "::1")));
        let place = match (config.get_hosts().first(), config.get_ports().first(), config.get_dbname()) {
            (Some(postgres::config::Host::Tcp(host)), Some(port), Some(database)) => format!("postgres://{host}:{port}/{database}"),
            _ => "postgres".to_owned(),
        };
        let client = if loopback {
            config.connect(postgres::NoTls).map_err(unavailable)?
        } else {
            let roots = rustls_native_certs::load_native_certs();
            let mut store = rustls::RootCertStore::empty();
            for certificate in roots.certs {
                let _ = store.add(certificate);
            }
            let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(unavailable)?
                .with_root_certificates(store)
                .with_no_client_auth();
            config.connect(tokio_postgres_rustls::MakeRustlsConnect::new(tls)).map_err(unavailable)?
        };
        Ok(Self { inner: Inner::Postgres(Box::new(client)), place })
    }

    pub fn dialect(&self) -> Dialect {
        match self.inner {
            Inner::Sqlite(_) => Dialect::Sqlite,
            Inner::Postgres(_) => Dialect::Postgres,
        }
    }

    /// Where the database is, for a person to read: a file path or `postgres://host:port/name`. Never a user or a password.
    pub fn place(&self) -> &str {
        &self.place
    }

    /// Run a statement that answers rows.
    pub fn query(&mut self, sql: &str, params: &[Cell]) -> Result<Vec<Vec<Cell>>, Error> {
        let text = numbered(self.dialect(), sql, params);
        match &mut self.inner {
            Inner::Sqlite(connection) => {
                let mut statement = connection.prepare_cached(&text).map_err(unavailable)?;
                let columns = statement.column_count();
                let bound: Vec<rusqlite::types::Value> = params.iter().map(sqlite_value).collect();
                let mut rows = statement.query(rusqlite::params_from_iter(bound)).map_err(unavailable)?;
                let mut out = Vec::new();
                while let Some(row) = rows.next().map_err(unavailable)? {
                    let mut cells = Vec::with_capacity(columns);
                    for at in 0..columns {
                        cells.push(match row.get_ref(at).map_err(unavailable)? {
                            rusqlite::types::ValueRef::Null => Cell::Text(None),
                            rusqlite::types::ValueRef::Integer(number) => Cell::Int(Some(number)),
                            rusqlite::types::ValueRef::Real(number) => Cell::Int(Some(number as i64)),
                            rusqlite::types::ValueRef::Text(bytes) | rusqlite::types::ValueRef::Blob(bytes) => {
                                Cell::Text(Some(String::from_utf8_lossy(bytes).into_owned()))
                            }
                        });
                    }
                    out.push(cells);
                }
                Ok(out)
            }
            Inner::Postgres(client) => {
                let bound = postgres_values(params);
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = bound.iter().map(|value| value.as_ref()).collect();
                let rows = client.query(&text, &refs).map_err(unavailable)?;
                let mut out = Vec::with_capacity(rows.len());
                for row in rows {
                    let mut cells = Vec::with_capacity(row.len());
                    for at in 0..row.len() {
                        cells.push(if *row.columns()[at].type_() == postgres::types::Type::INT8 {
                            Cell::Int(row.try_get::<_, Option<i64>>(at).map_err(unavailable)?)
                        } else {
                            Cell::Text(row.try_get::<_, Option<String>>(at).map_err(unavailable)?)
                        });
                    }
                    out.push(cells);
                }
                Ok(out)
            }
        }
    }

    /// Run a statement that changes rows; answers how many.
    pub fn execute(&mut self, sql: &str, params: &[Cell]) -> Result<u64, Error> {
        let text = numbered(self.dialect(), sql, params);
        match &mut self.inner {
            Inner::Sqlite(connection) => {
                let bound: Vec<rusqlite::types::Value> = params.iter().map(sqlite_value).collect();
                let mut statement = connection.prepare_cached(&text).map_err(unavailable)?;
                statement.execute(rusqlite::params_from_iter(bound)).map(|changed| changed as u64).map_err(unavailable)
            }
            Inner::Postgres(client) => {
                let bound = postgres_values(params);
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = bound.iter().map(|value| value.as_ref()).collect();
                client.execute(&text, &refs).map_err(unavailable)
            }
        }
    }

    /// Run statements with no parameters (the tables, a transaction's brackets).
    pub fn batch(&mut self, sql: &str) -> Result<(), Error> {
        match &mut self.inner {
            Inner::Sqlite(connection) => connection.execute_batch(sql).map_err(unavailable),
            Inner::Postgres(client) => client.batch_execute(sql).map_err(unavailable),
        }
    }

    /// Open a transaction that holds the database's one writer from its first statement.
    pub fn begin(&mut self) -> Result<(), Error> {
        self.batch(match self.dialect() {
            Dialect::Sqlite => "BEGIN IMMEDIATE",
            Dialect::Postgres => "BEGIN",
        })
    }

    /// Commit. A commit that fails may have been applied.
    pub fn commit(&mut self) -> Result<(), Error> {
        self.batch("COMMIT").map_err(|_| crate::cause!(Error::OutcomeUnknown))
    }

    /// Undo the open transaction. Nothing to undo is not a failure.
    pub fn rollback(&mut self) {
        let _ = self.batch("ROLLBACK");
    }
}

/// The statement text with each `?` made the parameter marker of its value in `dialect`.
fn numbered(dialect: Dialect, sql: &str, params: &[Cell]) -> String {
    let mut out = String::with_capacity(sql.len() + params.len() * 8);
    for (nth, part) in sql.split('?').enumerate() {
        if nth > 0 {
            out.push_str(&dialect.marker(nth, &params[nth - 1]));
        }
        out.push_str(part);
    }
    out
}

fn sqlite_value(cell: &Cell) -> rusqlite::types::Value {
    match cell {
        Cell::Int(Some(number)) => rusqlite::types::Value::Integer(*number),
        Cell::Text(Some(text)) => rusqlite::types::Value::Text(text.clone()),
        Cell::Int(None) | Cell::Text(None) => rusqlite::types::Value::Null,
    }
}

/// A value that the Postgres driver sends: a number or text, possibly null.
enum Bound {
    Int(Option<i64>),
    Text(Option<String>),
}
impl Bound {
    fn as_ref(&self) -> &(dyn postgres::types::ToSql + Sync) {
        match self {
            Bound::Int(value) => value,
            Bound::Text(value) => value,
        }
    }
}
fn postgres_values(params: &[Cell]) -> Vec<Bound> {
    params
        .iter()
        .map(|cell| match cell {
            Cell::Int(value) => Bound::Int(*value),
            Cell::Text(value) => Bound::Text(value.clone()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_is_numbered_for_postgres_and_left_alone_for_sqlite() {
        let params = [Cell::text("a"), Cell::int(2), Cell::Text(None)];
        let sql = "SELECT id FROM ns_name WHERE scope = ? AND version > ? AND file IS NOT ?";
        assert_eq!(numbered(Dialect::Sqlite, sql, &params), sql);
        assert_eq!(
            numbered(Dialect::Postgres, sql, &params),
            "SELECT id FROM ns_name WHERE scope = CAST($1 AS TEXT) AND version > CAST($2 AS BIGINT) AND file IS NOT CAST($3 AS TEXT)"
        );
    }

    #[test]
    fn a_text_that_is_no_connection_string_is_refused_before_any_connection() {
        assert!(matches!(Link::postgres("not a connection"), Err(Error::Invalid(..))));
    }

    #[test]
    fn a_cell_reads_as_text_or_as_a_number_whichever_it_was_stored_as() {
        assert_eq!(Cell::Text(Some(" 42 ".into())).as_int(), Some(42));
        assert_eq!(Cell::Int(Some(7)).as_text().as_deref(), Some("7"));
        assert_eq!(Cell::Text(None).as_int(), None);
    }
}
