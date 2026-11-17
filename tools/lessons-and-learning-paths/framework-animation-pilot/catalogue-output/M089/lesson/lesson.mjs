import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['step', 'observation', 'revision', 'zoom', 'comparison', 'alternative'];
const emptyNotes = () => Object.fromEntries(fields.map(key => [key, '']));

function Lesson({ surfaceInput, host }) {
  const [notes, setNotes] = useState(emptyNotes);
  const [exampleView, setExampleView] = useState('interpretation');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [overLimit, setOverLimit] = useState([]);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: {
      length: content.messages.length,
      missing: content.messages.missing,
      saved: content.messages.saved,
      conflict: content.messages.conflict,
      saveFailure: content.messages.saveFailure,
      readbackFailure: content.messages.readbackFailure,
    },
    requestPrefix: 'm089-friction-practice',
    onRestore: record => {
      setNotes(Object.fromEntries(fields.map(key => [
        key, typeof record[key] === 'string' ? record[key] : '',
      ])));
    },
  });
  const busy = practice.loading || practice.saving;
  const locked = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const setField = (key, value) => {
    practice.markEdited();
    if (key === 'step') practice.setValue('step', value);
    setNotes(current => ({ ...current, [key]: value }));
    setOverLimit(current => current.filter(item => item !== key));
    setNotice('');
  };
  const field = (key, rows = 3) => {
    const id = `m089-note-${key}`;
    const errorId = `${id}-error`;
    const value = notes[key];
    const tooLong = value.length > 2000;
    const describedBy = [
      'm089-capacity-hint',
      key === 'step' ? 'm089-required-hint' : null,
      tooLong ? errorId : null,
    ].filter(Boolean).join(' ') || undefined;
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.labels[key]),
      key === 'step' ? paragraph('One concrete moment is needed to save; the other notes can stay blank.', { id: 'm089-required-hint' }) : null,
      h(Textarea, {
        id,
        rows,
        autoGrow: true,
        maxHeight: 300,
        value,
        disabled: locked,
        'aria-invalid': tooLong ? 'true' : undefined,
        'aria-describedby': describedBy,
        onChange: event => setField(key, event.target.value),
      }),
      tooLong ? h(Text, { as: 'p', variant: 'body', id: errorId, role: 'alert' }, content.messages.length) : null);
  };
  const loadExample = () => {
    if (locked) return;
    const next = { ...notes };
    const example = {
      step: content.example.task,
      observation: 'A tight feeling in my chest.',
      revision: 'If the update sounds rough, my teammate will think I am careless.',
      zoom: 'That a rough recording would prove I do not care about the work.',
      comparison: 'Whether I have a working microphone and what format the teammate can use.',
      alternative: 'Check the prediction or the equipment first. The answer may call for a short draft, a different format, a request for access, or stopping.',
    };
    for (const key of fields) if (!next[key].trim()) next[key] = example[key];
    practice.markEdited();
    practice.setValue('step', next.step);
    setNotes(next);
    setOverLimit([]);
    setNotice('The example filled blank notes only. Every note remains editable.');
  };
  const save = () => {
    const over = fields.filter(key => notes[key].length > 2000);
    setOverLimit(over);
    setNotice('');
    if (over.length) return;
    practice.setValue('step', notes.step);
    practice.save(Object.fromEntries(fields.filter(key => key !== 'step').map(key => [key, notes[key]])));
  };
  const example = content.example[exampleView];
  const section = (id, title, children, gap = 'md') => h(Container, {
    as: 'section', gap, 'aria-labelledby': id,
  }, heading(title, 'h2', id), ...children);
  const status = notice || practice.status;

  return h(Container, {
    as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg',
  },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm089-example-heading' },
      heading(content.example.title, 'h2', 'm089-example-heading'),
      paragraph(content.example.task),
      h(Container, { role: 'group', 'aria-label': 'Compare possible causes of the same resistance', gap: 'sm' },
        h(Button, {
          variant: exampleView === 'interpretation' ? 'primary' : 'secondary',
          disabled: locked,
          'aria-pressed': exampleView === 'interpretation',
          onClick: () => setExampleView('interpretation'),
        }, content.labels.interpretation),
        h(Button, {
          variant: exampleView === 'obstacle' ? 'primary' : 'secondary',
          disabled: locked,
          'aria-pressed': exampleView === 'obstacle',
          onClick: () => setExampleView('obstacle'),
        }, content.labels.obstacle)),
      h(Container, { gap: 'sm', 'aria-live': 'polite', 'aria-atomic': 'true' },
        h(Text, { as: 'h3', variant: 'heading-md' }, exampleView === 'interpretation' ? 'Inspect the prediction' : 'Check the missing condition'),
        paragraph(`Thought: ${example.thought}`),
        paragraph(`Task condition: ${example.condition}`),
        paragraph(`Possible response: ${example.response}`)),
      paragraph('The two readings can coexist. A feeling may remain after a practical obstacle is fixed, and a changed arrangement cannot settle every interpretation.'),
      h(Button, { variant: 'secondary', disabled: busy || practice.locked, onClick: loadExample }, content.labels.example)),
    section('m089-try-heading', 'Try it with a real moment', [
      paragraph('Choose a manageable task. You can keep any note blank except the concrete moment needed to save. You do not have to make yourself feel better or force the task to continue.'),
      field('step'), field('observation'), field('revision'), field('zoom'), field('comparison'), field('alternative'),
    ]),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm089-source-heading' },
      h(Button, {
        variant: 'secondary',
        'aria-expanded': sourceOpen,
        'aria-controls': 'm089-source-quote',
        onClick: () => setSourceOpen(value => !value),
      }, content.labels.source),
      sourceOpen ? h(Container, { id: 'm089-source-quote', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm089-source-heading' },
        heading('Source wording', 'h2', 'm089-source-heading'),
        paragraph(`“${content.sourceQuote}”`),
        paragraph(content.sourceLocator)) : null),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm089-private-heading' },
      heading('Private practice notes', 'h2', 'm089-private-heading'),
      paragraph(content.messages.capacity, { id: 'm089-capacity-hint' }),
      h(Container, { role: 'group', 'aria-label': 'Private practice actions', gap: 'sm' },
        h(Button, { variant: 'primary', disabled: busy, onClick: save },
          practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save)),
      status ? paragraph(status, { role: 'status', 'aria-live': 'polite' }) : null,
      overLimit.length ? paragraph('Shorten the notes marked above before saving.', { role: 'alert', 'aria-live': 'assertive' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
