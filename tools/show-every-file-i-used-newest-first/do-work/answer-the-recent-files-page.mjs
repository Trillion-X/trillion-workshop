// tools/show-every-file-i-used-newest-first/do-work/answer-the-recent-files-page.mjs
//
// The Recent screen's route, answered as old trillion answered it (tag old-trillion-before-worker-retire):
// src/work-media.mjs's RECENT branch over src/native-media-account-actions.mjs nativeRecentFiles, which ran
// src/recent-files.mjs recentFilesStore (src/recent-files.mjs here, unchanged) on the account's own SQLite. The engine
// runs this as a @workshop-routes tool: input { path, method, query, body, browser }, result { status, body }.
//
//   GET  /recent-files?limit=&before=   { items, next_before, said }: the files the person used, newest first
//   POST /recent-files { file, kind }   { recorded: true, file }: keep that a file was used, now
//
// The uses the old table recent_file_uses held (one row per file and kind, its newest time) are the person's own
// records of kind `recent-file-use`, one per file and kind: { id: "recent-file-use:<identity>:<kind>", value:
// { identity, kind, at } }. A run lays them in the same table in an in-memory SQLite, runs recentFilesStore unchanged
// on it, and writes back what changed: the use kept, and each file the store's own trim let go (value null).
// A file is found by its name or identity in the person's Namespace files (the door's find_file), as the old
// /namespace/files/lookup found it; a file no longer kept drops out of the list.
// The old route refused a POST from another origin (403); the engine's door admits the page before a route tool runs,
// as the old native route was admitted before it reached this owner.
import { DatabaseSync } from 'node:sqlite';
import { afterTimeCursor, readTimeCursor } from '../../recently-deleted-and-storage/time-cursor.mjs';
import { recentFilesStore } from '../src/recent-files.mjs';
import recentSettings from '../src/recent-files.json' with { type: 'json' };
import { fileLookupBody } from '../../organize-my-files/src/namespace-file-lookup.mjs';

export const KIND = 'recent-file-use';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idOf = (identity, kind) => `${KIND}:${identity}:${kind}`;

/** The cursor-and-rows shape recentFilesStore reads its SQLite through, over node:sqlite. */
export function memorySql() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec: (query, ...params) => { const rows = db.prepare(query).all(...params); return { toArray: () => rows }; } } };
}

const usesIn = sql => new Map(sql.exec('SELECT identity, kind, at FROM recent_file_uses').toArray().map(row => [idOf(row.identity, row.kind), { identity: row.identity, kind: row.kind, at: row.at }]));

// src/native-media-account-actions.mjs nativeRecentFiles at the tag, byte for byte: the store's reads and uses, each file
// resolved through the account's Namespace lookup first.
export function nativeRecentFiles(sql,namespaceHttp){
  const resolved=new Map();
  const use=recentFilesStore(sql,{locate:identity=>resolved.get(identity)??null});
  const resolve=async ref=>{
    const row=await namespaceHttp('/namespace/files/lookup','POST',fileLookupBody(ref,{metadata:'file'})).catch(error=>{if(error.status===404)return null;throw error;});
    if(row?.identity)resolved.set(row.identity,row.names?.length?row:null);
    return row?.identity?row:null;
  };
  const recent=async input=>{
    const asked=Number(input?.limit),limit=Math.max(1,Math.min(recentSettings.list_max,Number.isSafeInteger(asked)&&asked>0?asked:recentSettings.list_default));
    const older=readTimeCursor(input?.before),after=afterTimeCursor(older,'MAX(at)','identity');
    const page=sql.exec(`SELECT identity FROM recent_file_uses GROUP BY identity HAVING ${after.sql}
      ORDER BY MAX(at) DESC,identity DESC LIMIT ?`,...after.args,limit+1).toArray();
    await Promise.all(page.map(row=>resolve(row.identity)));
    return use.recent(input??{});
  };
  const record=async input=>{
    const found=await resolve(input?.file);
    if(!found)throw new Error(`${String(input?.file??'')} is not in your files.`);
    resolved.set(found.identity,found);
    return use.record({...input,file:found.identity});
  };
  return {recent,record};
}

/**
 * The old account's `/namespace/files/lookup` answer for one name or identity ({ identity, names, media_type }, or a
 * 404 refusal), from the person's Namespace files through the files door's find_file.
 */
export const doorNamespaceHttp = door => async (path, _method, body) => {
  if (path !== '/namespace/files/lookup') throw Object.assign(new Error(`${path} is not reached from this run.`), { status: 404 });
  const found = await door.files('find_file', { name_or_identity: body.name ?? body.identity }).catch(() => null);
  if (!found?.identity) throw Object.assign(new Error('Not found'), { status: 404 });
  return { identity: found.identity, names: found.names ?? [], media_type: found.media_type ?? null, byte_length: found.byte_length };
};

/**
 * The person's recent files over the kept `uses` ({ identity, kind, at } rows) laid in recent_file_uses, with
 * `namespaceHttp` answering the lookup: { recent, record, changes }, `changes()` being the records to write.
 */
export function recentFilesOver({ uses = [], namespaceHttp }) {
  const { sql } = memorySql();
  sql.exec('CREATE TABLE IF NOT EXISTS recent_file_uses (identity TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (identity, kind))');
  for (const row of uses) sql.exec('INSERT OR REPLACE INTO recent_file_uses (identity, kind, at) VALUES (?, ?, ?)', row.identity, row.kind, row.at);
  const before = usesIn(sql);
  const { recent, record } = nativeRecentFiles(sql, namespaceHttp);
  const changes = () => {
    const after = usesIn(sql);
    const kept = [...after].filter(([id, row]) => before.get(id)?.at !== row.at).map(([id, value]) => ({ id, type: KIND, value }));
    const gone = [...before.keys()].filter(id => !after.has(id)).map(id => ({ id, type: KIND, value: null }));
    return [...kept, ...gone];
  };
  return { recent, record, changes };
}

/** tool:answer-the-recent-files-page: run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }). */
export async function answerTheRecentFilesPage(input, { door }) {
  const { method = 'GET', query = {}, body } = object(input) ? input : {};
  const uses = [];
  for await (const record of door.list({ type: KIND })) if (object(record.value)) uses.push(record.value);
  const person = recentFilesOver({ uses, namespaceHttp: doorNamespaceHttp(door) });
  if (method === 'GET') return { status: 200, body: await person.recent({ limit: query?.limit ?? null, before: query?.before ?? null }) };
  if (method !== 'POST') return { status: 404, body: { error: 'Not found' } };
  let answer;
  try { answer = await person.record(object(body) ? body : null); }
  catch (error) { return { status: 400, body: { error: error.message } }; }
  const writes = person.changes();
  if (writes.length) await door.write(writes);
  return { status: 200, body: answer };
}
