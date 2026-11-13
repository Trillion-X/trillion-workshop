// tools/export-documents-to-files: the file exporter (tool:export-a-document-to-a-file), run the way the tool container
// runs it, over made-up documents. Word, Excel and PDF files are opened again with `unzip` and `pdftotext` when this
// computer has them; the test says which it skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import formats from '../read-data/export-formats.json' with { type: 'json' };
import { formatTakes } from '../do-work/format-takes.mjs';
import { runVerb } from '../do-work/export-to-file.mjs';

const exec = promisify(execFile);
const command = new URL('../do-work/export-to-file.mjs', import.meta.url).pathname;
const has = program => spawnSync(program, ['-h'], { stdio: 'ignore' }).error === undefined;
const noUnzip = has('unzip') ? false : 'needs unzip';
const noPdftotext = has('pdftotext') ? false : 'needs pdftotext';

const table = { kind: 'table', title: 'Invoices', columns: ['Name', 'Amount', 'Paid'], rows: [['Acme, Inc.', 1200.5, false], ['Birch "Ltd"', 300, true], ['Cedar\nline two', 5, null]] };
const sample = {
  title: 'Money owed',
  blocks: [
    { kind: 'heading', level: 2, text: 'Open invoices' },
    { kind: 'paragraph', text: 'Not yet paid.' },
    table,
    { kind: 'list', items: ['one', { text: 'two', children: ['two-a'] }] },
    { kind: 'list', ordered: true, items: ['first', 'second'] },
  ],
};
const graph = { kind: 'graph', title: 'Plan', nodes: [{ id: 'a', label: 'Start "here"' }, { id: 'b', label: 'Finish' }], edges: [{ from: 'a', to: 'b', label: 'then' }, { from: 'b', to: 'a' }] };
const events = { kind: 'events', title: 'Dates', events: [{ id: 'e1', title: 'Pay, then rest; again', start: '2026-11-30', description: 'Line one\nline two' }, { title: 'Call', start: '2026-12-01T09:30:00Z', end: '2026-12-01T10:00:00Z' }] };
const picture = { kind: 'picture', title: 'Mark', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><path d="M 0 0 L 10 10"/></svg>' };

const out = (document, format, more = {}) => runVerb('export', { document, format, now: '2026-11-12T12:00:00Z', ...more });
const textOf = (document, format, more) => out(document, format, more).text;
const unzipList = async file => (await exec('unzip', ['-Z1', file])).stdout.split('\n').filter(Boolean);
const unzipRead = async (file, part) => (await exec('unzip', ['-p', file, part], { maxBuffer: 1 << 26 })).stdout;
const save = (result, name) => { const file = join(mkdtempSync(join(tmpdir(), 'export-')), name); writeFileSync(file, Buffer.from(result.base64, 'base64')); return file; };

test('every format row is complete, unique, and writes every kind it says it takes', () => {
  assert.equal(new Set(formats.formats.map(format => format.id)).size, formats.formats.length);
  const samples = { heading: sample.blocks[0], paragraph: sample.blocks[1], table, list: sample.blocks[3], graph, events, picture };
  for (const format of formats.formats) {
    assert.match(format.extension, /^[a-z0-9]+$/, format.id);
    for (const [kind, block] of Object.entries(samples)) {
      if (!formatTakes(format, [kind])) continue;
      const result = out({ title: 'T', blocks: [block] }, format.id);
      assert.ok(result.byte_length > 0, `${format.id} wrote nothing for ${kind}`);
      assert.equal(result.filename, `t.${format.extension}`);
    }
  }
});

test('the formats the people asked for are there: PDF, Word, Excel, CSV, Markdown, text, SVG', () => {
  const ids = runVerb('formats', {}).formats.map(format => format.id);
  for (const wanted of ['pdf', 'docx', 'xlsx', 'csv', 'markdown', 'txt', 'svg', 'html', 'json', 'ics', 'mermaid', 'dot', 'graphml', 'opml', 'freemind', 'png', 'slides', 'tsv']) assert.ok(ids.includes(wanted), wanted);
});

test('CSV quotes only what needs it and holds a table as rows', () => {
  assert.equal(textOf({ title: 'Money', blocks: [table] }, 'csv'), 'Name,Amount,Paid\r\n"Acme, Inc.",1200.5,false\r\n"Birch ""Ltd""",300,true\r\n"Cedar\nline two",5,\r\n');
});

test('Markdown writes headings, a pipe table with its characters escaped, and nested lists', () => {
  const md = textOf({ title: 'Money', blocks: [sample.blocks[0], { kind: 'table', columns: ['A|B', 'C'], rows: [['x|y', 'two\nlines']] }, sample.blocks[3]] }, 'markdown');
  assert.equal(md, '# Money\n\n## Open invoices\n\n| A\\|B | C |\n| --- | --- |\n| x\\|y | two<br>lines |\n\n- one\n- two\n    - two-a\n');
});

test('HTML escapes words and writes a table with header cells', () => {
  const html = textOf({ title: '<b>T</b>', blocks: [{ kind: 'table', columns: ['A'], rows: [['<i>x</i>']] }] }, 'html');
  assert.match(html, /<title>&lt;b&gt;T&lt;\/b&gt;<\/title>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>&lt;i&gt;x&lt;\/i&gt;<\/td>/);
  assert.equal(/<i>/.test(html), false);
});

test('slides break the page before each top heading', () => {
  const html = textOf({ title: 'Deck', blocks: [{ kind: 'heading', level: 1, text: 'One' }, picture] }, 'slides');
  assert.match(html, /h1\{break-before:page/);
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<figure><svg/);
});

test('a calendar writes all-day and timed events, escapes, and folds long lines at 75 octets', () => {
  const ics = textOf({ title: 'x', blocks: [{ ...events, events: [...events.events, { title: 'L'.repeat(200), start: '2026-12-02' }] }] }, 'ics');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261130\r\n/);
  assert.match(ics, /DTSTART:20261201T093000Z\r\nDTEND:20261201T100000Z\r\n/);
  assert.match(ics, /SUMMARY:Pay\\, then rest\\; again\r\n/);
  assert.match(ics, /DESCRIPTION:Line one\\nline two\r\n/);
  assert.match(ics, /DTSTAMP:20261112T120000Z/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('Mermaid, DOT and GraphML write the same graph with their own escapes', () => {
  const mermaid = textOf({ blocks: [graph] }, 'mermaid');
  assert.match(mermaid, /^flowchart TD\n {4}n1\["Start #quot;here#quot;"\]\n {4}n2\["Finish"\]\n {4}n1 -->\|"then"\| n2\n {4}n2 --> n1\n$/);
  const dot = textOf({ blocks: [graph] }, 'dot');
  assert.match(dot, /n1 \[label="Start \\"here\\""\];/);
  assert.match(dot, /n1 -> n2 \[label="then"\];/);
  assert.match(dot, /n2 -> n1;/);
  const graphml = textOf({ blocks: [graph] }, 'graphml');
  assert.match(graphml, /<node id="n1"><data key="label">Start &quot;here&quot;<\/data><\/node>/);
  assert.match(graphml, /<edge source="n1" target="n2">/);
});

test('OPML and FreeMind write headings as nested nodes with their words escaped', () => {
  const doc = { title: 'Root & co', blocks: [{ kind: 'heading', level: 1, text: 'A' }, { kind: 'paragraph', text: 'say "hi"' }, { kind: 'heading', level: 2, text: 'B' }, { kind: 'list', items: ['x'] }] };
  assert.match(textOf(doc, 'opml'), /<outline text="A"><outline text="say &quot;hi&quot;"\/><outline text="B"><outline text="x"\/><\/outline><\/outline>/);
  assert.match(textOf(doc, 'freemind'), /<node TEXT="Root &amp; co"><node TEXT="A">/);
});

test('a graph or events block goes to a format that has only tables as two tables or one, and a picture is refused by name', () => {
  assert.match(textOf({ blocks: [graph] }, 'csv'), /^id,label\r\na,"Start ""here"""\r\nb,Finish\r\n\r\nfrom,to,label\r\n"Start ""here""",Finish,then\r\nFinish,"Start ""here""",\r\n$/);
  assert.match(textOf({ blocks: [events] }, 'csv'), /^title,start,end,all_day,description\r\n/);
  assert.throws(() => out({ blocks: [picture] }, 'csv'), /csv format cannot write a picture block; choose a format that can, such as svg or html/);
  assert.throws(() => out({ blocks: [picture] }, 'pdf'), /pdf format cannot write a picture block/);
});

test('a picture alone comes out as that picture, untouched; PNG comes back as the SVG with the last step named', () => {
  assert.equal(textOf({ blocks: [picture] }, 'svg'), `<?xml version="1.0" encoding="UTF-8"?>\n${picture.svg}\n`);
  const png = out({ blocks: [picture] }, 'png');
  assert.equal(png.finish, 'raster-png');
  assert.equal(png.extension, 'png');
  assert.match(png.text, /<svg/);
});

test('ink marks become a picture in the space’s own coordinates', () => {
  const operations = [{ id: 'line', target: { address: 'wall' }, body: { coordinate_sets: [{ points: [{ values: [10, 10] }, { values: [20, 30] }] }] } }];
  const svg = textOf({ blocks: [{ kind: 'ink', operations, target: { address: 'wall' }, default_stroke: '#222222' }] }, 'svg');
  assert.match(svg, /d="M 10 10 L 20 30"/);
  assert.match(svg, /viewBox="6 6 18 28"/);
  assert.throws(() => out({ blocks: [{ kind: 'ink', operations: [], default_stroke: '#222' }] }, 'svg'), /no ink showing/);
});

test('SVG lays a document out as text, rules and shaded header cells', () => {
  const svg = textOf(sample, 'svg');
  assert.match(svg, /<text [^>]*font-weight="bold"[^>]*>Money owed<\/text>/);
  assert.match(svg, /<text [^>]*>Acme, Inc.<\/text>/);
  assert.match(svg, /<line /);
});

test('a PDF is a whole PDF with its words, and a character Helvetica cannot draw stops it, named', { skip: noPdftotext }, async () => {
  const result = out({ title: 'Money — owed €5', blocks: sample.blocks }, 'pdf');
  const file = save(result, 'money.pdf');
  assert.equal(Buffer.from(result.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  const words = (await exec('pdftotext', ['-layout', file, '-'])).stdout;
  for (const wanted of ['Money — owed €5', 'Open invoices', 'Acme, Inc.', '1200.5', 'two-a']) assert.ok(words.includes(wanted), wanted);
  assert.throws(() => out({ title: '日本', blocks: [] }, 'pdf'), /cannot draw: "日" \(U\+65E5\), "本" \(U\+672C\)\. Nothing was substituted/);
});

test('a header word is never broken, even in a narrow table of many columns', { skip: noPdftotext }, async () => {
  const columns = ['Statement', 'Interest', 'Previous balance', 'Payments and credits', 'Purchases', 'Statement month', 'Period start', 'Period end', 'Fees', 'New balance'];
  const file = save(out({ title: 'Wide', blocks: [{ kind: 'table', columns, rows: [columns.map((_, index) => index * 1000.5)] }] }, 'pdf'), 'wide.pdf');
  const words = (await exec('pdftotext', ['-layout', file, '-'])).stdout;
  for (const word of columns.flatMap(name => name.split(' '))) assert.ok(words.includes(word), `${word} is whole`);
});

test('a table of 150,000 rows is written in every table format without overrunning the call stack', () => {
  const rows = Array.from({ length: 150000 }, (_, index) => [`row ${index}`, index]);
  const big = { title: 'Big', blocks: [{ kind: 'table', columns: ['Name', 'Number'], rows }] };
  for (const format of ['docx', 'xlsx', 'csv']) assert.ok(out(big, format).byte_length > 500000, format);
});

test('a long table runs onto more pages and repeats its header there', { skip: noPdftotext }, async () => {
  const rows = Array.from({ length: 120 }, (_, index) => [`row ${index}`, index, 'a fairly long note that fills the cell']);
  const file = save(out({ title: 'Long', blocks: [{ kind: 'table', columns: ['Name', 'Number', 'Note'], rows }] }, 'pdf'), 'long.pdf');
  const pages = (await exec('pdftotext', ['-layout', file, '-'])).stdout.split('\f').filter(page => page.trim());
  assert.ok(pages.length >= 3, `pages: ${pages.length}`);
  for (const page of pages) assert.match(page, /Name\s+Number\s+Note/);
  assert.ok(pages.at(-1).includes('row 119'));
  assert.match(pages[1], /Page 2 of/);
});

test('a Word file holds real styles, a table with a repeating header, and Word lists', { skip: noUnzip }, async () => {
  const file = save(out(sample, 'docx'), 'money.docx');
  const parts = await unzipList(file);
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml']) assert.ok(parts.includes(part), part);
  const xml = await unzipRead(file, 'word/document.xml');
  assert.match(xml, /<w:pStyle w:val="Title"\/>/);
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>.*?Open invoices/);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /<w:t xml:space="preserve">Acme, Inc\.<\/w:t>/);
  assert.match(xml, /Cedar<\/w:t><\/w:r><w:r><w:br\/><\/w:r><w:r><w:t xml:space="preserve">line two/);
  assert.match(xml, /<w:ilvl w:val="1"\/><w:numId w:val="1"\/>/);
  assert.match(xml, /<w:numId w:val="2"\/>/);
});

test('an Excel file keeps numbers and true/false as such, one sheet per table', { skip: noUnzip }, async () => {
  const file = save(out({ title: 'Money', blocks: [table, { kind: 'table', title: 'Other', columns: ['K'], rows: [['v']] }, { kind: 'paragraph', text: 'note' }] }, 'xlsx'), 'money.xlsx');
  const workbook = await unzipRead(file, 'xl/workbook.xml');
  assert.deepEqual([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]), ['Document', 'Invoices', 'Other']);
  const sheet = await unzipRead(file, 'xl/worksheets/sheet2.xml');
  assert.match(sheet, /<c r="B2"><v>1200\.5<\/v><\/c>/);
  assert.match(sheet, /<c r="C2" t="b"><v>0<\/v><\/c>/);
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr">/);
  assert.match(sheet, /pane ySplit="1"/);
});

const money = { kind: 'table', columns: ['Item', 'Amount'], currencies: [null, 'USD'], rows: [['Rent', 1234.5], ['Refund', -40]] };

test('a column that declares a currency is written as money in words and kept as numbers in CSV and Excel', { skip: noUnzip }, async () => {
  assert.match(textOf({ blocks: [money] }, 'markdown'), /\| Rent \| \$1,234\.50 \|\n\| Refund \| -\$40\.00 \|/);
  assert.match(textOf({ blocks: [money] }, 'html'), /<td>\$1,234\.50<\/td>/);
  assert.equal(textOf({ blocks: [money] }, 'csv'), 'Item,Amount\r\nRent,1234.5\r\nRefund,-40\r\n');
  assert.match(textOf({ blocks: [money] }, 'markdown', { locale: 'de-DE' }), /1\.234,50\s*\$/);
  const file = save(out({ title: 'Money', blocks: [money] }, 'xlsx'), 'money.xlsx');
  assert.match(await unzipRead(file, 'xl/styles.xml'), /formatCode="&quot;\$&quot;#,##0\.00;-&quot;\$&quot;#,##0\.00"/);
  assert.match(await unzipRead(file, 'xl/worksheets/sheet1.xml'), /<c r="B2" s="2"><v>1234\.5<\/v><\/c>/);
  assert.throws(() => out({ blocks: [{ ...money, currencies: ['usd', null] }] }, 'markdown'), /currencies must name/);
});

test('the page is the paper the request names, else the region of its locale, else US Letter, in either orientation', { skip: noPdftotext }, async () => {
  const size = async (more) => {
    const file = save(out({ title: 'T', blocks: [] }, 'pdf', more), 'p.pdf');
    return (await exec('pdfinfo', [file])).stdout.match(/Page size:\s+(\d+) x (\d+)/).slice(1).map(Number);
  };
  assert.deepEqual(await size({}), [612, 792]);
  assert.deepEqual(await size({ locale: 'en-US' }), [612, 792]);
  assert.deepEqual(await size({ locale: 'en-GB' }), [595, 842]);
  assert.deepEqual(await size({ locale: 'en-GB', paper: 'letter', orientation: 'landscape' }), [792, 612]);
  assert.throws(() => out({ blocks: [] }, 'pdf', { paper: 'foolscap' }), /no paper "foolscap"/);
  assert.throws(() => out({ blocks: [] }, 'pdf', { orientation: 'sideways' }), /orientation must be/);
});

test('a document that is one untitled table is one sheet named by the document title', { skip: noUnzip }, async () => {
  const file = save(out({ title: 'Card rows', blocks: [{ kind: 'table', columns: ['A'], rows: [['x']] }] }, 'xlsx'), 'one.xlsx');
  assert.deepEqual([...(await unzipRead(file, 'xl/workbook.xml')).matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]), ['Card rows']);
});

test('the zip written is a valid archive with the right checksums', { skip: noUnzip }, async () => {
  const file = save(out(sample, 'docx'), 'check.docx');
  const tested = await exec('unzip', ['-tq', file]);
  assert.match(tested.stdout, /No errors detected/);
});

test('a person’s own format row works with no code change, and a bad one is refused', () => {
  const pipes = { id: 'pipes', extension: 'psv', mime: 'text/plain', renderer: 'template', draws: ['table'], options: { escape: 'none', document: '{body}\n', table: { header_row: '{cells}', row: '{cells}', cell_separator: ' | ' } } };
  assert.equal(textOf({ blocks: [table] }, 'ignored', { format_row: pipes }), 'Name | Amount | Paid\nAcme, Inc. | 1200.5 | false\nBirch "Ltd" | 300 | true\nCedar\nline two | 5 | \n');
  assert.throws(() => out({ blocks: [] }, 'x', { format_row: { ...pipes, renderer: 'magic' } }), /renderer "magic"/);
  assert.throws(() => out({ blocks: [{ kind: 'paragraph', text: 'p' }] }, 'x', { format_row: { ...pipes, draws: ['paragraph'] } }), /has no paragraph template/);
});

test('a format that does not exist is refused with the ones that do; a file name cannot reach another folder', () => {
  assert.throws(() => out({ blocks: [] }, 'rtf'), /no format "rtf".*pdf, docx/);
  for (const stem of ['../escape', 'a/b', '.hidden', '']) assert.throws(() => out({ blocks: [] }, 'txt', { file_stem: stem }), /plain file name/, stem);
  assert.equal(out({ title: 'Ünï Çode — Q4!', blocks: [] }, 'txt').filename, 'uni-code-q4.txt');
  assert.equal(out({ blocks: [] }, 'txt').filename, 'txt.txt');
});

test('a document that is not readable says which block is wrong', () => {
  assert.throws(() => out({ blocks: [{ kind: 'heading', level: 9, text: 'x' }] }, 'txt'), /blocks\[0\]\.level/);
  assert.throws(() => out({ blocks: [{ kind: 'table', columns: ['A'], rows: [[{ nested: true }]] }] }, 'txt'), /blocks\[0\]\.rows\[0\]\[0\] must be words, a number/);
  assert.throws(() => out({ blocks: [{ kind: 'graph', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'z' }] }] }, 'dot'), /node that is not in nodes: a to z/);
  assert.throws(() => out({ blocks: [{ kind: 'video' }] }, 'txt'), /blocks\[0\]\.kind "video" is not one of/);
});

test('the command prints one JSON line: { result }, or { error } with a non-zero exit', async () => {
  const run = async (verb, input) => {
    const pending = exec('node', [command, verb]);
    pending.child.stdin.end(JSON.stringify(input));
    const done = await pending.catch(error => error);
    return { status: done.code ?? 0, answer: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
  };
  const good = await run('export', { document: { title: 'Hi', blocks: [{ kind: 'paragraph', text: 'there' }] }, format: 'txt' });
  assert.equal(good.status, 0);
  assert.equal(Buffer.from(good.answer.result.base64, 'base64').toString(), 'Hi\n\nthere\n');
  const bad = await run('export', { document: { blocks: [] }, format: 'rtf' });
  assert.equal(bad.status, 1);
  assert.match(bad.answer.error, /no format "rtf"/);
  assert.equal((await run('formats', {})).answer.result.formats.length, formats.formats.length);
});
