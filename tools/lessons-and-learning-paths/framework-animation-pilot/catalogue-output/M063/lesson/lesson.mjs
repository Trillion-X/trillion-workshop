import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['step', 'result', 'observation', 'zoom', 'revision', 'comparison', 'alternative', 'transfer', 'prediction'];
const emptyNotes = () => Object.fromEntries(fields.map(key => [key, '']));

function Lesson({ surfaceInput, host }) {
  const [notes, setNotes] = useState(emptyNotes);
  const [notice, setNotice] = useState('');
  const [overLimit, setOverLimit] = useState([]);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.messages,
    requestPrefix: 'm063-self-authoring-values',
    onRestore: record => setNotes(Object.fromEntries(fields.map(key => [
      key, typeof record[key] === 'string' ? record[key] : '',
    ]))),
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const setField = (key, value) => {
    practice.markEdited();
    practice.setValue('step', key === 'step' ? value : notes.step);
    setNotes(current => ({ ...current, [key]: value }));
    setOverLimit(current => current.filter(item => item !== key));
    setNotice('');
  };
  const field = (key, rows = 3) => {
    const id = `m063-note-${key}`;
    const value = notes[key];
    const tooLong = value.length > 2000;
    const helpId = 'm063-capacity-hint';
    const errorId = `${id}-error`;
    const describedBy = tooLong ? `${helpId} ${errorId}` : helpId;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.labels[key]),
      h(Textarea, {
        id,
        rows,
        autoGrow: true,
        maxHeight: 300,
        value,
        disabled,
        'aria-invalid': tooLong ? 'true' : undefined,
        'aria-describedby': describedBy,
        onChange: event => setField(key, event.target.value),
      }),
      tooLong ? h(Text, { as: 'p', variant: 'body', id: errorId, role: 'alert' }, content.messages.length) : null);
  };
  const loadExample = () => {
    if (disabled) return;
    const next = { ...notes };
    for (const key of fields) if (!next[key].trim()) next[key] = content.example[key];
    practice.markEdited();
    for (const key of fields) practice.setValue(key, next[key]);
    setNotes(next);
    setOverLimit([]);
    setNotice('The worked example filled only blank notes. Each note is editable.');
  };
  const save = () => {
    const over = fields.filter(key => notes[key].length > 2000);
    setOverLimit(over);
    setNotice('');
    if (over.length) return;
    practice.setValue('step', notes.step);
    practice.save(Object.fromEntries(fields.filter(key => key !== 'step').map(key => [key, notes[key]])));
  };
  const section = (id, title, children, gap = 'md') => h(Container, {
    as: 'section', gap, 'aria-labelledby': id,
  }, heading(title, 'h2', id), ...children);
  const actionsDisabled = practice.loading || practice.saving;
  const status = notice || practice.status;

  return h(Container, {
    as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg',
  },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),
    h(Container, {
      as: 'section', border: 'all', padding: 'md', gap: 'sm',
      'aria-labelledby': 'm063-example-heading',
    },
      heading(content.example.title, 'h2', 'm063-example-heading'),
      paragraph('One person can make room for a teammate in one discussion, then push past someone else when their own idea is challenged. The first episode suggests fairness or listening; the second adds evidence about defensiveness and whose views count. The same examples support more than one reading.'),
      paragraph('Try a low-stakes next step: ask whose view is missing before arguing for your own. If that action does not clarify the choice, keep looking.'),
      h(Button, { variant: 'secondary', disabled: actionsDisabled || practice.locked, onClick: loadExample }, content.labels.example)),
    section('m063-conduct-heading', content.labels.conduct, [
      paragraph('Name actions or patterns you can point to. A strength and a difficulty may both be present; neither is a verdict about who you are.'),
      field('result'),
      field('alternative'),
    ]),
    section('m063-episodes-heading', 'Choose episodes that help', [
      paragraph('You can use an ordinary recent event, leave these notes blank, or skip this section. Keep only context and consequences you want to include.'),
      field('observation'), field('zoom'), field('revision'),
    ]),
    section('m063-comparison-heading', 'Compare what mattered', [
      paragraph('Look across the examples you chose. What mattered in each? Similar emotion does not mean the same concern, and one episode need not settle the answer.'),
      field('comparison', 4),
    ]),
    section('m063-current-heading', 'Try a tentative value in current action', [
      paragraph('Write a possible value in your own words and keep another reading open. Choose a small current action that could clarify the difference.'),
      field('prediction'), field('transfer'),
    ]),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm063-private-heading' },
      heading('Your private reflection', 'h2', 'm063-private-heading'),
      paragraph(content.messages.capacity, { id: 'm063-capacity-hint' }),
      paragraph('The summary note is required to save; the conduct, episode, comparison and value notes above are optional. A recent ordinary event is enough, and you may skip memory notes altogether.'),
      field('step'),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': 'Private reflection actions' },
        h(Button, {
          variant: 'primary',
          disabled: actionsDisabled,
          onClick: save,
        }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save)),
      status ? paragraph(status, { role: 'status', 'aria-live': 'polite' }) : null,
      overLimit.length ? paragraph(content.messages.length, { role: 'alert' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
