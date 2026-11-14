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
import { AnatomyFigure, Button, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea, TuningSliderField, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/racket-materials.mjs';
import { CLAIMS, DURATIONS, FACETS, OBSERVATIONS, VIEWPOINTS, awarenessScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'revision'];
const DEFAULT_CLAIM = content.modes[0].availableStatements[0];
const validFacet = value => FACETS.includes(value);
const validClaim = value => CLAIMS.includes(value) && content.statements.some(statement => statement.id === value);

function restoredPractice(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const facet = validFacet(saved.facet) ? saved.facet : FACETS[0];
    const mode = content.modes.find(item => item.id === facet);
    const claim = validClaim(saved.claim) && mode.availableStatements.includes(saved.claim)
      ? saved.claim : mode.availableStatements[0];
    return {
      facet,
      claim,
      viewpoint: VIEWPOINTS.includes(saved.viewpoint) ? saved.viewpoint : 'player',
      selectedObservation: OBSERVATIONS.includes(saved.selectedObservation) ? saved.selectedObservation : null,
      duration: DURATIONS.includes(saved.duration) ? saved.duration : 'moment',
      progress: Number.isFinite(saved.progress) && saved.progress >= 0 && saved.progress <= 1 ? saved.progress : 0.5,
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [facet, setFacet] = useState(FACETS[0]);
  const [claim, setClaim] = useState(DEFAULT_CLAIM);
  const [viewpoint, setViewpoint] = useState('player');
  const [selectedObservation, setSelectedObservation] = useState(null);
  const [duration, setDuration] = useState('moment');
  const [progress, setProgress] = useState(0.5);
  const practiceState = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm009-practice',
    onRestore: record => {
      const restored = restoredPractice(record.transfer);
      if (!restored) return;
      setFacet(restored.facet);
      setClaim(restored.claim);
      setViewpoint(restored.viewpoint);
      setSelectedObservation(restored.selectedObservation);
      setDuration(restored.duration);
      setProgress(restored.progress);
    },
  });
  const mode = content.modes.find(item => item.id === facet) ?? content.modes[0];
  const statement = content.statements.find(item => item.id === claim) ?? content.statements[0];
  const selectedChoice = content.choices.find(item => item.id === selectedObservation);
  const figure = useMemo(() => awarenessScene({
    facet,
    viewpoint,
    selectedObservation: selectedObservation ?? 'unknown',
    duration,
    progress,
    claim,
  }), [facet, viewpoint, selectedObservation, duration, progress, claim]);
  const expectedObservation = figure.state.claimRelation.relation === 'supported' ? 'observed' : 'unknown';
  const caseFeedback = selectedChoice
    ? `${selectedObservation === expectedObservation ? content.feedback.correct : content.feedback.incorrect} ${statement.feedback}`
    : `${content.feedback.unresolved} ${statement.feedback}`;
  const update = action => {
    if (practiceState.locked) return;
    practiceState.markEdited();
    action();
  };
  const changeFacet = nextFacet => update(() => {
    setFacet(nextFacet);
    const nextMode = content.modes.find(item => item.id === nextFacet);
    if (nextMode && !nextMode.availableStatements.includes(claim)) setClaim(nextMode.availableStatements[0]);
  });
  const save = () => practiceState.save({ transfer: JSON.stringify({ facet, claim, viewpoint, selectedObservation, duration, progress }) });
  const paragraph = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const choices = (items, selected, label, onChoose) => h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': label,
  }, ...items.map(item => h(Button, {
    key: item.id,
    variant: selected === item.id ? 'primary' : 'secondary',
    'aria-pressed': selected === item.id,
    disabled: practiceState.locked,
    onClick: () => onChoose(item.id),
  }, item.label ?? item.text)));
  const selectChoice = (items, selected, label, onChoose) => h(Select, {
    value: selected,
    items: items.map(item => ({ value: item.id, label: item.label ?? item.text })),
    disabled: practiceState.locked,
    onValueChange: value => { if (typeof value === 'string') onChoose(value); },
  }, h(SelectTrigger, { 'aria-label': label }, h(SelectValue)),
  h(SelectPopup, { portalProps: { className: 'coss-ui' } }, ...items.map(item => h(SelectItem, { key: item.id, value: item.id }, item.label ?? item.text))));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl', 'data-source-course': surfaceInput.course_id ?? '' },
    h(Container, { gap: 'sm' }, h(Text, { as: 'h1', variant: 'heading-xl' }, content.title), paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(AnatomyFigure, { figure, label: content.accessibility.figure, appearanceCss: RACKET_MATERIAL_CSS, viewport: [-80, -100, 2080, 1320] }),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.facet),
        choices(content.modes, facet, content.accessibility.facet, changeFacet),
        paragraph(mode.description),
        paragraph(mode.focus),
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.viewpoint),
        choices(content.viewpoints, viewpoint, content.accessibility.viewpoint, next => update(() => setViewpoint(next))),
        paragraph(content.viewpoints.find(item => item.id === viewpoint).description),
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.claim),
        selectChoice(content.statements.filter(item => mode.availableStatements.includes(item.id)), claim, content.labels.claim, next => update(() => setClaim(next))),
        paragraph(statement.text),
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.selectedObservation),
        choices(content.choices, selectedObservation, content.accessibility.observation, next => update(() => setSelectedObservation(next))),
        paragraph(caseFeedback, { role: 'status', 'aria-live': 'polite' }),
        facet === 'time' ? h(Container, { gap: 'sm' },
          h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.duration),
          selectChoice(content.durations, duration, content.labels.duration, next => update(() => setDuration(next))),
          paragraph(content.durations.find(item => item.id === duration).description)) : null,
        h(Container, { gap: 'xs' },
          h(TuningSliderField, {
            label: content.labels.replayProgress,
            min: 0,
            max: 100,
            step: 1,
            unit: '%',
            value: Math.round(progress * 100),
            disabled: practiceState.locked,
            onChange: value => update(() => setProgress(value / 100)),
          })))),
    h(Container, { gap: 'md', role: 'group', 'aria-label': content.labels.ownPursuit },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit), paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m009-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.ownPursuit[key]),
          h(Textarea, {
            id, rows: 4, maxLength: 2000,
            value: practiceState.values[key], disabled: practiceState.locked,
            onChange: event => practiceState.setValue(key, event.target.value),
          }));
      }),
      practiceState.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practiceState.loading || practiceState.saving, onClick: save },
        practiceState.saving ? content.labels.busy : content.labels.save),
      practiceState.status ? paragraph(practiceState.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
