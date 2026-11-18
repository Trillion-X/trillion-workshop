// test-helpers/named-calls.mjs
//
// Purpose: find every call the Workshop's shipped text names that nothing answers. Text an AI reads (what it is told on
// connect, workflow steps, kits, tool descriptions, READMEs) names three kinds of call: a door operation (`@address` with
// a method such as `tools:run`), a tool (`tool:<id>`) and a workflow (`workflow:<id>`). A door operation answers only when
// tools/tell-ais-how-to-act/door-calls.json lists its pair (the Workshop's statement of the door it relies on; the engine
// confirms that list against what it answers); a tool answers only when a row of the Workshop has its id and every right
// its run asks for is one the door offers (else the engine withholds the row), and a workflow when a row has its id.
// A name left behind when its owner moved or was deleted is a finding.
//
// Non-Negotiable Invariants:
//   1. Read from git objects at `ref`, never the working tree, so a gate judges the commit being pushed.
//   2. No address, method, tool or kind of text is named here: the answered pairs, ids and files all come from the tree.
//   3. Text under a folder's `test/` (made-up ids) and `from-an-older-version/` (kept copies of old code) is evidence,
//      not something an AI is told, and is not read.
//
//   namedCallFindings({ repo, ref }) → { files: { "<path>": [names nothing answers] }, counts: { "<path>": n }, total }
//
// Run `node test-helpers/named-calls.mjs [ref] [--write]` to print the counts, or (--write) to rewrite
// test/named-calls-nothing-answers.json from them.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOOR_CALLS = 'tools/tell-ais-how-to-act/door-calls.json';
// A door call is a family:verb (or family.verb) written where a call is: a `method` or `operation` field, a right's
// `operations`, right after an address, or in words ("call X", "with X", "X at @address"). A row id (`record:x:y`), a
// file name or a tool or workflow id is never one.
const OP = String.raw`((?!tool:|workflow:)[a-z][a-z-]*[:.][a-z][a-z_-]*)(?![\w:.-])`;
const CALLS = [
  new RegExp(String.raw`\\?"(?:method|operation)\\?"\s*:\s*\\?"` + OP, 'g'),
  new RegExp(String.raw`@[a-z][a-z0-9-]*,?\s+` + OP, 'g'),
  new RegExp(String.raw`\b(?:call|calls|calling|with|use|uses|using|through|via)\s+` + OP, 'g'),
  new RegExp(OP + String.raw`\s+(?:at|on)\s+@`, 'g'),
];
const ADDRESSED = /(?:"address"\s*:\s*"|\bat\s+|\baddress\s+)@([a-z][a-z0-9-]*)/g;
const TOOL = /(?<![\w-])tool:([a-z0-9][a-z0-9:_.-]*[a-z0-9])/g;
const FLOW = /(?<![\w-])workflow:([a-z0-9][a-z0-9-]*[a-z0-9])/g;

const git = (repo, args, input) => execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 1 << 30 });

/** Every blob named, read by one git process: { path: text }. */
function blobs(repo, ref, paths) {
  const out = git(repo, ['cat-file', '--batch'], paths.map(p => `${ref}:${p}\n`).join(''));
  const texts = {};
  let at = 0;
  for (const path of paths) {
    const end = out.indexOf(10, at);
    const head = out.subarray(at, end).toString().split(' ');
    if (head.at(-1) === 'missing') { at = end + 1; continue; }
    const size = Number(head[2]);
    texts[path] = out.subarray(end + 1, end + 1 + size).toString('utf8');
    at = end + 1 + size + 1;
  }
  return texts;
}

const idsOf = (value, prefix, out, runs = () => true) => {
  if (Array.isArray(value)) for (const item of value) idsOf(item, prefix, out, runs);
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.id.startsWith(prefix) && (value.invoke || value.input_schema || value.steps || value.definition || value.definitions) && runs(value)) out.add(value.id.slice(prefix.length));
    for (const item of Object.values(value)) idsOf(item, prefix, out, runs);
  }
  return out;
};
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };
/** Every tool row in a value whose run asks the door for records rights. */
const rowsIn = (value, out = []) => {
  if (Array.isArray(value)) for (const item of value) rowsIn(item, out);
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.id.startsWith('tool:') && value.invoke?.records && typeof value.invoke.records === 'object') out.push(value);
    for (const item of Object.values(value)) rowsIn(item, out);
  }
  return out;
};

