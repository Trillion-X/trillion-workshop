import test from 'node:test';
import assert from 'node:assert/strict';
import { checkManageRequest } from '../read-data/ai-tool-manage-sales-contracts.mjs';

test('a request with an operation from the list and known fields is ready', () => {
  assert.deepEqual(checkManageRequest({ operation: 'list' }), { ok: true, problems: [] });
  assert.deepEqual(checkManageRequest({
    operation: 'send', contract_id: 'sales-contract:a', to: 'ana@example.test', note: 'Here it is', expires_at: '2026-12-01T00:00:00Z',
  }), { ok: true, problems: [] });
});

test('an operation outside the list is refused, and the list is named', () => {
  const answer = checkManageRequest({ operation: 'delete' });
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.problems, ['operation must be one of list, read, save, send, resources.']);
});

test('a field the tool does not name is refused', () => {
  assert.deepEqual(checkManageRequest({ operation: 'read', price: 5 }).problems, ['price is not a field of this tool.']);
});

test('each typed field is checked against its schema type', () => {
  assert.deepEqual(checkManageRequest({ operation: 'send', to: 'not-an-email' }).problems, ['to must be an email address.']);
  assert.deepEqual(checkManageRequest({ operation: 'save', contract: 'x' }).problems, ['contract must be an object.']);
  assert.deepEqual(checkManageRequest({ operation: 'read', contract_id: 7 }).problems, ['contract_id must be text.']);
  assert.deepEqual(checkManageRequest({ operation: 'save', name: 7 }).problems, ['name must be text.']);
  assert.deepEqual(checkManageRequest({ operation: 'send', scope: [] }).problems, ['scope must be an object.']);
  assert.deepEqual(checkManageRequest({ operation: 'send', expires_at: 'soon' }).problems, ['expires_at must be a date and time.']);
});

test('a note over 2000 characters is refused with its limit', () => {
  assert.deepEqual(checkManageRequest({ operation: 'send', note: 'x'.repeat(2001) }).problems, ['note must be text of at most 2000 characters.']);
  assert.equal(checkManageRequest({ operation: 'send', note: 'x'.repeat(2000) }).ok, true);
});

test('a request that is not an object is refused', () => {
  assert.deepEqual(checkManageRequest(null), { ok: false, problems: ['Give the request as an object.'] });
  assert.deepEqual(checkManageRequest(['list']), { ok: false, problems: ['Give the request as an object.'] });
});
