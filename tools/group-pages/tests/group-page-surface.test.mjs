import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('group-page entry remains editable and accepts only an admitted projection', async () => { const source = await readFile(new URL('../show/GroupPageView.tsx', import.meta.url), 'utf8'); assert.equal(source.includes('function GroupPageView'), true); assert.equal(source.includes('admitted_scope'), true); assert.equal(source.includes('useCurrentActorRef'), false); });
test('paid group projection has no public or static protected-row fallback', async () => {
  const [view, decoder] = await Promise.all([
    readFile(new URL('../show/GroupPageView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../read-data/read-group-page.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(view, /admitted_scope\s*\?\?\s*props\.public_scope/);
  assert.doesNotMatch(decoder, /isPublicProjectionScope|visibility:\s*'public'/);
});
test('group-page decodes raw owner-target replies before verifying admission', async () => {
  const pageSource = await readFile(new URL('../do-work/create-group-page.ts', import.meta.url), 'utf8');
  const postSource = await readFile(new URL('../do-work/create-group-post.ts', import.meta.url), 'utf8');

  assert.match(pageSource, /const verified = decodeJsonReply\(await sender\(\{/);
  assert.match(postSource, /const verified = jsonReply\(await sender\(\{ target: 'access-rule\.verify-decision'/);
  assert.doesNotMatch(pageSource, /const verified = record\(await sender\(\{/);
  assert.doesNotMatch(postSource, /const verified = record\(await sender\(\{ target: 'access-rule\.verify-decision'/);
});
