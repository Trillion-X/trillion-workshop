// packages/service-connections/show/__tests__/ServiceConnectionsSurface.render-states.test.tsx
//
// =============================================================================
// PURPOSE — UIR-6 render-state proof (offline, R7-safe)
// =============================================================================
//
// Mounts the REAL post-rebase ServiceConnectionsSurface (shared ProviderMark +
// ref-free ServiceConnectionReadinessView) across the render-state matrix the
// UI rebase plan requires: empty/loading, sparse, dense, connected, error,
// pending, and the search-empty "connect anything" path. Each state asserts the
// migrated DOM renders the right human controls WITHOUT crashing, and that no
// storage/ref vocabulary leaks into visible copy (L098/L114/L118).
//
// This is the maximally-capable proof obtainable WITHOUT touching the live
// studio: the studio engine is a shared, running product entry (R7 — never
// reboot/redeploy into a shared live carrier mid-session), and this repo has no
// pixel-screenshot tool (jsdom/vitest only). Pixel + responsive capture through
// the product entry is the one item this harness cannot cover — see
// observations/2026-06-20-ui-rebase-visual-proof.md for the deferred-item door.
//
// Fixtures use the EXACT proven raw shapes the decode tests validate:
//   - feed   → array-of-row-objects (read-service-connections.ts:231-240),
//              the same shape read-service-connection-readiness-view.test.ts uses
//   - catalog → the reactive `published-records` projection: an array of
//              `{ address, payload }` rows. Each provider self-describes via
//              its payload ({vendor,name,instructions,defaultScopes,
//              credentialFields,helperLinks,logoUrl,category,...}); the catalog
//              folds straight from the live log — no regenerated cell_table.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE — the documentation here is a design feature; do not
// simplify or remove it.
// =============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Boundary mocks --------------------------------------------------------
// useBitfieldData(key) returns whatever the active state staged on globalThis.
// Key `undefined` returns the live connection feed; `sc-catalog-feed` returns
// the bounded catalog; `provider-icon-registry-feed` returns only icon DATA.
vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: (key?: unknown) => {
    const staged = (globalThis as Record<string, unknown>).__SC_STAGE__ as
      | { feed: unknown; catalog: unknown; registry: unknown; chosen: unknown }
      | undefined;
    if (!staged) return null;
    if (key === 'sc-catalog-feed') return staged.catalog;
    if (key === 'provider-icon-registry-feed') return staged.registry;
    if (key === 'chosen-ai-provider') return staged.chosen;
    return staged.feed;
  },
}));

// Connect/disconnect/acquire route fact writes through this target; keep it
// inert so render-state tests stay pure (no live engine round-trip).
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: vi.fn(async () => ({ ok: true })),
}));

import { ServiceConnectionsSurface } from '@/packages/service-connections/show/ServiceConnectionsSurface';
import { ToastProvider } from '@/packages/ui/show/toast';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

// ---------------------------------------------------------------------------
// Fixtures — proven raw shapes
// ---------------------------------------------------------------------------

/** One live-feed row object (read-service-connections array decode path). */
function feedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'service_connection:alpaca',
    serviceName: 'Alpaca',
    serviceVendor: 'alpaca',
    statusRef: 'connection-status:connected',
    status: 'connected',
    canConnect: true,
    canSend: true,
    canRetry: false,
    isPending: false,
    scopes: ['market-data'],
    credentialHandle: 'handle',
    credentialHandleRefs: ['secret:one'],
    connectedAt: '2026-06-20T00:00:00.000Z',
    proofRefs: [],
    blockerRefs: [],
    eventRefs: [],
    ...overrides,
  };
}

const FIELD = [
  {
    id: 'api_key',
    label: 'API Key',
    required: true,
    secret: true,
    multiline: false,
    placeholder: 'sk-…',
    help: 'Keys live in the provider console.',
    autocomplete: 'off',
    guideUrl: '',
    guideSteps: [],
  },
];

/** A published-record row for one provider with a plain-language purpose +
 *  category — the reactive catalog folds these straight from the log. */
function catalogRow(
  vendor: string,
  name: string,
  purpose: string,
  category: string,
  logo = '',
) {
  return {
    address: `package::service-connections::published-record::${vendor}`,
    payload: {
      vendor,
      name,
      instructions: purpose,
      defaultScopes: [],
      credentialFields: FIELD,
      helperLinks: [],
      logoUrl: logo,
      category,
    },
  };
}

const EMPTY_CATALOG: ReturnType<typeof catalogRow>[] = [];

/** Eight catalog vendors → a dense, multi-category grid. */
const DENSE_CATALOG = [
  catalogRow('alpaca', 'Alpaca', 'Trade stocks and read market data.', 'Trading'),
  catalogRow('github', 'GitHub', 'Read and write your repositories.', 'Developer'),
  catalogRow('notion', 'Notion', 'Read and update your workspace pages.', 'Docs'),
  catalogRow('stripe', 'Stripe', 'Read payments and issue refunds.', 'Payments'),
  catalogRow('slack', 'Slack', 'Post messages to your channels.', 'Comms'),
  catalogRow('linear', 'Linear', 'Open and update issues.', 'Developer'),
  catalogRow('gmail', 'Gmail', 'Read and send mail.', 'Comms'),
  catalogRow('hubspot', 'HubSpot', 'Sync contacts and deals.', 'CRM'),
];

