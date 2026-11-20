// The assertions of the old source test/space-invitation.test.mjs at b6ae0ebf81 (the names and one-line people test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownName, peopleLine } from '../do-work/shown-name.mjs';

test('names that are email addresses or stand-ins are never shown; who is in it reads as one line', () => {
  assert.equal(shownName('morgan@example.com'), null);
  assert.equal(shownName('Member 3'), null);
  assert.equal(shownName('  Sam   Lee '), 'Sam Lee');
  assert.equal(peopleLine(['Morgan'], 1), 'Morgan is in it');
  assert.equal(peopleLine(['Morgan', 'Sam'], 2), 'Morgan and Sam are in it');
  assert.equal(peopleLine(['Morgan', 'Sam', 'Jo'], 3), 'Morgan, Sam and Jo are in it');
  assert.equal(peopleLine(['Morgan', 'Sam', 'Jo'], 4), 'Morgan, Sam and 2 others are in it');
  assert.equal(peopleLine(['Morgan', 'Sam', 'Jo'], 5), 'Morgan, Sam and 3 others are in it');
  assert.equal(peopleLine(['Morgan', 'user-063bcf15@example.com'], 3), 'Morgan and 2 others are in it');
  assert.equal(peopleLine(['Morgan', 'user-063bcf15@example.com'], 2), 'Morgan and one other are in it');
  assert.equal(peopleLine(['Morgan', 'Sam'], 3), 'Morgan, Sam and one other are in it');
  assert.equal(peopleLine([], 3), null);
});
