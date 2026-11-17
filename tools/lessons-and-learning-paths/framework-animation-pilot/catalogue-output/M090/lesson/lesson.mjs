import React, { useState } from 'react';
import { Button, Container, DisclosureSection, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';
import source from './source-actions.json' with { type: 'json' };

const h = React.createElement;
const requiredFields = ['result'];
const optionalFields = ['step', 'observation', 'alternative', 'prediction', 'revision', 'comparison', 'zoom', 'transfer'];
const allFields = [...requiredFields, ...optionalFields];

function Lesson({ surfaceInput, host }) {
  const [optional, setOptional] = useState(Object.fromEntries(optionalFields.map(key => [key, ''])));
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: requiredFields,
    messages: content.messages,
    requestPrefix: 'm090-ecosystem-resonance',
    onRestore: record => setOptional(Object.fromEntries(optionalFields.map(key => [
      key, typeof record[key] === 'string' ? record[key] : '',
    ]))),
  });

  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const value = key => requiredFields.includes(key) ? practice.values[key] ?? '' : optional[key] ?? '';
  const setField = (key, next) => {
    practice.markEdited();
    if (requiredFields.includes(key)) practice.setValue(key, next);
    else setOptional(current => ({ ...current, [key]: next }));
  };
  const messageFor = key => {
    if (!attemptedSave) return '';
    const current = value(key);
    if (current.length > content.labels.fieldLimit) {
      return `This answer has ${current.length} characters. Shorten it to ${content.labels.fieldLimit.toLocaleString()} characters or fewer; your full draft stays here.`;
    }
    if (requiredFields.includes(key) && !current.trim()) return content.messages.missingField;
    return '';
  };
  const field = ({ key, label, required = false, rows = 3 }) => {
    const id = `m090-practice-${key}`;
    const errorId = `${id}-error`;
    const error = messageFor(key);
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', weight: 'medium', htmlFor: id }, `${label} (${required ? content.labels.requiredToSave : content.labels.optional})`),
      h(Textarea, {
        id,
        rows,
        autoGrow: true,
        maxHeight: rows > 3 ? 260 : 200,
        value: value(key),
        disabled,
        required,
        'aria-required': required ? 'true' : undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': error ? errorId : undefined,
        onChange: event => setField(key, event.target.value),
      }),
      error ? paragraph(error, { id: errorId, role: 'alert' }) : null);
  };
  const episodeCard = ({ title, id, peopleLabel, settingLabel, qualitiesLabel, cueLabel }) =>
    h(Container, {
      key: title,
      as: 'section',
      flex: '1',
      minWidth: '260px',
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': id,
    },
      heading(title, 'h3', id),
      paragraph(peopleLabel),
      paragraph(settingLabel),
      paragraph(qualitiesLabel),
      paragraph(cueLabel));
  const example = h(Container, {
    as: 'section', border: 'all', padding: 'lg', gap: 'md',
    'aria-labelledby': 'm090-example-heading',
  },
    heading(content.labels.workedExample, 'h2', 'm090-example-heading'),
    paragraph(content.labels.illustration),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
      episodeCard({ title: content.labels.firstEpisode, id: 'm090-example-first', peopleLabel: content.labels.firstPeopleExample, settingLabel: content.labels.firstContext, qualitiesLabel: content.labels.firstExperience, cueLabel: content.labels.firstCue }),
      episodeCard({ title: content.labels.secondEpisode, id: 'm090-example-second', peopleLabel: content.labels.secondPeopleExample, settingLabel: content.labels.secondContext, qualitiesLabel: content.labels.secondExperience, cueLabel: content.labels.secondCue })),
    h(Container, { gap: 'sm' },
      heading('Compare the episodes', 'h3'),
      paragraph(content.labels.examplePattern),
      paragraph(content.labels.exampleInquiry)));
  const save = async () => {
    setAttemptedSave(true);
    if (allFields.some(key => value(key).length > content.labels.fieldLimit)
      || requiredFields.some(key => !value(key).trim())) return false;
    return practice.save({ ...Object.fromEntries(optionalFields.map(key => [key, value(key)])) });
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    example,
    h(DisclosureSection, { title: content.labels.source, collapsible: true, defaultOpen: false, divider: false, headingLevel: 2 },
      paragraph(`“${source.manuscript.excerpt}”`),
      paragraph(content.labels.sourceLocator)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm090-practice-heading' },
      heading(content.labels.practice, 'h2', 'm090-practice-heading'),
      paragraph(content.labels.practiceIntro)),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
      h(Container, { as: 'section', flex: '1', minWidth: '260px', gap: 'md', 'aria-labelledby': 'm090-first-heading' },
        heading(content.labels.firstSection, 'h3', 'm090-first-heading'),
        field({ key: 'step', label: content.labels.peopleAndRole, rows: 2 }),
        field({ key: 'observation', label: content.labels.settingAndConditions, rows: 2 }),
        field({ key: 'result', label: content.labels.experiencedQualities, required: true })),
      h(Container, { as: 'section', flex: '1', minWidth: '260px', gap: 'md', 'aria-labelledby': 'm090-second-heading' },
        heading(content.labels.secondSection, 'h3', 'm090-second-heading'),
        field({ key: 'alternative', label: content.labels.peopleAndRole, rows: 2 }),
        field({ key: 'prediction', label: content.labels.settingAndConditions, rows: 2 }),
        field({ key: 'revision', label: content.labels.experiencedQualities }))),
    h(Container, { gap: 'md' },
      field({ key: 'comparison', label: content.labels.comparison, rows: 4 }),
      field({ key: 'zoom', label: content.labels.observedCuePair, rows: 3 }),
      field({ key: 'transfer', label: content.labels.nextInquiry, rows: 3 }),
      h(Container, { gap: 'xs' },
        h(Button, {
          variant: 'primary',
          work: null,
          disabled: practice.loading || practice.saving,
          onClick: save,
        }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
        paragraph(content.labels.private)),
      practice.status ? paragraph(practice.status, { id: 'm090-practice-status', role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.messages.retryPending) : null));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
