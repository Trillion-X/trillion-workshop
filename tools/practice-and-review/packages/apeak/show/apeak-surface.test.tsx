import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: vi.fn(() => Promise.resolve({})) }));

import { ApeakSurface } from './ApeakSurface';
import {
  applyOverlayMappings,
  deriveSections,
  mergeActionValues,
  mergeMeasuredFields,
  normalizeSurfaceSource,
  type ApeakSurfaceSource,
} from './apeak-surface-model';

describe('apeak surface replacement', () => {
  beforeEach(async () => {
    const runtime = await import('@bitfield/runtime-kit');
    (runtime.sendRequestToBitfieldTarget as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('renders a guidance cue and dispatches its action', async () => {
    const source = normalizeSurfaceSource({
      view: {
        id: 'apeak.before-you-play',
        label: 'Before you play',
        fields: [
          { id: 'cue_title', label: 'Title', paths: [['fields', 'cue_title']] },
          { id: 'cue_body', label: 'Body', paths: [['fields', 'cue_body']] },
          { id: 'cue', label: 'Cue', paths: [], role: 'guidance-cue', roleConfig: { title: 'cue_title', body: 'cue_body' } },
        ],
      },
      records: [
        {
          id: 'cue-1',
          label: 'Reset',
          fields: { cue_title: 'Your 90-second reset', cue_body: 'Breathe and commit.' },
          actions: [{ id: 'done', label: 'I did my reset', target: 'slot::workflow', operation: 'execute_definition' }],
        },
      ],
    }) as ApeakSurfaceSource;

    render(<ApeakSurface source={source} />);
    expect(screen.getByText('Your 90-second reset')).toBeTruthy();
    fireEvent.click(screen.getByText('I did my reset'));
    const runtime = await import('@bitfield/runtime-kit');
    await waitFor(() => expect(runtime.sendRequestToBitfieldTarget).toHaveBeenCalledTimes(1));
  });

  it('renders the path rail from status overrides', () => {
    const source = normalizeSurfaceSource({
      view: {
        id: 'apeak.your-journey',
        label: 'Your journey',
        statusOverrides: {
          current: { toneColor: 'var(--accent-purple)', ring: true, bubble: 'START HERE' },
          upcoming: { toneColor: 'var(--text-muted)', dimmed: true },
        },
        fields: [
          { id: 'node_title', label: 'Title', paths: [['fields', 'node_title']] },
          { id: 'node_status', label: 'Status', paths: [['fields', 'node_status']] },
          { id: 'journey', label: 'Journey', paths: [], role: 'path-rail', roleConfig: { label: 'node_title', status: 'node_status' } },
        ],
      },
      records: [
        { id: 'j1', label: 'Baseline', fields: { node_title: 'Baseline', node_status: 'current' }, actions: [] },
        { id: 'j2', label: 'Skills', fields: { node_title: 'Skills', node_status: 'upcoming' }, actions: [] },
      ],
    }) as ApeakSurfaceSource;

    render(<ApeakSurface source={source} />);
    expect(screen.getByLabelText('Baseline')).toBeTruthy();
    expect(screen.getByText('START HERE')).toBeTruthy();
  });

  it('renders protocol-session rows and emits measured completion fields', async () => {
    const source = normalizeSurfaceSource({
      view: {
        id: 'apeak.checkin',
        label: 'Mental check-in',
        fields: [
          { id: 'step_label', label: 'Step', paths: [['fields', 'step_label']] },
          { id: 'step_content', label: 'Content', paths: [['fields', 'step_content']] },
          { id: 'step_capture', label: 'Capture', paths: [['fields', 'step_capture']] },
          { id: 'step_advance', label: 'Advance', paths: [['fields', 'step_advance']] },
          { id: 'row_source', label: 'Source', paths: [['sourceId']] },
          {
            id: 'session',
            label: 'Mental check-in',
            paths: [],
            role: 'protocol-session',
            rowsWhere: { field: 'row_source', equals: 'protocol-steps' },
            roleConfig: { label: 'step_label', content: 'step_content', capture: 'step_capture', advance: 'step_advance', completeAction: 'session-complete', autoStart: 'true' },
          },
        ],
      },
      records: [
        {
          id: 'step-1',
          label: 'Check in',
          sourceId: 'protocol-steps',
          fields: {
            step_label: 'How are you feeling right now?',
            step_content: 'choice',
            step_capture: 'state',
            step_advance: { op: 'input-given' },
            choices: [{ label: 'Steady', value: 'steady' }],
          },
          actions: [{ id: 'session-complete', label: 'Done', target: 'slot::workflow', operation: 'execute_definition' }],
        },
      ],
    }) as ApeakSurfaceSource;

    render(<ApeakSurface source={source} />);
    fireEvent.click(await screen.findByText('Steady'));
    const runtime = await import('@bitfield/runtime-kit');
    await waitFor(() => expect(runtime.sendRequestToBitfieldTarget).toHaveBeenCalled());
    const calls = (runtime.sendRequestToBitfieldTarget as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const payload = calls[calls.length - 1][0].payload;
    expect(payload.input.fields.state).toBe('steady');
    expect(payload.input.fields.steps_total).toBe(1);
  });

  it('applies overlay mappings before rendering', () => {
    const merged = applyOverlayMappings(
      {
        view: { id: 'v', label: 'V', fields: [] },
        records: [{ id: 'cue', label: 'Cue', fields: {}, actions: [] }],
      },
      {
        records: [{ id: 'measure', fields: { reading: { measure: { value: 4 } } } }],
      },
      [
        {
          from: { path: ['fields', 'reading', 'measure', 'value'] },
          to: { row_id: 'cue', field: 'cue_chip' },
          visibleWhen: { op: 'gt', value: 0 },
          display: { template: 'Used {value} times' },
        },
      ],
    ) as Record<string, unknown>;
    expect((merged.records as Array<Record<string, unknown>>)[0].fields).toMatchObject({ cue_chip: 'Used 4 times' });
  });

  it('derives role sections and merges measured fields deterministically', () => {
    const source = normalizeSurfaceSource({
      view: {
        id: 'apeak.path',
        label: 'Path',
        fields: [
          { id: 'row_source', label: 'Source', paths: [['sourceId']] },
          { id: 'cue', label: 'Cue', paths: [], role: 'guidance-cue' },
        ],
      },
      records: [{ id: 'r1', label: 'Row', sourceId: 'x', fields: {}, actions: [] }],
    }) as ApeakSurfaceSource;
    expect(deriveSections(source)).toHaveLength(1);
    expect(
      mergeActionValues(
        { id: 'a', label: 'Action', target: 'slot::workflow', operation: 'execute_definition', input: { fields: { protocol: 'x' } } },
        mergeMeasuredFields({
          sessionId: 'sess-1',
          stepsTotal: 1,
          stepsCompleted: 1,
          plannedSeconds: 10,
          actualSeconds: 9.3,
          captures: [{ stepId: 's1', fieldId: 'state', value: 'steady', atMs: 0 }],
          visibilityLost: false,
          completed: true,
        }),
      ),
    ).toMatchObject({
      target: 'slot::workflow',
      payload: {
        input: {
          fields: {
            protocol: 'x',
            state: 'steady',
            session_id: 'sess-1',
          },
        },
      },
    });
  });

  it('keeps every apeak placeable surface on the package-owned component', () => {
    const payload = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'packages/apeak/things-to-store-and-run.json'), 'utf8'),
    ) as { things: Array<{ payload?: Record<string, unknown> }> };
    const surfaces = payload.things.filter((thing) => thing.payload?.kind === 'placeable-surface');
    const owned = surfaces.filter((thing) => thing.payload?.material_target === 'component:apeak-surface');
    expect(surfaces.length).toBeGreaterThan(0);
    expect(owned).toHaveLength(surfaces.length);
  });
});
