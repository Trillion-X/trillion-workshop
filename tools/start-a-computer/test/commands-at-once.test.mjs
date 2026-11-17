import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { onMachine } from '../do-work/start-a-computer.mjs';

// sshd resets connections beyond its half-open limit (MaxStartups), so a layout with many units must not open every check at once.
test('at most four commands run on a machine at a time, and all of them finish', async () => {
  let live = 0, most = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    live++; most = Math.max(most, live);
    setTimeout(() => { live--; child.stdout.end('ok'); child.emit('close', 0); }, 20);
    return child;
  };
  const machine = { ssh: { known_hosts: '/tmp/known_hosts' }, address: '203.0.113.9' };
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => onMachine(machine, `test -e /x${i}`, undefined, spawnImpl)));
  assert.equal(answers.length, 20);
  assert.ok(answers.every(answer => answer === 'ok'));
  assert.equal(most, 4);
});
