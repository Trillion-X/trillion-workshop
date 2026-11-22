// tools/workspace-screens/test/owner-place.test.ts
// The owner-places record is read in one place: owner-place.ts gives back a role's place from one tool run, a missing role
// answers null, and a record that cannot be read throws. A source check keeps every other screen reading through it, so a
// second copy of the label or the role lookup cannot come back.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ownerPlaceOf } from '../web/src/workspace/owner-place.ts';
import owner from '../web/src/workspace/owner-places.json' with { type: 'json' };

const WORKSPACE = new URL('../web/src/workspace/', import.meta.url);
const CODE = /\.(ts|tsx|mjs|js)$/;
const DATA = /\.json$/;

/** A stand-in door: it records each tool run's input, and answers from the given rows in turn. */
function standIn(answers: unknown[]) {
  const runs: { tool: string; input: Record<string, unknown> }[] = [];
  const run = async (tool: string, input: Record<string, unknown>) => {
    runs.push({ tool, input });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { tool, exit_code: 0, result: answer };
  };
  return { runs, run: run as Parameters<typeof ownerPlaceOf>[1] };
}

const record = (roles: Record<string, unknown>) => ({ rows: [{ value: JSON.stringify({ roles }) }] });

test('a role is read from the owner-places record in one tool run, and its place is given back', async () => {
  const door = standIn([record({ notices: { credential_name: 'a-connection', table: 'notices' }, other: { credential_name: 'b-connection', table: 'x' } })]);
  const place = await ownerPlaceOf<{ credential_name: string; table: string }>('notices', door.run);

  assert.equal(door.runs.length, 1);
  assert.deepEqual(door.runs[0].input, {
    credential_name: owner.credential_name,
    sql: owner.sql,
    params: [owner.label],
    statement_timeout_ms: owner.statement_timeout_ms,
  });
  assert.equal(owner.statement_timeout_ms, 5000);
  assert.deepEqual(place, { credential_name: 'a-connection', table: 'notices' });
});

test('a record with no such role answers null, and no record at all answers null', async () => {
  assert.equal(await ownerPlaceOf('missing', standIn([record({})]).run), null);
  assert.equal(await ownerPlaceOf('missing', standIn([{ rows: [] }]).run), null);
});

test('a record that cannot be read throws, so the caller asks or refuses', async () => {
  await assert.rejects(ownerPlaceOf('notices', standIn([new Error('connection refused')]).run), /connection refused/);
});

test('only the shared reader names the owner-places label, and every reader of a role goes through it', () => {
  const files = readdirSync(WORKSPACE, { recursive: true }).map(String);
  const labelLiteral = /["']owner-places["']/;
  const holders = files.filter(name => (CODE.test(name) || DATA.test(name)) && labelLiteral.test(readFileSync(new URL(name, WORKSPACE), 'utf8')));
  assert.deepEqual(holders.sort(), ['owner-places.json']);

  const roleLookup = /\.roles\b|\broles\?\./;
  const lookups = files.filter(name => CODE.test(name) && roleLookup.test(readFileSync(new URL(name, WORKSPACE), 'utf8')));
  assert.deepEqual(lookups, ['owner-place.ts']);

  for (const reader of ['door-grant-approval.ts', 'send-to-seeds.ts']) {
    assert.match(readFileSync(new URL(reader, WORKSPACE), 'utf8'), /import \{[^}]*ownerPlaceOf[^}]*\} from '\.\/owner-place\.ts'/, reader);
  }
});
