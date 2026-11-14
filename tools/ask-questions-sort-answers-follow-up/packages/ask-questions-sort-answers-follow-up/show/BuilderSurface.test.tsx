// packages/ask-questions-sort-answers-follow-up/show/BuilderSurface.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: vi.fn(async () => ({ ok: true })),
}));

import { BuilderSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/BuilderSurface';
import {
  indexCapabilities,
  type QuestionTypeCapability,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor';

const CAPS: QuestionTypeCapability[] = [
  { questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string', label: 'Text' },
  { questionTypeId: 'choice', inputComponentKey: 'choice', coerce: 'string', label: 'Choice' },
  { questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', label: 'Rating' },
];
const REG = indexCapabilities(CAPS);

afterEach(cleanup);

describe('BuilderSurface', () => {
  it('starts on an empty draft with Save disabled', () => {
    render(<BuilderSurface registry={REG} />);
    expect(screen.getByText('Add your first question')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save form' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Add is disabled until a label is entered', () => {
    render(<BuilderSurface registry={REG} />);
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Question label'), { target: { value: 'Your name' } });
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a question that appears in the editor AND the live preview', () => {
    render(<BuilderSurface registry={REG} />);
    fireEvent.change(screen.getByLabelText('Question label'), { target: { value: 'Your name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // editor row input shows the value; preview renders it as a label
    expect(screen.getAllByDisplayValue('Your name').length).toBeGreaterThan(0);
    expect(screen.getByText('Your name')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save form' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves the draft and calls onSaved', async () => {
    const onSaved = vi.fn();
    render(<BuilderSurface registry={REG} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Question label'), { target: { value: 'Q1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save form' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0].questions).toHaveLength(1);
  });
});
