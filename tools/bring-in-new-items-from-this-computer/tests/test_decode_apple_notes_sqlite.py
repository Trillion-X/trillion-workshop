import gzip
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys


TOOL = Path(__file__).parents[1]
SCRIPT = TOOL / "do-work/process-scripts/decode-apple-notes-sqlite.py"
spec = importlib.util.spec_from_file_location("decode_apple_notes_sqlite", SCRIPT)
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)


def varint(value):
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def field(number, value):
    raw = value.encode() if isinstance(value, str) else value
    return varint((number << 3) | 2) + varint(len(raw)) + raw


def note_blob(text):
    return gzip.compress(field(1, field(3, field(2, text))))


def selected_blob(text, *, compressed=True):
    # Native path: root field 2 -> document field 3 -> text field 2.
    decoy = field(7, b"long printable decoy that is not the note text")
    raw = field(2, decoy + field(3, field(9, b"nested decoy") + field(2, text)))
    return gzip.compress(raw) if compressed else raw


def selected_db(path):
    connection = sqlite3.connect(path)
    connection.executescript(
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE TEXT, ZMODIFICATIONDATE1 REAL, ZNOTEDATA INTEGER, ZFOLDER INTEGER, ZMARKEDFORDELETION INTEGER, ZISPASSWORDPROTECTED INTEGER, ZFOLDERTYPE INTEGER);"
        "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);"
    )
    connection.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1,'folder',NULL,NULL,NULL,NULL,NULL,0,0,0)")
    connection.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (2,'trash-folder',NULL,NULL,NULL,NULL,NULL,0,0,1)")
    records = [
        (10, "accept", "  exact title  ", 1, 0, 0, 101, selected_blob("  Éxact\n body\t ")),
        (11, "held", "secret title", 1, 0, 0, 102, selected_blob("body")),
        (12, "deleted", "Deleted", 1, 1, 0, 103, selected_blob("must not read")),
        (13, "trash", "Trash", 2, 0, 0, 104, selected_blob("must not read")),
        (14, "no-folder", "No folder", 999, 0, 0, 105, selected_blob("must not read")),
        (15, "no-body", "No body", 1, 0, 0, None, None),
        (16, "too-large", "Too large", 1, 0, 0, 106, selected_blob("x" * 100_001, compressed=False)),
        (17, "locked", "Locked", 1, 0, 1, 107, selected_blob("must not read")),
        (18, "content-held", "Clean title", 1, 0, 0, 108, selected_blob("contains secret phrase")),
    ]
    for pk, ident, title, folder, deleted, locked, body_ref, blob in records:
        if blob is not None:
            connection.execute("INSERT INTO ZICNOTEDATA VALUES (?,?)", (body_ref, blob))
        connection.execute(
            "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pk, ident, title, None, 700000000, body_ref, folder, deleted, locked, None),
        )
    connection.commit()
    connection.close()


def selected_request(database, ids):
    return {
        "mode": "selected_private_snapshot", "database_path": str(database),
        "selected_ids": ids, "caller_text_hold_patterns": ["secret"],
        "max_blob_bytes": 100000, "max_text_bytes": 1000,
    }


def test_note_store_is_read_only_and_emits_revisioned_canonical_atoms(tmp_path):
    database = tmp_path / "NoteStore.sqlite"
    connection = sqlite3.connect(database)
    connection.executescript(
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE TEXT, ZMODIFICATIONDATE1 REAL, ZNOTEDATA INTEGER);"
        "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);"
    )
    connection.execute("INSERT INTO ZICNOTEDATA VALUES (?, ?)", (7, note_blob("Exact note body")))
    connection.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (?, ?, ?, ?, ?, ?)", (3, "note-stable-id", "Exact title", None, 700000000, 7))
    connection.commit()
    connection.close()

    before = database.read_bytes()
    observation = {
        "source_ref": "source:apple-notes",
        "native_ref": str(database),
        "batch_ref": "batch:one",
        "observed_at": "2026-09-10T00:00:00Z",
        "content_multihash": "1f:revision-one",
    }
    result = decoder.decode(observation, {"source_ref": "source:apple-notes"})
    assert database.read_bytes() == before
    assert len(result["threads"]) == 1
    assert result["threads"][0]["session_id"] == "note-stable-id"
    assert result["threads"][0]["presentation"]["title"] == "Exact title"
    assert len(result["atoms"]) == 1
    assert result["atoms"][0]["content"]["text"] == "Exact note body"


