import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { renderAttentionDiagram } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const objects = Object.keys(content.labels.objects);
const responses = Object.keys(content.labels.responses);

function Lesson({ surfaceInput, host }) {
  const [object, setObject] = useState('visual');
  const [path, setPath] = useState('returnPath');
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['observation'], messages: content.feedback,
    requestPrefix: 'm042-non-striving-attention-practice',
  });
  const figure = useMemo(() => renderAttentionDiagram(path, content.labels), [path]);
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);
  const objectControls = h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.chooseObject },
    ...objects.map(key => h(Button, {
      key, variant: object === key ? 'primary' : 'secondary', 'aria-pressed': object === key,
      disabled, onClick: () => setObject(key),
    }, content.labels.objects[key])));
  const responseControls = h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.responseGroup },
    ...responses.map(key => h(Button, {
      key, variant: path === key ? 'primary' : 'secondary', 'aria-pressed': path === key,
      disabled, onClick: () => setPath(key),
    }, content.labels.responses[key])));
  const focusContent = object === 'visual'
    ? h(Container, { gap: 'sm' },
      paragraph(content.labels.visualInstruction),
      responseControls,
      h(AnatomyFigure, { figure, label: content.labels.diagramDescription, className: 'anatomy-figure--contained' }))
    : paragraph(content.labels[`${object}Instruction`]);
  const note = h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm042-note-heading' },
    heading(content.labels.noteHeading, 'h2', 'm042-note-heading'),
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm042-note' }, content.practice.observation),
    h(Textarea, {
      id: 'm042-note', rows: 3, autoGrow: true, maxHeight: 220,
      value: practice.values.observation ?? '', disabled,
      onChange: event => practice.setValue('observation', event.target.value),
    }),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', align: 'center' },
      h(Button, { variant: 'primary', disabled: disabled || practice.saving || !practice.values.observation?.trim(), onClick: () => void practice.save() }, content.labels.save),
      [content.feedback.saveFailure, content.feedback.readbackFailure, content.feedback.retryPending].includes(practice.status)
        ? h(Button, { variant: 'secondary', disabled: practice.loading || practice.saving, onClick: () => void practice.save() }, content.labels.retry)
        : null,
      practice.status ? h(Text, { as: 'p', variant: 'body', role: 'status' }, practice.status) : null));

  return h(Container, { as: 'article', layout: 'vertical', gap: 'lg', padding: 'lg', 'aria-labelledby': 'm042-title' },
    h(Container, { as: 'header', gap: 'sm' }, heading(content.title, 'h1', 'm042-title'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm042-focus-heading' },
      heading(content.labels.chooseObject, 'h2', 'm042-focus-heading'),
      objectControls,
      focusContent),
    note,
    paragraph(content.labels.stopBoundary));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
