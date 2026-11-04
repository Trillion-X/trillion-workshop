import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAdmittedTool, boundToolId, boundToolParts, connectionBinding, requireCurrentConnection, selectSourceConnection } from '../src/source-connection.mjs';

const base = 'service_connection:mail', selected = `${base}:work`;
const binding = { connection_id: selected, connected_at: '2026-10-08T09:00:00.000Z' };
const row = { ...binding, vendor: 'mail', status: 'connected', can_send: true };
const held = (connection, field) => `service-connection-${Buffer.from(connection).toString('hex')}-field-${Buffer.from(field).toString('hex')}`;
const placement = { kind: 'header', name: 'Authorization', prefix: 'Bearer ' };
const tool = { id: 'tool:mail-read', invoke: { kind: 'http-request', connection_id: base, method: 'GET', url: 'https://mail.example/me',
  host_is_connection_field: 'site_url', credential_injections: [{ field_id: 'access_token', placement }] }, placements: ['placement:web'] };

test('bound identity is deterministic and keeps the admitted version plus exact source incarnation', () => {
  const source = { ...binding, source_id: 'events:mail', control_revision: 7, account: 'provider-person' };
  const id = boundToolId(tool.id, 'version-one', source);
  assert.deepEqual(boundToolParts(id), { tool_id: tool.id, version: 'version-one', binding: source });
  assert.equal(id, boundToolId(tool.id, 'version-one', { ...source, ignored: 'not admitted' }));
  assert.notEqual(id, boundToolId(tool.id, 'version-two', source));
  assert.notEqual(id, boundToolId(tool.id, 'version-one', { ...source, control_revision: 8 }));
  assert.throws(() => boundToolParts('tool:bound-connection:not-json'), /malformed/);
  assert.throws(() => connectionBinding({ ...source, control_revision: -1 }), /revision/);
});

test('binding changes only exact declared connection fields, preserving destinations, placements and other text', () => {
  const original = { ...tool, description: held(base, 'access_token'), invoke: { ...tool.invoke,
    headers: { 'X-Literal': held(base, 'access_token') }, credential_injections: [
      { field_id: 'access_token', placement }, { secret_name: held(base, 'second_field'), placement: { kind: 'header', name: 'X-Other' } },
    ] } };
  const before = structuredClone(original);
  const bound = bindAdmittedTool(original, 'bound-id', binding);
  assert.deepEqual(original, before, 'the shared descriptor is never edited');
  assert.equal(bound.invoke.connection_id, selected);
  assert.deepEqual(bound.invoke.credential_injections.map(item => item.field_id), ['access_token', 'second_field']);
  for (const field of ['url', 'method', 'host_is_connection_field', 'headers']) assert.deepEqual(bound.invoke[field], original.invoke[field]);
  assert.deepEqual(bound.placements, original.placements);
  assert.equal(bound.description, original.description);
  for (const secret_name of [held(`${base}:another`, 'access_token'), held('service_connection:other', 'access_token'), 'arbitrary-vault-secret']) {
    assert.throws(() => bindAdmittedTool({ ...tool, invoke: { ...tool.invoke, credential_injections: [{ secret_name, placement }] } }, 'bound', binding), /cannot be rebound/);
  }
  assert.throws(() => bindAdmittedTool({ ...tool, invoke: { ...tool.invoke, connection_id: `${base}:other` } }, 'bound', binding), /different explicit account/);
  assert.throws(() => bindAdmittedTool(tool, 'bound', { ...binding, connection_id: 'service_connection:other:work' }), /vendor/);
});

test('connection selection never substitutes a missing saved account and refuses unknown or denied incarnations', () => {
  const source = { connects_with: { vendor: 'mail' } };
  assert.deepEqual(selectSourceConnection(source, null, [{ ...row, connection_id: base, status: 'disconnected' }, row]), binding);
  assert.throws(() => selectSourceConnection(source, { connection_binding: { ...binding, connection_id: `${base}:missing` } }, [row]), /not replaced/);
  assert.throws(() => selectSourceConnection(source, null, [row, { ...row, connection_id: `${base}:two` }]), /Several/);
  for (const changed of [{ ...row, status: 'disconnected' }, { ...row, can_send: false }, { ...row, connected_at: '2026-10-08T09:01:00Z' }, { ...row, vendor: 'other' }]) {
    assert.throws(() => requireCurrentConnection(binding, [changed]), /disconnected or changed/);
  }
});
