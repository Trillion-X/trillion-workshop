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
import { DEFAULT_MODE, MODE_IDS, sceneForMode } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'revision'];
const validModes = new Set(MODE_IDS);
const validEvidence = new Set(['message', 'assumption']);
if (content.initialMode !== DEFAULT_MODE || content.modes.map(mode => mode.id).join('|') !== MODE_IDS.join('|')) {
  throw new Error('M013 content observation modes must match the lesson model contract');
}

function restoredInteraction(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    return {
      mode: validModes.has(saved.mode) ? saved.mode : content.initialMode,
      evidence: validEvidence.has(saved.evidence) ? saved.evidence : 'message',
      replyShown: saved.replyShown === true,
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [mode, setMode] = useState(content.initialMode);
  const [evidence, setEvidence] = useState('message');
  const [replyShown, setReplyShown] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm013-practice',
    onRestore: record => {
      const saved = restoredInteraction(record.transfer);
      if (saved) {
        setMode(saved.mode);
        setEvidence(saved.evidence);
        setReplyShown(saved.replyShown);
      }
    },
  });
  const selectedMode = content.modes.find(item => item.id === mode) ?? content.modes[0];
  const figure = useMemo(() => sceneForMode(mode, content.accessibility.figure), [mode]);
  const example = content.example;
  const displayedEvidence = evidence === 'message'
    ? { words: example.message }
    : { words: example.possibleAssumption };
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const save = () => practice.save({ transfer: JSON.stringify({ mode, evidence, replyShown }) });

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { layout: 'responsive-split', gap: 'lg', alignItems: 'start' },
      h(Container, { gap: 'md', flex: '1', role: 'group', 'aria-label': content.accessibility.example },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.example),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.inspectExample },
          h(Button, {
            variant: evidence === 'message' ? 'primary' : 'secondary',
            'aria-pressed': evidence === 'message',
            disabled: practice.locked,
            onClick: () => update(() => { setEvidence('message'); setReplyShown(false); }),
          }, example.messageLabel),
          h(Button, {
            variant: evidence === 'assumption' ? 'primary' : 'secondary',
            'aria-pressed': evidence === 'assumption',
            disabled: practice.locked,
            onClick: () => update(() => { setEvidence('assumption'); setReplyShown(false); }),
          }, example.assumptionLabel)),
        paragraph(displayedEvidence.words, { 'aria-live': 'polite' }),
        h(Button, {
          variant: replyShown ? 'secondary' : 'primary',
          'aria-expanded': replyShown,
          'aria-controls': 'm013-example-reply',
          disabled: practice.locked,
          onClick: () => update(() => setReplyShown(value => !value)),
        }, replyShown ? content.labels.hideReply : content.labels.showReply),
        h(Container, { id: 'm013-example-reply', hidden: !replyShown, gap: 'xs', role: 'region', 'aria-label': example.replyLabel, 'aria-live': 'polite' },
          h(Text, { as: 'h3', variant: 'heading' }, example.replyLabel),
          paragraph(example.reply))),
      h(Container, { flex: '1', width: 'full', maxWidth: 'md', alignItems: 'center', justifyContent: 'center' },
        h(AnatomyFigure, { figure, label: content.accessibility.figure, viewport: figure.viewport, className: 'anatomy-figure--contained' }))),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.modes),
      paragraph(content.modeNote),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.modes },
        ...content.modes.map(item => h(Button, {
          key: item.id,
          variant: item.id === mode ? 'primary' : 'secondary',
          'aria-pressed': item.id === mode,
          disabled: practice.locked,
          onClick: () => update(() => setMode(item.id)),
        }, item.label))),
      paragraph(selectedMode.description)),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m013-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.ownPursuit[key]),
          h(Textarea, {
            id, rows: 4, maxLength: 2000,
            value: practice.values[key], disabled: practice.locked,
            'aria-required': true,
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
