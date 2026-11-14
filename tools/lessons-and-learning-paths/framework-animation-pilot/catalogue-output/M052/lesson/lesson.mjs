import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const optionalFields = ['comparison', 'observation', 'revision'];
const emptyNotes = () => Object.fromEntries(optionalFields.map(key => [key, '']));

function Lesson({ surfaceInput, host }) {
  const [notes, setNotes] = useState(emptyNotes);
  const [draftStep, setDraftStep] = useState('');
  const [notice, setNotice] = useState('');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.feedback,
    requestPrefix: 'm052-intrinsic-value-recognition',
    onRestore: record => {
      setDraftStep(typeof record.step === 'string' ? record.step : '');
      setNotes(Object.fromEntries(optionalFields.map(key => [
        key, typeof record[key] === 'string' ? record[key] : '',
      ])));
    },
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => words ? h(Text, { as: 'p', variant: 'body', ...props }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);

  const field = (key, rows = 3) => {
    const id = `m052-note-${key}`;
    const value = key === 'step' ? draftStep : notes[key];
    const overLimit = value.length > 2000;
    const onChange = event => {
      const next = event.target.value;
      if (key === 'step') {
        setDraftStep(next);
        practice.markEdited();
        practice.setValue('step', next.length <= 2000 ? next : practice.values.step);
      } else {
        practice.markEdited();
        practice.setValue('step', draftStep.length <= 2000 ? draftStep : practice.values.step);
        setNotes(current => ({ ...current, [key]: next }));
      }
      setNotice('');
    };
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.labels[key]),
      h(Textarea, {
        id,
        rows,
        autoGrow: true,
        maxHeight: 320,
        value,
        disabled,
        'aria-required': key === 'step' ? 'true' : undefined,
        'aria-invalid': overLimit ? 'true' : undefined,
        'aria-describedby': overLimit ? `m052-capacity-hint ${id}-error` : 'm052-capacity-hint',
        onChange,
      }),
      overLimit ? h(Text, { as: 'p', variant: 'body', id: `${id}-error`, role: 'alert' }, content.feedback.length) : null,
    );
  };

  const loadExample = () => {
    if (disabled) return;
    const example = content.practice.example;
    practice.markEdited();
    if (!draftStep.trim()) {
      setDraftStep(example.step);
      practice.setValue('step', example.step);
    }
    setNotes(current => Object.fromEntries(optionalFields.map(key => [
      key, current[key].trim() ? current[key] : example[key],
    ])));
    setNotice('The comparison was added to empty notes. You can edit each one.');
  };

  const save = () => {
    const allNotes = [draftStep, ...optionalFields.map(key => notes[key])];
    if (allNotes.some(value => value.length > 2000)) {
      setNotice('');
      return;
    }
    practice.setValue('step', draftStep);
    practice.save(Object.fromEntries(optionalFields.map(key => [key, notes[key]])));
  };

  const example = content.practice.example;
  const exampleSection = h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'sm',
    'aria-labelledby': 'm052-example-heading',
  },
    heading(example.title, 'h2', 'm052-example-heading'),
    paragraph(example.comparison),
    paragraph(example.observation),
    paragraph(example.step),
    paragraph(example.revision),
    h(Button, { variant: 'secondary', disabled, onClick: loadExample }, content.labels.example));

  const status = notice || practice.status;
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
    exampleSection,
    h(Container, { as: 'section', gap: 'lg', 'aria-labelledby': 'm052-practice-heading' },
      heading('Your note', 'h2', 'm052-practice-heading'),
      paragraph('Each note has a 2,000-character limit.', { id: 'm052-capacity-hint' }),
      field('step', 3),
      ...optionalFields.map(key => field(key, key === 'comparison' ? 5 : 3)),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': 'Private note actions' },
        h(Button, {
          variant: 'primary',
          disabled: practice.loading || practice.saving,
          onClick: save,
        }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save)),
      status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, status) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
