import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crossOfferSessionCatalogEntry,
  currentSessionCatalogEntries,
  publishSessionCatalogEntry,
  readSessionCatalog,
  retractSessionCatalogEntry,
  supersedeSessionCatalogEntry,
  updateSessionCatalogEntry,
} from '../read-data/session-catalog.ts';

const entry = (id, groups, sessions, rule) => publishSessionCatalogEntry({
  catalog_entry_id: id,
  owning_group_refs: groups,
  session_refs: sessions,
  catalog_visibility_predicate: { policy_ref: rule },
  recommendation_policy_ref: `recommend:${id}`,
  cross_offer_policy: [],
  presentation_surface_refs: ['surface:desktop', 'surface:mobile', 'surface:desktop'],
});
const ids = list => list.map(item => item.catalog_entry_id);

test('only current entries are read; co-owned and multi-session offers keep their groups and sessions', () => {
  const local = entry('catalog:local', ['group:one'], ['session:one', 'session:two'], 'rule:members');
  const crossed = crossOfferSessionCatalogEntry(entry('catalog:cross', ['group:one', 'group:two'], ['session:three'], 'rule:everyone'), { target_catalog_entry_ref: 'catalog:local', relation_descriptor_ref: 'relation:related' });
  const successor = entry('catalog:local:next', ['group:one'], ['session:one', 'session:two'], 'rule:members');
  const superseded = supersedeSessionCatalogEntry(local, successor);
  const retracted = retractSessionCatalogEntry(entry('catalog:retracted', ['group:two'], ['session:three'], 'rule:members'), '2026-08-30T20:00:00Z', 'reason:withdrawn');
  const entries = [superseded.predecessor, superseded.successor, crossed, retracted];
  assert.deepEqual(ids(readSessionCatalog(entries)), ['catalog:local:next', 'catalog:cross']);
  assert.equal(readSessionCatalog(entries, { session_refs: ['session:two', 'session:three'] }).length, 2);
  assert.deepEqual(ids(readSessionCatalog(entries, { catalog_entry_refs: ['catalog:cross'] })), ['catalog:cross']);
  assert.deepEqual(crossed.owning_group_refs, ['group:one', 'group:two']);
  assert.deepEqual(crossed.cross_offer_policy.map(item => item.target_catalog_entry_ref), ['catalog:local']);
  assert.deepEqual(currentSessionCatalogEntries(entries).map(item => item.catalog_entry_id), ['catalog:local:next', 'catalog:cross']);
});

test('update keeps the id, a repeated cross offer to one target replaces it, and surfaces are listed once', () => {
  const first = entry('catalog:one', ['group:one'], ['session:one'], 'rule:members');
  assert.deepEqual(first.presentation_surface_refs, ['surface:desktop', 'surface:mobile']);
  const updated = updateSessionCatalogEntry(first, { presentation_surface_refs: ['surface:agent'], catalog_entry_id: 'catalog:other' });
  assert.equal(updated.catalog_entry_id, 'catalog:one');
  assert.deepEqual(updated.presentation_surface_refs, ['surface:agent']);
  const once = crossOfferSessionCatalogEntry(updated, { target_catalog_entry_ref: 'catalog:two', relation_descriptor_ref: 'relation:a' });
  const twice = crossOfferSessionCatalogEntry(once, { target_catalog_entry_ref: 'catalog:two', relation_descriptor_ref: 'relation:b' });
  assert.deepEqual(twice.cross_offer_policy.map(item => item.relation_descriptor_ref), ['relation:b']);
});

test('refusals name the field', () => {
  assert.throws(() => entry('', ['group:one'], ['session:one'], 'rule'), /catalog_entry_id/);
  assert.throws(() => entry('catalog:x', [], ['session:one'], 'rule'), /owning_group_refs/);
  assert.throws(() => entry('catalog:x', ['group:one'], [], 'rule'), /session_refs/);
  assert.throws(() => entry('catalog:x', ['group:one'], ['session:one'], ' '), /policy_ref/);
  const same = entry('catalog:x', ['group:one'], ['session:one'], 'rule');
  assert.throws(() => supersedeSessionCatalogEntry(same, same), /distinct catalog_entry_id/);
  assert.throws(() => retractSessionCatalogEntry(same, '', 'reason'), /retracted_at/);
  assert.throws(() => crossOfferSessionCatalogEntry(same, { target_catalog_entry_ref: '', relation_descriptor_ref: 'r' }), /target_catalog_entry_ref/);
});
