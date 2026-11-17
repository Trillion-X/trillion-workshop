import React, { useState } from 'react';
import { Button, Container, DisclosureSection, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { RESPONSES, decisionSummary, transferState } from './lesson-model.mjs';
import content from './lesson-content.json';
import source from './source-actions.json' with { type: 'json' };

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const optionalFields = fields.filter(key => key !== 'step');
const responseLabels = {
  continue: content.labels.continue,
  change: content.labels.responseChange,
  reconsider: content.labels.responseReconsider,
};

function Lesson({ surfaceInput, host }) {
  const [response, setResponse] = useState(null);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [optionalAnswers, setOptionalAnswers] = useState(() => Object.fromEntries(optionalFields.map(key => [key, ''])));
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.messages,
    requestPrefix: 'm082-amplifying-perceived-value',
    onRestore: record => {
      setOptionalAnswers(Object.fromEntries(optionalFields.map(key => [
        key, typeof record[key] === 'string' ? record[key] : '',
      ])));
      try {
        const saved = JSON.parse(record.transfer ?? '{}');
        setResponse(RESPONSES.includes(saved.response) ? saved.response : null);
      } catch { setResponse(null); }
    },
  });
  const answerFor = key => key === 'step' ? practice.values.step : optionalAnswers[key];
  const decision = response ? decisionSummary(content, response)
    : 'One result supports the core value and one shows a gap. Wider contribution is not established. Choose what the evidence justifies.';
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const evidenceItem = (title, words) => h(Container, { key: title, gap: 'xs' },
    heading(title, 'h3'), paragraph(words));
  const save = () => {
    setAttemptedSave(true);
    const tooLong = fields.some(key => answerFor(key).length > content.labels.fieldLimit);
    const missing = !practice.values.step.trim();
    if (tooLong || missing) return false;
    return practice.save({
      ...Object.fromEntries(optionalFields.map(key => [key, optionalAnswers[key]])),
      transfer: JSON.stringify(transferState(response)),
    });
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),
    h(Container, {
      as: 'section', border: 'all', padding: 'lg', gap: 'md',
      'aria-labelledby': 'm082-example-heading',
    },
      heading(content.labels.workedExample, 'h2', 'm082-example-heading'),
      paragraph(content.labels.exampleIntro),
      evidenceItem(content.labels.coreValue, content.labels.workedValue),
      evidenceItem(content.labels.effects, content.labels.workedEffects),
      evidenceItem(content.labels.wider, content.labels.workedWider),
      evidenceItem(content.labels.progress, content.labels.workedProgress),
      evidenceItem(content.labels.unresolved, content.labels.workedUnresolved),
      h(Container, { gap: 'sm' },
        heading(content.labels.decision, 'h3'),
        h(Container, {
          layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group',
          'aria-label': content.labels.choicePrompt,
        }, ...RESPONSES.map(key => h(Button, {
          key,
          variant: response === key ? 'primary' : 'secondary',
          'aria-pressed': response === key,
          disabled: practice.loading || practice.saving || practice.locked,
          onClick: () => {
            practice.markEdited();
            setResponse(key);
          },
        }, responseLabels[key]))),
        paragraph(decision, { id: 'm082-decision-feedback', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }))),
    h(DisclosureSection, { title: content.labels.source, collapsible: true, defaultOpen: false, divider: false, headingLevel: 2 },
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        paragraph(`“${source.manuscript.excerpt}”`),
        paragraph(content.labels.sourceLocator))),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm082-practice-heading' },
      heading(content.labels.practice, 'h2', 'm082-practice-heading'),
      paragraph(content.labels.practiceIntro)),
    h(Container, { gap: 'md' },
      ...fields.map(key => {
        const id = `m082-practice-${key}`;
        const errorId = `${id}-error`;
        const value = answerFor(key);
        const missing = key === 'step' && attemptedSave && !value.trim();
        const tooLong = attemptedSave && value.length > content.labels.fieldLimit;
        const error = missing ? content.messages.missing
          : tooLong ? `This answer has ${value.length} characters. Shorten it to 2,000 characters or fewer; your draft is kept.` : null;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 3,
            autoGrow: true,
            maxHeight: 240,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': error ? errorId : undefined,
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
      practice.status ? paragraph(practice.status, { id: 'm082-practice-status', role: 'status', 'aria-live': 'polite' }) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
