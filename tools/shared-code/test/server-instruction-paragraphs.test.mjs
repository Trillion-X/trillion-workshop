// Ported from old trillion test/server-instruction-paragraphs.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The first two tests are the old ones over src/server-instruction-paragraphs.mjs here.
// The third read setupPlan (old src/setup-plan.mjs), which is held, not run (tools/walk-a-new-person-through-first-setup/
// from-old-trillion/src/setup-plan.mjs.held): setupPlan copied instructionParagraph(id) into its fields, so the plan-equality
// checks are left out and the mission's words are checked on the paragraph itself; the single-source checks are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/server-instructions.json' with { type: 'json' };
import instructions, { instructionParagraph, instructionParagraphs } from '../src/server-instruction-paragraphs.mjs';

test('named instruction paragraphs keep identity after copy and order change', () => {
  const source = { named_paragraphs: { purpose: 'A rewritten heading: the current purpose.', startup: 'Current startup words.' },
    paragraphs: ['An ordinary paragraph.', '{startup}', '{purpose}'] };
  assert.equal(instructionParagraph('purpose', source), 'A rewritten heading: the current purpose.');
  assert.deepEqual(instructionParagraphs(source), ['An ordinary paragraph.', 'Current startup words.', 'A rewritten heading: the current purpose.']);
  source.paragraphs.reverse();
  source.named_paragraphs.purpose = 'Another opening: the latest purpose.';
  assert.equal(instructionParagraph('purpose', source), 'Another opening: the latest purpose.');
  assert.deepEqual(instructionParagraphs(source), ['Another opening: the latest purpose.', 'Current startup words.', 'An ordinary paragraph.']);
});

test('missing, empty and inherited named instructions are refused instead of returned as blank', () => {
  for (const named_paragraphs of [{}, { purpose: '' }, { purpose: '   ' }, { purpose: null }, Object.create({ purpose: 'Inherited words.' })]) {
    assert.throws(() => instructionParagraphs({ paragraphs: ['{purpose}'], named_paragraphs }), /has no text/);
  }
});

test('MCP uses the same current mission and startup paragraphs once', () => {
  for (const id of ['mission', 'host-startup']) {
    const words = instructionParagraph(id);
    assert.equal(data.paragraphs.filter(text => text === `{${id}}`).length, 1);
    assert.equal(instructions.paragraphs.filter(text => text === words).length, 1);
    assert.ok(!data.paragraphs.includes(words), 'the named text has a single source');
  }
  const mission = instructionParagraph('mission');
  assert.match(mission, /more meaningful life/);
  assert.match(mission, /help them find what is true, then help them share it/);
});
