import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import figure from './figure.json' with { type: 'json' };

const h = React.createElement;
const initialRows = () => [
  { id: 'candidate-a', activity: '', actual: '', imagined: '', conditions: '', feature: '' },
  { id: 'candidate-b', activity: '', actual: '', imagined: '', conditions: '', feature: '' },
];
const freshDraft = () => ({ rows: initialRows(), plan: '', observation: '', reflection: '' });

function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || !Array.isArray(parsed.rows) || typeof parsed.plan !== 'string') return null;
    const rows = parsed.rows.filter(row => row && typeof row.id === 'string'
      && ['activity', 'actual', 'imagined', 'conditions', 'feature'].every(key => typeof row[key] === 'string')).slice(0, 3);
    if (!rows.length) return null;
    return { rows, plan: parsed.plan, observation: typeof parsed.observation === 'string' ? parsed.observation : '', reflection: typeof parsed.reflection === 'string' ? parsed.reflection : '' };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [missing, setMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm077-passion-identification',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => { setMissing(false); setDirty(true); practice.markEdited(); action(); };
  const setRoot = key => event => mark(() => setDraft(previous => ({ ...previous, [key]: event.target.value })));
  const setRow = (id, key) => event => mark(() => setDraft(previous => ({
    ...previous, rows: previous.rows.map(row => row.id === id ? { ...row, [key]: event.target.value } : row),
  })));
  const save = async () => {
    if (!draft.rows.some(row => row.activity.trim()) || !draft.plan.trim()) { setMissing(true); return; }
    practice.setValue('result', JSON.stringify(draft));
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const tooLong = practice.status === content.feedback.length;
  const textarea = (label, value, update, errorId) => h(Textarea, {
    label, rows: 3, autoGrow: true, maxHeight: 220, value, disabled,
    'aria-invalid': tooLong ? true : undefined,
    'aria-describedby': tooLong ? 'm077-practice-length-error' : undefined,
    onChange: update,
  });
  const input = (label, value, update, hint) => h(Input, { type: 'text', label, value, disabled, hint, onChange: update });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm077-example-heading' },
      heading(content.labels.example, 'h2', 'm077-example-heading'),
      h(AnatomyFigure, { figure, label: content.labels.figure }),
      para(content.example.body),
      para(content.source.boundary)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm077-practice-heading' },
      h(Container, { gap: 'xs' }, heading(content.labels.practice, 'h2', 'm077-practice-heading'),
        para('Compare more than one activity when useful. A blank actual-experience field means “not yet tried,” not “not a passion.” Keep access conditions separate from attraction.')),
      ...draft.rows.map((row, index) => h(Container, {
        key: row.id, as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': `m077-candidate-heading-${index}`,
      },
      heading(row.activity || `${content.labels.activity} ${index + 1}`, 'h3', `m077-candidate-heading-${index}`),
      input(`${content.labels.activity} ${index + 1}`, row.activity, setRow(row.id, 'activity')),
      textarea(`${content.labels.experience} ${index + 1}`, row.actual, setRow(row.id, 'actual'), `m077-length-error-${index}`),
      textarea(`${content.labels.interest} ${index + 1}`, row.imagined, setRow(row.id, 'imagined'), `m077-length-error-${index}`),
      textarea(`${content.labels.barrier} ${index + 1}`, row.conditions, setRow(row.id, 'conditions'), `m077-length-error-${index}`),
      input(`${content.labels.draw} ${index + 1}`, row.feature, setRow(row.id, 'feature'), 'Name a compelling feature, including what absorbed you, returned unprompted or kept you engaged through friction.'))),
      draft.rows.length < 3 ? h(Button, { variant: 'secondary', disabled, onClick: () => mark(() => setDraft(previous => ({
        ...previous, rows: [...previous.rows, { id: `candidate-${Date.now()}`, activity: '', actual: '', imagined: '', conditions: '', feature: '' }],
      }))) }, 'Compare one more activity') : null),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm077-next-heading' },
      heading(content.labels.next, 'h2', 'm077-next-heading'),
      para('Choose one small real experience that fits the access you have now. Write the plan before the try; record an observation only after it happens.'),
      textarea(content.labels.plan, draft.plan, setRoot('plan'), 'm077-length-error-plan'),
      textarea(content.labels.observation, draft.observation, setRoot('observation'), 'm077-length-error-observation'),
      textarea(content.labels.reflection, draft.reflection, setRoot('reflection'), 'm077-length-error-reflection'),
      para(content.labels.private),
      h(Button, { variant: 'primary', errorLabel: content.labels.retry, work: dirty || tooLong ? null : undefined,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.feedback.missing, { role: 'alert' }) : null,
      tooLong ? para(practice.status, { id: 'm077-practice-length-error', role: 'alert' }) : null,
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
