import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };
import figure from './figure.json' with { type: 'json' };

const h = React.createElement;
const fields = ['event', 'value', 'difficulty', 'change', 'next', 'patterns'];
const freshDraft = () => Object.fromEntries(fields.map(key => [key, '']));
const freshComparison = () => ({ facts: content.example.facts, meaning: content.example.meaning });

function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [comparison, setComparison] = useState(freshComparison);
  const [missing, setMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm087-passion-awareness-journal',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) { setDraft(saved); setDirty(false); }
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const setJournalField = key => event => {
    const next = { ...draft, [key]: event.target.value };
    setMissing(false);
    setDirty(true);
    setDraft(next);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(next));
  };
  const setComparisonField = key => event => setComparison(previous => ({ ...previous, [key]: event.target.value }));
  const save = async () => {
    if (!fields.some(key => draft[key].trim())) { setMissing(true); return false; }
    practice.setValue('result', JSON.stringify(draft));
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const tooLong = practice.status === content.feedback.length;
  const longestField = fields.reduce((largest, key) => draft[key].length > draft[largest].length ? key : largest, fields[0]);
  const textarea = (key, label, value, onChange, { errorLinked = false } = {}) => h(Container, { gap: 'xs' },
    h(Textarea, {
      label, rows: 3, autoGrow: true, maxHeight: 240, value, disabled,
      'aria-invalid': tooLong && errorLinked ? true : undefined,
      'aria-describedby': tooLong && errorLinked ? 'm087-practice-length-error' : undefined,
      onChange,
    }),
    tooLong && errorLinked ? para(practice.status, { id: 'm087-practice-length-error', role: 'alert' }) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm087-example-heading' },
      heading(content.labels.example, 'h2', 'm087-example-heading'),
      h(AnatomyFigure, { figure, label: content.labels.figure }),
      para(`${content.labels.broadLabel}: “${content.example.broad}”`),
      para(content.labels.comparisonPrompt),
      textarea('facts', content.labels.factsLabel, comparison.facts, setComparisonField('facts')),
      textarea('meaning', content.labels.meaningLabel, comparison.meaning, setComparisonField('meaning')),
      para(content.example.reading),
      para('These example edits are not saved as your personal experience. Only the journal entry below can be saved to your private practice record.'),
      para(content.source.boundary)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm087-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm087-practice-heading'), para(content.labels.practicePrompt)),
      textarea('event', content.labels.event, draft.event, setJournalField('event'), { errorLinked: longestField === 'event' }),
      textarea('value', content.labels.value, draft.value, setJournalField('value'), { errorLinked: longestField === 'value' }),
      textarea('difficulty', content.labels.difficulty, draft.difficulty, setJournalField('difficulty'), { errorLinked: longestField === 'difficulty' }),
      textarea('change', content.labels.change, draft.change, setJournalField('change'), { errorLinked: longestField === 'change' }),
      textarea('next', content.labels.next, draft.next, setJournalField('next'), { errorLinked: longestField === 'next' }),
      textarea('patterns', content.labels.patterns, draft.patterns, setJournalField('patterns'), { errorLinked: longestField === 'patterns' }),
      para(content.labels.private),
      h(Button, {
        variant: 'primary', fullWidth: true,
        work: dirty || tooLong ? null : undefined,
        disabled: practice.loading || practice.saving,
        pendingLabel: content.labels.saving,
        errorLabel: content.labels.retry,
        onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.feedback.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary' }, content.labels.source),
      para(content.source.quote), para(content.labels.sourceHint), para(content.source.attribution),
      para(content.source.boundary), para(content.connections)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
