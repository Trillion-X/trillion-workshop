// The rows as the container runs them: each row's sample run is executed through the function runner with the
// row's own argv, and the money rules are read off the rows themselves: a row that can reach Stripe mounts the
// person's key by name and no row carries a key.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tools = join(import.meta.dirname, '..', '..');

// One row's command with its input on stdin (no descriptor beyond the three standard ones: no row mounts a door); a non-zero exit rejects with its stdout.
function runWithDoor(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: tools, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(stderr || `exit ${code}`), { stdout }));
    });
    child.stdin.end(JSON.stringify(input));
  });
}
const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const onThisComputer = word => (word.startsWith('/opt/') ? join(tools, word.slice('/opt/'.length)) : word);

const pointsAtRunner = row => row.invoke.argv[1] === '/opt/workflows/do-work/run-a-function.mjs';

test('every row runs the one function runner on a function this folder exports, and mounts no records door', async () => {
  for (const row of rows) {
    // take-payments.mjs, or for the checkout that reads its own offers the file that wraps its function.
    const module = await import(onThisComputer(row.invoke.argv[2]));
    assert.ok(pointsAtRunner(row), `${row.id} runs through the workflows function runner`);
    assert.ok(!(row.invoke.files?.package_files ?? []).some(spec => spec.package === 'records-door'), `${row.id} mounts no records door`);
    const name = row.invoke.argv.at(-1);
    assert.equal(typeof module[name], 'function', `${row.id} names ${name}, which ${row.invoke.argv[2]} exports`);
  }
  assert.equal(new Set(rows.map(row => row.invoke.argv.at(-1))).size, rows.length, 'one function per row');
});

test('a row can reach the internet only to talk to Stripe with the person\'s own key, and no row holds a key', () => {
  for (const row of rows) {
    // A row that reads its own offers (start-a-stripe-checkout given a database) also mounts that database's connection, read
    // only under a declared use with the reader login; it is not a key and never reaches Stripe.
    const reads = (row.invoke.credential_mounts ?? []).filter(mount => mount.secret_name_from_input === 'database');
    for (const mount of reads) {
      assert.deepEqual(mount, { secret_name_from_input: 'database', held_suffix: '-connection', fd: 6, only_when: { input: 'database', present: true },
        under_use: { use_from_input: 'use', ticket_fd: 7, held_suffix: '-reader-connection', key_suffix: '-use-key' } }, `${row.id} reads its database on 6 under a use`);
    }
    const mounts = (row.invoke.credential_mounts ?? []).filter(mount => !reads.includes(mount));
    if (row.invoke.internet) assert.equal(new Set(mounts.map(mount => mount.fd)).size, 1, `${row.id} reaches Stripe on one descriptor`);
    if (mounts.length) assert.ok(row.invoke.internet || row.id === 'tool:check-a-stripe-event', `${row.id} mounts a secret only to use it`);
    // The key is the seller's own: the run's input names it, by its vault name, by the account it is held for, or as a field
    // of the seller's Stripe connection. The row never names a key.
    for (const mount of mounts) {
      if (mount.secret_name_from_input === 'secret_name') assert.ok(mount.held_suffix === undefined && mount.share_by_listing === true, `${row.id} mounts the named key as it is, for a share only when its grant lists that name`);
      else if (mount.secret_name_from_input) assert.equal(mount.held_suffix, '-stripe-secret-key', `${row.id} names the account's key by its ending`);
      else assert.match(mount.field_id, /^(?:secret_key|test_secret_key|webhook_secret)$/, `${row.id} names a field of the seller's connection`);
    }
    if (mounts.length) {
      assert.deepEqual(row.invoke.connection, { vendor: 'stripe', from_input: 'seller_connection' }, `${row.id} takes the seller's connection from its input`);
      // A row with the three roads requires none of them (the engine refuses two, and a run with none holds no key); a row
      // with only its connection's field requires the connection.
      const roads = mounts.some(mount => mount.secret_name_from_input === 'secret_name');
      assert.equal(row.input_schema.required.includes('seller_connection'), !roads, `${row.id} requires seller_connection only when it is the one road`);
      if (roads) assert.equal(row.input_schema.properties.secret_name?.type, 'string', `${row.id} declares secret_name`);
    }
    // A sample's held values are made up; the one a key-prefix check needs is a visibly made-up test-mode key.
    const held = (row.verify ?? []).flatMap(item => Object.values(item.held ?? {}));
    for (const value of held) assert.ok(!/\b(?:sk|rk|whsec)_/.test(value) || /^(?:sk|rk)_test_made_up_[a-z_]+$/.test(value), `${row.id}: a sample's held key is a made-up test key`);
    const withoutHeld = { ...row, verify: (row.verify ?? []).map(({ held: _held, ...item }) => item) };
    assert.doesNotMatch(JSON.stringify(withoutHeld), /\b(?:sk|rk|whsec)_[A-Za-z0-9]/, `${row.id} carries no key`);
    const fixed = mounts.filter(mount => !mount.only_when);
    assert.ok(new Set(fixed.map(mount => mount.fd)).size === fixed.length && mounts.every(mount => mount.fd >= 4), `${row.id} keeps descriptor 3 for the records door`);
  }
});

