#!/usr/bin/env python3
"""Read Apple NoteStore.sqlite without mutating the personal source store."""

import datetime
import gzip
import json
import os
import pathlib
import re
import stat
import sqlite3
import sys
import zlib

APPLE_EPOCH = 978307200
MAX_SELECTED_IDS = 1000
MAX_BLOB_LIMIT = 8 * 1024 * 1024
MAX_TEXT_LIMIT = 4 * 1024 * 1024
MAX_TOTAL_BLOB_BYTES = 64 * 1024 * 1024
MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024
MAX_REQUEST_BYTES = 1024 * 1024


def _varint(data, offset):
    value = 0
    shift = 0
    for index in range(10):
        if offset >= len(data):
            raise ValueError("truncated protobuf")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            if index > 0 and byte == 0:
                raise ValueError("invalid protobuf")
            if index == 9 and byte > 1:
                raise ValueError("invalid protobuf")
            return value, offset
        shift = (index + 1) * 7
    raise ValueError("invalid protobuf")


def _fields(data):
    """Strictly parse a protobuf message into its (field number, wire, value) tuples."""
    fields = []
    offset = 0
    while offset < len(data):
        tag, offset = _varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0 or number > 0x1FFFFFFF or wire in (3, 4, 6, 7):
            raise ValueError("unsupported protobuf")
        if wire == 0:
            value, offset = _varint(data, offset)
        elif wire == 1:
            end = offset + 8
            if end > len(data):
                raise ValueError("truncated protobuf")
            value, offset = data[offset:end], end
        elif wire == 2:
            length, offset = _varint(data, offset)
            end = offset + length
            if end > len(data):
                raise ValueError("truncated protobuf")
            value, offset = data[offset:end], end
        else:  # wire 5
            end = offset + 4
            if end > len(data):
                raise ValueError("truncated protobuf")
            value, offset = data[offset:end], end
        fields.append((number, wire, value))
    return fields


def _one_bytes_field(data, number):
    matches = [(wire, value) for field_number, wire, value in _fields(data)
               if field_number == number]
    if len(matches) != 1:
        raise ValueError("ambiguous protobuf path")
    wire, value = matches[0]
    if wire != 2:
        raise ValueError("invalid protobuf path")
    return value


def _bounded_gzip(blob, max_text_bytes):
    # zlib exposes end-of-member and unused trailing bytes, unlike gzip.decompress.
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = inflater.decompress(blob, max_text_bytes + 1)
    if len(out) > max_text_bytes or inflater.unconsumed_tail:
        raise ValueError("text exceeds limit")
    out += inflater.flush(max_text_bytes + 1 - len(out))
    if len(out) > max_text_bytes or not inflater.eof or inflater.unused_data:
        raise ValueError("invalid gzip")
    return out


def extract_selected_text(blob, max_text_bytes):
    if not isinstance(blob, bytes) or not blob:
        raise ValueError("empty body")
    decoded = _bounded_gzip(blob, max_text_bytes) if blob.startswith(b"\x1f\x8b") else blob
    if len(decoded) > max_text_bytes:
        raise ValueError("text exceeds limit")
    root = _one_bytes_field(decoded, 2)
    document = _one_bytes_field(root, 3)
    raw_text = _one_bytes_field(document, 2)
    return raw_text.decode("utf-8", errors="strict")


def _read_regular(path, limit, *, private=False):
    path = pathlib.Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("regular file required")
    if private:
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("private regular file required")
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) & 0o077:
            raise ValueError("private parent directory required")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        current = os.fstat(fd)
        if not stat.S_ISREG(current.st_mode) or current.st_ino != info.st_ino or current.st_dev != info.st_dev:
            raise ValueError("input changed")
        if current.st_size > limit:
            raise ValueError("input exceeds limit")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > limit:
            raise ValueError("input exceeds limit")
        return raw
    finally:
        os.close(fd)


def _require_private_regular(path, limit):
    return _read_regular(path, limit, private=True)


