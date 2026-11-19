-- The history of anything, under any of its identifiers: the same intent, rendered for an embedded SQLite store.
-- Same invariants as history.pg.sql. A meaning rule here is a path and a value in SQLite's own JSON path words.
CREATE TABLE statements (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, told TEXT NOT NULL, place TEXT, change TEXT,
  at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  key TEXT, before TEXT, after TEXT, detail TEXT, meaning TEXT, retracts INTEGER REFERENCES statements (id),
  holds_from TEXT, holds_until TEXT, erased_at TEXT, UNIQUE (source, told));
CREATE INDEX statements_retracts ON statements (retracts) WHERE retracts IS NOT NULL;
CREATE TABLE mentions (statement INTEGER NOT NULL REFERENCES statements (id), role TEXT NOT NULL, scheme TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (statement, role, scheme, value));
CREATE INDEX mentions_identifier ON mentions (scheme, value);
CREATE TABLE schemes (scheme TEXT PRIMARY KEY, fold_case INTEGER NOT NULL DEFAULT 0, most_things INTEGER, words TEXT);
CREATE TABLE meanings (meaning TEXT PRIMARY KEY, joins_from TEXT, joins_to TEXT, words TEXT);
CREATE TABLE meaning_rules (position INTEGER PRIMARY KEY, source TEXT, place TEXT, change TEXT, path TEXT, equals TEXT, meaning TEXT NOT NULL);
CREATE TABLE mention_rules (source TEXT, place TEXT, path TEXT NOT NULL, role TEXT NOT NULL, scheme TEXT NOT NULL);

CREATE TRIGGER refuse_retracting_a_retraction BEFORE INSERT ON statements
WHEN NEW.retracts IS NOT NULL AND (SELECT retracts FROM statements WHERE id = NEW.retracts) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'That statement is itself a retraction. To undo it, tell the retracted statement again.'); END;

CREATE TRIGGER fill_meaning AFTER INSERT ON statements WHEN NEW.meaning IS NULL
BEGIN
  UPDATE statements SET meaning = coalesce((SELECT r.meaning FROM meaning_rules r
    WHERE (r.source IS NULL OR r.source = NEW.source) AND (r.place IS NULL OR r.place = NEW.place) AND (r.change IS NULL OR r.change = NEW.change)
      AND (r.path IS NULL OR (r.equals IS NULL AND json_extract(json_object('key', NEW.key, 'after', json(NEW.after)), r.path) IS NOT NULL)
           OR json_extract(json_object('key', NEW.key, 'after', json(NEW.after)), r.path) = r.equals)
    ORDER BY r.position LIMIT 1), 'unknown') WHERE id = NEW.id;
END;

CREATE TRIGGER mention_what_rules_find AFTER INSERT ON statements
BEGIN
  INSERT OR IGNORE INTO mentions (statement, role, scheme, value)
  SELECT NEW.id, r.role, r.scheme, CASE WHEN coalesce(sc.fold_case, 0) THEN lower(v) ELSE v END
  FROM mention_rules r LEFT JOIN schemes sc ON sc.scheme = r.scheme,
    (SELECT json_extract(json_object('key', NEW.key, 'after', json(NEW.after)), r2.path) AS v, r2.rowid AS rid FROM mention_rules r2) x
  WHERE x.rid = r.rowid AND x.v IS NOT NULL AND (r.source IS NULL OR r.source = NEW.source) AND (r.place IS NULL OR r.place = NEW.place);
END;

-- Reads (parameters :scheme, :value, :known):
-- known_as: every identifier reaching the thing, with the span its path holds over.
-- history:  every statement about one of them that happened inside that span, and every retraction of one.
CREATE TRIGGER fold_case AFTER INSERT ON mentions WHEN (SELECT fold_case FROM schemes WHERE scheme = NEW.scheme) = 1 AND NEW.value <> lower(NEW.value)
BEGIN UPDATE OR IGNORE mentions SET value = lower(NEW.value) WHERE statement = NEW.statement AND role = NEW.role AND scheme = NEW.scheme AND value = NEW.value; END;