export function namedCallFindings({ repo, ref = 'HEAD' } = {}) {
  const files = git(repo, ['ls-tree', '-r', '--name-only', ref, 'tools']).toString().split('\n')
    .filter(path => /\.(json|md)$/.test(path) && !/(^|\/)(node_modules|test|from-an-older-version)\//.test(path));
  const texts = blobs(repo, ref, files);
  const door = parsed(texts[DOOR_CALLS] ?? 'null')?.calls ?? [];
  // A row whose run asks for a right the door does not offer is withheld by the engine and refuses every run, so it
  // answers nothing: each right is a held secret's, or names a pair door-calls.json lists.
  const offered = right => 'secret' in right || (right.operations ?? []).every(method => door.some(([address, named]) => address === right.at && named === method));
  const runs = row => (row.invoke?.records?.rights ?? []).every(offered);
  const tools = new Set(), flows = new Set();
  for (const text of Object.values(texts)) {
    if (!/"(tool|workflow):/.test(text)) continue;
    const value = parsed(text);
    if (value) { idsOf(value, 'tool:', tools, runs); idsOf(value, 'workflow:', flows); }
  }
  // The published workflow view names its rows without the prefix.
  for (const text of Object.values(texts)) {
    const value = parsed(text);
    if (value?.source?.view === 'workflow-catalog' || value?.source?.list === 'workflows') for (const row of value.rows ?? []) if (typeof row.id === 'string') flows.add(row.id.replace(/^workflow:/, ''));
  }
  const addresses = new Set(door.map(([address]) => address));
  const answers = method => door.some(([, named]) => named === method);
  const found = {};
  for (const [path, text] of Object.entries(texts)) {
    const dead = [];
    for (const [, address] of text.matchAll(ADDRESSED)) if (!addresses.has(`@${address}`)) dead.push(`@${address}`);
    // One written call is counted once, whichever ways of writing it find it.
    const at = new Map();
    for (const pattern of CALLS) for (const match of text.matchAll(pattern)) at.set(match.index + match[0].indexOf(match[1]), match[1]);
    for (const method of at.values()) if (!answers(method)) dead.push(method);
    // A run's rights ask the engine's door: each operation a row's invoke.records.rights names that the door does not list.
    for (const row of rowsIn(parsed(text))) for (const right of row.invoke.records.rights ?? []) if (!offered(right)) for (const method of right.operations ?? []) dead.push(method);
    for (const [, id] of text.matchAll(TOOL)) if (!tools.has(id)) dead.push(`tool:${id}`);
    for (const [, id] of text.matchAll(FLOW)) if (!flows.has(id)) dead.push(`workflow:${id}`);
    if (dead.length) found[path] = dead;
  }
  const counts = Object.fromEntries(Object.entries(found).map(([path, dead]) => [path, dead.length]).sort());
  return { files: found, counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const { counts, total } = namedCallFindings({ repo, ref: args.find(arg => !arg.startsWith('--')) ?? 'HEAD' });
  if (args.includes('--write')) {
    writeFileSync(new URL('../test/named-calls-nothing-answers.json', import.meta.url), `${JSON.stringify({
      _what: 'How many calls the shipped text names that nothing answers (test-helpers/named-calls.mjs). It may only go down: test/every-named-call-resolves.test.mjs fails when the count is higher, and names what the files changed since this file was last written add. Rewrite it with `node test-helpers/named-calls.mjs <ref> --write` after a landing that removes some; the outcome is 0.',
      total }, null, 1)}\n`);
  }
  console.log(JSON.stringify({ total, files: Object.keys(counts).length }));
}
