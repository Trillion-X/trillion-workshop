import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const freshDraft = () => ({
  mode: 'group', value: '', conduct: '', setting: '', feedback: '',
});
function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const initial = freshDraft();
    return {
      mode: parsed.mode === 'solo' ? 'solo' : 'group',
      value: typeof parsed.value === 'string' ? parsed.value : initial.value,
      conduct: typeof parsed.conduct === 'string' ? parsed.conduct : initial.conduct,
      setting: typeof parsed.setting === 'string' ? parsed.setting : initial.setting,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : initial.feedback,
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(freshDraft);
  const [counterexampleShown, setCounterexampleShown] = useState(false);
  const [observationShown, setObservationShown] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm075-values-field',
    onRestore: record => {
      const saved = restore(record.result);
      if (saved) setDraft(saved);
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const edit = (key, value) => {
    practice.markEdited();
    setDraft(current => ({ ...current, [key]: value }));
  };
  const field = (key, label, rows = 2) => h(Container, { key, gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: `m075-${key}` }, label),
    h(Textarea, {
      id: `m075-${key}`, rows, autoGrow: true, maxHeight: 220,
      value: draft[key], disabled,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm075-length-error' : undefined,
      onChange: event => edit(key, event.target.value),
    }));
  const tooLong = practice.status === content.feedback.length;
  const complete = ['value', 'conduct', 'setting', 'feedback'].every(key => draft[key].trim());
  const save = () => {
    practice.setValue('result', JSON.stringify(draft));
    return practice.save();
  };
  const modeButtons = h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.arrangement,
  },
  h(Button, {
    variant: draft.mode === 'group' ? 'primary' : 'secondary', 'aria-pressed': draft.mode === 'group', disabled,
    onClick: () => edit('mode', 'group'),
  }, content.labels.groupMode),
  h(Button, {
    variant: draft.mode === 'solo' ? 'primary' : 'secondary', 'aria-pressed': draft.mode === 'solo', disabled,
    onClick: () => edit('mode', 'solo'),
  }, content.labels.soloMode));
  const comparison = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm075-comparison-heading' },
    heading(content.labels.comparison, 'h2', 'm075-comparison-heading'),
    p(content.labels.before),
    h(Container, { layout: 'responsive-split', gap: 'md' },
      h(Container, { flex: 1, border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm075-praise-heading' },
        heading(content.labels.praiseGroup, 'h3', 'm075-praise-heading'),
        p(content.labels.claim),
        counterexampleShown ? h(React.Fragment, null,
          p(content.labels.objection),
          p(content.labels.praiseResult, { role: 'status', 'aria-live': 'polite' }))
          : p('Members hear praise and agreement, but have not tested the claim against a concrete case.')),
      h(Container, { flex: 1, border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm075-inquiry-heading' },
        heading(content.labels.inquiryGroup, 'h3', 'm075-inquiry-heading'),
        p(content.labels.claim),
        counterexampleShown ? h(React.Fragment, null,
          p(content.labels.objection),
          p(content.labels.inquiryResult, { role: 'status', 'aria-live': 'polite' }))
          : p('Members name what evidence could change the claim, then decide how to test it.'))),
    h(Button, { variant: 'secondary', onClick: () => setCounterexampleShown(value => !value),
      'aria-expanded': counterexampleShown }, counterexampleShown ? content.labels.reset : content.labels.introduce),
    p(content.labels.solitude));
  const design = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm075-design-heading' },
    heading(content.labels.design, 'h2', 'm075-design-heading'),
    h(Text, { as: 'p', variant: 'body' }, content.labels.arrangement), modeButtons,
    p(draft.mode === 'solo' ? content.labels.soloModeHelp : content.labels.groupModeHelp),
    field('value', content.labels.value),
    field('conduct', content.labels.conduct),
    field('setting', content.labels.setting, 3),
    field('feedback', content.labels.feedback, 3),
    h(Button, { variant: 'secondary', disabled: !complete,
      'aria-expanded': observationShown,
      onClick: () => setObservationShown(value => !value) }, content.labels.observe),
    observationShown ? h(Container, { id: 'm075-observation', border: 'all', padding: 'md', gap: 'sm', 'aria-live': 'polite' },
      heading(content.labels.observationPrompt, 'h3'),
      p(draft.mode === 'solo' ? content.labels.observationSolo : content.labels.observationGroup),
      p(`${draft.value} · ${draft.conduct}`),
      p(content.labels.observationQuestion)) : null,
    tooLong ? p(content.labels.tooLong, { id: 'm075-length-error', role: 'alert' }) : null,
    p(content.labels.private),
    h(Button, {
      variant: 'primary', disabled: practice.loading || practice.saving || (!practice.locked && !complete),
      onClick: save,
    }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
    practice.status && !tooLong ? p(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
    practice.locked ? p(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
    p(content.labels.sourceExcerpt), p(content.labels.sourceLocator));
  const example = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm075-example-heading' },
    heading(content.labels.example, 'h2', 'm075-example-heading'), p(content.labels.exampleBody));
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    comparison, design, example, source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
