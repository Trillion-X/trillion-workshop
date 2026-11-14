import React from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['comparison', 'transfer'],
    messages: content.feedback,
    requestPrefix: 'm066-finding-deeper-patterns-through-abstraction',
  });
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const field = (key, headingText, fieldLabel, prompt, id) => h(Container, {
    as: 'section',
    gap: 'sm',
    'aria-labelledby': `${id}-heading`,
  },
  heading(headingText, 'h2', `${id}-heading`),
  paragraph(prompt),
  h(Text, { as: 'label', variant: 'body', htmlFor: id }, fieldLabel),
  h(Textarea, {
    id,
    rows: 6,
    autoGrow: true,
    maxHeight: 320,
    value: practice.values[key],
    'aria-describedby': practice.values[key].length > 2000 && practice.status === content.feedback.length ? 'm066-practice-length-error' : undefined,
    disabled: practice.locked,
    onChange: event => practice.setValue(key, event.target.value),
  }));

  return h(Container, { as: 'main', maxWidth: '3xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm066-method-heading' },
      heading(content.labels.method, 'h2', 'm066-method-heading'),
      h(Container, { as: 'ol', gap: 'md' }, ...content.actions.map((action, index) => h(Container, {
        key: action,
        as: 'li',
        gap: 'xs',
      }, paragraph(h(React.Fragment, null,
        h(Text, { as: 'span', variant: 'body', 'aria-hidden': true }, `${index + 1}. `), action)),
      index === 1 ? paragraph(content.teaching.mechanism) : null,
      index === 2 ? paragraph(content.teaching.guardrail) : null))),
      paragraph(content.teaching.transfer),
      paragraph(content.teaching.action)),

    field('comparison', content.labels.comparison, 'Your examples and possible pattern', content.labels.comparisonPrompt, 'm066-practice-comparison'),
    field('transfer', 'Try the pattern in another context', 'Your transfer and action', content.labels.transferPrompt, 'm066-practice-transfer'),

    hContainerPractice(practice));
}

function hContainerPractice(practice) {
  return h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm066-save-heading' },
    h(Text, { as: 'h2', id: 'm066-save-heading', variant: 'heading-lg' }, 'Keep your working comparison'),
    practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved comparison.') : null,
    practice.locked ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary',
      work: null,
      disabled: practice.loading || practice.saving,
      onClick: () => practice.save(),
    }, practice.saving ? 'Saving comparison' : practice.locked ? 'Retry the same save' : 'Save private comparison'),
    practice.status ? h(Text, {
      as: 'p',
      id: practice.status === content.feedback.length
        ? 'm066-practice-length-error'
        : undefined,
      role: 'status',
      'aria-live': 'polite',
    }, practice.status) : null);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