def test_missing_or_invalid_store_fails_as_a_structured_rejection(tmp_path):
    result = decoder.decode(
        {"source_ref": "source:apple-notes", "native_ref": str(tmp_path / "missing.sqlite")},
        {"source_ref": "source:apple-notes"},
    )
    assert result["threads"] == []
    assert result["atoms"] == []
    assert result["rejections"][0]["violation_path"] == "native_ref"


def test_committed_wal_revision_is_visible_without_mutating_any_store_file(tmp_path):
    database = tmp_path / "NoteStore.sqlite"
    writer = sqlite3.connect(database)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.executescript(
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE TEXT, ZMODIFICATIONDATE1 REAL, ZNOTEDATA INTEGER);"
        "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);"
    )
    writer.commit()
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.execute("INSERT INTO ZICNOTEDATA VALUES (?, ?)", (7, note_blob("Current WAL body")))
    writer.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (?, ?, ?, ?, ?, ?)", (3, "wal-note-id", "Current WAL title", None, 700000000, 7))
    writer.commit()

    # SQLite may update transient reader-lock bytes in -shm while opening a WAL
    # snapshot. The durable personal store is the main database plus WAL; both
    # must remain byte-identical.
    paths = [database, Path(str(database) + "-wal")]
    before = {path: path.read_bytes() for path in paths}
    result = decoder.decode(
        {
            "source_ref": "source:apple-notes",
            "native_ref": str(database) + "-wal",
            "batch_ref": "batch:wal-revision",
            "content_multihash": "1f:wal-revision",
        },
        {"source_ref": "source:apple-notes"},
    )
    after = {path: path.read_bytes() for path in paths}
    writer.close()

    assert before == after
    assert result["threads"][0]["session_id"] == "wal-note-id"
    assert result["atoms"][0]["content"]["text"] == "Current WAL body"


def test_sidecar_observations_collapse_to_one_stable_store_revision():
    sys.path.insert(0, str(TOOL.parent / "conversations" / "read-data"))
    from content_identity import content_hash

    observations = [
        {"native_ref": "/notes/NoteStore.sqlite", "content_multihash": "1f:main"},
        {"native_ref": "/notes/NoteStore.sqlite-wal", "content_multihash": "1f:wal"},
        {"native_ref": "/notes/NoteStore.sqlite-shm", "content_multihash": "1f:shm"},
    ]
    combined = decoder._one_store_observation(observations)
    replay = decoder._one_store_observation(list(reversed(observations)))
    changed = decoder._one_store_observation([
        observations[0],
        {"native_ref": "/notes/NoteStore.sqlite-wal", "content_multihash": "1f:changed"},
        observations[2],
    ])

    assert combined["native_ref"] == "/notes/NoteStore.sqlite"
    assert combined["content_multihash"] == content_hash(json.dumps(sorted(
        (row["native_ref"], row["content_multihash"]) for row in observations
    ), separators=(",", ":")).encode("utf-8"))
    assert combined["content_multihash"] == replay["content_multihash"]
    assert changed["content_multihash"] != combined["content_multihash"]


def test_selected_snapshot_preserves_exact_text_and_excludes_before_body_fetch(tmp_path, monkeypatch):
    database = tmp_path / "selected.sqlite"
    selected_db(database)
    seen = []
    original_connect = decoder.sqlite3.connect

    def traced_connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        connection.set_trace_callback(seen.append)
        return connection

    monkeypatch.setattr(decoder.sqlite3, "connect", traced_connect)
    result = decoder.selected_private_snapshot(selected_request(
        database, ["accept", "held", "deleted", "trash", "no-folder", "no-body", "too-large", "locked", "content-held"]
    ))
    assert result["rows"] == [
        {"selected_id": "accept", "status": "accepted", "title": "  exact title  ",
         "text": "  Éxact\n body\t ", "modified_at": "2023-03-08T20:26:40+00:00"},
        {"selected_id": "held", "status": "held"},
        {"selected_id": "deleted", "status": "marked_deleted"},
        {"selected_id": "trash", "status": "folder_type_excluded"},
        {"selected_id": "no-folder", "status": "folder_missing"},
        {"selected_id": "no-body", "status": "null_body_ref"},
        {"selected_id": "too-large", "status": "blob_over_limit"},
        {"selected_id": "locked", "status": "locked"},
        {"selected_id": "content-held", "status": "held"},
    ]
    body_fetches = [q for q in seen if "SELECT ZDATA FROM ZICNOTEDATA" in q]
    assert len(body_fetches) == 3
    assert {q.rsplit("=", 1)[-1] for q in body_fetches} == {"101", "102", "108"}
    serialized = json.dumps(result)
    assert "secret title" not in serialized and "must not read" not in serialized
    assert "secret phrase" not in serialized


