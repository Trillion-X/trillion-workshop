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
import { parseDocument, readFrontmatter, writeFrontmatter, documentRowSources } from '../read-data/document-properties.mjs';
import { folderFiles } from '../read-data/folder-files.mjs';
import { changeDocumentRows, readDocumentRows, readNamespaceDocumentRows, splitIntoDocuments } from '../read-data/rows.mjs';
import { splitDocuments } from '../read-data/split.mjs';
import { contentRows } from '../read-data/content-rows.mjs';

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

test('an exact path catalogue reads only named documents and exclusions work for both metadata and content', async () => {
  const root = await chores();
  const scope = { root: join(root, 'chores'), paths: ['/chore-1.md', '/rooms/kitchen.md'], exclude: ['rooms/**'] };
  assert.deepEqual((await readDocumentRows(scope)).rows.map(row => row.id), ['/chore-1.md']);
  assert.deepEqual((await readDocumentRows({ ...scope, content: true })).rows.map(row => row.id), ['/chore-1.md']);
  await assert.rejects(readDocumentRows({ root: join(root, 'chores'), paths: ['/escape.md'] }), /not in the folder/);
  await assert.rejects(readDocumentRows({ root, paths: ['relative.md'] }), /exact document names/);
  await assert.rejects(readDocumentRows({ root, exclude: 'one.md' }), /array/);
});

test('explicit UTF-8 source extensions do not change ordinary folder selection or execute the source', async () => {
  const root = await scratch();
  const code = '# a source file, not executed\nraise RuntimeError("must never run")\n';
  await writeFile(join(root, 'check.py'), code);
  assert.equal((await readDocumentRows({ root })).rows.length, 0);
  const page = await readDocumentRows({ root, paths: ['/check.py'], text_extensions: ['py'], content: true });
  assert.equal(page.rows[0].values['document.text'], code);
  await assert.rejects(readDocumentRows({ root, paths: ['/check.py'] }), /declared text extensions/);
  await writeFile(join(root, 'bad.py'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readDocumentRows({ root, paths: ['/bad.py'], text_extensions: ['py'], content: true }), /not a complete UTF-8/);
});

test('a catalogue page probes only selected present names and lookahead, without hashing unrelated bodies', async () => {
  const root = await scratch();
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, `${name}.md`), `# ${name}\n`);
  const files = await folderFiles(root), entry = files.entry.bind(files), probes = [];
  files.entry = async (name, options) => {
    if (name.endsWith('.md')) probes.push({ name, identity: options?.identity });
    return entry(name, options);
  };
  const read = documentRowSources({ files }).sources.documents;
  const page = await read({ source: { of: '/', paths: ['/a.md', '/b.md', '/aa-missing.md', '/c.md'] }, cursor: '/a.md', limit: 1 });
  assert.deepEqual(page.rows.map(row => row.id), ['/b.md']);
  assert.equal(page.next_cursor, '/b.md');
  assert.deepEqual(probes, [{ name: '/aa-missing.md', identity: false }, { name: '/b.md', identity: false }, { name: '/c.md', identity: false }]);
  assert.match((await entry('/a.md')).identity, /^1f:[0-9a-f]{64}$/, 'ordinary identity reads retain their BLAKE3 proof');
});

