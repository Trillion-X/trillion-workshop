// tools/start-a-computer/test/target.test.mjs
//
// The release target a computer reports for itself: measured from its own machine, and refused when the feed has no release for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredTarget, refuseWithoutTarget } from '../do-work/start-a-computer.mjs';

const feedWith = releases => async () => ({ json: async () => ({ releases: releases.map(target => ({ target })) }) });

test('a computer reports the target its own kernel and machine give, in the feed\'s triple', async () => {
  assert.equal(await measuredTarget({}, async () => 'Linux aarch64\n'), 'aarch64-unknown-linux-gnu');
  assert.equal(await measuredTarget({}, async () => 'Linux x86_64\n'), 'x86_64-unknown-linux-gnu');
  assert.equal(await measuredTarget({}, async () => 'Darwin arm64\n'), 'aarch64-apple-darwin');
  await assert.rejects(measuredTarget({}, async () => 'FreeBSD amd64\n'), /reports FreeBSD amd64, which the feed builds no release for/);
});

test('a reported target the feed has a release for proceeds; a fake target the feed lacks is refused with the reason named', async () => {
  const fetchImpl = feedWith(['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']);
  assert.equal(await refuseWithoutTarget('https://feed.example/feed.json', 'aarch64-unknown-linux-gnu', fetchImpl), 'aarch64-unknown-linux-gnu');
  await assert.rejects(refuseWithoutTarget('https://feed.example/feed.json', 'riscv64-unknown-linux-gnu', fetchImpl), /The feed has no release for riscv64-unknown-linux-gnu, the target this computer reports, so the update is refused/);
});
