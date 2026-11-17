import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { focusArrangement } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [materialsReady, setMaterialsReady] = useState(false);
  const [alertsPaused, setAlertsPaused] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm044-environment-design',
  });
  const disabled = practice.loading || practice.locked;
  const sceneLabel = [
    content.labels.scene,
    materialsReady ? content.labels.materialsReady : content.labels.materialsAway,
    alertsPaused ? content.labels.alertsPaused : content.labels.alertsOn,
    content.labels.reviewerNote,
  ].join('. ');
  const figure = useMemo(() => focusArrangement({
    materialsReady,
    alertsPaused,
    label: sceneLabel,
  }), [materialsReady, alertsPaused, sceneLabel]);

  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const toggle = (label, active, setActive) => h(Button, {
    variant: active ? 'primary' : 'secondary',
    'aria-pressed': active,
    disabled,
    onClick: () => {
      if (disabled) return;
      practice.markEdited();
      setActive(!active);
    },
  }, label);

  const consequence = !materialsReady
    ? 'The reviewer’s request is clear, but the draft and pen are off to the side. Getting the materials is still part of starting.'
    : alertsPaused
      ? 'The draft, pen and reviewer’s note are in reach. The phone remains available, with unrelated alerts paused. You can start the revision; check the result later.'
      : 'The draft, pen and reviewer’s note are in reach. The revision can start, while unrelated alerts remain visible on the phone.';

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm044-arrangement-heading' },
      heading(content.labels.arrangement, 'h2', 'm044-arrangement-heading'),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.arrangement },
        toggle(content.labels.materials, materialsReady, setMaterialsReady),
        toggle(content.labels.alerts, alertsPaused, setAlertsPaused)),
      h(AnatomyFigure, {
        figure,
        label: sceneLabel,
        viewport: figure.viewport,
        className: 'anatomy-figure--contained',
      }),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm044-task-heading' },
        heading(content.labels.consequence, 'h3', 'm044-task-heading'),
        h(Container, { layout: 'grid', gridColumns: 2, gap: 'sm' },
          h(Container, { as: 'article', border: 'all', padding: 'sm', gap: 'xs', 'aria-label': content.labels.task },
            h(Text, { as: 'h4', variant: 'heading-sm' }, content.labels.task),
            paragraph('Revise one paragraph by adding an example.')),
          h(Container, { as: 'article', border: 'all', padding: 'sm', gap: 'xs', 'aria-label': content.labels.feedback },
            h(Text, { as: 'h4', variant: 'heading-sm' }, content.labels.feedback),
            paragraph(content.labels.reviewerNote))),
        paragraph(materialsReady ? content.labels.materialsReady : content.labels.materialsAway, { role: 'status', 'aria-live': 'polite' }),
        paragraph(alertsPaused ? content.labels.alertsPaused : content.labels.alertsOn, { role: 'status', 'aria-live': 'polite' }),
        paragraph(consequence, { role: 'status', 'aria-live': 'polite' })),
      h(Container, { as: 'section', gap: 'xs', 'aria-labelledby': 'm044-boundary-heading' },
        heading('When the setting is not the obstacle', 'h3', 'm044-boundary-heading'),
        paragraph(content.labels.skillBoundary))),

    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm044-method-heading' },
      heading('Inspect the conditions that matter', 'h2', 'm044-method-heading'),
      paragraph(content.labels.method)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm044-practice-heading' },
      heading(content.labels.practice, 'h2', 'm044-practice-heading'),
      ...fields.map(key => {
        const id = `m044-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 2,
            autoGrow: true,
            maxHeight: 180,
            maxLength: 2000,
            required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm044-practice-feedback' : undefined,
            value: practice.values[key],
            disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? paragraph('Loading your saved note.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm044-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
