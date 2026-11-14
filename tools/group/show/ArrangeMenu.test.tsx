// Tests for ArrangeMenu: generic strategy-item derivation + trigger render.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { ArrangeMenu, arrangeStrategyItems } from './ArrangeMenu';
import { ARRANGE_STRATEGIES } from './arrange-strategies';

afterEach(() => cleanup());

describe('arrangeStrategyItems', () => {
  it('derives one item per registry key with Title-cased labels', () => {
    const items = arrangeStrategyItems();
    const keys = Object.keys(ARRANGE_STRATEGIES);
    expect(items.length).toBe(keys.length);
    const byValue = new Map(items.map((it) => [it.value, it]));
    for (const key of keys) {
      const item = byValue.get(key);
      expect(item).toBeDefined();
      expect(item!.label).toBe(key.charAt(0).toUpperCase() + key.slice(1));
    }
    expect(byValue.get('grid')!.label).toBe('Grid');
  });

  it('is generic — an injected registry with a custom id yields one Title-cased item', () => {
    const items = arrangeStrategyItems({ foo: () => [] });
    expect(items.length).toBe(1);
    expect(items[0].value).toBe('foo');
    expect(items[0].label).toBe('Foo');
  });
});

describe('ArrangeMenu', () => {
  it('renders the "Arrange selection" trigger button', () => {
    const { getByRole } = render(<ArrangeMenu onArrange={() => {}} />);
    const trigger = getByRole('button', { name: 'Arrange selection' });
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain('Arrange');
  });
});