// The usage tools that compute and answer: they declare no records door (observe-live-usage only the files door that reads the engine's own day rows).
const keepNothing = ['tool:price-resource-usage', 'tool:keep-resource-usage-observation', 'tool:observe-live-usage', 'tool:settle-shared-resource-cost', 'tool:correct-resource-usage-settlement', 'tool:report-resource-usage', 'tool:reconcile-resource-usage-report'];
test('the usage tools that compute keep nothing and read no records', () => {
  for (const id of keepNothing) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, `${id} is a row of this folder`);
    const rights = rightsOf(row) ?? [];
    assert.equal(rights.length, 0, `${id} declares no right: what it reads comes in the request`);
  }
});
// No row of this folder opens the records door or declares a record right: each tool takes the rows it works from in its
// request (the caller reads them from the person's own store) and answers what to keep.
test('no row opens a records door or declares a record right; the caller hands the rows in', () => {
  for (const row of rows) {
    assert.equal(row.invoke.records, undefined, `${row.id} opens no records door`);
    assert.deepEqual(rightsOf(row) ?? [], [], `${row.id} declares no record right`);
  }
});

test('each sample run answers what the row says it should', async () => {
  const checked = [];
  for (const row of rows) {
    // A sample with an output_selector says what it should answer; one without proves only the selector, run with
    // its seeded records and recorded replies by test/every-process-row-selector.test.mjs.
    for (const sample of (row.verify ?? []).filter(item => item.kind === 'sample-run' && 'output_selector' in item)) {
      const [command, ...rest] = row.invoke.argv.map(onThisComputer);
      const stdout = await runWithDoor(command === 'node' ? process.execPath : command, rest, sample.input);
      const answer = JSON.parse(stdout.trim().split('\n').at(-1));
      assert.ok(!answer.error, `${row.id}: ${answer.error}`);
      const picked = sample.output_selector.replace(/^\$\.?/, '').split('.').filter(Boolean).reduce((value, part) => {
        const match = /^(\w+)\[(\d+)\]$/.exec(part);
        return match ? value?.[match[1]]?.[Number(match[2])] : value?.[part];
      }, answer.result);
      assert.ok(String(picked).includes(sample.contains), `${row.id}: ${JSON.stringify(picked)} should contain ${sample.contains}`);
      checked.push(row.id);
    }
  }
  assert.deepEqual(checked.sort(), ['tool:cancel-prepared-resource-usage-report', 'tool:check-what-a-buyer-paid', 'tool:manage-usage-pricing', 'tool:price-a-sale', 'tool:price-resource-usage', 'tool:read-resource-usage-report', 'tool:read-resource-usage-settlement', 'tool:show-which-offers-a-buyer-may-see']);
});

// The engine's rules for which items a run mounts (trillion-rust src/tool_runs/tools/container.rs `mount_applies` and the
// one-place check in `mounts_of`): an item with only_when {input, present} applies when that input holds text (or not), and two
// items that apply on one descriptor refuse the run before it starts.
const applies = (mount, input) => !mount.only_when || (typeof input[mount.only_when.input] === 'string' && input[mount.only_when.input] !== '') === mount.only_when.present;
const mountsFor = (row, input) => {
  const mounted = row.invoke.credential_mounts.filter(mount => applies(mount, input));
  if (new Set(mounted.map(mount => mount.fd)).size !== mounted.length) return 'refused: two keys on one descriptor';
  return mounted;
};

test('a seller key is named by exactly one of secret_name, account and seller_connection; two together are refused', () => {
  const seller = rows.filter(row => row.invoke.connection?.from_input === 'seller_connection' && row.invoke.credential_mounts?.some(mount => mount.field_id === 'secret_key'));
  assert.equal(seller.length, 19);
  const named = 'a-sellers-stripe-key';
  for (const row of seller) {
    assert.deepEqual(row.invoke.credential_mounts.filter(mount => mount.secret_name_from_input !== 'database'), [
      { secret_name_from_input: 'secret_name', share_by_listing: true, fd: 4, only_when: { input: 'secret_name', present: true } },
      { secret_name_from_input: 'account', held_suffix: '-stripe-secret-key', fd: 4, only_when: { input: 'account', present: true } },
      { fd: 4, field_id: 'secret_key', only_when: { input: 'seller_connection', present: true } },
    ], `${row.id} mounts one key, by its name, by account, or by the seller connection field`);
    // Each road alone mounts its one key on descriptor 4.
    assert.deepEqual(mountsFor(row, { secret_name: named }).map(mount => mount.secret_name_from_input), ['secret_name'], `${row.id}: secret_name alone`);
    assert.deepEqual(mountsFor(row, { account: 'shop' }).map(mount => [mount.secret_name_from_input, mount.held_suffix]), [['account', '-stripe-secret-key']], `${row.id}: account alone, as before`);
    assert.deepEqual(mountsFor(row, { seller_connection: 'service_connection:stripe:shop' }).map(mount => mount.field_id), ['secret_key'], `${row.id}: seller_connection alone`);
    // Two roads given together are refused before the run starts; none mounts no key.
    for (const both of [{ secret_name: named, account: 'shop' }, { secret_name: named, seller_connection: 'service_connection:stripe' }, { account: 'shop', seller_connection: 'service_connection:stripe' }]) {
      assert.equal(mountsFor(row, both), 'refused: two keys on one descriptor', `${row.id}: ${Object.keys(both).join(' and ')}`);
    }
    assert.deepEqual(mountsFor(row, {}), [], `${row.id}: no road, no key`);
  }
});
