// packages/ask-questions-sort-answers-follow-up/show/FillSurface.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FillSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/FillSurface';
import {
  indexCapabilities,
  type QuestionSequence,
  type QuestionTypeCapability,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor';

const CAPS: QuestionTypeCapability[] = [
  { questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', validate: { rules: { required: false, min: 1, max: 5 } } },
];
const REG = indexCapabilities(CAPS);

const SEQ: QuestionSequence = {
  formId: 'intake',
  title: 'Player Intake',
  questions: [
    { questionId: 'q-name', questionTypeId: 'text', label: 'Your name', required: true, validation: { required: true } },
    { questionId: 'q-rate', questionTypeId: 'rating', label: 'Rate us' },
  ],
};

afterEach(cleanup);

describe('FillSurface — render-state matrix', () => {
  it('empty: no questions', () => {
    render(<FillSurface sequence={{ formId: 'f', title: 'T', questions: [] }} registry={REG} />);
    expect(screen.getByText('No questions yet')).toBeTruthy();
  });

  it('loading: shows skeleton, no submit', () => {
    render(<FillSurface sequence={SEQ} registry={REG} loading />);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('error: shows the message', () => {
    render(<FillSurface sequence={SEQ} registry={REG} errorMessage="Could not reach the server" />);
    expect(screen.getByText('Could not reach the server')).toBeTruthy();
  });

  it('submitted without a result: shows the plain saved-confirmation', () => {
    render(<FillSurface sequence={SEQ} registry={REG} submitted />);
    expect(screen.getByText(/your answers were saved/i)).toBeTruthy();
    expect(screen.getByText(/we'll be in touch/i)).toBeTruthy();
  });

  it('submitted WITH a result: shows the respondent their humanised verdict + score', () => {
    render(<FillSurface sequence={SEQ} registry={REG} submitted result={{ segmentId: 'promising-domain-found', score: 42 }} />);
    // verdict key humanised for display, no closed enum
    expect(screen.getByText('Promising Domain Found')).toBeTruthy();
    expect(screen.getByText(/score 42/i)).toBeTruthy();
    expect(screen.getByText(/where your answers point/i)).toBeTruthy();
    // the generic "we'll be in touch" is replaced when a verdict exists
    expect(screen.queryByText(/we'll be in touch/i)).toBeNull();
  });

  it('submitted WITH DATA-supplied copy: shows the title, meaning + next step', () => {
    render(
      <FillSurface
        sequence={SEQ}
        registry={REG}
        submitted
        result={{
          segmentId: 'strong-passion-domain',
          score: 54,
          title: 'A strong passion domain',
          meaning: 'Your value, skill, and drive all point the same way.',
          nextStep: 'Schedule it weekly and protect the time.',
        }}
      />,
    );
    // DATA title overrides the humanised key
    expect(screen.getByText('A strong passion domain')).toBeTruthy();
    expect(screen.queryByText('Strong Passion Domain')).toBeNull();
    expect(screen.getByText(/point the same way/i)).toBeTruthy();
    expect(screen.getByText(/your next step/i)).toBeTruthy();
    expect(screen.getByText(/protect the time/i)).toBeTruthy();
  });

  it('questions: renders each label + a submit button', () => {
    render(<FillSurface sequence={SEQ} registry={REG} />);
    expect(screen.getByText('Player Intake')).toBeTruthy();
    expect(screen.getByText('Your name')).toBeTruthy();
    expect(screen.getByText('Rate us')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
  });
});

describe('FillSurface — submit gating', () => {
  it('blocks submit while a required answer is empty, and reveals the error', () => {
    const onSubmit = vi.fn();
    render(<FillSurface sequence={SEQ} registry={REG} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('This question is required')).toBeTruthy();
  });

  it('submits coerced answers once the required answer is provided', () => {
    const onSubmit = vi.fn();
    render(<FillSurface sequence={SEQ} registry={REG} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Bri' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ 'q-name': 'Bri', 'q-rate': undefined });
  });

  it('renders one prompt at a time, retains prior answers, and submits only at the final prompt', () => {
    const onSubmit = vi.fn();
    const sequence: QuestionSequence = {
      ...SEQ,
      presentation: {
        mode: 'one-prompt-at-a-time',
        backLabel: 'Previous',
        nextLabel: 'Next setting',
        submitLabel: 'Save settings',
      },
    };
    render(<FillSurface sequence={sequence} registry={REG} onSubmit={onSubmit} />);

    expect(screen.getByText('Your name')).toBeTruthy();
    expect(screen.queryByText('Rate us')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next setting' }));
    expect(screen.getByText('This question is required')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Bri' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next setting' }));
    expect(screen.queryByText('Your name')).toBeNull();
    expect(screen.getByText('Rate us')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Bri');
    fireEvent.click(screen.getByRole('button', { name: 'Next setting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSubmit).toHaveBeenCalledWith({ 'q-name': 'Bri', 'q-rate': undefined });
  });
});

describe('FillSurface — DATA-driven suggestion chips (prefill only, never submit)', () => {
  const SEQ_WITH_BINDING: QuestionSequence = {
    formId: 'suggestions',
    title: 'Suggested',
    questions: [
      {
        questionId: 'q-obj',
        questionTypeId: 'text',
        label: 'Objective',
        required: true,
        validation: { required: true },
        suggestion_source: {
          input_name: 'objective-suggestions',
          label_path: ['title'],
          value_path: ['title'],
          evidence_ref_path: ['id'],
        },
      },
    ],
  };
  const FEEDS = {
    'objective-suggestions': [
      { id: 'r1', title: 'Ship the launch page' },
      { id: 'r2', title: 'Fix onboarding drop-off' },
    ],
  };

  it('renders chips only when the bound feed has current rows', () => {
    render(<FillSurface sequence={SEQ_WITH_BINDING} registry={REG} suggestionFeeds={FEEDS} />);
    expect(screen.getByRole('button', { name: 'Suggest: Ship the launch page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suggest: Fix onboarding drop-off' })).toBeTruthy();
  });

  it('a chip click prefills the EDITABLE input only — it never submits', () => {
    const onSubmit = vi.fn();
    render(
      <FillSurface sequence={SEQ_WITH_BINDING} registry={REG} suggestionFeeds={FEEDS} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suggest: Ship the launch page' }));
    // prefill landed in the editable input (still editable: change it)
    expect((screen.getByLabelText('Objective') as HTMLInputElement).value).toBe('Ship the launch page');
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the launch page TODAY' } });
    expect((screen.getByLabelText('Objective') as HTMLInputElement).value).toBe('Ship the launch page TODAY');
    // a chip is type=button: it must not have submitted
    expect(onSubmit).not.toHaveBeenCalled();
    // the user can still submit the edited draft explicitly
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ 'q-obj': 'Ship the launch page TODAY' });
  });

  it('empty / absent / unauthorized feed renders NO chips and NO fallback constants', () => {
    for (const feeds of [undefined, {}, { 'objective-suggestions': [] }, { 'objective-suggestions': { stale: true } }]) {
      cleanup();
      render(<FillSurface sequence={SEQ_WITH_BINDING} registry={REG} suggestionFeeds={feeds} />);
      expect(screen.queryByRole('button', { name: /Suggest:/ })).toBeNull();
      // the retired Q3 constants can never reappear as fallback chips
      expect(screen.queryByText('Show results here')).toBeNull();
      expect(screen.queryByText('Email me')).toBeNull();
      expect(screen.queryByText('Ask before updates')).toBeNull();
      // the input remains freely typeable
      fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'my own words' } });
      expect((screen.getByLabelText('Objective') as HTMLInputElement).value).toBe('my own words');
    }
  });

  it('a capability-derived question is free text whose suggestions come only from capability rows', () => {
    const capabilitySeq: QuestionSequence = {
      formId: 'routes',
      title: 'Routes',
      questions: [{
        questionId: 'q-route',
        questionTypeId: 'text',
        label: 'Update route',
        required: true,
        validation: { required: true },
        suggestion_source: {
          input_name: 'update-routes',
          label_path: ['serviceName'],
          value_path: ['serviceName'],
          where: [{ path: ['can_send'], equals: true }],
        },
      }],
    };
    const capabilityFeeds = {
      'update-routes': [
        { serviceName: 'Email', can_send: true },
        { serviceName: 'Slack', can_send: false }, // cannot send → filtered out
      ],
    };
    const onSubmit = vi.fn();
    render(
      <FillSurface sequence={capabilitySeq} registry={REG} suggestionFeeds={capabilityFeeds} onSubmit={onSubmit} />,
    );
    expect(screen.getByRole('button', { name: 'Suggest: Email' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suggest: Slack' })).toBeNull();
    // free text answer without touching any chip
    fireEvent.change(screen.getByLabelText('Update route'), { target: { value: 'carrier pigeon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith({ 'q-route': 'carrier pigeon' });
  });
});
