import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import figure from './figure.json' with { type: 'json' };

const h = React.createElement;
const fieldNames = ['pursuit', 'difficulty', 'value', 'question', 'limits', 'plan', 'actual', 'difficultyObserved', 'valueObserved', 'review'];
const freshDraft = () => Object.fromEntries(fieldNames.map(key => [key, '']));

function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return Object.fromEntries(fieldNames.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [dirty, setDirty] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm079-passion-crucible',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => { setDirty(true); practice.markEdited(); action(); };
  const setField = key => event => mark(() => setDraft(previous => ({ ...previous, [key]: event.target.value })));
  const save = async () => {
    practice.setValue('result', JSON.stringify(draft));
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const tooLong = practice.status === content.feedback.length;
  const textarea = key => h(Textarea, {
    label: content.labels[key], rows: 3, autoGrow: true, maxHeight: 220,
    value: draft[key], disabled,
    'aria-invalid': tooLong ? true : undefined,
    'aria-describedby': tooLong ? 'm079-practice-length-error' : undefined,
    onChange: setField(key),
  });
  const input = key => h(Input, { type: 'text', label: content.labels[key], value: draft[key], disabled, onChange: setField(key) });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm079-example-heading' },
      heading(content.labels.example, 'h2', 'm079-example-heading'),
      h(AnatomyFigure, { figure, label: content.labels.figure }),
      para(content.example.body),
      h(Container, { border: 'all', padding: 'md', gap: 'xs' },
        heading(content.comparison.title, 'h3'), para(content.comparison.body)),
      para(content.source.boundary), para(content.connections)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm079-practice-heading' },
      h(Container, { gap: 'xs' }, heading(content.labels.practice, 'h2', 'm079-practice-heading'),
        para('Keep your intended plan separate from what you actually do. Before the trial, fill the planning fields. Afterward, return to record what happened and what you noticed. “Not yet done” and partial saves are fine.')),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm079-plan-heading' },
        heading('Before the trial', 'h3', 'm079-plan-heading'),
        input('pursuit'), textarea('difficulty'), textarea('value'), textarea('question'), textarea('limits'), textarea('plan')),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm079-observation-heading' },
        heading('After the trial', 'h3', 'm079-observation-heading'),
        textarea('actual'), textarea('difficultyObserved'), textarea('valueObserved'), textarea('review')),
      para(content.labels.private),
      h(Button, { variant: 'primary', errorLabel: content.labels.retry, work: dirty || tooLong ? null : undefined,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      tooLong ? para(practice.status, { id: 'm079-practice-length-error', role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      para(content.source.manuscript), para(content.labels.sourceHint), para(content.source.attribution)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
