import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import boundary from '../things-to-store-and-run.json';
import {
  readNotificationsPolicy,
  type PublishedRecordRow,
  type SettingActionRouteView,
} from '../read-data/read-notifications-policy';
import {
  projectSettingView,
  type WritePhase,
} from '../read-data/project-setting-view';
import { buildActionPayload } from '../do-work/save-setting';

type JsonRecord = Record<string, unknown>;

const JSCORE_DIR = join(process.cwd(), 'packages/notifications/show-ios-jscore');
const SOURCE = readFileSync(join(JSCORE_DIR, 'mount-notifications-jscore.js'), 'utf8');

interface JscoreApi {
  sharedContractSourcePaths: string[];
  readPolicy: (input: unknown) => unknown;
  projectView: (input: unknown) => unknown;
  buildActionPayload: (route: unknown, optionId: string) => unknown;
  interpretReply: (reply: unknown) => { ok: boolean };
  buildSnapshot: (view: unknown, key: string) => JsonRecord;
}

interface Sandbox {
  console: Console;
  globalThis: Sandbox;
  bitfieldMount: (record: JsonRecord, mount: unknown) => { dispose: () => void };
  putThingOnScreen: (record: JsonRecord, mount: unknown) => { dispose: () => void };
  bitfieldOnAction: (payloadText: string) => void;
  NotificationsJscore: JscoreApi;
}

function loadMount(): Sandbox {
  const sandbox = { console } as unknown as Sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox;
}

function boundaryRecords(): PublishedRecordRow[] {
  const things = (boundary as { things?: Array<{ address?: string; payload?: unknown }> }).things ?? [];
  return things.map((thing) => ({
    address: typeof thing.address === 'string' ? thing.address : '',
    payload: thing.payload,
  }));
}

function descriptor(): JsonRecord {
  const row = boundaryRecords().find(
    (entry) => !!entry.payload
      && typeof entry.payload === 'object'
      && (entry.payload as JsonRecord).kind === 'setting-control',
  );
  if (!row?.payload || typeof row.payload !== 'object') throw new Error('setting descriptor missing');
  return row.payload as JsonRecord;
}

function valueInputName(source: JsonRecord): string {
  const value = (source.value ?? {}) as JsonRecord;
  return String(value.feed_label ?? value.feedLabel ?? '');
}

function valuePropertyId(source: JsonRecord): string {
  const value = (source.value ?? {}) as JsonRecord;
  const ids = Array.isArray(value.property_ids) ? value.property_ids : [];
  return String(ids[0] ?? '');
}

function valueKey(source: JsonRecord): string {
  const value = (source.value ?? {}) as JsonRecord;
  const keys = Array.isArray(value.keys) ? value.keys : [];
  return String(keys[0] ?? 'id');
}

const RECORDS = boundaryRecords();
const DESCRIPTOR = descriptor();
const CURRENT_POLICY = readNotificationsPolicy({ records: RECORDS, currentRecords: [] });
const CURRENT_ID = CURRENT_POLICY.currentOptionId ?? '';
const OTHER_ID = CURRENT_POLICY.options.find((option) => option.id !== CURRENT_ID)?.id ?? CURRENT_ID;

function fakeBridge(
  inputs: Record<string, unknown>,
  invokeReply: unknown = { status: 'ok' },
  onInvoke?: (payload: JsonRecord) => void,
) {
  let snapshot: JsonRecord | null = null;
  const operations: Array<{ operation: string; payload: JsonRecord }> = [];
  return {
    snapshot: () => snapshot,
    operations: () => operations,
    invoke(operation: string, payloadText: string): string {
      const payload = JSON.parse(payloadText) as JsonRecord;
      operations.push({ operation, payload });
      if (operation === 'package.input.read') {
        const name = String(payload.input_name ?? '');
        const value = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : [];
        return JSON.stringify({ found: true, value });
      }
      if (operation === 'native.view.snapshot.replace') {
        snapshot = payload;
        return '';
      }
      if (operation === 'runtime.target.invoke') {
        onInvoke?.(payload);
        return JSON.stringify(invokeReply);
      }
      return '';
    },
  };
}

function allNodes(node: JsonRecord | null, out: JsonRecord[] = []): JsonRecord[] {
  if (!node) return out;
  out.push(node);
  const children = (node.children as JsonRecord[] | undefined) ?? [];
  for (const child of children) allNodes(child, out);
  return out;
}

function allText(node: JsonRecord | null): string[] {
  return allNodes(node)
    .filter((entry) => entry.kind === 'text')
    .map((entry) => String((entry.props as JsonRecord).text ?? ''));
}

function allPresses(node: JsonRecord | null): JsonRecord[] {
  return allNodes(node)
    .map((entry) => (entry.props as JsonRecord).press as JsonRecord | undefined)
    .filter((press): press is JsonRecord => !!press);
}

