import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['step'];
const editableFields = ['result', 'prerequisites', 'order', 'scope', 'period', 'materials', 'inspection'];
const emptyPlan = () => Object.fromEntries(editableFields.map(key => [key, '']));
const savedPlan = record => {
  try {
    const extras = typeof record.transfer === 'string' ? JSON.parse(record.transfer) : record.transfer;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return emptyPlan();
    return Object.fromEntries(editableFields.map(key => [key,
      typeof extras[key] === 'string' ? extras[key] : '',
    ]));
  } catch { return emptyPlan(); }
};

function Lesson({ surfaceInput, host }) {
  const [plan, setPlan] = useState(emptyPlan);
  const [notice, setNotice] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm043-focus-block-design',
    onRestore: record => setPlan(savedPlan(record)),
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => words ? h(Text, { as: 'p', variant: 'body', ...props }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const field = (key, title, rows = 3) => {
    const id = `m043-plan-${key}`;
    const isTask = key === 'task';
    const value = isTask ? practice.values.step : plan[key] ?? '';
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.labels[title]),
      h(Text, { as: 'p', variant: 'body', id: `${id}-hint` }, content.teaching.hints[title]),
      h(Textarea, {
        id, rows, autoGrow: true, maxHeight: 400, maxLength: 2000,
        'aria-describedby': `${id}-hint`, value, disabled,
        onChange: event => {
          if (isTask) practice.setValue('step', event.target.value);
          else {
            practice.markEdited();
            practice.setValue('step', practice.values.step);
            setPlan(current => ({ ...current, [key]: event.target.value }));
            setNotice('');
          }
        },
      }));
  };
  const loadExample = () => {
    if (disabled) return;
    practice.markEdited();
    practice.setValue('step', content.practice.example.task);
    setPlan(Object.fromEntries(editableFields.map(key => [key, content.practice.example[key]])));
    setNotice('The example is in your plan. Edit any detail to fit the work.');
  };
  const clearCurrent = () => {
    if (disabled) return;
    practice.markEdited();
    practice.setValue('step', '');
    setPlan(emptyPlan());
    setNotice('The current editor is clear. Any previously saved private draft will still be available if you reopen it.');
  };
  const save = () => practice.save({ transfer: JSON.stringify(plan) });
  const saveButton = h(Button, {
    variant: 'primary', disabled: practice.loading || practice.saving,
    onClick: save,
  }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save);
  const feedback = practice.status || notice;

  const example = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm043-example-heading' },
    heading(content.practice.example.title, 'h2', 'm043-example-heading'),
    paragraph(content.practice.example.task),
    h(Container, { as: 'ul', gap: 'xs' },
      h(Text, { as: 'li', variant: 'body' }, 'The route waits for the coordinator’s approved map; each label waits for the walk lead’s confirmed name.'),
      h(Text, { as: 'li', variant: 'body' }, 'The map and names can be confirmed at the same time. Page setup can happen while both are on the way.'),
      h(Text, { as: 'li', variant: 'body' }, 'The guide is one page with three stops. The print preview is checked against the map and names before the coordinator reviews it.')),
    h(Button, { variant: 'secondary', disabled, onClick: loadExample }, content.labels.example));

  const reviewRows = [
    ['Task', practice.values.step], ['Intended result', plan.result],
    ['Inputs and dependencies', plan.prerequisites], ['Order and independent work', plan.order],
    ['Scope', plan.scope], ['Period and capacity', plan.period],
    ['Materials, tools and setting', plan.materials], ['Result check and follow-up', plan.inspection],
  ];
  const review = h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm043-review-heading' },
    heading('Review your draft', 'h2', 'm043-review-heading'),
    paragraph('Read the plan as one piece of work. Open details can stay blank; keep unknown inputs marked as unknown.'),
    h(Container, { as: 'dl', gap: 'sm' }, ...reviewRows.map(([label, value]) => h(Container, { key: label, gap: 'xs' },
      h(Text, { as: 'dt', variant: 'body' }, label),
      h(Text, { as: 'dd', variant: 'body' }, value.trim() || 'Not added yet.')))));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening), paragraph(content.intro)),
    h(Container, { as: 'section', gap: 'lg', 'aria-labelledby': 'm043-plan-heading' },
      heading('Plan one task', 'h2', 'm043-plan-heading'),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': 'Private plan actions' },
        saveButton,
        h(Button, { variant: 'secondary', disabled, onClick: clearCurrent }, content.labels.clear)),
      paragraph('Name the task before saving. The other notes are optional while you work out what is ready.'),
      field('task', 'task', 2),
      field('result', 'result', 2),
      example,
      field('prerequisites', 'prerequisites', 5),
      field('order', 'order', 6),
      field('scope', 'scope', 3),
      field('period', 'period', 6),
      field('materials', 'materials', 4),
      field('inspection', 'inspection', 6),
      feedback ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, feedback) : null),
    review,
    paragraph('This is a private lesson draft. It does not reserve calendar time or contact anyone. A short action may not need a block; judge the plan by the result you can inspect, not by minutes spent.'));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