test('extensionless UTF-8 files require an explicit positive path and empty declared extension', async () => {
  const root = await scratch();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'prompt'), 'Keep the full explanation.\n');
  await writeFile(join(root, 'nested', 'LICENSE'), 'Example licence words.\n');
  await writeFile(join(root, 'visible.md'), '# Normal document\n');
  assert.deepEqual((await readDocumentRows({ root, text_extensions: [''] })).rows.map(row => row.id), ['/visible.md']);
  await assert.rejects(readDocumentRows({ root, paths: ['/prompt'], content: true }), /declared text extensions/);
  const page = await readDocumentRows({ root, paths: ['/prompt', '/nested/LICENSE'], text_extensions: [''], content: true });
  assert.deepEqual(page.rows.map(row => row.id), ['/nested/LICENSE', '/prompt']);
  assert.equal(page.rows[0].values['document.text'], 'Example licence words.\n');
  assert.equal(page.rows[1].values['document.text'], 'Keep the full explanation.\n');
  await writeFile(join(root, 'catalogue.json'), JSON.stringify(['/nested/LICENSE', '/prompt']));
  assert.deepEqual((await readDocumentRows({ root, paths_file: '/catalogue.json', text_extensions: [''], content: true })).rows, page.rows);
  await writeFile(join(root, 'not-text'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readDocumentRows({ root, paths: ['/not-text'], text_extensions: [''], content: true }), /not a complete UTF-8/);
});

test('a resumed long-body cursor reads future text pieces without rereading earlier body ranges', async () => {
  const bytes = Buffer.from('A long café 🙂 source.\n'.repeat(10000));
  const row = { id: '/long.md', title: 'long', identity: 'one-stable-source', values: { 'file.size': bytes.length } };
  const asked = [];
  const files = { readSlice: async (identity, offset, length) => {
    asked.push({ offset, length });
    return { identity, bytes: bytes.subarray(offset, offset + length) };
  } };
  const metadataReads = [];
  const read = async ({ row_ids, cursor }) => {
    metadataReads.push({ row_ids, cursor });
    return { rows: row_ids || !cursor ? [row] : [], next_cursor: null };
  };
  const input = { folder: '/', limit: 3, content: { part_bytes: 1000 } };
  const first = await contentRows(files, read, input);
  assert.deepEqual(first.rows.map(one => one.values['document.part']), [1, 2, 3]);
  asked.length = 0;
  metadataReads.length = 0;
  const second = await contentRows(files, read, { ...input, after: first.next });
  assert.deepEqual(second.rows.map(one => one.values['document.part']), [4, 5, 6]);
  assert.equal(asked.length, 4, 'three returned pieces plus one bounded lookahead');
  assert.ok(asked.every(one => one.offset >= 2997), 'none of the earlier body ranges is read again');
  assert.deepEqual(metadataReads, [{ row_ids: ['/long.md'], cursor: undefined }], 'an unfinished body never reads following parent documents');
});

test('original BOM characters survive at the file start and at a bounded text-piece boundary', async () => {
  const root = await scratch();
  const text = '\ufeffA\ufeffB,C\n1,2\n';
  await writeFile(join(root, 'table.csv'), text);
  const rows = [];
  let after = null;
  do {
    const page = await readDocumentRows({ root, paths: ['/table.csv'], text_extensions: ['csv'], content: { part_bytes: 4 }, limit: 1, after });
    rows.push(...page.rows); after = page.next;
  } while (after);
  assert.equal(rows[0].values['document.text'][0], '\ufeff');
  assert.equal(rows[1].values['document.text'][0], '\ufeff');
  assert.deepEqual(Buffer.from(rows.map(row => row.values['document.text']).join('')), Buffer.from(text));
});

test('a granted filesystem root can read an exact positive catalogue without a recursive root listing', async () => {
  const folder = await scratch(), path = join(folder, 'one.md');
  await writeFile(path, 'one exact granted file\n');
  const page = await readDocumentRows({ root: '/', paths: [path], content: true });
  assert.deepEqual(page.rows.map(row => row.id), [path]);
  assert.equal(page.rows[0].values['document.text'], 'one exact granted file\n');
});

test('a bounded paths_file keeps a large positive catalogue out of the list record', async () => {
  const root = await chores();
  await writeFile(join(root, 'catalogue.json'), JSON.stringify(['/chores/chore-1.md', '/chores/rooms/kitchen.md']));
  const page = await readDocumentRows({ root, paths_file: '/catalogue.json', content: true });
  assert.deepEqual(page.rows.map(row => row.id), ['/chores/chore-1.md', '/chores/rooms/kitchen.md']);
  await assert.rejects(readDocumentRows({ root, paths_file: '/catalogue.json', paths: ['/chores/chore-1.md'] }), /instead of paths/);
  await writeFile(join(root, 'too-big.json'), ' '.repeat(262145));
  await assert.rejects(readDocumentRows({ root, paths_file: '/too-big.json' }), /existing .*byte document read bound/);
});

