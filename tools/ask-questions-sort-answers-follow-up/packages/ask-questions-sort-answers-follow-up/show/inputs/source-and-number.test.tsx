import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EvidenceReferenceInput } from './EvidenceReferenceInput';
import { NumberInput } from './NumberInput';
import { isEvidenceReference } from '../../../../read-data/evidence-reference';

afterEach(cleanup);
const source = { kind: 'question-answer.evidence-reference', reference: { id: 'opaque', nested: [null, 1] } };

it('accepts opaque JSON references and rejects empty, cyclic, nonfinite and inherited records', () => {
  expect(isEvidenceReference(source)).toBe(true);
  for (const reference of [{}, { value: Infinity }, { value: undefined }, Object.create({ id: 'inherited' })]) {
    expect(isEvidenceReference({ ...source, reference })).toBe(false);
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(isEvidenceReference({ ...source, reference: cycle })).toBe(false);
});

it('returns a validated source and refuses malformed owner results', async () => {
  const onChange = vi.fn();
  const requestValue = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce({ id: 'unwrapped' });
  render(<EvidenceReferenceInput questionId="s" label="Source" value={null} onChange={onChange} requestValue={requestValue} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(source));
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  await screen.findByText('The source did not return a valid result.');
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('bounds deep and repeatedly shared reference graphs', () => {
  let deep: unknown = 'leaf';
  for (let i = 0; i < 10000; i++) deep = { child: deep };
  expect(isEvidenceReference({ ...source, reference: deep })).toBe(false);
  let shared: unknown = { id: 'leaf' };
  for (let i = 0; i < 40; i++) shared = { left: shared, right: shared };
  expect(isEvidenceReference({ ...source, reference: shared })).toBe(false);
});

it('discards a source returned after its question unmounts', async () => {
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const onChange = vi.fn();
  const view = render(<EvidenceReferenceInput questionId="s" label="Source" value={null} onChange={onChange} requestValue={() => pending} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  view.unmount();
  await act(async () => { complete(source); await pending; });
  expect(onChange).not.toHaveBeenCalled();
});

it('preserves decimals and an empty numeric answer instead of coercing it to zero', () => {
  const onChange = vi.fn();
  const view = render(<NumberInput questionId="n" label="Amount" value={null} onChange={onChange} />);
  const input = screen.getByRole('spinbutton');
  expect(input.getAttribute('step')).toBe('any');
  fireEvent.change(input, { target: { value: '1.25' } });
  expect(onChange).toHaveBeenLastCalledWith('1.25');
  view.rerender(<NumberInput questionId="n" label="Amount" value="1.25" onChange={onChange} />);
  fireEvent.change(input, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith('');
});
