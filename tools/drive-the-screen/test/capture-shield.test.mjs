const toolsFolder = import.meta.dirname.split('/test')[0].replace(/[^/]+$/, '');
const runtime = { moduleURL: specifier => `file://${toolsFolder}${specifier.slice('tools/'.length)}` };
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const runtimeImport1 = await import(runtime.moduleURL("tools/drive-the-screen/read-data/capture-shield.mjs"));
const { shieldNames, withShield } = runtimeImport1;

test('the capture is bracketed by the begin and end notifications, and the end is posted when the capture fails', async () => {
  const names = shieldNames();
  const seen = [];
  const send = async name => { seen.push(name); };
  assert.equal(await withShield(async () => { seen.push('capture'); return 'pixels'; }, { names, send }), 'pixels');
  await assert.rejects(withShield(async () => { throw new Error('screen program failed'); }, { names, send }), /screen program failed/);
  assert.deepEqual(seen, [names.begin, 'capture', names.end, names.begin, names.end]);
  console.log('REAL names:', JSON.stringify(names));
});
