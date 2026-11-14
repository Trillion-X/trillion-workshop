import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm055-creative-expression-without-evaluation',
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const id = 'm055-private-reflection';
  const overLimit = practice.values.observation.length > 2000;
  const invalid = overLimit || (attemptedSave && !practice.values.observation.trim());
  const describedBy = invalid ? 'm055-reflection-limit m055-reflection-feedback' : 'm055-reflection-limit';

  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm055-example-heading' },
      heading(content.labels.example, 'h2', 'm055-example-heading'),
      paragraph(content.examples.work.description),
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        heading(content.labels.afterward, 'h3'),
        paragraph(content.examples.keeping.description)),
      h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
        h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
        paragraph(content.teaching.sourceExcerpt),
        paragraph(`Manuscript, ${content.source.manuscriptLocator}.`),
        paragraph(content.teaching.sourceLimits))),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm055-boundary-heading' },
      heading(content.labels.boundary, 'h2', 'm055-boundary-heading'),
      paragraph(content.examples.boundary.description)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm055-practice-heading' },
      heading(content.labels.practice, 'h2', 'm055-practice-heading'),
      paragraph('The creative work does not go into this note. You can skip the reflection and leave the work private, keep it or discard it.'),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.labels.observation),
        h(Text, { as: 'p', id: 'm055-reflection-limit', variant: 'body' }, content.labels.limit),
        h(Textarea, {
          id,
          rows: 3,
          autoGrow: true,
          maxHeight: 240,
          'aria-invalid': invalid ? 'true' : undefined,
          'aria-describedby': describedBy,
          value: practice.values.observation,
          disabled,
          onChange: event => practice.setValue('observation', event.target.value),
        })),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved reflection.') : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => {
          setAttemptedSave(true);
          return practice.save();
        },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm055-reflection-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
