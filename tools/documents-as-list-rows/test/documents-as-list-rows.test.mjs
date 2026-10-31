// documents-as-list-rows on made-up chores and house rules: frontmatter read and write, a folder read a page at a time
// with no cap, a field changed only while the document is the one read, links and backlinks, nothing read outside the
// granted folder, and long documents split into one document per item. Needs node only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, readFrontmatter, writeFrontmatter } from '../read-data/document-properties.mjs';
import { changeDocumentRows, readDocumentRows, readNamespaceDocumentRows, splitIntoDocuments } from '../read-data/rows.mjs';

const command = fileURLToPath(new URL('../do-work/documents.mjs', import.meta.url));
const scratch = () => mkdtemp(join(tmpdir(), 'documents-as-list-rows-'));

test('frontmatter: scalars, lists, block lists and quoted text are read', () => {
  const text = '---\nstatus: open\ncount: 3\ndone: false\ntags: [kitchen, weekly]\nsteps:\n  - wash\n  - dry\nquote: "a: b"\n---\nbody\n';
  assert.deepEqual(readFrontmatter(text).properties,
    { status: 'open', count: 3, done: false, tags: ['kitchen', 'weekly'], steps: ['wash', 'dry'], quote: 'a: b' });
  assert.deepEqual(readFrontmatter('# Title\n\ntext\n').properties, {});
});

test('frontmatter: a change rewrites only its key, keeps comments and the body, quotes what is ambiguous', () => {
  const text = '---\nstatus: open\n# a note kept as written\nnested:\n  a: 1\nowner: Sam\n---\nbody stays\n';
  assert.equal(writeFrontmatter(text, { set: { status: 'done' } }), '---\nstatus: done\n# a note kept as written\nnested:\n  a: 1\nowner: Sam\n---\nbody stays\n');
  const added = writeFrontmatter('plain body\n', { set: { title: 'Keep: one place', tags: ['a', 'b'] } });
  assert.equal(added, '---\ntitle: "Keep: one place"\ntags:\n  - a\n  - b\n---\nplain body\n');
  assert.equal(writeFrontmatter('---\na: 1\nb: 2\n---\nx', { remove: ['a'] }), '---\nb: 2\n---\nx');
});

test('links and tags are read from the words', () => {
  const parsed = parseDocument('---\ntags: [home]\n---\nSee [[Rooms]] and [the plan](../plan.md), #weekly. Not https://example.org.');
  assert.deepEqual(parsed.links.map(link => link.target), ['Rooms', '../plan.md']);
  assert.deepEqual(parsed.tags.sort(), ['home', 'weekly']);
});

async function chores() {
  const root = await scratch();
  await mkdir(join(root, 'chores', 'rooms'), { recursive: true });
  for (let number = 1; number <= 7; number += 1) await writeFile(join(root, 'chores', `chore-${number}.md`), `---\nchore: chore ${number}\nevery: week\n---\nSee [[kitchen]].\n`);
  await writeFile(join(root, 'chores', 'rooms', 'kitchen.md'), '---\nroom: kitchen\n---\n');
  await writeFile(join(root, 'chores', 'rooms', 'picture.png'), 'not a document');
  await mkdir(join(root, 'chores', '.hidden'));
  await writeFile(join(root, 'chores', '.hidden', 'skip.md'), '---\nx: 1\n---\n');
  await writeFile(join(root, 'outside.md'), '---\nsecret: yes\n---\n');
  await symlink(join(root, 'outside.md'), join(root, 'chores', 'escape.md'));
  return root;
}

test('a folder is read a page at a time, in name order, with no cap; hidden folders and outside links are left out', async () => {
  const root = await chores();
  const seen = [];
  let after = null;
  do {
    const page = await readDocumentRows({ root: join(root, 'chores'), after, limit: 3 });
    seen.push(...page.rows.map(row => row.id));
    after = page.next;
  } while (after);
  assert.equal(seen.length, 8);
  assert.deepEqual(seen, [...seen].sort());
  assert.ok(seen.includes('/rooms/kitchen.md'));
  assert.ok(!seen.includes('/escape.md'));
});

