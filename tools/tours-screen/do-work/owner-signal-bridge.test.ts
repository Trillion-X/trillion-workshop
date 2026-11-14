import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  buildOwnerSignalBridge,
  ownerSignalTargetMap,
} from './owner-signal-bridge.ts';

describe('owner-signal-bridge', () => {
  it('keeps only executable envelope descriptors', () => {
    expect(ownerSignalTargetMap({
      valid: { target: 'owner.session', operation: 'read' },
      invalid: { target: 'owner.session' },
      'not-an-object': 'nope',
    })).toEqual({
      valid: { target: 'owner.session', operation: 'read' },
    });
    expect(ownerSignalTargetMap(null)).toBeNull();
  });

  it('resolves DATA context params and decodes a bytes reply', async () => {
    const bridge = buildOwnerSignalBridge({
      'package::owner::session': {
        target: 'owner.session',
        operation: 'read',
        params: {
          browser_id: { $source: 'local_storage', key: 'owner.browser-id' },
          scope: { $source: 'scope_ref' },
        },
      },
    }, {
      resolveContextParam: (source, context) => source.$source === 'scope_ref'
        ? context.scopeRef ?? null
        : source.key === 'owner.browser-id' ? 'browser-1' : null,
      dispatch: async (perform) => {
        expect(perform).toEqual({
          target: 'owner.session',
          operation: 'read',
          params: { browser_id: 'browser-1', scope: 'run-1' },
        });
        return { payload: new TextEncoder().encode(JSON.stringify({ session: null })) };
      },
    });

    await expect(bridge(['package::owner::session'], {
      definitionId: 'definition',
      stepId: 'gate',
      scopeRef: 'run-1',
    })).resolves.toEqual({ 'package::owner::session': { session: null } });
  });

  it('fails one owner independently instead of starving every declared signal', async () => {
    const bridge = buildOwnerSignalBridge({
      failing: { target: 'owner.down', operation: 'read' },
      working: { target: 'owner.up', operation: 'read' },
    }, {
      dispatch: async (perform) => {
        if (perform.target === 'owner.down') throw new Error('offline');
        return { accepted: true };
      },
    });

    await expect(bridge(['failing', 'working', 'undeclared'], {
      definitionId: 'definition',
      stepId: 'gate',
    })).resolves.toEqual({ failing: null, working: { accepted: true }, undeclared: null });
  });

  it('never dispatches inherited targets or accepts inherited reply fields', async () => {
    let calls = 0;
    const bridge = buildOwnerSignalBridge(Object.assign(Object.create({
      inherited: { target: 'not-declared', operation: 'read' },
    }), { own: { target: 'declared', operation: 'read', read_path: ['accepted'] } }), {
      dispatch: async () => { calls++; return Object.create({ accepted: true }); },
    });
    await expect(bridge(['inherited', 'own'], { definitionId: 'definition', stepId: 'gate' }))
      .resolves.toEqual({ inherited: null, own: null });
    expect(calls).toBe(1);
  });

  it('retains an explicitly declared prototype-shaped reference as ordinary DATA', async () => {
    const map = ownerSignalTargetMap(JSON.parse('{"__proto__":{"target":"owner.read","operation":"read"}}'))!;
    expect(Object.hasOwn(map, '__proto__')).toBe(true);
    const bridge = buildOwnerSignalBridge(map, { dispatch: async () => ({ accepted: true }) });
    const result = await bridge(['__proto__'], { definitionId: 'definition', stepId: 'gate' });
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__).toEqual({ accepted: true });
  });

  it('projects a declared reply path so nested owner state can gate a step', async () => {
    const bridge = buildOwnerSignalBridge({
      session: {
        target: 'owner.session',
        operation: 'read',
        read_path: ['session'],
      },
    }, { dispatch: async () => ({ session: null }) });

    await expect(bridge(['session'], { definitionId: 'definition', stepId: 'gate' }))
      .resolves.toEqual({ session: null });
  });
});
