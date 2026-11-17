import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../../screen-look/show/anatomy/racket-materials.mjs';
import { CASE_IDS, INITIAL_CASE, evidenceScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['observation', 'alternative', 'result', 'step'];
const cases = new Map(content.teaching.cases.map(row => [row.id, row]));

function Lesson({ surfaceInput, host }) {
  const [caseId, setCaseId] = useState(INITIAL_CASE);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm025-capability-practice',
  });
  const selected = cases.get(caseId);
  const figure = useMemo(() => evidenceScene({ caseId, label: content.labels.exampleFigure }), [caseId]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const updateCase = id => {
    if (practice.locked) return;
    practice.markEdited();
    setCaseId(id);
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.workedExample),
      paragraph(content.labels.exampleText),
      h(AnatomyFigure, {
        figure,
        label: content.labels.exampleFigure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: figure.viewport,
        className: 'anatomy-figure--contained',
      })),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.evidence),
      paragraph(content.labels.evidencePrompt),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.evidence },
        ...CASE_IDS.map(id => h(Button, {
          key: id,
          variant: id === caseId ? 'primary' : 'secondary',
          'aria-pressed': id === caseId,
          disabled: practice.loading || practice.locked,
          onClick: () => updateCase(id),
        }, cases.get(id).label))),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, selected.label),
        paragraph(selected.evidence)),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.account),
        paragraph(selected.account),
        paragraph(selected.test)),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.alternatives),
        paragraph(selected.contrary))),

    h(Container, { gap: 'sm' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.trigger),
      paragraph(content.labels.triggerText)),

    h(Container, { gap: 'sm' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.practice),
      paragraph(content.labels.practiceText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.write),
      ...fields.map(key => {
        const id = `m025-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 4,
            autoGrow: true,
            maxHeight: 240,
            maxLength: 2000,
            required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm025-practice-feedback' : undefined,
            value: practice.values[key],
            disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? 'Saving reflection' : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm025-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
