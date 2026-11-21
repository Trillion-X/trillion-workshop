// A parts screen's `run` request runs the tool that declared the screen, and only that tool. A declaration or a spec that
// names another tool is refused before anything is sent. The saved-module validator still refuses the door: a saved
// screen's code gets no door call from its declarations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRunRequest, runFor, runInputFor } from '../web/src/workspace/declared-run.mjs';
import { validateModuleSurfaceRequests } from '../../ui/show/isolated-module-surface/module-surface-requests.mjs';

const DECLARING = 'tool:hello-from-elsewhere';
const run = { run: { input_schema: { type: 'object', properties: { words: { type: 'string' } }, required: ['words'] } } };

test('a parts request runs the declaring tool, with the input the spec gives', () => {
  assert.equal(isRunRequest(run), true);
  assert.equal(isRunRequest({ method: 'POST', path: '/work/api/records' }), false);
  assert.deepEqual(runFor(run, DECLARING, { words: 'hello' }), { tool: DECLARING, input: { words: 'hello' } });
});

test('a spec cannot name a different tool: a tool key in its input, a tool in the declaration, or no declaring tool', () => {
  assert.throws(() => runFor(run, DECLARING, { words: 'hi', tool: 'tool:someone-else' }));
  assert.throws(() => runFor(run, DECLARING, { words: 'hi', tool_id: 'tool:someone-else' }));
  assert.throws(() => runFor({ run: { tool: 'tool:someone-else' } }, DECLARING, { words: 'hi' }));
  assert.throws(() => runFor({ ...run, path: '/work/api/door/tools:run' }, DECLARING, { words: 'hi' }));
  assert.throws(() => runFor(run, undefined, { words: 'hi' }));
  assert.throws(() => runFor(run, '', { words: 'hi' }));
});

test('the run input is checked against the declared input schema', () => {
  assert.throws(() => runFor(run, DECLARING, { words: 'hi', extra: 1 }), /unavailable/);
  assert.throws(() => runFor(run, DECLARING, {}), /unavailable/);
  assert.throws(() => runFor(run, DECLARING, { words: 'x'.repeat(40000) }), /unavailable/);
});

test('the saved-module validator still refuses the door', () => {
  const door = { call: { method: 'POST', path: '/work/api/door/tools:run', body: { tool: 'tool:anything' } } };
  assert.throws(() => validateModuleSurfaceRequests(door));
  assert.throws(() => validateModuleSurfaceRequests({ call: { method: 'GET', path: '/work/api/door/tools:list' } }));
});

test('a run request carries the surface input fields its input schema names, and the call\'s own input wins', () => {
  const declaration = { run: { input_schema: { type: 'object', properties: { piece: { type: 'string' }, credential_name: { type: 'string' }, words: { type: 'string' } }, required: ['piece', 'credential_name'] } } };
  const surface = { piece: 'phrase-7', credential_name: 'vault-key-x', tab: 'open' };
  assert.deepEqual(runFor(declaration, DECLARING, runInputFor(declaration, surface, {})).input, { piece: 'phrase-7', credential_name: 'vault-key-x' });
  assert.deepEqual(runInputFor(declaration, surface, { piece: 'other', words: 'hi' }), { piece: 'other', credential_name: 'vault-key-x', words: 'hi' });
  assert.deepEqual(runInputFor(declaration, { ...surface, tool_id: 'tool:someone-else' }, {}).tool_id, undefined, 'tool_id is never carried');
  assert.equal(runInputFor(declaration, { piece: undefined }, {}).piece, undefined, 'an unset surface field is not sent');
});

test('a run request with no input schema carries no surface input, and a non-run request is untouched by the run input', () => {
  assert.deepEqual(runInputFor({ run: {} }, { piece: 'phrase-7' }, {}), {});
  assert.deepEqual(runInputFor({ run: {} }, { piece: 'phrase-7' }, { words: 'hi' }), { words: 'hi' });
  assert.equal(isRunRequest({ method: 'GET', path: '/work/api/records' }), false);
});
