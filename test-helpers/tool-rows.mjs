// The rows every tool folder offers, read the way Trillion reads them before it offers a tool: each tool folder's card
// (tools/<name>/what-this-tool-does-and-how-to-run-it.json, or the older tools/<name>/tool-rows.json, for the one release
// the engine reads both) is { records: [{ payload }], prepare?, needs_tools? }, and a tool-row-source's list.records names a
// records file (or a folder of them) holding rows of its kind. Read by test/every-tool-row.test.mjs and
// test/lockfile-licences.test.mjs.
//
// As the engine does (trillion-rust src/tool_runs/tools/card.rs), a row's invoke (and each by_input variant) may use the
// new field names, read here as the older ones every test reads: `run` (an array; an on-your-computer row's text `run` is
// its own field) as `argv`, `key` as `credential_mounts`, and `may_reach` (a list of hosts) as `internet: true` with
// `hosts` and each credential injection's `hosts`. A folder holding its card under both names, or a row naming one field
// both ways, is refused, naming both.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const tools = resolve(root, 'tools');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const folders = readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

// The card's file names, the new one first (the engine's tool-runs.json tool_sources.card_files).
export const cardFiles = ['what-this-tool-does-and-how-to-run-it.json', 'tool-rows.json'];

// The card file of `folder` in the tools folder `within`, or null when it holds none; two names are refused, naming both.
export function cardIn(within, folder) {
  const held = cardFiles.map(name => join(within, folder, name)).filter(path => existsSync(path));
  assert.ok(held.length < 2, `${folder} holds its card under two names: ${held.join(' and ')}`);
  return held[0] ?? null;
}

// Each new field name and the older name it is read as.
const renamed = [['run', 'argv'], ['key', 'credential_mounts']];
const oldReach = ['internet', 'hosts'];

// The row as every test reads it: the new field names of its invoke and of each by_input variant as the older ones.
export function asRead(where, payload) {
  const invoke = payload?.invoke;
  if (!invoke || typeof invoke !== 'object' || Array.isArray(invoke)) return payload;
  const variants = Object.values(invoke.by_input?.variants ?? {}).filter(variant => variant && typeof variant === 'object');
  const places = [invoke, ...variants];
  const any = test => places.some(test);
  const isNewName = (place, name) => name === 'run' ? Array.isArray(place.run) : name in place;
  for (const [name, old] of renamed) {
    assert.ok(!(any(place => isNewName(place, name)) && any(place => old in place)), `${where}: ${payload.id} names one field both ways: ${name} and ${old}`);
  }
  if (any(place => 'may_reach' in place)) {
    for (const old of oldReach) assert.ok(!any(place => old in place), `${where}: ${payload.id} names one field both ways: may_reach and ${old}`);
    assert.ok(!any(place => (place.credential_injections ?? []).some(item => item && 'hosts' in item)),
      `${where}: ${payload.id} names one field both ways: may_reach and credential_injections.hosts`);
    assert.ok(places.every(place => !('may_reach' in place) || (Array.isArray(place.may_reach) && place.may_reach.every(host => typeof host === 'string'))),
      `${where}: ${payload.id}: may_reach is a list of hosts`);
  }
  const rename = (place, reach) => {
    const read = { ...place };
    if (Array.isArray(read.run)) { read.argv = read.run; delete read.run; }
    if ('key' in read) { read.credential_mounts = read.key; delete read.key; }
    if ('may_reach' in read) { read.internet = true; read.hosts = read.may_reach; delete read.may_reach; }
    if (reach && Array.isArray(read.credential_injections)) {
      read.credential_injections = read.credential_injections.map(item => item && typeof item === 'object' && !('hosts' in item) ? { ...item, hosts: reach } : item);
    }
    return read;
  };
  const reach = invoke.may_reach;
  const read = rename(invoke, reach);
  if (read.by_input?.variants) {
    read.by_input = { ...read.by_input, variants: Object.fromEntries(Object.entries(read.by_input.variants)
      .map(([name, variant]) => [name, variant && typeof variant === 'object' ? rename(variant, variant.may_reach ?? reach) : variant])) };
  }
  return { ...payload, invoke: read };
}

// Whether a card's own optional fields are of their shapes: `prepare` a command (non-empty texts), `needs_tools`
// distinct folder names. Nothing acts on them yet.
function checkCard(where, card) {
  if ('prepare' in card) {
    assert.ok(Array.isArray(card.prepare) && card.prepare.length > 0 && card.prepare.every(word => typeof word === 'string' && word.length > 0),
      `${where}: prepare is a command, a list of texts`);
  }
  if ('needs_tools' in card) {
    const names = card.needs_tools;
    assert.ok(Array.isArray(names) && names.every(name => typeof name === 'string' && name && !name.includes('/') && name !== '.' && name !== '..')
      && new Set(names).size === names.length, `${where}: needs_tools is a list of distinct tool folder names`);
  }
}

// The rows each folder offers: its card, plus the rows a tool-row-source there lists from a records file.
export function rowsOf(folder) {
  return rowsIn(tools, folder);
}

// `rowsOf`, for the tool folder `folder` of the tools folder `within`.
export function rowsIn(within, folder) {
  const file = cardIn(within, folder);
  if (!file) return [];
  const where = file.slice(within.length + 1);
  const card = json(file);
  checkCard(where, card);
  const kept = card.records;
  assert.ok(Array.isArray(kept), `${where} has a records list`);
  return kept.flatMap(({ payload: written }) => {
    assert.ok(written?.kind && written?.id, `${where}: every record has a payload with kind and id`);
    const payload = asRead(where, written);
    if (payload.kind !== 'tool-row-source' || !payload.list?.records) return [{ folder, payload }];
    const { package: name, kind, file: records = 'records.json' } = payload.list.records;
    const path = join(within, name, records);
    assert.ok(existsSync(path), `${payload.id} lists ${name}/${records}, which is here`);
    // A file holds its rows; a folder holds files that each hold rows. Either way a row is { payload } in things or records.
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter(entry => entry.endsWith('.json')).map(entry => join(path, entry))
      : [path];
    const listed = files.flatMap(file => { const kept = json(file); return kept.things ?? kept.records ?? []; })
      .filter(thing => thing?.payload?.kind === kind);
    assert.ok(listed.length, `${payload.id}: ${name}/${records} holds rows of kind ${kind}`);
    return [{ folder, payload }, ...listed.map(thing => ({ folder: name, payload: asRead(`${name}/${records}`, thing.payload) }))];
  });
}

export const rows = () => folders.flatMap(rowsOf);
