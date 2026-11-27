// tools/check-against-a-persons-rules-and-verdicts: the two piece rows at the sizes measured on a person's real Checks
// list (Nov 4, 2026): a list of 40,707 rows of which 39,088 are pieces, and whole documents of 31 KB and 120 KB with ```
// and ~~~ fences. Every row, file and word here is made up. Each row runs as the container runs it
// (test-helpers/run-a-row.mjs), under the heap of the row's needs.memory_mb. The coverage row is handed its check rows
// as input (`records`); the split row reads its document by name through the run's host (a stub here, in process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRow } from '../../../test-helpers/run-a-row.mjs';
import { pieceRows, splitIntoPieces } from '../do-work/pieces.mjs';
import SETTINGS from '../read-data/pieces.json' with { type: 'json' };

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const rowOf = id => rows.find(row => row.id === id);
const DOOR_MESSAGE = 65_536;
// The engine's door cuts a list page at what fits one message; the stand-in cuts it a little under that.
const door = { pageBytes: 60_000, mostRequestBytes: DOOR_MESSAGE };

// A row run with its heap held well under what the row's container has (old space memory_mb - 80, young space 2 MB),
// its peak resident memory read from its own exit.
async function runHeld(row, input, sample) {
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--max-old-space-size=${row.needs.memory_mb - 80} --max-semi-space-size=2 --require ${resolve(import.meta.dirname, 'peak-memory.cjs')}`;
  const started = Date.now();
  try {
    const ran = await runRow(row, input, { doorOptions: door, ...sample });
    const peak = Number(ran.stderr.match(/peak_rss_kb (\d+)/)?.[1]);
    return { ...ran, peak_kb: peak, peak_mb: Math.round(peak / 1024), ms: Date.now() - started, answer_bytes: Buffer.byteLength(ran.stdout.trim().split('\n').at(-1)) };
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 40,707 rows: 1,619 checks and 39,088 pieces over 140 made-up files. Piece n is checked (n % 4 == 0), has a reason
// (1), has nothing (2), or names a check that does not exist (3); every tenth piece also stands in the next file.
const PIECES = 39_088, CHECKS = 1_619, FILES = 140;
const fileName = n => `made-up/file-${String(n % FILES).padStart(3, '0')}.md`;
const pieceId = n => `piece-${n.toString(16).padStart(24, '0')}`;
function madeUpList() {
  const records = [];
  for (let c = 0; c < CHECKS; c += 1) {
    const id = `made-up-check-${String(c).padStart(4, '0')}`;
    records.push({ id: `record:check:${id}`, type: 'record:check', value: { id, part_of: 'made-up-base', says: `Made-up check ${c}`, words: ['made-up'] } });
  }
  for (let n = 0; n < PIECES; n += 1) {
    const sources = [{ file: fileName(n), section: `Made-up part ${n % 97} / Made-up rule ${n}`, file_identity: `1f:${'c'.repeat(64)}`, at: 1 + (n % 400) }];
    if (n % 10 === 0) sources.push({ ...sources[0], file: fileName(n + 1) });
    const value = { id: pieceId(n), kind: 'piece', says: `Made-up rule ${n}`, identity: `1f:${n.toString(16).padStart(64, '0')}`, key: sources[0].section,
      text: `**Made-up rule ${n}.** ${'Made-up words said plainly about a made-up thing, so a check can be written from them. '.repeat(3)}`,
      sources, tags: [], kinds: [], checked_by: [] };
    if (n % 4 === 0) value.checked_by = [`made-up-check-${String(n % CHECKS).padStart(4, '0')}`];
    if (n % 4 === 1) value.no_check = { reason: 'A made-up aside, not a rule.' };
    if (n % 4 === 3) value.checked_by = [`made-up-gone-${n}`];
    records.push({ id: `record:check:${value.id}`, type: 'record:check', value });
  }
  return records;
}

// What the list holds, counted from the way it was made, not by the coverage.
function expected() {
  const files = new Map();
  const add = (file, how) => { const entry = files.get(file) ?? { pieces: 0, with_check: 0, with_reason: 0, uncovered: 0 }; entry.pieces += 1; entry[how] += 1; files.set(file, entry); };
  for (let n = 0; n < PIECES; n += 1) {
    const how = n % 4 === 0 ? 'with_check' : n % 4 === 1 ? 'with_reason' : 'uncovered';
    add(fileName(n), how);
    if (n % 10 === 0) add(fileName(n + 1), how);
  }
  const sum = key => [...files.values()].reduce((total, entry) => total + entry[key], 0);
  return { files, totals: { files: files.size, pieces: sum('pieces'), with_check: sum('with_check'), with_reason: sum('with_reason'), uncovered: sum('uncovered') } };
}

test('tool:check-every-piece-is-covered finishes on a 40,707-row list (39,088 pieces) handed in as its records, under its heap', { timeout: 600_000 }, async t => {
  const records = madeUpList();
  assert.equal(records.length, 40_707);
  assert.equal(records.filter(record => record.value.kind === 'piece').length, 39_088);
  const want = expected();
  const row = rowOf('tool:check-every-piece-is-covered');
  const ran = await runHeld(row, { records }, {});
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  const answer = ran.last.result;
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.totals, want.totals);
  assert.deepEqual(answer.missing_count, { checks: PIECES / 4, covered_by: 0 });
  assert.ok(ran.answer_bytes <= SETTINGS.answer.most_bytes, `the answer is ${ran.answer_bytes} bytes`);
  assert.ok(ran.peak_mb < row.needs.memory_mb, `peak ${ran.peak_mb} MB`);
  t.diagnostic(`40,707 rows (39,088 pieces): ${ran.ms} ms, peak ${ran.peak_mb} MB, answer ${ran.answer_bytes} bytes, `
    + `${answer.files.length} of ${answer.totals.files} files on the first page; totals ${JSON.stringify(answer.totals)}`);

  // Page by page over every file: each file once, with its whole counts.
  const seen = new Map(answer.files.map(file => [file.file, file]));
  let pages = 1;
  for (let after = answer.next; after !== null; pages += 1) {
    const page = (await runRow(row, { records, after }, {})).last.result;
    assert.deepEqual(page.totals, want.totals);
    for (const file of page.files) { assert.ok(!seen.has(file.file), `${file.file} twice`); seen.set(file.file, file); }
    after = page.next;
  }
  assert.equal(seen.size, FILES);
  for (const [name, entry] of want.files) {
    const got = seen.get(name);
    assert.deepEqual([got.pieces, got.with_check, got.with_reason, got.uncovered_count], [entry.pieces, entry.with_check, entry.with_reason, entry.uncovered], name);
  }
  t.diagnostic(`every one of the ${FILES} files in ${pages} answers`);

  // One file's uncovered pieces, named page by page, each once.
  const one = fileName(7), named = [];
  for (let after = null; ;) {
    const page = (await runRow(row, after === null ? { records, file: one } : { records, file: one, after }, {})).last.result;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SETTINGS.answer.most_bytes);
    named.push(...page.files[0].uncovered.map(piece => piece.id));
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(named.length, want.files.get(one).uncovered);
  assert.equal(new Set(named).size, named.length);
  t.diagnostic(`${one}: all ${named.length} uncovered pieces named, each once`);
});

// ---------------------------------------------------------------------------------------------------------------------
// A made-up skill file of about `bytes` bytes: headings, bold leads, lists, tables, ``` and ~~~ fences (one ~~~ fence
// holding ``` lines, one ```` fence holding ~~~), and blank lines inside fences.
function madeUpSkill(bytes) {
  // The parts are kept in a list and joined once: measuring a string that grows by appending flattens it every turn.
  const head = '# Made-up skill\n\nA made-up opening paragraph.\n\n', parts = [head];
  let part = 0, size = Buffer.byteLength(head);
  while (size < bytes) {
    part += 1;
    const next = `## Made-up part ${part}\n\n**Made-up rule ${part}.** Made-up words about a made-up thing, said plainly so a check can be written from them.\n\n`
      + `- made-up item ${part} a\n- made-up item ${part} b\n  continued here.\n\n| Made-up | What |\n|---|---|\n| Row ${part} | value ${part} |\n\n`
      + `~~~sh\nmade-up-command ${part}\n\n\`\`\`\nnot a closing fence of ~~~\n\`\`\`\n~~~\n\n`
      + `\`\`\`\`md\n~~~\nmade-up inside ${part}\n\n~~~\n\`\`\`\`\n\n\`\`\`js\nconst madeUp = ${part};\n\nconsole.log(madeUp);\n\`\`\`\n\n`;
    parts.push(next);
    size += Buffer.byteLength(next);
  }
  return parts.join('');
}

// Every page of a document, read as the person's AI would: each call's `next` is the next call's `after`.
async function pagesOf(row, input, sample) {
  const ran = [];
  let after;
  do {
    const page = await runHeld(row, after === undefined ? input : { ...input, after }, sample);
    assert.equal(page.code, 0, page.stdout + page.stderr);
    ran.push(page);
    after = page.last.result.next ?? undefined;
  } while (after !== undefined);
  return ran;
}

// The run's host, in process, answering the made-up text under its name as the host's readWholeFile reads it. The row
// runs of this file measure memory; the named reads below run in process, so they measure none.
const hostWith = (name, text) => ({
  readWholeFile: async (given, { mostBytes }) => {
    if (given !== name) throw new Error(`no file named ${given}`);
    const bytes = Buffer.from(text);
    return { title: name.split('/').pop(), size: bytes.length, bytes: bytes.length > mostBytes ? null : bytes };
  },
});

// Every page of a named file, each call's `next` the next call's `after`.
async function namedPagesOf(name, text) {
  const host = hostWith(name, text), pages = [];
  let after;
  do {
    const page = await splitIntoPieces({ name, ...(after === undefined ? {} : { after }) }, host);
    pages.push(page);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

for (const [label, bytes] of [['31 KB', 31 * 1024], ['120 KB', 120 * 1024]]) {
  test(`tool:split-a-document-into-pieces answers every piece of a whole ${label} file, read by name, page by page, and keeps nothing`, { timeout: 240_000 }, async () => {
    const text = madeUpSkill(bytes);
    const name = '/Skills/made-up/SKILL.md';
    const want = pieceRows([{ text, file: name }]);
    const ran = await namedPagesOf(name, text);
    const answered = ran.flatMap(page => page.pieces);
    assert.deepEqual(answered, want, 'the pages hold the pieces, in reading order, once each');
    assert.ok(ran.every(page => page.total === want.length && page.too_large.length === 0));
    assert.ok(ran.every(page => Buffer.byteLength(JSON.stringify({ result: page })) <= SETTINGS.split.most_bytes), 'every answer is within its room');
    assert.ok(ran.every(page => page.keep === undefined), 'nothing is kept');
    // Every ~~~ fence is one piece, with the ``` lines it holds; every ```` fence holds its ~~~ lines.
    const fenced = want.filter(piece => piece.text.startsWith('~~~sh'));
    assert.ok(fenced.length > 0 && fenced.every(piece => piece.text.endsWith('\n~~~') && piece.text.includes('not a closing fence')));
    assert.ok(want.filter(piece => piece.text.startsWith('````md')).every(piece => piece.text.endsWith('\n````')));
  });
}

test('a 31 KB file also splits whole as text; 120 KB as text is over the door\'s request body, which is why it goes by name', async () => {
  const small = madeUpSkill(31 * 1024), large = madeUpSkill(120 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: small })) < DOOR_MESSAGE);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: large })) > 91 * 1024);
  const pages = await pagesOf(rowOf('tool:split-a-document-into-pieces'), { text: small, file: 'made-up.md' }, {});
  assert.equal(pages.flatMap(page => page.last.result.pieces).length, pieceRows([{ text: small }]).length);
});

