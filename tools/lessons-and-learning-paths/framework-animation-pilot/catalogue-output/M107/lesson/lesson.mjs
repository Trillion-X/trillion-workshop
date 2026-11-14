import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [caseId, setCaseId] = useState(content.example.startType);
  const [targetCase, setTargetCase] = useState(content.example.cases[content.example.startType].targetCase);
  const [draft, setDraft] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm107-cross-domain-synthesis',
    onRestore: record => setDraft(typeof record.result === 'string' ? record.result : ''),
  });
  const savingDisabled = practice.loading || practice.saving || practice.locked;
  const exampleCase = content.example.cases[caseId];
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', h4: 'heading-xs' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const comparison = h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm107-map-heading' },
    heading(content.example.mappingHeading, 'h3', 'm107-map-heading'),
    ...content.example.mapping.map((row, index) => h(Container, {
      key: `m107-map-${index}`,
      as: 'article', border: 'all', padding: 'md', gap: 'sm',
      'aria-label': `${row.source} / ${row.target}`,
    },
      h(Container, { layout: 'responsive-split', gap: 'md' },
        h(Container, { gap: 'xs' },
          h(Text, { as: 'strong', variant: 'body' }, content.labels.sourceMechanism),
          p(row.source)),
        h(Container, { gap: 'xs' },
          h(Text, { as: 'strong', variant: 'body' }, 'In the lesson'),
          p(row.target))))));
  const scenarioButtons = h(Container, { layout: 'responsive-split', gap: 'sm', role: 'group', 'aria-label': 'Choose a lesson case to examine' },
    ...Object.entries(content.example.cases).map(([id, item]) => h(Button, {
      key: id,
      variant: id === caseId ? 'primary' : 'secondary',
      'aria-pressed': id === caseId,
      onClick: () => {
        setCaseId(id);
        setTargetCase(item.targetCase);
      },
    }, item.button)));
  const targetEditor = h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm107-target-case' }, content.labels.editCase),
    h(Textarea, {
      id: 'm107-target-case',
      rows: 3,
      autoGrow: true,
      maxHeight: 220,
      'aria-label': content.labels.editCase,
      value: targetCase,
      onChange: event => setTargetCase(event.target.value),
    }),
    p(content.labels.caseHelp));
  const activeCase = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm',
    'aria-labelledby': 'm107-selected-case-heading',
    'aria-live': 'polite', 'aria-atomic': 'true',
  },
    heading(exampleCase.button, 'h3', 'm107-selected-case-heading'),
    p(targetCase),
    h(Container, { layout: 'responsive-split', gap: 'md' },
      h(Container, { gap: 'xs' },
        h(Text, { as: 'strong', variant: 'body' }, content.labels.targetQuestion),
        p(exampleCase.question)),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'strong', variant: 'body' }, content.labels.evidenceToNotice),
        p(exampleCase.signal))),
    h(Container, { border: 'quote', padding: 'md', gap: 'xs' },
      h(Text, { as: 'strong', variant: 'body' }, content.labels.limit),
      p(exampleCase.limit)));
  const steps = h(Container, { as: 'ol', gap: 'sm' }, ...content.labels.steps.map((step, index) => h(Container, {
    as: 'li', key: `m107-step-${index}`, border: 'all', padding: 'md', gap: 'xs',
  }, h(Text, { as: 'strong', variant: 'body' }, String(index + 1)), p(step))));
  const practiceField = h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: 'm107-private-transfer' }, content.labels.practiceField),
    h(Textarea, {
      id: 'm107-private-transfer', rows: 9, autoGrow: true, maxHeight: 320,
      'aria-label': content.labels.practiceField,
      placeholder: content.labels.practicePlaceholder,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm107-practice-length-error' : undefined,
      value: draft,
      disabled: savingDisabled,
      onChange: event => {
        const value = event.target.value;
        setDraft(value);
        const overLimit = value.length > 2000;
        setTooLong(overLimit);
        practice.markEdited();
        practice.setValue('result', overLimit ? '' : value);
      },
    }));
  const practiceCard = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'md',
    'aria-labelledby': 'm107-practice-heading',
  },
    heading(content.labels.attemptHeading, 'h2', 'm107-practice-heading'),
    p(content.labels.attemptBody),
    practiceField,
    tooLong ? h(Text, {
      as: 'p', id: 'm107-practice-length-error', variant: 'body', role: 'alert',
    }, content.labels.oversize) : null,
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving || tooLong,
      onClick: () => { void practice.save(); },
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    p(content.labels.private),
    practice.status ? h(Text, {
      as: 'p', variant: 'body', role: 'status', 'aria-live': 'polite',
    }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);
  const sourceDisclosure = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceManuscript),
    p(content.labels.sourceBody),
    p(content.source.manuscriptLocator));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm107-example-heading' },
      heading(content.example.heading, 'h2', 'm107-example-heading'),
      p(content.example.intro),
      h(Container, { border: 'quote', padding: 'md', gap: 'sm' }, p(content.example.lesson)),
      comparison,
      h(Container, { gap: 'sm' },
        h(Text, { as: 'p', variant: 'body' }, content.labels.sourceConditions),
        scenarioButtons,
        targetEditor,
        activeCase)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm107-steps-heading' },
      heading(content.labels.fourStepsHeading, 'h2', 'm107-steps-heading'), steps),
    h(Container, {
      as: 'section', border: 'all', padding: 'md', gap: 'sm',
      'aria-labelledby': 'm107-boundary-heading',
    }, heading(content.labels.boundaryHeading, 'h2', 'm107-boundary-heading'), p(content.labels.boundaryBody)),
    practiceCard,
    sourceDisclosure);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
