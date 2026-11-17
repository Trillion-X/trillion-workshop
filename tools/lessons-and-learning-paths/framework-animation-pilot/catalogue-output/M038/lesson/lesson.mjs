import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { workPosition } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [stationId, setStationId] = useState(content.stations[0].id);
  const [signalId, setSignalId] = useState(content.signals[0].id);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm038-postural-activation',
  });
  const disabled = practice.loading || practice.locked;
  const station = content.stations.find(item => item.id === stationId) ?? content.stations[0];
  const signal = content.signals.find(item => item.id === signalId) ?? content.signals[0];
  const figure = useMemo(() => workPosition({ station: station.id, label: station.sceneLabel }), [station.id]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const updateChoice = action => {
    if (disabled) return;
    practice.markEdited();
    action();
  };
  const choiceGroup = (label, choices, current, onChoose) => h(Container, {
    layout: 'horizontal',
    wrap: 'wrap',
    gap: 'sm',
    role: 'group',
    'aria-label': label,
  }, ...choices.map(item => h(Button, {
    key: item.id,
    variant: current === item.id ? 'primary' : 'secondary',
    'aria-pressed': current === item.id,
    disabled,
    onClick: () => updateChoice(() => onChoose(item.id)),
  }, item.label)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm038-station-heading' },
      heading(content.labels.station, 'h2', 'm038-station-heading'),
      paragraph(content.labels.stationPrompt),
      choiceGroup(content.labels.station, content.stations, station.id, setStationId),
      h(AnatomyFigure, {
        figure,
        label: station.sceneLabel,
        viewport: figure.viewport,
        className: 'anatomy-figure--contained',
      })),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm038-signals-heading' },
      heading(content.labels.signals, 'h2', 'm038-signals-heading'),
      paragraph(content.labels.signalPrompt),
      choiceGroup(content.labels.signals, content.signals, signal.id, setSignalId),
      h(Container, { as: 'article', border: 'all', padding: 'md', gap: 'sm', 'aria-live': 'polite', 'aria-atomic': true },
        heading(signal.focus, 'h3'),
        paragraph(signal.first),
        h(Container, { gap: 'md' },
          h(Container, { gap: 'xs' }, heading(content.labels.comfort, 'h3'), paragraph(signal.observe)),
          h(Container, { gap: 'xs' }, heading(content.labels.task, 'h3'), paragraph(signal.change))))),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm038-source-heading' },
      heading(content.labels.source, 'h2', 'm038-source-heading'),
      paragraph('Try a light adjustment only if it feels comfortable. If discomfort increases or the task is not supported, change the arrangement or stop using the cue. Equipment or the task setup may matter more than reminding yourself to change position.')),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm038-practice-heading' },
      heading(content.labels.practice, 'h2', 'm038-practice-heading'),
      ...fields.map(key => {
        const id = `m038-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 3,
            autoGrow: true,
            maxHeight: 240,
            maxLength: 2000,
            required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm038-practice-feedback' : undefined,
            value: practice.values[key],
            disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? paragraph('Loading your saved notes.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm038-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
