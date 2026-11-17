import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fieldKeys = ['question', 'input', 'property', 'connection', 'evaluation'];
const wordList = ['spoon', 'window', 'seed', 'hinge', 'cloud', 'basket', 'ribbon', 'key', 'shell', 'ladder', 'button', 'river'];
const emptyDraft = () => Object.fromEntries(fieldKeys.map(key => [key, '']));
function restoreDraft(value) {
  try {
    const parsed = JSON.parse(value);
    return Object.fromEntries(fieldKeys.map(key => [key, typeof parsed?.[key] === 'string' ? parsed[key] : '']));
  } catch { return emptyDraft(); }
}

function Lesson({ surfaceInput, host }) {
  const [optionId, setOptionId] = useState(content.example.options[0].id);
  const [comparisonConnection, setComparisonConnection] = useState(content.example.options[0].connection);
  const [draft, setDraft] = useState(emptyDraft);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm106-random-input',
    onRestore: record => setDraft(restoreDraft(record.result)),
  });
  const serialized = JSON.stringify(draft);
  const overLimit = serialized.length > 2000;
  const hasDraft = fieldKeys.some(key => draft[key].trim());
  const disabled = practice.loading || practice.locked;
  const option = content.example.options.find(row => row.id === optionId) ?? content.example.options[0];
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const practiceField = key => {
    const invalidMissing = key === 'question' && saveAttempted && !hasDraft;
    const invalid = overLimit || invalidMissing;
    const errorId = overLimit ? 'm106-draft-length-error' : invalidMissing ? 'm106-draft-missing-error' : undefined;
    const error = overLimit ? content.feedback.length : invalidMissing ? content.feedback.missing : null;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: `m106-${key}` }, content.practice[key]),
      h(Textarea, {
        id: `m106-${key}`,
        rows: key === 'question' || key === 'evaluation' ? 3 : 2,
        autoGrow: true,
        maxHeight: 260,
        value: draft[key],
        disabled,
        'aria-invalid': invalid ? 'true' : undefined,
        'aria-describedby': errorId,
        onChange: event => {
          const updated = { ...draft, [key]: event.target.value };
          setDraft(updated);
          setSaveAttempted(false);
          practice.markEdited();
          practice.setValue('result', JSON.stringify(updated));
        },
      }),
      key === 'question' && overLimit ? paragraph(content.feedback.length, { id: 'm106-draft-length-error', role: 'alert' }) : null,
      key === 'question' && invalidMissing ? paragraph(content.feedback.missing, { id: 'm106-draft-missing-error', role: 'alert' }) : null);
  };
  const drawWord = () => {
    if (disabled) return;
    const index = Math.floor(Math.random() * wordList.length);
    const updated = { ...draft, input: wordList[index] };
    setDraft(updated);
    setDrawn(true);
    setSaveAttempted(false);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(updated));
  };
  const save = () => {
    setSaveAttempted(true);
    if (!hasDraft || overLimit) return;
    practice.setValue('result', serialized);
    return practice.save();
  };
  const comparison = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm106-comparison-heading' },
    heading(content.example.heading, 'h2', 'm106-comparison-heading'),
    paragraph(content.example.context),
    h(Container, { role: 'group', 'aria-label': content.example.comparisonLabel, layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
      ...content.example.options.map(row => h(Button, {
        key: row.id,
        variant: optionId === row.id ? 'primary' : 'secondary',
        'aria-pressed': optionId === row.id,
        onClick: () => { setOptionId(row.id); setComparisonConnection(row.connection); },
      }, `${row.input} input`))),
    h(Container, { gap: 'sm', 'aria-labelledby': 'm106-example-input-heading' },
      heading(`${option.input}: one property, one candidate`, 'h3', 'm106-example-input-heading'),
      paragraph(`Property: ${option.property}`),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm106-example-connection' }, content.labels.candidate),
        h(Textarea, {
          id: 'm106-example-connection', rows: 2, autoGrow: true, maxHeight: 180,
          value: comparisonConnection,
          onChange: event => setComparisonConnection(event.target.value),
        })),
      paragraph(option.fit),
      paragraph(`Limit: ${option.limit}`),
      paragraph(`A small check: ${option.check}`)),
    paragraph(content.example.boundary));
  const privatePractice = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm106-practice-heading' },
    heading(content.labels.practiceHeading, 'h2', 'm106-practice-heading'),
    paragraph(content.labels.practiceIntro),
    practice.loading ? paragraph('Loading your saved draft.', { role: 'status', 'aria-live': 'polite' }) : null,
    practiceField('question'),
    h(Container, { gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm106-input' }, content.practice.input),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
        h(Textarea, {
          id: 'm106-input', rows: 2, autoGrow: true, maxHeight: 180,
          value: draft.input, disabled,
          'aria-invalid': overLimit ? 'true' : undefined,
          'aria-describedby': overLimit ? 'm106-draft-length-error' : undefined,
          onChange: event => {
            const updated = { ...draft, input: event.target.value };
            setDraft(updated); setDrawn(false); setSaveAttempted(false); practice.markEdited(); practice.setValue('result', JSON.stringify(updated));
          },
        }),
        h(Button, { variant: 'secondary', disabled, onClick: drawWord }, content.labels.draw)),
      drawn ? paragraph(content.labels.drawHelp) : null,
    ),
    ...['property', 'connection', 'evaluation'].map(practiceField),
    paragraph(content.labels.privacy),
    practice.locked ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
    h(Button, {
      variant: 'primary', disabled: practice.loading || practice.saving, onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? paragraph(practice.status, { id: 'm106-practice-status', role: 'status', 'aria-live': 'polite' }) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    paragraph(content.labels.sourceQuote), paragraph(content.labels.sourceLocator));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    comparison,
    privatePractice,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
