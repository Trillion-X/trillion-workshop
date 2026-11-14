import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const emptyNoticing = () => ({ internal: '', external: '' });
const parseNoticing = value => {
  if (typeof value !== 'string') return emptyNoticing();
  try {
    const parsed = JSON.parse(value);
    return {
      internal: typeof parsed?.internal === 'string' ? parsed.internal : '',
      external: typeof parsed?.external === 'string' ? parsed.external : '',
    };
  } catch { return emptyNoticing(); }
};

function Lesson({ surfaceInput, host }) {
  const [phase, setPhase] = useState('before');
  const [noticing, setNoticing] = useState(emptyNoticing);
  const [next, setNext] = useState('');
  const [attempted, setAttempted] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result', 'transfer'],
    messages: content.feedback,
    requestPrefix: 'm088-awareness-checkin',
    onRestore: record => {
      setNoticing(parseNoticing(record.result));
      setNext(typeof record.transfer === 'string' ? record.transfer : '');
    },
  });
  const disabled = practice.loading || practice.locked;
  const longNoticing = practice.values.result.length > 2000;
  const longNext = practice.values.transfer.length > 2000;
  const missingInternal = attempted && !noticing.internal.trim();
  const missingExternal = attempted && !noticing.external.trim();
  const missingNext = attempted && !next.trim();
  const missingPractice = missingInternal || missingExternal || missingNext;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const textarea = ({ id, label, value, onChange, invalid, errorId, error, rows = 2 }) => h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
    h(Textarea, {
      id, rows, autoGrow: true, maxHeight: 240,
      value,
      disabled,
      'aria-invalid': invalid ? 'true' : undefined,
      'aria-describedby': invalid && errorId ? errorId : undefined,
      onChange: event => onChange(event.target.value),
    }),
    error ? paragraph(error, { id: errorId, role: 'alert' }) : null);
  const updateNoticing = (key, value) => {
    const nextNoticing = { ...noticing, [key]: value };
    setNoticing(nextNoticing);
    practice.markEdited();
    practice.setValue('result', JSON.stringify(nextNoticing));
  };
  const updateNext = value => {
    setNext(value);
    practice.setValue('transfer', value);
  };
  const save = async () => {
    setAttempted(true);
    if (!noticing.internal.trim() || !noticing.external.trim() || !next.trim() || longNoticing || longNext) return;
    await practice.save();
  };
  const phaseContent = {
    before: h(Container, { gap: 'sm', 'aria-labelledby': 'm088-before-heading' },
      heading(content.labels.beforeHeading, 'h3', 'm088-before-heading'),
      paragraph(content.labels.before)),
    notice: h(Container, { gap: 'md', 'aria-labelledby': 'm088-notice-heading' },
      heading(content.labels.noticeHeading, 'h3', 'm088-notice-heading'),
      h(Container, { layout: 'grid', gap: 'sm' }, ...content.example.observations.map(row => h(Container, {
        key: row.label, border: 'all', padding: 'md', gap: 'xs', 'aria-label': row.label,
      }, h(Text, { as: 'h4', variant: 'heading-sm' }, row.label), paragraph(row.value))),
      h(Container, { border: 'all', padding: 'md', gap: 'xs' },
        h(Text, { as: 'h4', variant: 'heading-sm' }, content.labels.storyHeading),
        paragraph(content.labels.observation), paragraph(content.example.story)))),
    continue: h(Container, { gap: 'sm', 'aria-labelledby': 'm088-continue-heading' },
      heading(content.labels.continueHeading, 'h3', 'm088-continue-heading'),
      paragraph(content.example.relevant),
      paragraph(content.example.action),
      paragraph(content.labels.notRequired)),
  };
  const example = h(Container, { as: 'section', border: 'all', padding: 'lg', gap: 'md', 'aria-labelledby': 'm088-example-heading' },
    heading(content.labels.example, 'h2', 'm088-example-heading'),
    h(Container, { role: 'group', 'aria-label': content.labels.phases, layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
      ...[
        ['before', content.labels.phaseBefore],
        ['notice', content.labels.phaseNotice],
        ['continue', content.labels.phaseContinue],
      ].map(([key, label]) => h(Button, {
        key, variant: phase === key ? 'primary' : 'secondary',
        'aria-pressed': phase === key,
        onClick: () => setPhase(key),
      }, label))),
    phaseContent[phase]);
  const privatePractice = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm088-practice-heading' },
    heading(content.labels.practiceHeading, 'h2', 'm088-practice-heading'),
    paragraph(content.labels.practiceIntro),
    practice.loading ? paragraph('Loading your saved reflection.', { role: 'status', 'aria-live': 'polite' }) : null,
    textarea({
      id: 'm088-internal', label: content.practice.internal, value: noticing.internal,
      invalid: missingInternal || longNoticing, errorId: missingPractice ? 'm088-practice-missing-error' : 'm088-noticing-length-error',
      onChange: value => updateNoticing('internal', value),
    }),
    textarea({
      id: 'm088-external', label: content.practice.external, value: noticing.external,
      invalid: missingExternal || longNoticing, errorId: missingPractice ? 'm088-practice-missing-error' : 'm088-noticing-length-error',
      onChange: value => updateNoticing('external', value),
    }),
    missingPractice ? paragraph(content.feedback.missing, { id: 'm088-practice-missing-error', role: 'alert' }) : null,
    longNoticing ? paragraph(content.feedback.length, { id: 'm088-noticing-length-error', role: 'alert' }) : null,
    textarea({
      id: 'm088-next', label: content.practice.next, value: next,
      invalid: missingNext || longNext, errorId: missingPractice ? 'm088-practice-missing-error' : 'm088-next-length-error',
      onChange: updateNext, rows: 3,
    }),
    paragraph(content.labels.privacy),
    practice.locked ? paragraph(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', work: null,
      disabled: practice.loading || practice.saving,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? paragraph(practice.status, { id: 'm088-practice-status', role: 'status', 'aria-live': 'polite' }) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    paragraph(content.labels.sourceQuote),
    paragraph(content.labels.sourceLocator));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    example,
    privatePractice,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
