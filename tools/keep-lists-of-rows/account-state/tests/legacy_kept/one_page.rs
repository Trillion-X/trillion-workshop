//! Generic one-page binary-search base case using real pinned SQLite.
use super::*;

#[test]
fn one_page_exact_before_first_and_missing_key_use_one_indexed_boundary_key() {
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[("middle", r#"[["middle",1],["z",2]]"#.into())],
            0,
            0,
        );
        db.execute("UPDATE record_keys_runs SET last='\"z\"'", [])
            .unwrap();
    });
    for (key, expected, bodies) in [
        ("a", Entry::Absent, 0),
        ("middle", Entry::Json("1".into()), 1),
        ("n", Entry::Absent, 1),
    ] {
        let mut source = CountedSource::new(&f);
        let got = reader().point(&mut source, key).unwrap();
        assert_eq!(got.entry, expected);
        assert_eq!(source.serial_boundary_keys, 1);
        assert_eq!(got.work.page_bodies, bodies);
        assert_eq!(source.queries as u64, got.work.sql_statements);
    }
}

#[test]
fn one_page_uses_exact_utf16_order_without_fetching_a_wrong_body() {
    // JavaScript orders the astral key before this BMP key; UTF-8 orders it
    // after. A before-first lookup must not decode this deliberately bad body.
    let bmp = "\u{e000}";
    let f = fixture(|db| run(db, 1, 1, &[(bmp, "invalid body".into())], 0, 1));
    let mut source = CountedSource::new(&f);
    let got = reader().point(&mut source, "\u{10000}").unwrap();
    assert_eq!(got.entry, Entry::Absent);
    assert_eq!(source.serial_boundary_keys, 1);
    assert!(source.bodies.is_empty());
}

#[test]
fn one_page_missing_corrupt_duplicate_and_oversized_boundary_keys_refuse() {
    for damage in ["missing", "nontext", "nonstring", "duplicate", "oversized"] {
        let f = fixture(|db| {
            run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1);
            match damage {
                "missing" => {
                    db.execute("DELETE FROM record_keys_run_1", []).unwrap();
                }
                "nontext" => {
                    db.execute("UPDATE record_keys_run_1 SET first=x'FF'", [])
                        .unwrap();
                }
                "nonstring" => {
                    db.execute("UPDATE record_keys_run_1 SET first='123'", [])
                        .unwrap();
                }
                "duplicate" => {
                    db.execute_batch("ALTER TABLE record_keys_run_1 RENAME TO old_pages;CREATE TABLE record_keys_run_1(page INTEGER,first TEXT,body TEXT);INSERT INTO record_keys_run_1 SELECT * FROM old_pages;INSERT INTO record_keys_run_1 SELECT * FROM old_pages;").unwrap();
                }
                "oversized" => {
                    db.execute(
                        "UPDATE record_keys_run_1 SET first=?",
                        [serde_json::to_string(&"k".repeat(20_000)).unwrap()],
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
        });
        let mut source = CountedSource::new(&f);
        assert!(
            reader().point(&mut source, "key").is_err(),
            "must refuse {damage}"
        );
        assert_eq!(source.serial_boundary_keys, 1);
        assert!(source.bodies.is_empty());
    }
}

#[test]
fn multiple_pages_keep_general_seek_and_correct_selected_body() {
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[
                ("a", packed("a", "1")),
                ("m", packed("m", "2")),
                ("z", packed("z", "3")),
            ],
            0,
            1,
        )
    });
    for (key, expected, page) in [("a", "1", 0), ("m", "2", 1), ("z", "3", 2)] {
        let mut source = CountedSource::new(&f);
        let got = reader().point(&mut source, key).unwrap();
        assert_eq!(got.entry, Entry::Json(expected.into()));
        assert_eq!(
            source.serial_boundary_keys, 0,
            "ordinary multi-page path is unchanged"
        );
        assert_eq!(source.bodies, [page]);
    }
}
