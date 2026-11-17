import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'revision', 'step', 'result'];
const choices = new Map(content.choices.map(item => [item.id, item]));
const scenarios = new Map(content.scenarios.map(item => [item.id, item]));
const skillChallengeMap = content.ownPursuit.skillChallengeMap;
const mapActionById = new Map(skillChallengeMap.nextActions.map(item => [item.id, item]));
const mapCellIds = new Set(skillChallengeMap.skillLevels.flatMap(skill =>
  skillChallengeMap.challengeLevels.map(challenge => `${skill.id}:${challenge.id}`)));
mapCellIds.add('not-enough-evidence');

if (!content.choices.length || !content.scenarios.length
  || !content.choices.some(item => item.id === 'pace')
  || !content.choices.some(item => item.id === 'vocabulary')
  || skillChallengeMap.skillLevels.length !== 3 || skillChallengeMap.challengeLevels.length !== 3
  || skillChallengeMap.nextActions.length !== 4) {
  throw new Error('M029 needs a source-derived demand adjustment and a useful-feedback branch.');
}

function Lesson({ surfaceInput, host }) {
  const [adjustmentId, setAdjustmentId] = useState('pace');
  const [answerId, setAnswerId] = useState(null);
  const [nextDemandId, setNextDemandId] = useState('steady');
  const [nextAnswerId, setNextAnswerId] = useState(null);
  const [mapCellId, setMapCellId] = useState(null);
  const [mapActionId, setMapActionId] = useState(null);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm029-practice',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.transfer);
        if (mapCellIds.has(saved.mapCellId)) setMapCellId(saved.mapCellId);
        if (mapActionById.has(saved.mapActionId)) setMapActionId(saved.mapActionId);
      } catch { /* Earlier practice records did not include the map state. */ }
    },
  });
  const choice = choices.get(adjustmentId);
  const scenario = scenarios.get(nextDemandId);
  const statements = content.statements.filter(item => item.id.startsWith(`${adjustmentId}-`));
  const selectedStatement = content.statements.find(item => item.id === answerId);
  const transferStatements = content.statements.filter(item => item.id.startsWith('transfer-'));
  const selectedTransferStatement = content.statements.find(item => item.id === nextAnswerId);
  const selectedMapAction = mapActionById.get(mapActionId);
  const selectedCellParts = typeof mapCellId === 'string' && mapCellId !== 'not-enough-evidence' ? mapCellId.split(':') : [];
  const selectedSkill = skillChallengeMap.skillLevels.find(item => item.id === selectedCellParts[0]);
  const selectedChallenge = skillChallengeMap.challengeLevels.find(item => item.id === selectedCellParts[1]);
  const mapRelation = selectedChallenge?.id === 'below' ? skillChallengeMap.lowerRelation
    : selectedChallenge?.id === 'near' ? skillChallengeMap.nearRelation
      : selectedChallenge ? skillChallengeMap.higherRelation : null;
  const mapFeedback = mapCellId === 'not-enough-evidence'
    ? skillChallengeMap.noEstimateFeedback
    : selectedSkill && mapRelation
      ? `${skillChallengeMap.estimatedPrefix} ${mapRelation}. Your skill estimate: ${selectedSkill.label.toLowerCase()}. ${skillChallengeMap.followUp}`
      : null;

  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const chooseAdjustment = id => update(() => {
    setAdjustmentId(id);
    setAnswerId(null);
  });
  const chooseNextDemand = id => update(() => {
    setNextDemandId(id);
    setNextAnswerId(null);
  });
  const chooseAnswer = id => update(() => setAnswerId(id));
  const chooseNextAnswer = id => update(() => setNextAnswerId(id));
  const chooseMapCell = id => update(() => setMapCellId(id));
  const chooseMapAction = id => update(() => setMapActionId(id));
  const save = () => {
    setSaveAttempted(true);
    if (!mapCellId || !mapActionId) return;
    return practice.save({ transfer: JSON.stringify({ mapCellId, mapActionId }) });
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.case),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.target),
      paragraph(content.caseStatus.target),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.task),
      paragraph(content.caseStatus.task),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.report),
      paragraph(content.caseStatus.report)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.adjustment),
      h(Container, {
        layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
        'aria-label': content.accessibility.adjustment,
      }, ...content.choices.map(item => h(Button, {
        key: item.id,
        variant: item.id === adjustmentId ? 'primary' : 'secondary',
        'aria-pressed': item.id === adjustmentId,
        disabled: practice.locked,
        onClick: () => chooseAdjustment(item.id),
      }, item.label))),
      paragraph(choice.description),
      adjustmentId === 'vocabulary' ? h(Container, { gap: 'xs' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.wordGuide),
        paragraph(content.caseStatus.wordGuide)) : null,
      h(Text, { as: 'h3', variant: 'heading-md' }, adjustmentId === 'vocabulary'
        ? content.labels.meaningQuestion : content.labels.question),
      h(Container, {
        layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
        'aria-label': `${content.accessibility.evidence} ${adjustmentId === 'vocabulary'
          ? content.labels.meaningQuestion : content.labels.question}`,
      }, ...statements.map(statement => h(Button, {
        key: statement.id,
        variant: statement.id === answerId ? 'primary' : 'secondary',
        'aria-pressed': statement.id === answerId,
        disabled: practice.locked,
        onClick: () => chooseAnswer(statement.id),
      }, statement.text))),
      selectedStatement ? paragraph(selectedStatement.feedback,
        { role: 'status', 'aria-live': 'polite' },
      ) : null),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.next),
      h(Container, {
        layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
        'aria-label': content.accessibility.next,
      }, ...content.scenarios.map(item => h(Button, {
        key: item.id,
        variant: item.id === nextDemandId ? 'primary' : 'secondary',
        'aria-pressed': item.id === nextDemandId,
        disabled: practice.locked,
        onClick: () => chooseNextDemand(item.id),
      }, item.label))),
      paragraph(scenario.description),
      nextDemandId === 'transfer' ? h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.task),
        paragraph(content.caseStatus.transferTask),
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.transferQuestion),
        h(Container, {
          layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
          'aria-label': 'Choose what the new instruction establishes',
        }, ...transferStatements.map(statement => h(Button, {
          key: statement.id,
          variant: nextAnswerId === statement.id ? 'primary' : 'secondary',
          'aria-pressed': nextAnswerId === statement.id,
          disabled: practice.locked,
          onClick: () => chooseNextAnswer(statement.id),
        }, statement.text))),
        selectedTransferStatement ? paragraph(selectedTransferStatement.feedback,
        { role: 'status', 'aria-live': 'polite' }) : null) : null),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m029-practice-${key}`;
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
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, skillChallengeMap.title),
        paragraph(skillChallengeMap.prompt),
        h(Text, { as: 'h3', variant: 'heading-md' }, skillChallengeMap.challengeAxis),
        h(Container, { layout: 'grid', gridColumns: 3, gap: 'sm', role: 'group', 'aria-label': skillChallengeMap.challengeAxis },
          ...skillChallengeMap.challengeLevels.map(item => h(Text, { key: item.id, variant: 'body-xs' }, item.short))),
        h(Container, { gap: 'md' }, ...skillChallengeMap.skillLevels.map(skill => h(Container, { key: skill.id, gap: 'xs' },
          h(Text, { as: 'h3', variant: 'heading-md' }, skill.label),
          h(Container, { layout: 'grid', gridColumns: 3, gap: 'sm', role: 'group', 'aria-label': `${skillChallengeMap.skillAxis}: ${skill.label}` },
            ...skillChallengeMap.challengeLevels.map(challenge => {
              const id = `${skill.id}:${challenge.id}`;
              return h(Button, {
                key: id,
                variant: mapCellId === id ? 'primary' : 'secondary',
                'aria-pressed': mapCellId === id,
                'aria-label': `${skillChallengeMap.selectPrompt}: ${skill.label}; ${challenge.label}`,
                disabled: practice.locked || practice.loading,
                className: 'w-full',
                onClick: () => chooseMapCell(id),
              }, challenge.short);
            }))
        ))),
        h(Button, {
          variant: mapCellId === 'not-enough-evidence' ? 'primary' : 'secondary',
          'aria-pressed': mapCellId === 'not-enough-evidence',
          disabled: practice.locked || practice.loading,
          onClick: () => chooseMapCell('not-enough-evidence'),
        }, skillChallengeMap.noEstimate),
        mapFeedback ? paragraph(mapFeedback, { role: 'status', 'aria-live': 'polite' }) : null,
        h(Text, { as: 'h3', variant: 'heading-md' }, skillChallengeMap.actionTitle),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': skillChallengeMap.actionLabel },
          ...skillChallengeMap.nextActions.map(item => h(Button, {
            key: item.id,
            variant: mapActionId === item.id ? 'primary' : 'secondary',
            'aria-pressed': mapActionId === item.id,
            disabled: practice.locked || practice.loading,
            onClick: () => chooseMapAction(item.id),
          }, item.label))),
        selectedMapAction ? paragraph(selectedMapAction.description, { role: 'status', 'aria-live': 'polite' }) : null,
        saveAttempted && (!mapCellId || !mapActionId)
          ? paragraph(skillChallengeMap.saveMissing, { role: 'status', 'aria-live': 'polite' }) : null),
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.steps),
      h('ol', null, ...content.steps.map(step => h('li', { key: step.id }, step.label))),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null,
        disabled: practice.loading || practice.saving || (practice.locked
          && ![content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status)),
        onClick: save,
      },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
