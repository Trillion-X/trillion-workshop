import React, { useState } from 'react';
import { Button, Container, DisclosureSection, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { INITIAL_COMPARISON, comparisonSummary, transferState } from './lesson-model.mjs';
import source from './source-actions.json' with { type: 'json' };
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const optionalFields = fields.filter(key => key !== 'step');
const identityControls = [
  { id: true, label: content.labels.keepLabel },
  { id: false, label: content.labels.omitLabel },
];
const sourceQuote = source.currentCourseInput.body.split('\n')
  .find(line => line.startsWith('3. Ground it in specific actions and compare with what others have actually observed.'))
  ?.replace(/^\d+\.\s*/u, '');
if (!sourceQuote) throw new Error('The current M074 source action quote is missing.');
const responseControls = [
  { id: 'revise', label: content.labels.revise },
  { id: 'act', label: content.labels.act },
];

function Lesson({ surfaceInput, host }) {
  const [comparison, setComparison] = useState({ ...INITIAL_COMPARISON });
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [optionalAnswers, setOptionalAnswers] = useState(() => Object.fromEntries(optionalFields.map(key => [key, ''])));
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.messages,
    requestPrefix: 'm074-value-identity-integration',
    onRestore: record => {
      setOptionalAnswers(Object.fromEntries(optionalFields.map(key => [
        key, typeof record[key] === 'string' ? record[key] : '',
      ])));
      try {
        const saved = JSON.parse(record.transfer ?? '{}');
        if (typeof saved.identityLabelUsed === 'boolean' && ['revise', 'act'].includes(saved.response)) {
          setComparison({ useIdentity: saved.identityLabelUsed, response: saved.response });
        }
      } catch { /* Keep the visible example editable if an earlier reflection has no comparison state. */ }
    },
  });
  const answerFor = key => key === 'step' ? practice.values.step : optionalAnswers[key];
  const summary = comparisonSummary(content, comparison);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const group = (key, label, choices) => h(Container, { gap: 'sm' },
    h(Text, { as: 'h3', variant: 'heading-md' }, label),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': label },
      ...choices.map(choice => h(Button, {
        key: String(choice.id),
        variant: comparison[key] === choice.id ? 'primary' : 'secondary',
        'aria-pressed': comparison[key] === choice.id,
        disabled: practice.loading || practice.locked,
        onClick: () => {
          practice.markEdited();
          setComparison(current => ({ ...current, [key]: choice.id }));
        },
      }, choice.label))));
  const save = () => {
    setAttemptedSave(true);
    const tooLong = fields.some(key => answerFor(key).length > content.labels.fieldLimit);
    const missing = !practice.values.step.trim();
    if (tooLong || missing) return false;
    return practice.save({
      ...Object.fromEntries(optionalFields.map(key => [key, optionalAnswers[key]])),
      transfer: JSON.stringify(transferState(comparison)),
    });
  };
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { border: 'all', padding: 'lg', gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.example),
      paragraph(content.labels.exampleIntro),
      group('useIdentity', content.labels.identityPrompt, identityControls),
      h(Container, { border: 'all', padding: 'md', gap: 'sm', 'aria-label': 'Observed actions and intended value' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.value),
        paragraph(content.labels.workedValue),
        summary.description ? h(Container, { gap: 'xs' },
          h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.identity),
          paragraph(summary.description)) : paragraph('No identity label is needed to compare the actions.'),
        h(Container, { gap: 'xs' },
          h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.support),
          paragraph(summary.supportingAction)),
        h(Container, { gap: 'xs' },
          h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.challenge),
          paragraph(summary.challengingAction)),
        paragraph(content.labels.evidenceNote)),
      group('response', content.labels.nextStep, responseControls),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.interpretation),
        paragraph(summary.message, { id: 'm074-comparison-feedback', role: 'status', 'aria-live': 'polite' }),
        paragraph(summary.resolution))),
    h(DisclosureSection, { title: content.labels.source, collapsible: true, defaultOpen: false, divider: false, headingLevel: 2 },
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        paragraph(`“${sourceQuote}”`), paragraph(content.labels.sourceLocator))),
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.practice),
      paragraph(content.labels.practiceIntro)),
    h(Container, { gap: 'md' },
      ...fields.map(key => {
        const id = `m074-practice-${key}`;
        const errorId = `${id}-error`;
        const value = answerFor(key);
        const missing = key === 'step' && attemptedSave && !value.trim();
        const tooLong = attemptedSave && value.length > content.labels.fieldLimit;
        const error = missing ? content.messages.missing
          : tooLong ? `This answer has ${value.length} characters. Shorten it to 2,000 characters or fewer; your draft is kept.` : null;
        const describedBy = error ? errorId : undefined;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 3,
            autoGrow: true,
            maxHeight: 240,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': describedBy,
            value,
            disabled: practice.loading || practice.locked,
            onChange: event => {
              practice.markEdited();
              if (key === 'step') practice.setValue(key, event.target.value);
              else setOptionalAnswers(current => ({ ...current, [key]: event.target.value }));
            },
          }),
          error ? paragraph(error, { id: errorId, role: 'alert' }) : null);
      }),
      practice.locked ? paragraph(content.messages.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? paragraph(practice.status, { id: 'm074-practice-status', role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
