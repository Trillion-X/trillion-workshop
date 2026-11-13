// tools/workflows/test/calendar-ids-are-record-addresses.test.mjs
//
// A workflow step that tells an AI to write a calendar task or task list names its row by its record address
// (record:calendar-task:<key>, record:calendar-task-list:<key>). A bare `calendar-task:<key>` writes a row no list reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['../published/workflow-steps.json', '../recipes/workflows.json'];
const BARE = /(?<!record:)calendar-task(?:-list)?:/g;

for (const file of FILES) {
  test(`${file} names calendar rows only by their record address`, () => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const bare = [...text.matchAll(BARE)].map(match => text.slice(Math.max(0, match.index - 20), match.index + 30));
    assert.deepEqual(bare, [], 'bare calendar ids in workflow steps');
  });
}
