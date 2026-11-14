import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, NamedIcon, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/racket-materials.mjs';
import { readerScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const appearanceCss = RACKET_MATERIAL_CSS;
const choiceFor = id => content.approaches.find(row => row.id === id) ?? content.approaches[0];

function Lesson({ surfaceInput, host }) {
  const [approachId, setApproachId] = useState(content.approaches[0].id);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm036-gaze-stabilization',
    onRestore: record => {
      try {
        const transfer = typeof record.transfer === 'string' ? JSON.parse(record.transfer) : record.transfer;
        if (transfer && typeof transfer === 'object' && !Array.isArray(transfer)) {
          setApproachId(choiceFor(transfer.approachId).id);
        }
      } catch { /* Keep the safe default when older or malformed transfer data is present. */ }
    },
  });
  const figureLabel = approachId === 'gaze'
    ? `${content.labels.figure}. ${content.labels.targetLabel}: ${content.labels.targetText}.`
    : content.labels.figure;
  const figure = useMemo(() => readerScene({
    label: figureLabel,
    manualTarget: approachId === 'gaze',
  }), [approachId, figureLabel]);
  const selected = choiceFor(approachId);
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const setApproach = id => {
    if (disabled) return;
    practice.markEdited();
    setApproachId(id);
  };
  const save = () => { setAttemptedSave(true); return practice.save({ transfer: JSON.stringify({ approachId }) }); };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm036-approach-heading' },
      heading(content.labels.comparison, 'h2', 'm036-approach-heading'),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.comparison },
        ...content.approaches.map(option => h(Button, {
          key: option.id, variant: approachId === option.id ? 'primary' : 'secondary',
          'aria-pressed': approachId === option.id, disabled,
          onClick: () => setApproach(option.id),
        }, option.label))),
      h(Container, { gap: 'sm' },
        h(AnatomyFigure, {
          figure, label: figureLabel, appearanceCss,
          viewport: figure.viewport, className: 'anatomy-figure--contained',
        }),
        h(Container, { gap: 'sm', 'aria-labelledby': 'm036-windows-heading' },
          heading(content.labels.windows, 'h3', 'm036-windows-heading'),
          approachId === 'environment'
            ? paragraph(content.labels.windowsClosed)
            : h(Container, { layout: 'grid', gridColumns: 3, gap: 'sm', role: 'list', 'aria-label': content.labels.windows },
                ...content.windows.map(window => h(Container, {
                  key: window.id, as: 'article', border: 'all', padding: 'md', gap: 'sm', role: 'listitem',
                  'aria-label': `${window.name}: ${window.detail}`,
                },
                  h(NamedIcon, { name: window.icon, size: 'xl', color: 'muted', 'aria-hidden': true }),
                  h(Text, { as: 'h3', variant: 'heading-md' }, window.name),
                  paragraph(window.detail))),
              ),
        ),
        h(Text, { as: 'p', role: 'status', 'aria-live': 'polite', 'aria-label': selected.label }, content.labels[selected.sceneLabel])),
      ),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm036-suitable-heading' },
      heading(content.labels.suitable, 'h2', 'm036-suitable-heading'),
      paragraph('Use the gaze option only when it feels comfortable and you can remain safely stationary. It is optional.'),
      heading(content.labels.stop, 'h3'),
      paragraph('Skip it when you need broad awareness, such as crossing a road. Stop if your eyes feel strained. Closing unnecessary windows may address the distraction directly.')),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm036-practice-heading' },
      heading(content.labels.practice, 'h2', 'm036-practice-heading'),
      paragraph('If useful, compare the actual task under its conditions. Keep how focused you felt separate from the work result you can inspect.'),
      ...fields.map(key => {
        const id = `m036-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm036-practice-feedback' : undefined,
            value: practice.values[key], disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved notes.') : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm036-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
