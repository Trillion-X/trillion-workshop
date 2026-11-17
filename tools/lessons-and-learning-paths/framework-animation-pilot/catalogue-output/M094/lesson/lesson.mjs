import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const blankFollowup = id => ({ id, question: '', answer: '' });
const blankDraft = () => ({ moment: '', situation: '', answer: '', consequence: '', followups: [] });
const textKeys = ['situation', 'answer', 'consequence'];

function parseRecord(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      moment: content.moments.some(row => row.id === parsed.moment) ? parsed.moment : '',
      situation: typeof parsed.situation === 'string' ? parsed.situation : '',
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      consequence: typeof parsed.consequence === 'string' ? parsed.consequence : '',
      followups: Array.isArray(parsed.followups) ? parsed.followups
        .filter(row => row && typeof row === 'object')
        .map((row, index) => ({
          ...blankFollowup(typeof row.id === 'string' ? row.id : `followup-${index + 1}`),
          question: typeof row.question === 'string' ? row.question : '',
          answer: typeof row.answer === 'string' ? row.answer : '',
        })) : [],
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blankDraft);
  const [nextId, setNextId] = useState(0);
  const [missing, setMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [buttonEpoch, setButtonEpoch] = useState(0);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm094-daily-questioning',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (!restored) return;
      setDraft(restored);
      setDirty(false);
      setNextId(restored.followups.reduce((max, row) => {
        const match = /^followup-(\d+)$/.exec(row.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0));
    },
  });
  const disabled = practice.loading || practice.locked;
  const selectedMoment = content.moments.find(row => row.id === draft.moment);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const markEdited = action => {
    setMissing(false);
    setDirty(true);
    setButtonEpoch(value => value + 1);
    practice.markEdited();
    action();
  };
  const setValue = key => event => {
    const value = event.currentTarget.value;
    markEdited(() => setDraft(previous => ({ ...previous, [key]: value })));
  };
  const chooseMoment = moment => markEdited(() => setDraft(previous => ({ ...previous, moment })));
  const addFollowup = () => markEdited(() => {
    const id = `followup-${nextId + 1}`;
    setNextId(value => value + 1);
    setDraft(previous => ({ ...previous, followups: [...previous.followups, blankFollowup(id)] }));
  });
  const editFollowup = (id, key) => event => {
    const value = event.currentTarget.value;
    markEdited(() => setDraft(previous => ({
      ...previous,
      followups: previous.followups.map(row => row.id === id ? { ...row, [key]: value } : row),
    })));
  };
  const removeFollowup = id => markEdited(() => setDraft(previous => ({
    ...previous, followups: previous.followups.filter(row => row.id !== id),
  })));
  const serialized = () => JSON.stringify(draft);
  const tooLong = serialized().length > 2000 || practice.status === content.feedback.length;
  const lengthFields = [
    ...textKeys.map(key => ({ id: `m094-${key}`, value: draft[key] })),
    ...draft.followups.flatMap(row => ['question', 'answer'].map(key => ({ id: `m094-${row.id}-${key}`, value: row[key] }))),
  ];
  const longest = lengthFields.reduce((best, row) => row.value.length > best.value.length ? row : best, { id: 'm094-answer', value: '' });
  const hasWords = textKeys.some(key => draft[key].trim())
    || draft.followups.some(row => row.question.trim() || row.answer.trim());
  const describedBy = (id, isDraftField) => [
    tooLong && longest.id === id ? 'm094-length-error' : null,
    missing && isDraftField ? 'm094-missing-error' : null,
  ].filter(Boolean).join(' ') || undefined;
  const invalid = (id, isDraftField) => (tooLong && longest.id === id) || (missing && isDraftField) ? true : undefined;
  const textarea = (id, label, value, onChange, rows = 3, isDraftField = false, showMissing = false) => h(Container, { gap: 'xs' },
    h(Textarea, {
      id, label, rows, autoGrow: true, maxHeight: 240, value, disabled,
      'aria-invalid': invalid(id, isDraftField), 'aria-describedby': describedBy(id, isDraftField), onChange,
    }),
    tooLong && longest.id === id ? para(content.feedback.length, { id: 'm094-length-error', role: 'alert' }) : null,
    missing && showMissing ? para(content.feedback.missing, { id: 'm094-missing-error', role: 'alert' }) : null);
  const save = async () => {
    if (!hasWords) { setMissing(true); return false; }
    if (tooLong) return false;
    practice.setValue('result', serialized());
    const result = await practice.save();
    if (result) setDirty(false);
    return result;
  };
  const exampleSteps = content.moments.map((moment, index) => h(Container, {
    key: moment.id, as: 'section', width: 'full', border: 'all', padding: 'md', gap: 'sm',
    'aria-labelledby': `m094-example-${moment.id}`,
  },
  heading(`${index + 1}. ${moment.label}`, 'h3', `m094-example-${moment.id}`),
  para(moment.example),
  moment.id === 'resistance' ? para('This branch is optional; no cause is supplied or required.') : null));
  const followups = draft.followups.map((row, index) => h(Container, {
    key: row.id, as: 'section', border: 'all', padding: 'md', gap: 'md',
    'aria-labelledby': `m094-followup-heading-${row.id}`,
  },
  heading(`Follow-up ${index + 1}`, 'h3', `m094-followup-heading-${row.id}`),
  textarea(`m094-${row.id}-question`, content.labels.followupQuestion, row.question, editFollowup(row.id, 'question')),
  textarea(`m094-${row.id}-answer`, content.labels.followupAnswer, row.answer, editFollowup(row.id, 'answer')),
  h(Button, { variant: 'secondary', disabled, onClick: () => removeFollowup(row.id) }, `${content.labels.removeFollowup} ${index + 1}`)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { as: 'header', gap: 'sm' }, heading(content.title, 'h1', 'm094-title'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm094-example-heading' },
      heading(content.labels.workedExample, 'h2', 'm094-example-heading'),
      para(content.labels.exampleNote),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' }, ...exampleSteps),
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        heading('When a clear plan is enough', 'h3'), para(content.nearMiss))),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm094-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm094-practice-heading'), para(content.labels.practiceIntro)),
      h(Container, { as: 'fieldset', border: 'all', padding: 'md', gap: 'md' },
        h(Text, { as: 'legend', variant: 'body' }, content.labels.moment),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' }, ...content.moments.map(moment => h(Button, {
          key: moment.id, variant: draft.moment === moment.id ? 'primary' : 'secondary', disabled,
          'aria-pressed': draft.moment === moment.id,
          onClick: () => chooseMoment(moment.id),
        }, moment.label))),
        selectedMoment ? h(Container, { border: 'all', padding: 'md', gap: 'sm', 'aria-live': 'polite' },
          h(Text, { as: 'p', variant: 'heading' }, selectedMoment.prompt), para(selectedMoment.guidance))
          : para('Choose one moment to reveal its question. You can stop after that one.')),
      textarea('m094-situation', content.labels.situation, draft.situation, setValue('situation'), 3, true),
      textarea('m094-answer', content.labels.answer, draft.answer, setValue('answer'), 3, true, true),
      textarea('m094-consequence', content.labels.consequence, draft.consequence, setValue('consequence'), 3, true),
      h(Container, { gap: 'md' },
        h(Container, { gap: 'sm' }, heading(content.labels.followups, 'h3'), para('Add another question only if the previous answer made it useful.')),
        ...followups,
        h(Button, { variant: 'secondary', disabled, onClick: addFollowup }, content.labels.addFollowup)),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm094-save-heading' },
        heading('Private practice', 'h3', 'm094-save-heading'), para(content.labels.private),
        h(Button, {
          key: buttonEpoch,
          variant: 'primary', fullWidth: true, doneLabel: content.labels.done,
          pendingLabel: content.labels.saving, errorLabel: content.labels.retry,
          disabled: practice.loading || practice.saving || tooLong,
          onClick: save,
        }, content.labels.save),
        practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
          ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
        practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading' }, content.labels.source),
      para(content.labels.sourceQuote), para(content.labels.sourceAttribution), para(content.labels.sourceBoundary)));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
