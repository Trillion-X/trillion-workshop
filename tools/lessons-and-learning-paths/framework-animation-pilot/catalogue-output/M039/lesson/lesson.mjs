import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const phases = ['prepare', 'perform', 'review'];
const preparationFields = ['prediction', 'observation', 'comparison'];
const reviewFields = ['result', 'revision', 'step'];
const phaseFor = value => phases.includes(value) ? value : 'prepare';
const kindFor = value => content.choices?.[value] ? value : 'other';

function Lesson({ surfaceInput, host }) {
  const [phase, setPhase] = useState('prepare');
  const [kind, setKind] = useState('other');
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm039-master-performer-protocol',
    onRestore: record => {
      try {
        const saved = typeof record.transfer === 'string' ? JSON.parse(record.transfer) : record.transfer;
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          setPhase(phaseFor(saved.phase));
          setKind(kindFor(saved.kind));
        }
      } catch { /* Keep the safe default while leaving all saved notes available. */ }
    },
  });
  const disabled = practice.loading || practice.locked;
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const changePhase = next => {
    if (disabled) return;
    practice.markEdited();
    setPhase(phaseFor(next));
  };
  const changeKind = next => {
    if (disabled) return;
    practice.markEdited();
    setKind(kindFor(next));
  };
  const field = key => {
    const id = `m039-practice-${key}`;
    const missing = attemptedSave && !practice.values[key].trim();
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, {
        id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
        'aria-invalid': missing ? 'true' : undefined,
        'aria-describedby': missing ? 'm039-practice-feedback' : undefined,
        value: practice.values[key], disabled,
        onChange: event => practice.setValue(key, event.target.value),
      }));
  };
  const phaseControls = h(Container, { gap: 'sm' },
    heading(content.labels.statusLabel, 'h2', 'm039-phase-control-heading'),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.statusLabel },
      ...phases.map(id => h(Button, {
        key: id, variant: phase === id ? 'primary' : 'secondary',
        'aria-pressed': phase === id, 'aria-controls': 'm039-phase-content', disabled,
        onClick: () => changePhase(id),
      }, content.labels[id]))));
  const kindControls = h(Container, { gap: 'sm' },
    heading(content.labels.task, 'h2', 'm039-kind-heading'),
    p(content.labels.taskHelp),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.task },
      ...Object.entries(content.choices).map(([id, choice]) => h(Button, {
        key: id, variant: kind === id ? 'primary' : 'secondary',
        'aria-pressed': kind === id, disabled,
        onClick: () => changeKind(id),
      }, choice.label))));
  const phaseBody = phase === 'prepare'
    ? h(Container, { gap: 'md' },
        heading(content.steps.prepare.label, 'h2', 'm039-active-phase-heading'), p(content.steps.prepare.description),
        h(Container, { gap: 'md' }, ...preparationFields.map(field)))
    : phase === 'perform'
      ? h(Container, { gap: 'md' },
          heading(content.steps.perform.label, 'h2', 'm039-active-phase-heading'), p(content.steps.perform.description),
          h(Container, { border: 'all', padding: 'md', gap: 'sm', 'aria-label': content.labels.perform },
            p(practice.values.prediction.trim() || content.labels.noTask),
            p(content.labels.safety)))
      : h(Container, { gap: 'md' },
          heading(content.steps.review.label, 'h2', 'm039-active-phase-heading'), p(content.steps.review.description),
          h(Container, { gap: 'md' }, ...reviewFields.map(field)),
          practice.locked ? p(content.feedback.retryPending) : null,
          h(Button, {
            variant: 'primary', work: null, disabled: practice.loading || practice.saving,
            onClick: () => { setAttemptedSave(true); return practice.save({ transfer: JSON.stringify({ phase, kind }) }); },
          }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
          practice.status ? h(Text, { as: 'p', id: 'm039-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null);
  const sourcePanel = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm039-source-heading' },
    heading(content.labels.source, 'h2', 'm039-source-heading'),
    ...Object.values(content.teaching.branches).map((words, index) => p(words, { key: index })));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    kindControls,
    phaseControls,
    h(Container, {
      as: 'section', id: 'm039-phase-content', role: 'region', 'aria-labelledby': 'm039-active-phase-heading', gap: 'md',
    }, phaseBody),
    phase === 'review' ? sourcePanel : null);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
