import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The surface dispatches through sendRequestToBitfieldTarget (runtime-kit) — mock
// the transport itself, NOT a window.bitfield shim (which the component never uses).
vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: vi.fn() }));
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import mount, { MediaSearchSurface } from './mount-media-search';

const dispatchMock = sendRequestToBitfieldTarget as unknown as ReturnType<typeof vi.fn>;
const PLACEHOLDER = "Search your media — describe what you're looking for…";

// Replies are byte-encoded JSON (decodeReply does TextDecoder + JSON.parse).
const reply = (value: unknown) => ({ payload: new TextEncoder().encode(JSON.stringify(value)) });

// Route by target: the search is slot::workflow (find-similar); hydration is
// slot::find-current-items (best-effort metadata — empty is fine, titles derive
// from the address). `items` are {address, score}; the tile title is
// titleFromAddress(address) so use readable address tails.
function mockFindSimilar(items: Array<{ address: string; score: number }>, hydration: unknown[] = []) {
  dispatchMock.mockImplementation(async (req: any) => {
    if (req?.target === 'slot::workflow') return reply({ output: { result: { items } } });
    return reply({ items: hydration });
  });
}

function mockFindSimilarError(message: string) {
  dispatchMock.mockImplementation(async (req: any) => {
    if (req?.target === 'slot::workflow') throw new Error(message);
    return reply({ items: [] });
  });
}

function mockFindSimilarErrorWithFallback(message: string, hydration: unknown[]) {
  dispatchMock.mockImplementation(async (req: any) => {
    if (req?.target === 'slot::workflow') throw new Error(message);
    return reply({ items: hydration });
  });
}

const FOREHAND = 'package::media-analysis::embedding::forehand technique';
const BACKHAND = 'package::media-analysis::embedding::backhand drill';

describe('MediaSearchSurface', () => {
  beforeEach(() => mockFindSimilar([]));
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  describe('Component rendering', () => {
    it('renders the search bar and the empty (pre-query) state', () => {
      render(<MediaSearchSurface />);
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
      expect(screen.getAllByText('Search to discover media').length).toBeGreaterThan(0);
    });

    it('focuses the search bar on mount', () => {
      render(<MediaSearchSurface />);
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBe(document.activeElement);
    });

    it('dispatches action:find-similar (slot::workflow) on query input', async () => {
      mockFindSimilar([{ address: FOREHAND, score: 0.95 }]);
      render(<MediaSearchSurface indexId="media-visual" />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'forehand');
      await waitFor(() => {
        expect(dispatchMock).toHaveBeenCalledWith(
          expect.objectContaining({
            target: 'slot::workflow',
            payload: expect.objectContaining({
              definition_id: 'action:find-similar',
              input: expect.objectContaining({ index_id: 'media-visual', query_text: 'forehand' }),
            }),
          }),
        );
      });
    });
  });

  describe('Search results', () => {
    it('renders hydrated production labels and relevance %', async () => {
      mockFindSimilar([
        { address: FOREHAND, score: 0.95 },
        { address: BACKHAND, score: 0.87 },
      ], [{ content_address: FOREHAND, label: 'Federer Forehand Master Class' }]);
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'forehand');
      await waitFor(() => {
        expect(screen.getByText('Federer Forehand Master Class')).toBeTruthy();
        expect(screen.getByText('backhand drill')).toBeTruthy();
        expect(screen.getByText('relevance 95%')).toBeTruthy();
      });
    });

    it('shows the honest empty-result state when nothing matches', async () => {
      mockFindSimilar([]);
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'xyzabc123');
      await waitFor(() => {
        expect(screen.getAllByText('No media found').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Multi-select', () => {
    // Selection is a per-tile "Select" badge (not a checkbox input); clicking it
    // flips the label to "Selected" and toggles the address into the set.
    it('toggles item selection on the Select badge', async () => {
      mockFindSimilar([{ address: FOREHAND, score: 0.95 }]);
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'video');
      await waitFor(() => expect(screen.getByText('forehand technique')).toBeTruthy());

      fireEvent.click(screen.getByText('Select'));
      await waitFor(() => expect(screen.getByText('Selected')).toBeTruthy());
    });

    it('shows the bulk-select bar with the selected count', async () => {
      mockFindSimilar([{ address: FOREHAND, score: 0.95 }]);
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'video');
      await waitFor(() => expect(screen.getByText('forehand technique')).toBeTruthy());

      fireEvent.click(screen.getByText('Select'));
      await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    });
  });

  describe('default mount (runtime screen-mount entry)', () => {
    it('renders the component into el and returns a cleanup function', async () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const cleanup = mount({ el, props: { indexId: 'media-visual' } });
      expect(typeof cleanup).toBe('function');
      await waitFor(() => expect(el.querySelector('input')).toBeTruthy());
      cleanup();
      el.remove();
    });
  });

  describe('Error handling', () => {
    it('falls back to DATA-only media records when the contained workflow path is unavailable', async () => {
      mockFindSimilarErrorWithFallback(
        'mandatory process containment unavailable on linux: this platform has no held-directory input authority',
        [{
          payload: {
            kind: 'ethos-community-media-search-item',
            content_address: FOREHAND,
            label: 'Federer Forehand Master Class',
            search_text: 'forehand technique contact swing lesson',
          },
        }],
      );
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'forehand');
      await waitFor(() => expect(screen.getByText('Federer Forehand Master Class')).toBeTruthy());
      expect(screen.queryAllByText('Search failed').length).toBe(0);
    });

    it('shows the error state when the search dispatch fails', async () => {
      mockFindSimilarError('Network error');
      render(<MediaSearchSurface />);
      await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'query');
      await waitFor(() => expect(screen.getByText('Network error')).toBeTruthy());
    });

    it('clears the error when the query is cleared', async () => {
      // The error surface reuses EmptyPlaceholder, whose title === description
      // here ("Search failed"), so the string appears twice — assert on count.
      mockFindSimilarError('Search failed');
      render(<MediaSearchSurface />);
      const input = screen.getByPlaceholderText(PLACEHOLDER);
      await userEvent.type(input, 'query');
      await waitFor(() => expect(screen.getAllByText('Search failed').length).toBeGreaterThan(0));

      await userEvent.clear(input);
      await waitFor(() => expect(screen.queryAllByText('Search failed').length).toBe(0));
    });
  });
});
