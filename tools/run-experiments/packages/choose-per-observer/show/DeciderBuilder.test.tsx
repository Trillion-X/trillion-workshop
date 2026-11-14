// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DeciderBuilder } from './DeciderBuilder';
import type { ScoreExpr } from '@/packages/choose-per-observer/read-data/decider-schema';

// Test isolation: RTL appends to document.body; without cleanup the DOM
// accumulates across `it` blocks and role queries find stale buttons.
afterEach(cleanup);

const ops = [
  { id: 'eq', label: 'is' },
  { id: 'contains', label: 'contains' },
];

const factPaths = [
  ['utm', 'source'],
  ['account', 'plan'],
];

it('renders the empty state as matching everyone', () => {
  render(<DeciderBuilder ops={ops} factPaths={factPaths} value={null} onChange={vi.fn()} />);

  expect(screen.getByText(/matches everyone/i)).toBeTruthy();
});

it('emits a structured node when adding a condition', () => {
  const onChange = vi.fn();
  render(<DeciderBuilder ops={ops} factPaths={factPaths} value={null} onChange={onChange} />);

  fireEvent.click(screen.getByRole('button', { name: /add condition/i }));

  expect(onChange).toHaveBeenCalledWith({
    op: 'eq',
    left: { fact_path: ['utm', 'source'] },
    right: { const: '' },
  });
});

it('nests a group inside a group', () => {
  const onChange = vi.fn();
  const value: ScoreExpr = {
    op: 'and',
    operands: [
      {
        op: 'eq',
        left: { fact_path: ['utm', 'source'] },
        right: { const: 'youtube' },
      },
    ],
  };

  render(<DeciderBuilder ops={ops} factPaths={factPaths} value={value} onChange={onChange} />);

  fireEvent.click(screen.getByRole('button', { name: /add group/i }));

  expect(onChange).toHaveBeenCalledWith({
    op: 'and',
    operands: [
      {
        op: 'eq',
        left: { fact_path: ['utm', 'source'] },
        right: { const: 'youtube' },
      },
      {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { fact_path: ['utm', 'source'] },
            right: { const: '' },
          },
        ],
      },
    ],
  });
});

it('uses op and attribute options from props', () => {
  const onChange = vi.fn();
  const customOps = [{ id: 'starts_with', label: 'starts with' }];
  const customFactPaths = [['visitor', 'country']];

  render(<DeciderBuilder ops={customOps} factPaths={customFactPaths} value={null} onChange={onChange} />);

  fireEvent.click(screen.getByRole('button', { name: /add condition/i }));

  expect(screen.queryByRole('button', { name: 'is' })).toBeNull();
  expect(onChange).toHaveBeenCalledWith({
    op: 'starts_with',
    left: { fact_path: ['visitor', 'country'] },
    right: { const: '' },
  });
});