def _private_output(path, payload, request_path, database_path):
    target = pathlib.Path(path)
    parent = target.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent_info = parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or stat.S_IMODE(parent_info.st_mode) & 0o077:
        raise ValueError("private output directory required")
    target_abs = target.absolute()
    candidates = [pathlib.Path(request_path), pathlib.Path(database_path)]
    candidates.extend(pathlib.Path(str(database_path) + suffix) for suffix in ("-wal", "-shm"))
    for candidate in candidates:
        if target_abs == candidate.absolute():
            raise ValueError("output aliases input")
        try:
            target_info, candidate_info = target.lstat(), candidate.lstat()
        except FileNotFoundError:
            continue
        if (target_info.st_dev, target_info.st_ino) == (candidate_info.st_dev, candidate_info.st_ino):
            raise ValueError("output aliases input")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(target, flags, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def _text_fields(data, depth=0):
    if depth > 8:
        return []
    found = []
    offset = 0
    while offset < len(data):
        try:
            tag, offset = _varint(data, offset)
            wire = tag & 7
            if wire == 0:
                _, offset = _varint(data, offset)
            elif wire == 1:
                offset += 8
            elif wire == 2:
                length, offset = _varint(data, offset)
                end = offset + length
                if end > len(data):
                    break
                field = data[offset:end]
                offset = end
                try:
                    text = field.decode("utf-8")
                    printable = sum(ch.isprintable() or ch in "\n\r\t" for ch in text)
                    if text and printable / len(text) > 0.9:
                        found.append(text)
                except UnicodeDecodeError:
                    pass
                found.extend(_text_fields(field, depth + 1))
            elif wire == 5:
                offset += 4
            else:
                break
        except (ValueError, IndexError):
            break
    return found


def extract_note_text(blob):
    if not blob:
        return ""
    try:
        decoded = gzip.decompress(blob)
    except (OSError, EOFError):
        return ""
    candidates = _text_fields(decoded)
    return max(candidates, key=len, default="").strip()


def _open_read_only(path):
    # NoteStore is an actively written WAL database. `immutable=1` tells SQLite
    # that no writer can exist and may therefore hide committed rows that are
    # still in NoteStore.sqlite-wal. `mode=ro` plus query_only preserves the
    # personal store while retaining SQLite's own coherent main+WAL view.
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _store_path(native_ref):
    """Map a main/WAL/SHM observation to the one stable NoteStore identity."""
    text = str(native_ref or "")
    for suffix in ("-wal", "-shm"):
        if text.endswith(suffix):
            return text[:-len(suffix)]
    return text


def _mount_conversations_owner():
    """content_identity.py and transcript_mapper.py are owned by the conversations tool: mount that folder, never copy it."""
    folder = str(pathlib.Path(__file__).resolve().parents[3] / "conversations" / "read-data")
    if folder not in sys.path:
        sys.path.insert(0, folder)


def _one_store_observation(observations):
    """Collapse one store's sidecar observations into one revisioned event."""
    _mount_conversations_owner()
    from content_identity import content_hash

    first = dict(observations[0])
    main = _store_path(first.get("native_ref"))
    revision_parts = sorted(
        (str(item.get("native_ref") or ""), str(item.get("content_multihash") or ""))
        for item in observations
    )
    first["native_ref"] = main
    first["content_multihash"] = content_hash(
        json.dumps(revision_parts, separators=(",", ":")).encode("utf-8")
    )
    return first


def decode(observation, descriptor):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    _mount_conversations_owner()
    import transcript_mapper as tm

    source_ref = observation.get("source_ref") or descriptor.get("source_ref") or "source:apple-notes"
    native_ref = _store_path(observation.get("native_ref"))
    rejection = lambda reason: {"threads": [], "atoms": [], "rejections": [{
        "source_ref": source_ref, "violation_path": "native_ref", "expected": "readable Apple NoteStore.sqlite", "got": reason,
    }]}
    if not native_ref:
        return rejection("missing")
    try:
        connection = _open_read_only(native_ref)
        rows = connection.execute(
            "SELECT COALESCE(o.ZIDENTIFIER, CAST(o.Z_PK AS TEXT)), "
            "COALESCE(o.ZTITLE1, o.ZTITLE, 'Untitled'), o.ZMODIFICATIONDATE1, d.ZDATA "
            "FROM ZICCLOUDSYNCINGOBJECT o JOIN ZICNOTEDATA d ON d.Z_PK=o.ZNOTEDATA "
            "WHERE d.ZDATA IS NOT NULL AND (o.ZTITLE1 IS NOT NULL OR o.ZTITLE IS NOT NULL)"
        ).fetchall()
        connection.close()
    except (sqlite3.Error, OSError) as error:
        return rejection(str(error))

    specs = []
    for identity, title, modified, blob in rows:
        text = extract_note_text(blob)
        if not text:
            continue
        at = None
        if modified is not None:
            at = datetime.datetime.fromtimestamp(float(modified) + APPLE_EPOCH, datetime.timezone.utc).isoformat()
        specs.append({
            "session_id": str(identity),
            "title": str(title),
            "messages": [{"index": 0, "native_ref": str(identity), "speaker": "me", "text": text, "at": at, "kind": "note"}],
        })
    result = tm.map_transcript(observation, descriptor, specs)
    result["rejections"] = result.get("rejections", [])
    return result


def selected_private_snapshot(request):
    """Return an isolated selected-note snapshot. This path never maps ledger atoms."""
    database = pathlib.Path(request.get("database_path", ""))
    db_info = database.lstat()
    if not stat.S_ISREG(db_info.st_mode):
        raise ValueError("database must be a regular file")
    ids = request.get("selected_ids")
    if (not isinstance(ids, list) or not ids or len(ids) > MAX_SELECTED_IDS
            or any(not isinstance(item, str) or not item or len(item) > 256 for item in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("invalid selected identifiers")
    blob_limit = request.get("max_blob_bytes")
    text_limit = request.get("max_text_bytes")
    if type(blob_limit) is not int or not 0 < blob_limit <= MAX_BLOB_LIMIT:
        raise ValueError("invalid blob limit")
    if type(text_limit) is not int or not 0 < text_limit <= MAX_TEXT_LIMIT:
        raise ValueError("invalid text limit")
    patterns = request.get("caller_text_hold_patterns")
    if (not isinstance(patterns, list) or not patterns or len(patterns) > 128
            or any(not isinstance(p, str) or not p or len(p) > 512 for p in patterns)):
        raise ValueError("invalid hold patterns")
    compiled = [re.compile(pattern) for pattern in patterns]

    uri = database.absolute().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=1.0)
    rows_out = []
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN")
        marks = ",".join("?" for _ in ids)
        metadata = connection.execute(
            "SELECT o.ZIDENTIFIER, COALESCE(o.ZTITLE1,o.ZTITLE,''), "
            "length(CAST(COALESCE(o.ZTITLE1,o.ZTITLE,'') AS BLOB)), "
            "o.ZMARKEDFORDELETION, o.ZISPASSWORDPROTECTED, o.ZFOLDER, f.Z_PK, f.ZMARKEDFORDELETION, "
            "f.ZFOLDERTYPE, o.ZNOTEDATA, o.ZMODIFICATIONDATE1 "
            "FROM ZICCLOUDSYNCINGOBJECT o LEFT JOIN ZICCLOUDSYNCINGOBJECT f "
            "ON f.Z_PK=o.ZFOLDER WHERE typeof(o.ZIDENTIFIER)='text' "
            "AND o.ZIDENTIFIER COLLATE BINARY IN (" + marks + ")",
            tuple(ids),
        ).fetchall()
        by_id = {}
        for row in metadata:
            identity = row[0]
            if identity is None:
                continue
            by_id.setdefault(str(identity), []).append(row)
        for identity in ids:
            matches = by_id.get(identity, [])
            if not matches:
                raise ValueError("selected identifier missing")
            if len(matches) != 1:
                raise ValueError("selected identifier ambiguous")
        total_blob_bytes = 0
        total_text_bytes = 0
        text_budget_exceeded = False
        for identity in ids:
            row = by_id[identity][0]
            _, title, title_size, marked_deleted, locked, folder_ref, folder_pk, folder_deleted, folder_type, body_ref, modified = row
            status = None
            if locked != 0:
                status = "locked"
            elif marked_deleted != 0:
                status = "marked_deleted"
            elif folder_ref is None or folder_pk is None:
                status = "folder_missing"
            elif folder_deleted != 0:
                status = "folder_deleted"
            elif folder_type != 0:
                status = "folder_type_excluded"
            elif body_ref is None:
                status = "null_body_ref"
            if status:
                rows_out.append({"selected_id": identity, "status": status})
                continue
            if title_size > text_limit:
                rows_out.append({"selected_id": identity, "status": "title_over_limit"})
                continue
            if text_budget_exceeded:
                rows_out.append({"selected_id": identity, "status": "total_text_over_limit"})
                continue
            size = connection.execute(
                "SELECT length(ZDATA) FROM ZICNOTEDATA WHERE Z_PK=?", (body_ref,)
            ).fetchone()
            if size is None or size[0] is None:
                rows_out.append({"selected_id": identity, "status": "null_body_ref"})
                continue
            if size[0] > blob_limit:
                rows_out.append({"selected_id": identity, "status": "blob_over_limit"})
                continue
            total_blob_bytes += size[0]
            if total_blob_bytes > MAX_TOTAL_BLOB_BYTES:
                rows_out.append({"selected_id": identity, "status": "total_blob_over_limit"})
                continue
            body = connection.execute(
                "SELECT ZDATA FROM ZICNOTEDATA WHERE Z_PK=?", (body_ref,)
            ).fetchone()
            if body is None or body[0] is None:
                rows_out.append({"selected_id": identity, "status": "null_body_ref"})
                continue
            try:
                text = extract_selected_text(body[0], text_limit)
            except (ValueError, UnicodeDecodeError, zlib.error):
                rows_out.append({"selected_id": identity, "status": "invalid_body"})
                continue
            title = str(title or "")
            total_text_bytes += len(title.encode("utf-8")) + len(text.encode("utf-8"))
            if total_text_bytes > MAX_TOTAL_TEXT_BYTES:
                text_budget_exceeded = True
                rows_out.append({"selected_id": identity, "status": "total_text_over_limit"})
                continue
            held_by_title = any(pattern.search(title) for pattern in compiled)
            held_by_text = any(pattern.search(text) for pattern in compiled)
            if held_by_title or held_by_text:
                rows_out.append({"selected_id": identity, "status": "held"})
                continue
            at = None
            if modified is not None:
                at = datetime.datetime.fromtimestamp(
                    float(modified) + APPLE_EPOCH, datetime.timezone.utc
                ).isoformat()
            rows_out.append({
                "selected_id": identity, "status": "accepted", "title": title,
                "text": text, "modified_at": at,
            })
        connection.commit()
        return {"mode": "selected_private_snapshot", "rows": rows_out}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main():
    if len(sys.argv) != 3:
        raise SystemExit(2)
    request_path, output_path = sys.argv[1:]
    try:
        raw = _read_regular(request_path, MAX_REQUEST_BYTES)
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        if "mode" in request and request["mode"] != "selected_private_snapshot":
            raise ValueError("unsupported request mode")
        if request.get("mode") == "selected_private_snapshot":
            # Reopen under the stricter selected-mode privacy and refuse a changed request.
            private_raw = _require_private_regular(request_path, MAX_REQUEST_BYTES)
            if private_raw != raw:
                raise ValueError("request changed")
            request_stat = pathlib.Path(request_path).stat()
            database_stat = pathlib.Path(request.get("database_path", "")).lstat()
            if (request_stat.st_dev, request_stat.st_ino) == (database_stat.st_dev, database_stat.st_ino):
                raise ValueError("request aliases database")
            request = json.loads(private_raw.decode("utf-8"))
            result = selected_private_snapshot(request)
            _private_output(
                output_path, json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                request_path, request.get("database_path", ""),
            )
            return
    except Exception:
        sys.stderr.write("selected snapshot failed\n")
        raise SystemExit(2)
    descriptor = request.get("descriptor") or {}
    observations = [request["observation"]] if "observation" in request else (request.get("batch") or {}).get("accepted", [])
    combined = {"threads": [], "atoms": [], "rejections": []}
    grouped = {}
    for observation in observations:
        grouped.setdefault(_store_path(observation.get("native_ref")), []).append(observation)
    for group in grouped.values():
        result = decode(_one_store_observation(group), descriptor)
        for key in combined:
            combined[key].extend(result.get(key, []))
    pathlib.Path(output_path).write_text(json.dumps(combined, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
