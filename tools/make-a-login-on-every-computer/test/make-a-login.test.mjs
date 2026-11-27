// tools/make-a-login-on-every-computer/test/make-a-login.test.mjs
//
// Made-up door answers only. The stub door keeps each request body, so the test can show the order of calls, where the password
// travels (this computer's vault put, and nowhere else), and that no answer, error or tool run carries it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionOf, inputOf, makeLogin } from '../do-work/make-a-login.mjs';
import { engineClient } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const PASSWORD = 'synthetic-password-made-for-this-test-only-0123456789abcdefghij';
const INPUT = {
  login: 'synthetic_pursuit_post_writer', database: 'synthetic_pursuit', host: 'synthetic.example.test', computer: 'synthetic-mac',
  operator: 'synthetic-operator-connection', grants: { recipe: 'post-writer-for-a-login' },
};
const HELD = 'synthetic_pursuit_post_writer-connection';
const ROLE = 'synthetic_pursuit_post_writer_synthetic_mac';

// A door that answers each call by its method. `refuse` makes this computer's vault refuse the put; `heldAt` says whether the name
// reads back; `roleExists` says whether the role is already on the database.
function stubDoor({ refuse = false, heldAt = true, roleExists = false } = {}) {
  const bodies = [];
  const fetchImpl = async (url, { body }) => {
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const call = parsed.params.arguments;
    let answer;
    if (call.method === 'secrets:put') answer = { accepted: !refuse };
    else if (call.method === 'secrets:names') answer = { names: heldAt ? [HELD] : [] };
    else if (call.input?.input?.sql) answer = { exit_code: 0, result: { rows: [{ n: roleExists ? 1 : 0 }] } };
    else answer = { exit_code: 0, result: { rows: [] } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { structuredContent: answer, isError: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = engineClient({ door: { name: 'test door', mcp: 'https://door.test/mcp' }, credential: { kind: 'key', bearer: 'nm_synthetic' }, fetchImpl });
  return { client, bodies };
}

const methods = bodies => bodies.map(body => body.params.arguments.method === 'tools:run'
  ? `tools:run:${body.params.arguments.input.input?.recipe?.name ?? 'sql'}`
  : body.params.arguments.method);

test('this computer puts the value, reads the name back, then makes its own role and gives the grants: no route, no other computer', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: INPUT, client, password: PASSWORD });
  assert.deepEqual(methods(bodies), ['tools:run:sql', 'secrets:put', 'secrets:names', 'tools:run:a-login', 'tools:run:post-writer-for-a-login']);
  for (const body of bodies) assert.equal(body.params.arguments.pins, undefined, 'no call names another computer');
  const put = bodies[1].params.arguments.input;
  assert.equal(put.name, HELD);
  assert.deepEqual(put.hosts, [INPUT.host]);
  assert.equal(put.value, connectionOf({ role: ROLE, password: PASSWORD, database: INPUT.database, host: INPUT.host }));
  assert.equal(bodies[3].params.arguments.input.input.role_credential_name, HELD);
  assert.equal(bodies[4].params.arguments.input.input.recipe.role, ROLE);
  assert.deepEqual(made, { login: INPUT.login, role: ROLE, held_name: HELD, held_at: [INPUT.computer], role_made: true, grants: 'post-writer-for-a-login' });
});

test('the password is not in the answer and not in any tool run: it travels only in this computer\'s vault put', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: INPUT, client, password: PASSWORD });
  assert.ok(!JSON.stringify(made).includes(PASSWORD));
  for (const body of bodies) {
    if (body.params.arguments.method !== 'secrets:put') assert.ok(!JSON.stringify(body).includes(PASSWORD), 'only the vault put carries the value');
  }
});

test('a refused put stops the run before any role is made, and the answer carries no password', async () => {
  const { client, bodies } = stubDoor({ refuse: true });
  await assert.rejects(makeLogin({ input: INPUT, client, password: PASSWORD }), error => {
    assert.match(error.message, /did not accept/);
    assert.ok(!error.message.includes(PASSWORD));
    return true;
  });
  assert.ok(bodies.every(body => !body.params.arguments.input?.input?.recipe), 'no role was made');
});

test('a value missing on read-back stops the run before any role is made', async () => {
  const { client, bodies } = stubDoor({ heldAt: false });
  await assert.rejects(makeLogin({ input: INPUT, client, password: PASSWORD }), /is not held on this computer on read-back/);
  assert.ok(bodies.every(body => !body.params.arguments.input?.input?.recipe), 'no role was made');
});

