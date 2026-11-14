import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RACKET_MATERIAL_CSS } from '../../../../parts/screen-look/show/anatomy/racket-materials.mjs';
import { CASE_IDS, INITIAL_CASE, INITIAL_VERDICT, evidenceScene, selectedVerdict } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['observation', 'prediction', 'alternative', 'comparison', 'revision', 'result'];
const cases = new Map(content.options.learnerCases.map(item => [item.id, item]));

if (content.options.learnerCases.map(item => item.id).join('|') !== CASE_IDS.join('|')
  || content.choices.map(item => item.id).join('|') !== ['supported', 'rejected', 'unresolved'].join('|')) {
  throw new Error('M021 hypothetical evidence cases and verdicts must match their model contracts.');
}

function restoredState(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !CASE_IDS.includes(saved.caseId)) return null;
    return { caseId: saved.caseId, verdict: selectedVerdict(saved.verdict ?? null) };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [selectedCase, setSelectedCase] = useState(INITIAL_CASE);
  const [verdict, setVerdict] = useState(INITIAL_VERDICT);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm021-practice',
    onRestore: record => {
      const saved = restoredState(record.transfer);
      if (saved) {
        setSelectedCase(saved.caseId);
        setVerdict(saved.verdict);
      }
    },
  });
  const figure = useMemo(() => evidenceScene({ selectedCase, label: content.accessibility.figure }), [selectedCase]);
  const current = cases.get(selectedCase);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', variant: 'body', ...props }, words)
    : null;
  const update = action => {
    if (practice.locked) return;
    practice.markEdited();
    action();
  };
  const save = () => practice.save({ transfer: JSON.stringify({ caseId: selectedCase, verdict }) });
  const feedback = verdict ? content.feedback.verdicts[selectedCase]?.[verdict] : null;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.example),
      h(Container, {
        layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
        'aria-label': content.accessibility.caseChoices,
      }, ...content.options.learnerCases.map(item => h(Button, {
        key: item.id,
        variant: selectedCase === item.id ? 'primary' : 'secondary',
        'aria-pressed': selectedCase === item.id,
        disabled: practice.locked,
        onClick: () => update(() => { setSelectedCase(item.id); setVerdict(null); }),
      }, item.label))),
      h(AnatomyFigure, {
        figure,
        label: content.accessibility.figure,
        appearanceCss: RACKET_MATERIAL_CSS,
        viewport: figure.viewport,
      }),
      h(Container, { gap: 'xs' },
      h(Text, { as: 'h3', variant: 'heading-md' }, content.options.predictions[selectedCase]),
        paragraph(current.description)),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.verdict),
        h(Container, {
          layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
          'aria-label': content.accessibility.verdicts,
        }, ...content.choices.map(item => h(Button, {
          key: item.id,
          variant: verdict === item.id ? 'primary' : 'secondary',
          'aria-pressed': verdict === item.id,
          disabled: practice.locked,
          onClick: () => update(() => setVerdict(item.id)),
        }, item.label)),
        feedback ? paragraph(feedback, {
          role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
        }) : null))),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.sourceSteps),
      h('ol', null, ...content.steps.map(step => h('li', { key: step.id }, step.label))),
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.ownPursuit),
      paragraph(content.ownPursuit.prompt),
      ...fields.map(key => {
        const id = `m021-practice-${key}`;
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
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
