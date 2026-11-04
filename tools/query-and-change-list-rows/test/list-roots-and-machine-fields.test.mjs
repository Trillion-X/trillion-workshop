// The registrable root of a web address as a shared form (src/list-identity.mjs `domain_root`, DATA src/lists.json
// domain_suffixes) and a field a machine always keeps (`machine: true`, src/list-stamps.mjs), through the real record store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { normalizedForm } from '../src/list-identity.mjs';

const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  return makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
};

test('domain_root reduces a host to its registrable part, under a two-label suffix too', () => {
  const form = value => normalizedForm(value, 'domain_root');
  assert.equal(form('https://shop.Acme.com/about?x=1'), 'acme.com');
  assert.equal(form('www.acme.co.uk'), 'acme.co.uk');
  assert.equal(form('mail.shop.acme.co.uk:8080/x'), 'acme.co.uk');
  assert.equal(form('user-edf45184@example.com'), 'acme.io');
  assert.equal(form('localhost'), 'localhost');
  assert.equal(form('10.0.0.1'), '10.0.0.1');
  assert.equal(form('acme.com.'), 'acme.com');
});

test('a unique field with domain_root refuses a second company on a subdomain of the same domain', async t => {
  const lists = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }, { id: 'site', label: 'Site', kind: 'link-address', normalize: 'domain_root', unique: true }] });
  await lists.putRows('companies', { rows: [{ id: 'a', values: { name: 'Acme', site: 'https://www.acme.co.uk' } }] });
  await assert.rejects(async () => await lists.putRows('companies', { rows: [{ id: 'b', values: { name: 'Acme shop', site: 'shop.acme.co.uk/buy' } }] }), error => error instanceof ListsError && error.detail?.code === 'not_unique');
  await lists.putRows('companies', { rows: [{ id: 'c', values: { name: 'Other', site: 'other.co.uk' } }] });
  assert.equal((await lists.read('companies')).rows.length, 2);
});

test('a machine field reads as machine-written whoever wrote it, on a list that keeps stamps', async t => {
  const lists = fresh(t);
  await lists.save({ id: 'people', label: 'People', stamps: true, fields: [{ id: 'name', label: 'Name' }, { id: 'title', label: 'Job title', machine: true }] });
  await lists.putRows('people', { rows: [{ id: 'p', values: { name: 'Ana', title: 'CEO' } }] }, { actor: { by: 'you, in trillion' } });
  const row = (await lists.read('people')).rows[0];
  assert.deepEqual(row.machine_written, ['title']);
  assert.equal((await lists.find('people')).fields.find(field => field.id === 'title').machine, true);
  await assert.rejects(async () => await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name', machine: 'yes' }] }), ListsError);
});
