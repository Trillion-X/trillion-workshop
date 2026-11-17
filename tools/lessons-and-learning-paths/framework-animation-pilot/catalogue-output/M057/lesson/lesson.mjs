import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const optionalFields = ['alternative', 'comparison', 'observation', 'revision'];
const emptyOptional = () => Object.fromEntries(optionalFields.map(key => [key, '']));

function Lesson({ surfaceInput, host }) {
  const [notes, setNotes] = useState(emptyOptional);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.feedback,
    requestPrefix: 'm057-post-utility-life-design',
    onRestore: record => setNotes(Object.fromEntries(optionalFields.map(key => [key, typeof record[key] === 'string' ? record[key] : '']))),
  });
  const area = practice.values.step;
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);

  const field = (idKey, value, onChange) => {
    const id = `m057-${idKey}`;
    const label = content.labels[idKey];
    const promptId = `${id}-prompt`;
    const errorId = `${id}-error`;
    const overLimit = value.length > 2000;
    const describedBy = overLimit ? `${promptId} m057-capacity-hint ${errorId}` : `${promptId} m057-capacity-hint`;
    return h(Container, { key: idKey, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
      paragraph(content.labels[`${idKey}Prompt`], { id: promptId }),
      h(Textarea, {
        id,
        rows: idKey === 'commitments' ? 2 : 3,
        autoGrow: true,
        maxHeight: 260,
        value,
        disabled,
        'aria-invalid': overLimit ? 'true' : undefined,
        'aria-describedby': describedBy,
        onChange,
      }),
      overLimit ? paragraph(content.feedback.length, { id: errorId, role: 'alert' }) : null);
  };

  const updateArea = event => practice.setValue('step', event.target.value);
  const updateNote = key => event => {
    practice.setValue('step', area);
    setNotes(current => ({ ...current, [key]: event.target.value }));
  };
  const save = () => practice.save(Object.fromEntries(optionalFields.map(key => [key, notes[key]])));

  return h(Container, {
    as: 'main',
    maxWidth: '4xl',
    marginX: 'auto',
    width: 'full',
    padding: 'lg',
    gap: 'lg',
  },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, {
      as: 'section',
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': 'm057-example-heading',
    },
      heading(content.example.title, 'h2', 'm057-example-heading'),
      paragraph(content.example.body)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm057-plan-heading' },
      heading('Plan a small trial', 'h2', 'm057-plan-heading'),
      paragraph(content.labels.reviewWindow),
      field('area', area, updateArea),
      field('change', notes.alternative, updateNote('alternative')),
      field('commitments', notes.comparison, updateNote('comparison'))),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm057-review-heading' },
      heading('Review or revise', 'h2', 'm057-review-heading'),
      field('review', notes.observation, updateNote('observation')),
      field('decision', notes.revision, updateNote('revision'))),

    h(Container, { gap: 'sm', 'aria-labelledby': 'm057-private-notes-heading' },
      heading('Private notes', 'h2', 'm057-private-notes-heading'),
      paragraph('You can try the practice without saving. At least one area is needed to save a note.', { id: 'm057-capacity-hint' }),
      h(Button, {
        variant: 'primary',
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      practice.loading ? paragraph(content.labels.loading, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.status && ![area, ...optionalFields.map(key => notes[key])].some(value => value.length > 2000)
        ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
