import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const phases = ['notice', 'compare', 'choose'];
const phaseFor = value => phases.includes(value) ? value : 'notice';
const choiceFor = value => content.choices.some(row => row.id === value) ? value : '';
const phaseFields = {
  notice: ['prediction', 'observation'],
  compare: ['comparison', 'result'],
  choose: ['revision', 'step'],
};

function Lesson({ surfaceInput, host }) {
  const [phase, setPhase] = useState('notice');
  const [choice, setChoice] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm041-natural-focus-observation',
    onRestore: record => {
      try {
        const saved = typeof record.transfer === 'string' ? JSON.parse(record.transfer) : record.transfer;
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          setPhase(phaseFor(saved.phase));
          setChoice(choiceFor(saved.choice));
        }
      } catch { /* Retain the safe default and keep private notes available. */ }
    },
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => words ? h(Text, { as: 'p', variant: 'body', ...props }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const field = key => {
    const id = `m041-practice-${key}`;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, {
        id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000,
        value: practice.values[key], disabled,
        onChange: event => practice.setValue(key, event.target.value),
      }));
  };
  const changePhase = next => {
    if (disabled) return;
    practice.markEdited();
    setPhase(phaseFor(next));
  };
  const choose = id => {
    if (disabled) return;
    practice.markEdited();
    setChoice(choiceFor(id));
  };
  const choiceRow = content.choices.find(row => row.id === choice);
  const controls = h(Container, { gap: 'sm' },
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': 'Observation steps' },
      ...phases.map(id => h(Button, {
        key: id, variant: phase === id ? 'primary' : 'secondary',
        'aria-pressed': phase === id, 'aria-controls': 'm041-active-stage', disabled,
        onClick: () => changePhase(id),
      }, content.steps[id].label))));
  const sample = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm041-examples-heading' },
    heading(content.labels.examples, 'h2', 'm041-examples-heading'),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'stretch' },
      ...content.examples.map((episode, index) => h(Container, {
        key: episode.id, as: 'article', border: 'all', padding: 'md', gap: 'sm',
        flex: '1', minWidth: '300px',
        'aria-label': `${content.labels.episodeA.replace('1', String(index + 1))}: ${episode.title}`,
      },
        heading(episode.title, 'h3'),
        ...episode.description.split('\n').map((line, index) => paragraph(line, { key: index })),
      ))),
    paragraph('Both episodes include absorption. The comparison depends on the purpose and what each episode displaced, not which one lasted longer.'));
  const notice = h(Container, { gap: 'md' },
    heading(content.steps.notice.label, 'h2', 'm041-active-stage-heading'),
    paragraph(content.steps.notice.description),
    ...phaseFields.notice.map(field));
  const compare = h(Container, { gap: 'md' },
    heading(content.steps.compare.label, 'h2', 'm041-active-stage-heading'),
    paragraph(content.steps.compare.description),
    sample,
    h(Container, { gap: 'sm' },
      heading('Which episode served its stated purpose?', 'h3'),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': 'Compare the example episodes' },
        ...content.choices.map(row => h(Button, {
          key: row.id, variant: choice === row.id ? 'primary' : 'secondary',
          'aria-pressed': choice === row.id, disabled, onClick: () => choose(row.id),
        }, row.label))),
      choiceRow ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, choiceRow.description) : null),
    ...phaseFields.compare.map(field));
  const chooseStage = h(Container, { gap: 'md' },
    heading(content.steps.choose.label, 'h2', 'm041-active-stage-heading'),
    paragraph(content.steps.choose.description),
    ...phaseFields.choose.map(field),
    practice.locked ? paragraph(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', work: null, disabled: practice.loading || practice.saving,
      onClick: () => practice.save({ transfer: JSON.stringify({ phase, choice }) }),
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, { as: 'p', id: 'm041-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null);
  const active = phase === 'notice' ? notice : phase === 'compare' ? compare : chooseStage;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening),
      paragraph('Notice soon after. Compare before changing a condition. A useful action can happen whenever the evidence is already clear.')),
    controls,
    h(Container, { as: 'section', id: 'm041-active-stage', role: 'region', 'aria-labelledby': 'm041-active-stage-heading', gap: 'md' }, active),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
