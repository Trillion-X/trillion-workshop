import React, { useState } from 'react';
import { Button, Container, DragReorderList, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const keys = ['event', 'meaning', 'observed', 'pending', 'value', 'connection', 'earlier', 'next'];
const blankEntry = () => ({ id: globalThis.crypto?.randomUUID?.() ?? `entry-${Date.now()}-${Math.random()}`, connectionStatus: 'possible', ...Object.fromEntries(keys.map(key => [key, ''])) });
const blank = () => ({ entries: [blankEntry()] });
const restore = raw => {
  try {
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.entries)) return blank();
    return { entries: value.entries.filter(row => row && typeof row === 'object').map(row => ({ ...blankEntry(), ...row, id: String(row.id ?? blankEntry().id), connectionStatus: row.connectionStatus === 'none' ? 'none' : 'possible', ...Object.fromEntries(keys.map(key => [key, typeof row[key] === 'string' ? row[key] : ''])) })) };
  } catch { return blank(); }
};

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blank);
  const [overLimit, setOverLimit] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields: ['result'], messages: content.feedback, requestPrefix: 'm081-suffering-reframe-log', onRestore: record => setDraft(restore(record.result)) });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = (id, key, value) => {
    const next = { ...draft, entries: draft.entries.map(entry => entry.id === id ? { ...entry, [key]: value } : entry) };
    const encoded = JSON.stringify(next);
    setDraft(next);
    setOverLimit(encoded.length > 2000);
    practice.markEdited();
    if (encoded.length <= 2000) practice.setValue('result', encoded);
  };
  const encoded = JSON.stringify(draft);
  const row = entry => h(Container, { key: entry.id, as: 'article', border: 'all', padding: 'md', gap: 'sm' },
    heading(`Entry ${draft.entries.indexOf(entry) + 1}`, 'h3'),
    ...keys.map(key => {
      const id = `m081-${entry.id}-${key}`;
      const label = content.labels[key];
      const errorId = `${id}-error`;
      const prompt = key === 'connection' ? 'Describe the concrete link between this event and the value. Do not infer a benefit that the facts do not support.' : key === 'observed' ? 'What did you directly see, hear, or otherwise observe? Keep this field factual.' : key === 'pending' ? 'What remains unknown, or still needs more evidence?' : key === 'next' ? 'Record any practical change, repair, or boundary that is still needed.' : key === 'earlier' ? content.labels.earlierPrompt : undefined;
      return h(Container, { key, gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
        prompt ? paragraph(prompt, { id: `${id}-prompt` }) : null,
        h(Textarea, { id, rows: key === 'event' || key === 'value' ? 2 : 3, autoGrow: true, maxHeight: 220, value: entry[key], disabled, 'aria-invalid': overLimit ? 'true' : undefined, 'aria-describedby': [prompt ? `${id}-prompt` : null, overLimit ? 'm081-practice-length-error' : null].filter(Boolean).join(' ') || undefined, onChange: event => update(entry.id, key, event.target.value) }));
    }),
    h(Container, { gap: 'xs', role: 'group', 'aria-label': `Connection status for entry ${draft.entries.indexOf(entry) + 1}` },
      paragraph('Is a useful connection established?'),
      h(Container, { gap: 'sm' },
        h(Button, { variant: entry.connectionStatus === 'possible' ? 'primary' : 'secondary', disabled, 'aria-pressed': entry.connectionStatus === 'possible', onClick: () => update(entry.id, 'connectionStatus', 'possible') }, content.labels.possible),
        h(Button, { variant: entry.connectionStatus === 'none' ? 'primary' : 'secondary', disabled, 'aria-pressed': entry.connectionStatus === 'none', onClick: () => update(entry.id, 'connectionStatus', 'none') }, content.labels.none))),
    h(Button, { variant: 'secondary', disabled: disabled || draft.entries.length < 2, onClick: () => setDraft(current => { const entries = [...current.entries]; const index = entries.findIndex(item => item.id === entry.id); if (index > 0) [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]]; const next = { ...current, entries }; const value = JSON.stringify(next); if (value.length <= 2000) practice.setValue('result', value); practice.markEdited(); return next; }) }, `Move entry ${draft.entries.indexOf(entry) + 1} up`),
    h(Button, { variant: 'secondary', disabled: disabled || draft.entries.length < 2, onClick: () => { const entries = draft.entries.filter(item => item.id !== entry.id); const next = { ...draft, entries }; setDraft(next); practice.setValue('result', JSON.stringify(next)); practice.markEdited(); } }, content.labels.remove));
  const add = () => { const next = { ...draft, entries: [...draft.entries, blankEntry()] }; const value = JSON.stringify(next); setDraft(next); setOverLimit(value.length > 2000); practice.markEdited(); if (value.length <= 2000) practice.setValue('result', value); };
  const reorder = ids => { const rows = new Map(draft.entries.map(entry => [entry.id, entry])); const next = { entries: ids.map(id => rows.get(id)).filter(Boolean) }; const value = JSON.stringify(next); setDraft(next); setOverLimit(value.length > 2000); if (value.length <= 2000) practice.setValue('result', value); practice.markEdited(); };
  const save = () => { if (!draft.entries.length) return; const value = JSON.stringify(draft); if (value.length <= 2000) practice.setValue('result', value); practice.save(); };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm081-example-heading' }, heading(content.example.title, 'h2', 'm081-example-heading'), paragraph(content.example.body)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm081-log-heading' },
      heading(content.labels.logTitle, 'h2', 'm081-log-heading'),
      paragraph('Keep each entry specific. A fact can support a useful connection, leave it uncertain, or show that an arrangement should change.'),
      h(DragReorderList, { items: draft.entries.map(entry => ({ id: entry.id, label: `Entry ${draft.entries.indexOf(entry) + 1}`, content: row(entry) })), onReorder: reorder, surface: 'grouped', handleAlign: 'start' }),
      h(Button, { variant: 'secondary', disabled, onClick: add }, content.labels.add)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm081-private-heading' },
      heading('Private practice', 'h2', 'm081-private-heading'), paragraph(content.labels.private),
      overLimit ? paragraph(content.labels.oversize, { id: 'm081-practice-length-error', role: 'alert' }) : null,
      practice.loading ? paragraph('Loading saved log.', { role: 'status', 'aria-live': 'polite' }) : null,
      disabled && !practice.loading ? paragraph(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null,
      h(Button, { variant: 'primary', disabled: practice.loading || practice.saving || overLimit || draft.entries.length === 0, onClick: save }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !overLimit ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' }, h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle), paragraph(content.labels.sourceExcerpt)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
