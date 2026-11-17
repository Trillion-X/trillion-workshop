import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const blankDraft = () => ({
  values: Array.from({ length: 5 }, () => ({ value: '', activities: '' })),
  comparison: '',
});
const hasContent = draft => draft.values.some(row => row.value.trim() || row.activities.trim())
  || draft.comparison.trim().length > 0;
const serialize = draft => hasContent(draft) ? JSON.stringify(draft) : '';
const restoredDraft = result => {
  if (typeof result !== 'string' || !result) return blankDraft();
  try {
    const parsed = JSON.parse(result);
    if (parsed && Array.isArray(parsed.values) && parsed.values.length === 5
      && parsed.values.every(row => row && typeof row.value === 'string' && typeof row.activities === 'string')
      && typeof parsed.comparison === 'string') {
      return { values: parsed.values, comparison: parsed.comparison };
    }
  } catch {}
  return { ...blankDraft(), comparison: result };
};

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blankDraft);
  const [tooLong, setTooLong] = useState(false);
  const [activity, setActivity] = useState('reading');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm078-values-to-action',
    onRestore: record => {
      const nextDraft = restoredDraft(typeof record.result === 'string' ? record.result : '');
      setDraft(nextDraft);
      setTooLong(serialize(nextDraft).length > 2000);
    },
  });
  const disabled = practice.loading || practice.saving || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', h4: 'heading' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const label = (words, id) => h(Text, { as: 'label', variant: 'body', htmlFor: id }, words);
  const setDraftField = nextDraft => {
    setDraft(nextDraft);
    const value = serialize(nextDraft);
    setTooLong(value.length > 2000);
    practice.setValue('result', value);
  };
  const textarea = ({ id, name, value, rows, onChange }) => h(Textarea, {
    id,
    rows,
    autoGrow: true,
    maxHeight: 180,
    'aria-label': name,
    'aria-invalid': tooLong ? 'true' : undefined,
    'aria-describedby': tooLong ? 'm078-draft-length-error' : undefined,
    value,
    disabled,
    onChange: event => onChange(event.target.value),
  });
  const updateValue = (index, key, value) => setDraftField({
    ...draft,
    values: draft.values.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row),
  });
  const mapRows = draft.values.map((row, index) => {
    const groupId = `m078-value-group-${index + 1}`;
    const valueId = `m078-value-${index + 1}`;
    const activitiesId = `m078-activities-${index + 1}`;
    return h(Container, {
      key: index,
      as: 'section',
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': groupId,
    },
      heading(`Value ${index + 1}`, 'h3', groupId),
      h(Container, { gap: 'xs' },
        label(content.labels.value, valueId),
        textarea({
          id: valueId,
          name: `Value ${index + 1}`,
          value: row.value,
          rows: 1,
          onChange: value => updateValue(index, 'value', value),
        })),
      h(Container, { gap: 'xs' },
        label(content.labels.activities, activitiesId),
        textarea({
          id: activitiesId,
          name: `Possible activities for value ${index + 1}`,
          value: row.activities,
          rows: 2,
          onChange: value => updateValue(index, 'activities', value),
        })));
  });
  const activityCard = (key, selected) => {
    const detail = content.activities[key];
    const id = `m078-activity-${key}`;
    return h(Container, {
      key,
      as: 'section',
      flex: 1,
      border: 'all',
      padding: 'md',
      gap: 'sm',
      'aria-labelledby': id,
    },
      heading(detail.title, 'h3', id),
      h(Container, { gap: 'xs' },
        heading(content.labels.connection, 'h4'), p(detail.connection)),
      h(Container, { gap: 'xs' },
        heading(content.labels.impact, 'h4'), p(detail.impact)),
      h(Container, { gap: 'xs' },
        heading(content.labels.fit, 'h4'), p(detail.fit)),
      h(Container, { gap: 'xs' },
        heading(content.labels.difficulty, 'h4'), p(detail.difficulty)),
      h(Button, {
        variant: selected ? 'primary' : 'secondary',
        'aria-pressed': selected,
        onClick: () => setActivity(key),
      }, key === 'reading' ? content.labels.examineReading : content.labels.examineObservation));
  };
  const chosenActivity = content.activities[activity];
  const errorId = 'm078-draft-length-error';
  const mapSection = h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-labelledby': 'm078-map-heading',
  },
    heading(content.labels.mapHeading, 'h2', 'm078-map-heading'),
    p(content.labels.mapIntro),
    h(Container, { gap: 'md' }, ...mapRows));
  const comparisonFieldId = 'm078-comparison';
  const practiceCard = h(Container, {
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-labelledby': 'm078-comparison-heading',
  },
    heading(content.labels.comparisonHeading, 'h2', 'm078-comparison-heading'),
    p(content.labels.comparisonIntro),
    h(Container, { gap: 'xs' },
      label(content.labels.comparisonField, comparisonFieldId),
      textarea({
        id: comparisonFieldId,
        name: content.labels.comparisonField,
        value: draft.comparison,
        rows: 5,
        onChange: value => setDraftField({ ...draft, comparison: value }),
      })),
    tooLong ? h(Text, { as: 'p', id: errorId, variant: 'body', role: 'alert' }, content.labels.overlimit) : null,
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving || tooLong,
      onClick: () => { void practice.save(); },
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    p(content.labels.private),
    practice.status ? h(Text, { as: 'p', variant: 'body', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm078-example-heading' },
      heading(content.labels.example, 'h2', 'm078-example-heading'),
      p(content.labels.exampleContext),
      h(Container, { layout: 'responsive-split', gap: 'md', 'aria-label': content.labels.comparison },
        activityCard('reading', activity === 'reading'), activityCard('observation', activity === 'observation')),
      h(Container, {
        as: 'section',
        border: 'quote',
        padding: 'md',
        gap: 'xs',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'aria-labelledby': 'm078-trial-heading',
      },
        heading(content.labels.selectedTrial, 'h3', 'm078-trial-heading'),
        p(chosenActivity.trial))),
    mapSection,
    practiceCard,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