describe('notifications iOS JSCore shared-contract mirror', () => {
  it('reads the real package records through the same policy projection as TypeScript', () => {
    const sandbox = loadMount();
    expect(sandbox.NotificationsJscore.readPolicy({ records: RECORDS, currentRecords: [] })).toEqual(CURRENT_POLICY);
  });

  it('resolves nested current values through descriptor-declared keys', () => {
    const sandbox = loadMount();
    const rows = [
      {
        property_id: valuePropertyId(DESCRIPTOR),
        value: { [valueKey(DESCRIPTOR)]: OTHER_ID },
      },
    ];
    expect(sandbox.NotificationsJscore.readPolicy({ records: RECORDS, currentRecords: rows })).toEqual(
      readNotificationsPolicy({ records: RECORDS, currentRecords: rows }),
    );
  });

  it('projects every write phase to the same HumanSettingView as TypeScript', () => {
    const sandbox = loadMount();
    const phases: WritePhase[] = ['idle', 'loading', 'saving', 'saved', 'error'];
    const policies = [
      CURRENT_POLICY,
      readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: OTHER_ID }),
      readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: 'not-an-option' }),
    ];

    for (const policy of policies) {
      for (const phase of phases) {
        expect(sandbox.NotificationsJscore.projectView({ policy, phase, offline: false })).toEqual(
          projectSettingView({ policy, phase, offline: false }),
        );
      }
      expect(sandbox.NotificationsJscore.projectView({ policy, phase: 'idle', offline: true })).toEqual(
        projectSettingView({ policy, phase: 'idle', offline: true }),
      );
    }
  });

  it('builds the same descriptor-derived action payload as the TypeScript write authority', () => {
    const sandbox = loadMount();
    const policy = readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: OTHER_ID });
    expect(sandbox.NotificationsJscore.buildActionPayload(policy.actionRoute, OTHER_ID)).toEqual(
      buildActionPayload(policy.actionRoute!, OTHER_ID),
    );
  });

  it('rejects malformed route templates the same way as the TypeScript write authority', () => {
    const sandbox = loadMount();
    const route = {
      id: 'route:any',
      target: 'owner:any',
      valuePath: ['input', 'choice'],
      payloadTemplate: 'not-an-object',
    };

    expect(() => sandbox.NotificationsJscore.buildActionPayload(route, OTHER_ID)).toThrow(
      'Setting write payload template must be an object when a value path is set',
    );
    expect(() => buildActionPayload(route as unknown as SettingActionRouteView, OTHER_ID)).toThrow(
      'Setting write payload template must be an object when a value path is set',
    );
  });

  it('uses the same projection for an adversarial non-package descriptor', () => {
    const sandbox = loadMount();
    const genericDescriptor = {
      kind: 'setting-control',
      title: 'Plain setting',
      description: 'A data-described choice.',
      options: [
        { value: 'alpha', label: 'Alpha', description: 'First', icon: 'Circle' },
        { value: 'beta', label: 'Beta', description: 'Second', icon: 'Square' },
      ],
      value: {
        default: 'alpha',
        property_ids: ['prop:any:active'],
        keys: ['choice'],
      },
      write: {
        target: 'owner:any',
        value_path: ['input', 'choice'],
        payload: { operation: 'do-anything', input: { choice: 'alpha' } },
      },
    };
    const rows = [{ property_id: 'prop:any:active', value: { choice: 'beta' } }];
    expect(sandbox.NotificationsJscore.readPolicy({ descriptor: genericDescriptor, currentRecords: rows })).toEqual(
      readNotificationsPolicy({ descriptor: genericDescriptor, currentRecords: rows }),
    );
  });
});

