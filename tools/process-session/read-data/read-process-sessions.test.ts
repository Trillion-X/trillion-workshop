import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { decodeProcessSessionSnapshot, decodeProcessSessionsFeed } from './read-process-sessions.ts';

describe('process-session snapshot feed decoding', () => {
  it('decodes canonical process-session snapshot rows without executor-specific assumptions', () => {
    expect(decodeProcessSessionSnapshot({
      session_id: 'process_session:any-executor',
      event_feed_address: 'feed:any-executor',
      state: 'running',
      argv: ['/tools/anything', '--flag'],
      cwd: '/workspace/alpha',
      session_settings: {
        text_grid: { columns: '120', rows: 40 },
      },
      started_at_ms: '1000',
      updated_at_ms: 2500,
      command_count: '2',
      event_count: 5,
      exit_code: null,
      failure_reason: '',
    })).toEqual({
      session_id: 'process_session:any-executor',
      event_feed_address: 'feed:any-executor',
      state: 'running',
      argv: ['/tools/anything', '--flag'],
      cwd: '/workspace/alpha',
      session_settings: {
        text_grid: { columns: 120, rows: 40 },
      },
      started_at_ms: 1000,
      updated_at_ms: 2500,
      command_count: 2,
      event_count: 5,
      exit_code: null,
      failure_reason: null,
    });
  });

  it('omits malformed rows and sorts deterministically by start time then session id', () => {
    expect(decodeProcessSessionsFeed([
      null,
      { session_id: '', started_at_ms: 1 },
      { session_id: 'process_session:b', started_at_ms: 20 },
      { session_id: 'process_session:a', started_at_ms: 20 },
      { session_id: 'process_session:early', started_at_ms: 10 },
    ]).map((session) => session.session_id)).toEqual([
      'process_session:early',
      'process_session:a',
      'process_session:b',
    ]);
  });

  it('normalizes unknown states to running because snapshots are current process liveness facts', () => {
    expect(decodeProcessSessionSnapshot({
      session_id: 'process_session:future-state',
      state: 'paused-by-new-runtime',
    })?.state).toBe('running');
  });
});
