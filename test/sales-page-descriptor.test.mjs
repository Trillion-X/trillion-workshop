import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runRow } from '../test-helpers/run-a-row.mjs';

const descriptor = JSON.parse(readFileSync(new URL('../tools/write-a-sales-page/records.json', import.meta.url), 'utf8'))
  .things.find(row => row.payload.id === 'tool:write-a-sales-page').payload;

test('the packed sales-page descriptor renders synthetic landing data', async () => {
  const input = {
    title: 'Synthetic page',
    description: 'Synthetic fixture',
    sections: [
      { emphasis: 'hero', heading: 'A sample promise', body: 'A plain body.', actions: [{ label: 'See details', href: 'https://example.invalid/details' }] },
      { emphasis: 'proof', heading: 'Proof', items: [{ heading: 'Person A', body: 'Exact approved quote.' }] },
      { emphasis: 'offer', heading: 'Plans', cards: [{ heading: 'Basic', body: 'Current price supplied by its owner.', href: 'https://example.invalid/checkout' }] },
    ],
  };
  const result = await runRow(descriptor, input);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.last?.result?.title, input.title);
  assert.ok(result.last?.result?.bytes > 0);
  assert.match(result.last?.result?.identity ?? '', /^1f:[a-f0-9]{64}$/);
  assert.match(result.last?.result?.words ?? '', /A sample promise/);
  assert.match(result.last?.result?.words ?? '', /Exact approved quote\./);
  assert.match(result.last?.result?.words ?? '', /Basic/);
});
