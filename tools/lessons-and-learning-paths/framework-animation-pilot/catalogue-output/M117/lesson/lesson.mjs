import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = ['feature', 'action', 'experience', 'boundary', 'question'];
const freshDraft = () => Object.fromEntries(fields.map(key => [key, '']));
function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [missing, setMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [exampleNotice, setExampleNotice] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm117-minimum-viable-action',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => { setMissing(false); setDirty(true); setExampleNotice(false); practice.markEdited(); action(); };
  const setField = key => event => mark(() => {
    const next = { ...draft, [key]: event.target.value };
    setDraft(next);
    practice.setValue('result', JSON.stringify(next));
  });
  const loadExample = () => mark(() => {
    const next = { ...content.example.practice };
    setDraft(next);
    practice.setValue('result', JSON.stringify(next));
    setExampleNotice(true);
  });
  const tooLong = JSON.stringify(draft).length > 2000;
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved && !dirty ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const save = () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return; }
    if (tooLong) return;
    practice.setValue('result', JSON.stringify(draft));
    return practice.save().then(result => { if (result) setDirty(false); return result; });
  };
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const textarea = (key, label, id) => h(Container, { gap: 'xs' },
    h(Textarea, {
      id, label, rows: 3, autoGrow: true, maxHeight: 260, value: draft[key], disabled,
      'aria-invalid': tooLong && key === longestField ? true : undefined,
      'aria-describedby': tooLong && key === longestField ? 'm117-practice-length-error' : undefined,
      onChange: setField(key),
    }),
    tooLong && key === longestField ? para(content.feedback.length, { id: 'm117-practice-length-error', role: 'alert' }) : null);
  const example = content.example;
  const comparison = (name, action, reveals, boundary, prefix) => h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': `${prefix}-heading`,
  }, heading(name, 'h3', `${prefix}-heading`),
    h(Container, { gap: 'xs' }, heading(content.labels.action, 'h3'), para(action)),
    h(Container, { gap: 'xs' }, heading(content.labels.reveals, 'h3'), para(reveals)),
    h(Container, { gap: 'xs' }, heading(content.labels.boundary, 'h3'), para(boundary)));
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm117-example-heading' },
      heading(content.labels.example, 'h2', 'm117-example-heading'),
      para(content.labels.exampleNote),
      h(Container, { gap: 'xs' }, heading(content.labels.feature, 'h3'), para(example.feature)),
      h(Container, { layout: 'grid', gridCols: 'auto-fill-xs', gap: 'md', width: 'full' },
        comparison(content.labels.optionA, example.actionA, example.revealsA, example.boundaryA, 'm117-example-a'),
        comparison(content.labels.optionB, example.actionB, example.revealsB, example.boundaryB, 'm117-example-b')),
      para(content.labels.sourceBoundary)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm117-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm117-practice-heading'), para(content.labels.practiceIntro)),
      h(Button, { variant: 'secondary', disabled, onClick: loadExample }, content.labels.loadExample),
      exampleNotice ? para(content.labels.exampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
      textarea('feature', content.labels.featureField, 'm117-feature'),
      textarea('action', content.labels.actionField, 'm117-action'),
      textarea('experience', content.labels.experienceField, 'm117-experience'),
      textarea('boundary', content.labels.boundaryField, 'm117-boundary'),
      textarea('question', content.labels.questionField, 'm117-question'),
      para(content.labels.private),
      h(Button, {
        variant: 'primary', fullWidth: true, doneLabel: content.labels.done, work: buttonWork,
        disabled: practice.loading || practice.saving, pendingLabel: content.labels.saving,
        errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.feedback.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote), para(content.labels.sourceHint)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
