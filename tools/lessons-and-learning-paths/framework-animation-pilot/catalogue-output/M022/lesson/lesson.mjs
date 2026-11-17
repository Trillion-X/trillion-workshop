import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { BOOK_MATERIAL_CSS } from '../../../../../screen-look/show/anatomy/book-materials.mjs';
import { INSTRUCTION_CASE_CSS } from '../../../../../screen-look/show/anatomy/instruction-case-materials.mjs';
import { INITIAL_CASE, SOURCE_CONDITIONS, caseScene } from './lesson-model.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['step', 'result', 'prediction', 'alternative', 'observation', 'revision'];
const appearanceCss = `${BOOK_MATERIAL_CSS}\n${INSTRUCTION_CASE_CSS}`;
const choice = id => content.choices.find(row => row.id === id)?.label ?? id;

function restoredCase(transfer) {
  try {
    const saved = typeof transfer === 'string' ? JSON.parse(transfer) : transfer;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const state = { ...INITIAL_CASE, sourceCondition: saved.sourceCondition ?? INITIAL_CASE.sourceCondition,
      candidateRoute: saved.candidateRoute ?? INITIAL_CASE.candidateRoute };
    if (!SOURCE_CONDITIONS.includes(state.sourceCondition)
      || typeof state.candidateRoute !== 'boolean') return null;
    return state;
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [caseState, setCaseState] = useState(INITIAL_CASE);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm022-practice',
    onRestore: record => {
      const saved = restoredCase(record.transfer);
      if (saved) setCaseState(saved);
    },
  });
  const figure = useMemo(() => caseScene(caseState), [caseState]);
  const paragraph = (words, props = {}) => typeof words === 'string' && words.trim()
    ? h(Text, { as: 'p', ...props }, words)
    : null;
  const updateCase = patch => {
    if (practice.locked || practice.loading) return;
    practice.markEdited();
    setCaseState(state => ({ ...state, ...patch }));
  };
  const save = () => practice.save({ transfer: JSON.stringify(caseState) });
  const status = caseState.sourceCondition === 'requires-repetition' && caseState.candidateRoute
    ? content.caseStatus.candidate
    : content.caseStatus[caseState.sourceCondition];
  const currentSourceCondition = SOURCE_CONDITIONS.find(value => value === caseState.sourceCondition);
  const disabled = practice.locked || practice.loading;

  const toggleGroup = (options, labels, groupLabel, selected) => h(Container, {
    gap: 'xs', role: 'group', 'aria-label': groupLabel,
  },
  ...options.map(value => h(Button, {
    key: value,
    variant: value === selected ? 'primary' : 'secondary',
    'aria-pressed': value === selected,
    disabled,
    onClick: () => updateCase({ sourceCondition: value, candidateRoute: false }),
  }, labels[value])));

  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),

    h(Container, { gap: 'sm', role: 'group', 'aria-label': content.steps[0].label },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.steps[0].label),
      paragraph(content.steps[0].description),
      ...content.actions.map(action => h(Text, {
        key: action.id,
        as: 'p',
        variant: 'body',
      }, action.title))),

    h(Container, { gap: 'sm' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.examples[0].title),
      paragraph(content.examples[0].description)),

    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.steps[1].label),
      paragraph(content.steps[1].description),
      toggleGroup(SOURCE_CONDITIONS, Object.fromEntries(SOURCE_CONDITIONS.map(id => [id, choice(id)])),
        content.accessibility.conditions, currentSourceCondition),
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.steps[2].label),
      paragraph(content.steps[2].description),
      h(AnatomyFigure, {
        figure,
        label: content.accessibility.figure,
        appearanceCss,
        viewport: figure.viewport,
      }),
      paragraph(status, { role: 'status', 'aria-live': 'polite' }),
      h(Container, { gap: 'xs', role: 'group', 'aria-label': content.accessibility.candidate },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.steps[3].label),
        paragraph(content.steps[3].description),
        h(Button, {
          variant: caseState.candidateRoute ? 'primary' : 'secondary',
          'aria-pressed': caseState.candidateRoute,
          disabled: disabled || caseState.sourceCondition !== 'requires-repetition',
          onClick: () => updateCase({ candidateRoute: !caseState.candidateRoute }),
        }, choice('candidate-route')))),

    h(Container, { gap: 'md', role: 'group', 'aria-label': content.accessibility.practice },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.practice.title),
      paragraph(content.practice.prompt),
      ...fields.map(key => {
        const id = `m022-practice-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 4,
            autoGrow: true,
            maxHeight: 288,
            maxLength: 2000,
            required: true,
            value: practice.values[key],
            disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
