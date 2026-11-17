import React, { useState } from 'react';
import { Button, Container, Text, Textarea, Timeline, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import actionsData from './source-actions.json' with { type: 'json' };

const h = React.createElement;
const fields = content.fields.map(row => row.id);
const emptyDraft = () => Object.fromEntries(fields.map(key => [key, '']));
function restoreDraft(value) {
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null; return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : ''])); }
  catch { return null; }
}
function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [active, setActive] = useState('step1');
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields: ['result'], messages: content.feedback, requestPrefix: 'm159-practice', onRestore: record => { const saved = restoreDraft(record.result); if (saved) { setDraft(saved); setDirty(false); } } });
  const unavailable = practice.loading || practice.locked;
  const tooLong = JSON.stringify(draft).length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => { const next = { ...draft, [key]: value }; setDraft(next); setDirty(true); setMissing(false); practice.markEdited(); practice.setValue('result', JSON.stringify(next)); };
  const field = row => h(Container, { gap: 'xs' }, h(Textarea, { id: `m159-${row.id}`, label: row.label, rows: 3, autoGrow: true, maxHeight: 260, value: draft[row.id], disabled: unavailable, 'aria-invalid': tooLong && row.id === longestField ? true : undefined, 'aria-describedby': tooLong && row.id === longestField ? 'm159-practice-length-error' : undefined, onChange: event => update(row.id, event.currentTarget.value) }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm159-practice-length-error', role: 'alert' }) : null);
  const save = () => { if (!fields.some(key => draft[key].trim())) { setMissing(true); return; } practice.setValue('result', JSON.stringify(draft)); return practice.save().then(saved => { if (saved) setDirty(false); return saved; }); };
  const buttonWork = practice.saving ? 'pending' : practice.status === content.feedback.saved && !dirty ? 'done' : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const actions = actionsData.sourceActions;
  const timeline = actions.map(row => ({ id: row.id, title: row.text, detail: '' }));
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm159-journey-heading' },
      heading(content.labels.journey, 'h2', 'm159-journey-heading'), para(content.labels.journeyIntro),
      h(Container, { role: 'group', 'aria-label': content.labels.journey, layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' }, ...actions.map(row => h(Button, { key: row.id, variant: active === row.id ? 'primary' : 'secondary', 'aria-pressed': active === row.id, onClick: () => setActive(row.id) }, `Step ${row.id.slice(-1)}`))),
      h(Timeline, { items: timeline })),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm159-practice-heading' },
      heading(content.labels.practice, 'h2', 'm159-practice-heading'), para(content.labels.practiceIntro), field(content.fields.find(row => row.id === active)), para(content.labels.private),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done, disabled: practice.loading, pendingLabel: content.labels.saving, errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null, practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved) ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null, practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' }, h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote, { wrap: 'preserve' }), para(content.labels.sourceLocator)));
}
export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
