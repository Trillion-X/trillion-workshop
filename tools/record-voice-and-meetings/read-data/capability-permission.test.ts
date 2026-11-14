import { afterEach, describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  capabilityPermissionRecoveryAvailable,
  probeCapabilityPermission,
  readCapabilityPermissionDescriptor,
  recoverCapabilityPermission,
  registerCapabilityPermissionAdapter,
  requireCapabilityPermission,
} from './capability-permission.ts';

const manifest = {
  things: [{
    payload: {
      kind: 'capability-permission-requirement',
      operation_ref: 'operation:test.capture',
      capability_ref: 'capability:test-device',
      adapter_ref: 'adapter:test',
      adapter_input: { value: 'opaque' },
      consent: { title: 'Use the test device', explanation: 'Needed for this test.', action_label: 'Allow test device' },
      denied: { title: 'Test device is blocked', explanation: 'Turn it on.', recovery_path: 'Settings → Test device' },
      unavailable: { title: 'Test device is unavailable', explanation: 'This platform has no test device.', recovery_path: '' },
    },
  }],
};

let release: (() => void) | undefined;
afterEach(() => release?.());

describe('capability permission broker', () => {
  it('decodes an open adapter reference from package DATA', () => {
    expect(readCapabilityPermissionDescriptor(manifest, 'operation:test.capture')).toMatchObject({
      capability_ref: 'capability:test-device',
      adapter_ref: 'adapter:test',
    });
  });

  it('probes and requests through a runtime-registered adapter', async () => {
    release = registerCapabilityPermissionAdapter('adapter:test', {
      probe: async () => 'undetermined',
      request: async (input) => ({ granted: input.value }),
    });
    const descriptor = readCapabilityPermissionDescriptor(manifest, 'operation:test.capture');
    expect(descriptor).not.toBeNull();
    expect(await probeCapabilityPermission(descriptor!)).toBe('undetermined');
    expect(await requireCapabilityPermission(descriptor!)).toEqual({ granted: 'opaque' });
  });

  it('reports an unknown adapter as platform unavailable', async () => {
    const descriptor = readCapabilityPermissionDescriptor(manifest, 'operation:test.capture')!;
    expect(await probeCapabilityPermission(descriptor)).toBe('platform-unavailable');
  });

  it('reports host recovery unavailable without the presenter bridge', async () => {
    const descriptor = readCapabilityPermissionDescriptor(manifest, 'operation:test.capture')!;
    expect(capabilityPermissionRecoveryAvailable()).toBe(false);
    const outcome = await recoverCapabilityPermission(descriptor);
    expect(outcome.recovered).toBe(false);
    expect(outcome.recovery_unavailable).toBe('host-recovery-bridge-not-present');
  });

  it('recovers through the presenter bridge when the host resets the denial', async () => {
    const descriptor = readCapabilityPermissionDescriptor(manifest, 'operation:test.capture')!;
    const previousWindow = globalThis.window;
    const bridge = {
      available: true,
      recoverMediaCapture: async (mediaTypes: string[]) => ({
        recovery_performed: true,
        results: Object.fromEntries(mediaTypes.map((key) => [key, 'granted'])),
        tcc_client_name: 'Trillion',
      }),
    };
    (globalThis as Record<string, unknown>).window = { __BITFIELD_PERMISSION_BROKER__: bridge };
    try {
      expect(capabilityPermissionRecoveryAvailable()).toBe(true);
      const outcome = await recoverCapabilityPermission(descriptor);
      expect(outcome.recovered).toBe(true);
      expect(outcome.tcc_client_name).toBe('Trillion');
    } finally {
      (globalThis as Record<string, unknown>).window = previousWindow;
    }
  });

  it('derives media types from the descriptor constraints for recovery', async () => {
    const descriptor = readCapabilityPermissionDescriptor(manifest, 'operation:test.capture')!;
    const previousWindow = globalThis.window;
    let observed: string[] = [];
    const bridge = {
      available: true,
      recoverMediaCapture: async (mediaTypes: string[]) => {
        observed = mediaTypes;
        return { recovery_performed: true, results: { audio: 'denied' } };
      },
    };
    (globalThis as Record<string, unknown>).window = { __BITFIELD_PERMISSION_BROKER__: bridge };
    try {
      const outcome = await recoverCapabilityPermission(descriptor);
      expect(observed).toEqual(['audio', 'video']);
      expect(outcome.recovered).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).window = previousWindow;
    }
  });
});
