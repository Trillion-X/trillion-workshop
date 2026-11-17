import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['observation', 'comparison', 'revision', 'alternative', 'prediction', 'result', 'transfer', 'zoom', 'step'];
const CHUNK_SIZE = 1800;
const VERSION = 'm058-evidence-v1';

function emptyDraft() {
  return { candidate: '', examples: [] };
}

function encodeDraft(draft) {
  const body = JSON.stringify(draft);
  const count = Math.ceil(body.length / CHUNK_SIZE);
  if (count > fields.length - 1) return null;
  const values = Object.fromEntries(fields.map(key => [key, '-']));
  values.observation = `${VERSION}:${count}:${body.length}`;
  for (let index = 0; index < count; index++) {
    values[fields[index + 1]] = body.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
  }
  return values;
}

function decodeDraft(record) {
  if (!record || typeof record.observation !== 'string') return emptyDraft();
  const match = new RegExp(`^${VERSION}:(\\d+):(\\d+)$`).exec(record.observation);
  if (!match) throw new Error('The saved M058 draft version is not recognized.');
  const count = Number(match[1]);
  const length = Number(match[2]);
  if (!Number.isInteger(count) || count < 1 || count >= fields.length || !Number.isInteger(length)
    || length > CHUNK_SIZE * (fields.length - 1)) {
    throw new Error('The saved M058 draft size is not valid.');
  }
  const body = fields.slice(1, count + 1).map(key => record[key] ?? '').join('');
  if (body.length !== length) throw new Error('The saved M058 draft is incomplete.');
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.candidate !== 'string'
    || !Array.isArray(value.examples) || value.examples.some(row => !row || typeof row !== 'object'
      || Array.isArray(row) || typeof row.id !== 'string' || !['activity', 'further'].includes(row.stage)
      || ['area', 'name', 'pattern', 'circumstance', 'absorption'].some(key => typeof row[key] !== 'string')
      || !Array.isArray(row.readings) || row.readings.some(item => !['fit', 'challenge', 'constraint'].includes(item)))) {
    throw new Error('The saved M058 evidence rows are not readable.');
  }
  return value;
}

