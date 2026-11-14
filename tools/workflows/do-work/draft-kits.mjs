// tools/workflows/do-work/draft-kits.mjs
//
// Burns down test/items-without-a-kit.json: for the items still on it, run each tool's own sample runs here
// (test-helpers/kit-drafter/observe.mjs), draft each kit from the item's own row and those real answers
// (read-data/draft-a-kit.mjs), write the whole ones beside their items and take their ids off the list. An item whose draft
// is refused stays on the list, and its refusal is its gap: printed as JSON for the workflow-gaps rows (--gaps FILE writes it).
// --redraft also re-drafts a kit already written as a draft (draft: true) when the new draft is whole, so an older draft
// whose example only described its answer now shows the answer the tool really gave. A kit a person wrote is never touched.
//
//   node tools/workflows/do-work/draft-kits.mjs [--write] [--redraft] [--batch N] [--gaps FILE]
//     without --write nothing is written; --batch N takes the first N whole drafts in list order (all when left out)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OWED_FILE, items } from '../../../test-helpers/every-item-kit.mjs';
import { observeAll } from '../../../test-helpers/kit-drafter/observe.mjs';
import { draftKit } from '../read-data/draft-a-kit.mjs';
import { HOST_TOOLS } from '../read-data/recipe-problems.mjs';

const argv = process.argv.slice(2);
const flag = name => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
const write = argv.includes('--write');
const redraft = argv.includes('--redraft');
const batch = flag('--batch') ? Number(flag('--batch')) : Infinity;

const owed = JSON.parse(readFileSync(OWED_FILE, 'utf8'));
const all = items();
const byId = new Map(all.map(item => [item.id, item]));
const known = new Set([...all.map(item => item.id), ...HOST_TOOLS]);
const isDraft = item => item.problems !== null && JSON.parse(readFileSync(item.file, 'utf8')).draft === true;
// The lists other kits here already define, by list id, for any item that names one of them.
const keptLists = new Map();
for (const entry of all.filter(item => item.problems !== null)) for (const list of JSON.parse(readFileSync(entry.file, 'utf8')).lists ?? []) if (!keptLists.has(list.list)) keptLists.set(list.list, list);
for (const list of JSON.parse(readFileSync(new URL('../kit-lists.json', import.meta.url), 'utf8')).lists) if (!keptLists.has(list.list)) keptLists.set(list.list, list);
// The items on the list first, then any item with no kit that landed without one.
const chosen = [...new Set([...owed.workflows, ...owed.tools, ...all.filter(item => item.problems === null).map(item => item.id)])].map(id => byId.get(id)).filter(item => item && item.problems === null);
if (redraft) chosen.push(...all.filter(item => !chosen.includes(item) && existsSync(item.file) && isDraft(item)));

// Each tool's samples run once: the chosen tools and every tool a chosen workflow's steps run.
const toRun = new Map();
for (const item of chosen) {
  if (item.kind === 'tool') toRun.set(item.id, item.item);
  else for (const step of item.item.steps ?? []) if (byId.get(step.run_tool?.tool_id)?.kind === 'tool') toRun.set(step.run_tool.tool_id, byId.get(step.run_tool.tool_id).item);
}
const observed = await observeAll([...toRun.values()]);

const done = [];
const redrafted = [];
const gaps = [];
for (const item of chosen) {
  const { kit, problems } = draftKit({ [item.kind === 'tool' ? 'tool' : 'recipe']: item.item, known, keptLists, observed: item.kind === 'tool' ? observed.get(item.id) : observed });
  const owing = item.problems === null;
  if (problems.length) { if (owing) gaps.push({ id: item.id, kind: item.kind, problems }); continue; }
  if (owing && done.length >= batch) continue;
  (owing ? done : redrafted).push(item.id);
  if (write) {
    mkdirSync(dirname(item.file), { recursive: true });
    writeFileSync(item.file, `${JSON.stringify(kit, null, 2)}\n`);
  }
}
if (write) {
  const out = new Set(done);
  owed.workflows = owed.workflows.filter(id => !out.has(id));
  owed.tools = owed.tools.filter(id => !out.has(id));
  writeFileSync(OWED_FILE, `${JSON.stringify(owed, null, 1)}\n`);
}
if (flag('--gaps')) writeFileSync(flag('--gaps'), `${JSON.stringify(gaps, null, 1)}\n`);
const left = owed.workflows.length + owed.tools.length - (write ? 0 : done.filter(id => owed.workflows.includes(id) || owed.tools.includes(id)).length);
console.log(`Drafted ${done.length} new kit${done.length === 1 ? '' : 's'}${redraft ? ` and re-drafted ${redrafted.length}` : ''}${write ? '' : ' (nothing written: add --write)'}. ${gaps.length} item${gaps.length === 1 ? '' : 's'} have a gap the item's own rows cannot fill. ${left} item${left === 1 ? '' : 's'} still have no kit.`);
