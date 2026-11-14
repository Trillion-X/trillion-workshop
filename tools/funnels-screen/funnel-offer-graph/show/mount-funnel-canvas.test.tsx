// packages/funnel-offer-graph/show/mount-funnel-canvas.test.tsx
//
// Renders the funnel mount (tornado view of the stage_address primitive)
// against mocked feeds: the honest empty state, and a resolved funnel that
// draws stage bars with conversion % (titles resolved SSOT from workflow nodes).

import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Unmount every render (and its portalled modals) between tests so the shared
// document.body never accumulates duplicate nodes across cases.
afterEach(() => cleanup());

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const dataByInput: Record<string, unknown> = {};
vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: (name: string) => dataByInput[name],
}));
const sent: unknown[] = [];
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: (req: unknown) => { sent.push(req); return Promise.resolve(); },
}));

import { FunnelCanvasRoot, decodeItemAddress } from './mount-funnel-canvas';

const emptyInput = { funnel_input: 'funnel-definition-list' };

const resolvedInput = {
  funnel_input: 'funnel-definition-list',
  owners: {
    workflow_nodes_input: 'workflow-node-list',
    measures_input: 'measure-list',
    offers_input: 'offer-list',
    detail_views_input: 'detail-view-list',
  },
  detail_records_input: 'detail-record-list',
};

function seedResolvedFeeds() {
  dataByInput['funnel-definition-list'] = [{
    kind: 'funnel-definition',
    id: 'funnel:test',
    title: 'Test funnel',
    stages: [
      {
        stage_address: 'stage:test:visit',
        workflow_node_ref: { $ref: 'workflow-definition:test#visit' },
        outcome_edges: [{ outcome_token: 'clicked', to_stage: 'stage:test:buy' }],
        detail_projection_ref: { $ref: 'visual-database.view-descriptor:visit-detail' },
        metric_selectors: [
          { measure_ref: 'progression-evaluator:visit-entered', role: 'entered' },
          { measure_ref: 'progression-evaluator:visit-converted', role: 'converted' },
        ],
      },
      {
        stage_address: 'stage:test:buy',
        workflow_node_ref: { $ref: 'workflow-definition:test#buy' },
        offer_price_ref: { $ref: 'commercial-offer:front' },
        metric_selectors: [
          { measure_ref: 'progression-evaluator:buy-entered', role: 'entered' },
          { measure_ref: 'progression-evaluator:buy-converted', role: 'converted' },
        ],
      },
    ],
  }];
  dataByInput['workflow-node-list'] = [
    { id: 'visit', label: 'Visited' },
    { id: 'buy', label: 'Bought' },
  ];
  dataByInput['measure-list'] = [
    { id: 'visit-entered', value: 1000 },
    { id: 'visit-converted', value: 250 },
    { id: 'buy-entered', value: 250 },
    { id: 'buy-converted', value: 50 },
  ];
  dataByInput['offer-list'] = [
    { id: 'front', price_options: [{ id: 'p', amount_cents: 4700, currency: 'usd' }] },
  ];
  dataByInput['detail-view-list'] = [{
    kind: 'visual-database.view-descriptor',
    id: 'visit-detail',
    fields: {
      kind: 'visual-database.fields',
      version: 3,
      descriptors: [
        { id: 'source', label: 'Source', role: 'title', paths: [['fields', 'source']] },
        { id: 'visits', label: 'Visits', role: 'metric', paths: [['fields', 'visits']], shape: 'number' },
        { id: 'conversions', label: 'Conversions', role: 'metric', paths: [['fields', 'conversions']], shape: 'number' },
      ],
    },
    views: {
      kind: 'visual-database.views',
      version: 3,
      views: [
        { id: 'visit-detail', label: 'Who is at this step', kind: 'table', columns: { order: ['source', 'visits', 'conversions'] } },
      ],
    },
  }];
  dataByInput['detail-record-list'] = [
    { id: 'detail-1', fields: { source: 'Organic', visits: 12, conversions: 3 } },
  ];
}

describe('FunnelCanvasRoot', () => {
  it('renders the honest empty state when no funnel is defined', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    expect(screen.getByText('No funnel yet')).toBeTruthy();
  });

  it('renders stage bars with resolved titles and conversion % for a real funnel', () => {
    seedResolvedFeeds();
    render(<FunnelCanvasRoot surfaceInput={resolvedInput} />);
    // titles resolved from workflow nodes (SSOT), conversion % computed
    expect(screen.getByText('Visited')).toBeTruthy();
    expect(screen.getByText('Bought')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy(); // 250/1000
    expect(screen.getByText('20%')).toBeTruthy(); // 50/250
  });

  it('opens the visual-database drill-in for the selected stage', () => {
    seedResolvedFeeds();
    render(<FunnelCanvasRoot surfaceInput={resolvedInput} />);
    fireEvent.click(screen.getByText('Visited'));
    expect(screen.getByRole('heading', { name: 'Who is at this step' })).toBeTruthy();
    expect(screen.getByText('Organic')).toBeTruthy();
  });

  it('renders reachability attributes for the prover (#44)', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    const { container } = render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    // funnel-canvas (must_see): set via CanvasView.reachRole prop
    const canvasContainer = container.querySelector('[data-reach-role="funnel-canvas"]');
    expect(canvasContainer).toBeTruthy();
    // empty-state (empty_ok): set on the empty state container
    const emptyStateContainer = container.querySelector('[data-reach-role="empty-state"]');
    expect(emptyStateContainer).toBeTruthy();
    expect(emptyStateContainer?.textContent).toMatch(/No funnel yet/);
  });

  it('renders conversion-rates and view-funnel attributes for a resolved funnel', () => {
    seedResolvedFeeds();
    const { container } = render(<FunnelCanvasRoot surfaceInput={resolvedInput} />);
    // conversion-rates (must_see): set on each stage bar
    const conversionRates = container.querySelectorAll('[data-reach-role="conversion-rates"]');
    expect(conversionRates.length).toBeGreaterThan(0);
    // view-funnel (must_act): set on each stage card
    const viewFunnelActions = container.querySelectorAll('[data-reach-action="view-funnel"]');
    expect(viewFunnelActions.length).toBeGreaterThan(0);
  });
});

