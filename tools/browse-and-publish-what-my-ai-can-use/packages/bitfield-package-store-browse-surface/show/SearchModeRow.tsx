import React from 'react';
import { Button } from '@/packages/ui/show/button';
import { Text } from '@/packages/ui/show/text';

export interface SearchMode {
  id: string;
  label: string;
  description: string;
}

export const SEARCH_MODES: SearchMode[] = [
  { id: 'keyword', label: 'Search packages', description: 'Browse by keyword' },
  { id: 'ask_ai', label: 'Ask AI to curate', description: 'Describe what you need' },
];

interface SearchModeRowProps {
  modes: SearchMode[];
  onSelectMode: (modeId: string, query?: string) => void;
  query: string;
}

export function SearchModeRow({ modes, onSelectMode, query }: SearchModeRowProps) {
  if (modes.length === 0) return null;

  return (
    <div className="grid gap-2">
      {modes.map((mode) => (
        <button
          key={mode.id}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-4 py-3 text-left transition hover:bg-[var(--glass-bg-hover)]"
          onClick={() => onSelectMode(mode.id, query)}
          type="button"
        >
          <span aria-hidden="true" className="text-lg">
            {mode.id === 'keyword' ? '🔍' : '✨'}
          </span>
          <div className="min-w-0">
            <Text variant="body" className="font-medium">
              {mode.id === 'keyword' ? `Search "${query}"` : `Ask AI for "${query}"`}
            </Text>
            <Text variant="body-xs" color="muted">
              {mode.description}
            </Text>
          </div>
        </button>
      ))}
    </div>
  );
}