test('most_bytes ends a page at the last row that fits, and the next page goes on from there', async () => {
  const root = await chores();
  const whole = await readDocumentRows({ root: join(root, 'chores'), limit: 8 });
  const room = Buffer.byteLength(JSON.stringify({ rows: whole.rows.slice(0, 3), next: whole.rows[2].id }));
  const first = await readDocumentRows({ root: join(root, 'chores'), limit: 8, most_bytes: room });
  assert.deepEqual(first.rows.map(row => row.id), whole.rows.slice(0, 3).map(row => row.id));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= room);
  const rest = await readDocumentRows({ root: join(root, 'chores'), limit: 8, after: first.next });
  assert.deepEqual([...first.rows, ...rest.rows].map(row => row.id), whole.rows.map(row => row.id));
  await assert.rejects(readDocumentRows({ root: join(root, 'chores'), most_bytes: 10 }), /bigger than most_bytes/);
});

test('a row holds its properties, its file facts and its identity; a glob keeps some documents', async () => {
  const root = await chores();
  const [row] = (await readDocumentRows({ root: join(root, 'chores'), limit: 1 })).rows;
  assert.equal(row.id, '/chore-1.md');
  assert.equal(row.values['note.chore'], 'chore 1');
  assert.equal(row.values['file.basename'], 'chore-1');
  assert.match(row.values['file.identity'], /^1f:[0-9a-f]{64}$/);
  const kept = await readDocumentRows({ root: join(root, 'chores'), match: 'rooms/*.md' });
  assert.deepEqual(kept.rows.map(one => one.id), ['/rooms/kitchen.md']);
});

test('backlinks are worked out across the whole folder when asked for', async () => {
  const root = await chores();
  const page = await readDocumentRows({ root: join(root, 'chores'), match: 'rooms/*.md', backlinks: true });
  assert.equal(page.rows[0].values['file.backlinks'].length, 7);
});

test('a field changes only while the document is the one read', async () => {
  const root = await chores();
  const [row] = (await readDocumentRows({ root: join(root, 'chores'), match: 'chore-2.md' })).rows;
  const changed = await changeDocumentRows({ root: join(root, 'chores'), rows: [{ id: row.id, values: { 'note.every': 'day' }, if_identity: row.identity }] });
  assert.equal(changed.kept[0].values['note.every'], 'day');
  assert.equal(await readFile(join(root, 'chores', 'chore-2.md'), 'utf8'), '---\nchore: chore 2\nevery: day\n---\nSee [[kitchen]].\n');
  await assert.rejects(changeDocumentRows({ root: join(root, 'chores'), rows: [{ id: row.id, values: { 'note.every': 'month' }, if_identity: row.identity }] }), /changed after it was read/);
  await assert.rejects(changeDocumentRows({ root: join(root, 'chores'), rows: [{ id: '/../outside.md', values: { 'note.a': 'b' } }] }), /not .* in this folder|not in the folder/);
  await assert.rejects(changeDocumentRows({ root: join(root, 'chores'), rows: [{ id: '/chore-3.md', values: { 'file.size': 1 } }] }), /cannot be written/);
});

const MAPPING = {
  sources: [{ name: 'long', file: 'rules-long.md' }, { name: 'short', file: 'rules-short.md' }],
  heading: '^#{1,4}\\s+(?<id>R\\d{2})(?:\\s*[:—-]\\s*|\\s*$)(?<title>.*?)\\s*(?:\\((?<date>\\d{4}-\\d\\d-\\d\\d)\\))?\\s*$',
  row: '^\\|\\s*(?<id>R\\d{2})\\s*\\|\\s*(?:\\*\\*(?<title>.+?)\\*\\*\\s*)?(?<text>.*?)\\s*\\|\\s*$',
  group_heading: '^##\\s+Level\\s+(?<level>\\d)\\b',
  flags: { tags: ['MUST'] },
  first_sentence_when_missing: ['title'],
  prefer: ['short:row', 'short:grouped-row', 'long:section'],
  parts: { 'short:row': 'Rule', 'long:section': 'Write-up', 'short:grouped-row': 'Short form' },
  field_order: ['title', 'level', 'date', 'tags'],
  order_by: '^R(\\d+)',
};
const LONG = `# House rules, written out

## R01: Shoes Off At The Door (2026-01-02)

### Why
\`\`\`
# not a heading: inside a fence
\`\`\`
You MUST leave shoes on the rack.

### R02 Relation
A sub-heading naming another rule stays in this one.

## R02 — Lights Out By Eleven

Quiet after eleven.

## Notes that are no rule
Kept as leftover text.
`;
const SHORT = `# House rules, short

| R01 | **SHOES OFF AT THE DOOR.** Rack by the door. |
| R03 | Water the plants on Sunday. Use the blue can. |

## Level 2

| R02 | **LIGHTS OUT BY ELEVEN.** Quiet hours. |
| R01 | **SHOES OFF AT THE DOOR.** Rack by the door. |
`;

