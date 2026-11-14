import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const EMPTY_STATE = {
  schema: 'm046-distraction-reframing-state/v1',
  task: content.example.task,
  selectedCase: '',
  currentDraft: content.example.draftLine,
  laterIdea: content.example.laterIdea,
  laterIdeas: [],
  setupChange: content.example.setupChange,
  setupPlanRecorded: false,
  priceCorrected: false,
  lastAction: '',
};

function restoreState(value) {
  if (typeof value !== 'string') return { ...EMPTY_STATE };
  try {
    const saved = JSON.parse(value);
    if (!saved || saved.schema !== EMPTY_STATE.schema) return { ...EMPTY_STATE };
    return {
      ...EMPTY_STATE,
      task: typeof saved.task === 'string' ? saved.task : EMPTY_STATE.task,
      selectedCase: content.cases.some(item => item.id === saved.selectedCase) ? saved.selectedCase : '',
      currentDraft: typeof saved.currentDraft === 'string' ? saved.currentDraft : EMPTY_STATE.currentDraft,
      laterIdea: typeof saved.laterIdea === 'string' ? saved.laterIdea : EMPTY_STATE.laterIdea,
      laterIdeas: Array.isArray(saved.laterIdeas) ? saved.laterIdeas.filter(item => typeof item === 'string') : [],
      setupChange: typeof saved.setupChange === 'string' ? saved.setupChange : EMPTY_STATE.setupChange,
      setupPlanRecorded: saved.setupPlanRecorded === true,
      priceCorrected: saved.priceCorrected === true,
      lastAction: typeof saved.lastAction === 'string' ? saved.lastAction : '',
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function Lesson({ surfaceInput, host }) {
  const [state, setState] = useState(() => ({ ...EMPTY_STATE }));
  const [captureError, setCaptureError] = useState('');
  const [laterSaveState, setLaterSaveState] = useState('idle');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm046-distraction-reframing',
    onRestore: record => {
      const restored = restoreState(record.result);
      setState(restored);
      setLaterSaveState(restored.laterIdeas.length ? 'saved' : 'idle');
    },
  });
  const disabled = practice.loading || practice.locked;
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const update = patch => {
    if (disabled) return false;
    const next = { ...state, ...patch };
    const serialized = JSON.stringify(next);
    if (serialized.length > 2000) {
      setState(next);
      setCaptureError(content.feedback.length);
      return false;
    }
    setState(next);
    practice.setValue('result', serialized);
    setCaptureError('');
    return true;
  };
  const change = (key, value) => {
    if (key === 'laterIdea') setLaterSaveState('idle');
    return update({ [key]: value, lastAction: '' });
  };
  const chooseCase = id => update({ selectedCase: id, lastAction: '' });
  const saveLater = async () => {
    const idea = state.laterIdea.trim();
    if (!idea || disabled || practice.saving) return;
    const laterIdeas = state.laterIdeas.includes(idea) ? state.laterIdeas : [...state.laterIdeas, idea];
    if (!update({ laterIdeas, selectedCase: 'later', lastAction: '' })) return;
    setLaterSaveState('saving');
    setLaterSaveState(await practice.save() ? 'saved' : 'unconfirmed');
  };
  const saveNotes = async () => {
    const saved = await practice.save();
    if (state.laterIdeas.includes(state.laterIdea.trim())) setLaterSaveState(saved ? 'saved' : 'unconfirmed');
  };
  const correctDraft = () => update({
    currentDraft: content.example.approvedLine,
    priceCorrected: true,
    selectedCase: 'now',
    lastAction: 'price-corrected',
  });
  const recordSetupChange = () => {
    if (!state.setupChange.trim() || disabled) return;
    update({ setupPlanRecorded: true, selectedCase: 'recurring', lastAction: 'setup-plan-recorded' });
  };
  const selected = content.cases.find(item => item.id === state.selectedCase);
  const active = selected ? h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-labelledby': 'm046-response-heading',
  },
    heading(selected.label, 'h2', 'm046-response-heading'),
    p(selected.summary),
    state.selectedCase === 'later'
      ? h(Container, { gap: 'md' },
          h(Container, { gap: 'xs' },
            h(Text, { as: 'label', variant: 'body', htmlFor: 'm046-later-idea' }, content.labels.laterIdea),
            h(Textarea, {
              id: 'm046-later-idea', rows: 2, autoGrow: true, maxHeight: 140, maxLength: 500,
              value: state.laterIdea, disabled,
              onChange: event => change('laterIdea', event.target.value),
            })),
          h(Button, {
            variant: 'primary',
            disabled: disabled || practice.saving || !state.laterIdea.trim() || Boolean(captureError),
            onClick: saveLater,
          }, practice.saving ? content.labels.savingLater : content.labels.saveLater),
          state.laterIdeas.length
            ? h(Container, { as: 'section', gap: 'xs', 'aria-labelledby': 'm046-later-list-heading' },
                heading(content.labels.laterList, 'h3', 'm046-later-list-heading'),
                h(Container, { as: 'ul', gap: 'xs', role: 'list', 'aria-label': content.labels.laterList },
                  ...state.laterIdeas.map((idea, index) => h(Container, { as: 'li', key: `${index}-${idea}`, border: 'all', padding: 'sm' }, p(idea)))))
            : null,
          laterSaveState === 'saved'
            ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, `Saved for later in your private lesson record. Your current task remains: ${state.task}`)
            : null,
          laterSaveState === 'unconfirmed'
            ? h(Text, { as: 'p', role: 'alert' }, content.feedback.ideaNotConfirmed)
            : null)
      : null,
    state.selectedCase === 'now'
      ? h(Container, { gap: 'md' },
          h(Container, { gap: 'xs' },
            h(Text, { as: 'label', variant: 'body', htmlFor: 'm046-current-draft' }, content.labels.draftLine),
            h(Textarea, {
              id: 'm046-current-draft', rows: 2, autoGrow: true, maxHeight: 140, maxLength: 500,
              value: state.currentDraft, disabled,
              onChange: event => change('currentDraft', event.target.value),
            })),
          h(Container, { border: 'all', padding: 'sm', gap: 'xs', 'aria-label': content.labels.exampleSource },
            h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.exampleSource),
            p(content.example.approvedLine)),
          p('This fact changes the explanation you are writing, so update it here before continuing.'),
          h(Button, { variant: 'primary', disabled, onClick: correctDraft }, content.labels.correctDraft),
          state.priceCorrected
            ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, `The current draft now says: ${state.currentDraft}`)
            : null)
      : null,
    state.selectedCase === 'recurring'
      ? h(Container, { gap: 'md' },
          p(content.teaching.recurringPattern),
          h(Container, { gap: 'xs' },
            h(Text, { as: 'label', variant: 'body', htmlFor: 'm046-setup-change' }, content.labels.setupChange),
            h(Textarea, {
              id: 'm046-setup-change', rows: 2, autoGrow: true, maxHeight: 140, maxLength: 500,
              value: state.setupChange, disabled,
              onChange: event => change('setupChange', event.target.value),
            })),
          h(Button, { variant: 'primary', disabled: disabled || !state.setupChange.trim(), onClick: recordSetupChange }, content.labels.recordSetup),
          state.setupPlanRecorded
            ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, `Setup change recorded for you to make: ${state.setupChange}`)
            : null)
      : null,
  ) : null;

  const report = practice.status
    ? h(Text, { as: 'p', id: 'm046-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status)
    : null;
  const save = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm046-private-heading',
  },
    heading(content.labels.privateRecord, 'h2', 'm046-private-heading'),
    p('The video idea is saved when its button confirms. Save other example changes or the setup plan here when you want to keep them.'),
    captureError ? h(Text, { as: 'p', role: 'alert' }, captureError) : null,
    practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved private note.') : null,
    practice.locked ? p(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', work: null,
      disabled: practice.loading || practice.saving || !practice.values.result || Boolean(captureError),
      onClick: saveNotes,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    report);

  const source = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm046-source-heading' },
    heading(content.labels.sourceExcerpt, 'h2', 'm046-source-heading'),
    p(content.teaching.sourceExcerpt));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm046-task-heading' },
      heading('Keep the current task in view', 'h2', 'm046-task-heading'),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm046-task' }, content.labels.task),
        h(Textarea, {
          id: 'm046-task', rows: 1, autoGrow: true, maxHeight: 80, maxLength: 500,
          value: state.task, disabled,
          onChange: event => change('task', event.target.value),
        })),
      heading(content.labels.classify, 'h3', 'm046-classify-heading'),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.classify },
        ...content.cases.map(item => h(Button, {
          key: item.id,
          variant: state.selectedCase === item.id ? 'primary' : 'secondary',
          'aria-pressed': state.selectedCase === item.id,
          disabled,
          onClick: () => chooseCase(item.id),
        }, item.label))),
      active),
    save,
    source,
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
