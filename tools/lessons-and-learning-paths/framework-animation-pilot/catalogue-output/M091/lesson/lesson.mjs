import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [lens, setLens] = useState('task');
  const [draft, setDraft] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm091-wholeness-reflection',
    onRestore: record => setDraft(typeof record.result === 'string' ? record.result : ''),
  });
  const disabled = practice.loading || practice.saving || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', h4: 'heading-xs' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const episodeCard = (episode, index) => {
    const id = `m091-episode-${index}`;
    return h(Container, {
      key: episode.title,
      as: 'article',
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': id,
    },
      heading(episode.title, 'h3', id),
      p(episode.kind),
      heading('What it contributed', 'h4'),
      p(episode.contribution),
      heading('What was resisted', 'h4'),
      p(episode.resistance));
  };
  const field = h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm091-private-reflection' }, content.labels.practiceField),
    h(Textarea, {
      id: 'm091-private-reflection',
      rows: 10,
      autoGrow: true,
      maxHeight: 320,
      placeholder: content.labels.practicePlaceholder,
      'aria-label': content.labels.practiceField,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm091-practice-length-error' : undefined,
      value: draft,
      disabled,
      onChange: event => {
        const value = event.target.value;
        setDraft(value);
        setTooLong(value.length > 2000);
        practice.markEdited();
        practice.setValue('result', value.length <= 2000 ? value : '');
      },
    }));
  const practiceCard = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'md',
    'aria-labelledby': 'm091-practice-heading',
  },
    heading(content.labels.attempt, 'h2', 'm091-practice-heading'),
    p(content.labels.attemptIntro),
    field,
    tooLong ? h(Text, { as: 'p', id: 'm091-practice-length-error', variant: 'body', role: 'alert' }, content.labels.oversize) : null,
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving || tooLong,
      onClick: () => { void practice.save(); },
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    p(content.labels.private),
    practice.status ? h(Text, { as: 'p', variant: 'body', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt), p(content.source.manuscriptLocator));
  const lensButtons = h(Container, { layout: 'responsive-split', gap: 'sm' },
    h(Button, {
      variant: lens === 'task' ? 'primary' : 'secondary',
      'aria-pressed': lens === 'task',
      onClick: () => setLens('task'),
    }, content.labels.taskLens),
    h(Button, {
      variant: lens === 'whole' ? 'primary' : 'secondary',
      'aria-pressed': lens === 'whole',
      onClick: () => setLens('whole'),
    }, content.labels.wholeLens));
  const reflectionView = lens === 'task'
    ? h(Container, { as: 'section', border: 'quote', padding: 'md', gap: 'sm', 'aria-live': 'polite', 'aria-atomic': 'true' },
      heading(content.labels.taskLensHeading, 'h3'),
      p(content.labels.taskLensBody))
    : h(Container, { as: 'section', gap: 'md', 'aria-live': 'polite', 'aria-atomic': 'true' },
      heading(content.labels.wholeLensHeading, 'h3'),
      ...content.labels.episodes.map(episodeCard),
      h(Container, { border: 'quote', padding: 'md', gap: 'xs' },
        heading(content.labels.choiceHeading, 'h4'), p(content.labels.choiceBody)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm091-example-heading' },
      heading(content.labels.example, 'h2', 'm091-example-heading'),
      p(content.labels.exampleContext),
      lensButtons,
      reflectionView),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm091-boundary-heading' },
      heading(content.labels.counterexampleHeading, 'h2', 'm091-boundary-heading'),
      p(content.labels.counterexampleBody)),
    practiceCard,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
