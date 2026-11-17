import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const MAP_KEYS = ['transfer', 'observation', 'comparison', 'result', 'alternative', 'prediction', 'revision', 'zoom'];
let fallbackId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `m051-area-${++fallbackId}`;
const blankArea = () => ({ id: newId(), area: '', situation: '', responsibility: '', condition: '', effect: '' });
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanAreas = rows => Array.isArray(rows) ? rows.filter(plainObject).map(row => ({
  id: typeof row.id === 'string' && row.id ? row.id : newId(),
  area: typeof row.area === 'string' ? row.area.slice(0, 2000) : '',
  situation: typeof row.situation === 'string' ? row.situation.slice(0, 2000) : '',
  responsibility: typeof row.responsibility === 'string' ? row.responsibility.slice(0, 2000) : '',
  condition: typeof row.condition === 'string' ? row.condition.slice(0, 2000) : '',
  effect: typeof row.effect === 'string' ? row.effect.slice(0, 2000) : '',
})) : [];

const title = (words, level = 'h2', id) => h(Text, {
  as: level,
  id,
  variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
}, words);
const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);

function Lesson({ surfaceInput, host }) {
  const [areas, setAreas] = useState(() => [blankArea()]);
  const [localStatus, setLocalStatus] = useState('');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.feedback,
    requestPrefix: 'm051-worth-separation-mapping',
    onRestore: record => {
      try {
        const parts = MAP_KEYS.map(key => typeof record[key] === 'string' ? record[key] : '').join('');
        if (!parts) {
          setAreas([blankArea()]);
          return;
        }
        const saved = JSON.parse(parts);
        if (saved?.version === 1 && Array.isArray(saved.areas)) setAreas(cleanAreas(saved.areas));
      } catch { /* Keep an editable map if older private context cannot be restored. */ }
    },
  });
  const locked = practice.loading || practice.locked;
  const changeArea = (id, key, value) => {
    practice.markEdited();
    setLocalStatus('');
    setAreas(current => current.map(row => row.id === id ? { ...row, [key]: value } : row));
  };
  const addArea = () => {
    practice.markEdited();
    setLocalStatus('');
    setAreas(current => [...current, blankArea()]);
  };
  const removeArea = id => {
    practice.markEdited();
    setLocalStatus('');
    setAreas(current => current.filter(row => row.id !== id));
  };
  const encodedMap = () => {
    const text = JSON.stringify({ version: 1, areas: cleanAreas(areas) });
    const chunks = [];
    for (let at = 0; at < text.length; at += 2000) chunks.push(text.slice(at, at + 2000));
    if (chunks.length > MAP_KEYS.length) return null;
    return Object.fromEntries(MAP_KEYS.map((key, index) => [key, chunks[index] ?? '']));
  };
  const save = () => {
    const map = encodedMap();
    if (!map) {
      setLocalStatus(content.feedback.length);
      return;
    }
    setLocalStatus('');
    practice.save(map);
  };
  const renderField = (row, key) => {
    const id = `m051-${row.id}-${key}`;
    return h(Container, { key, gap: 'xs', flex: '1', minWidth: '280px' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, {
        id,
        rows: 3,
        autoGrow: true,
        maxHeight: 220,
        maxLength: 2000,
        value: row[key],
        disabled: locked,
        onChange: event => changeArea(row.id, key, event.target.value),
      }));
  };
  const mapSection = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm051-map-heading' },
    title(content.labels.map, 'h2', 'm051-map-heading'),
    paragraph(content.practice.instructions),
    ...areas.map((row, index) => h(Container, {
      key: row.id,
      as: 'article',
      border: 'all',
      padding: 'md',
      gap: 'md',
      'aria-label': row.area.trim() ? row.area : `Area ${index + 1}`,
    },
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
      title(row.area.trim() || content.practice.area, 'h3'),
      h(Button, { variant: 'secondary', disabled: locked, onClick: () => removeArea(row.id) }, content.labels.removeArea)),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
      renderField(row, 'area'),
      renderField(row, 'situation')),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
      renderField(row, 'responsibility'),
      renderField(row, 'condition')),
    renderField(row, 'effect'))),
    h(Button, { variant: 'secondary', disabled: locked, onClick: addArea }, content.labels.addArea),
    h(Container, { gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: 'm051-next' }, content.practice.next),
      h(Textarea, {
        id: 'm051-next',
        rows: 3,
        autoGrow: true,
        maxHeight: 220,
        maxLength: 2000,
        value: practice.values.step ?? '',
        disabled: locked,
        'aria-required': 'true',
        onChange: event => {
          setLocalStatus('');
          practice.setValue('step', event.target.value);
        },
      })),
    h(Button, {
      variant: 'primary',
      disabled: practice.loading || practice.saving,
      onClick: save,
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    localStatus || practice.status ? h(Text, {
      as: 'p', id: 'm051-map-feedback', role: 'status', 'aria-live': 'polite',
    }, localStatus || practice.status) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, title(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm051-example-heading' },
      title(content.labels.example, 'h2', 'm051-example-heading'),
      paragraph(content.examples.context.description)),
    mapSection,
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
