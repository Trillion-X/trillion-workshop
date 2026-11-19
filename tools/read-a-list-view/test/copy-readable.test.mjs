// When a list's file copy may be read (read-data/copy-readable.mjs): readable only when the caller's reading of the list
// says it could not be reached or answered with an unavailable code, never when the list answered, and closed when no
// reading is handed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyReadable } from '../read-data/copy-readable.mjs';

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const ask = reading => copyReadable({ names: NAMES, list: 'notes', reading });

test('a list that answers keeps its copy closed, with or without its record', () => {
  assert.equal(ask({ answered: true }).readable, false);
  assert.equal(copyReadable({ names: NAMES, list: 'no-such-list', reading: { answered: true } }).readable, false);
});

test('a list that answers unavailable opens its copy, read-only; another refusal does not', () => {
  const open = ask({ code: 'original_workspace_source_unavailable' });
  assert.equal(open.readable, true);
  assert.equal(open.code, 'original_workspace_source_unavailable');
  const closed = ask({ code: 'current_workspace_rights_refused' });
  assert.equal(closed.readable, false);
  assert.equal(closed.code, 'current_workspace_rights_refused');
});

test('a store that cannot be reached at all opens the copy', () => {
  const answer = ask({ unreachable: true });
  assert.equal(answer.readable, true);
  assert.equal(answer.code, 'unreachable');
});

test('a guard that hands in no reading of the list keeps the copy closed, never reads it as unavailable', () => {
  const answer = ask(undefined);
  assert.equal(answer.readable, false);
  assert.equal(answer.code, 'not_checked');
  assert.equal(ask({ answered: true, unreachable: false, code: 'unavailable' }).readable, false);
});

test('a bad name or list is refused', () => {
  assert.throws(() => copyReadable({ names: NAMES, list: '', reading: { answered: true } }), error => error.code === 'bad_input');
});
