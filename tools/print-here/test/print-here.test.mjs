import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileGiven, makePrintTools, printArguments, printersFrom, printSettings } from '../read-data/print-here.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const listing = 'printer SAMPLE_OFFICE is idle.  enabled since Mon Jan  5 09:00:00 2026\nprinter SAMPLE_PHOTO disabled since Mon Jan  5 09:00:00 2026 -\nsystem default destination: SAMPLE_OFFICE\n';

test('both rows run on the person\'s computer with only the print system, and print is given the file it prints', () => {
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['use-the-print-system']);
    assert.notEqual(row.invoke.internet, true);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    // run-a-function prints { result }, and the engine's `result` is that last line: the answer is one level down.
    assert.equal(row.result_selector, '$.result');
  }
  assert.equal(rows.some(row => row.stored !== undefined), false, 'no row reads the door: print is given the file it prints in stored.files');
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

test('prints the whole file the caller handed in, on the default printer, and refuses what it cannot do in words', async () => {
  const sent = [];
  const tools = makePrintTools({ list: async () => listing, send: async job => { sent.push(job); return { job: 'SAMPLE_OFFICE-7' }; } });
  const stored = { files: { '/Projects/sample-card.pdf': 'pdf' } };
  assert.deepEqual(await tools.print({ file: '/Projects/sample-card.pdf', stored }),
    { printed: true, printer: 'SAMPLE_OFFICE', job: 'SAMPLE_OFFICE-7', copies: 1, said: 'Sent sample-card.pdf to SAMPLE_OFFICE (1 copy).' });
  assert.equal(sent[0].bytes.toString(), 'pdf');
  assert.match((await tools.print({ file: 'x', printer: 'NOWHERE', stored: { files: { x: 'pdf' } } })).said, /no printer named NOWHERE\. Its printers: SAMPLE_OFFICE, SAMPLE_PHOTO/);
  assert.equal((await tools.print({})).printed, false);
  const big = Buffer.alloc(200_000_000, 1).toString('base64');
  assert.match((await tools.print({ file: 'x', stored: { files: { x: { base64: big } } } })).said, /larger than this Mac sends/);
  assert.match((await tools.print({ file: 'x' })).said, /Could not read x from your files: the file's bytes were not handed in/);
  assert.equal(sent.length, 1, 'only the good request printed');
  assert.match((await makePrintTools({ list: async () => '' }).print({ file: 'x', stored: { files: { x: 'pdf' } } })).said, /no printer set up/);
  const noDefault = listing.replace(/^system default.*$/m, '');
  assert.match((await makePrintTools({ list: async () => noDefault, send: async () => ({ job: 'x' }) }).print({ file: 'x', stored: { files: { x: 'pdf' } } })).said,
    /Say which printer to use.*SAMPLE_OFFICE, SAMPLE_PHOTO/, 'two printers and no default: nothing is guessed');
});

test('a file is read from the bytes handed in: text or base64, its title is its last name, and one over the cap is not given', () => {
  const settings = { ...printSettings(), most_bytes: 4 };
  assert.deepEqual(fileGiven({ file: '/Projects/card.pdf', stored: { files: { '/Projects/card.pdf': 'abc' } } }, settings),
    { title: 'card.pdf', size: 3, bytes: Buffer.from('abc') });
  assert.deepEqual(fileGiven({ file: '/a.bin', stored: { files: { '/a.bin': { base64: 'AQI=' } } } }, settings).bytes, Buffer.from([1, 2]));
  assert.equal(fileGiven({ file: '/a.bin', stored: { files: { '/a.bin': { base64: 'AAAAAAAA' } } } }, settings).bytes, null);
  assert.equal(fileGiven({ file: '/missing.pdf', stored: { files: {} } }, settings), null);
  assert.equal(fileGiven({ file: '/missing.pdf' }, settings), null);
});

// Brought from Trillion-X/trillion test/who-does-it.test.mjs, where the Mac's own copy of these tools was tested.
test('the Mac prints a file the caller handed in on a printer it has, and refuses one it does not', async () => {
  const listed = 'printer EPSON_XP_6100_Series is idle.  enabled since Thu\nsystem default destination: EPSON_XP_6100_Series\n';
  assert.deepEqual(printersFrom(listed).printers, [{ name: 'EPSON_XP_6100_Series', state: 'idle', default: true }]);
  const sent = [];
  const tools = makePrintTools({ settings: printSettings(), list: async () => listed, send: async job => { sent.push(job); return { job: 'EPSON-12' }; } });
  const stored = { files: { '/Popcorn/card.pdf': '%PDF-1.4' } };
  const done = await tools.print({ file: '/Popcorn/card.pdf', copies: 2, paper: 'Letter', fit: true, stored });
  assert.equal(done.printed, true);
  assert.equal(done.job, 'EPSON-12');
  assert.deepEqual(sent[0].args, ['-d', 'EPSON_XP_6100_Series', '-n', '2', '-t', 'card.pdf', '-o', 'media=Letter', '-o', 'fit-to-page']);
  assert.equal(String(sent[0].bytes), '%PDF-1.4');
  const refused = await tools.print({ file: '/x.pdf', printer: 'Nope', stored: { files: { 'x.pdf': 'pdf' } } });
  assert.equal(refused.printed, false);
  assert.match(refused.said, /EPSON_XP_6100_Series/);
});

test('native print work records a stable effect and refuses to replay an unresolved submission', async () => {
  const listed = 'printer EPSON_XP_6100_Series is idle.  enabled since Thu\nsystem default destination: EPSON_XP_6100_Series\n';
  let started = 0, sent = 0;
  const tools = makePrintTools({ settings: printSettings(), list: async () => listed,
    send: async () => { sent += 1; return { job: 'EPSON-13' }; } });
  const stored = { files: { '/Popcorn/card.pdf': '%PDF-1.4' } };
  const effects = { handoff_id: 'h_print_1', recordEffect: async effect => {
    if (effect.state === 'starting') { started += 1; return { proceed: true, repeated: started > 1 }; }
    return { effect: { state: 'done', receipt: { printed: true, printer: 'EPSON_XP_6100_Series', job: 'EPSON-13', copies: 1 } } };
  } };
  const result = await tools.print({ file: '/Popcorn/card.pdf', stored }, effects);
  assert.equal(result.printed, true);
  assert.equal(sent, 1);
  await assert.rejects(tools.print({ file: '/Popcorn/card.pdf', stored }, effects), /may already have started/);
  assert.equal(sent, 1, 'a repeated starting effect never sends to the printer again');
});

test('a job the journal already finished answers its receipt without printing again', async () => {
  const listed = 'printer SAMPLE_OFFICE is idle.\nsystem default destination: SAMPLE_OFFICE\n';
  let sent = 0;
  const receipt = { printed: true, printer: 'SAMPLE_OFFICE', job: 'SAMPLE_OFFICE-1', copies: 1, said: 'Sent card.pdf to SAMPLE_OFFICE (1 copy).' };
  const tools = makePrintTools({ list: async () => listed, send: async () => { sent += 1; return { job: 'x' }; } });
  const answer = await tools.print({ file: '/card.pdf', stored: { files: { '/card.pdf': 'pdf' } } },
    { handoff_id: 'h_done', recordEffect: async () => ({ proceed: false, effect: { state: 'done', receipt } }) });
  assert.deepEqual(answer, receipt);
  assert.equal(sent, 0);
});
