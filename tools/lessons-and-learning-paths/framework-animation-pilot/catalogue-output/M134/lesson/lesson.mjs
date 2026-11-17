import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = content.practice.fields.map(row => row.id);
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
  const [selectedStep, setSelectedStep] = useState('recognize');
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [exampleLoaded, setExampleLoaded] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm134-three-r-method',
    onRestore: record => {
      const saved = restoreDraft(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const unavailable = practice.loading || practice.locked;
  const serialized = JSON.stringify(draft);
  const tooLong = serialized.length > 2000;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (key, value) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    setDirty(true);
    setMissing(false);
    setExampleLoaded(false);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(next));
  };
  const edit = key => event => {
    const value = event.currentTarget.value;
    update(key, value);
  };
  const loadExample = () => {
    const next = { ...content.practice.example };
    setDraft(next);
    setDirty(true);
    setMissing(false);
    setExampleLoaded(true);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(next));
  };
  const save = () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return; }
    practice.setValue('result', serialized);
    return practice.save().then(saved => { if (saved) setDirty(false); return saved; });
  };
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved && !dirty ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const field = row => {
    const invalid = tooLong && row.id === longestField;
    return h(Container, { gap: 'xs', key: row.id },
      h(Textarea, {
        id: `m134-${row.id}`,
        label: row.label,
        rows: row.id === 'observation' || row.id === 'hypothesis' ? 4 : 3,
        autoGrow: true,
        maxHeight: 260,
        value: draft[row.id],
        disabled: unavailable,
        'aria-invalid': invalid ? true : undefined,
        'aria-describedby': invalid ? 'm134-practice-length-error' : undefined,
        onChange: edit(row.id),
      }),
      invalid ? para(content.practice.length, { id: 'm134-practice-length-error', role: 'alert' }) : null);
  };
  const step = content.lesson.steps[selectedStep];
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm134-explanation-heading' },
      heading(content.lesson.heading, 'h2', 'm134-explanation-heading'),
      para(content.lesson.text),
      para(content.lesson.hypothesisNote)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm134-steps-heading' },
      heading(content.lesson.stepsHeading, 'h2', 'm134-steps-heading'),
      h(Container, { as: 'div', role: 'group', 'aria-label': content.lesson.stepPrompt, layout: 'responsive-split', gap: 'sm' },
        ...Object.entries(content.lesson.steps).map(([key, row]) => h(Button, {
          key, variant: selectedStep === key ? 'primary' : 'secondary', 'aria-pressed': selectedStep === key,
          onClick: () => setSelectedStep(key),
        }, row.label))),
      para(step.text, { role: 'status', 'aria-live': 'polite' })),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm134-practice-heading' },
      heading(content.practice.heading, 'h2', 'm134-practice-heading'),
      para(content.practice.intro),
      h(Button, { variant: 'secondary', disabled: unavailable, onClick: loadExample }, content.practice.loadExample),
      exampleLoaded ? para(content.practice.sampleLoaded, { role: 'status', 'aria-live': 'polite' }) : null,
      ...content.practice.fields.map(field),
      para(content.practice.optional),
      h(Button, {
        variant: 'primary', fullWidth: true, work: buttonWork,
        doneLabel: content.practice.done,
        disabled: practice.loading,
        pendingLabel: content.practice.saving,
        errorLabel: practice.locked ? content.practice.retry : content.practice.save,
        onClick: save,
      }, practice.saving ? content.practice.saving : practice.locked ? content.practice.retry : content.practice.save),
      missing ? para(content.practice.missing, { role: 'alert' }) : null,
      tooLong && !missing ? para(content.feedback.length, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.practice.source.label),
      para(content.practice.source.quote),
      para(content.practice.source.locator)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
