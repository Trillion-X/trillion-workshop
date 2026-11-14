import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
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
  const [boundary, setBoundary] = useState('player');
  const [authority, setAuthority] = useState(true);
  const [change, setChange] = useState('space');
  const [conditions, setConditions] = useState('steady');
  const [predictions, setPredictions] = useState(['response']);
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm148-practice',
    onRestore: record => {
      const saved = restoreDraft(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
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
  const field = row => h(Container, { key: row.id, gap: 'xs' }, h(Textarea, {
    id: `m148-${row.id}`, label: row.label, rows: 3, autoGrow: true, maxHeight: 260,
    value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm148-practice-length-error' : undefined,
    onChange: event => update(row.id, event.currentTarget.value),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm148-practice-length-error', role: 'alert' }) : null);
  const save = () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return; }
    practice.setValue('result', JSON.stringify(draft));
    return practice.save().then(saved => { if (saved) setDirty(false); return saved; });
  };
  const loadSample = () => {
    const next = { ...content.example };
    setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(true);
    practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved && !dirty ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const result = !authority || change === 'observe' ? content.labels.observeOnlyResult : conditions === 'steady' ? content.labels.steadyResult : content.labels.confoundedResult;
  const mode = content.modes.find(row => row.id === boundary);
  const togglePrediction = key => setPredictions(current => current.includes(key) ? current.filter(row => row !== key) : [...current, key]);
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm148-demo-heading' },
      heading(content.labels.demo, 'h2', 'm148-demo-heading'), para(content.labels.demoIntro),
      h(Container, { gap: 'xs' }, para(content.labels.boundaryGroup),
        h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.boundaryGroup, layout: 'responsive-split', gap: 'sm' },
          ...content.modes.map(row => h(Button, { key: row.id, variant: boundary === row.id ? 'primary' : 'secondary', 'aria-pressed': boundary === row.id, onClick: () => setBoundary(row.id) }, row.label))),
        para(boundary === 'player' ? content.labels.playerBoundary : content.labels.teamBoundary, { role: 'status', 'aria-live': 'polite' }),
        h(Container, { gap: 'xs' }, heading(content.labels.rolesTitle, 'h3'), para(content.labels.returnRoles))),
      h(Container, { gap: 'xs' }, para(content.labels.authorityGroup),
        h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.authorityGroup, layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: authority ? 'primary' : 'secondary', 'aria-pressed': authority, onClick: () => { setAuthority(true); setChange('space'); } }, content.labels.authorityYes),
          h(Button, { variant: !authority ? 'primary' : 'secondary', 'aria-pressed': !authority, onClick: () => { setAuthority(false); setChange('observe'); } }, content.labels.authorityNo))),
      h(Container, { gap: 'xs' }, para(content.labels.changeGroup),
        h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.changeGroup, layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: change === 'space' ? 'primary' : 'secondary', 'aria-pressed': change === 'space', disabled: !authority, onClick: () => setChange('space') }, content.labels.changeSpace),
          h(Button, { variant: change === 'observe' ? 'primary' : 'secondary', 'aria-pressed': change === 'observe', onClick: () => setChange('observe') }, content.labels.changeObserve))),
      h(Container, { gap: 'xs' }, para(content.labels.conditionsGroup),
        h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.conditionsGroup, layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: conditions === 'steady' ? 'primary' : 'secondary', 'aria-pressed': conditions === 'steady', disabled: !authority || change === 'observe', onClick: () => setConditions('steady') }, content.labels.steady),
          h(Button, { variant: conditions === 'confounded' ? 'primary' : 'secondary', 'aria-pressed': conditions === 'confounded', disabled: !authority || change === 'observe', onClick: () => setConditions('confounded') }, content.labels.confounded))),
      h(Container, { gap: 'xs' }, para(content.labels.predictionGroup),
        h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.predictionGroup, layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: predictions.includes('response') ? 'primary' : 'secondary', 'aria-pressed': predictions.includes('response'), disabled: !authority || change === 'observe', onClick: () => togglePrediction('response') }, content.labels.predictResponse),
          h(Button, { variant: predictions.includes('partner') ? 'primary' : 'secondary', 'aria-pressed': predictions.includes('partner'), disabled: !authority || change === 'observe', onClick: () => togglePrediction('partner') }, content.labels.predictPartner)),
        predictions.length ? para(predictions.map(key => key === 'response' ? content.labels.predictResponse : content.labels.predictPartner).join(' · '), { role: 'status', 'aria-live': 'polite' }) : para(content.labels.predictionNote)),
      h(Container, { gap: 'xs', 'aria-label': content.labels.observationGroup }, para(content.labels.observationGroup), para(content.labels.notRecorded)),
      h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm148-result-heading' }, heading(content.labels.demoResultTitle, 'h3', 'm148-result-heading'), para(result, { role: 'status', 'aria-live': 'polite' })),
      para(mode.text)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm148-practice-heading' },
      heading(content.labels.practice, 'h2', 'm148-practice-heading'), para(content.labels.practiceIntro),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadSample }, content.labels.loadExample),
      sampleLoaded ? para(content.labels.sampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
      ...content.fields.map(field), para(content.labels.private),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done, disabled: practice.loading,
        pendingLabel: content.labels.saving, errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save },
      practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved) ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' }, h(Text, { as: 'summary' }, content.labels.source),
      para(content.labels.sourceQuote, { wrap: 'preserve' }), para(content.labels.sourceLocator)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
