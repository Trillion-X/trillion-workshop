//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Render-state proof fixtures for the publish-composer surface. ONE source of
// truth for both the jsdom render-state-matrix test and the offline Playwright
// screenshot harness — so the states we test are exactly the states we capture.
//
// Each fixture is a fully-resolved `PublishComposerSurfaceView` (or `null` for
// the loading state), shaped exactly as the read-data projection produces. No
// fixture contains a destination's internal execution/transport vocabulary or a
// source product name — the composer is blind to those, and so is its proof.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  PublishComposerSurfaceView,
  PublishDestinationOption,
} from '@/packages/publish-composer/read-data/read-publish-composer';

/** Build a destination option with sensible defaults; override only what a state needs. */
export function destinationFixture(
  overrides: Partial<PublishDestinationOption> & Pick<PublishDestinationOption, 'id' | 'label'>,
): PublishDestinationOption {
  return {
    detail: '',
    status: 'ready',
    statusLine: 'Ready to post',
    canPublish: true,
    disabledReason: null,
    actionId: 'action:run-publish-intent',
    metadataFields: [],
    ...overrides,
  };
}

function denseDestinations(): PublishDestinationOption[] {
  const labels = [
    'Newsletter', 'Team channel', 'Personal blog', 'Reading list', 'Community forum',
    'Announcements', 'Status page', 'Field notes', 'Release log', 'Weekly digest',
  ];
  return labels.map((label, index) => destinationFixture({
    id: `destination:${index}`,
    label,
    detail: index % 2 === 0 ? 'Connected and ready' : 'Shared with your team',
    canPublish: index % 4 !== 3,
    statusLine: index % 4 === 3 ? '' : 'Ready to post',
    disabledReason: index % 4 === 3 ? 'Reconnect this place to post to it.' : null,
  }));
}

/** Loading is the absence of a resolved surface — the surface renders its own spinner. */
export const PUBLISH_COMPOSER_LOADING: PublishComposerSurfaceView | null = null;

export const publishComposerFixtures: Record<string, PublishComposerSurfaceView> = {
  empty: {
    destinations: [],
    selectedDestinationId: '',
    blockers: [],
  },
  blocked: {
    destinations: [],
    selectedDestinationId: '',
    blockers: ['No place to post yet. Connect one to start posting.'],
  },
  sparse: {
    destinations: [destinationFixture({ id: 'destination:alpha', label: 'Newsletter', detail: 'Main list' })],
    selectedDestinationId: 'destination:alpha',
    blockers: [],
  },
  dense: (() => {
    const destinations = denseDestinations();
    return { destinations, selectedDestinationId: destinations[0].id, blockers: [] };
  })(),
  notReady: {
    destinations: [
      destinationFixture({
        id: 'destination:blocked',
        label: 'Status page',
        detail: 'Not connected',
        canPublish: false,
        statusLine: '',
        disabledReason: 'Reconnect this place to post to it.',
      }),
    ],
    selectedDestinationId: 'destination:blocked',
    blockers: [],
  },
};
