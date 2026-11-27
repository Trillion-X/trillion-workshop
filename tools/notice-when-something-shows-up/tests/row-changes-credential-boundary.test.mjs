// The row-change leaf uses the same mounted-credential boundary as the other mechanisms. Synthetic descriptors only;
// every injected connection fails before a client opens, so a regression cannot contact a database or leave a waiter running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchForTransitions } from '../do-work/mechanisms/row-changes.mjs';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';

const INVALID_FD = 2 ** 31 - 1;
const STOP = 'synthetic connection stopped before opening';

function descriptorHolding(text) {
  const folder = tempFolder(join(tmpdir(), 'row-change-credential-'));
  const file = join(folder, 'held');
  writeFileSync(file, `${text}\n`);
  return openSync(file, 'r');
}

test('a row waiter with no mounted credential refuses before reading a descriptor or connecting', { timeout: 2000 }, async () => {
  let connected = false;
  await assert.rejects(watchForTransitions({ connection_fd: INVALID_FD }, {
    credentialMounted: false,
    connect: async () => { connected = true; throw new Error(STOP); },
  }), error => error.noCredential === true && error.reason === 'no-credential');
  assert.equal(connected, false);
});

test('two row waiters sharing the run credential both receive the one descriptor read', { timeout: 2000 }, async () => {
  const credential = 'postgresql://synthetic.invalid/row_change_fixture';
  const fd = descriptorHolding(credential);
  const connections = [];
  try {
    const handlers = {
      credentialMounted: true,
      connect: async value => { connections.push(value); throw new Error(STOP); },
    };
    await assert.rejects(watchForTransitions({ connection_fd: fd }, handlers), new RegExp(STOP));
    await assert.rejects(watchForTransitions({ connection_fd: fd }, handlers), new RegExp(STOP));
    assert.deepEqual(connections, [credential, credential]);
  } finally { closeSync(fd); }
});

test('a row waiter reads its own mounted descriptor instead of the run descriptor', { timeout: 2000 }, async () => {
  const credential = 'postgresql://synthetic.invalid/own_row_change_fixture';
  const fd = descriptorHolding(credential);
  const connections = [];
  try {
    await assert.rejects(watchForTransitions({ connection_fd: INVALID_FD }, {
      credentialFd: fd,
      credentialMounted: true,
      connect: async value => { connections.push(value); throw new Error(STOP); },
    }), new RegExp(STOP));
    assert.deepEqual(connections, [credential]);
  } finally { closeSync(fd); }
});

test('every packed row-change leaf includes its canonical credential helper', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
  const leaf = 'do-work/mechanisms/row-changes.mjs';
  const helper = 'do-work/mechanisms/given-credential.mjs';
  const covers = (packs, path) => packs.some(pack => pack.paths?.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
  let packed = 0;
  for (const { payload } of rows.records) {
    const packs = (payload.invoke?.files?.package_files ?? []).filter(pack => pack.package === 'notice-when-something-shows-up');
    if (!covers(packs, leaf)) continue;
    packed += 1;
    assert.ok(covers(packs, helper), `${payload.id} packs the leaf without its credential helper`);
  }
  assert.ok(packed > 0, 'the package declares a tool that packs the row-change leaf');
});
