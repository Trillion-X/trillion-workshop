// tools/write-a-post-for-each-place/test/surface-compose.test.mjs (moved from Trillion-X/trillion test/surface-compose.test.mjs)
//
// One body written for what each place can show (read-data/surface-compose.mjs): the composer reads a capability record, degrades what
// the place cannot show and says so, keeps the marker through a cut, names the unconfirmed capabilities it relied on, and builds
// a record from a post place's own limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../read-data/surface-compose.json' with { type: 'json' };
import { capabilityOf, capabilityOfPlace, composeFor } from '../read-data/surface-compose.mjs';

const blocks = [
  { type: 'heading', text: 'What changed', level: 2 },
  { type: 'image', alt: 'The change', url: 'https://example.com/c.svg', dark_url: 'https://example.com/c-dark.svg' },
  { type: 'collapsible', summary: 'Files', blocks: [{ type: 'list', items: ['a.js', 'b.js'] }] },
  { type: 'checklist', items: [{ text: 'Tests', done: true }, { text: 'Docs', done: false }] },
];
const MARKER = 'trillion-change-picture:abc';
const FOLD = ['details', 'summary'];

test('a surface that shows everything gets folded sections, boxes and both pictures, and degrades nothing', () => {
  const made = composeFor(blocks, capabilityOf('github_comment'), { marker: MARKER });
  assert.ok(made.body.startsWith(MARKER));
  assert.ok(made.body.includes('c.svg#gh-light-mode-only') && made.body.includes('c-dark.svg#gh-dark-mode-only'));
  assert.ok(made.body.includes('- [x] Tests') && made.body.includes('- [ ] Docs'));
  for (const name of FOLD) assert.ok(made.body.includes(`${String.fromCharCode(60)}${name}`), name);
  assert.deepEqual(made.degraded, []);
  assert.deepEqual(made.unproven_used, []);
});

test('a surface that shows less degrades each missing capability and names the ones nobody confirmed', () => {
  const made = composeFor(blocks, capabilityOf('bitbucket_comment'), { marker: MARKER });
  assert.ok(!made.body.includes(String.fromCharCode(60)));
  assert.ok(made.body.includes('Files') && made.body.includes('- a.js'));
  assert.ok(made.body.includes('• done: Tests') && made.body.includes('• to do: Docs'));
  assert.ok(!made.body.includes('c-dark.svg'), 'only the light picture where there is one form');
  assert.deepEqual([...made.degraded].sort(), ['checkboxes', 'collapsibles', 'theme']);
  assert.deepEqual([...made.unproven_used].sort(), ['max_chars']);
});

test('a plain surface removes the formatting', () => {
  const made = composeFor([{ type: 'heading', text: 'Done', level: 1 }, { type: 'paragraph', text: 'See [the file](https://x.test) now' }], capabilityOf('plain_message'));
  assert.equal(made.body, 'Done\n\nSee the file now');
});

test('a body over the limit is cut at a block boundary, says so, and keeps the marker first', () => {
  const capability = { ...capabilityOf('github_comment'), max_chars: 200 };
  const long = [{ type: 'paragraph', text: 'a'.repeat(60) }, { type: 'paragraph', text: 'b'.repeat(60) }, { type: 'paragraph', text: 'c'.repeat(60) }];
  const made = composeFor(long, capability, { marker: MARKER });
  assert.ok(made.body.length <= 200, String(made.body.length));
  assert.ok(made.body.startsWith(MARKER));
  assert.ok(made.body.includes('a'.repeat(60)) && !made.body.includes('c'.repeat(60)));
  assert.equal(made.truncated, true);
  assert.ok(made.degraded.includes('max_chars'));
  assert.ok(made.body.endsWith(rules.words.truncated.replace('{max}', '200')));
});

test('an unknown surface has no record, and a post place becomes one from its own limits', () => {
  assert.equal(capabilityOf('__proto__'), null);
  const sourced = capabilityOfPlace({ id: 'post-place:x', format: { caption_max_characters: 280, source: 'read 2026' } });
  assert.equal(sourced.max_chars, 280);
  assert.deepEqual(sourced.unproven, []);
  const unsourced = capabilityOfPlace({ id: 'post-place:y', format: { caption_max_characters: 500 } });
  assert.deepEqual(unsourced.unproven, ['max_chars']);
  assert.equal(composeFor([{ type: 'paragraph', text: 'x'.repeat(600) }], unsourced).unproven_used[0], 'max_chars');
});

test('an unknown block type is refused', () => {
  assert.throws(() => composeFor([{ type: 'video' }], capabilityOf('plain_message')), /unknown block type/);
});
