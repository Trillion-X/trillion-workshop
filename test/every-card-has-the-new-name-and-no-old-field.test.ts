// Every tool's card is tools/<folder>/what-this-tool-does-and-how-to-run-it.json, and no row says its run with the old
// field names. The walk reads every folder under tools/ (at any depth): a file still named tool-rows.json fails here, by
// its path. For each card it checks, for each field, first that it is there and of its type, then its value:
//   - records is a list of { payload } with a text kind and id;
//   - in each row's invoke and in each invoke.by_input.variants.<name> (a merge patch over the invoke), run is a list of
//     words (or, on an on-your-computer row, its text template), key is a list of objects, may_reach is a list of host
//     names, and argv, credential_mounts, internet, hosts and a credential_injections item's hosts are absent;
//   - the card's optional prepare is a non-empty list of texts, and its optional needs_tools names distinct tool folders.
// Rows a tool-row-source lists from a records file are checked the same way, and the file they are listed from is never
// named tool-rows.json. The test reader's own refusals (test-helpers/tool-rows.mjs) are checked to name what they refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CARD, OLD_CARD, oldCardIn, oldFieldsOf, placesOf, root, tools } from '../test-helpers/tool-rows.mjs';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Payload = { [key: string]: Json };

const SKIPPED = new Set(['node_modules', '.git', 'target']);
const OLD_FIELDS = ['argv', 'credential_mounts', 'internet', 'hosts'];
const isObject = (value: unknown): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);
const read = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));

/** Every file under `folder` whose name is `name`, at any depth. */
function filesNamed(folder: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) filesNamed(path, name, out);
    else if (entry.name === name) out.push(path);
  }
  return out;
}

const toolFolders = readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const cards = toolFolders.filter(folder => existsSync(join(tools, folder, CARD)));

/** One line for each field of one place that is missing its type or holds an old name. */
function placeProblems(where: string, place: { [key: string]: Json }): string[] {
  const problems: string[] = [];
  for (const old of OLD_FIELDS) if (Object.hasOwn(place, old)) problems.push(`${where}.${old} is an old field name`);
  if (Object.hasOwn(place, 'run')) {
    const run = place.run;
    if (Array.isArray(run)) {
      if (run.length === 0) problems.push(`${where}.run is an empty list`);
    } else if (typeof run !== 'string') problems.push(`${where}.run is neither a list of words nor a text template`);
    else if (run.trim() === '') problems.push(`${where}.run is an empty text`);
  }
  if (Object.hasOwn(place, 'key')) {
    const key = place.key;
    if (!Array.isArray(key)) problems.push(`${where}.key is not a list`);
    else key.forEach((item, at) => { if (!isObject(item)) problems.push(`${where}.key[${at}] is not an object`); });
  }
  if (Object.hasOwn(place, 'may_reach')) {
    const reach = place.may_reach;
    if (!Array.isArray(reach)) problems.push(`${where}.may_reach is not a list`);
    else reach.forEach((host, at) => {
      if (typeof host !== 'string') problems.push(`${where}.may_reach[${at}] is not a text`);
      else if (host === '' || host !== host.trim()) problems.push(`${where}.may_reach[${at}] is not a host name`);
    });
  }
  if (Object.hasOwn(place, 'credential_injections')) {
    const items = place.credential_injections;
    if (!Array.isArray(items)) problems.push(`${where}.credential_injections is not a list`);
    else items.forEach((item, at) => {
      if (!isObject(item)) problems.push(`${where}.credential_injections[${at}] is not an object`);
      else if (Object.hasOwn(item, 'hosts')) problems.push(`${where}.credential_injections[${at}].hosts is an old field name`);
    });
  }
  return problems;
}

/** One line for each problem of one row payload's places. */
function rowProblems(label: string, payload: Payload): string[] {
  return (placesOf(payload) as [string, Json][]).flatMap(([where, place]) => (isObject(place)
    ? placeProblems(`${label} ${payload.id} ${where}`, place)
    : [`${label} ${payload.id} ${where} is not an object`]));
}

/** The payloads of one records list (`records`, or `things` in a listed file), each checked to be { payload } first. */
function payloadsOf(label: string, file: Json, key: 'records' | 'things', problems: string[]): Payload[] {
  if (!isObject(file)) { problems.push(`${label} is not an object`); return []; }
  const list = file[key];
  if (!Array.isArray(list)) { problems.push(`${label} has no ${key} list`); return []; }
  return list.flatMap((record, at) => {
    if (!isObject(record) || !isObject(record.payload)) { problems.push(`${label} ${key}[${at}] has no payload object`); return []; }
    const payload = record.payload;
    if (typeof payload.kind !== 'string' || typeof payload.id !== 'string') { problems.push(`${label} ${key}[${at}] has no text kind and id`); return []; }
    return [payload];
  });
}

test('no folder under tools holds a card under the old name', () => {
  const old = filesNamed(tools, OLD_CARD).map(path => relative(root, path));
  assert.deepEqual(old, [], `files still named ${OLD_CARD}: ${old.join(', ')}`);
  assert.ok(cards.length > 0, `the tools folders hold cards named ${CARD}`);
});

