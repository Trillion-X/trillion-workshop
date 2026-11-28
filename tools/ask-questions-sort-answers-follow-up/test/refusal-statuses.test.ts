// tools/ask-questions-sort-answers-follow-up/test/refusal-statuses.test.ts
//
// Every refusal a page's steps throw names its own HTTP status (run-sql.mjs refusal, as sitting.ts hands it on), so none reaches
// the site without one and is answered as a bare 502. This reads every throw in
// the step files of the form pages, the booking pages and the words page (gather-words-from-people routes), so a new refusal that
// names no status fails here, and checks every named refusal of a sitting or a page has its status, and that a run leaves a 4xx
// refusal as the JSON line the door reads. The steps' own tests check each family answers the right status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_STATUS, SITTING_REFUSALS } from '../steps/sitting.ts';
import { FORM_PAGE_REFUSALS } from '../steps/form-page-steps.ts';
import { refusal, refusalLine } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

const STEP_FOLDERS = ['../steps/', '../../take-a-booking-one-step-at-a-time/steps/', '../../gather-words-from-people/routes/'].map(folder => fileURLToPath(new URL(folder, import.meta.url)));

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

test('a run leaves a 4xx refusal as the JSON line the door reads, and anything else as its plain words without a held value', () => {
  assert.equal(refusalLine(refusal('That time was taken.', 409)), JSON.stringify({ error: 'That time was taken.', status: 409 }));
  assert.equal(refusalLine(refusal('The calendar could not be read right now.', 503)), 'The calendar could not be read right now.');
  const held = 'made-up-held-value-7';
  assert.equal(refusalLine(new Error(`connect failed for ${held}`), held), 'connect failed for [held]');
  assert.equal(refusalLine(refusal(`Wrong at ${held}.`, 400), held), JSON.stringify({ error: 'Wrong at [held].', status: 400 }));
});
