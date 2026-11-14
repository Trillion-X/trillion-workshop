import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/racket-materials.mjs';
import { contextScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'step'];
const experienceIds = content.examples.map(item => item.id);
function Lesson({ surfaceInput, host }) {
  const [experience, setExperience] = useState(experienceIds[0]);
  const [evidenceId, setEvidenceId] = useState(content.teaching.evidenceByContext[content.examples[0].id][0].id);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm024-strengths-practice',
  });

  const selectedExperience = content.examples.find(item => item.id === experience);
  const evidenceChoices = content.teaching.evidenceByContext[experience];
  const selectedEvidence = evidenceChoices.find(item => item.id === evidenceId) ?? evidenceChoices[0];
  const contextFigure = useMemo(() => contextScene({ experience, label: content.labels.sceneFigure }), [experience]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),

    h(Container, { gap: 'lg' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.experiences),
      paragraph(content.labels.experiencePrompt),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.experiences },
        ...content.examples.map(item => h(Button, {
          key: item.id,
          variant: item.id === experience ? 'primary' : 'secondary',
          'aria-pressed': item.id === experience,
          disabled: practice.loading || practice.locked,
          onClick: () => update(() => {
            setExperience(item.id);
            setEvidenceId(content.teaching.evidenceByContext[item.id][0].id);
          }),
        }, item.title))),
      h(AnatomyFigure, {
        figure: contextFigure,
        label: content.labels.sceneFigure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: contextFigure.viewport,
        className: 'anatomy-figure--contained',
      }),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, selectedExperience.title),
        paragraph(selectedExperience.description))),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.evidence),
      paragraph(content.labels.evidencePrompt),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.evidence },
        ...evidenceChoices.map(item => h(Button, {
          key: item.id,
          variant: selectedEvidence.id === item.id ? 'primary' : 'secondary',
          'aria-pressed': selectedEvidence.id === item.id,
          disabled: practice.loading || practice.locked,
          onClick: () => update(() => setEvidenceId(item.id)),
        }, item.label))),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'h3', variant: 'heading-md' }, selectedEvidence.candidate),
        paragraph(selectedEvidence.evidence),
        paragraph(`${content.labels.unproved} ${selectedEvidence.unproved}`, { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }))),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.nextTask),
      paragraph(content.labels.nextTaskText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.limits),
      paragraph(content.labels.limitsText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.practice),
      ...fields.map(key => {
        const id = `m024-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 4,
            autoGrow: true,
            maxHeight: 240,
            maxLength: 2000,
            required: true,
            'aria-invalid': attemptedSave && !practice.values[key].trim() ? 'true' : undefined,
            'aria-describedby': attemptedSave && !practice.values[key].trim() ? 'm024-practice-feedback' : undefined,
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
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm024-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null,
      paragraph(content.feedback.directAction)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
