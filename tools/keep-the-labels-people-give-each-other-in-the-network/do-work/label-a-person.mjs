// tools/keep-the-labels-people-give-each-other-in-the-network/do-work/label-a-person.mjs
//
// The old label_person tool: one person gives another person in the network one declared label (unwanted-requests,
// unsafe or vouched). It writes one row in the labels table of the database named in the input, once per labeler, and
// one history row of what was written. The database is reached through the `db` the run hands in (a mounted
// connection); nothing is kept here.
//
// Non-negotiable invariants:
//   1. The label must be one of the declared labels (introduce-two-people/src/network-settings.json).
//   2. The same label from the same person is written once; a repeat writes nothing new.
//   3. An erased identity cannot publish a label: it is refused before anything is written.
import rules from '../../introduce-two-people/src/network-settings.json' with { type: 'json' };

const declared = new Set(rules.labels.map(row => row.id));
const fail = (message, status) => Object.assign(new Error(message), { status });

// The old tables, under the old names, so rows kept before this port still read.
const TABLES = [
  'CREATE TABLE IF NOT EXISTS labels(relay TEXT NOT NULL,label TEXT NOT NULL,by_relay TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(relay,label,by_relay))',
  'CREATE TABLE IF NOT EXISTS native_moderation_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,relay TEXT NOT NULL,label TEXT NOT NULL,by_relay TEXT NOT NULL,at TEXT NOT NULL,action TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS native_moderation_erased_relays(relay TEXT PRIMARY KEY)',
];

// `db.exec(sql, ...values)` answers the rows of a select (an empty list for a write).
export function labelAPerson({ db, input, now = () => new Date().toISOString() }) {
  const { relay, label, by } = input ?? {};
  if (typeof relay !== 'string' || !relay || typeof by !== 'string' || !by) throw fail('Give the target and the labeler.', 400);
  if (!declared.has(label)) throw fail(`label is one of: ${[...declared].join(', ')}`, 400);
  for (const sql of TABLES) db.exec(sql);
  if (db.exec('SELECT 1 FROM native_moderation_erased_relays WHERE relay IN(?,?) LIMIT 1', relay, by).length)
    throw fail('An erased moderation identity cannot publish another label.', 410);
  if (!db.exec('SELECT 1 FROM labels WHERE relay=? AND label=? AND by_relay=?', relay, label, by).length) {
    db.exec('INSERT INTO labels(relay,label,by_relay,at) VALUES(?,?,?,?)', relay, label, by, now());
    db.exec('INSERT INTO native_moderation_history(relay,label,by_relay,at,action) VALUES(?,?,?,?,?)', relay, label, by, now(), 'label');
  }
  return { labelled: relay, label };
}
