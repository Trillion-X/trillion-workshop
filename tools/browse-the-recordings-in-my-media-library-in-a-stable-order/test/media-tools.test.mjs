import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaTools, mediaAnnotations } from '../src/media-tools.mjs';
import { fileTools, fileAnnotations } from '../../organize-my-files/src/file-tools.mjs';

test('Media tools use read-only owners', () => {
  const tools = mediaTools(async () => ({}));
  for (const name of ['list_media', 'next_media_edit']) {
    assert.ok(tools.find(tool => tool.name === name));
    assert.equal(mediaAnnotations[name].readOnlyHint, true);
  }
  assert.equal(tools.some(tool => tool.name === 'search_media'), false, 'searching media is the one search tool');
});

test('list_media defaults to a small image-free page and requires paging through the library', async () => {
  const calls = [];
  const list = mediaTools(async path => { calls.push(path); return { rows: [] }; }).find(tool => tool.name === 'list_media');
  await list.run({});
  await list.run({ after: '[1,0,"1f:x"]', revision: 'r&1', limit: 5, stored: true, origin: 'made', unused: false });
  assert.deepEqual(calls, [
    '/media/library?limit=20&previews=false',
    '/media/library?limit=5&previews=false&after=%5B1%2C0%2C%221f%3Ax%22%5D&revision=r%261&stored=true&origin=made&unused=false',
  ]);
  await assert.rejects(list.run({ all: true }), /Read the media library in pages/);
  await assert.rejects(list.run({ all: true, after: 'cursor' }), /Read the media library in pages/);
  assert.equal(list.inputSchema.properties.all, undefined);
  assert.equal(list.inputSchema.properties.limit.maximum, 60);
});

test('list_media refuses an oversized page instead of returning a partial answer', async () => {
  const paths = [];
  const list = mediaTools(async path => {
    paths.push(path);
    return { rows: [{ facts: 'x'.repeat(200_000) }] };
  }).find(tool => tool.name === 'list_media');
  await assert.rejects(list.run({ limit: 1 }), /media page is too large.*smaller limit/);
  assert.deepEqual(paths, ['/media/library?limit=1&previews=false']);
});

test('The one search tool keeps the whole question and passes places and sources', async () => {
  const calls = [];
  const search = fileTools(async path => { calls.push(path); return { results: [], unavailable: [], pending: [] }; }).find(tool => tool.name === 'search');
  assert.equal(fileAnnotations.search.readOnlyHint, true);
  await search.run({ question: 'serve & volley?' });
  await search.run({ question: 'recipe', places: ['said', 'seen'], sources: ['files'], limit: 5 });
  assert.deepEqual(calls, ['/namespace/search?q=serve%20%26%20volley%3F', '/namespace/search?q=recipe&places=said%2Cseen&sources=files&limit=5'], 'asked of the account\'s own Namespace resource, where its files are kept');
});
