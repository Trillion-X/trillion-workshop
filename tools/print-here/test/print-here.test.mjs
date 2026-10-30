import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePrintTools, printArguments, printersFrom, printSettings, readWhole } from '../read-data/print-here.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const listing = 'printer SAMPLE_OFFICE is idle.  enabled since Mon Jan  5 09:00:00 2026\nprinter SAMPLE_PHOTO disabled since Mon Jan  5 09:00:00 2026 -\nsystem default destination: SAMPLE_OFFICE\n';

test('both rows run on the person\'s computer with only the print system, and print reads files through the door', () => {
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['use-the-print-system']);
    assert.notEqual(row.invoke.internet, true);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    // run-an-export prints { result }, and the engine's `result` is that last line: the answer is one level down.
    assert.equal(row.result_selector, '$.result');
  }
  const print = rows.find(row => row.id === 'tool:print');
  assert.deepEqual(print.invoke.records, { fd: 3, rights: [{ files: '/', operations: ['find_file', 'read_file'] }] });
  assert.equal(rows.find(row => row.id === 'tool:printers').invoke.records, undefined, 'listing printers reads no files');
});

test('reads the printers and the default from the print system\'s words', () => {
  assert.deepEqual(printersFrom(listing), {
    printers: [{ name: 'SAMPLE_OFFICE', state: 'idle', default: true }, { name: 'SAMPLE_PHOTO', state: 'disabled since Mon Jan  5 09:00:00 2026 -', default: false }],
    default: 'SAMPLE_OFFICE',
  });
  assert.deepEqual(printersFrom(''), { printers: [], default: null });
});

test('builds one argument list from the settings, leaving out options not given', () => {
  const { command, args } = printArguments(printSettings(), { printer: 'SAMPLE_OFFICE', copies: 2, title: 'card', paper: 'A4', fit: true, sides: null });
  assert.equal(command, '/usr/bin/lp');
  assert.deepEqual(args, ['-d', 'SAMPLE_OFFICE', '-n', '2', '-t', 'card', '-o', 'media=A4', '-o', 'fit-to-page']);
});

test('prints the whole file on the default printer and refuses what it cannot do in words', async () => {
  const sent = [];
  const tools = makePrintTools({ list: async () => listing, send: async job => { sent.push(job); return { job: 'SAMPLE_OFFICE-7' }; } });
  const read = async () => ({ title: 'sample-card.pdf', size: 3, bytes: Buffer.from('pdf') });
  assert.deepEqual(await tools.print({ file: '/Projects/sample-card.pdf' }, read),
    { printed: true, printer: 'SAMPLE_OFFICE', job: 'SAMPLE_OFFICE-7', copies: 1, said: 'Sent sample-card.pdf to SAMPLE_OFFICE (1 copy).' });
  assert.equal(sent[0].bytes.toString(), 'pdf');
  assert.match((await tools.print({ file: 'x', printer: 'NOWHERE' }, read)).said, /no printer named NOWHERE\. Its printers: SAMPLE_OFFICE, SAMPLE_PHOTO/);
  assert.equal((await tools.print({}, read)).printed, false);
  assert.match((await tools.print({ file: 'x' }, async () => ({ title: 'big', size: 2e8, bytes: null }))).said, /larger than this Mac sends/);
  assert.match((await tools.print({ file: 'x' }, async () => { throw new Error('the door refused: current_workspace_rights_refused'); })).said, /Could not read x/);
  assert.equal(sent.length, 1, 'only the good request printed');
  assert.match((await makePrintTools({ list: async () => '' }).print({ file: 'x' }, read)).said, /no printer set up/);
  const noDefault = listing.replace(/^system default.*$/m, '');
  assert.match((await makePrintTools({ list: async () => noDefault, send: async () => ({ job: 'x' }) }).print({ file: 'x' }, read)).said,
    /Say which printer to use.*SAMPLE_OFFICE, SAMPLE_PHOTO/, 'two printers and no default: nothing is guessed');
});

test('reads a file in steps through the door until every byte is in', async () => {
  const bytes = Buffer.from('a'.repeat(5) + 'b'.repeat(5));
  const calls = [];
  const call = async (method, input) => {
    calls.push({ method, offset: input.offset });
    if (method === 'find_file') return { names: ['/Projects/sample-card.pdf'], identity: 'file-1' };
    const piece = bytes.subarray(input.offset, input.offset + input.length);
    return { byte_length: bytes.length, offset: input.offset, bytes_returned: piece.length, encoding: 'base64', content: piece.toString('base64') };
  };
  const file = await readWhole(call, { ...printSettings(), read_bytes: 4 }, '/Projects/sample-card.pdf');
  assert.equal(file.title, 'sample-card.pdf');
  assert.equal(file.bytes.toString(), bytes.toString());
  assert.deepEqual(calls.map(row => [row.method, row.offset]), [['find_file', undefined], ['read_file', 0], ['read_file', 4], ['read_file', 8]]);
});
