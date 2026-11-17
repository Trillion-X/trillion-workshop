import React, { useState } from 'react';
import { Button, Container, Text, Textarea, Timeline, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = content.fields.map(row => row.id);
const emptyDraft = () => Object.fromEntries(fields.map(key => [key, '']));
function restoreDraft(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [selected, setSelected] = useState('effectiveness');
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm155-practice',
    onRestore: record => { const saved = restoreDraft(record.result); if (saved) { setDraft(saved); setDirty(false); } },
  });
  const unavailable = practice.loading || practice.locked;
  const tooLong = JSON.stringify(draft).length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => {
    const next = { ...draft, [key]: value };
    setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(false);
    practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const field = row => h(Container, { gap: 'xs' }, h(Textarea, {
    id: `m155-${row.id}`, label: row.label, rows: row.id === 'correction' ? 4 : 3, autoGrow: true, maxHeight: 260,
    value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm155-practice-length-error' : undefined,
    onChange: event => update(row.id, event.currentTarget.value),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm155-practice-length-error', role: 'alert' }) : null);
  const loadExample = () => {
    const next = { ...content.example };
    setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(true);
    practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const save = () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return; }
    practice.setValue('result', JSON.stringify(draft));
    return practice.save().then(saved => { if (saved) setDirty(false); return saved; });
  };
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved && !dirty ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const current = content.distinctions.find(row => row.id === selected);
  const items = content.steps.map(step => ({ id: step.id, title: step.title, detail: step.detail }));
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm155-diagnosis-heading' },
      heading(content.labels.diagnosis, 'h2', 'm155-diagnosis-heading'), para(content.labels.diagnosisIntro),
      h(Container, { role: 'group', 'aria-label': content.labels.capacity, gap: 'sm' },
        ...content.distinctions.map(row => h(Button, { key: row.id, variant: selected === row.id ? 'primary' : 'secondary', 'aria-pressed': selected === row.id, onClick: () => setSelected(row.id) }, row.title))),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': content.labels.capacity },
        heading(current.title, 'h3'), para(current.detail), para(content.labels.decision, { role: 'status', 'aria-live': 'polite' })),
      h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm155-trace-heading' },
        heading(content.labels.trace, 'h3', 'm155-trace-heading'), para(content.labels.traceIntro), h(Timeline, { items }))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm155-practice-heading' },
      heading(content.labels.practice, 'h2', 'm155-practice-heading'), para(content.labels.practiceIntro),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadExample }, content.labels.loadExample),
      sampleLoaded ? para(content.labels.sampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
      ...content.fields.map(field), para(content.labels.private),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done, disabled: practice.loading, pendingLabel: content.labels.saving, errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved) ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' }, h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote, { wrap: 'preserve' }), para(content.labels.sourceLocator)));
}

export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
