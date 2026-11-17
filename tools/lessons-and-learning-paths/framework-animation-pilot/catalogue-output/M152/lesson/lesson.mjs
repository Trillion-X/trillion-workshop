import React, { useMemo, useState } from 'react';
import { Button, Chart, Container, Input, Text, Textarea, Timeline, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = content.fields.map(row => row.id);
const emptyDraft = () => Object.fromEntries(fields.map(key => [key, '']));
const defaultModules = () => Object.fromEntries(content.modules.map(row => [row.id, { change: '', completion: '', direction: '', dependency: '', feedback: '', dateOrigin: 'unset', response: '' }]));
function restoreDraft(value) {
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null; return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : ''])); }
  catch { return null; }
}
function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [modules, setModules] = useState(defaultModules);
  const [active, setActive] = useState('immediate');
  const [leadTime, setLeadTime] = useState(content.scheduleExample.leadTimeDays);
  const [chosenDays, setChosenDays] = useState(content.scheduleExample.chosenDays);
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields: ['result'], messages: content.feedback, requestPrefix: 'm152-practice',
    onRestore: record => { const saved = restoreDraft(record.result); if (saved) { setDraft(saved); setDirty(false); } },
  });
  const unavailable = practice.loading || practice.locked;
  const tooLong = JSON.stringify(draft).length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const updateDraft = (key, value) => { const next = { ...draft, [key]: value }; setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(false); practice.markEdited(); practice.setValue('result', JSON.stringify(next)); };
  const updateModule = (key, value) => setModules(previous => ({ ...previous, [active]: { ...previous[active], [key]: value } }));
  const current = modules[active];
  const selected = content.modules.find(row => row.id === active);
  const items = content.modules.map(row => {
    const state = modules[row.id];
    const date = state.dateOrigin === 'real' ? content.labels.realDate : state.dateOrigin === 'chosen' ? content.labels.chosenDate : content.labels.unsetDate;
    const direction = state.direction || row.nextTitle;
    const detail = [state.change || row.detail, direction, date, state.completion, state.response].filter(Boolean).join(' · ');
    return { id: row.id, title: row.title, detail };
  });
  const maxDay = Math.max(leadTime, chosenDays, 2);
  const seriesData = useMemo(() => {
    const slots = Array.from({ length: maxDay + 1 }, (_, day) => ({ key: String(day), label: `Day ${day}`, at: day }));
    return { slots, series: [
      { id: 'open', label: content.labels.scheduleLabel, values: slots.map(slot => slot.at <= chosenDays ? 1 : 0) },
      { id: 'visible', label: content.labels.effectLabel, values: slots.map(slot => slot.at >= leadTime ? 1 : 0) },
    ], value_kind: 'count', y_domain: [0, 1], label_ends: true };
  }, [maxDay, chosenDays, leadTime]);
  const timingMessage = chosenDays < leadTime ? content.labels.gap : content.labels.fits;
  const field = row => h(Container, { gap: 'xs' }, h(Textarea, {
    id: `m152-${row.id}`, label: row.label, rows: row.id === 'dependencies' || row.id === 'feedback' ? 4 : 3, autoGrow: true, maxHeight: 260,
    value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm152-practice-length-error' : undefined,
    onChange: event => updateDraft(row.id, event.currentTarget.value),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm152-practice-length-error', role: 'alert' }) : null);
  const loadExample = () => {
    const next = { ...content.example }; setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(true); practice.markEdited(); practice.setValue('result', JSON.stringify(next));
    setModules(previous => ({ ...previous, week: { ...previous.week, change: content.example.chosen, completion: 'Review when the external response arrives.', direction: 'Make the decision the response is needed for.', dependency: content.example.dependencies, feedback: content.example.feedback, dateOrigin: 'real' } }));
  };
  const save = () => { if (!fields.some(key => draft[key].trim())) { setMissing(true); return; } practice.setValue('result', JSON.stringify(draft)); return practice.save().then(saved => { if (saved) setDirty(false); return saved; }); };
  const buttonWork = practice.saving ? 'pending' : practice.status === content.feedback.saved && !dirty ? 'done'
    : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm152-timeline-heading' },
      heading(content.labels.timeline, 'h2', 'm152-timeline-heading'), para(content.labels.timelineIntro),
      h(Container, { role: 'group', 'aria-label': content.labels.horizon, layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' },
        ...content.modules.map(row => h(Button, { key: row.id, variant: active === row.id ? 'primary' : 'secondary', 'aria-pressed': active === row.id, onClick: () => setActive(row.id) }, row.title))),
      h(Container, { layout: 'grid', gridCols: '1', gap: 'lg' },
        h(Container, { role: 'group', 'aria-label': content.labels.horizon + ': ' + selected.title, gap: 'sm' },
          heading(selected.title, 'h3'),
          h(Textarea, { id: 'm152-change', label: content.labels.meaningful, rows: 2, autoGrow: true, maxHeight: 180, value: current.change, onChange: event => updateModule('change', event.currentTarget.value) }),
          h(Textarea, { id: 'm152-completion', label: content.labels.completion, rows: 2, autoGrow: true, maxHeight: 180, value: current.completion, onChange: event => updateModule('completion', event.currentTarget.value) }),
          h(Textarea, { id: 'm152-direction', label: content.labels.direction, rows: 2, autoGrow: true, maxHeight: 180, value: current.direction, onChange: event => updateModule('direction', event.currentTarget.value) }),
          h(Textarea, { id: 'm152-dependency', label: content.labels.dependency, rows: 3, autoGrow: true, maxHeight: 220, value: current.dependency, onChange: event => updateModule('dependency', event.currentTarget.value) }),
          h(Textarea, { id: 'm152-feedback', label: content.labels.feedback, rows: 2, autoGrow: true, maxHeight: 180, value: current.feedback, onChange: event => updateModule('feedback', event.currentTarget.value) }),
          h(Container, { role: 'group', 'aria-label': content.labels.dateOrigin, layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' },
            ...[['real', content.labels.realDate], ['chosen', content.labels.chosenDate], ['unset', content.labels.unsetDate]].map(([key, label]) => h(Button, { key, variant: current.dateOrigin === key ? 'primary' : 'secondary', 'aria-pressed': current.dateOrigin === key, onClick: () => updateModule('dateOrigin', key) }, label))),
          h(Container, { role: 'group', 'aria-label': content.labels.response, layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm' },
            ...[['continue', content.labels.continueAction], ['change', content.labels.changeAction], ['stop', content.labels.stopAction], ['recover', content.labels.recoverAction]].map(([key, label]) => h(Button, { key, variant: current.response === key ? 'primary' : 'secondary', 'aria-pressed': current.response === key, onClick: () => updateModule('response', key) }, label))),
          current.response ? para(content.labels[`response${current.response[0].toUpperCase()}${current.response.slice(1)}`], { role: 'status', 'aria-live': 'polite' }) : null,
        ),
        h(Container, { as: 'section', gap: 'sm', 'aria-label': content.labels.timeline },
          h(Timeline, { items }),
          h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm152-comparison-heading' },
            heading(content.labels.comparison, 'h3', 'm152-comparison-heading'), para(content.labels.comparisonIntro),
            h(Container, { layout: 'grid', gridCols: '2', gap: 'sm' },
              h(Input, { id: 'm152-real-lead-time', label: content.labels.leadTime, type: 'number', min: 1, max: 90, value: String(leadTime), onChange: event => setLeadTime(Math.max(1, Math.min(90, Number(event.currentTarget.value) || 1))) }),
              h(Input, { id: 'm152-chosen-days', label: content.labels.chosenDays, type: 'number', min: 1, max: 90, value: String(chosenDays), onChange: event => setChosenDays(Math.max(1, Math.min(90, Number(event.currentTarget.value) || 1))) })),
            h(Chart, { data: seriesData, mark: 'step-line', label: content.labels.comparison, height: 220 }), para(timingMessage, { role: 'status', 'aria-live': 'polite' })))),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadExample }, content.labels.loadExample),
      sampleLoaded ? para(content.labels.sampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
    ),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm152-practice-heading' },
      heading(content.labels.practice, 'h2', 'm152-practice-heading'), para(content.labels.practiceIntro), ...content.fields.map(field), para(content.labels.private),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done, disabled: practice.loading, pendingLabel: content.labels.saving, errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved) ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' }, h(Text, { as: 'summary' }, content.labels.source), para(content.labels.sourceQuote, { wrap: 'preserve' }), para(content.labels.sourceLocator)));
}
export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
