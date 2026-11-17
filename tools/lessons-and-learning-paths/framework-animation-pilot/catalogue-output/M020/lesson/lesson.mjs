import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../../screen-look/show/anatomy/racket-materials.mjs';
import { candidateScene, CAUSE_IDS, INITIAL_CAUSE, STATUS_IDS, statusId } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'revision', 'step', 'result'];
const causes = new Map(content.causes.map(cause => [cause.id, cause]));
const statuses = new Map(content.evidenceStatuses.map(status => [status.id, status]));

if (content.causes.map(cause => cause.id).join('|') !== CAUSE_IDS.join('|')
  || content.evidenceStatuses.map(status => status.id).join('|') !== STATUS_IDS.join('|')) {
  throw new Error('M020 candidate conditions and evidence statuses must match their source-derived contracts.');
}

function Lesson({ surfaceInput, host }) {
  const [cause, setCause] = useState(INITIAL_CAUSE);
  const [presence, setPresence] = useState(() => Object.fromEntries(CAUSE_IDS.map(id => [id, 'unknown'])));
  const [relevance, setRelevance] = useState(() => Object.fromEntries(CAUSE_IDS.map(id => [id, 'unknown'])));
  const practice = useLessonPractice({ host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm020-practice' });
  const figure = useMemo(() => candidateScene({ cause, label: content.accessibility.figure }), [cause]);

  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const changeEvidence = (setState, condition, value) => update(() => setState(current => ({ ...current, [condition]: value })));
  const save = () => practice.save();

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { gap: 'lg' },
      h(AnatomyFigure, {
        figure,
        label: content.accessibility.figure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: figure.viewport,
      }),
      h(Container, { gap: 'md' },
        h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.candidates),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.accessibility.candidates },
          ...content.causes.map(item => h(Button, {
            key: item.id,
            variant: item.id === cause ? 'primary' : 'secondary',
            'aria-pressed': item.id === cause,
            disabled: practice.locked,
            onClick: () => update(() => setCause(item.id)),
          }, item.label))),
      paragraph(causes.get(cause).description))),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.evidence),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.examples[0].title),
        paragraph(content.examples[0].description),
        paragraph(content.exampleSummary)),
      ...content.causes.map(condition => h(Container, { key: condition.id, gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, condition.label),
        h(Text, { as: 'p', variant: 'body' }, content.labels.presence),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': `${condition.label}: ${content.labels.presence}` },
          ...content.evidenceStatuses.map(status => h(Button, {
            key: status.id,
            variant: presence[condition.id] === status.id ? 'primary' : 'secondary',
            'aria-pressed': presence[condition.id] === status.id,
            disabled: practice.locked,
            onClick: () => changeEvidence(setPresence, condition.id, statusId(status.id)),
          }, status.label))),
        h(Text, { as: 'p', variant: 'body' }, content.labels.relevance),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': `${condition.label}: ${content.labels.relevance}` },
          ...[
            { id: 'relevant', label: 'Relevant' },
            { id: 'not-relevant', label: 'Not shown to be relevant' },
            { id: 'unknown', label: 'Unknown' },
          ].map(option => h(Button, {
            key: option.id,
            variant: relevance[condition.id] === option.id ? 'primary' : 'secondary',
            'aria-pressed': relevance[condition.id] === option.id,
            disabled: practice.locked,
            onClick: () => changeEvidence(setRelevance, condition.id, option.id),
          }, option.label)))))),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m020-practice-${key}`;
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
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.sourceSteps),
      h('ol', null, ...content.steps.map((step, index) => h('li', { key: step.id }, step.label))),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
