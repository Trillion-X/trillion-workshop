import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { INITIAL_SESSION, sessionPlan } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const sessionKeys = Object.keys(INITIAL_SESSION);
const textKeys = ['target', 'criterion', 'firstAttempt', 'firstEvidence', 'secondAttempt', 'check'];
const phaseSectionTitles = {
  prepare: ['Prepare the work'],
  during: ['Work on the same target', 'Change the task demand, not the target'],
  after: ['After the attempt', 'Use a record to make the next call'],
};

function Lesson({ surfaceInput, host }) {
  const [activePhase, setActivePhase] = useState('prepare');
  const [session, setSession] = useState(INITIAL_SESSION);
  const [text, setText] = useState(Object.fromEntries(textKeys.map(key => [key, ''])));
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm033-optimal-performance-protocol',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.transfer ?? '{}');
        if (saved.session) {
          const restored = Object.fromEntries(sessionKeys.map(key => [key, saved.session[key] ?? INITIAL_SESSION[key]]));
          sessionPlan(content, restored, saved.text?.target ?? '');
          setSession(restored);
        }
        if (saved.text) setText(current => ({ ...current, ...Object.fromEntries(textKeys.map(key => [key, typeof saved.text[key] === 'string' ? saved.text[key] : ''])) }));
      } catch { /* The six saved practice fields remain available if an older record has no transfer data. */ }
    },
  });
  const plan = sessionPlan(content, session, text.target);
  const phase = content.labels[activePhase];
  const phaseSections = phaseSectionTitles[activePhase].map(title => content.teaching.sections.find(section => section.title === title));
  const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);
  const editText = (key, value) => {
    if (practice.locked || practice.loading) return;
    practice.markEdited();
    setText(current => ({ ...current, [key]: value }));
  };
  const select = (group, id) => {
    if (practice.locked || practice.loading) return;
    practice.markEdited();
    setSession(current => ({ ...current, [group]: id }));
  };
  const choiceGroup = (group, title, choices) => h(Container, { gap: 'xs' },
    h(Text, { as: 'h3', variant: 'heading-md' }, title),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': title },
      ...Object.keys(choices).map(id => h(Button, {
        key: id,
        variant: session[group] === id ? 'primary' : 'secondary',
        'aria-pressed': session[group] === id,
        disabled: practice.loading || practice.locked,
        onClick: () => select(group, id),
      }, content.choices[id].label))));
  const field = (key, label, help, rows = 3) => {
    const id = `m033-${key}`;
    const missing = attemptedSave && !text[key].trim();
    return h(Container, { gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
      help ? paragraph(help) : null,
      h(Textarea, { id, rows, autoGrow: true, maxHeight: 300, maxLength: 2000,
        'aria-invalid': missing ? 'true' : undefined,
        'aria-describedby': missing ? 'm033-practice-feedback' : undefined,
        value: text[key], disabled: practice.loading || practice.locked,
        onChange: event => editText(key, event.target.value) }));
  };
  const practiceField = key => {
    const id = `m033-practice-${key}`;
    const missing = attemptedSave && !practice.values[key].trim();
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, { id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
        'aria-invalid': missing ? 'true' : undefined,
        'aria-describedby': missing ? 'm033-practice-feedback' : undefined,
        value: practice.values[key], disabled: practice.loading || practice.locked,
        onChange: event => practice.setValue(key, event.target.value) }));
  };
  const save = () => practice.save({ transfer: JSON.stringify({ session, text }) });
  const practicePanel = h(Container, { border: 'all', padding: 'lg', gap: 'md' },
    h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.task),
    paragraph('Name the ability you want to develop. Conditions and task demand can change between attempts while that target stays the same.'),
    field('target', content.labels.target, content.labels.targetHelp, 2),
    choiceGroup('capability', content.labels.capability, content.choiceGroups.capability),
    h(Text, { as: 'h3', variant: 'heading-md' }, plan.task),
    paragraph(`${plan.taskPrompt} Target: ${plan.target}`),
    field('criterion', content.labels.criterion, content.labels.criterionHelp, 2),
    field('firstAttempt', content.labels.firstAttempt, content.labels.taskHelp, 4),
    field('firstEvidence', content.labels.firstEvidence, 'After the attempt, compare it with the criterion or record why the evidence is not clear yet.', 3),
    choiceGroup('stage', content.labels.stage, content.choiceGroups.stage), paragraph(content.labels.stageHelp),
    choiceGroup('result', content.labels.result, content.choiceGroups.result),
    choiceGroup('adjustment', content.labels.adjustment, content.choiceGroups.adjustment),
    choiceGroup('dimension', content.labels.dimension, content.choiceGroups.dimension),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-label': content.labels.nextAttempt },
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.nextAttempt),
      h(Text, { as: 'p', variant: 'body', 'aria-live': 'polite' }, plan.nextAttempt)),
    field('secondAttempt', content.labels.secondAttempt, 'Repeat the same target under the chosen change. Record the real answer, movement or feedback. If you did not make the attempt, say so.', 4),
    field('check', content.labels.comparison, content.labels.check, 3));
  const phaseNavigation = h(Container, { gap: 'xs' },
    h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.phaseNavigation),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.phaseNavigation },
      ...['prepare', 'during', 'after'].map(id => h(Button, {
        key: id,
        variant: activePhase === id ? 'primary' : 'secondary',
        'aria-pressed': activePhase === id,
        'aria-controls': 'm033-phase-content',
        onClick: () => setActivePhase(id),
      }, content.labels[id]))));
  const phaseContent = h(Container, { as: 'section', id: 'm033-phase-content', role: 'region', 'aria-labelledby': 'm033-phase-title', gap: 'sm' },
    h(Text, { as: 'h2', id: 'm033-phase-title', variant: 'heading-lg' }, phase),
    ...phaseSections.map(section => h(Container, { key: section.title, gap: 'sm' },
      h(Text, { as: 'h3', variant: 'heading-md' }, section.title),
      ...section.paragraphs.map((words, index) => h(Text, { key: index, as: 'p', variant: 'body' }, words)))));
  const recordPanel = h(Container, { gap: 'sm' },
    h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.savePlan),
    ...fields.map(practiceField),
    practice.locked ? paragraph(content.feedback.retryPending) : null,
    h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving,
      onClick: () => { setAttemptedSave(true); return save(); } },
    practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, { as: 'p', id: 'm033-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null);
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening), paragraph(content.teaching.distinction)),
    practicePanel,
    phaseNavigation,
    phaseContent,
    recordPanel);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
