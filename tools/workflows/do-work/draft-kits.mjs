// tools/workflows/do-work/draft-kits.mjs
//
// Burns down test/items-without-a-kit.json: for the items still on it, draft each kit from the item's own row
// (read-data/draft-a-kit.mjs), write the whole ones beside their items and take their ids off the list. An item whose draft
// is refused stays on the list, and its refusal is its gap: printed as JSON for the workflow-gaps rows (--gaps FILE writes it).
//
//   node tools/workflows/do-work/draft-kits.mjs [--write] [--batch N] [--gaps FILE]
//     without --write nothing is written; --batch N takes the first N whole drafts in list order (all when left out)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OWED_FILE, items } from '../../../test-helpers/every-item-kit.mjs';
import { draftKit } from '../read-data/draft-a-kit.mjs';
import { HOST_TOOLS } from '../read-data/recipe-problems.mjs';

const argv = process.argv.slice(2);
const flag = name => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
const write = argv.includes('--write');
const batch = flag('--batch') ? Number(flag('--batch')) : Infinity;

const owed = JSON.parse(readFileSync(OWED_FILE, 'utf8'));
const owing = new Map(items().filter(item => item.problems === null).map(item => [item.id, item]));
const known = new Set([...items().map(item => item.id), ...HOST_TOOLS]);
const done = [];
const gaps = [];
for (const id of [...owed.workflows, ...owed.tools]) {
  const item = owing.get(id);
  if (!item) continue;
  const { kit, problems } = draftKit({ [item.kind === 'tool' ? 'tool' : 'recipe']: item.item, known });
  if (problems.length) { gaps.push({ id, kind: item.kind, problems }); continue; }
  if (done.length >= batch) continue;
  done.push(id);
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
console.log(JSON.stringify({ drafted: done.length, written: write, still_owing: owed.workflows.length + owed.tools.length, gaps: gaps.length }));
