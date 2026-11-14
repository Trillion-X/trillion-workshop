import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { frameFor } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [frameId, setFrameId] = useState('usual');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm054-unconditional-action-practice',
  });
  const frame = frameFor(frameId);
  const resultTooLong = practice.values.result.length > 2000;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const frameChoices = h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
    'aria-label': content.labels.frame,
  }, ...content.example.frames.map(item => h(Button, {
    key: item.id,
    variant: frameId === item.id ? 'primary' : 'secondary',
    'aria-pressed': frameId === item.id,
    onClick: () => setFrameId(item.id),
  }, item.label)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm054-example-heading' },
      heading(content.labels.example, 'h2', 'm054-example-heading'),
      paragraph(content.example.activity),
      frameChoices,
      h(Container, { gap: 'sm', 'aria-live': 'polite', 'aria-atomic': true },
        paragraph(frame.message),
        paragraph(frame.question)),
      h(Container, { gap: 'sm' },
        paragraph(content.example.standard))),

    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm054-limits-heading' },
      heading(content.limits.heading, 'h2', 'm054-limits-heading'),
      paragraph(content.limits.body),
      paragraph(content.limits.comparison)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm054-transfer-heading' },
      heading(content.labels.transfer, 'h2', 'm054-transfer-heading'),
      paragraph('Choose a low-stakes activity you can safely do. Keep commitments and real task standards in view.'),
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm054-practice-result' }, content.labels.note),
      h(Textarea, {
        id: 'm054-practice-result', rows: 3, autoGrow: true, maxHeight: 240,
        value: practice.values.result, disabled: practice.locked,
        'aria-invalid': resultTooLong,
        'aria-describedby': resultTooLong ? 'm054-practice-length-error' : undefined,
        onChange: event => practice.setValue('result', event.target.value),
      }),
      resultTooLong ? paragraph(content.feedback.length, { id: 'm054-practice-length-error', role: 'alert' }) : null,
      paragraph('Your note stays private in this practice. You can leave it blank and leave the lesson.'),
      practice.loading ? paragraph('Loading your saved note.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => practice.save(),
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !(resultTooLong && practice.status === content.feedback.length)
        ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
