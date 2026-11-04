// Ported unchanged except for import paths from bitfield-packages packages/timed-action/do-work/evaluate-due-scheduled-actions.test.ts.
// Proves the generic due-and-unfired evaluator over timed-action's REAL graph shape
// (separate records / time_windows / actions / receipts joined by record_id — the same
// shape read-scheduled-action-graph.ts consumes). Engine-free, deterministic (clock
// injected). Covers: due+unfired fires emit identity + operation only (row-carried
// dispatch doctrine — the fire def re-reads the row and dispatches row.dispatch);
// not-yet-due skips; already-run (a matching receipt by record_id+operation) skips;
// unscheduled (no window) fails closed; a dispatch-less row fails closed; a second
// action on the same record fires independently; the real __fixtures__ shape parses;
// malformed now throws.

import { describe, it, expect } from './vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateDueScheduledActions, receiptKey, actionOperation } from '../do-work/evaluate-due-scheduled-actions.ts';

const NOW = '2026-07-02T12:00:00Z';
const HERE = dirname(fileURLToPath(import.meta.url));

// A minimal graph: one customer work-item due yesterday with a feedback action.
// The action row carries its OWN dispatch config as DATA (L090 self-describing).
const graph = (over = {}) => ({
  records: [{ role: 'record', record_id: 'cust-1', owner_ref: 'account:cust-1', fields: { title: 'Jordan' } }],
  time_windows: [{ time_window_id: 'tw-1', record_id: 'cust-1', start: '2026-07-01T00:00:00Z' }],
  actions: [
    {
      action_id: 'action:customer-follow-up.send-feedback-request',
      record_id: 'cust-1',
      dispatch: {
        name: 'slot::workflow',
        input: {
          operation: 'execute_definition',
          definition_id: 'action:customer-follow-up.send-feedback-request',
          input: { record_id: 'cust-1' },
        },
      },
    },
  ],
  receipts: [],
  ...over,
});

describe('evaluateDueScheduledActions (real timed-action graph shape)', () => {
  it('fires a due action, emitting identity + operation only (no owner vocabulary)', () => {
    const r = evaluateDueScheduledActions({ ...graph(), now: NOW });
    expect(r.due_count).toBe(1);
    expect(r.due[0].record_id).toBe('cust-1');
    expect(r.due[0].operation).toBe('action:customer-follow-up.send-feedback-request');
    expect(r.due[0].evaluated_at).toBe('2026-07-02T12:00:00.000Z');
    // The due item never carries owner invocation shapes — the fire def re-reads the row.
    expect(r.due[0]).not.toHaveProperty('target_ref');
    expect(r.due[0]).not.toHaveProperty('owner_ref');
    expect(r.due[0]).not.toHaveProperty('fields');
  });

  it('skips when the joined time-window has not opened yet', () => {
    const g = graph({ time_windows: [{ time_window_id: 'tw-1', record_id: 'cust-1', start: '2026-07-10T00:00:00Z' }] });
    expect(evaluateDueScheduledActions({ ...g, now: NOW }).due_count).toBe(0);
  });

  it('skips a due action that already has a matching receipt (record_id + operation)', () => {
    const op = actionOperation(graph().actions[0]);
    const g = graph({ receipts: [{ record_id: 'cust-1', operation: op, observed_at: NOW }] });
    const r = evaluateDueScheduledActions({ ...g, now: NOW });
    expect(r.due_count).toBe(0);
    expect(r.already_fired_count).toBe(1);
  });

  it('fails closed when a record has no time-window (unscheduled)', () => {
    expect(evaluateDueScheduledActions({ ...graph({ time_windows: [] }), now: NOW }).due_count).toBe(0);
  });

  it('fails closed when the action row carries no dispatch config (never fired, never receipted)', () => {
    const g = graph({
      actions: [{ action_id: 'action:no-dispatch', record_id: 'cust-1' }],
    });
    const r = evaluateDueScheduledActions({ ...g, now: NOW });
    expect(r.due_count).toBe(0);
    expect(r.scanned_action_count).toBe(1);
  });

  it('a second action on the same record fires independently of the first receipt', () => {
    const dispatch = { name: 'compute.process', input: { argv: ['node', '-e', ''] } };
    const g = graph({
      actions: [
        { action_id: 'action:a', record_id: 'cust-1', dispatch },
        { action_id: 'action:b', record_id: 'cust-1', dispatch },
      ],
      receipts: [{ record_id: 'cust-1', operation: 'action:a', observed_at: NOW }],
    });
    const r = evaluateDueScheduledActions({ ...g, now: NOW });
    expect(r.due_count).toBe(1);
    expect(r.due[0].operation).toBe('action:b');
  });

  it('receipts suppress only the exact identity pair, including delimiter-bearing identifiers', () => {
    const dispatch = { name: 'slot::workflow', input: {} };
    const g = graph({
      time_windows: [
        { record_id: 'a|b', start: '2026-07-01T00:00:00Z' },
        { record_id: 'a', start: '2026-07-01T00:00:00Z' },
      ],
      actions: [
        { record_id: 'a|b', operation: 'c', dispatch },
        { record_id: 'a', operation: 'b|c', dispatch },
      ],
      receipts: [{ record_id: 'a|b', operation: 'c' }],
    });
    const result = evaluateDueScheduledActions({ ...g, now: NOW });
    expect(result.due.map(({ record_id, operation }) => [record_id, operation])).toEqual([['a', 'b|c']]);
    expect(receiptKey('a', null)).not.toBe(receiptKey('a', ''));
  });

  it('parses the real __fixtures__/scheduled-action-records.json graph shape', () => {
    const fixture = JSON.parse(readFileSync(join(HERE, 'scheduled-action-records.json'), 'utf8'));
    // work-a start 2026-06-22T15:00 is due at this now; every fixture action carries dispatch.
    const r = evaluateDueScheduledActions({ ...fixture, now: '2026-06-22T15:30:00.000Z' });
    expect(r.scanned_action_count).toBe(fixture.actions.length);
    expect(r.due.length).toBeGreaterThan(0);
    expect(r.due.every((d) => typeof d.record_id === 'string' && typeof d.operation === 'string')).toBe(true);
  });

  it('throws on an unparseable now (never silently treats everything as due)', () => {
    expect(() => evaluateDueScheduledActions({ ...graph(), now: 'garbage' })).toThrow();
  });
});
