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
// - A Postgres connection can end under the link: the database restarts, the network drops, or (in a run the engine keeps in its
//   sandbox) the run's proxy closes a tunnel that stayed quiet past its `quiet_ms`, two minutes (the engine's public-egress.json).
//   So a Postgres link keeps how it was opened (`Reopen`) and opens again when its connection has ended and no transaction is open:
//   before any statement, and once more for a statement that changes nothing (a read, a `BEGIN`) that failed because the connection
//   ended under it. A statement that changes rows is never sent twice: inside a transaction, or a change outside one, its failure is
//   the call's. A link that listens (`listen`) listens again on its new connection, and its `heard` answers once at that moment,
//   because a notification sent while it was closed was not heard.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::Error;
use std::path::Path;
use super::through_the_run_proxy::{Ask, Told};
use zeroize::Zeroizing;

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
    /// The person's Postgres reached from a run in the engine's sandbox, over a tunnel through the run's proxy
    /// (through_the_run_proxy.rs).
    Tunneled(Box<super::through_the_run_proxy::Tunneled>),
}

/// One open connection.
pub struct Link {
    inner: Inner,
    place: String,
    /// How to open a Postgres connection again; none for SQLite, whose file does not go away under it.
    reopen: Option<Reopen>,
    /// A transaction is open (`begin` until `commit` or `rollback`): its connection is never replaced under it.
    in_transaction: bool,
    /// The channels this link listens on (`listen`), listened on again on a new connection.
    channels: Vec<String>,
    /// A statement failed saying the connection is gone, before the driver marked it closed.
    lost: bool,
    /// The transaction open has only begun and read: on a connection that ended under it, it may be begun again.
    fresh: bool,
    /// Statements written down to go with the next one awaited (`defer`), through the run's proxy only.
    waiting: Vec<Waiting>,
    /// The statements prepared on this connection, by their text.
    statements: std::collections::HashMap<String, postgres::Statement>,
}

