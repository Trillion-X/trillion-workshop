import React, { useState } from 'react';
import { Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fieldIds = content.fields.map(row => row.id);
const emptyDraft = () => Object.fromEntries(fieldIds.map(key => [key, '']));
function restorePractice(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      draft: Object.fromEntries(fieldIds.map(key => [key, typeof parsed.draft?.[key] === 'string' ? parsed.draft[key] : ''])),
      minutes: typeof parsed.minutes === 'string' ? parsed.minutes : '5',
      dailyFit: ['yes', 'no', 'unsure'].includes(parsed.dailyFit) ? parsed.dailyFit : null,
      observedDays: Array.isArray(parsed.observedDays) ? [...new Set(parsed.observedDays.filter(day => Number.isInteger(day) && day >= 1 && day <= 14))] : [],
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [minutes, setMinutes] = useState('5');
  const [dailyFit, setDailyFit] = useState(null);
  const [observedDays, setObservedDays] = useState([]);
  const [activeAction, setActiveAction] = useState(0);
  const [caseChoice, setCaseChoice] = useState('symbolic');
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const [invalidMinutes, setInvalidMinutes] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback, requestPrefix: 'm153-practice',
    onRestore: record => {
      const saved = restorePractice(record.result);
      if (saved) {
        setDraft(saved.draft); setMinutes(saved.minutes); setDailyFit(saved.dailyFit); setObservedDays(saved.observedDays); setDirty(false);
      }
    },
  });
  const unavailable = practice.loading || practice.locked;
  const practiceValue = { draft, minutes, dailyFit, observedDays };
  const serialized = JSON.stringify(practiceValue);
  const tooLong = serialized.length > 2000;
  const longestField = fieldIds.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fieldIds[0]);
  const active = content.actions[activeAction];
  const selectedCase = caseChoice === 'connected';
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => {
    const next = { ...draft, [key]: value };
    setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(false); practice.markEdited();
    practice.setValue('result', JSON.stringify({ ...practiceValue, draft: next }));
  };
  const updatePlan = (changes) => {
    const next = { ...practiceValue, ...changes };
    if (changes.draft) setDraft(changes.draft);
    if (Object.hasOwn(changes, 'minutes')) setMinutes(changes.minutes);
    if (Object.hasOwn(changes, 'dailyFit')) setDailyFit(changes.dailyFit);
    if (Object.hasOwn(changes, 'observedDays')) setObservedDays(changes.observedDays);
    setDirty(true); setMissing(false); setSampleLoaded(false); practice.markEdited();
    practice.setValue('result', JSON.stringify(next));
  };
  const loadExample = () => {
    const next = { draft: content.example, minutes: '5', dailyFit: 'yes', observedDays: [] };
    setDraft(next.draft); setMinutes(next.minutes); setDailyFit(next.dailyFit); setObservedDays(next.observedDays);
    setDirty(true); setMissing(false); setSampleLoaded(true); practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const save = () => {
    if (!fieldIds.some(key => draft[key].trim())) { setMissing(true); return; }
    if (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0 || Number(minutes) > 5) { setInvalidMinutes(true); return; }
    setInvalidMinutes(false); practice.setValue('result', serialized);
    return practice.save().then(saved => { if (saved) setDirty(false); return saved; });
  };
  const field = row => h(Container, { gap: 'xs', key: row.id }, h(Textarea, {
    id: `m153-${row.id}`, label: row.label, rows: row.id === 'environment' ? 3 : 2,
    autoGrow: true, maxHeight: 220, value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm153-length-error' : undefined,
    onChange: event => update(row.id, event.currentTarget.value),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm153-length-error', role: 'alert' }) : null);
  const toggleDay = day => updatePlan({ observedDays: observedDays.includes(day) ? observedDays.filter(value => value !== day) : [...observedDays, day].sort((a, b) => a - b) });
  const actionGroup = h(Container, { role: 'group', 'aria-label': content.labels.sequence, layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' },
    ...content.actions.map((row, index) => h(Button, { key: row.id, variant: activeAction === index ? 'primary' : 'secondary', 'aria-pressed': activeAction === index, onClick: () => setActiveAction(index) }, `${index + 1}. ${row.stepLabel}`)));
  const caseResult = selectedCase ? content.labels.connectedResult : content.labels.symbolicResult;
  const buttonWork = practice.saving ? 'pending' : practice.status === content.feedback.saved && !dirty ? 'done'
    : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;

  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm153-sequence-heading' },
      heading(content.labels.sequence, 'h2', 'm153-sequence-heading'), para(content.labels.sequenceIntro),
      actionGroup,
      h(Container, { gap: 'sm', 'aria-live': 'polite', 'aria-atomic': true },
        heading(active.title, 'h3', 'm153-active-action'),
        para(active.detail),
        para(content.labels.stepCount.replace('{n}', String(activeAction + 1)), { role: 'status' })),
      h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.case, gap: 'sm' },
        heading(content.labels.case, 'h3'), para(content.labels.caseIntro),
        para(content.labels.outcomeCase),
        h(Container, { role: 'group', 'aria-label': content.labels.case, layout: 'responsive-split', gap: 'sm' },
          h(Button, { variant: selectedCase ? 'primary' : 'secondary', 'aria-pressed': selectedCase, onClick: () => setCaseChoice('connected') }, content.labels.connectedChoice),
          h(Button, { variant: selectedCase ? 'secondary' : 'primary', 'aria-pressed': !selectedCase, onClick: () => setCaseChoice('symbolic') }, content.labels.symbolicChoice)),
        para(selectedCase ? content.labels.connectedAction : content.labels.symbolicAction),
        para(caseResult, { role: 'status', 'aria-live': 'polite' })),
    ),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm153-plan-heading' },
      heading(content.labels.plan, 'h2', 'm153-plan-heading'), para(content.labels.planIntro),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadExample }, 'Load a research example'),
      sampleLoaded ? para('Research example loaded.', { role: 'status', 'aria-live': 'polite' }) : null,
      ...content.fields.map(field),
      h(Input, { id: 'm153-minutes', label: content.labels.minutes, type: 'number', min: 0.1, max: 5, step: 0.1, value: minutes, disabled: unavailable,
        'aria-invalid': invalidMinutes || Number(minutes) > 5 ? true : undefined,
        'aria-describedby': invalidMinutes || Number(minutes) > 5 ? 'm153-minutes-error' : undefined,
        onChange: event => { setMinutes(event.currentTarget.value); updatePlan({ minutes: event.currentTarget.value }); setInvalidMinutes(false); } }),
      (invalidMinutes || Number(minutes) > 5 || Number(minutes) <= 0) ? para('Choose a useful first action that takes five minutes or less.', { id: 'm153-minutes-error', role: 'alert' }) : null,
      h(Container, { gap: 'sm', role: 'group', 'aria-label': content.labels.scheduleFit },
        heading(content.labels.scheduleFit, 'h3'),
        h(Container, { role: 'group', 'aria-label': content.labels.scheduleFit, layout: 'responsive-split', gap: 'sm' },
          ...[['yes', content.labels.fitYes], ['no', content.labels.fitNo], ['unsure', content.labels.fitUnsure]].map(([key, label]) => h(Button, {
            key, variant: dailyFit === key ? 'primary' : 'secondary', 'aria-pressed': dailyFit === key,
            onClick: () => updatePlan({ dailyFit: key, observedDays: key === 'yes' ? observedDays : [] }),
          }, label))),
        dailyFit === 'yes' ? h(Container, { gap: 'sm', 'aria-labelledby': 'm153-observation-heading' },
          heading(content.labels.observation, 'h3', 'm153-observation-heading'), para(content.labels.observationIntro),
          h(Container, { layout: 'grid', gridCols: '2', gap: 'sm', role: 'group', 'aria-label': 'Fourteen observation days' },
            ...Array.from({ length: 14 }, (_, index) => {
              const day = index + 1, observed = observedDays.includes(day);
              return h(Button, { key: day, variant: observed ? 'primary' : 'secondary', 'aria-pressed': observed, onClick: () => toggleDay(day) }, `${content.labels.day.replace('{n}', String(day))} · ${observed ? content.labels.tried : content.labels.notTried}`);
            }),
          ),
          para(`${observedDays.length} of 14 days marked. This record does not measure progress toward the outcome.`),
        ) : dailyFit === 'no' ? para(content.labels.notDaily, { role: 'status', 'aria-live': 'polite' })
          : dailyFit === 'unsure' ? para(content.labels.unsureDaily, { role: 'status', 'aria-live': 'polite' }) : null,
      ),
      para(content.labels.expand),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done, disabled: practice.loading,
        pendingLabel: content.labels.saving, errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save },
      practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved) ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
    ),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote, { wrap: 'preserve' }), para(content.labels.sourceLocator)),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
