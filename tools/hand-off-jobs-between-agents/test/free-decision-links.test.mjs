import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withItemLinks, missingLinks } from '../src/item-links.mjs';

const origin = 'https://app.gettrillion.ai';

test('a transient Free decision does not advertise a saved decision page', () => {
  const reply = { case_id: 'run_sealed-customer-state', question: { step_id: 'focused-choice' },
    next_call: { tool: 'next_question', arguments: { case_id: 'run_sealed-customer-state' } } };
  const linked = withItemLinks(reply, origin);
  assert.equal(linked.open_url, undefined);
  assert.deepEqual(linked.next_call, reply.next_call);
  assert.deepEqual(missingLinks(linked), []);
});

test('saved decisions and sibling saved records still carry their exact links', () => {
  const reply = withItemLinks({ decisions: [{ case_id: 'source:proof' }],
    files: [{ identity: '1f:' + 'a'.repeat(64) }] }, origin);
  assert.equal(reply.decisions[0].open_url, origin + '/decisions/source%3Aproof');
  assert.equal(reply.files[0].open_url, origin + '/file/1f%3A' + 'a'.repeat(64));
  assert.deepEqual(missingLinks(reply), []);
});
