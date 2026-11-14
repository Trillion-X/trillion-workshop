import React from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const fields = Object.keys(content.practice);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm062-early-life-exploration',
  });
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const noteField = key => {
    const inputId = `m062-practice-${key}`;
    const errorId = `${inputId}-length-error`;
    const tooLong = practice.values[key].length > 2000;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: inputId }, content.prompts[key]),
      h(Textarea, {
        id: inputId, rows: 3, autoGrow: true, maxHeight: 240,
        value: practice.values[key], disabled: practice.locked,
        'aria-invalid': tooLong,
        'aria-describedby': tooLong ? errorId : undefined,
        onChange: event => practice.setValue(key, event.target.value),
      }),
      tooLong ? paragraph(content.feedback.length, { id: errorId, role: 'alert' }) : null);
  };
  const oversized = fields.some(key => practice.values[key].length > 2000);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm062-comparison-heading' },
      heading(content.labels.comparison, 'h2', 'm062-comparison-heading'),
      ...fields.map(noteField)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm062-limits-heading' },
      heading(content.limits.heading, 'h2', 'm062-limits-heading'),
      paragraph(content.limits.body)),
    h(Container, { as: 'section', gap: 'md', 'aria-label': 'Private notes' },
      paragraph(content.limits.privacy),
      practice.loading ? paragraph('Loading saved notes.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => practice.save(),
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !(oversized && practice.status === content.feedback.length)
        ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
