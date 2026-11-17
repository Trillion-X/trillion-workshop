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
import { DECISIONS_BY_MODE, MODES, coinScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['observation'];
const modeIds = new Set(MODES);
const validDecisions = new Map(Object.entries(DECISIONS_BY_MODE).map(([mode, decisions]) => [mode, new Set(decisions)]));
const modes = new Map(content.modes.map(mode => [mode.id, mode]));

function restorePractice(transfer) {
  try {
    const saved = JSON.parse(transfer);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const mode = modeIds.has(saved.mode) ? saved.mode : content.initialMode;
    const allowed = validDecisions.get(mode);
    const decision = allowed?.has(saved.decision) ? saved.decision : content.initialDecision;
    return { mode, decision };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [mode, setMode] = useState(content.initialMode);
  const [decision, setDecision] = useState(content.initialDecision);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm006-practice',
    onRestore: record => {
      const saved = restorePractice(record.transfer);
      if (saved) {
        setMode(saved.mode);
        setDecision(saved.decision);
      }
    },
  });
  const figureLabel = content.accessibility.figure[mode][decision];
  const figure = useMemo(() => coinScene({ mode, decision, figureLabel }), [mode, decision, figureLabel]);
  const selectedMode = modes.get(mode);
  const actions = DECISIONS_BY_MODE[mode].map(id => ({ id, ...content.decisions[id] }));
  const update = action => { if (!practice.locked) { practice.markEdited(); action(); } };
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const save = () => practice.save({ transfer: JSON.stringify({ mode, decision }) });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(AnatomyFigure, { figure, label: figureLabel, viewport: figure.viewport }),
      h(Container, { gap: 'lg' },
        h(Container, { gap: 'md' },
          h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.context),
          h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.mode },
            ...content.modes.map(item => h(Button, {
              key: item.id,
              variant: item.id === mode ? 'primary' : 'secondary',
              'aria-pressed': item.id === mode,
              disabled: practice.locked,
              onClick: () => update(() => { setMode(item.id); setDecision(content.initialDecision); }),
            }, item.label))),
          paragraph(selectedMode.description)),
        h(Container, { gap: 'md' },
          h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.decision),
          h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.decision },
            ...actions.map(item => h(Button, {
              key: item.id,
              variant: item.id === decision ? 'primary' : 'secondary',
              'aria-pressed': item.id === decision,
              disabled: practice.locked,
              onClick: () => update(() => setDecision(item.id)),
            }, item.label))),
          paragraph(content.decisionPrompt)))),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.reflection },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.reflection),
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm006-observation' }, content.reflection.question),
      h(Textarea, { id: 'm006-observation', rows: 4, maxLength: 2000, value: practice.values.observation, 'aria-required': true,
        disabled: practice.locked, onChange: event => practice.setValue('observation', event.target.value) }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', size: 'lg', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
