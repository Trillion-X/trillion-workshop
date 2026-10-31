import { strict as assert } from 'node:assert'
import test from 'node:test'
import { placeSection, locateSection, headingDepth } from '../do-work/append-section.mjs'

test('appends when the heading is absent and keeps every existing byte', () => {
  const before = '# Doc\n\nbody\n'
  const result = placeSection(before, '## New\n\ncontent\n')
  assert.equal(result.placement, 'appended')
  assert.ok(result.text.startsWith('# Doc\n\nbody'))
  assert.ok(result.text.includes('## New\n\ncontent'))
})

test('replaces an existing section only up to the next same-depth heading', () => {
  const before = '# Doc\n\n## A\n\nold\n\n## B\n\nkeep\n'
  const result = placeSection(before, '## A\n\nfresh\n')
  assert.equal(result.placement, 'replaced')
  assert.ok(result.text.includes('fresh'))
  assert.ok(!result.text.includes('old'))
  assert.ok(result.text.includes('## B\n\nkeep'))
})

test('replacing a section swallows its deeper subsections but not its siblings', () => {
  const before = '## A\n\nold\n\n### A1\n\nnested\n\n## B\n\nkeep\n'
  const result = placeSection(before, '## A\n\nfresh\n')
  assert.ok(!result.text.includes('nested'))
  assert.ok(result.text.includes('## B\n\nkeep'))
})

test('a heading-looking line inside a fence never ends a section', () => {
  const before = '## A\n\n```\n## B\n```\n\ntail\n\n## C\n\nkeep\n'
  const located = locateSection(before.split('\n'), '## A', 2)
  assert.ok(before.split('\n').slice(located.start, located.end).join('\n').includes('tail'))
  assert.ok(!before.split('\n').slice(located.start, located.end).join('\n').includes('keep'))
})

test('placing the same section twice is idempotent', () => {
  const once = placeSection('# Doc\n\nbody\n', '## New\n\ncontent\n').text
  const twice = placeSection(once, '## New\n\ncontent\n')
  assert.equal(twice.placement, 'replaced')
  assert.equal(twice.text, once)
})

test('a section file without a heading is refused rather than silently appended', () => {
  assert.throws(() => placeSection('# Doc\n', 'no heading here\n'), /no markdown heading/)
})

test('heading depth ignores a hash that is not a heading', () => {
  assert.equal(headingDepth('#notaheading'), 0)
  assert.equal(headingDepth('#### deep'), 4)
})

test('a missing section is not confused with a prefix match', () => {
  const lines = '## Alpha\n\nbody\n'.split('\n')
  assert.equal(locateSection(lines, '## Alph', 2), null)
})
