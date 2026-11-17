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
  const [active, setActive] = useState(0);
  const [route, setRoute] = useState('');
  const [performed, setPerformed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm151-practice',
    onRestore: record => { const saved = restoreDraft(record.result); if (saved) { setDraft(saved); setDirty(false); } },
  });
  const unavailable = practice.loading || practice.locked;
  const tooLong = JSON.stringify(draft).length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => {
    const next = { ...draft, [key]: value }; setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(false);
    practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const field = row => h(Container, { gap: 'xs' }, h(Textarea, {
    id: `m151-${row.id}`, label: row.label, rows: row.id === 'next' ? 4 : 3, autoGrow: true, maxHeight: 260,
    value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm151-practice-length-error' : undefined,
    onChange: event => update(row.id, event.currentTarget.value),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm151-practice-length-error', role: 'alert' }) : null);
  const loadExample = () => {
    const next = { ...content.example }; setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(true);
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
  const current = content.steps[active];
  const jump = (target, message) => { setActive(target); setRoute(message); setPerformed(false); };
  const items = content.steps.map((step, index) => ({
    id: step.id, title: `${index + 1}. ${step.title}`,
    detail: index === active ? `${step.detail} ${route}`.trim() : step.detail,
  }));
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm151-loop-heading' },
      heading(content.labels.loop, 'h2', 'm151-loop-heading'), para(content.labels.loopIntro),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': content.labels.progress },
        heading(content.labels.current.replace('{n}', String(active + 1)).replace('{title}', current.title), 'h3'),
        para(current.detail),
        h(Container, { layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: 'secondary', disabled: active === 0, onClick: () => { setActive(value => Math.max(0, value - 1)); setRoute(''); } }, content.labels.back),
          h(Button, { variant: 'primary', disabled: active === content.steps.length - 1, onClick: () => { setActive(value => Math.min(content.steps.length - 1, value + 1)); setRoute(''); } }, content.labels.next)),
        h(Container, { role: 'group', 'aria-label': content.labels.branch, gap: 'sm' }, heading(content.labels.branch, 'h3'), para(content.labels.branchIntro),
          h(Container, { layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' },
            h(Button, { variant: 'secondary', onClick: () => jump(2, content.labels.branchPrediction) }, content.labels.predictionFailed),
            h(Button, { variant: 'secondary', onClick: () => jump(6, content.labels.branchAuthority) }, content.labels.authorityMissing),
            h(Button, { variant: 'secondary', onClick: () => jump(10, content.labels.branchUnresolved) }, content.labels.resultUnresolved),
            h(Button, { variant: 'secondary', onClick: () => jump(12, content.labels.branchSupported) }, content.labels.resultSupported))),
        h(Container, { role: 'group', 'aria-label': content.labels.outcome, gap: 'sm' },
          h(Button, { variant: performed ? 'primary' : 'secondary', disabled: active !== 8, 'aria-pressed': performed, onClick: () => setPerformed(value => !value) }, content.labels.performed),
          para(performed ? content.labels.doneAction : content.labels.pending, { role: 'status', 'aria-live': 'polite' })),
      h(Container, { as: 'section', gap: 'sm', 'aria-label': content.labels.loop }, h(Timeline, { items })))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm151-practice-heading' },
      heading(content.labels.practice, 'h2', 'm151-practice-heading'), para(content.labels.practiceIntro),
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