/** A couple of catalog vendors → a sparse grid. */
const SPARSE_CATALOG = [
  catalogRow('github', 'GitHub', 'Read and write your repositories.', 'Developer'),
  catalogRow('notion', 'Notion', 'Read and update your workspace pages.', 'Docs'),
];

const WHATSAPP_PROVIDER_ICON = {
  payload: {
    kind: 'provider-icon',
    provider_slug: 'whatsapp',
    icon_id: 'logos:whatsapp-icon',
    asset: { kind: 'bundled-svg', id: 'logos:whatsapp-icon' },
  },
};

// Storage/ref vocabulary that must never reach visible product copy.
const BANNED_VISIBLE_TERMS = [
  'statusref',
  'proofref',
  'blockerref',
  'eventref',
  'credentialhandle',
  'attribute_fact',
  'subject_id',
  'envelope',
  'payload',
  'descriptor',
  'slot::',
];

function stage(feed: unknown, catalog: unknown, registry: unknown = [], chosen: unknown = null) {
  (globalThis as Record<string, unknown>).__SC_STAGE__ = { feed, catalog, registry, chosen };
}

function mount() {
  return render(
    React.createElement(ToastProvider, null, React.createElement(ServiceConnectionsSurface)),
  );
}

function mountDiscovery() {
  return render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ServiceConnectionsSurface, {
        presentation: 'onboarding-discovery',
        showDiscoveryProgress: true,
      }),
    ),
  );
}

function expectNoBannedVocab(text: string | null | undefined) {
  const haystack = (text ?? '').toLowerCase();
  for (const banned of BANNED_VISIBLE_TERMS) {
    expect(haystack).not.toContain(banned);
  }
}

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__SC_STAGE__;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Render-state matrix
// ---------------------------------------------------------------------------