def test_selected_snapshot_missing_and_duplicate_ids_fail_closed(tmp_path):
    database = tmp_path / "selected.sqlite"
    selected_db(database)
    for ids in (["missing"], ["accept", "accept"]):
        request = selected_request(database, ids)
        try:
            decoder.selected_private_snapshot(request)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid selection accepted")


def test_selected_protobuf_is_exact_and_rejects_duplicates_wrappers_and_bad_gzip():
    assert decoder.extract_selected_text(selected_blob("  spaced  ", compressed=False), 100) == "  spaced  "
    for blob in (
        gzip.compress(field(1, field(3, field(2, "toy wrapper")))),
        gzip.compress(field(2, field(3, field(2, "first") + field(2, "second")))),
        gzip.compress(field(2, field(3, field(2, b"\xff")))),
        gzip.compress(field(2, field(3, field(2, "ok")))) + b"trailing",
        b"\x1f\x8btruncated",
        gzip.compress(b"\x00"),
        gzip.compress(b"\x0b"),
        gzip.compress(b"\x12\x05abc"),
        gzip.compress(b"\x80\x00"),
    ):
        try:
            decoder.extract_selected_text(blob, 100)
        except Exception:
            pass
        else:
            raise AssertionError("invalid native body accepted")


def test_selected_snapshot_reads_coherent_wal_without_mutating_database_or_wal(tmp_path):
    database = tmp_path / "wal.sqlite"
    writer = sqlite3.connect(database)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.executescript(
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE TEXT, ZMODIFICATIONDATE1 REAL, ZNOTEDATA INTEGER, ZFOLDER INTEGER, ZMARKEDFORDELETION INTEGER, ZISPASSWORDPROTECTED INTEGER, ZFOLDERTYPE INTEGER);"
        "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);"
    )
    writer.commit()
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1,'folder',NULL,NULL,NULL,NULL,NULL,0,0,0)")
    writer.execute("INSERT INTO ZICNOTEDATA VALUES (7,?)", (selected_blob("WAL Ω"),))
    writer.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (3,'wal-id','WAL title',NULL,700000000,7,1,0,0,NULL)")
    writer.commit()
    paths = [database, Path(str(database) + "-wal")]
    before = {path: path.read_bytes() for path in paths}
    request = selected_request(database, ["wal-id"])
    result = decoder.selected_private_snapshot(request)
    after = {path: path.read_bytes() for path in paths}
    writer.close()
    assert before == after
    assert result["rows"][0]["text"] == "WAL Ω"


def test_cli_private_output_is_create_only_and_mode_0600(tmp_path):
    database = tmp_path / "selected.sqlite"
    selected_db(database)
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(selected_request(database, ["accept"])))
    request_path.chmod(0o600)
    output = tmp_path / "result.json"
    decoder._private_output(output, b"{}", request_path, database)
    assert output.stat().st_mode & 0o777 == 0o600
    try:
        decoder._private_output(output, b"changed", request_path, database)
    except FileExistsError:
        pass
    else:
        raise AssertionError("output was overwritten")
    sidecar = Path(str(database) + "-wal")
    sidecar.write_bytes(b"existing wal sidecar")
    try:
        decoder._private_output(sidecar, b"{}", request_path, database)
    except ValueError:
        pass
    else:
        raise AssertionError("output aliasing the database WAL was accepted")


def test_private_request_input_rejects_symlinks_and_broad_permissions(tmp_path):
    source = tmp_path / "request.json"
    source.write_text("{}")
    source.chmod(0o600)
    assert decoder._require_private_regular(source, 100) == b"{}"
    broad = tmp_path / "broad.json"
    broad.write_text("{}")
    broad.chmod(0o644)
    for path in (broad, tmp_path / "link.json"):
        if path.name == "link.json":
            path.symlink_to(source)
        try:
            decoder._require_private_regular(path, 100)
        except (OSError, ValueError):
            pass
        else:
            raise AssertionError("unsafe request input accepted")
