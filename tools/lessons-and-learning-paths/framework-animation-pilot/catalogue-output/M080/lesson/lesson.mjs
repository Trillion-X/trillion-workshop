import React, { useState } from 'react';
import { Button, Container, DisclosureSection, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import source from './source-actions.json' with { type: 'json' };
import content from './lesson-content.json';

const h = React.createElement;
const optionalFields = ['prediction', 'observation', 'result'];
const phaseIds = ['before', 'during', 'after'];

function Lesson({ surfaceInput, host }) {
  const [phase, setPhase] = useState('before');
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [optionalAnswers, setOptionalAnswers] = useState(() => Object.fromEntries(optionalFields.map(key => [key, ''])));
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['revision'],
    messages: content.messages,
    requestPrefix: 'm080-value-integration-ritual',
    onRestore: record => setOptionalAnswers(Object.fromEntries(optionalFields.map(key => [
      key, typeof record[key] === 'string' ? record[key] : '',
    ]))),
  });
  const values = { ...optionalAnswers, revision: practice.values.revision };
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const phaseCopy = content.example.phases[phase];
  const save = () => {
    setAttemptedSave(true);
    const tooLong = Object.values(values).some(value => value.length > content.practice.fieldLimit);
    if (tooLong || !practice.values.revision.trim()) return false;
    return practice.save(Object.fromEntries(optionalFields.map(key => [key, optionalAnswers[key]])));
  };
  const exampleLine = (label, value) => h(Container, { key: label, gap: 'xs' },
    h(Text, { as: 'h4', variant: 'heading-sm' }, label),
    paragraph(value));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      h(Text, { as: 'h1', variant: 'heading-xl' }, content.title),
      paragraph(content.opening)),
    h(Container, { border: 'all', padding: 'lg', gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.example.title),
      paragraph(content.example.intro),
      paragraph(content.example.phaseNavigation),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': 'Value ritual phases' },
        ...phaseIds.map(id => {
          const item = content.example.phases[id];
          return h(Button, {
            key: id,
            variant: phase === id ? 'primary' : 'secondary',
            active: phase === id,
            'aria-pressed': phase === id,
            'aria-controls': 'm080-example-phase',
            onClick: () => setPhase(id),
          }, item.label);
        })),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', id: 'm080-example-phase', role: 'region', 'aria-labelledby': 'm080-phase-heading' },
        h(Text, { as: 'h3', variant: 'heading-md', id: 'm080-phase-heading' }, phaseCopy.heading),
        ...Object.keys(phaseCopy).filter(key => /Label$/u.test(key)).map(key => {
          const valueKey = key.slice(0, -5);
          return exampleLine(phaseCopy[key], phaseCopy[valueKey]);
        }))),
    h(DisclosureSection, { title: 'Manuscript, page 43', collapsible: true, defaultOpen: false, divider: false, headingLevel: 2 },
      h(Container, { border: 'all', padding: 'md', gap: 'sm' },
        paragraph(`“${source.manuscript.excerpt}”`), paragraph(content.source.locator))),
    h(Container, { as: 'section', border: 'all', padding: 'lg', gap: 'md', 'aria-labelledby': 'm080-practice-heading' },
      h(Text, { as: 'h2', variant: 'heading-lg', id: 'm080-practice-heading' }, content.practice.title),
      paragraph(content.practice.intro),
      ...optionalFields.concat('revision').map(key => {
        const isRequired = key === 'revision';
        const id = `m080-practice-${key}`;
        const errorId = `${id}-error`;
        const value = values[key];
        const missing = isRequired && attemptedSave && !value.trim();
        const tooLong = attemptedSave && value.length > content.practice.fieldLimit;
        const error = tooLong ? `This answer has ${value.length} characters. Shorten it to 2,000 characters or fewer; the full draft is kept.`
          : missing ? content.messages.missing : null;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice.prompts[key]),
          h(Textarea, {
            id,
            rows: key === 'revision' ? 3 : 2,
            autoGrow: true,
            maxHeight: 240,
            'aria-required': isRequired ? 'true' : undefined,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': error ? errorId : undefined,
            value,
            disabled: practice.loading || practice.locked,
            onChange: event => {
              practice.markEdited();
              if (isRequired) practice.setValue(key, event.target.value);
              else setOptionalAnswers(current => ({ ...current, [key]: event.target.value }));
            },
          }),
          error ? paragraph(error, { id: errorId, role: 'alert' }) : null);
      }),
      paragraph(content.practice.partialSave),
      paragraph(content.practice.privacy),
      practice.locked ? paragraph(content.messages.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        loading: practice.saving,
        pendingLabel: content.practice.busy,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.locked ? content.practice.retry : content.practice.save),
      practice.status ? paragraph(practice.status, { id: 'm080-practice-status', role: 'status', 'aria-live': 'polite' }) : null),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