describe('ServiceConnectionsSurface — render-state matrix', () => {
  it('onboarding discovery presents truthful live progress instead of the settings catalog', () => {
    stage(
      [
        feedRow(),
        feedRow({
          id: 'service_connection:notion',
          serviceName: 'Notion',
          serviceVendor: 'notion',
          status: 'pending',
          canSend: false,
          isPending: true,
          connectedAt: null,
        }),
      ],
      SPARSE_CATALOG,
    );
    const { container } = mountDiscovery();
    expect(screen.getByText('Your assistant is learning how your work fits together.')).toBeTruthy();
    expect(screen.getByText('Connected and ready')).toBeTruthy();
    expect(screen.getByText('Finish these outside sign-ins')).toBeTruthy();
    expect(container.querySelector('[data-service-connections-presentation="onboarding-discovery"]')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search or type any service…')).toBeNull();
  });

  it('onboarding discovery never fabricates a completed scan from an empty readback', () => {
    stage([], EMPTY_CATALOG);
    mountDiscovery();
    expect(screen.getByText('Looking for available tools and sources')).toBeTruthy();
    expect(screen.getByText('Looking for tools and services you can reach')).toBeTruthy();
  });

  it('loading/empty: no feed + no catalog → honest empty placeholder, never a crash or fake row', () => {
    stage(null, null);
    const { container } = mount();
    // The header + standing "add your own" promise are always present.
    expect(screen.getByText('Connections')).toBeTruthy();
    expect(screen.getByText('Don’t see your tool?')).toBeTruthy();
    // Honest empty state — no fabricated tiles (L117).
    expect(screen.getByText(/Nothing connected yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browse all services' })).toBeTruthy();
    expectNoBannedVocab(container.textContent);
  });

  it('empty catalog cursor (rowCount 0) decodes to the same honest empty state', () => {
    stage([], EMPTY_CATALOG);
    mount();
    expect(screen.getByText(/Nothing connected yet/i)).toBeTruthy();
  });

  it('sparse: a small catalog with nothing connected → connectable tiles, no connected group', () => {
    stage([], SPARSE_CATALOG);
    const { container } = mount();
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('Notion')).toBeTruthy();
    // Every sparse tile offers a Connect action; none is connected yet.
    expect(screen.getAllByRole('button', { name: 'Connect' }).length).toBeGreaterThanOrEqual(2);
    // The connected group is detected by its unique management affordances, NOT
    // by "Connected" text — the SegmentedControl always renders that label.
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expectNoBannedVocab(container.textContent);
  });

  it('a caller-selected category opens already scoped without hiding the category control', () => {
    stage([], [
      catalogRow('openai', 'OpenAI', 'Chat with GPT models.', 'AI'),
      catalogRow('github', 'GitHub', 'Read and write repositories.', 'Developer'),
    ]);
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ServiceConnectionsSurface, { initialCategories: ['AI'] }),
      ),
    );
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.getByRole('button', { name: 'AI' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('provider choice saves an unknown AI provider without opening authorization', async () => {
    stage([], [
      catalogRow('future-unknown', 'Future Unknown', 'Use a future AI provider.', 'AI'),
      catalogRow('github', 'GitHub', 'Read and write repositories.', 'Developer'),
    ]);
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ServiceConnectionsSurface, {
          initialCategories: ['AI'],
          presentation: 'provider-choice',
          providerChoiceActionRef: 'action:update-chosen-ai-provider',
        }),
      ),
    );

    expect(screen.getByText('Future Unknown')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(sendRequestToBitfieldTarget).toHaveBeenCalledWith({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: 'action:update-chosen-ai-provider',
        include_steps: false,
        include_output: true,
        input: { provider_ref: 'future-unknown' },
      },
    }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('authorization shows only the provider chosen earlier', () => {
    stage(
      [],
      [
        catalogRow('future-unknown', 'Future Unknown', 'Use a future AI provider.', 'AI'),
        catalogRow('openai', 'OpenAI', 'Use OpenAI models.', 'AI'),
      ],
      [],
      { provider_ref: 'future-unknown' },
    );
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ServiceConnectionsSurface, {
          initialCategories: ['AI'],
          presentation: 'onboarding-authorization',
        }),
      ),
    );

    expect(screen.getByText('Future Unknown')).toBeTruthy();
    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('authorization fails closed when no provider choice exists', () => {
    stage([], [catalogRow('openai', 'OpenAI', 'Use OpenAI models.', 'AI')]);
    render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ServiceConnectionsSurface, {
          initialCategories: ['AI'],
          presentation: 'onboarding-authorization',
        }),
      ),
    );

    expect(screen.getByText('Choose an AI before authorizing it.')).toBeTruthy();
    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('provider icon registry feed renders a borderless shared brand mark', () => {
    stage(
      [],
      [catalogRow('whatsapp', 'WhatsApp', 'Send messages.', 'Comms')],
      [WHATSAPP_PROVIDER_ICON],
    );
    const { container } = mount();
    const mark = container.querySelector<HTMLElement>('[data-provider-mark="whatsapp"]');
    expect(mark).toBeTruthy();
    expect(mark?.getAttribute('data-provider-icon-id')).toBe('logos:whatsapp-icon');
    expect(mark?.getAttribute('data-provider-mark-kind')).toBe('brand');
    expect(mark?.querySelector('[data-provider-mark-image]')).toBeTruthy();
    expect(mark?.classList.contains('border-0')).toBe(true);
    expect(mark?.classList.contains('border')).toBe(false);
    expect(mark?.style.borderWidth).toBe('0px');
    expect(mark?.style.backgroundColor).toBe('transparent');
  });

  it('dense: eight vendors + one connected → connected group + Available group, dense grid', () => {
    stage([feedRow()], DENSE_CATALOG);
    const { container } = mount();
    // Connected group surfaces the live Alpaca instance with quiet management.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy();
    expect(screen.getByText('Alpaca')).toBeTruthy();
    // "Available" group label only appears once a connected group exists.
    expect(screen.getByText('Available')).toBeTruthy();
    // The remaining seven catalog vendors render as available tiles.
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('HubSpot')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Connect' }).length).toBeGreaterThanOrEqual(5);
    expectNoBannedVocab(container.textContent);
  });

  it('connected: a single live connection renders the connected affordances', () => {
    stage([feedRow()], [catalogRow('alpaca', 'Alpaca', 'Trade stocks.', 'Trading')]);
    mount();
    expect(screen.getByText('Alpaca')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy();
    // No bare "Connect" — the only instance is already connected.
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('error: a retryable failure (canRetry) → the tile offers Retry, not Connect', () => {
    stage(
      [feedRow({ statusRef: 'connection-status:error', status: 'error', canSend: false, canRetry: true, connectedAt: null })],
      [catalogRow('alpaca', 'Alpaca', 'Trade stocks.', 'Trading')],
    );
    mount();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('pending: an in-flight connection still renders its tile (status carried by the model)', () => {
    stage(
      [feedRow({ statusRef: 'connection-status:pending', status: 'pending', canSend: false, isPending: true, connectedAt: null })],
      [catalogRow('alpaca', 'Alpaca', 'Trade stocks.', 'Trading')],
    );
    mount();
    // Pending is not "connected" → it sits in the available group as a live row,
    // proven by the absence of the connected-only Disconnect affordance.
    expect(screen.getByText('Alpaca')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('search-empty: typing an unknown service offers the connect-anything path', () => {
    stage([], SPARSE_CATALOG);
    const { container } = mount();
    const search = screen.getByPlaceholderText('Search or type any service…');
    fireEvent.change(search, { target: { value: 'Acme Robotics' } });
    expect(screen.getByText('Acme Robotics')).toBeTruthy();
    expect(screen.getByText(/Not in the catalog yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect Acme Robotics/i })).toBeTruthy();
    const unknownMark = container.querySelector<HTMLElement>('[title="Acme Robotics"]');
    expect(unknownMark?.textContent).toBe('A');
  });

  it('the open-catalog promise (Add a service) is present in every populated state', () => {
    stage([feedRow()], DENSE_CATALOG);
    mount();
    expect(screen.getByRole('button', { name: /Add a service/i })).toBeTruthy();
  });
});
