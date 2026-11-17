import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import figure from './figure.json' with { type: 'json' };

const h = React.createElement;
const fields = ['activity', 'noticing', 'wandering', 'return', 'compare', 'fit'];
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
  const [buttonEpoch, setButtonEpoch] = useState(0);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'],
    messages: { ...content.feedback, length: content.feedback.length },
    requestPrefix: 'm093-continuous-presence',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => { setMissing(false); setDirty(true); setButtonEpoch(value => value + 1); practice.markEdited(); action(); };
  const setField = key => event => mark(() => setDraft(previous => ({ ...previous, [key]: event.target.value })));
  const save = async () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return false; }
    practice.setValue('result', JSON.stringify(draft));
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const tooLong = practice.status === content.feedback.length;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const textarea = (key, label) => h(Container, { gap: 'xs' },
    h(Textarea, {
      label, rows: 3, autoGrow: true, maxHeight: 260, value: draft[key], disabled,
      'aria-invalid': tooLong && key === longestField ? true : undefined,
      'aria-describedby': tooLong && key === longestField ? 'm093-practice-length-error' : undefined,
      onChange: setField(key),
    }),
    tooLong && key === longestField ? para(content.feedback.length, { id: 'm093-practice-length-error', role: 'alert' }) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm093-cycle-heading' },
      heading(content.labels.example, 'h2', 'm093-cycle-heading'),
      h(AnatomyFigure, { figure, label: content.labels.figure }),
      ...content.cases.map((row, index) => h(Container, {
        key: row.name, as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': `m093-case-${index}`,
      }, heading(row.name, 'h3', `m093-case-${index}`), para(`Before: ${row.before}`), para(`During: ${row.after}`), para(row.reading))),
      para(content.labels.sourceBoundary)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm093-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm093-practice-heading'),
        para('Keep the attempt brief and optional. Describe what happened without judging your attention or trying to force it to stay fixed.')),
      textarea('activity', content.labels.activity),
      textarea('noticing', content.labels.noticing),
      textarea('wandering', content.labels.wandering),
      textarea('return', content.labels.return),
      textarea('compare', content.labels.compare),
      textarea('fit', content.labels.fit),
      para(content.labels.private),
      h(Button, {
        key: buttonEpoch, variant: 'primary', fullWidth: true, doneLabel: content.labels.done,
        disabled: practice.loading || practice.saving, pendingLabel: content.labels.saving,
        errorLabel: content.labels.retry, onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.feedback.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote), para(content.labels.sourceHint),
      para(content.labels.sourceAttribution), para(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
