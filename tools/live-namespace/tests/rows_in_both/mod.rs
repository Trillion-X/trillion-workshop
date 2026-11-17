// tests/rows_in_both/mod.rs
//
// Purpose: The person's rows in each database the store supports, for tests that must hold in both: SQLite (a database in memory)
// and Postgres (a real server this test binary starts once in a temporary folder, each test in its own new database). Synthetic data
// only.

#![allow(dead_code)]

use live_namespace::store::{link::Link, SqlStore};
use postgresql_embedded::{blocking::PostgreSQL, Settings, BOOTSTRAP_DATABASE};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
};

static SERVER: OnceLock<(PostgreSQL, u16, String, String)> = OnceLock::new();

/// Stops the server when the binary ends: a static is never dropped, and a server left running holds one of the computer's few
/// shared memory segments until no new server can start.
extern "C" fn stop_server() {
    if let Some((postgres, ..)) = SERVER.get() {
        let _ = postgres.stop();
    }
}

/// The one Postgres server of this test binary, started at its first use and stopped when the binary ends.
fn server() -> &'static (PostgreSQL, u16, String, String) {
    SERVER.get_or_init(|| {
        // No command is cut short by a time of the harness's own (a first run unpacks the archive).
        let mut postgres = PostgreSQL::new(Settings { timeout: None, ..Settings::default() });
        postgres.setup().expect("the embedded Postgres is set up");
        postgres.start().expect("the embedded Postgres starts");
        // SAFETY: stop_server is a plain function that only reads a set OnceLock.
        assert_eq!(unsafe { libc::atexit(stop_server) }, 0, "the server's stop is registered for the binary's end");
        let settings = postgres.settings();
        let (port, user, password) = (settings.port, settings.username.clone(), settings.password.clone());
        (postgres, port, user, password)
    })
}

/// The connection string of one database of the embedded server.
fn connection(database: &str) -> String {
    let (_, port, user, password) = server();
    format!("postgresql://{user}:{password}@127.0.0.1:{port}/{database}")
}

/// The connection string of a new, empty database of the embedded server.
pub fn new_database() -> String {
    static MADE: AtomicUsize = AtomicUsize::new(0);
    let database = format!("rows_{}_{}", std::process::id(), MADE.fetch_add(1, Ordering::SeqCst));
    // The database is made over the store's own driver: the server's packaged time zones lack the one the harness's own client sets.
    Link::postgres(&connection(BOOTSTRAP_DATABASE)).expect("the embedded Postgres answers").batch(&format!("CREATE DATABASE {database}")).expect("a new database");
    connection(&database)
}

/// A connection to a new, empty database of the embedded server.
pub fn postgres_link() -> Link {
    Link::postgres(&new_database()).expect("the embedded Postgres answers")
}

/// The same store opened twice, each over its own connection and hearing the other's commits, as two processes open it.
pub fn postgres_pair() -> (SqlStore, SqlStore) {
    let database = new_database();
    let link = || Link::postgres(&database).expect("the embedded Postgres answers");
    (SqlStore::open(link()).unwrap().hearing(link()).unwrap(), SqlStore::open(link()).unwrap().hearing(link()).unwrap())
}

/// A store over each database: (its name, the store).
pub fn both() -> Vec<(&'static str, SqlStore)> {
    vec![("sqlite", SqlStore::memory().unwrap()), ("postgres", SqlStore::open(postgres_link()).unwrap())]
}
