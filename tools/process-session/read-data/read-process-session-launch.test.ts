import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  readConfiguredProcessSessionTarget,
  readConfiguredTarget,
  readConfiguredTimedTarget,
  renderProcessSessionLaunchDescriptor,
} from './read-process-session-launch.ts';

describe('process-session launch descriptors', () => {
  it('reads configured process-session targets from package records without package-specific parsers', () => {
    expect(readConfiguredProcessSessionTarget({
      things: [{
        type: 'record',
        address: 'package::test::target::process-session',
        payload: {
          target: 'compute.process_session',
          target_key: 'process-session',
        },
      }],
    }, 'process-session')).toBe('compute.process_session');
  });

  it('reads configured targets with descriptor-owned timeout policy', () => {
    expect(readConfiguredTarget({
      things: [{
        type: 'record',
        address: 'package::test::target::tool-edit-apply',
        payload: {
          target: 'compute.process',
          target_key: 'tool-edit-apply',
          timeout_ms: 300_000,
        },
      }],
    }, 'tool-edit-apply')).toEqual({
      target: 'compute.process',
      timeoutMs: 300_000,
    });
  });

  it('rejects malformed configured target timeout policy', () => {
    expect(() => readConfiguredTarget({
      things: [{
        type: 'record',
        address: 'package::test::target::bad',
        payload: {
          target: 'compute.process',
          target_key: 'bad',
          timeout_ms: 0,
        },
      }],
    }, 'bad')).toThrow(/Invalid configured target timeout_ms/);
  });

  it('requires descriptor-owned timeout policy for timed targets', () => {
    expect(() => readConfiguredTimedTarget({
      things: [{
        type: 'record',
        address: 'package::test::target::missing-timeout',
        payload: {
          target: 'compute.process',
          target_key: 'missing-timeout',
        },
      }],
    }, 'missing-timeout')).toThrow(/Missing configured target timeout_ms/);
  });

  it('renders the exact nested canonical process-session descriptor', () => {
    expect(renderProcessSessionLaunchDescriptor({
      argv: ['claude', '--print', 'hello'],
      cwd: {
        kind: 'owner-resolved',
        value: 'workspace/project',
        policyHandle: 'package::chat::path-policy::project',
      },
      env: [{ kind: 'literal', name: 'CLAUDE_CONFIG_DIR', value: 'account:default', inert: true }],
      timeoutMs: 300_000,
      sessionSettings: { text_grid: { columns: 120, rows: 40 } },
    })).toEqual({
      process: {
        argv: ['claude', '--print', 'hello'],
        cwd: 'workspace/project',
        timeout_ms: 300_000,
        termination_grace_ms: 1_000,
        expected_termination: null,
        env: { CLAUDE_CONFIG_DIR: 'account:default' },
        inputs: [],
        input_trees: [],
        outputs: [],
        containment: {
          kind: 'descendant_effect_contained',
          pipe_eof_timeout_ms: 1_000,
          publications: [],
        },
        capture_fds: [1, 2],
        collected_files: [],
      },
      session_settings: { text_grid: { columns: 120, rows: 40 } },
    });
  });

  it('preserves a DATA-selected leaf session for a process that cannot create descendants', () => {
    const descriptor = renderProcessSessionLaunchDescriptor({
      argv: ['codex', 'login', 'status'],
      containmentKind: 'leaf',
      sessionSettings: { text_grid: null },
    });
    expect(descriptor.process.containment).toEqual({ kind: 'leaf' });
  });

  it('rejects unclassified process-control env and unsafe literal paths', () => {
    for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'TERMINAL']) {
      expect(() => renderProcessSessionLaunchDescriptor({
        argv: ['cmd'],
        env: [{ kind: 'literal', name, value: 'bad', inert: true }],
      })).toThrow(/Process-control env/);
    }

    expect(() => renderProcessSessionLaunchDescriptor({
      argv: ['cmd'],
      cwd: { kind: 'literal', value: '/absolute/project', inert: true },
    })).toThrow(/absolute/);
    expect(() => renderProcessSessionLaunchDescriptor({
      argv: ['cmd'],
      cwd: { kind: 'literal', value: '../project', inert: true },
    })).toThrow(/traversing/);
    expect(() => renderProcessSessionLaunchDescriptor({
      argv: ['cmd'],
      cwd: { kind: 'owner-resolved', value: '../project', policyHandle: 'policy:path' },
    })).toThrow(/portable and relative/);
    expect(() => renderProcessSessionLaunchDescriptor({
      argv: ['/usr/bin/cmd'],
    })).toThrow(/argv\[0\]/);
  });

  it('rejects credential handles until an owner materializes them', () => {
    expect(() => renderProcessSessionLaunchDescriptor({
      argv: ['cmd'],
      env: [{ kind: 'credential-handle', name: 'API_TOKEN', handleRef: 'credential:api-token' }],
    })).toThrow(/owner materialization/);
  });

  it('rejects retired top-level session fields by construction', () => {
    const descriptor = renderProcessSessionLaunchDescriptor({ argv: ['cmd'] });
    expect(Object.keys(descriptor).sort()).toEqual(['process', 'session_settings']);
    expect(JSON.stringify(descriptor)).not.toMatch(
      /sandbox_profile|credential_env|operation_claim_token|budget_reservation_token|correlation_refs/,
    );
  });
});
