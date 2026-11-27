// The rows every tool folder offers, read the way Trillion reads them before it offers a tool: each tool folder's card,
// tools/<name>/what-this-tool-does-and-how-to-run-it.json, is { records: [{ payload }] }, and a tool-row-source's list.records
// names a records file (or a folder of them) holding rows of its kind. Read by test/every-tool-row.test.mjs and
// test/lockfile-licences.test.mjs.
//
// The old names are refused, with words that name them: a folder that still holds tool-rows.json, and a row whose invoke (or
// one of its invoke.by_input.variants) still holds argv (now run), credential_mounts (now key), internet or hosts (now
// may_reach), or a credential_injections item that holds hosts (now the place's may_reach).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CARD = 'what-this-tool-does-and-how-to-run-it.json';
export const OLD_CARD = 'tool-rows.json';
export const root = resolve(import.meta.dirname, '..');
export const tools = resolve(root, 'tools');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const folders = readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

// The old field names a place (an invoke, or a variant merged over it) may not hold, each with the name that replaced it.
const OLD_FIELDS = { argv: 'run', credential_mounts: 'key', internet: 'may_reach', hosts: 'may_reach' };

/** The program a row starts and its words: its invoke's run when that is a list (an on-your-computer row's text run is a
 * template, not a list of words), else none. */
export const programOf = invoke => (Array.isArray(invoke?.run) ? invoke.run : []);

/** The places of one row's run: its invoke and each variant, each with the words that name it. */
export const placesOf = payload => {
  const invoke = payload?.invoke;
  if (!invoke || typeof invoke !== 'object') return [];
  const variants = Object.entries(invoke.by_input?.variants ?? {});
  return [['invoke', invoke], ...variants.map(([name, variant]) => [`invoke.by_input.variants.${name}`, variant])];
};

/** One line for each old field name the row still holds; none when it holds only the new names. */
export function oldFieldsOf(payload) {
  return placesOf(payload).flatMap(([where, place]) => [
    ...Object.entries(OLD_FIELDS).filter(([old]) => Object.hasOwn(place, old))
      .map(([old, now]) => `${payload.id} ${where}.${old} is an old field name: it is ${now} now`),
    ...(Array.isArray(place.credential_injections) ? place.credential_injections : [])
      .flatMap((item, at) => (item && Object.hasOwn(item, 'hosts')
        ? [`${payload.id} ${where}.credential_injections[${at}].hosts is an old field name: the hosts are the place's may_reach now`]
        : [])),
  ]);
}

const refuseOldFields = payload => {
  const old = oldFieldsOf(payload);
  assert.deepEqual(old, [], old.join('\n'));
};

/** The words that refuse a folder of `toolsDir` holding a card under its old name, or null when it holds none. */
export const oldCardIn = (toolsDir, folder) => (existsSync(join(toolsDir, folder, OLD_CARD))
  ? `tools/${folder}/${OLD_CARD} is the old name of a tool's card: it is tools/${folder}/${CARD} now` : null);

// The rows each folder offers: its card, plus the rows a tool-row-source there lists from a records file.
export function rowsOf(folder) {
  const old = oldCardIn(tools, folder);
  assert.equal(old, null, old ?? '');
  const file = join(tools, folder, CARD);
  if (!existsSync(file)) return [];
  const kept = json(file).records;
  assert.ok(Array.isArray(kept), `${folder}/${CARD} has a records list`);
  return kept.flatMap(({ payload }) => {
    assert.ok(payload?.kind && payload?.id, `${folder}/${CARD}: every record has a payload with kind and id`);
    refuseOldFields(payload);
    if (payload.kind !== 'tool-row-source' || !payload.list?.records) return [{ folder, payload }];
    const { package: name, kind, file: records = 'records.json' } = payload.list.records;
    assert.ok(records.split('/').at(-1) !== OLD_CARD,
      `${payload.id} lists ${name}/${records}: ${OLD_CARD} is the old name of a card, it is ${CARD} now`);
    const path = join(tools, name, records);
    assert.ok(existsSync(path), `${payload.id} lists ${name}/${records}, which is here`);
    // A file holds its rows; a folder holds files that each hold rows. Either way a row is { payload } in things or records.
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter(entry => entry.endsWith('.json')).map(entry => join(path, entry))
      : [path];
    const listed = files.flatMap(file => { const kept = json(file); return kept.things ?? kept.records ?? []; })
      .filter(thing => thing?.payload?.kind === kind);
    assert.ok(listed.length, `${payload.id}: ${name}/${records} holds rows of kind ${kind}`);
    for (const thing of listed) refuseOldFields(thing.payload);
    return [{ folder, payload }, ...listed.map(thing => ({ folder: name, payload: thing.payload }))];
  });
}

export const rows = () => folders.flatMap(rowsOf);
