// tools/recently-deleted-and-storage/do-work/delete-archive-and-put-back.mjs
//
// Recently Deleted and Archived for a person's files, run over files handed in: the namespace (namespace-store.mjs
// namespaceStore, its tables in an in-memory SQLite database, node:sqlite) is given the files' names with putNames, and
// then the steps run in order through namespace-set-aside.mjs's own setAsideStore: delete or archive files and folders,
// put things back, change how long each state keeps things, and move on what is due on a given day. Then everything set
// aside is listed with its time left. Nothing is kept after the run, no byte is deleted (as the store never deletes
// one: a name taken away leaves the file reachable by its identity), no file is written and nothing is sent.
//
// Input:
//   files  [{ name, identity?, byte_length?, modified_at_ms? }]: the person's files by name (each starting with /)
//   now    ISO time the run starts at (the clock every step reads; a sweep step moves it on)
//   steps  [ { op: "delete" | "archive", items: [{ name } | { identity }], by? }
//          | { op: "put_back", items: [<label or id of something set aside>] }
//          | { op: "keep_for", after_days: { deleted?: days | null, archived?: days | null } }
//          | { op: "sweep", at } ]                      at: ISO time; whatever is due by then moves on
// Answers { steps: [what each step answered], set_aside: [every item, as Recently Deleted and Archived list it],
//           names: [the names the person's Files still shows], gone: [identities whose names are gone for good],
//           keep_for }.
// Refuses no files, a step it does not know, a put_back naming nothing set aside, and whatever the store refuses
// (a name not starting with /, the whole Files, a day count out of range).
import { DatabaseSync } from 'node:sqlite';
import { namespaceStore } from '../namespace-store.mjs';
import { setAsideStore } from '../namespace-set-aside.mjs';

// The node:sqlite handle in the shape the store's code takes: exec(query, ...params), spread or toArray().
function sqlOver(db) {
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : (statement.run(...params), []);
      return Object.assign(rows, { toArray: () => rows });
    },
  };
}

const timeOf = (text, what) => {
  const ms = Date.parse(text);
  if (typeof text !== 'string' || Number.isNaN(ms)) throw new Error(`${what} needs a time as ISO text, such as 2026-11-01T09:00:00Z.`);
  return ms;
};

export function deleteArchiveAndPutBack({ files, now, steps = [] } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Give files: a list of { name, identity?, byte_length? }, each name starting with /.');
  if (!Array.isArray(steps)) throw new Error('Give steps as a list, or leave them out.');
  let clock = timeOf(now, 'now');
  const sql = sqlOver(new DatabaseSync(':memory:'));
  const names = namespaceStore(sql);
  const put = names.putNames(files.map(file => ({ byte_length: 0, ...file })));
  if (put.conflicts?.length) throw new Error(`These files could not be named: ${JSON.stringify(put.conflicts)}.`);
  let saved = null;
  const gone = [];
  let next = 0;
  const store = setAsideStore(sql, {
    keepFor: { read: () => saved, write: value => { saved = value; } },
    now: () => clock,
    newId: () => `set-aside-${++next}`,
    onGone: identities => gone.push(...identities),
  });

  const answers = steps.map((step, index) => {
    switch (step?.op) {
      case 'delete':
      case 'archive':
        return { op: step.op, ...store.setAside({ items: step.items, state: step.op === 'delete' ? 'deleted' : 'archived', by: step.by ?? null }) };
      case 'put_back': {
        if (!Array.isArray(step.items)) throw new Error(`Step ${index} (put_back) needs items: the labels or ids of what to put back.`);
        const held = store.everything();
        const ids = step.items.map(asked => {
          const found = held.find(item => item.id === asked) ?? held.find(item => item.label === asked);
          if (!found) throw new Error(`Step ${index} (put_back): nothing set aside is called ${JSON.stringify(asked)}.`);
          return found.id;
        });
        return { op: 'put_back', ...store.putBack(ids) };
      }
      case 'keep_for':
        return { op: 'keep_for', keep_for: store.setKeepFor({ after_days: step.after_days }) };
      case 'sweep':
        clock = timeOf(step.at, `Step ${index} (sweep) at`);
        return { op: 'sweep', ...store.sweep(clock) };
      default:
        throw new Error(`Step ${index} has op ${JSON.stringify(step?.op)}; choose one of: delete, archive, put_back, keep_for, sweep.`);
    }
  });
  const shown = [...sql.exec('SELECT name FROM namespace_names ORDER BY name')].map(row => row.name);
  return { steps: answers, set_aside: store.everything(), names: shown, gone, keep_for: store.keepFor() };
}
