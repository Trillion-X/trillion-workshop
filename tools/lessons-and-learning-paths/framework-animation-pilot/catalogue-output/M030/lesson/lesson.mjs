import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { INITIAL_ARRANGEMENT, sessionPlan } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];

function Lesson({ surfaceInput, host }) {
  const [arrangement, setArrangement] = useState(INITIAL_ARRANGEMENT);
  const [attemptDraft, setAttemptDraft] = useState('');
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm030-flow-trigger-design',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.transfer ?? '{}');
        const restored = saved.arrangement ?? saved;
        sessionPlan(content, restored);
        setArrangement(Object.fromEntries(Object.keys(INITIAL_ARRANGEMENT).map(key => [key, restored[key]])));
        setAttemptDraft(typeof saved.draft === 'string' ? saved.draft : '');
      } catch { /* Keep the visible default if an older record has no saved arrangement. */ }
    },
  });
  const plan = sessionPlan(content, arrangement);
  const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);
  const update = (kind, id) => {
    if (practice.locked || practice.loading) return;
    practice.markEdited();
    setArrangement(current => ({ ...current, [kind]: id }));
  };
  const save = () => practice.save({ transfer: JSON.stringify({ arrangement, draft: attemptDraft }) });
  const group = (kind, title, choices) => h(Container, { gap: 'xs' },
    h(Text, { as: 'h3', variant: 'heading-md' }, title),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': title },
      ...choices.map(choice => h(Button, {
        key: choice.id,
        variant: arrangement[kind] === choice.id ? 'primary' : 'secondary',
        'aria-pressed': arrangement[kind] === choice.id,
        disabled: practice.loading || practice.locked,
        onClick: () => update(kind, choice.id),
      }, choice.title))));
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, h(Text, { as: 'h1', variant: 'heading-xl' }, content.title), paragraph(content.opening)),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.conditions), paragraph(content.labels.conditionsText),
      group('setting', content.labels.setting, content.choices.setting),
      group('preparation', content.labels.preparation, content.choices.preparation),
      group('challenge', content.labels.challenge, content.choices.challenge),
      group('feedback', content.labels.feedback, content.choices.feedback)),
    h(Container, { border: 'all', padding: 'lg', gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.attempt),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.goal), paragraph(plan.goal),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.challengeLabel), paragraph(plan.task),
      paragraph(plan.preparedQuestion ? content.labels.prepWithQuestion : content.labels.prepWithoutQuestion),
      paragraph(content.labels.draftPrompt),
      h(Textarea, { id: 'm030-attempt-draft', rows: 4, autoGrow: true, maxHeight: 300, maxLength: 2000,
        'aria-label': content.labels.draftPrompt, placeholder: content.labels.draftPlaceholder, value: attemptDraft, disabled: practice.loading || practice.locked,
        onChange: event => { practice.markEdited(); setAttemptDraft(event.target.value); } }),
      h(Text, { as: 'p', variant: 'body', 'aria-live': 'polite' }, plan.feedbackPrompt),
    ),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.comparison), paragraph(content.labels.comparisonText),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.evidence),
      h(Container, { as: 'ul', gap: 'sm' },
        h(Text, { as: 'li', variant: 'body' }, content.labels.engagementEvidence),
        h(Text, { as: 'li', variant: 'body' }, content.labels.disruptionEvidence),
        h(Text, { as: 'li', variant: 'body' }, content.labels.performanceEvidence),
        h(Text, { as: 'li', variant: 'body' }, content.labels.unknownEvidence))),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.plan),
      ...fields.map(key => {
        const id = `m030-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, { id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm030-practice-feedback' : undefined,
            value: practice.values[key], disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value) }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return save(); } },
      practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm030-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
