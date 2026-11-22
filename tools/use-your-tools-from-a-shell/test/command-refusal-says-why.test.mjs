// tools/use-your-tools-from-a-shell/test/command-refusal-says-why.test.mjs
//
// A refusal says why. The engine's own words come first: a string detail, or an object detail's `words` (its
// pin_not_this_computer and wake_not_declared). A code with no plain words in this command's table is said with its code
// and the engine's cause, never as the bare "did not do that" (Nov 22 2026, 2:34 AM CST: `schedule on` of a wake no
// row declares answered only "{which} did not do that.").
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, speakFor } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'cd'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-refusal-says-why-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** A door that refuses every call with `refused` as its structured answer. */
function refusingDoor(refused) {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: refused, content: [] } });
  };
  return { fetchImpl };
}

const run = (door) => main(['op', 'wake:switch', '{"tool":"tool:nothing-here","id":"no-such-wake","on":true}', '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const CAUSE = 'caller@src/native_entry/computer.rs:988:62:refusal#abc';

test("an object detail's words are said", async () => {
  const words = 'No tool row you have declares the wake no-such-wake of tool:nothing-here, so it was not switched.';
  await assert.rejects(run(refusingDoor({ code: 'original_input_refused', cause: CAUSE, detail: { why: 'wake_not_declared', words } })),
    error => error.message.startsWith(words));
});

test('a string detail is said as it is', async () => {
  await assert.rejects(run(refusingDoor({ code: 'original_input_refused', cause: CAUSE, detail: 'The engine said this.' })),
    error => error.message.startsWith('The engine said this.'));
});

test('a code with no words of its own is said with its code and cause, not as the bare line', async () => {
  await assert.rejects(run(refusingDoor({ code: 'original_input_refused', cause: CAUSE })), error => {
    assert.match(error.message, /did not do that\. Code: original_input_refused\./);
    assert.ok(error.message.includes(`Cause: ${CAUSE}`), error.message);
    return true;
  });
});

test('a code with plain words keeps them, with no cause added', async () => {
  await assert.rejects(run(refusingDoor({ code: 'original_command_conflict', cause: CAUSE })), error => {
    assert.ok(error.message.startsWith('That changed in the meantime, so nothing was written.'), error.message);
    assert.equal(error.message.includes('Cause:'), false, error.message);
    return true;
  });
});
