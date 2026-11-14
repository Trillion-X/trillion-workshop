import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildMailActionRequest } from '../do-work/request-mail-action.ts';
import {
  readMailWorkspaceProofFeed,
  readMailWorkspaceProofState,
} from '../show/mail-workspace-fixtures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOUNT_SOURCE = readFileSync(join(HERE, 'mount-email-client-jscore.js'), 'utf8');

type SnapshotNode = {
  kind: string;
  props: Record<string, unknown>;
  children: SnapshotNode[];
};

function loadMount(): (record: unknown, mount: unknown) => { dispose: () => void } {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MOUNT_SOURCE, sandbox);
  return sandbox.bitfieldMount as never;
}

function fakeMount(inputs: Record<string, unknown | null>) {
  let snapshot: { root: SnapshotNode } | null = null;
  const invocations: Array<{ operation: string; payload: unknown }> = [];
  return {
    snapshot: () => snapshot,
    invocations: () => invocations,
    invoke(operation: string, json: string): string {
      const payload = JSON.parse(json);
      invocations.push({ operation, payload });
      if (operation === 'package.input.read') {
        const name = payload.input_name as string;
        const value = inputs[name];
        const found = value !== null && value !== undefined;
        return JSON.stringify({ found, value: found ? value : null });
      }
      if (operation === 'native.view.snapshot.replace') {
        snapshot = payload;
      }
      return '';
    },
  };
}

function allText(node: SnapshotNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.kind === 'text' && typeof node.props.text === 'string') out.push(node.props.text);
  for (const child of node.children || []) allText(child, out);
  return out;
}

function pressNodes(node: SnapshotNode | undefined, out: SnapshotNode[] = []): SnapshotNode[] {
  if (!node) return out;
  if (node.props && node.props.press) out.push(node);
  for (const child of node.children || []) pressNodes(child, out);
  return out;
}

describe('email-client iOS JSCore mount', () => {
  let mount: ReturnType<typeof loadMount>;

  beforeAll(() => {
    mount = loadMount();
    expect(typeof mount).toBe('function');
  });

  it('renders the same sparse workspace labels as the browser read model', () => {
    const feed = readMailWorkspaceProofFeed('sparse');
    const browserModel = readMailWorkspaceProofState('sparse');
    const nativeMount = fakeMount({ 'communication-work-items': feed });

    mount({ lifecycle_key: 'email-test' }, nativeMount);

    const texts = allText(nativeMount.snapshot()?.root);
    expect(texts).toContain('Email');
    expect(texts).toContain(browserModel.accounts[0].name);
    expect(texts).toContain(browserModel.messageRows[0].subject);
    expect(texts).toContain(browserModel.selectedThread?.actions[0].label);
    expect(texts.join('\n')).not.toMatch(/React|requestGoogleMailSync|sync-google-mail|service-connections/);
  });

  it('renders dense and empty states from the package input contract', () => {
    const denseModel = readMailWorkspaceProofState('dense');
    const denseMount = fakeMount({ 'communication-work-items': readMailWorkspaceProofFeed('dense') });
    mount({ lifecycle_key: 'email-dense' }, denseMount);
    expect(allText(denseMount.snapshot()?.root)).toContain(denseModel.messageRows[0].subject);

    const emptyMount = fakeMount({ 'communication-work-items': readMailWorkspaceProofFeed('empty-no-accounts') });
    mount({ lifecycle_key: 'email-empty' }, emptyMount);
    expect(allText(emptyMount.snapshot()?.root)).toContain('Connect an email account');
  });

  it('seals descriptor actions as native target-invoke button payloads', () => {
    const feed = readMailWorkspaceProofFeed('sparse');
    const nativeMount = fakeMount({ 'communication-work-items': feed });
    mount({ lifecycle_key: 'email-action' }, nativeMount);

    const buttons = pressNodes(nativeMount.snapshot()?.root);
    expect(buttons.length).toBeGreaterThan(0);
    const archive = buttons.find((item) => allText(item).includes('Archive'));
    expect(archive).toBeTruthy();
    const press = archive?.props.press as {
      operation: string;
      payload: { target: string; payload: { correlation_id: string } };
    };
    const message = feed.messages?.find((item) => item && typeof item === 'object' && 'address' in item) as {
      address: string;
      accountAddress: string;
      threadAddress: string;
    };
    const action = feed.actions?.find((item) => item && typeof item === 'object' && 'id' in item && item.id === 'action:archive') as {
      id: string;
      label: string;
      target: string;
      operation: string;
      undoActionId?: string;
    };
    const expected = buildMailActionRequest({
      action,
      workItemAddress: message.address,
      accountAddress: message.accountAddress,
      threadAddress: message.threadAddress,
      correlationId: press.payload.payload.correlation_id,
      values: {},
    });
    expect(press).toEqual({
      operation: 'runtime.target.invoke',
      payload: expected,
    });
  });

  it('does not import React or package-specific browser helpers', () => {
    expect(MOUNT_SOURCE).not.toMatch(/\bReact\b|@bitfield\/runtime-kit\/react|requestGoogleMailSync|sync-google-mail/);
  });
});
