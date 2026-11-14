import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The pure surface calls `submitPublication` (do-work) on Post. Mock it at that
// boundary so the show-layer test drives posted/failed states deterministically
// without touching the universal dispatch transport.
vi.mock('@/packages/publish-composer/do-work/submit-publication', () => ({
  submitPublication: vi.fn(async () => ({ ok: true })),
}));

import { submitPublication } from '@/packages/publish-composer/do-work/submit-publication';
import { PublishComposer } from '@/packages/publish-composer/show/PublishComposer';
import {
  PUBLISH_COMPOSER_LOADING,
  publishComposerFixtures,
} from '@/packages/publish-composer/show/publish-composer-fixtures';

// Vocabulary that must NEVER reach the customer's eyes. Internal execution,
// transport, and storage terms, plus the source product names the composer
// replaces. If any of these render, the translation boundary leaked (L098/L118).
const bannedVisibleTerms = [
  'process_descriptor', 'transport', 'provider_key', 'account_label', 'destination_id',
  'payload', 'fact', 'slot', 'envelope', 'address', 'eeaf', 'workflow', 'execute_definition',
  'argv', 'cas', 'artifact_ref', 'descriptor',
  'buffer', 'resend', 'craft', 'digg', 'paramount', 'later', 'ferndesk', 'elevenlabs', 'claude',
];

function expectNoBannedTerms(text: string | null | undefined): void {
  const lowered = (text ?? '').toLowerCase();
  for (const banned of bannedVisibleTerms) {
    expect(lowered).not.toContain(banned);
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('publish-composer browser surface', () => {
  // -- Render-state matrix: every state reachable from data alone renders without
  //    crashing and never leaks internal/source vocabulary. ------------------
  it('renders the loading state', () => {
    const { container } = render(<PublishComposer surface={PUBLISH_COMPOSER_LOADING} />);
    expect(container.textContent).toContain('Loading places to post');
    expectNoBannedTerms(container.textContent);
  });

  it.each(['empty', 'blocked', 'sparse', 'dense', 'notReady'])(
    'renders the %s state',
    (state) => {
      const { container } = render(<PublishComposer surface={publishComposerFixtures[state]} />);
      // The composer-first shell is present in every loaded state.
      expect(container.textContent).toContain('Write a post');
      expect(container.textContent).toContain('Post to');
      expectNoBannedTerms(container.textContent);
    },
  );

  it('shows the owner blocker message when there is no place to post', () => {
    render(<PublishComposer surface={publishComposerFixtures.blocked} />);
    expect(screen.getAllByText(/No place to post yet/i).length).toBeGreaterThan(0);
  });

  // -- Readiness: a not-ready destination carries a plain human reason and the
  //    primary action stays disabled (no silent dead button). -----------------
  it('keeps Post disabled with a human reason when the selected place is not ready', () => {
    render(<PublishComposer surface={publishComposerFixtures.notReady} />);
    const body = screen.getAllByLabelText('Publication body')[0] as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Ready to go' } });
    const post = screen.getAllByRole('button', { name: /Post/ }).find(
      (button) => (button as HTMLButtonElement).type !== 'button' || button.textContent?.includes('Post'),
    ) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    expect(screen.getAllByText(/Reconnect this place/i).length).toBeGreaterThan(0);
    expectNoBannedTerms(document.body.textContent);
  });

  // -- Posted: writing + posting a ready destination surfaces the result. -----
  it('posts a ready destination and shows the posted result', async () => {
    render(<PublishComposer surface={publishComposerFixtures.sparse} />);
    const body = screen.getAllByLabelText('Publication body')[0] as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Hello world, this is the post body.' } });

    const post = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Post') as HTMLButtonElement;
    expect(post.disabled).toBe(false);
    fireEvent.click(post);

    await waitFor(() => expect(submitPublication).toHaveBeenCalled());
    await screen.findAllByText('Posted');
    expect(screen.getAllByText('Posted to').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Newsletter').length).toBeGreaterThan(0);
    expectNoBannedTerms(document.body.textContent);

    // The composer passes only its descriptor-free intent to do-work.
    const request = vi.mocked(submitPublication).mock.calls[0][0];
    expect(request).toMatchObject({ destinationId: 'destination:alpha', actionId: 'action:run-publish-intent' });
    expect(JSON.stringify(request)).not.toContain('process_descriptor');
    expect(JSON.stringify(request)).not.toContain('transport');
  });

  // -- Failed: a rejected post surfaces a sanitized error + retry, not a crash. -
  it('shows a sanitized error with retry when posting fails', async () => {
    vi.mocked(submitPublication).mockRejectedValueOnce(new Error('Could not reach the place to post.'));
    render(<PublishComposer surface={publishComposerFixtures.sparse} />);
    const body = screen.getAllByLabelText('Publication body')[0] as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'This one will fail.' } });
    const post = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'Post') as HTMLButtonElement;
    fireEvent.click(post);

    await screen.findAllByText('Did not post');
    expect(screen.getAllByText(/Could not reach the place to post/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Try again').length).toBeGreaterThan(0);
    expectNoBannedTerms(document.body.textContent);
  });

  // -- Generic / data-driven: a renamed destination + custom statusLine render
  //    with zero panel code changes (proves no closed enum / hardcoded labels). -
  it('renders a custom-named place and owner statusLine without control-flow branches', () => {
    render(<PublishComposer surface={{
      destinations: [
        { id: 'destination:x', label: 'My Zine', detail: 'Quarterly', status: 'whatever',
          statusLine: 'Open for drafts', canPublish: true, disabledReason: null,
          actionId: 'action:run-publish-intent', metadataFields: [] },
      ],
      selectedDestinationId: 'destination:x',
      blockers: [],
    }} />);
    expect(screen.getAllByText('My Zine').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Open for drafts').length).toBeGreaterThan(0);
  });
});