function newExample(stage) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `m058-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stage,
    area: '',
    name: '',
    pattern: '',
    circumstance: '',
    absorption: '',
    readings: [],
  };
}

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [sizeLimit, setSizeLimit] = useState(false);
  const [restoreIssue, setRestoreIssue] = useState('');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm058-actions-activities',
    onRestore: record => {
      try { setDraft(decodeDraft(record)); }
      catch (error) { setRestoreIssue(error.message); }
    },
  });
  const disabled = practice.loading || practice.locked;

  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);

  const commitDraft = next => {
    const encoded = encodeDraft(next);
    if (!encoded) {
      setSizeLimit(true);
      return false;
    }
    setSizeLimit(false);
    for (const key of fields) if (practice.values[key] !== encoded[key]) practice.setValue(key, encoded[key]);
    setDraft(next);
    return true;
  };
  const updateExample = (id, key, value) => {
    if (disabled) return;
    commitDraft({
      ...draft,
      examples: draft.examples.map(row => row.id === id ? { ...row, [key]: value } : row),
    });
  };
  const toggleReading = (row, reading) => updateExample(row.id, 'readings', row.readings.includes(reading)
    ? row.readings.filter(item => item !== reading)
    : [...row.readings, reading]);
  const rowCount = row => draft.examples.filter(item => item.stage === row.stage).indexOf(row) + 1;
  const rows = (stage, title, emptyText) => {
    const selected = draft.examples.filter(row => row.stage === stage);
    return h(Container, { as: 'section', gap: 'md', 'aria-labelledby': `m058-${stage}-heading` },
      heading(title, 'h2', `m058-${stage}-heading`),
      selected.length ? null : paragraph(emptyText),
      ...selected.map(row => h(Container, {
        key: row.id,
        as: 'article',
        border: 'all',
        padding: 'md',
        gap: 'sm',
        'aria-labelledby': `m058-example-${row.id}`,
      },
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
        heading(stage === 'activity' ? `Activity ${rowCount(row)}` : `Further behavior ${rowCount(row)}`, 'h3', `m058-example-${row.id}`),
        h(Button, {
          variant: 'secondary',
          disabled,
          onClick: () => updateExample(row.id, 'stage', stage === 'activity' ? 'further' : 'activity'),
        }, stage === 'activity' ? 'Use as further behavior' : 'Keep with activities'),
        h(Button, {
          variant: 'secondary',
          disabled,
          'aria-label': `${content.labels.remove} ${stage === 'activity' ? 'activity' : 'further behavior'} ${rowCount(row)}`,
          onClick: () => commitDraft({ ...draft, examples: draft.examples.filter(item => item.id !== row.id) }),
        }, content.labels.remove)),
      ...[
        ['area', content.labels.domain, 1],
        ['name', content.labels.activity, 1],
        ['pattern', content.labels.pattern, 2],
        ['circumstance', content.labels.circumstance, 2],
        ['absorption', content.labels.absorption, 2],
      ].map(([key, label, rowSize]) => {
        const id = `m058-${row.id}-${key}`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
          h(Textarea, {
            id,
            rows: rowSize,
            autoGrow: true,
            maxHeight: 220,
            value: row[key],
            disabled,
            onChange: event => updateExample(row.id, key, event.target.value),
          }));
      }),
      h(Container, { gap: 'xs', role: 'group', 'aria-label': content.labels.relations },
        h(Text, { as: 'p', variant: 'body' }, content.labels.relations),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
          ...[
            ['fit', content.labels.fit],
            ['challenge', content.labels.challenge],
            ['constraint', content.labels.constraint],
          ].map(([value, label]) => h(Button, {
            key: value,
            variant: row.readings.includes(value) ? 'primary' : 'secondary',
            'aria-pressed': row.readings.includes(value),
            disabled,
            onClick: () => toggleReading(row, value),
          }, label)))))));
  };

  const add = stage => {
    if (disabled) return;
    commitDraft({ ...draft, examples: [...draft.examples, newExample(stage)] });
  };
  const save = () => {
    if (!commitDraft(draft)) return false;
    return practice.save();
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening),
      paragraph(content.labels.method)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm058-activity-heading' },
      heading(content.labels.activities, 'h2', 'm058-activity-heading'),
      paragraph(content.labels.activitiesPrompt),
      h(Button, {
        variant: 'primary',
        disabled,
        onClick: () => add('activity'),
      }, content.labels.addActivity),
      rows('activity', 'Activity examples', 'No activity examples yet. Add one when it helps.'),
      h(Button, {
        variant: 'secondary',
        disabled,
        onClick: () => add('further'),
      }, content.labels.addFurther),
      rows('further', content.labels.further, 'No further behavior yet. Add an example when one comes to mind.')),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm058-candidate-heading' },
      heading(content.labels.candidate, 'h2', 'm058-candidate-heading'),
      paragraph(content.labels.candidatePrompt),
      h(Textarea, {
        id: 'm058-candidate',
        'aria-label': content.labels.candidate,
        rows: 3,
        autoGrow: true,
        maxHeight: 240,
        value: draft.candidate,
        disabled,
        onChange: event => commitDraft({ ...draft, candidate: event.target.value }),
      }),
      h(Container, { as: 'article', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm058-source-example-heading' },
        heading(content.labels.sourceExample, 'h3', 'm058-source-example-heading'),
        paragraph(content.labels.sourceExampleText))),

    sizeLimit ? paragraph(content.labels.sizeLimit, { role: 'alert' }) : null,
    restoreIssue ? paragraph(restoreIssue, { role: 'status', 'aria-live': 'polite' }) : null,
    practice.loading ? paragraph('Loading your private draft.', { role: 'status', 'aria-live': 'polite' }) : null,
    practice.locked ? paragraph(content.labels.locked) : null,
    h(Button, {
      variant: 'primary',
      work: null,
      disabled: practice.loading || practice.saving,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? paragraph(practice.status, { id: 'm058-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
