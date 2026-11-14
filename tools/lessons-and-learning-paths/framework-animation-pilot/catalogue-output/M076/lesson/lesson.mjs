import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const blank = { broad: '', value: '', difficulty: '', moment: '', causes: '', test: '', responses: '', result: '' };
const parseObject = value => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

function Lesson({ surfaceInput, host }) {
  const [examples, setExamples] = useState(() => content.comparisonCases.map(row => ({ ...row })));
  const [attempt, setAttempt] = useState(blank);
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm076-difficulty-diagnostic',
    onRestore: record => {
      const restored = parseObject(record.result);
      const answers = restored?.answers;
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return;
      const next = Object.fromEntries(Object.keys(blank).map(key => [key, typeof answers[key] === 'string' ? answers[key] : '']));
      setAttempt(next);
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const isComplete = Object.values(attempt).every(value => value.trim().length > 0);
  const field = ({ id, label, value, onChange, rows = 2, error = false }) => h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
    h(Textarea, {
      id,
      rows,
      autoGrow: true,
      maxHeight: rows > 2 ? 220 : 160,
      value,
      disabled,
      'aria-invalid': error ? 'true' : undefined,
      'aria-describedby': error ? 'm076-practice-length-error' : undefined,
      onChange: event => onChange(event.target.value),
    }));
  const editExample = (caseId, key, value) => {
    setExamples(rows => rows.map(row => row.id === caseId ? { ...row, [key]: value } : row));
  };
  const exampleCards = examples.map(row => h(Container, {
    key: row.id,
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-labelledby': `m076-example-${row.id}`,
  },
  heading(row.title, 'h3', `m076-example-${row.id}`),
  field({ id: `m076-${row.id}-moment`, label: content.labels.moment, value: row.moment, onChange: value => editExample(row.id, 'moment', value), rows: 2 }),
  field({ id: `m076-${row.id}-cause`, label: content.labels.cause, value: row.cause, onChange: value => editExample(row.id, 'cause', value), rows: 3 }),
  field({ id: `m076-${row.id}-test`, label: content.labels.test, value: row.test, onChange: value => editExample(row.id, 'test', value), rows: 3 }),
  field({ id: `m076-${row.id}-response`, label: content.labels.response, value: row.response, onChange: value => editExample(row.id, 'response', value), rows: 3 }),
  field({ id: `m076-${row.id}-evidence`, label: content.labels.evidence, value: row.evidence, onChange: value => editExample(row.id, 'evidence', value), rows: 3 })));
  const updateAttempt = (key, value) => {
    const next = { ...attempt, [key]: value };
    setAttempt(next);
    const serialized = JSON.stringify({ answers: next });
    const over = serialized.length > 2000;
    setTooLong(over);
    practice.markEdited();
    if (!over) practice.setValue('result', serialized);
  };
  const save = () => practice.save();

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm076-comparison-heading' },
      heading(content.labels.comparison, 'h2', 'm076-comparison-heading'),
      p(content.labels.comparisonNote),
      h(Container, { layout: 'responsive-split', gap: 'md', alignItems: 'start' }, ...exampleCards)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm076-practice-heading' },
      heading(content.labels.attempt, 'h2', 'm076-practice-heading'),
      p('Use evidence to choose a response. Do not treat the 1-to-10 reports as a score or the first cause you name as a diagnosis.'),
      field({ id: 'm076-broad', label: content.labels.broad, value: attempt.broad, onChange: value => updateAttempt('broad', value), error: tooLong }),
      field({ id: 'm076-value', label: content.labels.value, value: attempt.value, onChange: value => updateAttempt('value', value), error: tooLong }),
      field({ id: 'm076-difficulty', label: content.labels.difficulty, value: attempt.difficulty, onChange: value => updateAttempt('difficulty', value), error: tooLong }),
      field({ id: 'm076-exact-moment', label: content.labels.exactMoment, value: attempt.moment, onChange: value => updateAttempt('moment', value), error: tooLong }),
      field({ id: 'm076-causes', label: content.labels.causes, value: attempt.causes, onChange: value => updateAttempt('causes', value), rows: 3, error: tooLong }),
      field({ id: 'm076-test-both', label: content.labels.testBoth, value: attempt.test, onChange: value => updateAttempt('test', value), rows: 3, error: tooLong }),
      field({ id: 'm076-responses', label: content.labels.responses, value: attempt.responses, onChange: value => updateAttempt('responses', value), rows: 3, error: tooLong }),
      field({ id: 'm076-result', label: content.labels.result, value: attempt.result, onChange: value => updateAttempt('result', value), rows: 3, error: tooLong }),
      p(content.labels.ending),
      !isComplete ? p(content.labels.needPractice) : null,
      tooLong ? h(Text, { as: 'p', id: 'm076-practice-length-error', role: 'alert' }, content.labels.oversize) : null,
      h(Button, {
        variant: 'primary',
        disabled: !isComplete || tooLong || practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? p(content.feedback.retryPending) : null,
      p(content.labels.private)),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
      h(Container, { gap: 'xs' }, ...content.labels.sourceExcerpt.split('\n').map((line, index) => p(line, { key: `source-${index}` })))));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
