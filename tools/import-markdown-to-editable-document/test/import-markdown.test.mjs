import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importMarkdown } from '../do-work/import-markdown.mjs';
import { importMarkdownFile } from '../do-work/import-markdown-file.mjs';

test('imports lists, tables and fenced code with exact UTF-8 source spans and semantic round trip', () => {
  const markdown = '# Café\n\n- parent\n  - child\n\n| A | B |\n|:---|---:|\n| 1 | 2 |\n\n````js\nconst fence = ```;\n````\n\n> quoted text\n\nA [labeled link](https://example.com/path).\n';
  const result = importMarkdown(markdown, 'sample-doc');
  assert.equal(result.round_trip, 'passed');
  assert.equal(result.source_provenance.length, result.block_count);
  const source = Buffer.from(markdown);
  for (const { source_block: span } of result.source_provenance) {
    assert.ok(span.byte_start >= 0 && span.byte_end > span.byte_start);
    assert.equal(source.subarray(span.byte_start, span.byte_end).toString(), span.text);
  }
  const all = [];
  const visit = node => { all.push(node); for (const child of node.children ?? []) visit(child); };
  visit(result.page);
  const listOwners = all.filter(node => node.props?.interaction?.structure?.list_item);
  assert.equal(listOwners.length, 2);
  assert.ok(listOwners[0].children[1].children.includes(listOwners[1]));
  const text = all.filter(node => node.kind === 'Text').map(node => node.props.text);
  assert.ok(text.some(value => value.includes('A') && value.includes('B')));
  assert.ok(text.some(value => value.includes('const fence = ```;')));
  assert.ok(text.some(value => value.includes('quoted text')));
  assert.ok(text.some(value => value.includes('labeled link')));
  assert.ok(all.some(node => node.props?.custom?.interchange_kind === 'table-row'));
  assert.ok(all.some(node => node.props?.custom?.interchange_kind === 'fenced-code'));
  const ordered = importMarkdown('3. third\n4. fourth\n', 'ordered-doc');
  assert.equal(ordered.round_trip, 'passed');
  assert.match(JSON.stringify(ordered.page), /3\.\s+third/);
});

test('refuses unsupported block HTML', () => {
  assert.throws(() => importMarkdown('# ok\n\n<div>no</div>'), /HTML|unsupported/i);
});

test('refuses documents that exceed the bounded response size', () => {
  assert.throws(() => importMarkdown('x'.repeat(500_001)), /500000-byte import limit/i);
});

test('file adapter writes a private exclusive artifact and returns only a summary', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'markdown-import-'));
  try {
    const source = path.join(folder, 'source.md');
    const output = path.join(folder, 'editable.json');
    await writeFile(source, '# Hello\r\n\r\nUnicode: café\r\n', { mode: 0o600 });
    const summary = await importMarkdownFile({ granted_folder: folder, source_path: source, output_path: output });
    assert.equal(summary.round_trip, 'passed');
    assert.ok(!('page' in summary));
    const artifact = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(artifact.round_trip, 'passed');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(importMarkdownFile({ granted_folder: folder, source_path: source, output_path: output }), /EEXIST/);
    await assert.rejects(importMarkdownFile({ granted_folder: folder, source_path: source, output_path: path.join(path.dirname(folder), 'outside.json') }), /inside the granted folder/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
