import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const owner = path('../do-work/calendar-invite-file.ts');
const copies = [
  path('../../booking-slots-and-invitations/do-work/calendar-invite-file.ts'),
  path('../packages/calendar-booker/do-work/calendar-invite-file.ts'),
];

test('every shipped copy of the calendar invitation file holds the owner\'s bytes', () => {
  const expected = readFileSync(owner);
  for (const copy of copies) assert.deepEqual(readFileSync(copy), expected, `${copy} differs from the owner`);
});
