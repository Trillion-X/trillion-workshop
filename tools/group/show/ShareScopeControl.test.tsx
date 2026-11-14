// Tests for ShareScopeControl: generic item derivation + trigger render.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShareScopeControl, shareScopeItems } from './ShareScopeControl';
import { DEFAULT_SCOPE_RESOLVERS } from '../read-data/share-scope';

describe('shareScopeItems', () => {
  it('emits one item per default resolver key, Title-cased', () => {
    const items = shareScopeItems();
    expect(items).toHaveLength(Object.keys(DEFAULT_SCOPE_RESOLVERS).length);
    expect(items).toEqual([
      { value: 'board', label: 'Board' },
      { value: 'selection', label: 'Selection' },
      { value: 'section', label: 'Section' },
      { value: 'tag', label: 'Tag' },
      { value: 'type', label: 'Type' },
    ]);
  });

  it('is generic — derives items from any injected resolver map', () => {
    const items = shareScopeItems({ whole: () => [] });
    expect(items).toEqual([{ value: 'whole', label: 'Whole' }]);
  });
});

describe('ShareScopeControl', () => {
  it('renders the "Share scope" trigger', () => {
    render(<ShareScopeControl onShare={() => {}} />);
    expect(screen.getByLabelText('Share scope')).toBeTruthy();
  });
});
