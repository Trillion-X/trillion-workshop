// packages/group/read-data/feed-board-projection.test.ts
//
// Proves the generic record-feed -> board-item mapping: pointer-only (no copy),
// DATA-driven fields, cluster fallback, kind filter, id dedup, no positions
// (merge-preserve contract), and that its output drives the authoritative reconcile.

import { describe, expect, it } from 'vitest';
import { recordFeedToProducerOutput, type FeedBoardProjectionConfig } from 'trillion-workshop/tools/organize-the-sidebar/read-data/feed-board-projection.ts';
import type { AddressRef } from '../../ui/show/group/group-graph';

const board: AddressRef = { family: 'group', parts: { board: 'company' } };

const AGENT_CONFIG: FeedBoardProjectionConfig = {
  cardSurface: { packageName: 'ai-agent-profile', entryName: 'agent-card' },
  idField: 'id',
  surfaceInputKey: 'agentId',
  groupKeyField: 'department',
  groupKeyFallback: 'Unassigned',
  statusField: 'status',
  kindFilter: 'ai-agent-profile',
};

const rec = (payload: unknown) => ({ payload });

describe('recordFeedToProducerOutput', () => {
  it('projects each record to a pointer item — NO record data copied (SSOT)', () => {
    const out = recordFeedToProducerOutput(
      [rec({ kind: 'ai-agent-profile', id: 'a1', label: 'Scout', department: 'Growth', status: 'running' })],
      board,
      AGENT_CONFIG,
    );
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.memberId).toBe('a1');
    const pres = item.presentation as any;
    expect(pres.placeableSurface).toEqual({
      packageName: 'ai-agent-profile',
      entryName: 'agent-card',
      surfaceInput: { agentId: 'a1' },
    });
    // the human label is NEVER copied into the member — only the pointer
    expect(JSON.stringify(item.presentation)).not.toContain('Scout');
  });

  it('carries the DATA-configured cluster field as groupKey (L090)', () => {
    const out = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'a', department: 'Ops' })], board, AGENT_CONFIG);
    expect(out.items[0].presentation.groupKey).toBe('Ops');
  });

  it('falls back to the configured cluster when the field is absent (never drops)', () => {
    const out = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'a' })], board, AGENT_CONFIG);
    expect(out.items[0].presentation.groupKey).toBe('Unassigned');
  });

  it('mirrors the status field for tone when present, omits it otherwise', () => {
    const withS = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'a', status: 'idle' })], board, AGENT_CONFIG);
    expect((withS.items[0].presentation as any).status).toBe('idle');
    const noS = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'b' })], board, AGENT_CONFIG);
    expect('status' in (noS.items[0].presentation as any)).toBe(false);
  });

  it('OMITS x/y (the merge-preserve contract for dragged positions)', () => {
    const out = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'a' })], board, AGENT_CONFIG);
    expect('x' in out.items[0].presentation).toBe(false);
    expect('y' in out.items[0].presentation).toBe(false);
  });

  it('applies the kind filter — skips non-matching records', () => {
    const out = recordFeedToProducerOutput(
      [rec({ kind: 'ai-agent-profile', id: 'a' }), rec({ kind: 'something-else', id: 'b' }), rec({ id: 'c' })],
      board,
      AGENT_CONFIG,
    );
    expect(out.items.map((i) => i.memberId)).toEqual(['a']);
  });

  it('skips records missing the id field and dedups repeated ids (first wins)', () => {
    const out = recordFeedToProducerOutput(
      [rec({ kind: 'ai-agent-profile' }), rec({ kind: 'ai-agent-profile', id: 'x', department: 'A' }), rec({ kind: 'ai-agent-profile', id: 'x', department: 'B' })],
      board,
      AGENT_CONFIG,
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0].presentation.groupKey).toBe('A');
  });

  it('is generic — a DIFFERENT family (tasks) works with only a config change, zero code edit', () => {
    const TASK_CONFIG: FeedBoardProjectionConfig = {
      cardSurface: { packageName: 'tasks', entryName: 'task-card' },
      idField: 'task_id',
      surfaceInputKey: 'taskId',
      groupKeyField: 'stage',
    };
    const out = recordFeedToProducerOutput([rec({ task_id: 't1', stage: 'Doing' })], board, TASK_CONFIG);
    expect(out.items[0].memberId).toBe('t1');
    expect((out.items[0].presentation as any).placeableSurface).toEqual({
      packageName: 'tasks',
      entryName: 'task-card',
      surfaceInput: { taskId: 't1' },
    });
    expect(out.items[0].presentation.groupKey).toBe('Doing');
  });

  it('EDGES: projects a connector per record carrying a from/to ref (topology, L090)', () => {
    const CFG = { ...AGENT_CONFIG, edgeConfigs: [
      { id: 'spawn', kindFilter: 'ai-agent-profile', fromField: 'id', toField: 'spawned_by', relationKind: 'spawned', label: 'spawned', style: { arrow: 'end' as const } },
    ] };
    const out = recordFeedToProducerOutput([
      rec({ kind: 'ai-agent-profile', id: 'child', spawned_by: 'parent' }),
      rec({ kind: 'ai-agent-profile', id: 'parent' }),
    ], board, CFG);
    // 2 node members + 1 connector
    const conns = out.items.filter((i) => typeof (i.presentation as any).fromMemberId === 'string');
    expect(conns).toHaveLength(1);
    const c = conns[0].presentation as any;
    expect(c.kind).toBe('connector');
    expect(c.fromMemberId).toBe('child');
    expect(c.toMemberId).toBe('parent');
    expect(c.relationKind).toBe('spawned');
    expect(c.arrow).toBe('end');
    // connector carries NO x/y (geometry from endpoints)
    expect('x' in c).toBe(false);
  });

  it('EDGES: drops self-loops, de-dups identical edges, and keeps a dangling ref (renderer skips it)', () => {
    const CFG = { ...AGENT_CONFIG, edgeConfigs: [
      { id: 'spawn', kindFilter: 'ai-agent-profile', fromField: 'id', toField: 'spawned_by' },
    ] };
    const out = recordFeedToProducerOutput([
      rec({ kind: 'ai-agent-profile', id: 'a', spawned_by: 'a' }),        // self-loop → dropped
      rec({ kind: 'ai-agent-profile', id: 'b', spawned_by: 'offboard' }), // dangling → kept (renderer skips)
      rec({ kind: 'ai-agent-profile', id: 'b2', spawned_by: 'offboard' }),
    ], board, CFG);
    const conns = out.items.filter((i) => typeof (i.presentation as any).fromMemberId === 'string');
    // a→a dropped; b→offboard and b2→offboard kept (distinct); no dup
    expect(conns.map((c) => `${(c.presentation as any).fromMemberId}->${(c.presentation as any).toMemberId}`).sort())
      .toEqual(['b->offboard', 'b2->offboard']);
  });

  it('EDGES: none configured → zero connectors (pure node board, zero regression)', () => {
    const out = recordFeedToProducerOutput([rec({ kind: 'ai-agent-profile', id: 'a', spawned_by: 'x' })], board, AGENT_CONFIG);
    expect(out.items.every((i) => typeof (i.presentation as any).fromMemberId !== 'string')).toBe(true);
  });

  it('preserves feed order and targets the given group', () => {
    const out = recordFeedToProducerOutput(
      [rec({ kind: 'ai-agent-profile', id: 'a' }), rec({ kind: 'ai-agent-profile', id: 'b' })],
      board,
      AGENT_CONFIG,
    );
    expect(out.targetGroupRef).toBe(board);
    expect(out.items.map((i) => i.memberId)).toEqual(['a', 'b']);
  });
});
