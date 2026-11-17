import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { INITIAL_SESSION, attemptFeedback, scenarioPlan, transferState } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const stages = [
  'Name the capability you want and inspect its present limiter.',
  'Prepare the task environment, material, and relevant state.',
  'Make an attempt that exposes the target and gives usable feedback.',
  'Adjust the next attempt from that feedback.',
  'Retain what the attempt taught you and check it later where the ability matters.',
];

function Lesson({ surfaceInput, host }) {
  const [session, setSession] = useState({ ...INITIAL_SESSION });
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.messages, requestPrefix: 'm031-performance-engineering',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.transfer ?? '{}');
        const restoredSession = saved.session ?? INITIAL_SESSION;
        scenarioPlan(content, restoredSession);
        setSession(Object.fromEntries(Object.keys(INITIAL_SESSION).map(key => [key, restoredSession[key]])));
        setAnswer(typeof saved.attempt === 'string' ? saved.attempt : '');
        setChecked(Boolean(saved.performance));
      } catch { /* An older record keeps the visible default and editable text. */ }
    },
  });
  const plan = scenarioPlan(content, session);
  const feedback = checked ? attemptFeedback(content, session, answer) : null;
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (kind, id) => {
    if (practice.locked || practice.loading) return;
    practice.markEdited();
    setSession(current => ({ ...current, [kind]: id }));
    setAnswer('');
    setChecked(false);
  };
  const save = () => {
    if (!checked) {
      setAttemptedSave(true);
      return false;
    }
    return practice.save({ transfer: JSON.stringify(transferState(content, session, answer)) });
  };
  const group = (kind, title, choices) => h(Container, { gap: 'xs' },
    h(Text, { as: 'h3', variant: 'heading-md' }, title),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': title },
      ...choices.map(choice => h(Button, {
        key: choice.id,
        variant: session[kind] === choice.id ? 'primary' : 'secondary',
        'aria-pressed': session[kind] === choice.id,
        disabled: practice.loading || practice.locked,
        onClick: () => update(kind, choice.id),
      }, choice.title))));
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, h(Text, { as: 'h1', variant: 'heading-xl' }, content.title), paragraph(content.opening)),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.task),
      paragraph(content.labels.taskIntro),
      group('objective', content.labels.objective, content.choices.objective),
      group('preparation', content.labels.preparation, content.choices.preparation),
      group('scenario', content.labels.challenge, content.choices.scenario),
      group('feedback', content.labels.feedbackMode, content.choices.feedback)),
    h(Container, { border: 'all', padding: 'lg', gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.attempt),
      h(Text, { as: 'h3', variant: 'heading-md' }, plan.task.title),
      paragraph(plan.task.prompt),
      h(Container, { as: 'ul', gap: 'sm' }, ...plan.task.materials.map(row => h(Text, { as: 'li', variant: 'body', key: row.id }, `${row.name}: ${row.stock} available; ${row.perPack} needed for each complete pack or kit.`))),
      session.preparation === 'ratio-card' ? paragraph('Preparation cue: for each material, divide available stock by the amount needed per pack. The smallest whole-number capacity is the limiting row.') : null,
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.attemptPrompt),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.attemptPrompt }, ...plan.answerOptions.map(option => h(Button, {
        key: option.id, variant: answer === option.id ? 'primary' : 'secondary', 'aria-pressed': answer === option.id,
        disabled: practice.loading || practice.locked,
        onClick: () => { practice.markEdited(); setAnswer(option.id); setChecked(false); },
      }, option.label))),
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.locked || !answer,
        onClick: () => { setChecked(true); setAttemptedSave(false); practice.markEdited(); } }, content.labels.checkAttempt),
      checked && feedback ? h(Container, { gap: 'xs' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.diagnostic),
        paragraph(feedback.message, { id: 'm031-attempt-feedback', role: 'status', 'aria-live': 'polite' }),
        session.feedback === 'diagnostic' ? paragraph(feedback.diagnostic) : null,
        session.objective === 'capacity' ? paragraph(`The limiting material is ${plan.limiting.map(row => row.name.toLowerCase()).join(' and ')}.`) : null,
        h(Button, { variant: 'secondary', work: null, disabled: practice.loading || practice.locked,
          onClick: () => { practice.markEdited(); setSession(current => ({ ...current, scenario: current.scenario === 'field-pack' ? 'workshop-kit' : 'field-pack' })); setAnswer(''); setChecked(false); } }, content.labels.nextAttempt),
      ) : null,
      attemptedSave && !checked ? paragraph(content.messages.attemptFirst, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.sourceSequence),
      paragraph(content.labels.sourceSequenceIntro),
      h(Container, { as: 'ol', gap: 'sm' }, ...stages.map((stage, index) => h(Text, { as: 'li', variant: 'body', key: index }, stage)))),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.savePlan),
      ...fields.map(key => {
        const id = `m031-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, { id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm031-practice-status' : undefined,
            value: practice.values[key], disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value) }));
      }),
      practice.locked ? paragraph(content.messages.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return save(); } }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm031-practice-status', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