describe('notifications iOS JSCore bridge output', () => {
  function seed(reply: unknown = { status: 'ok' }, onInvoke?: (inputs: Record<string, unknown>) => void) {
    const sandbox = loadMount();
    const inputName = valueInputName(DESCRIPTOR);
    const inputs: Record<string, unknown> = {
      'published-records': RECORDS,
      'setting-control': DESCRIPTOR,
      [inputName]: [],
    };
    const bridge = fakeBridge(inputs, reply, () => onInvoke?.(inputs));
    const handle = sandbox.bitfieldMount({ lifecycle_key: 'component:test' }, bridge);
    return { sandbox, bridge, handle, inputs, inputName };
  }

  it('renders a sealed native snapshot with one selectable row per option', () => {
    const { bridge } = seed();
    const texts = allText(bridge.snapshot()?.root as JsonRecord | null);
    expect(texts).toContain(CURRENT_POLICY.heading);
    for (const option of CURRENT_POLICY.options) expect(texts).toContain(option.label);
    expect(bridge.operations().some((entry) => entry.operation === 'native.view.snapshot.replace')).toBe(true);
  });

  it('selecting and saving emits the canonical target invoke and reconciles to saved', () => {
    const propId = valuePropertyId(DESCRIPTOR);
    const { sandbox, bridge, inputName } = seed({ status: 'ok' }, (inputs) => {
      inputs[inputName] = [{ property_id: propId, value: OTHER_ID }];
    });

    const selectPress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'select'
        && ((press.payload as JsonRecord).payload as JsonRecord).id === OTHER_ID,
    );
    expect(selectPress).toBeTruthy();
    sandbox.bitfieldOnAction(JSON.stringify(selectPress!.payload));

    const savePress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'save',
    );
    expect(savePress).toBeTruthy();
    bridge.operations().length = 0;
    sandbox.bitfieldOnAction(JSON.stringify(savePress!.payload));

    const policy = readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: OTHER_ID });
    const write = bridge.operations().find((entry) => entry.operation === 'runtime.target.invoke');
    expect(write?.payload).toEqual({
      target: policy.actionRoute!.target,
      payload: buildActionPayload(policy.actionRoute!, OTHER_ID),
    });
    expect(allText(bridge.snapshot()?.root as JsonRecord | null)).toContain(
      projectSettingView({
        policy: readNotificationsPolicy({
          records: RECORDS,
          currentRecords: [{ property_id: propId, value: OTHER_ID }],
        }),
        phase: 'saved',
      }).statusCopy,
    );
  });

  it('rejected replies preserve the selected option and show the generic error copy', () => {
    const { sandbox, bridge } = seed({ status: 'rejected' });
    const selectPress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'select'
        && ((press.payload as JsonRecord).payload as JsonRecord).id === OTHER_ID,
    )!;
    sandbox.bitfieldOnAction(JSON.stringify(selectPress.payload));
    const savePress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'save',
    )!;
    sandbox.bitfieldOnAction(JSON.stringify(savePress.payload));
    expect(allText(bridge.snapshot()?.root as JsonRecord | null)).toContain(
      projectSettingView({
        policy: readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: OTHER_ID }),
        phase: 'error',
      }).errorCopy,
    );
  });

  it('offline replies preserve the selected option and show the generic offline copy', () => {
    const { sandbox, bridge } = seed({ offline: true });
    const selectPress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'select'
        && ((press.payload as JsonRecord).payload as JsonRecord).id === OTHER_ID,
    )!;
    sandbox.bitfieldOnAction(JSON.stringify(selectPress.payload));
    const savePress = allPresses(bridge.snapshot()?.root as JsonRecord | null).find(
      (press) => press.operation === 'screen.mount.action'
        && (press.payload as JsonRecord).type === 'save',
    )!;
    sandbox.bitfieldOnAction(JSON.stringify(savePress.payload));
    expect(allText(bridge.snapshot()?.root as JsonRecord | null)).toContain(
      projectSettingView({
        policy: readNotificationsPolicy({ records: RECORDS, currentRecords: [], selectedOptionId: OTHER_ID }),
        phase: 'idle',
        offline: true,
      }).statusCopy,
    );
  });

  it('dispose emits the sealed snapshot disposal operation', () => {
    const { bridge, handle } = seed();
    handle.dispose();
    expect(bridge.operations().some((entry) => entry.operation === 'native.view.snapshot.dispose')).toBe(true);
  });
});

describe('notifications iOS JSCore conformance gates', () => {
  const j = (...parts: string[]) => parts.join('');
  const banned = [
    j('nor', 'mal'),
    j('fo', 'cus'),
    j('d', 'n', 'd'),
    j('sched', 'uled'),
    j('Notification', ' ', 'Mode'),
    j('mode', '_id'),
    j('prop:', 'settings'),
    j('action:update-workspace-', 'notification-mode'),
    j('slot::', 'workflow'),
  ];

  it('does not import React or use DOM/browser globals', () => {
    expect(SOURCE).not.toMatch(/React\.|ReactDOM|react-dom|document\.|window\.|\brequire\(|\bimport\s/);
  });

  it('keeps domain labels, states, keys, and routes out of JSCore source', () => {
    for (const term of banned) {
      expect(SOURCE.includes(term), `JSCore source leaked ${term}`).toBe(false);
    }
  });

  it('keeps the no-leak test source clean too', () => {
    const self = readFileSync(join(JSCORE_DIR, 'mount-notifications-jscore.test.ts'), 'utf8');
    for (const term of banned) {
      expect(self.includes(term), `test source leaked ${term}`).toBe(false);
    }
  });

  it('declares the shared source paths that must stay equivalent', () => {
    const sandbox = loadMount();
    expect(sandbox.NotificationsJscore.sharedContractSourcePaths).toContain('read-data/read-notifications-policy.ts');
    expect(sandbox.NotificationsJscore.sharedContractSourcePaths).toContain('read-data/project-setting-view.ts');
    expect(sandbox.NotificationsJscore.sharedContractSourcePaths).toContain('do-work/save-setting.ts');
  });
});
