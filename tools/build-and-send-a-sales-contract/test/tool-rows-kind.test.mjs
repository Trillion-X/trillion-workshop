// The sales tool rows (tool-rows.json) are the rows the engine lists: every payload has the kind every listed tool has
// (ai-tool-descriptor, as tool:run-sql-in-my-database and tool:plan-what-a-sent-deal-sets-up), and the run kind sits under
// invoke.kind. The sales process reads its database connection on descriptor 3, so its row names that mount.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LISTED_KIND = 'ai-tool-descriptor';
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

test('every payload in tool-rows.json is the kind the engine lists', () => {
  assert.ok(rows.records.length > 0);
  for (const record of rows.records) {
    assert.equal(record.payload.kind, LISTED_KIND, `${record.payload.id} is ${record.payload.kind}, not ${LISTED_KIND}`);
    assert.equal(typeof record.payload.invoke?.kind, 'string', `${record.payload.id} names its run kind under invoke.kind`);
  }
});

test('the sales contract row mounts its database connection on descriptor 3', () => {
  const sales = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:sales-contracts');
  assert.ok(sales, 'tool:sales-contracts is in tool-rows.json');
  const mounts = sales.invoke.credential_mounts ?? [];
  assert.ok(mounts.some(mount => mount.fd === 3 && mount.secret_name_from_database === 'database'));
  assert.equal(sales.invoke.argv.at(-1), '/opt/build-and-send-a-sales-contract/do-work/sales-contract-sql.mjs');
});