async function rules() {
  const root = await scratch();
  await writeFile(join(root, 'rules-long.md'), LONG);
  await writeFile(join(root, 'rules-short.md'), SHORT);
  await writeFile(join(root, 'mapping.json'), JSON.stringify(MAPPING));
  return root;
}

test('a split places every line, merges pieces by id and writes identical words once', async () => {
  const root = await rules();
  const report = await splitIntoDocuments({ root, mapping: 'mapping.json', check: true });
  assert.equal(report.lines_in, report.lines_placed);
  assert.equal(report.items, 3);
  assert.equal(report.identical_pieces_merged, 1);
});

test('the split command writes one document per item and the leftover, and refuses a used folder', async () => {
  const root = await rules();
  const run = () => spawnSync(process.execPath, [command, 'split', '--root', root, '--mapping', 'mapping.json', '--out', 'rules', '--leftover', 'rest'], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual((await readdir(join(root, 'rules'))).sort(), ['R01.md', 'R02.md', 'R03.md']);
  const document = await readFile(join(root, 'rules', 'R01.md'), 'utf8');
  assert.ok(document.startsWith('---\nid: R01\ntitle: SHOES OFF AT THE DOOR.\nlevel: 2\ndate: 2026-01-02\ntags:\n  - MUST\n---\n'), document);
  assert.match(document, /# not a heading: inside a fence/);
  assert.match(document, /A sub-heading naming another rule stays in this one\./);
  assert.match(await readFile(join(root, 'rules', 'R03.md'), 'utf8'), /title: Water the plants on Sunday\./);
  assert.match(await readFile(join(root, 'rest', 'long.md'), 'utf8'), /Kept as leftover text\./);
  assert.equal(run().status, 2);
});

test('a JSON list splits into one document per item: plain values as fields, the rest under headings, the remainder kept', async () => {
  const root = await scratch();
  const garden = { about: 'made-up garden notes', plants: [
    { name: 'basil', water: 'daily', sun: 6, tags: ['herb', 'kitchen'], note: 'Pinch the tops.\nKeep it warm.', pests: [{ name: 'aphids' }] },
    { name: 'mint', water: 'weekly', sun: 3 },
  ] };
  await writeFile(join(root, 'garden.json'), JSON.stringify(garden));
  const mapping = { sources: [{ name: 'garden', file: 'garden.json' }], items_at: 'plants', id: '{name}-{#}', parts: { note: 'Note' }, field_order: ['name'] };
  await writeFile(join(root, 'mapping.json'), JSON.stringify(mapping));
  const report = await splitIntoDocuments({ root, mapping: 'mapping.json', out: 'plants', leftover: 'rest' });
  assert.deepEqual(report, { items: 2, items_in: 2, leftover_documents: 1 });
  const basil = await readFile(join(root, 'plants', 'basil-1.md'), 'utf8');
  assert.ok(basil.startsWith('---\nid: basil-1\nname: basil\nsun: 6\ntags:\n  - herb\n  - kitchen\nwater: daily\n---\n'), basil);
  assert.match(basil, /## Note\n\nPinch the tops\.\nKeep it warm\./);
  assert.match(basil, /## pests\n\n```json\n\[\n  \{\n    "name": "aphids"/);
  assert.deepEqual(readFrontmatter(await readFile(join(root, 'plants', 'mint-2.md'), 'utf8')).properties, { id: 'mint-2', name: 'mint', sun: 3, water: 'weekly' });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'rest', 'garden.json'), 'utf8')), { about: 'made-up garden notes' });
  await writeFile(join(root, 'mapping.json'), JSON.stringify({ ...mapping, id: 'plant' }));
  await assert.rejects(splitIntoDocuments({ root, mapping: 'mapping.json', check: true }), /Two items make the id plant/);
});

