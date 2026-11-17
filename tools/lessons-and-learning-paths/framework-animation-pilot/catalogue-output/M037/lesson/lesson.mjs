import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { BookTaskInteraction } from './BookTaskInteraction.tsx';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const validIds = (rows, id) => rows.some(row => row.id === id);
const restoreTransfer = value => {
  try {
    const parsed = JSON.parse(value ?? '');
    return {
      interpretation: validIds(content.interpretations, parsed.interpretation) ? parsed.interpretation : '',
      nextMove: validIds(content.nextMoves, parsed.nextMove) ? parsed.nextMove : '',
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
    requestPrefix: 'm037-palm-cooling',
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
  const chosenInterpretation = content.interpretations.find(item => item.id === interpretation);
  const chosenMove = content.nextMoves.find(item => item.id === nextMove);
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

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm037-case-heading' },
      heading(content.labels.case, 'h2', 'm037-case-heading'),
      paragraph(content.labels.caseIntro),
      paragraph('You do not need to cool your hands to complete this lesson. If anyone chooses the source option, keep it comfortable and stop if uncomfortable; painful cold and ice are outside the source guidance.'),
      h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm037-book-task-heading' },
        h(BookTaskInteraction, { taskExample: content.taskExample }),
        h(Container, { layout: 'grid', gridColumns: 2, gap: 'sm', role: 'list', 'aria-label': content.labels.task },
          ...[
            { title: 'Before cooling', answer: content.taskExample.beforeCooling },
            { title: 'After cooling', answer: content.taskExample.afterCooling },
          ].map((item, index) => h(Container, {
            key: item.title,
            as: 'article',
            role: 'listitem',
            border: 'all',
            padding: 'md',
            gap: 'xs',
            'aria-label': `${index + 1} of 2: ${item.title}. ${item.answer}`,
          },
            heading(item.title, 'h4'),
            paragraph(item.answer))),
        ),
        h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
          h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.checkTaskAnswer),
          paragraph(`${content.taskExample.correctAnswer}. ${content.taskExample.reading}`)),
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm037-reading-heading' },
      heading(content.labels.decision, 'h2', 'm037-reading-heading'),
      choices(content.labels.decisionGroup, content.interpretations, interpretation, setInterpretation),
      chosenInterpretation
        ? h(Container, { border: 'all', padding: 'md', gap: 'xs', role: 'status', 'aria-live': 'polite', 'aria-label': content.labels.conclusion },
            h(Text, { as: 'h3', variant: 'heading-md' }, chosenInterpretation.status),
            paragraph(chosenInterpretation.explanation))
        : paragraph('What does the changed feeling tell us about the answer?'),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm037-next-heading' },
      heading(content.labels.nextMove, 'h2', 'm037-next-heading'),
      choices(content.labels.nextMoveGroup, content.nextMoves, nextMove, setNextMove),
      chosenMove
        ? h(Container, { border: 'all', padding: 'md', role: 'status', 'aria-live': 'polite', 'aria-label': `${content.labels.nextMove}: ${chosenMove.label}` }, paragraph(chosenMove.plan))
        : paragraph('What could help the person meet both requirements?'),
    ),

    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
      paragraph('The manuscript describes optional brief palm cooling with comfortably cool water or a suitable surface. It establishes no exact temperature or alertness mechanism.'),
      h(Text, { as: 'p', variant: 'body' }, `${content.source.manuscriptLocator}.`),
      h(Text, { as: 'p', variant: 'body' }, `External context only: NCCIH, Meditation and Mindfulness — ${content.source.externalContext}`),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm037-practice-heading' },
      heading(content.labels.practice, 'h2', 'm037-practice-heading'),
      ...fields.map(key => {
        const id = `m037-practice-${key}`;
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
            'aria-describedby': missing ? 'm037-practice-feedback' : undefined,
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
      practice.status ? h(Text, { as: 'p', id: 'm037-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