test('every card is a records list of row payloads that name their run with the new fields', () => {
  const problems: string[] = [];
  for (const folder of cards) {
    const label = `tools/${folder}/${CARD}`;
    for (const payload of payloadsOf(label, read(join(tools, folder, CARD)), 'records', problems)) problems.push(...rowProblems(label, payload));
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('a card\'s prepare and needs_tools, when present, are a list of texts and distinct tool folders', () => {
  const problems: string[] = [];
  const known = new Set(toolFolders);
  for (const folder of cards) {
    const label = `tools/${folder}/${CARD}`;
    const card = read(join(tools, folder, CARD));
    if (!isObject(card)) continue;
    if (Object.hasOwn(card, 'prepare')) {
      const prepare = card.prepare;
      if (!Array.isArray(prepare) || prepare.length === 0) problems.push(`${label} prepare is not a non-empty list`);
      else prepare.forEach((step, at) => { if (typeof step !== 'string' || step.trim() === '') problems.push(`${label} prepare[${at}] is not a text`); });
    }
    if (Object.hasOwn(card, 'needs_tools')) {
      const needs = card.needs_tools;
      if (!Array.isArray(needs)) problems.push(`${label} needs_tools is not a list`);
      else {
        needs.forEach((name, at) => {
          if (typeof name !== 'string') problems.push(`${label} needs_tools[${at}] is not a text`);
          else if (!known.has(name)) problems.push(`${label} needs_tools[${at}] names ${name}, which is not a tools folder`);
        });
        if (new Set(needs).size !== needs.length) problems.push(`${label} needs_tools names a folder twice`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the rows a tool-row-source lists use the new fields, from a file that is not named tool-rows.json', () => {
  const problems: string[] = [];
  let listed = 0;
  for (const folder of cards) {
    const label = `tools/${folder}/${CARD}`;
    for (const source of payloadsOf(label, read(join(tools, folder, CARD)), 'records', [])) {
      if (source.kind !== 'tool-row-source') continue;
      const list = isObject(source.list) && isObject(source.list.records) ? source.list.records : null;
      if (list === null) continue;
      if (typeof list.package !== 'string' || typeof list.kind !== 'string') { problems.push(`${source.id} list.records has no text package and kind`); continue; }
      const named = list.file === undefined ? 'records.json' : list.file;
      if (typeof named !== 'string') { problems.push(`${source.id} list.records.file is not a text`); continue; }
      if (named.split('/').at(-1) === OLD_CARD) problems.push(`${source.id} lists ${list.package}/${named}, the old name of a card`);
      const path = join(tools, list.package, named);
      if (!existsSync(path)) { problems.push(`${source.id} lists ${list.package}/${named}, which is missing`); continue; }
      const files = statSync(path).isDirectory() ? readdirSync(path).filter(name => name.endsWith('.json')).map(name => join(path, name)) : [path];
      for (const file of files) {
        const kept = read(file);
        const key = isObject(kept) && Array.isArray(kept.things) ? 'things' : 'records';
        for (const payload of payloadsOf(relative(root, file), kept, key, problems)) {
          if (payload.kind !== list.kind) continue;
          listed++;
          problems.push(...rowProblems(relative(root, file), payload));
        }
      }
    }
  }
  assert.ok(listed > 0, 'the cards list rows from records files');
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the test reader refuses each old name with words that name it', () => {
  const row: Payload = {
    kind: 'ai-tool-descriptor', id: 'tool:made-up',
    invoke: {
      kind: 'container', argv: ['node'], credential_mounts: [], internet: true, hosts: ['example.com'],
      by_input: { variants: { other: { credential_injections: [{ hosts: ['example.com'], placement: { kind: 'header', name: 'X' } }] } } },
    },
  };
  const words = oldFieldsOf(row) as string[];
  assert.ok(Array.isArray(words));
  for (const named of ['invoke.argv', 'invoke.credential_mounts', 'invoke.internet', 'invoke.hosts', 'invoke.by_input.variants.other.credential_injections[0].hosts']) {
    assert.ok(words.some(line => typeof line === 'string' && line.includes(named)), `the refusal names ${named}: ${words.join(' | ')}`);
  }
  assert.deepEqual(oldFieldsOf({ kind: 'ai-tool-descriptor', id: 'tool:new', invoke: { kind: 'container', run: ['node'], key: [], may_reach: ['example.com'] } }), []);

  const made = mkdtempSync(join(tmpdir(), 'old-card-name-'));
  mkdirSync(join(made, 'a-tool'));
  assert.equal(oldCardIn(made, 'a-tool'), null);
  writeFileSync(join(made, 'a-tool', OLD_CARD), '{"records":[]}');
  const refusal = oldCardIn(made, 'a-tool');
  assert.equal(typeof refusal, 'string');
  assert.ok(refusal.includes(`tools/a-tool/${OLD_CARD}`) && refusal.includes(CARD), refusal);
});
