import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [example, setExample] = useState(() => ({ ...content.example }));
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: Object.keys(content.practice),
    messages: content.feedback,
    requestPrefix: 'm103-context-shifting',
  });
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const exampleField = key => {
    const inputId = `m103-example-${key}`;
    return h(Container, { key, gap: 'xs', width: 'full' },
      h(Text, { as: 'label', variant: 'body', htmlFor: inputId }, content.labels[key]),
      h(Textarea, {
        id: inputId,
        rows: key === 'shifted' || key === 'boundary' ? 3 : 2,
        autoGrow: true,
        maxHeight: 240,
        value: example[key],
        onChange: event => setExample(current => ({ ...current, [key]: event.target.value })),
      }));
  };
  const practiceId = 'm103-practice-result';
  const errorId = 'm103-practice-result-length-error';
  const oversized = practice.values.result.length > 2000;
  const hasDraft = practice.values.result.trim().length > 0;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm103-example-heading' },
      heading(content.labels.example, 'h2', 'm103-example-heading'),
      h(Container, { layout: 'responsive-split', gap: 'md' }, exampleField('question'), exampleField('current')),
      h(Container, { layout: 'responsive-split', gap: 'md' }, exampleField('shifted'), exampleField('visible')),
      exampleField('candidate'),
      paragraph(content.example.boundary),
      paragraph('These example fields are editable for comparison. They are not saved to private practice.')),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm103-practice-heading' },
      h(Container, { gap: 'sm' },
        heading(content.labels.practice, 'h2', 'm103-practice-heading'),
        paragraph(content.prompts.practice)),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: practiceId }, content.labels.attempt),
        h(Textarea, {
          id: practiceId,
          rows: 5,
          autoGrow: true,
          maxHeight: 360,
          value: practice.values.result,
          disabled: practice.locked,
          'aria-invalid': oversized,
          'aria-describedby': oversized ? errorId : undefined,
          onChange: event => practice.setValue('result', event.target.value),
        }),
        oversized ? paragraph(content.feedback.length, { id: errorId, role: 'alert' }) : null),
      paragraph('Saved drafts are private. Leave names and identifying details out unless needed.'),
      practice.loading ? paragraph('Loading your private draft.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
      !hasDraft && !practice.loading ? paragraph(content.feedback.missing, { role: 'status' }) : null,
      h(Button, {
        variant: 'primary',
        disabled: practice.loading || practice.saving || !hasDraft,
        pendingLabel: content.labels.saving,
        doneLabel: 'Draft saved',
        errorLabel: content.labels.retry,
        onClick: () => practice.save(),
      }, practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !(oversized && practice.status === content.feedback.length)
        ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      paragraph(content.source.quote),
      paragraph(content.source.locator),
      paragraph(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
