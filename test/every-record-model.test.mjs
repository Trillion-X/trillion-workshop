// The record model the tools' descriptors declare, joined the way Trillion joins it (trillion-rust
// src/record_model_policy/installed.rs): each row's record_model, a listed section one tool after another and an object
// section by its keys. No two tools declare one kind, one index or one object key, and every kind and index names a
// type. Nothing here names a tool; the one kind list below is what the engine's own part keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rows as readRows } from '../test-helpers/tool-rows.mjs';

const parts = readRows().filter(({ payload }) => payload.record_model !== undefined);

// The kinds the engine writes itself (trillion-rust src/record_model_policy/settings.json engine_part): no tool declares them.
const ENGINE_KINDS = ['setting', 'execution', 'resource-command-result', 'table-schema-change'];

test('a record model is an object of lists and objects, and its notes are only notes', () => {
  for (const { payload } of parts) {
    assert.equal(typeof payload.record_model, 'object', `${payload.id}: record_model is an object`);
    for (const [section, value] of Object.entries(payload.record_model)) {
      if (section.startsWith('_')) continue;
      assert.ok(value !== null && typeof value === 'object', `${payload.id}: ${section} is a list or an object`);
    }
  }
});

test('no two tools declare one kind, one index or one object key, nor a kind the engine keeps', () => {
  const kinds = new Map();
  const indexes = new Map();
  const keys = new Map();
  for (const { payload } of parts) {
    for (const [section, value] of Object.entries(payload.record_model)) {
      if (section.startsWith('_') || Array.isArray(value)) continue;
      for (const key of Object.keys(value)) {
        assert.ok(!keys.has(`${section}/${key}`), `${section}.${key} is in ${keys.get(`${section}/${key}`)} and ${payload.id}`);
        keys.set(`${section}/${key}`, payload.id);
      }
    }
    for (const kind of payload.record_model.kinds ?? []) {
      assert.ok(typeof kind.type === 'string' && kind.type, `${payload.id}: every kind names its type`);
      assert.ok(!ENGINE_KINDS.includes(kind.type), `${payload.id}: ${kind.type} is a kind the engine keeps`);
      assert.ok(!kinds.has(kind.type), `${kind.type} is in ${kinds.get(kind.type)} and ${payload.id}`);
      kinds.set(kind.type, payload.id);
    }
    for (const index of payload.record_model.indexes ?? []) {
      const name = `${index.type}/${index.name}`;
      assert.ok(index.type && index.name, `${payload.id}: every index names its type and name`);
      assert.ok(!indexes.has(name), `${name} is in ${indexes.get(name)} and ${payload.id}`);
      indexes.set(name, payload.id);
    }
  }
});

test('the saved logins and the WhatsApp pairing offer still stay on this computer', () => {
  // Moved from trillion-rust src/account_rights/run_capability.rs
  // the_saved_login_copy_kinds_and_the_whatsapp_pairing_offer_stay_on_this_computer: the model the tools declare
  // keeps them here, and the list prefix they are named by is the list rule's.
  const kinds = new Map(parts.flatMap(({ payload }) => (payload.record_model.kinds ?? []).map(kind => [kind.type, kind])));
  const rules = parts.flatMap(({ payload }) => payload.record_model.declared_by ?? []);
  assert.equal(rules.length, 1, 'one tool declares the list rule');
  const prefix = rules[0].kind.prefix;
  for (const rowType of ['saved-login', 'saved-login-grant', 'saved-login-shown']) {
    assert.equal(kinds.get(`${prefix}${rowType}`)?.stays_on_this_device, true, rowType);
  }
  assert.equal(kinds.get('whatsapp-pairing-offer')?.stays_on_this_device, true);
  assert.notEqual(kinds.get(`${prefix}saved-logins-list`)?.stays_on_this_device, true);
});
