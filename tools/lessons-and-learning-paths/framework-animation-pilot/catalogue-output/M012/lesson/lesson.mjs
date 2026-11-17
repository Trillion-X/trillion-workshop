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
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { BOOK_MATERIAL_CSS } from '../../../../../screen-look/show/anatomy/book-materials.mjs';
import { DEFAULT_STEP, STEP_IDS, sceneForStep } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'revision'];
const validSteps = new Set(STEP_IDS);
const statement = content.statements.find(item => item.id === 'draft-sentence');
const appearanceCss = BOOK_MATERIAL_CSS;
if (content.initialStep !== DEFAULT_STEP || content.steps.map(step => step.id).join('|') !== STEP_IDS.join('|')) {
  throw new Error('M012 content practice steps must match the lesson model contract');
}
if (!statement?.text?.trim() || !statement?.feedback?.trim()) {
  throw new Error('M012 needs the authored checkable draft sentence and its bounded feedback');
}

function restoredStep(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    return { step: validSteps.has(saved.step) ? saved.step : content.initialStep };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [step, setStep] = useState(content.initialStep);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm012-practice',
    onRestore: record => {
      const saved = restoredStep(record.transfer);
      if (saved) setStep(saved.step);
    },
  });
  const selectedStep = content.steps.find(item => item.id === step) ?? content.steps[0];
  const figure = useMemo(() => sceneForStep(step, content.accessibility.figure), [step]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const save = () => practice.save({ transfer: JSON.stringify({ step }) });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(Container, { layout: 'responsive-split', gap: 'lg', alignItems: 'center' },
        h(Container, { flex: '1', width: 'full', alignItems: 'center', justifyContent: 'center' },
          h(AnatomyFigure, { figure, label: content.accessibility.figure, appearanceCss, viewport: figure.viewport })),
        ['observe', 'return'].includes(step)
          ? h(Container, { flex: '1', gap: 'sm', role: 'region', 'aria-label': content.labels.draftSentence },
              h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.draftSentence),
              h(Container, { border: 'quote' }, h(Text, { as: 'blockquote', variant: 'body' }, statement.text)),
              paragraph(statement.feedback))
          : null),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.step),
        h(Container, { layout: 'responsive-split', gap: 'sm', role: 'group', 'aria-label': content.accessibility.step },
          ...[content.steps.slice(0, 2), content.steps.slice(2)].map((row, rowIndex) => h(Container, {
            key: `step-row-${rowIndex}`,
            layout: 'horizontal', gap: 'sm',
          }, ...row.map(item => h(Button, {
            key: item.id,
            variant: item.id === step ? 'primary' : 'secondary',
            'aria-pressed': item.id === step,
            disabled: practice.locked,
            onClick: () => update(() => setStep(item.id)),
          }, item.label))))),
        paragraph(selectedStep.description))),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.labels.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m012-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.ownPursuit[key]),
          h(Textarea, {
            id, rows: 4, maxLength: 2000,
            value: practice.values[key], disabled: practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
