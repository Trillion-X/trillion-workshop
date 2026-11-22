// tools/make-a-login-on-every-computer/test/make-a-login.test.mjs
//
// Made-up door answers only. The stub door keeps each request body, so the test can show the order of calls, where the
// password travels (the vault puts, and nowhere else), and that no answer, error or result carries it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionOf, inputOf, makeLogin } from '../do-work/make-a-login.mjs';
import { engineClient } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const PASSWORD = 'synthetic-password-made-for-this-test-only-0123456789abcdefghij';
const INPUT = {
  login: 'synthetic_post_writer', database: 'synthetic_pursuit', host: 'synthetic.example.test',
  pins: ['synthetic-always-on', 'synthetic-mac'], always_on: 'synthetic-always-on',
  operator: 'synthetic-operator-connection', grants: { recipe: 'post-writer-for-a-login' },
};
const HELD = 'synthetic_post_writer-connection';

// A door that answers each call by its method. `refuse` names a pin whose vault refuses the put.
function stubDoor({ refuse = null, heldAt = ['synthetic-always-on', 'synthetic-mac'] } = {}) {
  const bodies = [];
  const fetchImpl = async (url, { body }) => {
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const call = parsed.params.arguments;
    let answer;
    if (call.method === 'secrets:put') answer = call.pins?.[0] === refuse ? { accepted: false } : { accepted: true };
    else if (call.method === 'secrets:names') answer = { names: heldAt.includes(call.pins?.[0]) ? [HELD] : [] };
    else answer = { exit_code: 0, rows: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { structuredContent: answer, isError: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = engineClient({ door: { name: 'test door', mcp: 'https://door.test/mcp' }, credential: { kind: 'key', bearer: 'nm_synthetic' }, fetchImpl });
  return { client, bodies };
}

test('the password is put to every pin, read back on every pin, and only then made into the role and its grants', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: INPUT, client, password: PASSWORD });
  const calls = bodies.map(body => body.params.arguments);
  assert.deepEqual(calls.map(call => `${call.method}@${call.pins?.[0] ?? '-'}`), [
    'secrets:put@synthetic-always-on', 'secrets:put@synthetic-mac',
    'secrets:names@synthetic-always-on', 'secrets:names@synthetic-mac',
    'tools:run@synthetic-always-on', 'tools:run@synthetic-always-on']);
  const values = calls.filter(call => call.method === 'secrets:put').map(call => call.input.value);
  assert.equal(values[0], values[1], 'every pin holds the same connection string');
  assert.equal(values[0], connectionOf({ login: INPUT.login, password: PASSWORD, database: INPUT.database, host: INPUT.host }));
  assert.deepEqual(calls[0].input.hosts, [INPUT.host]);
  assert.equal(calls[4].input.input.recipe.name, 'a-login');
  assert.equal(calls[4].input.input.role_credential_name, HELD);
  assert.equal(calls[5].input.input.recipe.name, 'post-writer-for-a-login');
  assert.deepEqual(made, { login: INPUT.login, held_name: HELD, held_at: INPUT.pins, role_made: true, grants: 'post-writer-for-a-login' });
});

test('the password is not in the answer, in any error, or in a tool run: it travels only in the vault puts', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: INPUT, client, password: PASSWORD });
  assert.ok(!JSON.stringify(made).includes(PASSWORD));
  for (const body of bodies) {
    if (body.params.arguments.method !== 'secrets:put') assert.ok(!JSON.stringify(body).includes(PASSWORD), 'only the puts carry the value');
  }
});

test('a refused put stops the run before any role is made, and names the pin without the password', async () => {
  const { client, bodies } = stubDoor({ refuse: 'synthetic-mac' });
  await assert.rejects(makeLogin({ input: INPUT, client, password: PASSWORD }), error => {
    assert.match(error.message, /synthetic-mac/);
    assert.match(error.message, /did not accept/);
    assert.ok(!error.message.includes(PASSWORD));
    return true;
  });
  assert.ok(bodies.every(body => body.params.arguments.method !== 'tools:run'), 'no role was made');
});

test('a value missing on read-back stops the run before any role is made', async () => {
  const { client, bodies } = stubDoor({ heldAt: ['synthetic-always-on'] });
  await assert.rejects(makeLogin({ input: INPUT, client, password: PASSWORD }), /synthetic-mac is not held|not held at synthetic-mac/);
  assert.ok(bodies.every(body => body.params.arguments.method !== 'tools:run'), 'no role was made');
});

test('the input is checked before anything is put: the operator pin must be one of the pins, and names are plain', () => {
  assert.throws(() => inputOf({ ...INPUT, always_on: 'elsewhere' }), /always_on must be one of the pins/);
  assert.throws(() => inputOf({ ...INPUT, login: 'Bad Name' }), /login must be a role name/);
  assert.throws(() => inputOf({ ...INPUT, pins: ['synthetic-mac', 'synthetic-mac'] }), /name each computer once/);
  assert.throws(() => inputOf({ ...INPUT, grants: {} }), /grants must be/);
  assert.deepEqual(inputOf(INPUT).pins, INPUT.pins);
});

test('with make_role false the value is put and read back on every pin, and no role or grant is made', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: { ...INPUT, make_role: false, operator: undefined, grants: undefined }, client, password: PASSWORD });
  assert.deepEqual(made, { login: INPUT.login, held_name: HELD, held_at: INPUT.pins, role_made: false, grants: null });
  assert.deepEqual(bodies.map(body => body.params.arguments.method), ['secrets:put', 'secrets:put', 'secrets:names', 'secrets:names']);
});
