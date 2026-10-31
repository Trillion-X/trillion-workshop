// The rows as the container runs them: each row's sample run is executed through the records-door command with the
// row's own argv, and the money rules are read off the rows themselves: a row that can reach Stripe mounts the
// person's key by name and no row carries a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const tools = join(import.meta.dirname, '..', '..');
const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const onThisComputer = word => (word.startsWith('/opt/') ? join(tools, word.slice('/opt/'.length)) : word);

const pointsAtRecords = row => row.invoke.argv.includes('/opt/records-door/do-work/run-an-export.mjs');

test('every row runs the one records-door command on a function this folder exports', async () => {
  const module = await import(join(import.meta.dirname, '..', 'do-work', 'take-payments.mjs'));
  for (const row of rows) {
    assert.ok(pointsAtRecords(row), `${row.id} runs through the records-door command`);
    const name = row.invoke.argv.at(-1);
    assert.equal(typeof module[name], 'function', `${row.id} names ${name}, which take-payments.mjs exports`);
  }
  assert.equal(new Set(rows.map(row => row.invoke.argv.at(-1))).size, rows.length, 'one function per row');
});

test('a row can reach the internet only to talk to Stripe with the person\'s own key, and no row holds a key', () => {
  for (const row of rows) {
    const mounts = row.invoke.credential_mounts ?? [];
    if (row.invoke.internet) assert.equal(mounts.length, 1, `${row.id} reaches Stripe with exactly one held key`);
    if (mounts.length) assert.ok(row.invoke.internet || row.id === 'tool:check-a-stripe-event', `${row.id} mounts a secret only to use it`);
    for (const mount of mounts) assert.match(mount.secret_name, /^stripe-[a-z-]+$/, `${row.id} names its held value`);
    assert.doesNotMatch(JSON.stringify(row), /\b(?:sk|rk|whsec)_[A-Za-z0-9]/, `${row.id} carries no key`);
    assert.ok(new Set(mounts.map(mount => mount.fd)).size === mounts.length && mounts.every(mount => mount.fd >= 4), `${row.id} keeps descriptor 3 for the records door`);
  }
});

test('rows ask the records door only to list or read, never to write or remove', () => {
  for (const row of rows) {
    for (const right of row.invoke.records?.rights ?? []) {
      assert.ok(right.operations.every(operation => ['records:list', 'records:read'].includes(operation)), `${row.id} only reads ${right.kind}`);
    }
  }
});

test('each sample run answers what the row says it should', async () => {
  const checked = [];
  for (const row of rows) {
    for (const sample of (row.verify ?? []).filter(item => item.kind === 'sample-run')) {
      const [command, ...rest] = row.invoke.argv.map(onThisComputer);
      const child = promisify(execFile)(command === 'node' ? process.execPath : command, rest, { cwd: tools });
      child.child.stdin.end(JSON.stringify(sample.input));
      const { stdout } = await child;
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
  assert.deepEqual(checked.sort(), ['tool:check-what-a-buyer-paid', 'tool:price-a-sale', 'tool:show-which-offers-a-buyer-may-see']);
});
