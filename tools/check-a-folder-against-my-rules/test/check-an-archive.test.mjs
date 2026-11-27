// tool:check-an-archive-against-my-rules: an archive's files judged as they were packed, its shared top folder
// dropped, a path leaving it refused, a file past the bound listed but not read, and the run's folder gone after the
// answer. The archives are made here, byte by byte; nothing is fetched. Every value is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { checkAnArchive, fetchArchive, tarEntries } from '../do-work/check-an-archive.mjs';

/** A ustar archive of `files` ({ name, text }), with a pax `path` record for a name longer than 100 bytes. */
function tar(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0);
    block.write('0000644\0', 100);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const padded = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  for (const { name, text } of files) {
    const body = Buffer.from(text);
    if (Buffer.byteLength(name) > 100) {
      const record = Buffer.from(`${String(Buffer.byteLength(` path=${name}\n`) + 3).padStart(3, '0')} path=${name}\n`);
      blocks.push(header('pax', record.length, 'x'), padded(record));
    }
    blocks.push(header(name, body.length, '0'), padded(body));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const RULE = {
  kind: 'source-file-rule', id: 'no-plain-started-path', why: 'made up',
  scope: { path_matches: '\\.mjs$' },
  violation: { unit: { split: '\\n' }, forbidden: [{ pattern: 'import\\.meta\\.url === `file://\\$\\{process\\.argv\\[1\\]\\}`' }] },
  message: 'made up',
};
const run = (files, extra = {}) => checkAnArchive({ archive: 'https://example.test/a.tar.gz', rules: [RULE], recorded: { known_findings: {} }, ...extra }, async () => tar(files));

test('a commit archive is judged as packed: its shared top folder is dropped and each finding names its line', async () => {
  const deep = `top/${'a'.repeat(60)}/${'b'.repeat(60)}/run.mjs`;
  const answer = await run([
    { name: 'top/tools/fine.mjs', text: 'export const a = 1;\n' },
    // The line the rule forbids, made from parts, so this file does not hold it itself.
    { name: deep, text: `const a = 1;\nif (import.meta.url === ${'`file://${process.argv[1]}`'}) main();\n` },
  ]);
  assert.equal(answer.passed, false);
  assert.deepEqual(answer.violations.map((found) => [found.path, found.line]), [[deep.slice('top/'.length), 2]]);
  assert.equal(answer.written, 2);
  assert.match(answer.said, /1 finding/);
});

test('a clean archive passes, and the run leaves no folder behind', async () => {
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('archive-')).length;
  const answer = await run([{ name: 'top/tools/fine.mjs', text: 'if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();\n' }]);
  assert.equal(answer.passed, true);
  assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith('archive-')).length, before);
});

test('a path that leaves the archive is refused, and an address that is not https is refused', async () => {
  await assert.rejects(run([{ name: 'top/../../escape.mjs', text: 'x' }]), /outside itself/);
  await assert.rejects(checkAnArchive({ archive: 'http://example.test/a.tar.gz', rules: [RULE] }), /https/);
});

test('the tar reader keeps a long name from its pax record', () => {
  const name = `top/${'c'.repeat(120)}.mjs`;
  const { gunzipSync } = process.getBuiltinModule('node:zlib');
  assert.deepEqual(tarEntries(gunzipSync(tar([{ name, text: 'x' }]))).map((entry) => entry.name), [name]);
});

// A set computed from two other archives: what one repository declared at an older commit and no longer declares,
// judged in a third. Nothing is listed; the older commit is only an address in the input.
const RETIRED = {
  kind: 'source-file-rule', id: 'no-caller-of-a-retired-tool', why: 'made up',
  scope: { path_matches: '' },
  violation: { unit: { split: '\\n' }, forbidden: [{ collected: { from_subject: 'retired_tool_ids', pattern: '^(.+)$', flags: 'm', capture: 1 } }] },
  message: 'made up',
};
const ROWS = (...ids) => JSON.stringify(ids.map((id) => ({ id })));
const archives = {
  'https://example.test/was.tar.gz': tar([{ name: 'top/tools/a/what-this-tool-does-and-how-to-run-it.json', text: ROWS('tool:kept', 'tool:gone', 'tool:renamed') }]),
  'https://example.test/now.tar.gz': tar([{ name: 'top/tools/a/what-this-tool-does-and-how-to-run-it.json', text: `${ROWS('tool:kept', 'tool:new-name')}\n{"replaces": "tool:renamed", "id": "tool:new-name"}` }]),
  'https://example.test/apps.tar.gz': tar([
    { name: 'top/App/Calls.swift', text: 'call("tool:kept")\ncall("tool:gone")\ncall("tool:renamed")\ncall("tool:gone-too-far")\n' },
  ]),
};
const SUBJECTS = {
  retired_tool_ids: {
    was: 'https://example.test/was.tar.gz', now: 'https://example.test/now.tar.gz',
    path_matches: '^tools/[^/]+/what-this-tool-does-and-how-to-run-it\\.json$', pattern: '"id":\\s*"(tool:[^"]+)"', capture: 1,
    moved: '"replaces":\\s*"(?<from>tool:[^"]+)",\\s*"id":\\s*"(?<to>tool:[^"]+)"',
  },
};
const fetchedFrom = (seen) => async (address) => { seen.push(address); return archives[address]; };

