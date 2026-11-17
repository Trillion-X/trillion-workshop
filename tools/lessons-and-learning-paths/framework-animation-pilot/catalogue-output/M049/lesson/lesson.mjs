import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [active, setActive] = useState(false);
  const [directAction, setDirectAction] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm049-empty-point',
  });
  const disabled = practice.loading || practice.locked;
  const missing = attemptedSave && !practice.values.result.trim();
  const title = (value, as, id) => h(Text, {
    as,
    id,
    variant: as === 'h1' ? 'heading-xl' : as === 'h2' ? 'heading-lg' : 'body',
  }, value);

  const endPractice = () => {
    setActive(false);
    setDirectAction(false);
  };

  return h(Container, {
    as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg',
  },
  h(Container, { gap: 'sm' }, title(content.title, 'h1'), h('p', null, content.opening)),

  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm049-practice-heading' },
    title(content.labels.practice, 'h2', 'm049-practice-heading'),
    !directAction
      ? h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
        h(Button, {
          variant: active ? 'secondary' : 'primary',
          disabled,
          'aria-pressed': active,
          onClick: () => active ? endPractice() : setActive(true),
        }, active ? content.labels.stop : content.labels.begin),
        !active ? h(Button, { variant: 'secondary', disabled, onClick: () => setDirectAction(true) }, content.labels.directAction) : null)
      : null,
    active
      ? h(Container, { as: 'section', gap: 'md' },
        h(Container, { as: 'ol', gap: 'md', 'aria-label': content.labels.steps }, ...content.steps.map((step, index) =>
          h(Container, { as: 'li', key: index, layout: 'horizontal', gap: 'sm', alignItems: 'start' },
            h(Text, { as: 'span', variant: 'body', 'aria-hidden': 'true' }, `${index + 1}.`),
            h('p', null, step)))),
        h('p', null, 'If the next action is clear, you can stop here and take it.'),
        h(Button, { variant: 'secondary', disabled, onClick: () => { setActive(false); setDirectAction(true); } }, content.labels.directAction))
      : null,
    directAction
      ? h(Container, { gap: 'sm', role: 'status', 'aria-live': 'polite' },
        h('p', null, 'You can take the practical step that is already clear. The pause does not need to come first.'),
        h(Button, { variant: 'secondary', onClick: endPractice }, content.labels.return))
      : null,
    !active && !directAction ? h('p', null, 'Use the pause only if it suits this moment. You can stop at any point.') : null),

  h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm049-application-heading' },
    title(content.labels.application, 'h2', 'm049-application-heading'),
    h('p', null, content.application)),

  h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm049-note-heading' },
    title(content.labels.note, 'h2', 'm049-note-heading'),
    h('p', null, content.notePrompt),
    h(Textarea, {
      id: 'm049-private-note',
      label: content.practice.result,
      rows: 3,
      autoGrow: true,
      maxHeight: 240,
      maxLength: 2000,
      required: true,
      'aria-invalid': missing ? 'true' : undefined,
      'aria-describedby': missing ? 'm049-practice-feedback' : undefined,
      value: practice.values.result,
      disabled,
      onChange: event => practice.setValue('result', event.target.value),
    }),
    practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your private note.') : null,
    practice.locked ? h('p', null, content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary',
      work: null,
      disabled: practice.loading || practice.saving,
      onClick: () => { setAttemptedSave(true); return practice.save(); },
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, {
      as: 'p', id: 'm049-practice-feedback', role: 'status', 'aria-live': 'polite',
    }, practice.status) : null),

  h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm049-source-heading' },
    title(content.labels.source, 'h2', 'm049-source-heading'),
    h('blockquote', null, h('p', null, content.sourceExcerpt)),
    h('p', null, content.source.manuscript)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
