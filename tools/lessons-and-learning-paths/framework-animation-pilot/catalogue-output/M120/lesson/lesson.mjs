import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const routeKeys = Object.keys(content.labels.routeDetails);
const fields = content.labels.fields.map(row => row.id);
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
  const [selectedRoute, setSelectedRoute] = useState('clarity');
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.labels.feedback,
    requestPrefix: 'm120-aa-alignment-check',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (!restored) return;
      setDraft(restored);
    },
  });
  const unavailable = practice.loading || practice.locked;
  const serialize = value => JSON.stringify(value);
  const tooLong = serialize(draft).length > 2000;
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.labels.feedback.saved ? 'done'
      : [content.labels.feedback.conflict, content.labels.feedback.saveFailure, content.labels.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const tooLongMessageId = 'm120-practice-length-error';
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
    practice.markEdited();
    practice.setValue('result', result);
  };
  const field = ({ id, label, rows = 2 }) => h(Container, { gap: 'xs' },
    h(Textarea, {
      id: `m120-${id}`,
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
  const selected = content.labels.routeDetails[selectedRoute];
  const hasAny = fields.some(key => draft[key].trim().length > 0);
  const save = () => {
    if (!hasAny) { setMissing(true); return; }
    practice.setValue('result', serialize(draft));
    return practice.save();
  };
  const sourceDisclosure = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt));

  return h(Container, {
    as: 'main',
    maxWidth: '4xl',
    marginX: 'auto',
    width: 'full',
    padding: 'lg',
    gap: 'lg',
  },
  h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm120-comparison-heading' },
    heading(content.labels.comparisonTitle, 'h2', 'm120-comparison-heading'),
    p(content.labels.comparisonIntro),
    h(Container, { role: 'group', 'aria-label': content.labels.routeGroup, gap: 'sm' },
      ...routeKeys.map(key => h(Button, {
        key,
        variant: selectedRoute === key ? 'primary' : 'secondary',
        'aria-pressed': selectedRoute === key,
        onClick: () => setSelectedRoute(key),
      }, content.labels[`route${key[0].toUpperCase()}${key.slice(1)}`]))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm120-route-heading' },
      heading(selected.title, 'h3', 'm120-route-heading'),
      h(Container, { gap: 'md' },
        ...[
          ['testQuestion', selected.question],
          ['resourceLimit', selected.resource],
          ['timeframe', selected.time],
          ['successSignal', selected.success],
          ['failureSignal', selected.failure],
          ['resultBoundary', selected.boundary],
        ].map(([labelKey, value]) => h(Container, { key: labelKey, gap: 'xs' },
          heading(content.labels[labelKey], 'h3'), p(value)))),
      p(content.labels.comparisonTakeaway))),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm120-practice-heading' },
    heading(content.labels.practiceTitle, 'h2', 'm120-practice-heading'),
    p(content.labels.practiceIntro),
    ...content.labels.fields.map(({ id, label }) => field({ id, label, rows: id === 'tension' || id === 'next' ? 3 : 2 })),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm120-private-heading' },
      heading('Private practice', 'h3', 'm120-private-heading'),
      p(content.labels.private),
      missing ? h(Text, { as: 'p', id: 'm120-practice-missing', role: 'alert' }, content.labels.needAnswer) : null,
      h(Button, {
        variant: 'primary', fullWidth: true,
        work: buttonWork,
        disabled: practice.loading || practice.saving,
        pendingLabel: content.labels.busy,
        errorLabel: practice.locked ? content.labels.retry : content.labels.save,
        doneLabel: content.labels.savedAction,
        onClick: save,
      }, practice.locked ? content.labels.retry : practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? p(content.labels.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
  sourceDisclosure);
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
