/*!
MIT License

Copyright (c) 2026 Ryan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { BOOK_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/book-materials.mjs';
import { INSTRUCTION_CASE_CSS } from '../../../../parts/screen-look/show/anatomy/instruction-case-materials.mjs';
import { caseScene, INITIAL_NEED, INITIAL_STAGE, NEED_IDS, STAGE_IDS } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'revision', 'step', 'result'];
const stages = new Map(content.views.map(view => [view.id, view]));
const needs = new Map(content.sides.map(side => [side.id, side]));
const appearanceCss = `${BOOK_MATERIAL_CSS}\n${INSTRUCTION_CASE_CSS}`;

if (content.views.map(view => view.id).join('|') !== STAGE_IDS.join('|')
  || content.sides.map(side => side.id).join('|') !== NEED_IDS.join('|')) {
  throw new Error('M015 views and learner needs must match the source-derived scene contract.');
}

function Lesson({ surfaceInput, host }) {
  const [stage, setStage] = useState(INITIAL_STAGE);
  const [need, setNeed] = useState(INITIAL_NEED);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm015-practice',
  });
  const figure = useMemo(() => caseScene({ stage, need, labels: content.accessibility.case }), [stage, need]);
  const selectedStage = stages.get(stage);
  const selectedNeed = needs.get(need);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const save = () => practice.save();

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(AnatomyFigure, {
        figure,
        label: content.accessibility.figure,
        appearanceCss,
        viewport: figure.viewport,
      }),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.stage),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.stage },
          ...content.views.map(view => h(Button, {
            key: view.id,
            variant: view.id === stage ? 'primary' : 'secondary',
            'aria-pressed': view.id === stage,
            disabled: practice.locked,
            onClick: () => update(() => setStage(view.id)),
          }, view.label))),
        paragraph(selectedStage.description),
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.need),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.need },
          ...content.sides.map(side => h(Button, {
            key: side.id,
            variant: side.id === need ? 'primary' : 'secondary',
            'aria-pressed': side.id === need,
            disabled: practice.locked,
            onClick: () => update(() => setNeed(side.id)),
          }, side.label))),
        paragraph(selectedNeed.description))),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m015-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.ownPursuit[key]),
          h(Textarea, {
            id,
            rows: 4,
            maxLength: 2000,
            value: practice.values[key],
            disabled: practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
