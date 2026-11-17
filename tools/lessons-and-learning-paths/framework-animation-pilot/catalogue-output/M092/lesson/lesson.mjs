import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const blank = { event: '', observation: '', exit: '' };
const parse = value => {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
};

function Lesson({ surfaceInput, host }) {
  const [momentIndex, setMomentIndex] = useState(0);
  const [attempt, setAttempt] = useState(blank);
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.labels.feedback,
    requestPrefix: 'm092-pre-sleep-integration-review',
    onRestore: record => {
      const restored = parse(record.result);
      if (!restored) return;
      setAttempt(Object.fromEntries(Object.keys(blank).map(key => [key, typeof restored[key] === 'string' ? restored[key] : ''])));
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (value, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, value);
  const para = (value, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, value);
  const setValue = (key, value) => {
    const next = { ...attempt, [key]: value };
    setAttempt(next);
    const serialized = JSON.stringify(next);
    const over = serialized.length > 2000;
    setTooLong(over);
    practice.markEdited();
    if (!over) practice.setValue('result', serialized);
  };
  const field = (id, label, value, onChange, rows = 3) => h(Container, { gap: 'xs' },
    h(Textarea, {
      label, rows, autoGrow: true, maxHeight: 220, value, disabled,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm092-length-error' : undefined,
      onChange: event => onChange(event.target.value),
    }));
  const choices = [content.labels.end, content.labels.shorten, content.labels.move, content.labels.omit];
  const moment = content.example.moments[momentIndex];
  const save = () => practice.save();
  const isComplete = attempt.event.trim().length > 0 && attempt.exit.trim().length > 0;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening),
      para('Use this only when a short review fits comfortably. Permission to stop is part of the practice.')),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm092-example-heading' },
      heading(content.example.heading, 'h2', 'm092-example-heading'),
      para(content.example.note),
      h(Container, { gap: 'sm', 'aria-live': 'polite', 'aria-atomic': 'true' },
        h(Text, { as: 'p', variant: 'heading-md' }, moment.label),
        para(moment.detail),
        para(`${content.labels.position}: ${momentIndex + 1} of ${content.example.moments.length}`)),
      h(Container, { layout: 'responsive-split', gap: 'sm' },
        h(Button, { variant: 'secondary', disabled: momentIndex >= content.example.moments.length - 1, onClick: () => setMomentIndex(index => Math.min(index + 1, content.example.moments.length - 1)) }, content.labels.previous),
        h(Button, { variant: 'secondary', disabled: momentIndex <= 0, onClick: () => setMomentIndex(index => Math.max(index - 1, 0)) }, content.labels.next)),
      para(content.example.comparison)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm092-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm092-practice-heading'), para(content.labels.prompt)),
      field('m092-event', content.labels.event, attempt.event, value => setValue('event', value)),
      field('m092-observation', content.labels.observation, attempt.observation, value => setValue('observation', value)),
      h(Container, { as: 'fieldset', gap: 'sm' },
        h(Text, { as: 'legend', variant: 'body' }, content.labels.exit),
        h(Container, { layout: 'responsive-split', gap: 'sm' }, ...choices.map(choice => h(Button, {
          key: choice, variant: attempt.exit === choice ? 'primary' : 'secondary',
          'aria-pressed': String(attempt.exit === choice), disabled,
          onClick: () => setValue('exit', choice),
        }, choice)))),
      para(content.labels.private),
      !isComplete ? para(content.labels.missing) : null,
      tooLong ? h(Text, { as: 'p', id: 'm092-length-error', role: 'alert' }, content.labels.overlimit) : null,
      h(Button, { variant: 'primary', disabled: !isComplete || tooLong || practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? para(content.labels.feedback.retryPending) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
      para(content.source.excerpt), para(content.source.attribution), para(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
