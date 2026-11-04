import test from 'node:test';
import assert from 'node:assert/strict';
import { readSpaceForList } from '../../keep-a-shared-spaces-posts-files-and-tasks/from-old-trillion/src/space-list-read.mjs';
import wait from '../src/space-list-read.json' with { type: 'json' };
import { spaceMountingIn } from '../../keep-and-wake-ai-sessions-on-this-computer/src/failure.mjs';

test('a read that never ends makes the list answer busy within the wait, with the Space named for a later ask', async () => {
 let started = 0;
 const forever = () => { started++; return new Promise(() => {}); };
 const began = Date.now();
 await assert.rejects(readSpaceForList('never|a', forever), error => spaceMountingIn(error)?.retry_after_ms === wait.retry_after_ms);
 const took = Date.now() - began;
 assert.ok(took < wait.wait_ms + 500, `the list waited ${took} ms`);
 await assert.rejects(readSpaceForList('never|a', forever, { until: Date.now() }), error => Boolean(spaceMountingIn(error)));
 assert.equal(started, 1, 'a second list does not start a second read of the same Space while the first goes on');
});

test('a read that finishes late in the background is taken by the next list, and a failed one fails that list once', async () => {
 let finish;
 const slow = () => new Promise(done => { finish = done; });
 await assert.rejects(readSpaceForList('late|b', slow, { until: Date.now() }), error => Boolean(spaceMountingIn(error)));
 finish({ space_id: 'b' });
 await new Promise(done => setImmediate(done));
 assert.deepEqual(await readSpaceForList('late|b', slow, { until: Date.now() }), { space_id: 'b' });
 assert.deepEqual(await readSpaceForList('late|b', () => Promise.resolve({ again: true }), { until: Date.now() + 50 }), { again: true }, 'a finished read is taken once; the next list reads afresh');
 const failing = () => Promise.reject(new Error('Resource quota: credit_exhausted'));
 await assert.rejects(readSpaceForList('fail|c', failing), /credit_exhausted/);
});

test('a list shares one wait among its Spaces: Spaces after the first slow one do not each wait again', async () => {
 const until = Date.now() + 200;
 const began = Date.now();
 const outcomes = [];
 for (const name of ['x', 'y', 'z']) outcomes.push(await readSpaceForList(`share|${name}`, () => new Promise(() => {}), { until }).then(() => 'read', error => spaceMountingIn(error) ? 'busy' : 'failed'));
 assert.deepEqual(outcomes, ['busy', 'busy', 'busy']);
 assert.ok(Date.now() - began < 600, 'three never-ending Spaces cost one wait, not three');
});

test('a read kept 20 s is not shown once access to the Space has been withdrawn, and is shown while it still stands', async t => {
 let now = 1_000_000;
 t.mock.method(Date, 'now', () => now);
 let finish;
 const slow = () => new Promise(done => { finish = done; });
 await assert.rejects(readSpaceForList('keep|w', slow, { until: now }), error => Boolean(spaceMountingIn(error)));
 finish({ card: 'kept' });
 await new Promise(done => setImmediate(done));
 now += 20_000;
 assert.deepEqual(await readSpaceForList('keep|w', slow, { until: now, stillAllowed: () => true }), { card: 'kept' }, 'access stands: the card read in the background is shown');
 await assert.rejects(readSpaceForList('keep|v', slow, { until: now }), error => Boolean(spaceMountingIn(error)));
 finish({ card: 'kept for someone withdrawn' });
 await new Promise(done => setImmediate(done));
 now += 20_000;
 const refused = Object.assign(new Error('Current rights do not admit this Space.'), { status: 403 });
 await assert.rejects(readSpaceForList('keep|v', () => Promise.reject(refused), { until: now + 50, stillAllowed: async () => false }), error => error.status === 403, 'access withdrawn: the kept card is dropped and the read is made afresh and refused');
});
