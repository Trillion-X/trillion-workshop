import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = Object.keys(content.practice);
const freshDraft = () => Object.fromEntries(fields.map(key => [key, '']));

function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [example, setExample] = useState({ reward: content.example.reward, reason: content.example.reason });
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm095-because-of-audit',
    onRestore: record => {
      const restored = restore(record.result);
      if (restored) setDraft(restored);
    },
  });
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const setPracticeField = key => event => {
    const next = { ...draft, [key]: event.target.value };
    setDraft(next);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(next));
  };
  const setExampleField = key => event => setExample(previous => ({ ...previous, [key]: event.target.value }));
  const oversized = practice.status === content.feedback.length;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const field = (key, label, value, onChange, { rows = 3, errorLinked = false, disabled = practice.loading || practice.locked } = {}) => {
    const id = `m095-${key}`;
    const errorId = `${id}-length-error`;
    const linkedError = oversized && errorLinked;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
      h(Textarea, {
        id, rows, autoGrow: true, maxHeight: 240, value, disabled,
        'aria-invalid': linkedError ? true : undefined,
        'aria-describedby': linkedError ? errorId : undefined,
        onChange,
      }),
      linkedError ? paragraph(content.feedback.length, { id: errorId, role: 'alert' }) : null);
  };
  const hasDraft = fields.some(key => draft[key].trim().length > 0);
  const save = async () => {
    practice.setValue('result', JSON.stringify(draft));
    return practice.save();
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm095-example-heading' },
      heading(content.labels.example, 'h2', 'm095-example-heading'),
      paragraph(content.example.action),
      h(Container, { layout: 'responsive-split', gap: 'md' },
        field('example-reward', content.labels.exampleReward, example.reward, setExampleField('reward'), { disabled: false }),
        field('example-reason', content.labels.exampleReason, example.reason, setExampleField('reason'), { disabled: false })),
      paragraph(content.example.reading),
      paragraph(content.example.nearMiss),
      paragraph(content.example.boundary)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm095-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm095-practice-heading'), paragraph(content.labels.practicePrompt)),
      field('actions', content.labels.actions, draft.actions, setPracticeField('actions'), { rows: 4, errorLinked: longestField === 'actions' }),
      field('reasons', content.labels.reasons, draft.reasons, setPracticeField('reasons'), { rows: 4, errorLinked: longestField === 'reasons' }),
      field('own-sake', content.labels.ownSake, draft.ownSake, setPracticeField('ownSake'), { rows: 3, errorLinked: longestField === 'ownSake' }),
      field('tomorrow', content.labels.tomorrow, draft.tomorrow, setPracticeField('tomorrow'), { rows: 2, errorLinked: longestField === 'tomorrow' }),
      paragraph(content.labels.private),
      !hasDraft && !practice.loading ? paragraph(content.feedback.missing, { role: 'status' }) : null,
      practice.loading ? paragraph('Loading your private draft.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
      h(Button, {
        variant: 'primary', fullWidth: true,
        disabled: practice.loading || !hasDraft,
        pendingLabel: content.labels.saving,
        doneLabel: 'Draft saved',
        errorLabel: content.labels.retry,
        onClick: save,
      }, practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !(oversized && practice.status === content.feedback.length)
        ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      paragraph(content.source.quote),
      paragraph(content.labels.sourceHint),
      paragraph(content.source.attribution),
      paragraph(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
