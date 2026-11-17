import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import figure from './figure.json' with { type: 'json' };

const h = React.createElement;
const keys = ['lowAnchor', 'highAnchor'];
const blankReading = id => ({ id, interval: '', value: '', difficulty: '', situation: '', trigger: '' });
const blankDraft = () => ({ anchors: { lowAnchor: '', highAnchor: '' }, readings: [] });
const parseRecord = value => {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.readings)) return null;
    return {
      anchors: Object.fromEntries(keys.map(key => [key, typeof parsed.anchors?.[key] === 'string' ? parsed.anchors[key] : ''])),
      readings: parsed.readings.filter(row => row && typeof row === 'object').map((row, index) => ({
        ...blankReading(typeof row.id === 'string' ? row.id : `reading-${index + 1}`),
        ...Object.fromEntries(['interval', 'value', 'difficulty', 'situation', 'trigger'].map(key => [key, typeof row[key] === 'string' ? row[key] : ''])),
      })),
    };
  } catch { return null; }
};

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blankDraft);
  const [nextId, setNextId] = useState(0);
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm086-impetus-thermometer',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (restored) {
        setDraft(restored);
        setNextId(restored.readings.reduce((max, row) => {
          const match = /^reading-(\d+)$/.exec(row.id);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0));
      }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = action => { setMissing(false); practice.markEdited(); action(); };
  const updateAnchor = key => event => update(() => setDraft(previous => ({
    ...previous, anchors: { ...previous.anchors, [key]: event.target.value },
  })));
  const updateReading = (id, key, value) => update(() => setDraft(previous => ({
    ...previous, readings: previous.readings.map(row => row.id === id ? { ...row, [key]: value } : row),
  })));
  const addReading = () => update(() => {
    const id = `reading-${nextId + 1}`;
    setNextId(value => value + 1);
    setDraft(previous => ({ ...previous, readings: [...previous.readings, blankReading(id)] }));
  });
  const removeReading = id => update(() => setDraft(previous => ({
    ...previous, readings: previous.readings.filter(row => row.id !== id),
  })));
  const attempt = () => JSON.stringify(draft);
  const tooLong = attempt().length > 2000 || practice.status === content.feedback.length;
  const isComplete = row => Number.isInteger(Number(row.value))
    && Number(row.value) >= 1 && Number(row.value) <= 10
    && Number.isInteger(Number(row.difficulty)) && Number(row.difficulty) >= 1 && Number(row.difficulty) <= 10
    && row.interval.trim() && row.situation.trim();
  const completeReadings = draft.readings.filter(isComplete);
  const save = async () => {
    if (!completeReadings.length) { setMissing(true); return false; }
    practice.setValue('result', attempt());
    const saved = await practice.save();
    return saved;
  };
  const lengthField = draft.readings.flatMap(row => ['interval', 'situation', 'trigger'].map(key => ({ id: row.id, key, value: row[key] })))
    .sort((a, b) => b.value.length - a.value.length)[0];
  const describedBy = row => [
    tooLong && lengthField?.id === row.id ? 'm086-length-error' : null,
    missing && !isComplete(row) ? 'm086-missing-error' : null,
  ].filter(Boolean).join(' ') || undefined;
  const field = (row, key, label, rows = 2) => h(Container, { gap: 'xs', key },
    key === 'situation' || key === 'trigger' ? null
      : h(Text, { as: 'label', variant: 'body', htmlFor: `m086-${row.id}-${key}` }, label),
    key === 'value' || key === 'difficulty'
      ? h(Input, {
        id: `m086-${row.id}-${key}`, type: 'number', min: 1, max: 10, step: 1,
        value: row[key], disabled, 'aria-label': label,
        'aria-invalid': missing && !isComplete(row) ? true : undefined,
        'aria-describedby': describedBy(row),
        onChange: event => updateReading(row.id, key, event.currentTarget.value),
      })
      : key === 'interval'
        ? h(Input, {
          id: `m086-${row.id}-${key}`, type: 'text', value: row[key], disabled,
          'aria-label': label, placeholder: 'For example, week of 12 May',
          'aria-invalid': (missing && !isComplete(row)) || (tooLong && lengthField?.id === row.id && lengthField?.key === key) ? true : undefined,
          'aria-describedby': describedBy(row),
          onChange: event => updateReading(row.id, key, event.currentTarget.value),
        })
        : h(Textarea, {
          id: `m086-${row.id}-${key}`, label, rows, autoGrow: true, maxHeight: 180,
          value: row[key], disabled,
          'aria-invalid': (missing && !isComplete(row)) || (tooLong && lengthField?.id === row.id && lengthField?.key === key) ? true : undefined,
          'aria-describedby': describedBy(row),
          onChange: event => updateReading(row.id, key, event.currentTarget.value),
        }));
  const readingCards = draft.readings.length ? draft.readings.map((row, index) => h(Container, {
    key: row.id, as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': `m086-reading-${row.id}`,
  },
  heading(`${content.labels.readings} ${index + 1}`, 'h3', `m086-reading-${row.id}`),
  field(row, 'interval', content.labels.interval),
  h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
    field(row, 'value', content.labels.value),
    field(row, 'difficulty', content.labels.difficulty)),
  field(row, 'situation', content.labels.situation, 3),
  field(row, 'trigger', content.labels.trigger, 2),
  h(Button, { variant: 'secondary', disabled, onClick: () => removeReading(row.id) }, content.labels.removeReading)))
    : [para('Add a reading when you have one. A single report records a moment; it does not establish a trend.')];

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { as: 'header', gap: 'sm' }, heading(content.title, 'h1', 'm086-title'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm086-example-heading' },
      heading(content.labels.example, 'h2', 'm086-example-heading'),
      para(content.labels.exampleNote),
      h(AnatomyFigure, { figure, className: 'anatomy-figure--contained', label: content.labels.figure }),
      para(content.labels.exampleReading),
      para(content.labels.separateEvent)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm086-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm086-practice-heading'),
        para(content.labels.practiceIntro), para(content.labels.scaleNote)),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
        ...keys.map(key => h(Textarea, {
          key, label: content.labels[key], rows: 2, autoGrow: true, maxHeight: 120,
          value: draft.anchors[key], disabled,
          onChange: updateAnchor(key),
        }))),
      ...readingCards,
      h(Button, { variant: 'secondary', disabled, onClick: addReading }, content.labels.addReading),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm086-save-heading' },
        heading('Private practice', 'h3', 'm086-save-heading'), para(content.labels.private),
        missing ? para(content.feedback.missing, { id: 'm086-missing-error', role: 'alert' }) : null,
        tooLong ? para(content.feedback.length, { id: 'm086-length-error', role: 'alert' }) : null,
        h(Button, {
          variant: 'primary', fullWidth: true,
          disabled: practice.loading || practice.saving || (!practice.locked && tooLong),
          onClick: () => void save(),
        }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
        practice.status && !tooLong ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
        practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
    para(content.labels.trend),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
      para(content.labels.sourceQuote), para(content.labels.sourceLocator),
      para(content.labels.sourceAttribution), para(content.labels.sourceBoundary)));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
