import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { CONDITION_IDS, CONDITION_SCENES, CONDITION_VIEWPORT } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const practiceFields = ['step', 'prediction', 'observation', 'revision', 'transfer'];
const maxRecordedConditions = 4;
const interventions = new Map(content.interventions.map(item => [item.id, item]));

function restoreTransfer(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const recorded = Array.isArray(value.recorded) ? value.recorded.filter(item =>
      item && CONDITION_IDS.includes(item.condition)
      && typeof item.observation === 'string' && item.observation.length <= 300
      && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)))
      .filter((item, index, all) => all.findIndex(other => other.condition === item.condition) === index)
      .slice(0, maxRecordedConditions) : [];
    const pair = Array.isArray(value.pair) && value.pair.length === 2
      && value.pair.every(id => recorded.some(item => item.condition === id))
      && value.pair[0] !== value.pair[1] ? [...value.pair] : [];
    return { recorded, pair };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [conditionId, setConditionId] = useState('base');
  const [observationDraft, setObservationDraft] = useState('');
  const [recorded, setRecorded] = useState([]);
  const [pair, setPair] = useState([]);
  const [attemptStatus, setAttemptStatus] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields: practiceFields, messages: content.feedback,
    requestPrefix: 'm018-nxn-practice',
    onRestore: record => {
      const saved = restoreTransfer(record.comparison ?? record.transfer);
      if (!saved) return;
      setRecorded(saved.recorded);
      setPair(saved.pair);
    },
  });
  const conditions = useMemo(() => CONDITION_SCENES, []);
  const scene = conditions[conditionId];
  const geometryRelation = useMemo(() => {
    const gap = id => conditions[id].state.renderedContactGap;
    return gap('timing') > gap('base')
      && gap('position') < gap('base')
      && gap('combined') < Math.min(gap('timing'), gap('position'))
      ? content.sceneLabels.relationship
      : 'The feed and camera stay fixed. Compare the racket and ball in the separate and combined scenes, then say what the drawing supports.';
  }, [conditions]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words) : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const transferFor = (nextRecorded = recorded, nextPair = pair) => JSON.stringify({
    recorded: nextRecorded, pair: nextPair,
  });
  const save = () => practice.save({ comparison: transferFor() });
  const addCondition = () => {
    if (practice.locked) return;
    const observation = observationDraft.trim();
    if (!observation) {
      setAttemptStatus(content.feedback.empty);
      return;
    }
    if (recorded.some(item => item.condition === conditionId)) {
      setAttemptStatus(content.feedback.duplicate);
      return;
    }
    if (recorded.length >= maxRecordedConditions) {
      setAttemptStatus(content.feedback.limit);
      return;
    }
    const next = [...recorded, { condition: conditionId, observation, at: new Date().toISOString() }];
    const nextPair = pair.length < 2 ? [...pair, conditionId] : pair;
    if (transferFor(next, nextPair).length > 1900) {
      setAttemptStatus(content.feedback.length);
      return;
    }
    update(() => {
      setRecorded(next);
      setPair(nextPair);
      setObservationDraft('');
      setAttemptStatus('');
    });
  };
  const choosePair = id => update(() => setPair(current => {
    if (current.includes(id)) return current.filter(value => value !== id);
    return current.length < 2 ? [...current, id] : [current[1], id];
  }));
  const compared = pair.length === 2 ? pair.filter(id => recorded.some(item => item.condition === id)) : [];
  const comparison = compared.length === 2 ? {
    preparationDiffers: conditions[compared[0]].state.actualRacketAngle
      !== conditions[compared[1]].state.actualRacketAngle,
    positionDiffers: JSON.stringify(conditions[compared[0]].state.actualNearPosition)
      !== JSON.stringify(conditions[compared[1]].state.actualNearPosition),
  } : null;
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening),
      paragraph(content.explanation),
      paragraph(content.scope)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.selectCondition),
      h(Container, { layout: 'grid', gridColumns: 2, gap: 'sm', role: 'group', 'aria-label': content.labels.selectCondition },
        ...content.interventions.map(item => h(Button, {
          key: item.id,
          variant: item.id === conditionId ? 'primary' : 'secondary',
          'aria-pressed': item.id === conditionId,
          disabled: practice.locked,
          onClick: () => update(() => { setConditionId(item.id); setAttemptStatus(''); }),
        }, item.label))),
      h(Container, { gap: 'sm', border: 'all', padding: 'md' },
        h(AnatomyFigure, { figure: scene.figure, label: content.sceneLabels.figure, viewport: CONDITION_VIEWPORT }),
        paragraph(content.sceneLabels.feed),
        paragraph(geometryRelation)),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm018-condition-observation' },
          `What do you notice in “${scene.condition.label}”?`),
        h(Textarea, { id: 'm018-condition-observation', rows: 3, maxLength: 300,
          value: observationDraft, disabled: practice.loading || practice.locked,
          onChange: event => update(() => setObservationDraft(event.target.value)) }),
        h(Button, { variant: 'primary', disabled: practice.loading || practice.locked, onClick: addCondition }, content.labels.try),
        attemptStatus ? paragraph(attemptStatus, { role: 'status', 'aria-live': 'polite' }) : null)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.teaching.partsHeading),
      paragraph(content.teaching.partsText),
      paragraph(content.teaching.question),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': content.labels.attempts },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.attempts),
        recorded.length ? h(Container, { gap: 'sm' }, ...recorded.map(item => {
          const condition = interventions.get(item.condition);
          return h(Container, { key: item.condition, gap: 'xs', padding: 'md', border: 'all' },
            h(Text, { as: 'h4', variant: 'heading-md' }, `${content.labels.recorded}: ${condition.label}`),
            paragraph(item.observation),
            h(Button, { variant: pair.includes(item.condition) ? 'primary' : 'secondary',
              'aria-pressed': pair.includes(item.condition), disabled: practice.locked,
              onClick: () => choosePair(item.condition) }, `Compare ${condition.label}`));
        })) : paragraph(content.labels.empty),
        comparison ? h(Container, { gap: 'xs', border: 'all', padding: 'md' },
          paragraph('The incoming feed and camera stay fixed. Across the two scenes, racket preparation '
            + `${comparison.preparationDiffers ? 'changes' : 'stays the same'} and court position `
            + `${comparison.positionDiffers ? 'changes' : 'stays the same'}.`)) : null),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.teaching.returnHeading),
        paragraph(content.teaching.returnText))),

    h(Container, { gap: 'md', role: 'group', 'aria-label': content.practice.heading },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.practice.heading),
      paragraph(content.practice.prompt),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm018-own-task' }, content.labels.ownTask),
        h(Textarea, { id: 'm018-own-task', rows: 2, maxLength: 2000, value: practice.values.step, disabled: practice.locked,
          onChange: event => practice.setValue('step', event.target.value) })),
      ...practiceFields.map(key => {
        if (key === 'step') return null;
        const id = `m018-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, { id, rows: 3, maxLength: 2000, value: practice.values[key], disabled: practice.locked,
            onChange: event => practice.setValue(key, event.target.value) }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
        h(Button, { variant: 'primary', disabled: practice.loading || practice.locked, onClick: save }, content.labels.save),
        practice.locked ? h(Button, { variant: 'secondary', disabled: practice.saving,
          onClick: () => practice.save({ transfer: transferFor() }) }, content.labels.retry) : null),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
