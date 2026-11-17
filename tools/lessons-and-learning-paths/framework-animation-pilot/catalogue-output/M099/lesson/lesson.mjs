import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [motive, setMotive] = useState('outcome');
  const [presentation, setPresentation] = useState('honest');
  const [draft, setDraft] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm099-authenticity-motivation-matrix',
    onRestore: record => setDraft(typeof record.result === 'string' ? record.result : ''),
  });
  const disabled = practice.loading || practice.saving || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', h4: 'heading-xs' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const choice = (axis, value, selected, setValue, label) => h(Button, {
    key: value,
    variant: selected === value ? 'primary' : 'secondary',
    'aria-pressed': selected === value,
    onClick: () => setValue(value),
  }, label);
  const currentLabel = `${motive === 'activity' ? content.labels.activity : motive === 'outcome' ? content.labels.outcome : content.labels.mixed} / ${presentation === 'honest' ? content.labels.honest : presentation === 'disguised' ? content.labels.disguised : content.labels.unknown}`;
  const status = motive === 'mixed'
    ? content.labels.statusMixed
    : motive === 'unknown' && presentation === 'unknown' ? content.labels.statusUnknownBoth
      : motive === 'unknown' ? content.labels.statusUnknownMotive
        : presentation === 'unknown' ? content.labels.statusUnknownPresentation
          : content.labels.statusKnown.replace('{motive}', motive === 'activity' ? content.labels.activity : content.labels.outcome).replace('{presentation}', presentation === 'honest' ? content.labels.honest : content.labels.disguised);
  const matrix = h(Container, { as: 'div', gap: 'sm', role: 'table', 'aria-label': content.labels.matrixHeading },
    h(Container, { as: 'div', layout: 'responsive-split', gap: 'sm', role: 'row' },
      h(Text, { as: 'div', variant: 'body', role: 'columnheader' }, content.labels.motiveAxis),
      h(Text, { as: 'div', variant: 'body', role: 'columnheader' }, content.labels.honestAxis),
      h(Text, { as: 'div', variant: 'body', role: 'columnheader' }, content.labels.disguisedAxis)),
    ...[
      { key: 'activity', label: content.labels.intrinsic, honest: content.labels.intrinsicHonest, disguised: content.labels.intrinsicDisguised },
      { key: 'outcome', label: content.labels.extrinsic, honest: content.labels.extrinsicHonest, disguised: content.labels.extrinsicDisguised },
    ].map(row => h(Container, { key: row.key, as: 'div', layout: 'responsive-split', gap: 'sm', role: 'row' },
      h(Text, { as: 'div', variant: 'body', role: 'rowheader' }, row.label),
      ...['honest', 'disguised'].map(col => h(Container, {
        key: col, as: 'div', border: motive === row.key && presentation === col ? 'all' : 'none', padding: 'sm', gap: 'xs', role: 'cell',
        'aria-current': motive === row.key && presentation === col ? 'true' : undefined,
      }, p(row[col]))))));
  const field = h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm099-private-reflection' }, content.labels.practiceField),
    h(Textarea, {
      id: 'm099-private-reflection', rows: 8, autoGrow: true, maxHeight: 320,
      placeholder: content.labels.practicePlaceholder, 'aria-label': content.labels.practiceField,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm099-practice-length-error' : undefined,
      value: draft, disabled,
      onChange: event => {
        const value = event.target.value;
        setDraft(value); setTooLong(value.length > 2000); practice.markEdited();
        practice.setValue('result', value.length <= 2000 ? value : '');
      },
    }));
  const practiceCard = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm099-practice-heading' },
    heading(content.labels.attempt, 'h2', 'm099-practice-heading'), p(content.labels.attemptIntro), field,
    tooLong ? h(Text, { as: 'p', id: 'm099-practice-length-error', variant: 'body', role: 'alert' }, content.labels.oversize) : null,
    h(Button, { variant: 'primary', disabled: practice.loading || practice.saving || tooLong, onClick: () => { void practice.save(); } },
      practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    p(content.labels.private),
    practice.status ? h(Text, { as: 'p', variant: 'body', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle), p(content.labels.sourceExcerpt), p(content.source.manuscriptLocator));
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm099-case-heading' },
      heading(content.labels.example, 'h2', 'm099-case-heading'), p(content.labels.exampleAction), p(content.labels.exampleEvidence),
      h(Container, { gap: 'xs' }, heading(content.labels.motive, 'h3'),
        h(Container, { layout: 'responsive-split', gap: 'sm' },
          choice('motive', 'activity', motive, setMotive, content.labels.activity),
          choice('motive', 'outcome', motive, setMotive, content.labels.outcome),
          choice('motive', 'mixed', motive, setMotive, content.labels.mixed),
          choice('motive', 'unknown', motive, setMotive, content.labels.unknown))),
      h(Container, { gap: 'xs' }, heading(content.labels.presentation, 'h3'),
        h(Container, { layout: 'responsive-split', gap: 'sm' },
          choice('presentation', 'honest', presentation, setPresentation, content.labels.honest),
          choice('presentation', 'disguised', presentation, setPresentation, content.labels.disguised),
          choice('presentation', 'unknown', presentation, setPresentation, content.labels.unknown))),
      h(Container, { border: 'quote', padding: 'md', gap: 'xs', 'aria-live': 'polite', 'aria-atomic': 'true' },
        heading(content.labels.currentCase, 'h4'), p(currentLabel), p(status)),
      heading(content.labels.matrixHeading, 'h3'), matrix,
      p(content.labels.controlsHelp)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm099-boundary-heading' },
      heading(content.labels.boundaryHeading, 'h2', 'm099-boundary-heading'), p(content.labels.boundaryBody)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm099-change-heading' },
      heading(content.labels.changeHeading, 'h2', 'm099-change-heading'), p(content.labels.changeBody)),
    practiceCard, source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
