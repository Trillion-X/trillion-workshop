// The decision store on this computer: the same EEAF tables as the hosted store, in one SQLite file (node:sqlite).
// One exec call, with its query and params, then its rows (toArray) is the one interface the EEAF store needs, the same one a Durable Object's
// storage gives, so both hosts run the same store code. That seam is node:sqlite's, src/hosts/local/sqlite-host.mjs sqliteHost.
import { sqliteHost } from './hosts/local/sqlite-host.mjs';
import { decisionStore } from './decision-store.mjs';
import { guardShape, shapeOf, snapshotIfDue, stampShape } from './local-store-safety.mjs';
import safety from './local-store-safety.json' with { type: 'json' };

// The seam is named here too for the tests and scripts that import it from this file (about 790, 15 of them held by
// other chats' unlanded edits on 2026-10-27); a file that moves its import to src/hosts/local/sqlite-host.mjs drops one.
export { sqliteHost };

// The engine's store: read(scope) and write(state) over this computer's SQLite file.
export function localStore(file) {
  const { db, sql, transaction } = sqliteHost(file);
  // A rolling snapshot of the store on this computer is taken when one is due (src/local-store-safety.mjs).
  const guarded = safety.automatic && file !== ':memory:';
  if (guarded) snapshotIfDue(db, file);
  // A store whose tables this code is about to change is copied first; the new shape is recorded once the change is made.
  const shape = guarded ? shapeOf() : null;
  if (guarded) guardShape(db, file, shape);
  const store = decisionStore(sql, { transaction });
  if (guarded) stampShape(db, shape);
  return store;
}
