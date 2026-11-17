import React, { useState } from 'react';
import { Button, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const MAP_KEYS = ['transfer', 'observation', 'comparison', 'result', 'alternative', 'prediction', 'revision', 'zoom'];
let fallbackId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `m059-reaction-${++fallbackId}`;
const blankReaction = () => ({ id: newId(), reaction: '', event: '', behavior: '', quality: '', value: '', examples: '', counterexamples: '' });
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanReactions = rows => Array.isArray(rows) ? rows.filter(plainObject).map(row => ({
  id: typeof row.id === 'string' && row.id ? row.id : newId(),
  reaction: row.reaction === 'admiration' || row.reaction === 'criticism' ? row.reaction : '',
  event: typeof row.event === 'string' ? row.event : '',
  behavior: typeof row.behavior === 'string' ? row.behavior : '',
  quality: typeof row.quality === 'string' ? row.quality : '',
  value: typeof row.value === 'string' ? row.value : '',
  examples: typeof row.examples === 'string' ? row.examples : '',
  counterexamples: typeof row.counterexamples === 'string' ? row.counterexamples : '',
})) : [];

const title = (words, level = 'h2', id) => h(Text, {
  as: level,
  id,
  variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
}, words);
const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);

function Lesson({ surfaceInput, host }) {
  const [reactions, setReactions] = useState(() => [blankReaction()]);
  const [localStatus, setLocalStatus] = useState('');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.feedback,
    requestPrefix: 'm059-shadow-work-distinction-detector',
    onRestore: record => {
      try {
        const parts = MAP_KEYS.map(key => typeof record[key] === 'string' ? record[key] : '').join('');
        if (!parts) {
          setReactions([blankReaction()]);
          return;
        }
        const saved = JSON.parse(parts);
        if (saved?.version === 1 && Array.isArray(saved.reactions)) setReactions(cleanReactions(saved.reactions));
      } catch { /* Keep an editable card if older private context cannot be restored. */ }
    },
  });
  const locked = practice.loading || practice.locked;
  const changeReaction = (id, key, value) => {
    practice.markEdited();
    setLocalStatus('');
    setReactions(current => current.map(row => row.id === id ? { ...row, [key]: value } : row));
  };
  const addReaction = () => {
    practice.markEdited();
    setLocalStatus('');
    setReactions(current => [...current, blankReaction()]);
  };
  const removeReaction = id => {
    practice.markEdited();
    setLocalStatus('');
    setReactions(current => current.filter(row => row.id !== id));
  };
  const encodedMap = () => {
    const cleaned = cleanReactions(reactions);
    const textValues = cleaned.flatMap(row => ['event', 'behavior', 'quality', 'value', 'examples', 'counterexamples'].map(key => row[key]));
    if (textValues.some(value => value.length > 2000) || (practice.values.step ?? '').length > 2000) return { error: 'fieldLength' };
    const text = JSON.stringify({ version: 1, reactions: cleaned });
    const chunks = [];
    for (let at = 0; at < text.length; at += 2000) chunks.push(text.slice(at, at + 2000));
    if (chunks.length > MAP_KEYS.length) return { error: 'length' };
    return { map: Object.fromEntries(MAP_KEYS.map((key, index) => [key, chunks[index] ?? ''])) };
  };
  const save = () => {
    const result = encodedMap();
    if (result.error) {
      setLocalStatus(content.feedback[result.error]);
      return;
    }
    setLocalStatus('');
    practice.save(result.map);
  };
  const renderField = (row, key) => {
    const id = `m059-${row.id}-${key}`;
    const invalid = row[key].length > 2000;
    return h(Container, { key, gap: 'xs', flex: '1', minWidth: '280px' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, {
        id,
        rows: 3,
        autoGrow: true,
        maxHeight: 220,
        value: row[key],
        disabled: locked,
        'aria-invalid': invalid || undefined,
        'aria-describedby': invalid ? `${id}-limit` : undefined,
        onChange: event => changeReaction(row.id, key, event.target.value),
      }),
      invalid ? h(Text, { as: 'p', id: `${id}-limit`, variant: 'body', role: 'alert' }, content.feedback.fieldLength) : null);
  };
  const renderReaction = (row, index) => h(Container, {
    key: row.id,
    as: 'article',
    border: 'all',
    padding: 'md',
    gap: 'md',
    'aria-label': `Reaction ${index + 1}`,
  },
  h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
    title(`Reaction ${index + 1}`, 'h3'),
    h(Button, { variant: 'secondary', disabled: locked, onClick: () => removeReaction(row.id) }, content.labels.removeCase)),
  h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: `m059-${row.id}-reaction` }, content.practice.reaction),
    h(Select, {
      value: row.reaction || null,
      onValueChange: value => changeReaction(row.id, 'reaction', value === 'admiration' || value === 'criticism' ? value : ''),
    },
    h(SelectTrigger, { id: `m059-${row.id}-reaction`, 'aria-label': content.practice.reaction },
      h(SelectValue, { placeholder: content.practice.reactionPlaceholder }, row.reaction ? content.practice[row.reaction] : undefined)),
    h(SelectPopup, null,
      h(SelectItem, { value: 'admiration' }, content.practice.admiration),
      h(SelectItem, { value: 'criticism' }, content.practice.criticism)))),
  h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
    renderField(row, 'event'),
    renderField(row, 'behavior')),
  h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
    renderField(row, 'quality'),
    renderField(row, 'value')),
  h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
    renderField(row, 'examples'),
    renderField(row, 'counterexamples')));
  const mapSection = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm059-map-heading' },
    title(content.labels.map, 'h2', 'm059-map-heading'),
    paragraph(content.practice.instructions),
    ...reactions.map(renderReaction),
    h(Button, { variant: 'secondary', disabled: locked, onClick: addReaction }, content.labels.addCase),
    h(Container, { gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm059-next' }, content.practice.next),
      h(Textarea, {
        id: 'm059-next',
        rows: 3,
        autoGrow: true,
        maxHeight: 220,
        value: practice.values.step ?? '',
        disabled: locked,
        'aria-required': 'true',
        'aria-invalid': (practice.values.step ?? '').length > 2000 || undefined,
        'aria-describedby': (practice.values.step ?? '').length > 2000 ? 'm059-next-limit' : undefined,
        onChange: event => {
          setLocalStatus('');
          practice.setValue('step', event.target.value);
        },
      }),
      (practice.values.step ?? '').length > 2000 ? h(Text, {
        as: 'p', id: 'm059-next-limit', variant: 'body', role: 'alert',
      }, content.feedback.fieldLength) : null),
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    localStatus || practice.status ? h(Text, {
      as: 'p', id: 'm059-map-feedback', role: 'status', 'aria-live': 'polite',
    }, localStatus || practice.status) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, title(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm059-example-heading' },
      title(content.labels.example, 'h2', 'm059-example-heading'),
      paragraph(content.examples.context.description)),
    mapSection,
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
