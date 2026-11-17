import React, { useMemo, useRef, useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const PRACTICE_FIELD = 'result';
const PRACTICE_LIMIT = 2000;
const initialObservations = () => [{ id: 'E1', source: '', text: '' }];
const initialReview = () => ({ id: 'T1', theme: '', references: '', support: '', alternatives: '', conflicts: '', newContext: '' });
const text = value => typeof value === 'string' ? value : '';
const normalizeObservations = value => Array.isArray(value) && value.length
  ? value.filter(row => row && typeof row.id === 'string').map(row => ({ id: row.id, source: text(row.source), text: text(row.text) }))
  : initialObservations();
const normalizeReviews = value => Array.isArray(value) && value.length
  ? value.filter(row => row && typeof row.id === 'string').map(row => ({
    ...initialReview(), ...row,
    theme: text(row.theme), references: text(row.references), support: text(row.support),
    alternatives: text(row.alternatives), conflicts: text(row.conflicts), newContext: text(row.newContext),
  }))
  : [initialReview()];

function restoreRecord(value) {
  try {
    const saved = typeof value === 'string' ? JSON.parse(value) : value;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return {
      observations: normalizeObservations(saved.observations),
      response: text(saved.response),
      preferredConclusion: text(saved.preferredConclusion),
      reviews: normalizeReviews(saved.reviews),
    };
  } catch { /* Keep an older text result visible for copying and review. */ }
  return { observations: initialObservations(), response: typeof value === 'string' ? value : '', preferredConclusion: '', reviews: [initialReview()] };
}

function recordValue({ observations, response, preferredConclusion, reviews }) {
  return JSON.stringify({ observations, response, preferredConclusion, reviews });
}

function Lesson({ surfaceInput, host }) {
  const nextObservation = useRef(1);
  const nextReview = useRef(1);
  const [observations, setObservations] = useState(initialObservations);
  const [response, setResponse] = useState('');
  const [preferredConclusion, setPreferredConclusion] = useState('');
  const [reviews, setReviews] = useState([initialReview()]);
  const [copyStatus, setCopyStatus] = useState('');
  const [draftStatus, setDraftStatus] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields: [PRACTICE_FIELD], messages: content.feedback,
    requestPrefix: 'm067-pattern-review',
    onRestore: record => {
      const restored = restoreRecord(record.result);
      setObservations(restored.observations);
      setResponse(restored.response);
      setPreferredConclusion(restored.preferredConclusion);
      setReviews(restored.reviews);
      nextObservation.current = restored.observations.reduce((max, row) => Math.max(max, Number(/^E(\d+)$/.exec(row.id)?.[1] ?? 0)), 1);
      nextReview.current = restored.reviews.reduce((max, row) => Math.max(max, Number(/^T(\d+)$/.exec(row.id)?.[1] ?? 0)), 1);
    },
  });
  const locked = practice.loading || practice.locked;
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const label = (words, id) => h(Text, { as: 'label', variant: 'body', htmlFor: id }, words);
  const observationIds = useMemo(() => new Set(observations.map(row => row.id.toUpperCase())), [observations]);
  const prompt = useMemo(() => content.promptTemplate.replace('{observations}', observations
    .filter(row => row.text.trim() || row.source.trim())
    .map(row => `[${row.id}] ${row.text}${row.source ? ` (source: ${row.source})` : ''}`)
    .join('\n')), [observations]);
  const value = recordValue({ observations, response, preferredConclusion, reviews });
  const withinLimit = value.length <= PRACTICE_LIMIT;
  const persist = next => {
    const serialized = recordValue(next);
    if (serialized.length > PRACTICE_LIMIT) {
      setDraftStatus(content.labels.overflow);
      return false;
    }
    practice.setValue(PRACTICE_FIELD, serialized);
    setDraftStatus('');
    return true;
  };
  const update = (key, nextValue) => {
    if (locked) return;
    practice.markEdited();
    const next = { observations, response, preferredConclusion, reviews, [key]: nextValue };
    if (key === 'observations') setObservations(nextValue);
    if (key === 'response') setResponse(nextValue);
    if (key === 'preferredConclusion') setPreferredConclusion(nextValue);
    if (key === 'reviews') setReviews(nextValue);
    persist(next);
  };
  const editObservation = (id, key, nextValue) => update('observations', observations.map(row => row.id === id ? { ...row, [key]: nextValue } : row));
  const addObservation = () => {
    if (locked) return;
    const next = nextObservation.current + 1;
    nextObservation.current = next;
    update('observations', [...observations, { id: `E${next}`, source: '', text: '' }]);
  };
  const removeObservation = id => {
    if (!locked && observations.length > 1) update('observations', observations.filter(row => row.id !== id));
  };
  const editReview = (id, key, nextValue) => update('reviews', reviews.map(row => row.id === id ? { ...row, [key]: nextValue } : row));
  const addReview = () => {
    if (locked) return;
    const next = nextReview.current + 1;
    nextReview.current = next;
    update('reviews', [...reviews, { ...initialReview(), id: `T${next}` }]);
  };
  const removeReview = id => {
    if (!locked && reviews.length > 1) update('reviews', reviews.filter(row => row.id !== id));
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus(content.labels.copied);
    } catch {
      setCopyStatus(content.labels.copyFailed);
    }
  };
  const observationInputs = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm067-observations-heading' },
    heading(content.labels.observations, 'h2', 'm067-observations-heading'),
    p(content.labels.observationHelp),
    h(Container, { gap: 'md' }, ...observations.map(row => h(Container, { key: row.id, border: 'all', padding: 'md', gap: 'sm', 'aria-label': `Observation ${row.id}` },
      heading(row.id, 'h3', `m067-${row.id}-heading`),
      h(Container, { gap: 'xs' }, label(content.labels.observationSource, `m067-${row.id}-source`), h(Textarea, {
        id: `m067-${row.id}-source`, rows: 2, autoGrow: true, maxHeight: 120, value: row.source, disabled: locked,
        onChange: event => editObservation(row.id, 'source', event.target.value),
      })),
      h(Container, { gap: 'xs' }, label(content.labels.observationText, `m067-${row.id}-text`), h(Textarea, {
        id: `m067-${row.id}-text`, rows: 3, autoGrow: true, maxHeight: 220, value: row.text, disabled: locked,
        onChange: event => editObservation(row.id, 'text', event.target.value),
      })),
      observations.length > 1 ? h(Button, { variant: 'secondary', disabled: locked, onClick: () => removeObservation(row.id) }, `${content.labels.removeObservation} ${row.id}`) : null))),
    h(Button, { variant: 'secondary', disabled: locked, onClick: addObservation }, content.labels.addObservation));
  const promptSection = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm067-prompt-heading' },
    heading(content.labels.prompt, 'h2', 'm067-prompt-heading'),
    p(content.labels.promptBoundary),
    p(observations.some(row => row.text.trim()) ? 'The prompt contains only the observations above. Your preferred conclusion is kept out.' : content.labels.emptyObservations),
    h(Textarea, { id: 'm067-prompt', label: content.labels.prompt, rows: 9, autoGrow: true, maxHeight: 480, value: prompt, readOnly: true }),
    h(Button, { variant: 'secondary', disabled: locked || !observations.some(row => row.text.trim()), onClick: copyPrompt }, content.labels.copyPrompt),
    copyStatus ? p(copyStatus, { role: 'status', 'aria-live': 'polite' }) : null);
  const responseSection = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm067-response-heading' },
    heading(content.labels.response, 'h2', 'm067-response-heading'),
    p(content.labels.responseHelp),
    h(Textarea, { id: 'm067-response', label: content.labels.response, rows: 8, autoGrow: true, maxHeight: 520, value: response, disabled: locked,
      onChange: event => update('response', event.target.value) }),
    h(Container, { gap: 'xs' }, label(content.labels.preferredConclusion, 'm067-preferred-conclusion'),
      p(content.labels.preferredConclusionHelp),
      h(Textarea, { id: 'm067-preferred-conclusion', rows: 2, autoGrow: true, maxHeight: 180, value: preferredConclusion, disabled: locked,
        onChange: event => update('preferredConclusion', event.target.value) })));
  const observationCards = h(Container, { gap: 'sm', 'aria-label': content.labels.observations }, ...observations.map(row => h(Container, {
    key: `source-${row.id}`, border: 'all', padding: 'sm', gap: 'xs',
  }, heading(row.id, 'h3'), row.source ? p(`Source: ${row.source}`) : null, p(row.text || 'No example text entered yet.'))));
  const themeReviews = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm067-themes-heading' },
    heading(content.labels.themes, 'h2', 'm067-themes-heading'),
    p(content.labels.citationCheckLimit),
    observationCards,
    h(Container, { gap: 'md' }, ...reviews.map(row => {
      const ids = [...new Set((row.references.match(/\bE\d+\b/gi) ?? []).map(id => id.toUpperCase()))];
      const missing = ids.filter(id => !observationIds.has(id));
      const referenceMessage = ids.length === 0 ? 'Add the observation IDs cited for this theme.' : missing.length
        ? `Not found in your observations: ${missing.join(', ')}.`
        : `IDs found in your observations: ${ids.join(', ')}. Reopen each cited source to check its passage and context.`;
      const input = (key, labelText, rows = 2) => {
        const id = `m067-${row.id}-${key}`;
        return h(Container, { gap: 'xs' }, label(labelText, id), h(Textarea, {
          id, rows, autoGrow: true, maxHeight: rows > 3 ? 300 : 180, value: row[key], disabled: locked,
          onChange: event => editReview(row.id, key, event.target.value),
        }));
      };
      return h(Container, { key: row.id, border: 'all', padding: 'md', gap: 'sm', 'aria-label': `${content.labels.themeName} ${row.id}` },
        heading(row.id, 'h3'),
        input('theme', content.labels.themeName),
        input('references', content.labels.themeRefs),
        p(referenceMessage, { role: missing.length ? 'alert' : 'status' }),
        input('support', content.labels.themeSupport, 3),
        input('alternatives', content.labels.alternatives, 3),
        input('conflicts', content.labels.conflicts, 3),
        input('newContext', content.labels.newContext, 3),
        reviews.length > 1 ? h(Button, { variant: 'secondary', disabled: locked, onClick: () => removeReview(row.id) }, `${content.labels.removeTheme} ${row.id}`) : null);
    })),
    h(Button, { variant: 'secondary', disabled: locked, onClick: addReview }, content.labels.addTheme));
  const worked = content.teaching.walkthrough;
  const walkthrough = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm067-walkthrough-heading' },
    heading(content.labels.walkthrough, 'h2', 'm067-walkthrough-heading'),
    p(content.labels.walkthroughBoundary),
    p(worked.sourceExcerpt),
    h(Container, { gap: 'sm' }, ...worked.references.map(row => h(Container, { key: row.id, border: 'all', padding: 'sm', gap: 'xs' },
      heading(row.id, 'h3'), p(`Check here: ${row.source}`), p(row.text)))),
    h(Container, { gap: 'xs' }, heading('Candidate theme', 'h3'), p(worked.theme), p(worked.support)),
    h(Container, { gap: 'xs' }, heading('Competing explanation', 'h3'), p(worked.competing)),
    h(Container, { gap: 'xs' }, heading('Countercase', 'h3'), p(worked.conflict)),
    h(Container, { gap: 'xs' }, heading('Try a new context', 'h3'), p(worked.newContext)));
  const sourceNote = h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm067-source-heading' },
    heading('Source note', 'h2', 'm067-source-heading'),
    p(content.teaching.sourceSummary),
    p('Manuscript locator: p. 40.'));
  const status = practice.status ? p(practice.status, { role: 'status', 'aria-live': 'polite' }) : null;
  const privateSave = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm067-private-heading' },
    heading(content.labels.privateRecord, 'h2', 'm067-private-heading'),
    p(content.labels.saveLimit),
    draftStatus ? h(Text, { as: 'p', role: 'alert', 'aria-live': 'polite' }, draftStatus) : null,
    h(Button, { variant: 'primary', disabled: practice.loading || practice.saving || !observations.some(row => row.text.trim()) || !withinLimit,
      onClick: () => practice.save({ transfer: JSON.stringify({ reviewCount: reviews.length }) }),
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    status,
    practice.locked ? p(content.feedback.retryPending) : null);
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    observationInputs,
    promptSection,
    responseSection,
    themeReviews,
    walkthrough,
    sourceNote,
    privateSave);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
