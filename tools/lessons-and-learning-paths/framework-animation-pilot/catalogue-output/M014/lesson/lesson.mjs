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
import { DEFAULT_SIDE, SIDE_IDS, sceneForSide } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'revision'];
const maxAttempts = 3;
const modes = new Map(content.sides.map(side => [side.id, side]));
if (content.initialSide !== DEFAULT_SIDE || content.sides.map(side => side.id).join('|') !== SIDE_IDS.join('|')) {
  throw new Error('M014 question demands must match the assessment instrument');
}

function restoredTransfer(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const side = SIDE_IDS.includes(saved.side) ? saved.side : DEFAULT_SIDE;
    const attempts = Array.isArray(saved.attempts) ? saved.attempts.filter(attempt =>
      attempt && SIDE_IDS.includes(attempt.side) && attempt.demand === attempt.side &&
      attempt.question === modes.get(attempt.side)?.focus &&
      typeof attempt.response === 'string' && typeof attempt.result === 'string' && typeof attempt.at === 'string' &&
      attempt.response.length <= 2000 && attempt.result.length <= 2000 &&
      Number.isFinite(Date.parse(attempt.at)) && attempt.concept === content.conceptValue &&
      attempt.who === content.labels.attemptAuthor).slice(0, maxAttempts) : [];
    const pair = Array.isArray(saved.pair) && saved.pair.length === 2 && saved.pair.every(Number.isInteger)
      ? saved.pair.filter(index => index >= 0 && index < attempts.length).slice(0, 2) : [];
    return { side, attempts, pair };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [side, setSide] = useState(content.initialSide);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(SIDE_IDS.map(id => [id, ''])));
  const [resultDrafts, setResultDrafts] = useState(() => Object.fromEntries(SIDE_IDS.map(id => [id, ''])));
  const [attempts, setAttempts] = useState([]);
  const [pair, setPair] = useState([]);
  const [showExample, setShowExample] = useState(false);
  const [attemptStatus, setAttemptStatus] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm014-practice',
    onRestore: record => {
      const saved = restoredTransfer(record.transfer);
      if (!saved) return;
      setSide(saved.side);
      setAttempts(saved.attempts);
      setPair(saved.pair);
    },
  });
  const activeSide = modes.get(side) ?? content.sides[0];
  const model = content.statements.find(item => item.id === activeSide.statement);
  const scene = useMemo(() => sceneForSide(side, content.accessibility), [side]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words) : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const transferFor = (nextAttempts, nextPair = pair) => JSON.stringify({ side, attempts: nextAttempts, pair: nextPair });
  const save = () => practice.save({ transfer: transferFor(attempts) });
  const recordAttempt = () => {
    const response = drafts[side]?.trim();
    const result = resultDrafts[side]?.trim();
    if (practice.locked) return;
    if (!response || !result) {
      setAttemptStatus(content.feedback.emptyResponse);
      return;
    }
    if (attempts.length >= maxAttempts) {
      setAttemptStatus(content.feedback.attemptLimit);
      return;
    }
    const attempt = {
      side,
      concept: content.conceptValue,
      question: activeSide.focus,
      demand: side,
      response,
      result,
      who: content.labels.attemptAuthor,
      at: new Date().toISOString(),
    };
    const nextAttempts = [...attempts, attempt];
    const nextPair = pair.length < 1 ? [attempts.length] : pair;
    if (transferFor(nextAttempts, nextPair).length > 2000) {
      setAttemptStatus(content.feedback.transferLength);
      return;
    }
    update(() => {
      setAttempts(nextAttempts);
      setDrafts(current => ({ ...current, [side]: '' }));
      setResultDrafts(current => ({ ...current, [side]: '' }));
      setPair(nextPair);
      setAttemptStatus('');
    });
  };
  const selectForComparison = index => update(() => setPair(current => {
    if (current.includes(index)) return current.filter(value => value !== index);
    return current.length < 2 ? [...current, index] : [current[1], index];
  }));
  const compared = pair.length === 2 ? pair.map(index => attempts[index]) : null;
  const sameDemand = compared && compared[0] && compared[1] &&
    compared[0].demand === compared[1].demand && compared[0].question === compared[1].question;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(Container, { layout: 'grid', gridColumns: 2, gap: 'md', role: 'group', 'aria-label': content.accessibility.figure },
        ...scene.actors.map(actor => h(Container, { key: actor.id, gap: 'sm' },
          h(AnatomyFigure, { figure: actor.figure, label: content.accessibility.figure, viewport: actor.viewport }),
          h(Text, { as: 'h3', variant: 'heading-md' }, actor.label)))),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.side),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.side },
          ...content.sides.map(item => h(Button, {
            key: item.id,
            variant: item.id === side ? 'primary' : 'secondary',
            'aria-pressed': item.id === side,
            disabled: practice.locked,
            onClick: () => update(() => { setSide(item.id); setShowExample(false); }),
          }, item.label))),
        paragraph(activeSide.description))),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.statements },
      h(Text, { as: 'h2', variant: 'heading-lg' }, activeSide.label),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm014-attempt-response' }, activeSide.focus),
        h(Textarea, {
          id: 'm014-attempt-response', rows: 4, maxLength: 2000,
          value: drafts[side], disabled: practice.loading || practice.locked,
          onChange: event => update(() => setDrafts(current => ({ ...current, [side]: event.target.value }))),
        }),
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm014-attempt-result' }, content.labels.result),
        h(Textarea, {
          id: 'm014-attempt-result', rows: 3, maxLength: 2000,
          value: resultDrafts[side], disabled: practice.loading || practice.locked,
          onChange: event => update(() => setResultDrafts(current => ({ ...current, [side]: event.target.value }))),
        })),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
        h(Button, { variant: 'primary', disabled: practice.loading || practice.locked, onClick: recordAttempt }, content.labels.try),
        h(Button, { variant: 'secondary', 'aria-expanded': showExample, disabled: practice.locked,
          onClick: () => update(() => setShowExample(value => !value)) }, showExample ? content.labels.hideExample : content.labels.showExample)),
      attemptStatus ? paragraph(attemptStatus, { role: 'status', 'aria-live': 'polite' }) : null,
      showExample && model ? h(Container, { gap: 'xs', border: 'all', padding: 'md' },
        paragraph(model.text), paragraph(model.feedback, { role: 'status', 'aria-live': 'polite' })) : null),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.labels.attempts },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.comparison),
      attempts.length ? h(Container, { gap: 'sm' }, ...attempts.map((attempt, index) => {
        const attemptSide = modes.get(attempt.side);
        const compareLabel = `${content.choices[0].label} ${index + 1}`;
        return h(Container, { key: `${attempt.at}-${index}`, gap: 'xs', padding: 'md', border: 'all' },
          h(Text, { as: 'h3', variant: 'heading-md' }, `${content.labels.attempts} ${index + 1}: ${attemptSide.label}`),
          paragraph(`${content.labels.concept}: ${attempt.concept}`),
          paragraph(attempt.question),
          paragraph(attempt.response),
          paragraph(attempt.result),
          paragraph(`${content.labels.task}: ${modes.get(attempt.demand).label}`),
          paragraph(`${attempt.who} · ${new Date(attempt.at).toLocaleString()}`),
          h(Button, { variant: pair.includes(index) ? 'primary' : 'secondary', 'aria-pressed': pair.includes(index),
            disabled: practice.locked, onClick: () => selectForComparison(index) }, compareLabel));
      })) : paragraph(content.labels.emptyAttempts),
      pair.length === 2 && compared?.every(Boolean) ? paragraph(sameDemand ? content.feedback.sameDemand : content.feedback.differentDemand,
        { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m014-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.ownPursuit[key]),
          h(Textarea, { id, rows: 3, maxLength: 2000, value: practice.values[key], disabled: practice.locked,
            onChange: event => practice.setValue(key, event.target.value) }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
