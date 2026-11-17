import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = content.fields.map(row => row.id);
const blankDraft = () => Object.fromEntries(fields.map(key => [key, '']));
const parseRecord = value => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
};
function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blankDraft);
  const [selectedFact, setSelectedFact] = useState('clear');
  const [tooLong, setTooLong] = useState(false);
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm102-existing-activity-meaning',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (!restored) return;
      setDraft(restored);
      setTooLong(JSON.stringify(restored).length > 2000);
    },
  });
  const unavailable = practice.loading || practice.locked;
  const serialize = value => JSON.stringify(value);
  const tooLongMessageId = 'm102-practice-length-error';
  const longestKey = fields.reduce((best, key) => draft[key].length > draft[best].length ? key : best, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const edit = (key, value) => {
    const next = { ...draft, [key]: value };
    const result = serialize(next);
    setDraft(next);
    setMissing(false);
    setTooLong(result.length > 2000);
    practice.markEdited();
    if (result.length <= 2000) practice.setValue('result', result);
  };
  const field = ({ id, label, rows = 2 }) => h(Container, { gap: 'xs' },
    h(Textarea, {
      id: `m102-${id}`,
      label,
      rows,
      autoGrow: true,
      maxHeight: rows > 2 ? 240 : 180,
      value: draft[id],
      disabled: unavailable,
      'aria-invalid': tooLong && id === longestKey ? 'true' : undefined,
      'aria-describedby': tooLong && id === longestKey ? tooLongMessageId : undefined,
      onChange: event => edit(id, event.currentTarget.value),
    }),
    tooLong && id === longestKey ? h(Text, { as: 'p', id: tooLongMessageId, role: 'alert' }, content.labels.oversize) : null);
  const observedEffect = selectedFact === 'clear'
    ? content.labels.connectionPrompt
    : selectedFact === 'layout' ? content.labels.layoutPrompt : content.labels.unknownPrompt;
  const exampleCard = (id, title, example) => h(Container, {
    key: id,
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'sm',
    'aria-labelledby': `m102-example-${id}`,
  },
  heading(title, 'h3', `m102-example-${id}`),
  p(`${content.labels.activity}: ${example.activity}`),
  p(`${content.labels.skill}: ${example.skill}`),
  p(`${content.labels.goal}: ${example.goal}`),
  p(`${content.labels.value}: ${example.value}`),
  p(`${content.labels.difficulty}: ${example.difficulty}`),
  p(example.decision));
  const hasAny = fields.some(key => draft[key].trim().length > 0);
  const save = () => {
    if (!hasAny) { setMissing(true); return; }
    if (tooLong) return;
    practice.setValue('result', serialize(draft));
    return practice.save();
  };
  const sourceDisclosure = h(Container, {
    as: 'details', border: 'all', padding: 'md', gap: 'sm',
  },
  h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
  p(content.labels.sourceExcerpt),
  p(content.labels.decisionCheck));

  return h(Container, {
    as: 'main',
    maxWidth: '4xl',
    marginX: 'auto',
    width: 'full',
    padding: 'lg',
    gap: 'lg',
  },
  h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
  h(Container, {
    as: 'section', gap: 'md', 'aria-labelledby': 'm102-example-title',
  },
  heading(content.labels.comparison, 'h2', 'm102-example-title'),
  p(content.labels.comparisonIntro),
  h(Container, { layout: 'responsive-split', gap: 'md', alignItems: 'stretch' },
    exampleCard('clarity', content.labels.clarityTitle, content.example.clarify),
    exampleCard('reformat', content.labels.formatTitle, content.example.reformat)),
  h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm102-change-heading' },
    heading(content.labels.changedFact, 'h3', 'm102-change-heading'),
    h(Container, { role: 'group', 'aria-label': content.labels.changedFact, layout: 'vertical', gap: 'sm' },
      h(Button, {
        variant: selectedFact === 'clear' ? 'primary' : 'secondary',
        'aria-pressed': selectedFact === 'clear',
        onClick: () => setSelectedFact('clear'),
      }, content.labels.clearFact),
      h(Button, {
        variant: selectedFact === 'layout' ? 'primary' : 'secondary',
        'aria-pressed': selectedFact === 'layout',
        onClick: () => setSelectedFact('layout'),
      }, content.labels.layoutFact),
      h(Button, {
        variant: selectedFact === 'unknown' ? 'primary' : 'secondary',
        'aria-pressed': selectedFact === 'unknown',
        onClick: () => setSelectedFact('unknown'),
      }, content.labels.unknownFact)),
    p(observedEffect, { role: 'status', 'aria-live': 'polite' }))),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm102-practice-heading' },
    heading(content.labels.practiceTitle, 'h2', 'm102-practice-heading'),
    p(content.labels.practiceIntro),
    p(content.labels.leaveOpen),
    field({ id: 'activity', label: content.fields[0].label, rows: 2 }),
    field({ id: 'skill', label: content.fields[1].label, rows: 2 }),
    field({ id: 'goal', label: content.fields[2].label, rows: 2 }),
    field({ id: 'value', label: content.fields[3].label, rows: 2 }),
    field({ id: 'difficulty', label: content.fields[4].label, rows: 2 }),
    field({ id: 'evidence', label: content.fields[5].label, rows: 3 }),
    field({ id: 'decision', label: content.fields[6].label, rows: 2 }),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm102-private-heading' },
      heading('Private practice', 'h3', 'm102-private-heading'),
      p(content.labels.private),
      missing ? h(Text, { as: 'p', id: 'm102-practice-missing', role: 'alert' }, content.labels.needAnswer) : null,
      h(Button, {
        variant: 'primary', fullWidth: true,
        disabled: practice.loading || practice.saving || tooLong,
        pendingLabel: content.labels.busy,
        errorLabel: content.labels.retry,
        onClick: save,
      }, practice.locked ? content.labels.retry : practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? p(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
  sourceDisclosure);
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
