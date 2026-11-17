import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const fields = ['example', 'change'];
const freshDraft = () => Object.fromEntries(fields.map(key => [key, '']));
function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [question, setQuestion] = useState(content.example.question);
  const [input, setInput] = useState('unfamiliar');
  const [property, setProperty] = useState('feedback');
  const [draft, setDraft] = useState(freshDraft);
  const [missing, setMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [buttonEpoch, setButtonEpoch] = useState(0);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm104-novelty-challenge',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => { setMissing(false); setDirty(true); setButtonEpoch(value => value + 1); practice.markEdited(); action(); };
  const setField = key => event => mark(() => setDraft(previous => ({ ...previous, [key]: event.target.value })));
  const save = async () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return false; }
    practice.setValue('result', JSON.stringify(draft));
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const tooLong = practice.status === content.feedback.length;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const textarea = (key, label) => h(Container, { gap: 'xs' },
    h(Textarea, {
      label, rows: 3, autoGrow: true, maxHeight: 260, value: draft[key], disabled,
      'aria-invalid': tooLong && key === longestField ? true : undefined,
      'aria-describedby': tooLong && key === longestField ? 'm104-practice-length-error' : undefined,
      onChange: setField(key),
    }),
    tooLong && key === longestField ? para(content.feedback.length, { id: 'm104-practice-length-error', role: 'alert' }) : null);
  const choose = (label, value, selected, onClick) => h(Button, {
    variant: selected ? 'primary' : 'outline', active: selected, 'aria-pressed': selected,
    onClick,
  }, label);
  const observation = input === 'familiar'
    ? content.example.familiar
    : property === 'feedback' ? content.example.feedback : content.example.appearance;
  const row = content.example;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm104-model-heading' },
      heading(content.labels.model, 'h2', 'm104-model-heading'),
      h(Textarea, { label: content.labels.question, rows: 2, autoGrow: true, maxHeight: 180, value: question, onChange: event => setQuestion(event.target.value) }),
      h(Container, { as: 'div', gap: 'sm', role: 'group', 'aria-label': content.labels.input },
        choose(content.labels.familiar, 'familiar', input === 'familiar', () => { setInput('familiar'); setProperty('feedback'); }),
        choose(content.labels.unfamiliar, 'unfamiliar', input === 'unfamiliar', () => setInput('unfamiliar'))),
      input === 'unfamiliar'
        ? h(Container, { gap: 'sm' },
          h(Text, { as: 'p', variant: 'body' }, content.labels.property),
          h(Container, { as: 'div', gap: 'sm', role: 'group', 'aria-label': content.labels.property },
            choose(content.labels.feedbackProperty, 'feedback', property === 'feedback', () => setProperty('feedback')),
            choose(content.labels.appearanceProperty, 'appearance', property === 'appearance', () => setProperty('appearance'))))
        : null,
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm104-result-heading' },
        heading(content.labels.result, 'h3', 'm104-result-heading'),
        para(`${content.labels.question}: ${question || 'No current question entered.'}`),
        para(input === 'unfamiliar' ? row.puzzle : row.familiar),
        input === 'unfamiliar' ? para(observation) : null,
        input === 'unfamiliar' && property === 'feedback' ? para(row.transfer) : null),
      para(content.labels.nearMiss)),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      para(content.labels.sourceQuote), para(content.labels.sourceHint),
      para(content.labels.sourceBoundary)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm104-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm104-practice-heading'),
        para('Use a different medium from the puzzle. Explore a bounded example, name the property that matters, then say what it changes about your question. An unrelated or unsafe example can be set aside.')),
      textarea('example', content.labels.example), textarea('change', content.labels.change),
      para(content.labels.private),
      h(Button, {
        key: buttonEpoch, variant: 'primary', fullWidth: true, doneLabel: content.labels.done,
        disabled: practice.loading || practice.saving, pendingLabel: content.labels.saving,
        errorLabel: content.labels.retry, onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.feedback.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
