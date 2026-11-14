import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/racket-materials.mjs';
import { arrangementScene, ARRANGEMENTS, INITIAL_ARRANGEMENT, recallScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'step'];
const optionalMemoryFields = ['revision', 'transfer'];
const experienceIds = content.examples.map(item => item.id);
const arrangements = new Map([
  ['familiar', content.labels.familiar],
  ['question-check', content.labels.questionCheck],
]);

function Lesson({ surfaceInput, host }) {
  const [experience, setExperience] = useState(experienceIds[0]);
  const [arrangement, setArrangement] = useState(INITIAL_ARRANGEMENT);
  const [memories, setMemories] = useState({ revision: '', transfer: '' });
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm023-flow-practice',
    onRestore: record => setMemories(Object.fromEntries(optionalMemoryFields.map(key => [key, record[key] ?? '']))),
  });

  const selectedExperience = content.examples.find(item => item.id === experience);
  const recallFigure = useMemo(() => recallScene({ experience, label: content.labels.sceneFigure }), [experience]);
  const arrangementFigure = useMemo(() => arrangementScene({ arrangement, label: content.labels.sceneFigure }), [arrangement]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const save = () => practice.save({
    revision: memories.revision,
    transfer: memories.transfer,
  });

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
          onClick: () => update(() => setExperience(item.id)),
        }, item.title))),
      h(AnatomyFigure, {
        figure: recallFigure,
        label: content.labels.sceneFigure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: recallFigure.viewport,
        className: 'anatomy-figure--contained',
      }),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, selectedExperience.title),
        paragraph(selectedExperience.description))),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.pattern),
      paragraph(content.labels.patternText),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.arrangements },
        ...ARRANGEMENTS.map(id => h(Button, {
          key: id,
          variant: arrangement === id ? 'primary' : 'secondary',
          'aria-pressed': arrangement === id,
          disabled: practice.loading || practice.locked,
          onClick: () => update(() => setArrangement(id)),
        }, arrangements.get(id)))),
      h(AnatomyFigure, {
        figure: arrangementFigure,
        label: content.labels.sceneFigure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: arrangementFigure.viewport,
        className: 'anatomy-figure--contained',
      }),
      paragraph(arrangement === 'familiar' ? content.labels.sceneFamiliar : content.labels.sceneQuestionCheck)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.comparison),
      paragraph(content.labels.comparisonText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.music),
      paragraph(content.labels.musicText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.outcomes),
      paragraph(content.labels.outcomesText)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.practice),
      ...fields.map(key => {
        const id = `m023-practice-${key}`;
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
            'aria-describedby': attemptedSave && !practice.values[key].trim() ? 'm023-practice-feedback' : undefined,
            value: practice.values[key],
            disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      ...optionalMemoryFields.map((key, index) => {
        const id = `m023-practice-${key}`;
        const label = index === 0 ? content.labels.memoryFour : content.labels.memoryFive;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
          h(Textarea, {
            id,
            rows: 4,
            maxLength: 2000,
            value: memories[key],
            disabled: practice.loading || practice.locked,
            onChange: event => update(() => setMemories(current => ({ ...current, [key]: event.target.value }))),
          }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm023-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null,
      paragraph(content.feedback.directAction)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
