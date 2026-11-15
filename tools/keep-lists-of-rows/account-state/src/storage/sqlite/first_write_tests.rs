// Purpose: `first_write.rs` over a real SQLite connection: a declared table that does not exist is made by its first
// write, reads as empty until then, and every invariant in the module's header holds. Ported one to one from old
// trillion `test/schema-on-first-write.test.mjs` (8 tests, same names).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{exec_raw, Answer, FirstWrite};
use rusqlite::{types::Value as V, Connection};

fn tables_of(db: &Connection) -> Vec<String> {
    let mut statement = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap();
    statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
}
fn t(text: &str) -> V {
    V::Text(text.into())
}
fn column(rows: &[Answer], name: &str) -> Vec<V> {
    rows.iter().map(|row| row.iter().find(|(n, _)| n == name).unwrap().1.clone()).collect()
}
fn one(rows: &[Answer], name: &str) -> V {
    assert_eq!(rows.len(), 1);
    column(rows, name).remove(0)
}
fn declare(sql: &FirstWrite<'_>) {
    sql.exec(r#"CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, title TEXT NOT NULL, "the size" INTEGER, UNIQUE(title, id))"#, &[]).unwrap();
    sql.exec("CREATE INDEX IF NOT EXISTS items_by_title ON items(title)", &[]).unwrap();
    sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL DEFAULT '')", &[]).unwrap();
}

#[test]
fn a_declared_table_is_made_by_its_first_write_with_its_indexes_and_reads_as_empty_until_then() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    assert!(tables_of(&db).is_empty(), "declaring writes nothing");
    assert!(sql.exec(r#"SELECT id, title, "the size", rowid FROM items WHERE title = ?"#, &[t("a")]).unwrap().is_empty());
    assert_eq!(one(&sql.exec("SELECT count(*) AS n FROM items INDEXED BY items_by_title WHERE title > ?", &[t("")]).unwrap(), "n"), V::Integer(0));
    assert!(sql.exec("WITH wanted(t) AS (SELECT ?) SELECT i.id FROM items i JOIN wanted ON wanted.t = i.title", &[t("a")]).unwrap().is_empty());
    assert!(sql.exec("UPDATE items SET title = ? WHERE id = ?", &[t("b"), t("x")]).unwrap().is_empty());
    assert!(sql.exec("DELETE FROM items WHERE id = ?", &[t("x")]).unwrap().is_empty());
    assert!(tables_of(&db).is_empty(), "reads, updates and deletes of an empty table make nothing");
    sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", &[t("a"), t("Alpha")]).unwrap();
    assert_eq!(tables_of(&db), ["items", "items_by_title"], "the write made its table and indexes, not the other table");
    let rows = sql.exec("SELECT id, title FROM items INDEXED BY items_by_title WHERE title = ?", &[t("Alpha")]).unwrap();
    assert_eq!(rows, vec![vec![("id".to_string(), t("a")), ("title".to_string(), t("Alpha"))]]);
    sql.exec("INSERT INTO notes (body) SELECT title FROM items", &[]).unwrap();
    assert_eq!(column(&sql.exec("SELECT body FROM notes", &[]).unwrap(), "body"), [t("Alpha")]);
}

#[test]
fn an_insert_reading_another_declared_table_reads_it_as_empty_and_makes_only_its_target() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    sql.exec("INSERT INTO notes (body) SELECT title FROM items WHERE id = ?", &[t("none")]).unwrap();
    assert_eq!(tables_of(&db), ["notes"]);
    assert_eq!(one(&sql.exec("SELECT count(*) AS n FROM notes", &[]).unwrap(), "n"), V::Integer(0));
}

