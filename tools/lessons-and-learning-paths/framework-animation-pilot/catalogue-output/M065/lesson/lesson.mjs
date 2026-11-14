import React from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm065-story-based-value-excavation',
  });
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);

  return h(Container, { as: 'main', maxWidth: '3xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm065-method-heading' },
      heading(content.labels.method, 'h2', 'm065-method-heading'),
      h(Container, { as: 'ol', gap: 'md' }, ...content.actions.map(action => h(Container, {
        key: action,
        as: 'li',
        gap: 'xs',
      }, paragraph(action)))),
      paragraph(content.teaching.distinction),
      paragraph(content.teaching.evidence),
      paragraph(content.teaching.guardrail)),

    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm065-example-heading' },
      heading('One familiar fable', 'h2', 'm065-example-heading'),
      paragraph(content.teaching.tryIt),
      paragraph(content.teaching.independentSource)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm065-reflection-heading' },
      heading(content.labels.reflection, 'h2', 'm065-reflection-heading'),
      paragraph(content.labels.reflectionPrompt),
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm065-practice-result' }, content.labels.note),
      h(Textarea, {
        id: 'm065-practice-result',
        rows: 7,
        autoGrow: true,
        maxHeight: 320,
        value: practice.values.result,
        'aria-describedby': practice.status === content.feedback.length ? 'm065-practice-length-error' : undefined,
        disabled: practice.locked,
        onChange: event => practice.setValue('result', event.target.value),
      }),
      practice.loading ? paragraph('Loading your saved reflection.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => practice.save(),
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, {
        id: practice.status === content.feedback.length ? 'm065-practice-length-error' : undefined,
        role: 'status',
        'aria-live': 'polite',
      }) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
