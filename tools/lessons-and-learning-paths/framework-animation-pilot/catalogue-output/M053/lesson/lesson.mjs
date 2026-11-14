import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { sceneFor } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [lensId, setLensId] = useState('whole');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm053-ecosystem-worth-reflection',
  });
  const lens = content.lenses.find(row => row.id === lensId) ?? content.lenses[0];
  const figure = useMemo(() => sceneFor(lens.id), [lens.id]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const choices = h(Container, {
    layout: 'horizontal',
    wrap: 'wrap',
    gap: 'sm',
    role: 'group',
    'aria-label': content.labels.focus,
  }, ...content.lenses.map(item => h(Button, {
    key: item.id,
    variant: lens.id === item.id ? 'primary' : 'secondary',
    'aria-pressed': lens.id === item.id,
    onClick: () => setLensId(item.id),
  }, item.label)));
  const setNote = value => {
    practice.setValue('result', value);
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm053-focus-heading' },
      heading(content.labels.focus, 'h2', 'm053-focus-heading'),
      paragraph(content.labels.focusPrompt),
      choices,
      h(AnatomyFigure, {
        figure,
        label: lens.figureLabel,
        viewport: figure.viewport,
        className: 'anatomy-figure--contained',
      }),
      h(Container, { gap: 'sm', 'aria-live': 'polite', 'aria-atomic': true },
        paragraph(lens.message),
        paragraph(content.teaching.shadeExample),
        paragraph(content.teaching.engineeringComparison))),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm053-transfer-heading' },
      heading(content.labels.transfer, 'h2', 'm053-transfer-heading'),
      paragraph(content.teaching.practiceLead),
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm053-practice-result' }, content.labels.note),
      h(Textarea, {
        id: 'm053-practice-result',
        rows: 3,
        autoGrow: true,
        maxHeight: 240,
        maxLength: 2000,
        value: practice.values.result,
        disabled: practice.locked,
        onChange: event => setNote(event.target.value),
      }),
      practice.loading ? paragraph('Loading your saved note.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => practice.save(),
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