test('optional content keeps the same parent id and all metadata, with the complete small document', async () => {
  const root = await chores();
  const metadata = (await readDocumentRows({ root: join(root, 'chores'), match: 'chore-1.md' })).rows[0];
  const page = await readDocumentRows({ root: join(root, 'chores'), match: 'chore-1.md', content: true });
  const row = page.rows[0];
  assert.equal(row.id, metadata.id);
  for (const [key, value] of Object.entries(metadata.values)) assert.deepEqual(row.values[key], value, key);
  assert.equal(row.values['document.text'], await readFile(join(root, 'chores', 'chore-1.md'), 'utf8'));
  assert.equal(row.values['document.complete'], 'complete');
  assert.equal(row.values['document.part'], 1);
  assert.equal(row.values['document.parts'], 1);
  assert.equal(page.next, null);
});

test('explicit omission removes only regenerable caches, allowing bounded exact text while preserving authored fields', async () => {
  const root = await scratch();
  const text = '---\nname: Original name\ntags: [authored-tag]\n---\n' + Array.from({ length: 400 }, (_, index) => `[link ${index}](./${'a'.repeat(100)}-${index}.md)`).join('\n');
  await writeFile(join(root, 'links.md'), text);
  const metadata = (await readDocumentRows({ root })).rows[0];
  assert.equal(metadata.values['file.links'].length, 400);
  await assert.rejects(readDocumentRows({ root, content: { part_bytes: 4000 }, most_bytes: 12000 }), /bigger than most_bytes/);
  const rows = [];
  let after = null;
  do {
    const page = await readDocumentRows({ root, content: { part_bytes: 4000, omit_fields: ['file.links', 'file.tags'] }, most_bytes: 12000, after });
    rows.push(...page.rows); after = page.next;
  } while (after);
  assert.equal(rows.map(row => row.values['document.text']).join(''), text);
  assert.ok(rows.every(row => !Object.hasOwn(row.values, 'file.links')));
  assert.ok(rows.every(row => row.values['note.name'] === 'Original name'));
  assert.ok(rows.every(row => row.values['file.identity'] === metadata.values['file.identity']));
  assert.ok(rows.every(row => JSON.stringify(row.values['note.tags']) === '["authored-tag"]'));
  await assert.rejects(readDocumentRows({ root, content: { omit_fields: ['note.name'] } }), /source\/frontmatter fields/);
  await assert.rejects(readDocumentRows({ root, content: { field: 'file.links', omit_fields: ['file.links'] } }), /content text field/);
});

