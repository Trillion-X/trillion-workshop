import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import type { ProcessSessionEventsFeedView } from './read-process-session-events.ts';
import type { ProcessSessionSnapshot } from './read-process-sessions.ts';
import { buildProcessSessionActivityMap } from './build-process-session-activity.ts';

function session(overrides: Partial<ProcessSessionSnapshot> = {}): ProcessSessionSnapshot {
  return {
    session_id: 'process_session:any-runtime',
    event_feed_address: 'feed:any-runtime',
    state: 'running',
    argv: ['any-runtime'],
    cwd: '/workspace/alpha',
    session_settings: { text_grid: null },
    started_at_ms: 1_000,
    updated_at_ms: 5_000,
    command_count: 0,
    event_count: 0,
    exit_code: null,
    failure_reason: null,
    ...overrides,
  };
}

describe('process-session activity projection', () => {
  it('projects lifecycle, output, state, and rejection events from addressed feeds', () => {
    const feed: ProcessSessionEventsFeedView = {
      eventCount: 3,
      forEachEvent(visitor) {
        visitor.onOutputBytes?.(
          'process_session:any-runtime',
          1,
          2_000,
          'stdout',
          new TextEncoder().encode('hello from any runtime\n'),
        );
        visitor.onSessionStateChanged?.('process_session:any-runtime', 2, 3_000, 'exited', 0, null);
        visitor.onCommandRejected?.('process_session:any-runtime', 3, 4_000, 'command refused by policy');
      },
    };

    const events = buildProcessSessionActivityMap([
      session(),
    ], [
      { address: 'feed:any-runtime', data: feed },
    ])['process_session:any-runtime'];

    expect(events.map((event) => [event.hookType, event.toolName, event.summary])).toEqual([
      ['SessionStart', 'SessionStart', 'Session started'],
      ['OutputBytes', 'stdout', 'hello from any runtime'],
      ['SessionStateChanged', 'exited', 'Session exited with code 0'],
      ['CommandRejected', 'command-rejected', 'command refused by policy'],
    ]);
  });

  it('keeps a snapshot-visible lane when one addressed event feed is malformed', () => {
    const events = buildProcessSessionActivityMap([
      session(),
    ], [
      { address: 'feed:any-runtime', data: new Uint8Array([255]) },
    ])['process_session:any-runtime'];

    expect(events.map((event) => event.hookType)).toEqual([
      'SessionStart',
      'ProcessSessionFeedError',
    ]);
    expect(events[1]?.summary).toMatch(/process-session-events feed/);
  });

  it('ignores event feeds not addressed by the current process-session snapshots', () => {
    expect(buildProcessSessionActivityMap([
      session(),
    ], [
      {
        address: 'feed:other',
        data: {
          eventCount: 0,
          forEachEvent() {
            throw new Error('unreachable');
          },
        },
      },
    ])['process_session:any-runtime']?.map((event) => event.hookType)).toEqual(['SessionStart']);
  });
});