/// The connection string a Postgres link was opened with. It prints nothing and is wiped when the link goes.
struct Reopen(Zeroizing<String>);

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

    /// A SQLite database that lives only as long as the link (tests).
    pub fn memory() -> Result<Self, Error> {
        Self::sqlite_over(rusqlite::Connection::open_in_memory().map_err(unavailable)?, ":memory:".to_owned())
    }

    fn sqlite_over(connection: rusqlite::Connection, place: String) -> Result<Self, Error> {
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;")
            .map_err(unavailable)?;
        Ok(Self { inner: Inner::Sqlite(connection), place, reopen: None, in_transaction: false, channels: Vec::new(), lost: false, fresh: false, waiting: Vec::new(), statements: Default::default() })
    }

    /// The person's Postgres database, from the connection string the engine attached to the run (`postgresql://user:password@host:port/database`).
    /// Only a database on this computer's own loopback may be reached without encryption.
    /// In a run the engine keeps in its sandbox (HTTPS_PROXY naming the engine's loopback proxy), any other database is reached through it.
    pub fn postgres(connection: &str) -> Result<Self, Error> {
        let (inner, place) = Self::open_postgres(connection)?;
        Ok(Self { inner, place, reopen: Some(Reopen(Zeroizing::new(connection.to_owned()))), in_transaction: false, channels: Vec::new(), lost: false, fresh: false, waiting: Vec::new(), statements: Default::default() })
    }

    fn open_postgres(connection: &str) -> Result<(Inner, String), Error> {
        // libpq's sslmode=verify-ca and verify-full (what a connection string for a database reached over the internet names) are not
        // values the client reads; its TLS here always checks the certificate's chain and the database's name, which is verify-full, so
        // both are read as `require`.
        let connection = connection.replace("sslmode=verify-full", "sslmode=require").replace("sslmode=verify-ca", "sslmode=require");
        let mut config: postgres::Config = connection.parse().map_err(|_| Error::Invalid("the database connection is not a Postgres connection string", crate::cause!()))?;
        // The server's own error text can carry the connection string's parts; none of it is kept.
        config.application_name("live-namespace");
        let loopback = !config.get_hosts().is_empty()
            && config.get_hosts().iter().all(|host| matches!(host, postgres::config::Host::Tcp(name) if matches!(name.as_str(), "127.0.0.1" | "localhost" | "::1")));
        let place = match (config.get_hosts().first(), config.get_ports().first(), config.get_dbname()) {
            (Some(postgres::config::Host::Tcp(host)), Some(port), Some(database)) => format!("postgres://{host}:{port}/{database}"),
            _ => "postgres".to_owned(),
        };
        // Tests prove the tunneled path on a database of their own on this computer, through a stand-in proxy they name.
        #[cfg(test)]
        if let (true, Ok(proxy)) = (loopback, std::env::var("NAMESPACE_POSTGRES_TEST_PROXY")) {
            let mut tunneled: tokio_postgres::Config = connection.parse().map_err(unavailable)?;
            tunneled.application_name("live-namespace");
            let client = super::through_the_run_proxy::Tunneled::open(&tunneled, &proxy, tokio_postgres::NoTls).map_err(unavailable)?;
            return Ok((Inner::Tunneled(Box::new(client)), place));
        }
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
            let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls);
            // A run the engine keeps in its sandbox reaches the database only through the run's proxy (through_the_run_proxy.rs).
            if let Some(proxy) = crate::https::engine_proxy(std::env::var("HTTPS_PROXY").ok().as_deref()) {
                let mut tunneled: tokio_postgres::Config = connection.parse().map_err(|_| Error::Invalid("the database connection is not a Postgres connection string", crate::cause!()))?;
                tunneled.application_name("live-namespace");
                let client = super::through_the_run_proxy::Tunneled::open(&tunneled, proxy, tls).map_err(unavailable)?;
                return Ok((Inner::Tunneled(Box::new(client)), place));
            }
            config.connect(tls).map_err(unavailable)?
        };
        Ok((Inner::Postgres(Box::new(client)), place))
    }

    /// The connection ended under the link (a Postgres one only; a SQLite file stays open).
    fn ended(&self) -> bool {
        match &self.inner {
            Inner::Sqlite(_) => false,
            Inner::Postgres(client) => self.lost || client.is_closed(),
            Inner::Tunneled(client) => self.lost || client.is_closed(),
        }
    }

    /// Open the Postgres connection again and listen again on this link's channels. What was prepared or waiting on the
    /// ended connection is gone with it.
    fn open_again(&mut self) -> Result<(), Error> {
        let Some(reopen) = &self.reopen else { return Err(crate::cause!(Error::Unavailable)) };
        let (inner, _) = Self::open_postgres(&reopen.0)?;
        self.inner = inner;
        self.lost = false;
        self.statements.clear();
        self.waiting.clear();
        for channel in self.channels.clone() {
            self.send(Waiting::plain(&format!("LISTEN {channel}")), Want::Done).map_err(|_| crate::cause!(Error::Unavailable))?;
        }
        Ok(())
    }

    /// Before a statement: a connection that ended with no transaction open is opened again.
    fn ready(&mut self) -> Result<(), Error> {
        if !self.in_transaction && self.ended() {
            self.open_again()?;
        }
        Ok(())
    }

    /// A statement that changes nothing: sent once more on a new connection when the first one ended under it, while nothing
    /// sent with it changed a row (outside a transaction, or in one that has only begun and read: it is begun again).
    fn unchanging(&mut self, last: Waiting, want: Want) -> Result<Answer, Error> {
        self.ready()?;
        let again = (!self.in_transaction || self.fresh) && self.waiting.iter().all(|waiting| waiting.text == BEGIN);
        let retry = again.then(|| last.clone());
        match self.send(last, want) {
            Err(_) if retry.is_some() && self.ended() => {
                self.open_again()?;
                if self.in_transaction {
                    self.waiting.push(Waiting::plain(BEGIN));
                }
                self.send(retry.unwrap_or_else(|| Waiting::plain("")), want).map_err(|_| crate::cause!(Error::Unavailable))
            }
            sent => sent.map_err(|_| crate::cause!(Error::Unavailable)),
        }
    }

    /// Send what waits (`defer`) and then `last`, and answer `last`'s answer. Through the run's proxy they all go before any
    /// answer is awaited, so the whole lot costs one round trip (and one more the first time a statement is prepared on this
    /// connection); a direct connection sends `last` alone, since nothing waits on it. `Unsent::Before` when a statement
    /// sent before `last` failed (inside a transaction, the database then refuses the rest and a COMMIT answers ROLLBACK).
    fn send(&mut self, last: Waiting, want: Want) -> Result<Answer, Unsent> {
        let Self { inner, statements, waiting, lost, .. } = self;
        // A failure that says the connection is gone (closed, or ended by the database with a FATAL) is known at once, before the
        // driver has seen the connection close.
        let mut gone = |error: &postgres::Error| {
            *lost |= error.is_closed() || error.as_db_error().is_some_and(|db| db.severity() == "FATAL");
        };
        match inner {
            Inner::Sqlite(connection) => match want {
                Want::Rows => {
                    let mut statement = connection.prepare_cached(&last.text).map_err(|_| Unsent::Last)?;
                    let columns = statement.column_count();
                    let bound: Vec<rusqlite::types::Value> = last.params.iter().map(sqlite_value).collect();
                    let mut rows = statement.query(rusqlite::params_from_iter(bound)).map_err(|_| Unsent::Last)?;
                    let mut out = Vec::new();
                    while let Some(row) = rows.next().map_err(|_| Unsent::Last)? {
                        let mut cells = Vec::with_capacity(columns);
                        for at in 0..columns {
                            cells.push(match row.get_ref(at).map_err(|_| Unsent::Last)? {
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
                    Ok(Answer::Rows(out))
                }
                Want::Count => {
                    let bound: Vec<rusqlite::types::Value> = last.params.iter().map(sqlite_value).collect();
                    let mut statement = connection.prepare_cached(&last.text).map_err(|_| Unsent::Last)?;
                    statement.execute(rusqlite::params_from_iter(bound)).map(|changed| Answer::Count(changed as u64)).map_err(|_| Unsent::Last)
                }
                Want::Done => connection.execute_batch(&last.text).map(|()| Answer::Done).map_err(|_| Unsent::Last),
            },
            Inner::Postgres(client) => {
                if want == Want::Done {
                    return client.batch_execute(&last.text).map(|()| Answer::Done).map_err(|error| { gone(&error); Unsent::Last });
                }
                if !statements.contains_key(&last.text) {
                    if statements.len() >= MOST_STATEMENTS {
                        statements.clear();
                    }
                    let prepared = client.prepare(&last.text).map_err(|error| { gone(&error); Unsent::Last })?;
                    statements.insert(last.text.clone(), prepared);
                }
                let statement = &statements[&last.text];
                let bound = postgres_values(&last.params);
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = bound.iter().map(Bound::as_ref).collect();
                match want {
                    Want::Rows => rows_of(client.query(statement, &refs).map_err(|error| { gone(&error); Unsent::Last })?).map(Answer::Rows).map_err(|_| Unsent::Last),
                    _ => client.execute(statement, &refs).map(Answer::Count).map_err(|error| { gone(&error); Unsent::Last }),
                }
            }
            Inner::Tunneled(client) => {
                let mut steps = std::mem::take(waiting);
                steps.push(last);
                let unprepared: Vec<&str> = {
                    let mut texts: Vec<&str> = steps.iter().filter(|step| !step.plain && !statements.contains_key(&step.text)).map(|step| step.text.as_str()).collect();
                    texts.sort_unstable();
                    texts.dedup();
                    texts
                };
                if !unprepared.is_empty() {
                    if statements.len() + unprepared.len() > MOST_STATEMENTS {
                        statements.retain(|text, _| unprepared.contains(&text.as_str()));
                    }
                    for (text, prepared) in unprepared.iter().zip(client.prepare_all(&unprepared)) {
                        statements.insert((*text).to_owned(), prepared.map_err(|error| { gone(&error); Unsent::Before })?);
                    }
                }
                let bound: Vec<Vec<Bound>> = steps.iter().map(|step| postgres_values(&step.params)).collect();
                let lastly = steps.len() - 1;
                let mut asks = Vec::with_capacity(steps.len());
                for (at, (step, values)) in steps.iter().zip(&bound).enumerate() {
                    let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = values.iter().map(Bound::as_ref).collect();
                    asks.push(match (step.plain, at == lastly && want == Want::Rows) {
                        (true, _) => Ask::Simple(&step.text),
                        (false, true) => Ask::Rows(&statements[&step.text], refs),
                        (false, false) => Ask::Count(&statements[&step.text], refs),
                    });
                }
                let mut told = client.send_all(&asks);
                told.iter().filter_map(|told| told.as_ref().err()).for_each(&mut gone);
                let answered = told.pop();
                if told.iter().any(Result::is_err) {
                    return Err(Unsent::Before);
                }
                match answered {
                    Some(Ok(Told::Rows(rows))) => rows_of(rows).map(Answer::Rows).map_err(|_| Unsent::Last),
                    Some(Ok(Told::Count(count))) => Ok(Answer::Count(count)),
                    Some(Ok(Told::Done)) => Ok(Answer::Done),
                    _ => Err(Unsent::Last),
                }
            }
        }
    }

    pub fn dialect(&self) -> Dialect {
        match self.inner {
            Inner::Sqlite(_) => Dialect::Sqlite,
            Inner::Postgres(_) | Inner::Tunneled(_) => Dialect::Postgres,
        }
    }

    /// Where the database is, for a person to read: a file path or `postgres://host:port/name`. Never a user or a password.
    pub fn place(&self) -> &str {
        &self.place
    }

    /// Run a statement that answers rows.
    pub fn query(&mut self, sql: &str, params: &[Cell]) -> Result<Vec<Vec<Cell>>, Error> {
        match self.unchanging(Waiting::bound(numbered(self.dialect(), sql, params), params), Want::Rows)? {
            Answer::Rows(rows) => Ok(rows),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    /// Run a statement that changes rows; answers how many.
    pub fn execute(&mut self, sql: &str, params: &[Cell]) -> Result<u64, Error> {
        self.ready()?;
        self.fresh = false;
        match self.send(Waiting::bound(numbered(self.dialect(), sql, params), params), Want::Count) {
            Ok(Answer::Count(count)) => Ok(count),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    /// Change rows inside the open transaction without awaiting the answer: the statement is sent with the next one that is
    /// awaited, and its failure is that one's (and the commit's: a transaction with a failed statement commits nothing). A
    /// direct connection sends it at once.
    pub fn defer(&mut self, sql: &str, params: &[Cell]) -> Result<(), Error> {
        self.defer_waiting(Waiting::bound(numbered(self.dialect(), sql, params), params))
    }

    /// `defer` for statements with no parameters (a `NOTIFY`).
    pub fn defer_plain(&mut self, sql: &str) -> Result<(), Error> {
        self.defer_waiting(Waiting::plain(sql))
    }

    fn defer_waiting(&mut self, waiting: Waiting) -> Result<(), Error> {
        self.ready()?;
        self.fresh = false;
        if matches!(self.inner, Inner::Tunneled(_)) {
            self.waiting.push(waiting);
            return Ok(());
        }
        let want = if waiting.plain { Want::Done } else { Want::Count };
        self.send(waiting, want).map(|_| ()).map_err(|_| crate::cause!(Error::Unavailable))
    }

    /// Run statements with no parameters (the tables).
    pub fn batch(&mut self, sql: &str) -> Result<(), Error> {
        self.ready()?;
        self.fresh = false;
        self.send(Waiting::plain(sql), Want::Done).map(|_| ()).map_err(|_| crate::cause!(Error::Unavailable))
    }

    /// Listen on `channel` (a Postgres name the caller writes, never a person's value), now and on every new connection.
    pub fn listen(&mut self, channel: &str) -> Result<(), Error> {
        self.batch(&format!("LISTEN {channel}"))?;
        self.channels.push(channel.to_owned());
        Ok(())
    }

    /// Wait for the next notification on a channel this link listens on (`listen`). When the connection ended, it is opened again
    /// and this answers at once, since what was sent meanwhile went unheard; an error when it cannot be opened again. A SQLite
    /// connection hears nothing and answers an error at once.
    pub fn heard(&mut self) -> Result<(), Error> {
        let heard = self.heard_once();
        if heard.is_err() && self.ended() {
            self.open_again()?;
            return Ok(());
        }
        heard
    }

    fn heard_once(&mut self) -> Result<(), Error> {
        match &mut self.inner {
            Inner::Sqlite(_) => Err(Error::Invalid("a SQLite connection hears no notifications", crate::cause!())),
            Inner::Postgres(client) => match postgres::fallible_iterator::FallibleIterator::next(&mut client.notifications().blocking_iter()) {
                Ok(Some(_)) => Ok(()),
                _ => Err(crate::cause!(Error::Unavailable)),
            },
            Inner::Tunneled(client) => client.heard().map_err(unavailable),
        }
    }

    /// Open a transaction that holds the database's one writer from its first statement. Through the run's proxy the `BEGIN`
    /// waits to go with the transaction's first read.
    pub fn begin(&mut self) -> Result<(), Error> {
        self.ready()?;
        match self.dialect() {
            Dialect::Sqlite => self.send(Waiting::plain("BEGIN IMMEDIATE"), Want::Done).map(|_| ()).map_err(|_| crate::cause!(Error::Unavailable))?,
            Dialect::Postgres if matches!(self.inner, Inner::Tunneled(_)) => self.waiting.push(Waiting::plain(BEGIN)),
            Dialect::Postgres => {
                self.unchanging(Waiting::plain(BEGIN), Want::Done)?;
            }
        }
        self.in_transaction = true;
        self.fresh = true;
        Ok(())
    }

    /// Commit, with what waits sent before it. A commit that fails may have been applied, unless a statement before it failed on
    /// a connection that is still open: then the transaction was refused and nothing was applied.
    pub fn commit(&mut self) -> Result<(), Error> {
        self.in_transaction = false;
        self.fresh = false;
        match self.send(Waiting::plain("COMMIT"), Want::Done) {
            Ok(_) => Ok(()),
            Err(Unsent::Before) if !self.ended() => {
                self.rollback();
                Err(crate::cause!(Error::Unavailable))
            }
            Err(_) => Err(crate::cause!(Error::OutcomeUnknown)),
        }
    }

    /// Undo the open transaction, and drop what waits to be sent in it. Nothing to undo is not a failure.
    pub fn rollback(&mut self) {
        self.in_transaction = false;
        self.fresh = false;
        self.waiting.clear();
        let _ = self.send(Waiting::plain("ROLLBACK"), Want::Done);
    }
}

/// The `BEGIN` of a Postgres transaction, as it waits to be sent.
const BEGIN: &str = "BEGIN";
/// The most statements a link keeps prepared on its connection; past it the oldest set is let go and prepared again on use.
const MOST_STATEMENTS: usize = 512;

/// A statement to send: its text (numbered for its dialect) and values, or plain statements with no parameters.
#[derive(Clone)]
struct Waiting {
    text: String,
    params: Vec<Cell>,
    plain: bool,
}
impl Waiting {
    fn plain(text: &str) -> Self {
        Self { text: text.to_owned(), params: Vec::new(), plain: true }
    }
    fn bound(text: String, params: &[Cell]) -> Self {
        Self { text, params: params.to_vec(), plain: false }
    }
}

/// What a sent statement is to answer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    Rows,
    Count,
    Done,
}

enum Answer {
    Rows(Vec<Vec<Cell>>),
    Count(u64),
    Done,
}

/// Which statement of a send failed: one sent before the last, or the last.
enum Unsent {
    Before,
    Last,
}

/// Postgres rows as cells: an `int8` column as a number, every other column as text.
fn rows_of(rows: Vec<postgres::Row>) -> Result<Vec<Vec<Cell>>, Error> {
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
    fn a_connection_string_naming_libpqs_verify_full_is_read_not_refused() {
        // Port 1 on loopback answers nothing: the string was read, and only the connection failed.
        assert!(matches!(Link::postgres("postgresql://someone:pw@127.0.0.1:1/rows?sslmode=verify-full"), Err(Error::Unavailable(..))));
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

    /// A real Postgres server for this test, in a temporary folder, stopped when the test ends; and its connection string.
    fn real_database() -> (postgresql_embedded::blocking::PostgreSQL, String) {
        let mut postgres = postgresql_embedded::blocking::PostgreSQL::new(postgresql_embedded::Settings { timeout: None, ..Default::default() });
        postgres.setup().unwrap();
        postgres.start().unwrap();
        let settings = postgres.settings();
        let connection = format!("postgresql://{}:{}@127.0.0.1:{}/postgres?sslmode=disable", settings.username, settings.password, settings.port);
        (postgres, connection)
    }

    /// End every connection of this program's but the one asking, the way a database restart or a closed tunnel ends them.
    fn end_the_others(connection: &str) {
        let mut other = postgres::Client::connect(connection, postgres::NoTls).unwrap();
        other.batch_execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'live-namespace'").unwrap();
    }

    #[test]
    fn a_link_whose_connection_ended_reads_on_a_new_one_and_never_sends_a_change_twice() {
        let (database, connection) = real_database();
        let mut link = Link::postgres(&connection).unwrap();
        link.batch("CREATE TABLE kept (n int8)").unwrap();
        end_the_others(&connection);
        assert_eq!(link.query("SELECT 7::int8", &[]).unwrap(), vec![vec![Cell::int(7)]]);
        link.begin().unwrap();
        link.execute("INSERT INTO kept VALUES (?)", &[Cell::int(1)]).unwrap();
        end_the_others(&connection);
        assert!(link.execute("INSERT INTO kept VALUES (?)", &[Cell::int(2)]).is_err());
        link.rollback();
        end_the_others(&connection);
        link.begin().unwrap();
        link.execute("INSERT INTO kept VALUES (?)", &[Cell::int(3)]).unwrap();
        link.commit().unwrap();
        assert_eq!(link.query("SELECT n FROM kept", &[]).unwrap(), vec![vec![Cell::int(3)]]);
        let _ = database.stop();
    }

    #[test]
    fn a_listener_whose_connection_ended_listens_again_and_says_it_may_have_missed_one() {
        let (database, connection) = real_database();
        let mut listener = Link::postgres(&connection).unwrap();
        listener.listen("t9_heard").unwrap();
        end_the_others(&connection);
        assert!(listener.heard().is_ok());
        let mut sender = postgres::Client::connect(&connection, postgres::NoTls).unwrap();
        sender.batch_execute("NOTIFY t9_heard").unwrap();
        assert!(listener.heard().is_ok());
        let _ = database.stop();
    }

    /// A link to `connection` through a stand-in proxy of the run (through_the_run_proxy.rs), as a sandboxed run opens it.
    fn tunneled(connection: &str, proxy: &str) -> Link {
        let config: tokio_postgres::Config = connection.parse().unwrap();
        let client = super::super::through_the_run_proxy::Tunneled::open(&config, proxy, tokio_postgres::NoTls).unwrap();
        Link { inner: Inner::Tunneled(Box::new(client)), place: "postgres".into(), reopen: None, in_transaction: false, channels: Vec::new(),
            lost: false, fresh: false, waiting: Vec::new(), statements: Default::default() }
    }

    #[test]
    fn through_the_proxy_waiting_changes_go_with_the_next_statement_and_a_failed_one_commits_nothing() {
        let (database, connection) = real_database();
        let proxy = super::super::through_the_run_proxy::tests::stand_in_proxy("200 Connection established");
        let mut link = tunneled(&connection, &proxy);
        link.batch("CREATE TABLE kept (n int8 PRIMARY KEY)").unwrap();
        link.begin().unwrap();
        assert!(link.query("SELECT n FROM kept", &[]).unwrap().is_empty());
        link.defer("INSERT INTO kept VALUES (?)", &[Cell::int(1)]).unwrap();
        link.defer("INSERT INTO kept VALUES (?)", &[Cell::int(2)]).unwrap();
        assert_eq!(link.waiting.len(), 2);
        assert_eq!(link.query("SELECT count(*)::int8 FROM kept", &[]).unwrap(), vec![vec![Cell::int(2)]]);
        link.defer_plain("NOTIFY t9_kept").unwrap();
        link.commit().unwrap();
        link.begin().unwrap();
        link.defer("INSERT INTO kept VALUES (?)", &[Cell::int(3)]).unwrap();
        link.defer("INSERT INTO kept VALUES (?)", &[Cell::int(1)]).unwrap();
        assert!(matches!(link.commit(), Err(Error::Unavailable(_))));
        assert_eq!(link.query("SELECT n FROM kept ORDER BY n", &[]).unwrap(), vec![vec![Cell::int(1)], vec![Cell::int(2)]]);
        let _ = database.stop();
    }
}