test('content beyond the metadata cap reconstructs byte-for-byte from bounded linked rows and opaque pages', async () => {
  const root = await scratch();
  const body = '---\nname: Long café notes\n---\n' + 'café 🙂 漢字\\\"\n'.repeat(18000) + 'END beyond the former metadata cap\n';
  await writeFile(join(root, 'long.md'), body);
  await writeFile(join(root, 'z.md'), 'after the long document\n');
  assert.ok(Buffer.byteLength(body) > 262144);
  const rows = [];
  let after = null;
  do {
    const page = await readDocumentRows({ root, content: { part_bytes: 4097 }, after, limit: 3, most_bytes: 20000 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 20000);
    assert.ok(page.rows.length > 0);
    rows.push(...page.rows); after = page.next;
  } while (after);
  const parts = rows.filter(row => row.values['document.parent'] === '/long.md');
  assert.equal(parts[0].id, '/long.md');
  assert.equal(parts[0].values['note.name'], 'Long café notes');
  assert.ok(parts.length > 1);
  assert.equal(parts.length, parts[0].values['document.parts']);
  assert.deepEqual(parts.map(row => row.values['document.part']), Array.from({ length: parts.length }, (_, index) => index + 1));
  assert.deepEqual(Buffer.from(parts.map(row => row.values['document.text']).join('')), Buffer.from(body));
  assert.ok(parts.every(row => row.values['document.complete'] === 'part of document'));
  assert.equal(rows.at(-1).id, '/z.md');
  const again = await readDocumentRows({ root, content: { part_bytes: 4097 }, limit: 3 });
  assert.deepEqual(again.rows, rows.slice(0, 3));
});

test('an unfinished content cursor refuses a changed document instead of combining two versions', async () => {
  const root = await scratch();
  await writeFile(join(root, 'notes.md'), 'before '.repeat(100));
  const first = await readDocumentRows({ root, content: { part_bytes: 100 }, limit: 1 });
  assert.ok(first.next.startsWith('document-content:'));
  await writeFile(join(root, 'notes.md'), 'after '.repeat(100));
  await assert.rejects(readDocumentRows({ root, content: { part_bytes: 100 }, after: first.next, limit: 1 }), /changed after it was read/);
});

test('section content reuses the split parser but retains every original byte, duplicate words and stable section ids', async () => {
  const root = await scratch();
  const text = '# Original\n\nPreface café.\n\n### Case A: First\n\nSame words.\n\n### Case B: Second\n\nSame words.\n\n## Between\n\nRemainder 🙂.\n\n### Case A: Repeated id\n\nSame words.\n\n';
  await writeFile(join(root, 'cases.md'), text);
  const sections = { heading: '^### Case (?<id>[A-Z]): (?<title>.*)$', row: '^(?<id>never)(?!)$', parts: { 'document:section': 'Source' } };
  const split = await splitDocuments({ ...sections, sources: [{ name: 'document', file: 'cases.md' }], raw_segments: true }, async () => text);
  assert.equal(split.segments.map(span => span.text).join(''), text);
  assert.equal(split.report.lines_in, split.report.lines_placed);
  assert.equal(split.segments[0].from_byte, 0);
  assert.equal(split.segments.at(-1).after_byte, Buffer.byteLength(text));
  assert.equal('segments' in await splitDocuments({ ...sections, sources: [{ name: 'document', file: 'cases.md' }] }, async () => text), false);
  const rows = [];
  let after = null;
  do {
    const page = await readDocumentRows({ root, content: { sections, part_bytes: 41 }, after, limit: 2, most_bytes: 10000 });
    rows.push(...page.rows); after = page.next;
  } while (after);
  assert.equal(rows[0].id, '/cases.md');
  assert.equal(rows[0].values['document.part'], 0, 'original parent retains metadata without copying the whole body again');
  assert.ok(rows.some(row => row.id === '/cases.md#section-A'));
  assert.ok(rows.some(row => row.id === '/cases.md#section-A-occurrence-00000002'));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  const content = rows.filter(row => row.values['document.part'] > 0).sort((a, b) => a.values['document.offset'] - b.values['document.offset']);
  assert.equal(content.map(row => row.values['document.text']).join(''), text);
  assert.ok(content.every(row => row.values['document.source'] === '/cases.md'));
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

test('Namespace content pieces join exact UTF-8 across both source and files-door byte pages', async () => {
  const text = '---\nname: café\n---\n' + 'a🙂é漢\n'.repeat(50);
  const { door } = namespaceDoor({ '/Notes/one.md': text }, 7);
  const rows = [];
  let after = null;
  do {
    const page = await readNamespaceDocumentRows({ folder: '/Notes', content: { part_bytes: 31 }, after, limit: 2 }, { door });
    rows.push(...page.rows); after = page.next;
  } while (after);
  assert.equal(rows[0].id, '/Notes/one.md');
  assert.equal(rows.map(row => row.values['document.text']).join(''), text);
  assert.equal(rows.length, rows[0].values['document.parts']);
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
