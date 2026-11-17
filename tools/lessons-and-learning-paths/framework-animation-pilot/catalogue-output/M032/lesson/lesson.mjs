import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [interpretation, setInterpretation] = useState('');
  const [nextCheck, setNextCheck] = useState('');
  const [eventKind, setEventKind] = useState(content.eventKinds[0]);
  const [eventDate, setEventDate] = useState('');
  const [eventDetails, setEventDetails] = useState('');
  const [eventMessage, setEventMessage] = useState('');
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm032-goal-evidence-timeline' });
  const disabled = practice.loading || practice.locked;
  const paragraph = words => words ? h(Text, { as: 'p', variant: 'body' }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const selectedInterpretation = content.interpretations.find(item => item.id === interpretation);
  const selectedNextCheck = content.nextChecks.find(item => item.id === nextCheck);
  const savedEvents = practice.values.result.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}) \| (Practice|Instruction|Stage change|Comparison artifact) \| (.+)$/);
    return match ? [{ id: `saved-event-${index}`, date: match[1], kind: match[2], detail: match[3] }] : [];
  });
  const addEvent = () => {
    const date = eventDate.trim();
    const detail = eventDetails.trim();
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date || !detail) {
      setEventMessage('Enter a real date and the event conditions.');
      return;
    }
    const entry = `${date} | ${eventKind} | ${detail}`;
    practice.setValue('result', [practice.values.result.trim(), entry].filter(Boolean).join('\n'));
    setEventDate('');
    setEventDetails('');
    setEventMessage(`${eventKind} added for ${date}. Save your notes to keep it.`);
  };
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
  }, option.label)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm032-goal-heading' },
      heading(content.labels.goal, 'h2', 'm032-goal-heading'),
      h(Container, { layout: 'grid', gridColumns: 2, gap: 'sm' },
        ...[
          [content.labels.desired, content.goal.desired],
          [content.labels.current, content.goal.current],
          [content.labels.rate, content.goal.rate],
          [content.labels.target, content.goal.target],
        ].map(([label, value]) => h(Container, { key: label, as: 'article', border: 'all', padding: 'md', gap: 'xs' },
          h(Text, { as: 'h3', variant: 'heading-md' }, label), paragraph(value))),
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm032-timeline-heading' },
      heading(content.labels.timeline, 'h2', 'm032-timeline-heading'),
      h(Container, { as: 'ol', gap: 'sm', role: 'list', 'aria-label': content.labels.timeline },
        ...content.events.map(event => h(Container, {
          key: event.id, as: 'li', border: 'all', padding: 'md', gap: 'xs',
          'aria-label': `${event.date}: ${event.kind}. ${event.title}. ${event.detail}`,
        },
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
          h(Text, { as: 'span', variant: 'body' }, event.date),
          h(Text, { as: 'span', variant: 'body' }, event.kind)),
        h(Text, { as: 'h3', variant: 'heading-md' }, event.title),
        paragraph(event.detail))),
      ),
      savedEvents.length
        ? h(Container, { gap: 'sm', 'aria-labelledby': 'm032-your-events-heading' },
            heading(content.labels.yourEntries, 'h3', 'm032-your-events-heading'),
            h(Container, { as: 'ol', gap: 'sm', role: 'list', 'aria-label': content.labels.yourEntries },
              ...savedEvents.map(event => h(Container, {
                key: event.id, as: 'li', border: 'all', padding: 'md', gap: 'xs',
                'aria-label': `${event.date}: ${event.kind}. ${event.detail}`,
              },
                h(Container, { layout: 'horizontal', gap: 'sm' },
                  h(Text, { as: 'span', variant: 'body' }, event.date),
                  h(Text, { as: 'span', variant: 'body' }, event.kind)),
                paragraph(event.detail)))))
          : null,
      h(Container, { border: 'all', padding: 'md', gap: 'md', 'aria-label': content.labels.addEvent },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.addEvent),
        paragraph('Add an actual dated practice, instruction, stage change or comparison artifact. The entry is stored in your private timeline notes when you save them.'),
        choices('Event type', content.eventKinds.map(kind => ({ id: kind, label: kind })), eventKind, setEventKind),
        h(Container, { gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: 'm032-event-date' }, content.labels.eventDate),
          h(Textarea, { id: 'm032-event-date', rows: 1, autoGrow: true, maxHeight: 80, maxLength: 10, value: eventDate, disabled, onChange: event => setEventDate(event.target.value) })),
        h(Container, { gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: 'm032-event-details' }, content.labels.eventDetails),
          h(Textarea, { id: 'm032-event-details', rows: 2, autoGrow: true, maxHeight: 160, maxLength: 600, value: eventDetails, disabled, onChange: event => setEventDetails(event.target.value) })),
        h(Button, { variant: 'secondary', disabled, onClick: addEvent }, content.labels.addEvent),
        eventMessage ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, eventMessage) : null,
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm032-interpret-heading' },
      heading(content.labels.interpretation, 'h2', 'm032-interpret-heading'),
      choices(content.labels.interpretationGroup, content.interpretations, interpretation, setInterpretation),
      selectedInterpretation
        ? h(Container, { border: 'all', padding: 'md', gap: 'xs', role: 'status', 'aria-live': 'polite', 'aria-label': `Evidence status: ${selectedInterpretation.status}` },
            h(Text, { as: 'h3', variant: 'heading-md' }, selectedInterpretation.status),
            paragraph(selectedInterpretation.claim), paragraph(selectedInterpretation.feedback))
        : paragraph('Choose an interpretation to update the status attached to the later score.'),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm032-next-heading' },
      heading(content.labels.nextCheck, 'h2', 'm032-next-heading'),
      paragraph('Choose what conditions to use next. This is a plan; no future result exists yet.'),
      choices(content.labels.nextCheckGroup, content.nextChecks, nextCheck, setNextCheck),
      selectedNextCheck
        ? h(Container, { border: 'all', padding: 'md', role: 'status', 'aria-live': 'polite', 'aria-label': content.labels.future }, paragraph(selectedNextCheck.plan))
        : paragraph('No next check is selected.'),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm032-practice-heading' },
      heading(content.labels.practice, 'h2', 'm032-practice-heading'),
      ...fields.map(key => {
        const id = `m032-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm032-practice-feedback' : undefined,
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
      practice.status ? h(Text, { as: 'p', id: 'm032-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