test('a piece too large for one answer is named and not carried, and the rest of the file is answered', async () => {
  const text = `## Made-up\n\nCarried.\n\n~~~\n${'made-up line\n'.repeat(6000)}~~~\n`;
  const pages = await namedPagesOf('/made-up.md', text);
  const answer = pages[0];
  assert.deepEqual([answer.total, answer.pieces.length, answer.too_large.length], [2, 1, 1]);
  assert.match(answer.lines[1], /more than one answer holds/);
  assert.deepEqual(answer.pieces.map(piece => piece.says), ['Carried.']);
});

test('the largest file the row reads (4 MiB less 4 KiB) answers a first page, then a page from the middle by after', { timeout: 240_000 }, async () => {
  const text = madeUpSkill(4 * 1024 * 1024 - 4096);
  const name = '/Skills/made-up/SKILL.md';
  const want = pieceRows([{ text, file: name }]);
  const host = hostWith(name, text);
  const first = await splitIntoPieces({ name }, host);
  assert.deepEqual(first.pieces, want.slice(0, first.pieces.length));
  const after = want[Math.floor(want.length / 2)].id;
  const middle = await splitIntoPieces({ name, after }, host);
  assert.equal(middle.pieces[0].id, want[Math.floor(want.length / 2) + 1].id);
  for (const page of [first, middle]) {
    assert.ok(Buffer.byteLength(JSON.stringify({ result: page })) <= SETTINGS.split.most_bytes);
    assert.equal(page.keep, undefined, 'nothing is kept');
  }
});
