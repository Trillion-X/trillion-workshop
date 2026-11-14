import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const rowsFor = prefix => Object.entries(content.choices)
  .filter(([id]) => id.startsWith(prefix))
  .map(([id, row]) => ({ id, ...row }));
const interpretationChoices = rowsFor('classify-');
const responseChoices = rowsFor('respond-');
const validId = id => Object.hasOwn(content.choices, id);
const restoreTransfer = value => {
  try {
    const parsed = JSON.parse(value ?? '');
    return {
      interpretation: validId(parsed.interpretation) && parsed.interpretation.startsWith('classify-') ? parsed.interpretation : '',
      nextMove: validId(parsed.nextMove) && parsed.nextMove.startsWith('respond-') ? parsed.nextMove : '',
    };
  } catch {
    return { interpretation: '', nextMove: '' };
  }
};

function Lesson({ surfaceInput, host }) {
  const [interpretation, setInterpretation] = useState('');
  const [nextMove, setNextMove] = useState('');
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm047-stop-looking-start-seeing',
    onRestore: record => {
      const restored = restoreTransfer(record.transfer);
      setInterpretation(restored.interpretation);
      setNextMove(restored.nextMove);
    },
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = words => words ? h(Text, { as: 'p', variant: 'body' }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', h4: 'heading-md' })[level],
  }, words);
  const selectedInterpretation = content.choices[interpretation];
  const selectedMove = content.choices[nextMove];
  const choices = (label, options, selected, onChoose) => h(Container, {
    layout: 'horizontal',
    wrap: 'wrap',
    gap: 'sm',
    role: 'group',
    'aria-label': label,
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
  }, option.label)));

  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm047-case-heading' },
      heading(content.examples.work.title, 'h2', 'm047-case-heading'),
      paragraph(content.examples.summary),
      paragraph(content.examples.work.description),
      h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
        h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
        paragraph(content.teaching.sourceExcerpt),
        paragraph(`Manuscript, ${content.source.manuscriptLocator}.`),
        paragraph(content.source.limits))),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm047-guided-heading' },
      heading(content.labels.guided, 'h2', 'm047-guided-heading'),
      paragraph(content.labels.guidedText),
      choices(content.labels.classifyGroup, interpretationChoices, interpretation, setInterpretation),
      selectedInterpretation
        ? h(Container, { border: 'all', padding: 'md', gap: 'xs', role: 'status', 'aria-live': 'polite', 'aria-label': content.labels.result },
            heading(selectedInterpretation.label, 'h3'),
            paragraph(selectedInterpretation.description))
        : paragraph('Separate what was observed from what was felt or inferred.')),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm047-next-heading' },
      heading(content.labels.next, 'h2', 'm047-next-heading'),
      choices(content.labels.nextGroup, responseChoices, nextMove, setNextMove),
      selectedMove
        ? h(Container, { border: 'all', padding: 'md', role: 'status', 'aria-live': 'polite', 'aria-label': `${content.labels.next}: ${selectedMove.label}` },
            paragraph(selectedMove.description))
        : paragraph('A fitting response can investigate the event or address a practical need.')),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm047-practice-heading' },
      heading(content.labels.practice, 'h2', 'm047-practice-heading'),
      paragraph('Choose a manageable example. You do not need to use a painful or overwhelming event.'),
      ...fields.map(key => {
        const id = `m047-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 3,
            autoGrow: true,
            maxHeight: 240,
            maxLength: 2000,
            required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm047-practice-feedback' : undefined,
            value: practice.values[key],
            disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved notes.') : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: () => {
          setAttemptedSave(true);
          return practice.save({ transfer: JSON.stringify({ interpretation, nextMove }) });
        },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm047-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
