// @vitest-environment jsdom
// Proof for C3: the keyword-vs-"Ask AI to curate" mode selector renders when a query is present and
// routes the REAL typed query (not the mode id) to its onSelectMode handler. This guards the L062 bug
// where SearchModeRow was imported but never rendered (tree-shaken out), so the AI-curation entrypoint
// was unreachable even though the C4 panel existed.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchModeRow, SEARCH_MODES } from './SearchModeRow';

afterEach(() => cleanup());

describe('SearchModeRow (C3 keyword-vs-AI entrypoint)', () => {
  it('exposes both a keyword mode and an Ask-AI curate mode as DATA', () => {
    expect(SEARCH_MODES.some((m) => m.id === 'keyword')).toBe(true);
    expect(SEARCH_MODES.some((m) => m.id === 'ask_ai')).toBe(true);
  });

  it('renders both modes bound to the typed query', () => {
    render(<SearchModeRow modes={SEARCH_MODES} query="checkout flow" onSelectMode={vi.fn()} />);
    expect(screen.getByText('Search "checkout flow"')).toBeTruthy();
    expect(screen.getByText('Ask AI for "checkout flow"')).toBeTruthy();
  });

  it('routes the REAL query (not the mode id) when Ask-AI is chosen', () => {
    const onSelectMode = vi.fn();
    render(<SearchModeRow modes={SEARCH_MODES} query="checkout flow" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText('Ask AI for "checkout flow"'));
    expect(onSelectMode).toHaveBeenCalledWith('ask_ai', 'checkout flow');
  });

  it('routes the keyword mode with the query too', () => {
    const onSelectMode = vi.fn();
    render(<SearchModeRow modes={SEARCH_MODES} query="dark mode" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText('Search "dark mode"'));
    expect(onSelectMode).toHaveBeenCalledWith('keyword', 'dark mode');
  });

  it('renders nothing when there are no modes (sparse)', () => {
    const { container } = render(<SearchModeRow modes={[]} query="x" onSelectMode={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
