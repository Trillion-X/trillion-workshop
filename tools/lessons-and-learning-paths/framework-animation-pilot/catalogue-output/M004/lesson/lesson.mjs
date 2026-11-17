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
import { MODES, activityScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'revision'];
const modeIds = new Set(MODES);
const choiceIds = new Set(content.choices.map(choice => choice.id));
const modes = new Map(content.modes.map(mode => [mode.id, mode]));

function restorePractice(transfer) {
  try {
    const saved = JSON.parse(transfer);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const mode = modeIds.has(saved.mode) ? saved.mode : MODES[0];
    const classifications = {};
    if (saved.classifications && typeof saved.classifications === 'object' && !Array.isArray(saved.classifications)) {
      for (const statement of content.statements) {
        if (choiceIds.has(saved.classifications[statement.id])) classifications[statement.id] = saved.classifications[statement.id];
      }
    }
    return { mode, classifications };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [mode, setMode] = useState(MODES[0]);
  const [classifications, setClassifications] = useState({});
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm004-practice',
    onRestore: record => {
      const saved = restorePractice(record.transfer);
      if (saved) {
        setMode(saved.mode);
        setClassifications(saved.classifications);
      }
    },
  });
  const figureLabel = content.accessibility.figure[mode];
  const figure = useMemo(() => activityScene({ mode, figureLabel }), [mode, figureLabel]);
  const selectedMode = modes.get(mode);
  const update = action => { if (!practice.locked) { practice.markEdited(); action(); } };
  const paragraph = (words, props = {}) => words ? h(Text, { as: 'p', ...props }, words) : null;
  const save = () => practice.save({ transfer: JSON.stringify({ mode, classifications }) });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(AnatomyFigure, { figure, label: figureLabel, viewport: figure.viewport }),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.mode),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.mode },
          ...content.modes.map(item => h(Button, {
            key: item.id, variant: item.id === mode ? 'primary' : 'secondary',
            'aria-pressed': item.id === mode, disabled: practice.locked,
            onClick: () => update(() => setMode(item.id)),
          }, item.label))),
        paragraph(selectedMode.description))),
    content.examples.summary ? h(Container, { gap: 'sm' }, paragraph(content.examples.summary)) : null,
    h(Container, { gap: 'lg', role: 'group', 'aria-label': content.accessibility.statements },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.statements),
      ...content.statements.filter(statement => selectedMode.availableStatements.includes(statement.id)).map(statement => {
        const selected = classifications[statement.id];
        return h(Container, { key: statement.id, gap: 'sm', padding: 'md', border: 'all' },
          paragraph(statement.text),
          h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': statement.text },
            ...content.choices.map(choice => h(Button, {
              key: choice.id, variant: choice.id === selected ? 'primary' : 'secondary',
              disabled: practice.locked, 'aria-pressed': choice.id === selected,
              onClick: () => update(() => setClassifications(current => ({ ...current, [statement.id]: choice.id }))),
            }, choice.label))),
          selected ? paragraph(statement.feedback, { role: 'status', 'aria-live': 'polite' }) : null);
      }),
      paragraph(content.feedback.openQuestion)),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => h(Container, { key, gap: 'xs' },
        h(Text, { as: 'label', htmlFor: `m004-${key}` }, content.ownPursuit[key]),
        h(Textarea, { id: `m004-${key}`, rows: 4, maxLength: 2000, value: practice.values[key], disabled: practice.locked,
          onChange: event => practice.setValue(key, event.target.value) }))),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
