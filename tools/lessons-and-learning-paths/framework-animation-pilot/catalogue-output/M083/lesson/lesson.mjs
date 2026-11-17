import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [selected, setSelected] = useState(content.operations[0].id);
  const [draft, setDraft] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm083-value-suffering-reframe',
    onRestore: record => setDraft(typeof record.result === 'string' ? record.result : ''),
  });
  const disabled = practice.loading || practice.saving || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const card = operation => {
    const active = selected === operation.id;
    const id = `m083-operation-${operation.id}`;
    return h(Container, {
      key: operation.id,
      as: 'section',
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': id,
    },
      heading(operation.name, 'h3', id),
      heading(content.labels.difficulty, 'h3'), p(operation.difficulty),
      heading(content.labels.claimedValue, 'h3'), p(operation.claimedValue),
      h(Button, {
        variant: active ? 'primary' : 'secondary',
        'aria-pressed': active,
      'aria-label': `${content.labels.inspect}: ${operation.name}`,
        onClick: () => setSelected(operation.id),
    }, content.labels.inspect));
  };
  const operation = content.operations.find(row => row.id === selected) ?? content.operations[0];
  const field = h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm083-private-map' }, content.labels.practiceField),
    h(Textarea, {
      id: 'm083-private-map',
      rows: 10,
      autoGrow: true,
      maxHeight: 320,
      placeholder: content.labels.practicePlaceholder,
      'aria-label': content.labels.practiceField,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm083-practice-length-error' : undefined,
      value: draft,
      disabled,
      onChange: event => {
        const value = event.target.value;
        setDraft(value);
        setTooLong(value.length > 2000);
        practice.markEdited();
        if (value.length <= 2000) practice.setValue('result', value);
      },
    }));
  const practiceCard = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'md',
    'aria-labelledby': 'm083-practice-heading',
  },
    heading(content.labels.attempt, 'h2', 'm083-practice-heading'),
    p(content.labels.attemptIntro),
    field,
    tooLong ? h(Text, { as: 'p', id: 'm083-practice-length-error', variant: 'body', role: 'alert' }, content.labels.oversize) : null,
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving || tooLong,
      onClick: () => { void practice.save(); },
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    p(content.labels.private),
    practice.status ? h(Text, { as: 'p', variant: 'body', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt), p(content.source.manuscriptLocator));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm083-example-heading' },
      heading(content.labels.example, 'h2', 'm083-example-heading'),
      p(content.labels.exampleContext),
      heading(content.labels.map, 'h3', 'm083-map-heading'),
      h(Container, { gap: 'md', 'aria-label': content.labels.map },
        ...content.operations.map(card)),
      h(Container, { as: 'section', border: 'quote', padding: 'md', gap: 'xs', 'aria-live': 'polite', 'aria-atomic': 'true' },
        heading(content.labels.operation, 'h3'), p(operation.name),
        heading(content.labels.difficulty, 'h3'), p(operation.difficulty),
        heading(content.labels.claimedValue, 'h3'), p(operation.claimedValue),
        heading(operation.id === 'accuracy-check' ? content.labels.supported : content.labels.unsupported, 'h3'),
        p(operation.actualContribution),
        heading('Decision', 'h3'), p(operation.decision))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm083-redesign-heading' },
      heading(content.labels.redesign, 'h2', 'm083-redesign-heading'), p(content.labels.redesignBody)),
    h(Container, { as: 'section', border: 'quote', padding: 'md', gap: 'xs', 'aria-labelledby': 'm083-question-heading' },
      heading(content.labels.question, 'h2', 'm083-question-heading'), p(content.labels.questionAnswer)),
    practiceCard,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
