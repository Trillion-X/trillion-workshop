import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const practiceFields = [...content.dimensions.map(row => row.key), 'continuation'];
const emptyMap = () => Object.fromEntries(practiceFields.map(key => [key, '']));
const parseMap = value => {
  if (typeof value !== 'string') return emptyMap();
  try {
    const parsed = JSON.parse(value);
    return Object.fromEntries(practiceFields.map(key => [key, typeof parsed?.[key] === 'string' ? parsed[key] : '']));
  } catch { return emptyMap(); }
};

function Lesson({ surfaceInput, host }) {
  const [map, setMap] = useState(emptyMap);
  const [attempted, setAttempted] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm096-two-paths',
    onRestore: record => setMap(parseMap(record.result)),
  });
  const disabled = practice.loading || practice.locked;
  const invalid = key => attempted && !map[key].trim();
  const tooLong = practice.values.result.length > 2000;
  const missing = attempted && practiceFields.some(key => !map[key].trim());
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const textarea = (key, label, index) => {
    const errorId = `m096-field-${key}-error`;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: `m096-field-${key}` }, label),
      h(Textarea, {
        id: `m096-field-${key}`, rows: index === 5 ? 3 : 2, autoGrow: true, maxHeight: 240,
        value: map[key], disabled, required: true,
        'aria-invalid': invalid(key) || tooLong ? 'true' : undefined,
        'aria-describedby': invalid(key) || tooLong ? (missing ? 'm096-practice-missing-error' : errorId) : undefined,
        onChange: event => {
          const next = { ...map, [key]: event.target.value };
          setMap(next);
          practice.markEdited();
          practice.setValue('result', JSON.stringify(next));
        },
      }),
      tooLong && !missing ? paragraph(content.feedback.length, { id: errorId, role: 'alert' }) : null);
  };
  const save = async () => {
    setAttempted(true);
    if (practiceFields.some(key => !map[key].trim()) || tooLong) return;
    await practice.save();
  };
  const dimensions = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm096-comparison-heading' },
    heading(content.labels.comparison, 'h2', 'm096-comparison-heading'),
    ...content.dimensions.map(row => h(Container, {
      key: row.key, as: 'article', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': `m096-${row.key}-heading`,
    },
    heading(row.label, 'h3', `m096-${row.key}-heading`),
    h(Container, { gap: 'xs' },
      h(Text, { as: 'h4', variant: 'heading-sm' }, content.labels.institutionalHeading),
      paragraph(row.institutional)),
    h(Container, { gap: 'xs' },
      h(Text, { as: 'h4', variant: 'heading-sm' }, content.labels.sovereignHeading),
      paragraph(row.sovereign)))));
  const illustration = h(Container, { as: 'section', border: 'all', padding: 'lg', gap: 'md', 'aria-labelledby': 'm096-illustration-heading' },
    heading(content.labels.illustration, 'h2', 'm096-illustration-heading'),
    paragraph(content.labels.illustrationNote),
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.mixedHeading),
      paragraph(content.labels.mixedExample)),
    paragraph(content.labels.takeaway));
  const privatePractice = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm096-practice-heading' },
    heading(content.labels.practiceHeading, 'h2', 'm096-practice-heading'),
    paragraph(content.labels.practiceIntro),
    practice.loading ? paragraph('Loading your saved map.', { role: 'status', 'aria-live': 'polite' }) : null,
    ...content.dimensions.map((row, index) => textarea(row.key, content.labels[row.key], index)),
    textarea('continuation', content.labels.continuation, 5),
    missing ? paragraph(content.feedback.missing, { id: 'm096-practice-missing-error', role: 'alert' }) : null,
    practice.values.result.length > 2000 ? paragraph(content.feedback.length, { id: 'm096-practice-length-error', role: 'alert' }) : null,
    paragraph(content.labels.privacy),
    practice.locked ? paragraph(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', work: null,
      disabled: practice.loading || practice.saving,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? paragraph(practice.status, { id: 'm096-practice-status', role: 'status', 'aria-live': 'polite' }) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    paragraph(content.labels.sourceQuote),
    paragraph(content.labels.sourceLocator));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    dimensions,
    illustration,
    privatePractice,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
