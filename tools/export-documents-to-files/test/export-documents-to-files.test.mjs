// tools/export-documents-to-files: the Python programs' own tests, then the two commands the rows run,
// over trees and records this test makes up itself (a made-up bakery).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRecordPublicationProjection } from '../do-work/render-public-page.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const noPython = python('--version').status === 0 ? false : 'needs python3';
const renderer = `${folder}do-work/render-structured-file-export.py`;
const pageTool = `${folder}do-work/render-public-page.mjs`;
const starterRules = `${folder}read-data/starter-projection-rules.json`;

const node = (text, children = [], headingLevel) => ({ props: { ...(text === undefined ? {} : { text }), ...(headingLevel ? { heading_level: headingLevel } : {}) }, children });
const bakeryTree = node('Bakery price list', [
  node('Breads', [
    node('Baked fresh before seven.'),
    node(undefined, [node(undefined, [node('Loaf'), node('Price')]), node(undefined, [node('Rye'), node('4.50')])]),
  ], 1),
]);

function exportFile(directory, formatId, stem) {
  const job = { title: 'Bakery price list', descriptor: { format_id: formatId, destination_dir: directory, file_stem: stem }, tree: bakeryTree };
  const jobFile = join(directory, `${stem}-job.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  return python(renderer, '--job-file', jobFile, '--rules-rows-file', starterRules);
}

for (const file of readdirSync(`${folder}test`).filter((name) => /^test-.*\.py$/.test(name))) {
  test(`${file} passes or says what it needs`, { skip: noPython }, () => {
    const run = python(`${folder}test/${file}`);
    assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  });
}

test('a tree becomes a markdown file with its table and the result names the file', { skip: noPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const run = exportFile(directory, 'markdown', 'prices');
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(result.path, join(directory, 'prices.md'));
  assert.equal(result.format_id, 'markdown');
  assert.equal('payload_hash' in result, false);
  const text = readFileSync(result.path, 'utf8');
  assert.match(text, /^# Bakery price list/);
  assert.match(text, /## Breads/);
  assert.match(text, /\| Loaf \| Price \|\n\| --- \| --- \|\n\| Rye \| 4.50 \|/);
  assert.equal(result.byte_length, Buffer.byteLength(text));
});

test('a Word file is made from the same tree with no library installed', { skip: noPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const run = exportFile(directory, 'docx', 'prices');
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const listing = execFileSync('unzip', ['-l', result.path], { encoding: 'utf8' });
  assert.match(listing, /word\/document\.xml/);
  const xml = execFileSync('unzip', ['-p', result.path, 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /Bakery price list/);
  assert.match(xml, /<w:tbl>/);
});

test('no result file is left in the folder the command ran from', { skip: noPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const before = existsSync('result.json');
  assert.equal(exportFile(directory, 'txt', 'prices').status, 0);
  assert.equal(existsSync('result.json'), before);
});

test('a file name that reaches into another folder is refused and nothing is written', { skip: noPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const run = exportFile(directory, 'txt', '../escape');
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /plain file name/);
  assert.equal(existsSync(join(directory, '..', 'escape.txt')), false);
});

test('a format the rules do not define is refused by name', { skip: noPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const run = exportFile(directory, 'rtf', 'prices');
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /format rtf is not in the projection rules/);
});

function envelope(overrides = {}) {
  return {
    correlation_id: 'correlation:test',
    publication_descriptor: {
      descriptor_ref: 'descriptor:test',
      descriptor_version: 1,
      view: {
        title: { from: 'source_record', path: 'fields.title' },
        description: { from: 'source_record', path: 'fields.summary' },
        sections: [
          { operation: 'paragraph', text: { from: 'source_record', path: 'fields.summary' } },
          { operation: 'prose', html: { from: 'source_record', path: 'fields.body' } },
          { operation: 'list', items: { from: 'source_record', path: 'fields.items' } },
          { operation: 'future-operation', text: 'future data still renders' },
        ],
      },
      theme: { token_bindings: { primaryColor: { from: 'materialized_values', path: 'theme.primaryColor' } } },
      artifact: {
        kind: 'publication_artifact',
        mime_type: 'text/html',
        url: {
          scheme: 'https',
          domain: { from: 'materialized_values', path: 'site.domain' },
          path_segments: [
            { from: 'materialized_values', path: 'site.base_path' },
            { from: 'source_record', path: 'fields.slug' },
          ],
        },
        integrity_policy: { method: 'multihash' },
        projection_refs: ['projection:test'],
      },
      proof: { materialized_input_ref: 'materialization:test', process_session_ref: 'process-session:test' },
    },
    source_record: {
      ref: 'record:test',
      revision_ref: 'revision:test',
      fields: {
        title: 'Any Record Can Publish',
        slug: 'any-record',
        summary: 'A source record becomes a page through descriptor data.',
        body: '<p>Body made safe by the content owner.</p>',
        items: ['one', 'two'],
      },
    },
    materialized_values: { site: { domain: 'example.test', base_path: 'published' }, theme: { primaryColor: '#22c55e' } },
    ...overrides,
  };
}

test('a page is written from a record and a descriptor, with its address and proof', () => {
  const output = renderRecordPublicationProjection(envelope());
  assert.equal(output.artifact.canonical_url, 'https://example.test/published/any-record');
  assert.equal(output.artifact.mime_type, 'text/html');
  assert.match(output.artifact.bytes, /<h1>Any Record Can Publish<\/h1>/);
  assert.match(output.artifact.bytes, /future data still renders/);
  assert.match(output.artifact.bytes, /--accent-primary: #22c55e/);
  assert.deepEqual(output.artifact.projection_refs, ['projection:test']);
  assert.deepEqual({ ...output.proof }, {
    descriptor_ref: 'descriptor:test',
    source_ref: 'record:test',
    source_revision_ref: 'revision:test',
    materialized_input_ref: 'materialization:test',
    process_session_ref: 'process-session:test',
    correlation_id: 'correlation:test',
    integrity_policy: { method: 'multihash' },
  });
});

test('a differently shaped record renders with no code change', () => {
  const output = renderRecordPublicationProjection(envelope({
    source_record: {
      ref: 'record:service-entry',
      revision_ref: 'revision:service-entry',
      fields: { title: 'Service Entry', slug: 'service-entry', summary: 'Not shaped like a document.', body: '<p>Same writer, other record.</p>', items: ['configure', 'publish'] },
    },
  }));
  assert.match(output.artifact.bytes, /Service Entry/);
  assert.equal(output.artifact.canonical_url, 'https://example.test/published/service-entry');
});

test('words from the record are escaped, and only prose is written as given', () => {
  const output = renderRecordPublicationProjection(envelope({
    source_record: { ref: 'r', fields: { title: '<b>Loaf</b> & "rye"', slug: 's', summary: '<script>x</script>', body: '<em>ok</em>', items: ['<i>'] } },
  }));
  assert.match(output.artifact.bytes, /<h1>&lt;b&gt;Loaf&lt;\/b&gt; &amp; &quot;rye&quot;<\/h1>/);
  assert.match(output.artifact.bytes, /<p>&lt;script&gt;x&lt;\/script&gt;<\/p>/);
  assert.match(output.artifact.bytes, /<li>&lt;i&gt;<\/li>/);
  assert.match(output.artifact.bytes, /<div class="prose-section"><em>ok<\/em><\/div>/);
});

test('structured data is built from the descriptor nodes, empty fills are dropped, and < cannot close the script', () => {
  const output = renderRecordPublicationProjection({
    publication_descriptor: {
      artifact: { url: { scheme: 'https', domain: 'bakery.example', path_segments: ['articles', 'sourdough'] } },
      view: {
        title: { from: 'source_record', path: 'fields.title' },
        description: { from: 'source_record', path: 'fields.description' },
        sections: [{ operation: 'paragraph', text: 'body' }],
        schema_graph: {
          nodes: [
            {
              '@id': '#article', '@type': 'Article',
              headline: { $bind: { from: 'source_record', path: 'fields.title' } },
              datePublished: { $bind: { from: 'source_record', path: 'fields.datePublished' } },
              author: { '@id': '#baker' },
              image: { $bind: { from: 'source_record', path: 'fields.image', fallback: '' } },
            },
            { '@id': '#baker', '@type': 'Person', name: { $bind: { from: 'source_record', path: 'fields.author' } }, sameAs: ['https://example.test/entity/baker'] },
            { '@id': '#video', '@type': 'VideoObject', name: { $bind: { from: 'source_record', path: 'fields.videoName', fallback: '' } } },
          ],
        },
      },
    },
    source_record: { ref: 'article:sourdough', fields: { title: 'Sourdough </script> basics', description: 'How a starter is kept.', author: 'Sam Baker', datePublished: '2026-01-01' } },
  });
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(output.artifact.bytes);
  assert.ok(match, 'a structured-data script is written');
  assert.equal(match[1].includes('</script'), false);
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed['@context'], 'https://schema.org');
  assert.deepEqual(parsed['@graph'].map((entry) => entry['@type']), ['Article', 'Person', 'VideoObject']);
  assert.equal(parsed['@graph'][0].headline, 'Sourdough </script> basics');
  assert.equal('image' in parsed['@graph'][0], false);
  assert.equal(parsed['@graph'][1].name, 'Sam Baker');
  assert.deepEqual(parsed['@graph'][2], { '@id': '#video', '@type': 'VideoObject' });
});

test('the command writes the page to a file and prints the facts without the bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edf-'));
  const input = join(directory, 'envelope.json');
  const output = join(directory, 'page.html');
  writeFileSync(input, JSON.stringify(envelope()));
  const printed = JSON.parse(execFileSync('node', [pageTool, input, output], { encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.equal(printed.written, output);
  assert.equal(printed.artifact.canonical_url, 'https://example.test/published/any-record');
  assert.equal('bytes' in printed.artifact, false);
  assert.equal(printed.artifact.byte_length, Buffer.byteLength(readFileSync(output, 'utf8')));
  assert.match(readFileSync(output, 'utf8'), /^<!DOCTYPE html>/);
});

test('the command says what to fix when the envelope is not readable', () => {
  const run = spawnSync('node', [pageTool, join(tmpdir(), 'no-such-envelope.json')], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /could not be written/);
});
