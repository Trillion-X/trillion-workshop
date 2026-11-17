import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const choices = [
  ['coexist', content.labels.combination],
  ['constraint', content.labels.constraintChoice],
  ['unclear', content.labels.unclear],
];
const emptyAttempt = () => ({ statement: '', demands: '', assumption: '', classification: '', case: '', action: '', signal: '' });

function parseAttempt(value) {
  if (typeof value !== 'string') return emptyAttempt();
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyAttempt();
    const result = emptyAttempt();
    for (const key of Object.keys(result)) result[key] = typeof parsed[key] === 'string' ? parsed[key] : '';
    if (!choices.some(([id]) => id === result.classification)) result.classification = '';
    return result;
  } catch { return emptyAttempt(); }
}

function Lesson({ surfaceInput, host }) {
  const [attempt, setAttempt] = useState(emptyAttempt);
  const [tooLong, setTooLong] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: {
      unavailable: 'Private practice is unavailable in this lesson.',
      missing: content.labels.requiredError,
      length: content.labels.lengthError,
      saved: content.labels.saved,
      conflict: 'Another saved version changed. Compare it before you save again.',
      readbackFailure: content.labels.saveError,
      saveFailure: content.labels.saveError,
      readFailure: content.labels.saveError,
    },
    requestPrefix: 'm072-distinction-dissolution',
    onRestore: record => setAttempt(parseAttempt(record.result)),
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const valid = Boolean(attempt.statement.trim() && attempt.demands.trim() && attempt.assumption.trim()
    && attempt.classification && attempt.case.trim() && attempt.action.trim() && attempt.signal.trim());
  const update = (key, value) => {
    const next = { ...attempt, [key]: value };
    setAttempt(next);
    const result = JSON.stringify(next);
    const overflow = result.length > 2000;
    setTooLong(overflow);
    practice.markEdited();
    if (!overflow) practice.setValue('result', result);
  };
  const requiredErrorId = 'm072-attempt-required-error';
  const lengthErrorId = 'm072-attempt-length-error';
  const field = (key, label, rows = 2) => {
    const missing = submitted && !attempt[key]?.trim();
    const errorId = tooLong ? lengthErrorId : missing ? requiredErrorId : undefined;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: `m072-${key}` }, label),
      h(Textarea, {
        id: `m072-${key}`,
        rows,
        autoGrow: true,
        maxHeight: rows > 2 ? 220 : 160,
        value: attempt[key],
        disabled,
        required: true,
        'aria-required': 'true',
        'aria-invalid': tooLong || missing ? 'true' : undefined,
        'aria-describedby': errorId,
        onChange: event => update(key, event.target.value),
      }));
  };
  const example = (row, second = false) => h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'sm',
    'aria-labelledby': second ? 'm072-constraint-title' : 'm072-coexist-title',
  },
  heading(row.title, 'h2', second ? 'm072-constraint-title' : 'm072-coexist-title'),
  h(Text, { as: 'p', variant: 'body' }, h('strong', null, row.pair)),
  p(row.demands),
  p(row.test),
  p(row.limit));
  const classificationInvalid = submitted && !attempt.classification;
  const feedbackId = tooLong ? lengthErrorId : classificationInvalid ? requiredErrorId : undefined;
  const canSave = !tooLong && !practice.loading && !practice.saving;
  const save = () => {
    setSubmitted(true);
    if (!valid) return;
    practice.save();
  };
  const saveArea = h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-labelledby': 'm072-practice-title',
  },
    heading(content.labels.practiceTitle, 'h2', 'm072-practice-title'),
    p(content.labels.practiceDescription),
    tooLong ? h(Text, { as: 'p', id: lengthErrorId, role: 'alert' }, content.labels.lengthError) : null,
    submitted && !valid && !tooLong ? h(Text, { as: 'p', id: requiredErrorId, role: 'alert' }, content.labels.requiredError) : null,
    h(Button, {
      variant: 'primary',
      disabled: !canSave,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.labels.saveError) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm072-mechanism-title' },
      heading('Test the boundary', 'h2', 'm072-mechanism-title'),
      p(content.teaching.mechanism)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm072-examples-title' },
      heading('Two cases, two different answers', 'h2', 'm072-examples-title'),
      example(content.teaching.falseExclusivity),
      example(content.teaching.constraint, true)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm072-attempt-title' },
      heading(content.labels.attemptTitle, 'h2', 'm072-attempt-title'),
      p(content.labels.attemptIntro),
      field('statement', content.labels.statement),
      field('demands', content.labels.demands, 3),
      field('assumption', content.labels.assumption, 3),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'p', variant: 'body' }, content.labels.classification),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.classification,
          'aria-required': 'true', 'aria-invalid': classificationInvalid || tooLong ? 'true' : undefined,
          'aria-describedby': feedbackId },
        ...choices.map(([id, label]) => h(Button, {
          key: id,
          variant: attempt.classification === id ? 'primary' : 'secondary',
          'aria-pressed': attempt.classification === id,
          disabled,
          onClick: () => update('classification', id),
        }, label))),
      ),
      field('case', content.labels.case, 3),
      field('action', content.labels.action, 3),
      field('signal', content.labels.signal, 3)),
    saveArea,
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
      p(`“${content.labels.sourceExcerpt}”`)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
