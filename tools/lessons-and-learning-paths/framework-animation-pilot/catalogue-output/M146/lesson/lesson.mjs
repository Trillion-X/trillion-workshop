import React, { useState } from 'react';
import { Button, Chart, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = content.labels.fields.map(row => row.id);
const format = (template, value) => template.replace('{n}', String(value));
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
  const [waiting, setWaiting] = useState(content.routes.baseline.waiting);
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm146-contact',
    onRestore: record => {
      const saved = restoreDraft(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const unavailable = practice.loading || practice.locked;
  const tooLong = JSON.stringify(draft).length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => {
    const next = { ...draft, [key]: value };
    setDraft(next); setDirty(true); setMissing(false); setSampleLoaded(false);
    practice.markEdited(); practice.setValue('result', JSON.stringify(next));
  };
  const edit = key => event => update(key, event.currentTarget.value);
  const loadSample = () => {
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
  const route = content.routes.shortened;
  const firstContact = route.preparation + route.contact;
  const interval = firstContact + waiting;
  const attemptsBeforeLimit = content.comparison.available < firstContact ? 0
    : Math.min(content.comparison.attempts, 1 + Math.floor((content.comparison.available - firstContact) / interval));
  const contactPlot = (key, values) => {
    const first = values.preparation + values.contact;
    const times = Array.from({ length: content.comparison.available + 1 }, (_, n) => n);
    return {
      slots: times.map(t => ({ key: String(t), label: String(t), at: t })),
      series: [{ id: key, label: content.labels[key], values: times.map(t => t < first ? 0 : Math.min(content.comparison.attempts, 1 + Math.floor((t - first) / (first + values.waiting)))) }],
      lines: [{ id: 'planned-attempts', label: content.labels.timelineLimit, value: content.comparison.attempts }],
      value_kind: 'count',
      y_domain: [0, content.comparison.attempts], label_ends: true,
    };
  };
  const field = row => h(Container, { gap: 'xs' }, h(Textarea, {
    id: `m146-${row.id}`, label: row.label, rows: 3, autoGrow: true, maxHeight: 260,
    value: draft[row.id], disabled: unavailable,
    'aria-invalid': tooLong && row.id === longestField ? true : undefined,
    'aria-describedby': tooLong && row.id === longestField ? 'm146-practice-length-error' : undefined,
    onChange: edit(row.id),
  }), tooLong && row.id === longestField ? para(content.labels.length, { id: 'm146-practice-length-error', role: 'alert' }) : null);
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm146-comparison-heading' },
      heading(content.labels.comparison, 'h2', 'm146-comparison-heading'),
      para(content.labels.comparisonIntro),
      h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.waitQuestion, layout: 'responsive-split', gap: 'sm' },
        ...content.waitOptions.map(value => h(Button, {
          key: value, variant: waiting === value ? 'primary' : 'secondary', 'aria-pressed': waiting === value,
          onClick: () => setWaiting(value),
        }, value === 1 ? content.labels.waitOptionOne : format(content.labels.waitOptionTemplate, value)))),
      h(Container, { layout: 'grid', gridCols: '1', gap: 'md' },
        ...[
          ['baseline', content.routes.baseline],
          ['shortened', { ...route, waiting }],
        ].map(([key, values]) => {
          const first = values.preparation + values.contact;
          const total = content.comparison.attempts * first + (content.comparison.attempts - 1) * values.waiting;
          const resolved = content.comparison.available < first ? 0
            : Math.min(content.comparison.attempts, 1 + Math.floor((content.comparison.available - first) / (first + values.waiting)));
          return h(Container, { key, as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': `m146-${key}-heading` },
            heading(content.labels[key], 'h3', `m146-${key}-heading`),
            h(Chart, { data: contactPlot(key, values), mark: 'step-line', label: content.labels[key] + ': ' + content.labels.timelineLabel, height: 180 }),
            para(format(content.labels.preparationValue, values.preparation)),
            para(format(content.labels.contactValue, values.contact)),
            para(values.waiting === 1 ? content.labels.waitingValueOne : format(content.labels.waitingValue, values.waiting)),
            para(format(content.labels.intervalValue, first + values.waiting)),
            para(format(content.labels.totalValue, total)),
            para(format(content.labels.resolvedValue, resolved), { role: key === 'shortened' ? 'status' : undefined, 'aria-live': key === 'shortened' ? 'polite' : undefined }));
        })),
      para(format(content.labels.comparisonConclusion, attemptsBeforeLimit), { role: 'status', 'aria-live': 'polite' }),
      h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm146-interpret-heading' },
        heading(content.labels.interpretTitle, 'h3', 'm146-interpret-heading'), para(content.labels.interpretText))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm146-practice-heading' },
      heading(content.labels.practice, 'h2', 'm146-practice-heading'),
      para(content.labels.practiceIntro),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadSample }, content.labels.loadExample),
      sampleLoaded ? para(content.labels.sampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
      ...content.labels.fields.map(field),
      para(content.labels.private),
      h(Button, { variant: 'primary', fullWidth: true, work: buttonWork, doneLabel: content.labels.done,
        disabled: practice.loading, pendingLabel: content.labels.saving,
        errorLabel: practice.locked ? content.labels.retry : content.labels.save, onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      para(content.labels.sourceQuote, { wrap: 'preserve' }),
      para(content.labels.sourceLocator)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