// A made-up Namespace behind the files door's list_files and read_file, answering reads in small pages the way the door
// does: text as utf-8, a page cut inside a character as base64.
function namespaceDoor(documents, pageBytes = 7) {
  const asked = [];
  const files = async (operation, input) => {
    asked.push([operation, input]);
    if (operation === 'list_files') {
      const folder = input.folder.replace(/\/$/, '');
      const names = Object.keys(documents).filter(name => name.startsWith(`${folder}/`) && !name.slice(folder.length + 1).includes('/')).sort()
        .filter(name => !input.after || name > input.after);
      const folders = input.after ? [] : [...new Set(Object.keys(documents).filter(name => name.startsWith(`${folder}/`)).map(name => name.slice(folder.length + 1))
        .filter(rest => rest.includes('/')).map(rest => `${folder}/${rest.split('/')[0]}`))];
      const shown = names.slice(0, input.limit ?? 50);
      return { names: shown.map(name => ({ name, identity: `id-${name}`, byte_length: Buffer.byteLength(documents[name]) })), next_after: shown.length < names.length ? shown.at(-1) : null, folders };
    }
    if (operation === 'read_file') {
      const bytes = Buffer.from(documents[input.name_or_identity]);
      const part = bytes.subarray(input.offset, input.offset + Math.min(input.length ?? pageBytes, pageBytes));
      const text = new TextDecoder('utf-8', { fatal: true });
      let encoding = 'utf-8', content;
      try { content = text.decode(part); } catch { encoding = 'base64'; content = part.toString('base64'); }
      return { identity: `id-${input.name_or_identity}`, byte_length: bytes.length, offset: input.offset, bytes_returned: part.length, encoding, content };
    }
    throw new Error(`no operation ${operation}`);
  };
  return { door: { files }, asked };
}

test('Namespace documents are rows too: read by name through the run\'s files door, page after page, a cut character kept whole', async () => {
  const { door, asked } = namespaceDoor({
    '/Garden/basil.md': '---\nplant: basil\nnote: café crème\n---\nWater daily.\n',
    '/Garden/beds/mint.md': '---\nplant: mint\n---\n',
    '/Kitchen/bread.md': '---\nplant: none\n---\n',
  });
  const page = await readNamespaceDocumentRows({ folder: '/Garden' }, { door });
  assert.deepEqual(page.rows.map(row => row.id), ['/Garden/basil.md', '/Garden/beds/mint.md']);
  assert.equal(page.rows[0].values['note.note'], 'café crème');
  assert.ok(asked.every(([, input]) => !String(input.name_or_identity ?? '').startsWith('id-')), 'every read is by name');
  await assert.rejects(readNamespaceDocumentRows({ folder: '/Garden' }, {}), /no records door with files/);
});

test('the rows command pages and the set command refuses a stale identity with exit 1', async () => {
  const root = await chores();
  const rows = spawnSync(process.execPath, [command, 'rows', '--root', join(root, 'chores'), '--limit', '2'], { encoding: 'utf8' });
  assert.equal(rows.status, 0, rows.stderr);
  const page = JSON.parse(rows.stdout);
  assert.equal(page.rows.length, 2);
  assert.equal(page.next, '/chore-2.md');
  const stale = spawnSync(process.execPath, [command, 'set', '--root', join(root, 'chores'), '--path', '/chore-1.md', '--if-identity', `1f:${'0'.repeat(64)}`, '--set', 'every="day"'], { encoding: 'utf8' });
  assert.equal(stale.status, 1, stale.stderr);
});

test('with --stdin the input comes as JSON and the root only from the command, as a Workshop row runs it', async () => {
  const root = await chores();
  const input = JSON.stringify({ root: '/', match: 'rooms/*.md' });
  const rows = spawnSync(process.execPath, [command, 'rows', '--root', join(root, 'chores'), '--stdin'], { input, encoding: 'utf8' });
  assert.equal(rows.status, 0, rows.stderr);
  assert.deepEqual(JSON.parse(rows.stdout).rows.map(row => row.id), ['/rooms/kitchen.md']);
});
