-- The account owner's names index, from the archive tables of the same names (ns_name, ns_folder, ns_file, ns_chunk, ns_alias, ns_spans)
-- into the tables of src/store/tables.json, one statement a table. src/store/copy.rs reads this file: each INSERT names the table and its
-- columns, and its SELECT runs against the archive (read-only) to make the rows. Every archive column is a column here, `scope` is made from
-- the row's own id (a name's or folder's scope is its tree and its parent folder: `rtrim(id, replace(id, '/', ''))` is the id up to and
-- including its last slash), `version` is 1, and an archive `extra` of '' is no extra. The SELECTs are plain SQLite, which the archive is.
INSERT INTO ns_chunk (scope, id, version, byte_length, "key", kind, origin, stored_at, extra)
SELECT '@namespace/chunks', id, 1, CAST(byte_length AS BIGINT), "key", kind, origin, stored_at, NULLIF(extra, '')
FROM archive.ns_chunk;

INSERT INTO ns_alias (scope, id, version, added_at, grade, identity, kind, extra)
SELECT '@namespace/aliases', id, 1, added_at, grade, identity, kind, NULLIF(extra, '')
FROM archive.ns_alias;

INSERT INTO ns_spans (scope, id, version, kind, spans, extra)
SELECT '@namespace/spans', id, 1, kind, spans, NULLIF(extra, '')
FROM archive.ns_spans;

INSERT INTO ns_file (scope, id, version, aliases, byte_length, checked_at, "key", kind, media_type, names, origin, spans, stored_at, part_bytes, prefix_identity, span_layout, span_set, extra)
SELECT '@namespace/files', id, 1, aliases, CAST(byte_length AS BIGINT), checked_at, "key", kind, media_type, names, origin, CAST(spans AS BIGINT), stored_at, CAST(part_bytes AS BIGINT), prefix_identity, span_layout, span_set, NULLIF(extra, '')
FROM archive.ns_file;

INSERT INTO ns_name (scope, id, version, byte_length, file, identity, kind, modified_at_ms, name, named_at, extra)
SELECT CASE kind WHEN 'namespace-set-aside' THEN '@namespace/set-aside/names' ELSE '@namespace/names' END
         || CASE WHEN length(rtrim(id, replace(id, '/', ''))) <= 1 THEN '/' ELSE substr(rtrim(id, replace(id, '/', '')), 1, length(rtrim(id, replace(id, '/', ''))) - 1) END,
       id, 1, CAST(byte_length AS BIGINT), file, identity, kind, CAST(modified_at_ms AS BIGINT), name, named_at, NULLIF(extra, '')
FROM archive.ns_name;

INSERT INTO ns_folder (scope, id, version, folder, kind, extra)
SELECT '@namespace/folders'
         || CASE WHEN length(rtrim(id, replace(id, '/', ''))) <= 1 THEN '/' ELSE substr(rtrim(id, replace(id, '/', '')), 1, length(rtrim(id, replace(id, '/', ''))) - 1) END,
       id, 1, folder, kind, NULLIF(extra, '')
FROM archive.ns_folder;
