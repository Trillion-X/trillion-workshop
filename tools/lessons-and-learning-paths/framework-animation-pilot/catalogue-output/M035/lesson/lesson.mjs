import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';
import { initialState, readout, sequenceFigure } from './lesson-model.mjs';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [state, setState] = useState(initialState);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm035-physiological-sigh' });
  const disabled = practice.loading || practice.locked;
  const part = content.sequence[state.sequenceIndex];
  const visual = sequenceFigure(state.sequenceIndex);
  const preparation = content.preparations.find(row => row.id === state.preparation);
  const task = content.tasks.find(row => row.id === state.task);
  const result = readout(content, state.state, state.taskResult);
  const paragraph = words => words ? h(Text, { as: 'p', variant: 'body' }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const choices = (label, options, selected, onChoose) => h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': label,
  }, ...options.map(option => h(Button, {
    key: option.id,
    variant: selected === option.id ? 'primary' : 'secondary',
    'aria-pressed': selected === option.id,
    disabled,
    onClick: () => {
      if (disabled) return;
      practice.markEdited();
      onChoose(option.id);
    },
  }, option.title)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm035-sequence-heading' },
      heading(content.labels.sequence, 'h2', 'm035-sequence-heading'),
      paragraph(content.labels.sequenceIntro),
      choices(content.labels.sequenceGroup, content.sequence.map(({ id, title }) => ({ id, title })), part.id, id => setState(current => ({ ...current, sequenceIndex: content.sequence.findIndex(row => row.id === id) }))),
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        h(AnatomyFigure, { figure: visual, label: visual.label }),
        paragraph(part.instruction)),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm035-comparison-heading' },
      heading('Separate the preparation, feeling and task', 'h2', 'm035-comparison-heading'),
      paragraph(content.labels.scenarioIntro),
      h(Container, { gap: 'sm' },
        heading(content.labels.include, 'h3'),
        choices(content.labels.include, content.preparations, state.preparation, id => setState(current => ({ ...current, preparation: id }))),
        paragraph(preparation.detail)),
      h(Container, { gap: 'sm' },
        heading(content.labels.task, 'h3'),
        choices(content.labels.task, content.tasks, state.task, id => setState(current => ({ ...current, task: id }))),
        paragraph(task.measure)),
      h(Container, { layout: 'grid', gridColumns: 1, gap: 'md' },
        h(Container, { gap: 'sm' },
          heading(content.labels.state, 'h3'),
          choices(content.labels.state, content.states, state.state, id => setState(current => ({ ...current, state: id })))),
        h(Container, { gap: 'sm' },
          heading(content.labels.taskResult, 'h3'),
          choices(content.labels.taskResult, content.taskResults, state.taskResult, id => setState(current => ({ ...current, taskResult: id }))))),
      h(Container, { border: 'all', padding: 'md', gap: 'sm', role: 'status', 'aria-live': 'polite', 'aria-label': content.labels.interpretation },
        heading(content.labels.interpretation, 'h3'),
        h(Container, { layout: 'grid', gridColumns: 2, gap: 'md' },
          h(Container, { gap: 'xs' }, h(Text, { as: 'p', variant: 'body' }, 'Felt state'), paragraph(result.feeling)),
          h(Container, { gap: 'xs' }, h(Text, { as: 'p', variant: 'body' }, task.title), paragraph(result.result))),
        paragraph(result.explanation)),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm035-practice-heading' },
      heading(content.labels.practice, 'h2', 'm035-practice-heading'),
      ...fields.map(key => {
        const id = `m035-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm035-practice-feedback' : undefined,
            value: practice.values[key], disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved notes.') : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm035-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