test('a caller of an id the other repository stopped declaring is a finding, and a recorded new home is named', async () => {
  const seen = [];
  const answer = await checkAnArchive({ archive: 'https://example.test/apps.tar.gz', rules: [RETIRED], subjects_from: SUBJECTS }, fetchedFrom(seen));
  assert.equal(answer.passed, false);
  assert.deepEqual(answer.subjects, { retired_tool_ids: 2 });
  assert.deepEqual(answer.violations.map((found) => [found.line, found.moved_to ?? null]), [[2, null], [3, 'tool:new-name']]);
  assert.deepEqual([...new Set(seen)].length, seen.length, 'each address is fetched once');
});

test('a computed subject that matches no file is refused, never read as nothing retired', async () => {
  const subjects = { retired_tool_ids: { ...SUBJECTS.retired_tool_ids, path_matches: '^nowhere/' } };
  await assert.rejects(checkAnArchive({ archive: 'https://example.test/apps.tar.gz', rules: [RETIRED], subjects_from: subjects }, fetchedFrom([])), /no file of/);
  await assert.rejects(checkAnArchive({ archive: 'https://example.test/apps.tar.gz', rules: [RETIRED], subjects_from: { every_path: SUBJECTS.retired_tool_ids } }, fetchedFrom([])), /every_path/);
});

test('a file a rule covers that is too large to read is named, and the run is not a pass', async () => {
  const limits = { most_archive_bytes: 1 << 20, most_file_bytes: 64, most_written_bytes: 1 << 20 };
  const files = [{ name: 'top/tools/fine.mjs', text: 'export const a = 1;\n' }, { name: 'top/tools/large.mjs', text: `${'x'.repeat(100)}\n` },
    { name: 'top/notes/large.txt', text: 'y'.repeat(100) }];
  const answer = await checkAnArchive({ archive: 'https://example.test/a.tar.gz', rules: [RULE] }, async () => tar(files), limits);
  assert.equal(answer.passed, false, 'tools/large.mjs was never judged');
  assert.deepEqual(answer.unjudged_paths, ['tools/large.mjs'], 'the .txt file is skipped too, but no rule covers it');
  assert.deepEqual(answer.skipped_paths.map((item) => [item.path, item.bytes]), [['tools/large.mjs', 101], ['notes/large.txt', 100]]);
  assert.match(answer.said, /1 file\(s\) a rule covers were not judged: tools\/large\.mjs \(larger than 64 bytes\)/);
});

test('a held token reaches only the archive address\'s own host, and an address that is not https gets nothing', async () => {
  const seen = [];
  const fetchImpl = async (url, { headers }) => { seen.push([String(url), headers.authorization ?? null]); return new Response(Buffer.from('x')); };
  await fetchArchive('https://code-host.example/owner/repository/tar.gz/main', undefined, 'made-up-token', 'code-host.example', fetchImpl);
  await fetchArchive('https://other-host.example/a.tar.gz', undefined, 'made-up-token', 'code-host.example', fetchImpl);
  await fetchArchive('https://code-host.example/b.tar.gz', undefined, '', 'code-host.example', fetchImpl);
  assert.deepEqual(seen, [
    ['https://code-host.example/owner/repository/tar.gz/main', 'Bearer made-up-token'],
    ['https://other-host.example/a.tar.gz', null],
    ['https://code-host.example/b.tar.gz', null],
  ]);
  await assert.rejects(fetchArchive('http://code-host.example/a.tar.gz', undefined, 'made-up-token', 'code-host.example', fetchImpl), /https/);
  assert.equal(seen.length, 3);
});

test('what a run found is one text, the same for the same findings whatever the file count or order, and another for others', async () => {
  const bad = `if (import.meta.url === ${'`file://${process.argv[1]}`'}) main();\n`;
  const one = await run([{ name: 'top/a.mjs', text: bad }, { name: 'top/b.mjs', text: 'export const b = 1;\n' }]);
  const again = await run([{ name: 'top/c.mjs', text: 'export const c = 1;\n' }, { name: 'top/a.mjs', text: bad }, { name: 'top/d.mjs', text: '\n' }]);
  assert.equal(one.found, again.found, 'more files, another order: the same findings');
  assert.notEqual(one.said, again.said, 'while what it says counts the files');
  const two = await run([{ name: 'top/a.mjs', text: bad }, { name: 'top/e.mjs', text: bad }]);
  assert.notEqual(two.found, one.found, 'another finding is another text');
  assert.equal((await run([{ name: 'top/b.mjs', text: 'export const b = 1;\n' }])).found, '', 'a clean run found nothing');
  const recorded = { known_findings: { [RULE.id]: ['a.mjs', 'b.mjs'] } };
  const stale = await run([{ name: 'top/a.mjs', text: bad }, { name: 'top/b.mjs', text: 'export const b = 1;\n' }], { recorded });
  assert.equal(stale.passed, false);
  assert.equal(stale.found, `fixed ${RULE.id} b.mjs`, 'a recorded finding that was fixed is named, and the recorded one still there is not');
});
