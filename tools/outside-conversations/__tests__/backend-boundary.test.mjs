import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const backendFiles = [
  `${root}/read-data/read-outside-conversations.ts`,
  `${root}/read-data/generic-record-work-graph.ts`,
  `${root}/do-work/request-outside-conversation-transition.ts`,
  `${root}/do-work/generic-record-work-actions.ts`,
];

const forbiddenAuthorityPatterns = [
  /OUTSIDE_CONVERSATION_RECORD_KINDS/,
  /OUTSIDE_CONVERSATION_WAITING_PACKAGES/,
  /OUTSIDE_CONVERSATION_OPEN_BLOCKER_OWNER_PACKAGES/,
  /surfaceStatus/,
  /nextStepFor/,
  /status:\s*'empty'\s*\|\s*'blocked'\s*\|\s*'working'\s*\|\s*'ready'/,
  /status_ref\s*===/,
  /owner\s*===/,
];

test('backend files do not retain package-specific policy authority', () => {
  for (const file of backendFiles) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbiddenAuthorityPatterns) {
      assert.doesNotMatch(source, pattern, `${file} still matches ${pattern}`);
    }
  }
});

test('package boundary seeds descriptor graph rather than record contracts', () => {
  const boundary = JSON.parse(readFileSync(`${root}/things-to-store-and-run.json`, 'utf8'));
  const serialized = JSON.stringify(boundary);
  assert.equal(serialized.includes('"record-contracts"'), false);
  assert.match(serialized, /generic-record-work-graph/);
  assert.match(serialized, /record_type/);
  assert.match(serialized, /action_descriptor/);
});