#[test]
fn a_table_that_exists_is_never_kept_its_declaration_runs_and_its_rows_are_read() {
    let db = Connection::open_in_memory().unwrap();
    exec_raw(&db, "CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL)", &[]).unwrap();
    exec_raw(&db, "INSERT INTO items VALUES ('a', 'Alpha')", &[]).unwrap();
    let sql = FirstWrite::over(&db);
    sql.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, title TEXT NOT NULL)", &[]).unwrap();
    sql.exec("CREATE INDEX IF NOT EXISTS items_by_title ON items(title)", &[]).unwrap();
    assert!(tables_of(&db).contains(&"items_by_title".to_string()), "an index of an existing table is made at once");
    assert_eq!(column(&sql.exec("SELECT title FROM items", &[]).unwrap(), "title"), [t("Alpha")]);
}

#[test]
fn a_statement_that_reads_the_schema_sees_the_declared_table_it_is_made_first() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    let names = column(&sql.exec("SELECT name FROM pragma_table_info(?) ORDER BY cid", &[t("items")]).unwrap(), "name");
    assert_eq!(names, [t("id"), t("title"), t("the size")]);
    assert!(tables_of(&db).contains(&"items".to_string()));
    assert_eq!(one(&sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes'", &[]).unwrap(), "n"), V::Integer(1));
    sql.exec("ALTER TABLE notes ADD COLUMN extra TEXT", &[]).unwrap();
    assert!(column(&sql.exec("SELECT name FROM pragma_table_info(?)", &[t("notes")]).unwrap(), "name").contains(&t("extra")));
}

#[test]
fn a_read_that_lists_the_tables_sees_every_declared_table_all_of_them_are_made() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    let listed = column(&sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", &[]).unwrap(), "name");
    assert_eq!(listed, [t("items"), t("notes")]);
    assert_eq!(tables_of(&db), ["items", "items_by_title", "notes"]);
}

#[test]
fn a_read_of_the_schema_makes_only_the_declared_tables_it_would_list() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    assert!(sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", &[t("elsewhere")]).unwrap().is_empty());
    assert!(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'record_layer_*'", &[]).unwrap().is_empty());
    assert!(tables_of(&db).is_empty(), "a lookup of another name and a pattern matching no declared table make nothing");
    let indexed = column(&sql.exec("SELECT tbl_name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'items_%'", &[]).unwrap(), "tbl_name");
    assert_eq!(indexed, [t("items")]);
    assert_eq!(tables_of(&db), ["items", "items_by_title"], "the listed table is made with its indexes, the other is not");
    assert_eq!(
        one(&sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'", &[]).unwrap(), "n"),
        V::Integer(2),
        "an answer naming no table makes every declared table"
    );
    assert_eq!(tables_of(&db), ["items", "items_by_title", "notes"]);
}

#[test]
fn a_table_taken_back_by_a_rollback_is_made_again_by_the_next_statement_that_needs_it() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    db.execute_batch("BEGIN").unwrap();
    sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", &[t("a"), t("Alpha")]).unwrap();
    db.execute_batch("ROLLBACK").unwrap();
    assert!(tables_of(&db).is_empty(), "the rollback took the table back");
    assert!(sql.exec("SELECT id FROM items", &[]).unwrap().is_empty(), "a read of it does not fail");
    sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", &[t("b"), t("Beta")]).unwrap();
    assert_eq!(column(&sql.exec("SELECT id FROM items INDEXED BY items_by_title", &[]).unwrap(), "id"), [t("b")]);
}

#[test]
fn dropping_a_kept_table_forgets_it_declaring_again_keeps_it_again_one_seam_per_connection() {
    let db = Connection::open_in_memory().unwrap();
    let sql = FirstWrite::over(&db);
    declare(&sql);
    sql.exec("DROP TABLE IF EXISTS items", &[]).unwrap();
    let refused = sql.exec("SELECT id FROM items", &[]).unwrap_err().to_string();
    assert!(refused.contains("no such table: items"), "{refused}");
    declare(&sql);
    // The old test wrapped the seam twice and saw the same object: here a seam is only ever made over a connection
    // (`FirstWrite::over(&Connection)`), so the same declarations stay with the one seam.
    assert!(sql.waiting());
    assert!(sql.exec("SELECT id FROM items", &[]).unwrap().is_empty());
    assert!(tables_of(&db).is_empty());
}
