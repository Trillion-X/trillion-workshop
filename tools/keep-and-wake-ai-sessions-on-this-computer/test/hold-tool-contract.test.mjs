// The hold's own answer (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs holdView) passes the output contract of the tool that returns it
// (tool:hold-on-what-needs-me in records/workshop-account-tool-records.json): 2026-10-10 an aside ran and failed its own
// contract ("output.finishes must be object") because the schema said one object where the answer gives every way a
// held thing finishes, as a list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import settings from '../src/waiting-on-you.json' with { type: 'json' };
import { holdView } from '../../hold-one-thing-until-done/read-data/needs-you-hold.mjs';
import { schemaProblems } from '../src/workshop.mjs';

const records = JSON.parse(readFileSync(new URL('../records/workshop-account-tool-records.json', import.meta.url), 'utf8'));
function toolOf(value, id) {
  if (Array.isArray(value)) { for (const item of value) { const found = toolOf(item, id); if (found) return found; } return null; }
  if (!value || typeof value !== 'object') return null;
  if (value.id === id && value.output_schema) return value;
  for (const item of Object.values(value)) { const found = toolOf(item, id); if (found) return found; }
  return null;
}

test('the hold tool answers inside its own output contract, with something held and with nothing held', () => {
  const tool = toolOf(records, 'tool:hold-on-what-needs-me');
  assert.ok(tool, 'the hold tool is a Workshop row');
  const card = { id: 'asks:ein', source: 'asks', title: 'Paste the EIN', detail: 'Stripe asks for it.', at: new Date(Date.now() - 3_600_000).toISOString(), finish: 'Paste it' };
  const hold = { ...settings.hold, default_on: true };
  for (const cards of [[card], []]) {
    const answer = { finishes: settings.finishes, hold, sections: [{ id: 'asks', title: 'Your AIs need you to', icon: 'Hand', finish: 'Tap done', cards }] };
    // As the store answers it (src/person-store.mjs needsYouHold): the view with its words.
    const view = holdView(answer, {}, hold, Date.now());
    const output = { ...view, said: view.held ? hold.words.held.replace('{title}', view.held.card.title ?? '') : hold.words.free, words: hold.words };
    assert.deepEqual(schemaProblems(output, tool.output_schema, 'output'), [], `${cards.length ? 'held' : 'nothing held'}: no contract problem`);
  }
});
