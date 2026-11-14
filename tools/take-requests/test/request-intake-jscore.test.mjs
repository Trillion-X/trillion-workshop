import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readRequestIntakeSurface } from '../read-data/request-intake-projection.ts';
import { requestRequestIntakeChange } from '../do-work/request-intake-actions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const source = readFileSync(join(packageRoot, 'show-ios-jscore/mount-request-intake-jscore.js'), 'utf8');

function loadRuntime() {
  const logs = [];
  const sandbox = {
    console: {
      info(...args) {
        logs.push(args);
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, logs };
}

function fakeBridge(inputs = {}) {
  let snapshot = null;
  const calls = [];
  return {
    snapshot: () => snapshot,
    calls: () => calls,
    invoke(operation, payloadText) {
      const payload = payloadText ? JSON.parse(payloadText) : null;
      calls.push({ operation, payload });
      if (operation === 'package.input.read') {
        return JSON.stringify({ found: Object.hasOwn(inputs, payload.input_name), value: inputs[payload.input_name] });
      }
      if (operation === 'native.view.snapshot.replace') snapshot = payload;
      return JSON.stringify({ ok: true, operation, payload });
    },
  };
}

function allNodes(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children || []) allNodes(child, out);
  return out;
}

function allText(node) {
  return allNodes(node)
    .filter((entry) => entry.kind === 'text' && typeof entry.props?.text === 'string')
    .map((entry) => entry.props.text);
}

function fixtureSurface(status = undefined) {
  return readRequestIntakeSurface({
    status,
    shapes: [{
      id: 'shape:anything',
      label: 'Any configurable shape',
      version_ref: 'version:anything:1',
      fields: [
        { id: 'field:first', label: 'First value', order: 1, value_kind: 'text', required: true },
        { id: 'field:second', label: 'Second value', order: 2, value_kind: 'any-value' },
      ],
    }],
    views: [
      { id: 'view:any', label: 'Any view', order: 1 },
      { id: 'view:later', label: 'Later view', order: 2 },
    ],
    states: [{ id: 'state:any', label: 'Renamed by data', order: 1 }],
    actions: [{
      id: 'action:any-owner',
      label: 'Ask an owner to do work',
      order: 1,
      target: 'owner:any-target',
      definitionIds: ['definition:any'],
      copy: [{ key: 'copied_value', from: 'fields.field:first' }],
    }],
    sharePolicies: [{ id: 'share:any', label: 'Any share policy', order: 1 }],
    receipts: [{
      ref: 'receipt:any-owner:1',
      owner_ref: 'owner:anything',
      title: 'Owner accepted the handoff',
      summary: 'The returned proof is linked.',
      process_session_ref: 'process_session:anything',
    }],
    selectedRecordId: 'record:1',
    instances: [{
      id: 'record:1',
      shape_id: 'shape:anything',
      title: 'One submitted record',
      source_label: 'Configured source',
      received_at: '2026-06-21T10:00:00.000Z',
      values: {
        'field:first': 'Alpha',
        'field:second': { opaque: true },
      },
      linked_receipt_refs: ['receipt:any-owner:1'],
      action_descriptor_ids: ['action:any-owner'],
    }],
  });
}

test('renders a sealed one-task-per-screen native snapshot from the shared projection model', () => {
  const { sandbox, logs } = loadRuntime();
  const bridge = fakeBridge();
  sandbox.bitfieldMount({
    lifecycle_key: 'component:request-intake:jscore',
    surface: fixtureSurface(),
  }, bridge);

  const snapshot = bridge.snapshot();
  const texts = allText(snapshot.root);
  assert.equal(snapshot.schema, 'bitfield.native.view.snapshot');
  assert.equal(snapshot.package, 'request-intake');
  assert.equal(snapshot.coverage.status, 'sparse');
  assert.deepEqual(snapshot.navigation.screens.map((entry) => entry.id), [
    'root',
    'builder',
    'question-settings',
    'preview',
    'share',
    'submission-detail',
    'follow-up',
  ]);
  assert.ok(texts.includes('Ready to review'));
  assert.ok(texts.includes('Any configurable shape'));
  assert.ok(texts.includes('First value'));
  assert.ok(texts.includes('Any share policy'));
  assert.ok(texts.includes('One submitted record'));
  assert.ok(texts.includes('Owner accepted the handoff'));
  assert.ok(texts.includes('Ask an owner to do work'));
  assert.equal(logs[0][0], '[request-intake] jscore surface mounted');
  assert.equal(logs[0][1].status, 'sparse');
  assert.equal(logs[0][1].screens, 7);
});

test('renders the closed render-state matrix without adding domain branches', () => {
  const { sandbox } = loadRuntime();
  const states = ['empty', 'sparse', 'dense', 'loading', 'error', 'offline', 'conflict'];

  for (const status of states) {
    const snapshot = sandbox.RequestIntakeJscore.renderSnapshot(fixtureSurface(status), 'component:request-intake:jscore');
    const texts = allText(snapshot.root);
    assert.equal(snapshot.coverage.status, status);
    assert.ok(texts.length > 0);
    assert.equal(snapshot.navigation.mode, 'one-task-per-screen');
  }
});

test('sends actions through the package target and preserves do-work owner-action output', () => {
  const { sandbox, logs } = loadRuntime();
  const surface = fixtureSurface();
  const bridge = fakeBridge();
  sandbox.bitfieldMount({ surface }, bridge);

  const press = allNodes(bridge.snapshot().root)
    .map((entry) => entry.props?.press)
    .find((entry) => entry?.operation === 'runtime.target.invoke');

  assert.equal(press.payload.target, 'package::request-intake::target::request-intake-change');
  assert.equal(press.payload.payload.descriptorId, 'action:any-owner');
  assert.equal(press.payload.payload.recordRef, 'record:1');
  assert.equal(press.payload.payload.fieldValues['field:first'], 'Alpha');

  const result = requestRequestIntakeChange(press.payload.payload);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.targetRequests[0], {
    target: 'owner:any-target',
    payload: {
      operation: 'execute_definition',
      definition_id: 'definition:any',
      include_steps: false,
      include_output: false,
      input: {
        copied_value: 'Alpha',
        action_id: 'action:any-owner',
        record_ref: 'record:1',
        shape_ref: 'shape:anything',
        field_values: {
          'field:first': 'Alpha',
          'field:second': { opaque: true },
        },
        linked_receipt_refs: ['receipt:any-owner:1'],
        receipt_ref: null,
        'field:first': 'Alpha',
        'field:second': { opaque: true },
      },
    },
  });

  bridge.calls().length = 0;
  sandbox.bitfieldOnAction(JSON.stringify(press));
  assert.equal(bridge.calls()[0].operation, 'runtime.target.invoke');
  assert.equal(logs.at(-1)[0], '[request-intake] jscore requested owner action');
});

test('can read the same screen model through the sealed package input bridge', () => {
  const { sandbox } = loadRuntime();
  const bridge = fakeBridge({ 'screen-model': fixtureSurface('offline') });
  sandbox.bitfieldMount({ lifecycle_key: 'component:request-intake:jscore' }, bridge);
  assert.equal(bridge.snapshot().coverage.status, 'offline');
  assert.ok(bridge.calls().some((entry) => entry.operation === 'package.input.read' && entry.payload.input_name === 'screen-model'));
});

test('declares the JSCore boundary and avoids React/browser or destination-specific branches', () => {
  assert.ok(source.includes('RequestIntakeJscore'));
  assert.ok(source.includes('package::request-intake::target::request-intake-change'));
  assert.ok(source.includes('native.view.snapshot.replace'));
  assert.doesNotMatch(source, /from ['"]react['"]|react-dom|document\.|window\./);
  assert.doesNotMatch(source, /\b(crm|support|calendar|email|provider|campaign|event)\b/i);
  assert.doesNotMatch(source, /target\s*===\s*['"][^'"]+['"]/);
});