test('a re-run where the role exists checks the held value, puts no new password and makes no role, and gives the grants', async () => {
  const { client, bodies } = stubDoor({ roleExists: true });
  const made = await makeLogin({ input: INPUT, client, password: PASSWORD });
  assert.deepEqual(methods(bodies), ['tools:run:sql', 'secrets:names', 'tools:run:post-writer-for-a-login']);
  assert.equal(made.role_made, true);
  assert.ok(!JSON.stringify(made).includes(PASSWORD));
});

test('a re-run where the role exists but the held value is missing stops and says a password reset is needed', async () => {
  const { client, bodies } = stubDoor({ roleExists: true, heldAt: false });
  await assert.rejects(makeLogin({ input: INPUT, client, password: PASSWORD }), /password reset is needed/);
  assert.ok(bodies.every(body => body.params.arguments.method !== 'secrets:put'), 'nothing is rotated');
});

test('with make_role false the value is put and read back on this computer, and no role or grant is made', async () => {
  const { client, bodies } = stubDoor();
  const made = await makeLogin({ input: { ...INPUT, make_role: false, operator: undefined, grants: undefined }, client, password: PASSWORD });
  assert.deepEqual(made, { login: INPUT.login, role: ROLE, held_name: HELD, held_at: [INPUT.computer], role_made: false, grants: null });
  assert.deepEqual(methods(bodies), ['secrets:put', 'secrets:names']);
});

test('a held_name is the exact vault name: put, read back, handed to a-login and answered under it, never <login>-connection', async () => {
  const held = 'synthetic_pursuit-writer-connection';
  const bodies = [];
  const fetchImpl = async (url, { body }) => {
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const call = parsed.params.arguments;
    const answer = call.method === 'secrets:put' ? { accepted: true }
      : call.method === 'secrets:names' ? { names: [held] }
      : call.input?.input?.sql ? { exit_code: 0, result: { rows: [{ n: 0 }] } } : { exit_code: 0, result: { rows: [] } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { structuredContent: answer, isError: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = engineClient({ door: { name: 'test door', mcp: 'https://door.test/mcp' }, credential: { kind: 'key', bearer: 'nm_synthetic' }, fetchImpl });
  const made = await makeLogin({ input: { ...INPUT, held_name: held }, client, password: PASSWORD });
  assert.equal(bodies[1].params.arguments.input.name, held);
  assert.equal(bodies[3].params.arguments.input.input.role_credential_name, held);
  assert.equal(made.held_name, held);
  assert.equal(made.role, ROLE, 'the role name still comes from login and computer');
  assert.ok(bodies.every(body => !JSON.stringify(body).includes(HELD)), 'the default name is never used');
  assert.equal(inputOf(INPUT).heldName, HELD, 'with no held_name the default stays <login>-connection');
  assert.throws(() => inputOf({ ...INPUT, held_name: 'Not A Name' }), /held_name must be/);
  assert.throws(() => inputOf({ ...INPUT, held_name: 'synthetic_pursuit-writer' }), /held_name must be/);
});

test('the input is checked before anything is put: the computer is a short name, names are plain, the operator is needed to make a role', () => {
  assert.throws(() => inputOf({ ...INPUT, computer: 'Bad Name' }), /computer must be this computer's short name/);
  assert.throws(() => inputOf({ ...INPUT, computer: undefined }), /computer must be/);
  assert.throws(() => inputOf({ ...INPUT, login: 'Bad Name' }), /login must be a name/);
  assert.throws(() => inputOf({ ...INPUT, operator: undefined }), /operator must be/);
  assert.throws(() => inputOf({ ...INPUT, grants: {} }), /grants must be/);
  assert.equal(inputOf(INPUT).role, ROLE);
});

test('the row runs on the person\'s own computer (kind computer), takes its grant from the listed row, and packs the script and the door client it imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const row = JSON.parse(await readFile(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records[0].payload;
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.records, { fd: 3, from_listed_row: true });
  assert.deepEqual(row.invoke.run.slice(0, 2), ['node', '--no-warnings']);
  const packed = row.invoke.files.package_files.flatMap(entry => entry.paths);
  assert.ok(packed.includes('do-work/make-a-login.mjs'));
  assert.ok(packed.includes('do-work/command.mjs'));
  assert.equal(row.invoke.records.rights, undefined, 'the grant is read from the listed row, not declared here');
});
