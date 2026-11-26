// tools/ask-questions-sort-answers-follow-up/test/refusal-statuses.test.ts
//
// Every refusal a page's steps throw names its own HTTP status (sitting.ts refusal), so none reaches the site's door
// (serve-a-sites-pages-from-its-rows door.ts) without one and is answered as a bare 502. This reads every throw in the step files
// of the form pages and the booking pages, so a new refusal that names no status fails here, and checks every named refusal of a
// sitting or a page has its status. The steps' own tests check each family answers the right status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_STATUS, SITTING_REFUSALS } from '../steps/sitting.ts';
import { FORM_PAGE_REFUSALS } from '../steps/form-page-steps.ts';

const STEP_FOLDERS = ['../steps/', '../../take-a-booking-one-step-at-a-time/steps/'].map(folder => fileURLToPath(new URL(folder, import.meta.url)));

test('every throw in the step files is a refusal that names its status', () => {
  let throws = 0;
  for (const folder of STEP_FOLDERS) {
    for (const name of readdirSync(folder).filter(file => file.endsWith('.ts'))) {
      const source = readFileSync(folder + name, 'utf8');
      for (const [at, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('//')) continue;
        for (const found of line.matchAll(/\bthrow\s+(\S+?)\(/g)) {
          throws += 1;
          assert.ok(['refusal', 'refused'].includes(found[1]), `${name}:${at + 1} throws ${found[1]}(...), which names no status: use refusal(message, status)`);
        }
        assert.ok(!/\bthrow\s+(?!refusal\(|refused\()/.test(line.replace(/\/\/.*$/, '')), `${name}:${at + 1} throws something other than a refusal`);
      }
    }
  }
  assert.ok(throws > 20, `the step files were read (${throws} throws)`);
});

test('every named refusal of a sitting or a form page has its status', () => {
  for (const name of new Set([...Object.keys(SITTING_REFUSALS), ...Object.keys(FORM_PAGE_REFUSALS), 'out_of_order'])) {
    const status = REFUSAL_STATUS[name];
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 499, `${name} names a status a visitor's own state answers (got ${status})`);
  }
});