describe('FunnelCanvasRoot — the create-funnel path (usable empty→create→render)', () => {
  it('empty state offers a "Create funnel" CTA and a toolbar "New funnel" action', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    expect(screen.getByRole('button', { name: 'Create funnel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New funnel' })).toBeTruthy();
  });

  it('creating a funnel authors a valid funnel-definition write to the scoped-feed path', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    sent.length = 0;
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create funnel' }));
    // modal opened → name field present
    const input = screen.getByPlaceholderText('e.g. Offer ladder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Offer ladder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const write = sent.find(
      (r) => (r as { payload?: { operation_label?: string } })?.payload?.operation_label === 'engine.operation.write-batch',
    ) as { payload: { writes: Array<{ address_label: string; path_labels: string[]; payload: { kind: string; title?: string; stages: unknown[] } }> } } | undefined;
    expect(write).toBeTruthy();
    const w = write!.payload.writes[0];
    expect(w.payload.kind).toBe('funnel-definition'); // valid record
    expect(w.payload.title).toBe('Offer ladder');
    expect(w.payload.stages).toEqual([]); // honest empty — no fake stages (L117)
    expect(w.address_label).toContain('package::funnel-offer-graph::published-record::funnel-definition::offer-ladder');
    // MUST land where the funnel::funnel-definition-list feed reads
    expect(w.path_labels).toEqual(['current-item', 'published-record']);
  });

  it('a funnel with no stages shows "Start by adding a step" (not "No funnel yet")', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    dataByInput['funnel-definition-list'] = [{ kind: 'funnel-definition', id: 'funnel:empty', title: 'My funnel', stages: [] }];
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    expect(screen.getByText('Start by adding a step')).toBeTruthy();
    expect(screen.queryByText('No funnel yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add step' })).toBeTruthy();
  });

  it('adding a step appends ONE stage row and rewrites the funnel-definition', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    sent.length = 0;
    dataByInput['funnel-definition-list'] = [{ kind: 'funnel-definition', id: 'funnel:empty', title: 'My funnel', stages: [] }];
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const input = screen.getByPlaceholderText('e.g. Visited landing page') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Visited' } });
    // the modal confirm button is also labeled "Add step" — take the last match
    const addButtons = screen.getAllByRole('button', { name: 'Add step' });
    fireEvent.click(addButtons[addButtons.length - 1]);

    const write = sent.find(
      (r) => (r as { payload?: { operation_label?: string } })?.payload?.operation_label === 'engine.operation.write-batch',
    ) as { payload: { writes: Array<{ payload: { stages: Array<{ stage_address: string; title?: string }> } }> } } | undefined;
    expect(write).toBeTruthy();
    const stages = write!.payload.writes[0].payload.stages;
    expect(stages).toHaveLength(1);
    expect(stages[0].title).toBe('Visited');
    expect(stages[0].stage_address).toBe('stage:empty:s1');
  });

  it('a created + stepped funnel RESOLVES + renders a stage bar (not the empty state)', () => {
    for (const k of Object.keys(dataByInput)) delete dataByInput[k];
    dataByInput['funnel-definition-list'] = [{
      kind: 'funnel-definition',
      id: 'funnel:live',
      title: 'Live funnel',
      stages: [{ stage_address: 'stage:live:s1', title: 'Visited' }],
    }];
    render(<FunnelCanvasRoot surfaceInput={emptyInput} />);
    // the title-only stage self-names and draws a bar; no empty state
    expect(screen.getByText('Visited')).toBeTruthy();
    expect(screen.queryByText('No funnel yet')).toBeNull();
    expect(screen.queryByText('Start by adding a step')).toBeNull();
  });
});

describe('decodeItemAddress', () => {
  it('decodes the fold address hex (CAS-fp prefix stripped) to identity_text', () => {
    const label = 'choose-per-observer:ethos-membership-price';
    const hex = '1f48' + [...label].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    expect(decodeItemAddress(hex)).toBe(label);
  });
  it('rejects non-hex, short, and non-string inputs', () => {
    expect(decodeItemAddress('nothex!!')).toBeNull();
    expect(decodeItemAddress('1f48')).toBeNull();
    expect(decodeItemAddress(undefined)).toBeNull();
  });
});
