import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = content.fields.map(row => row.id);
const blankDraft = () => Object.fromEntries(fields.map(key => [key, '']));
const parseRecord = value => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return null; }
};

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blankDraft);
  const [selectedTarget, setSelectedTarget] = useState('tutorial');
  const tooLong = JSON.stringify(draft).length > 2000;
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm110-skill-resonance-recognition',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (!restored) return;
      setDraft(restored);
    },
  });
  const unavailable = practice.loading || practice.locked;
  const serialize = value => JSON.stringify(value);
  const tooLongMessageId = 'm110-practice-length-error';
  const longestKey = fields.reduce((best, key) => draft[key].length > draft[best].length ? key : best, fields[0]);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const edit = (key, value) => {
    const next = { ...draft, [key]: value };
    const result = serialize(next);
    setDraft(next);
    setMissing(false);
    practice.markEdited();
    practice.setValue('result', result);
  };
  const field = ({ id, label, rows = 2 }) => h(Container, { gap: 'xs' },
    h(Textarea, {
      id: `m110-${id}`,
      label,
      rows,
      autoGrow: true,
      maxHeight: rows > 2 ? 240 : 180,
      value: draft[id],
      disabled: unavailable,
      'aria-invalid': tooLong && id === longestKey ? 'true' : undefined,
      'aria-describedby': tooLong && id === longestKey ? tooLongMessageId : undefined,
      onChange: event => edit(id, event.currentTarget.value),
    }),
    tooLong && id === longestKey ? h(Text, { as: 'p', id: tooLongMessageId, role: 'alert' }, content.labels.oversize) : null);
  const targetPrompt = selectedTarget === 'tutorial'
    ? content.labels.tutorialPrompt
    : selectedTarget === 'security' ? content.labels.securityPrompt : content.labels.unknownPrompt;
  const hasAny = fields.some(key => draft[key].trim().length > 0);
  const save = () => {
    if (!hasAny) { setMissing(true); return; }
    if (tooLong) return;
    practice.setValue('result', serialize(draft));
    return practice.save();
  };
  const sourceDisclosure = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt));

  return h(Container, {
    as: 'main',
    maxWidth: '4xl',
    marginX: 'auto',
    width: 'full',
    padding: 'lg',
    gap: 'lg',
  },
  h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm110-comparison-heading' },
    heading(content.labels.comparison, 'h2', 'm110-comparison-heading'),
    p(content.labels.comparisonIntro),
    p(content.labels.pair),
    h(Container, { layout: 'responsive-split', gap: 'md', alignItems: 'stretch' },
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm110-tutorial-heading' },
        heading(content.labels.tutorialTitle, 'h3', 'm110-tutorial-heading'),
        p(content.labels.tutorialTransfer),
        p(content.labels.tutorialBoundary)),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm110-security-heading' },
        heading(content.labels.securityTitle, 'h3', 'm110-security-heading'),
        p(content.labels.securityTransfer),
        p(content.labels.securityBoundary))),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm110-target-heading' },
      heading(content.labels.targetPrompt, 'h3', 'm110-target-heading'),
      h(Container, { role: 'group', 'aria-label': content.labels.targetPrompt, layout: 'vertical', gap: 'sm' },
        h(Button, { variant: selectedTarget === 'tutorial' ? 'primary' : 'secondary', 'aria-pressed': selectedTarget === 'tutorial', onClick: () => setSelectedTarget('tutorial') }, content.labels.tutorialFact),
        h(Button, { variant: selectedTarget === 'security' ? 'primary' : 'secondary', 'aria-pressed': selectedTarget === 'security', onClick: () => setSelectedTarget('security') }, content.labels.securityFact),
        h(Button, { variant: selectedTarget === 'unknown' ? 'primary' : 'secondary', 'aria-pressed': selectedTarget === 'unknown', onClick: () => setSelectedTarget('unknown') }, content.labels.unknownFact)),
      p(targetPrompt, { role: 'status', 'aria-live': 'polite' }))),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm110-practice-heading' },
    heading(content.labels.practiceTitle, 'h2', 'm110-practice-heading'),
    p(content.labels.practiceIntro),
    field({ id: 'skill', label: content.fields[0].label }),
    field({ id: 'pattern', label: content.fields[1].label }),
    field({ id: 'combination', label: content.fields[2].label }),
    field({ id: 'opportunity', label: content.fields[3].label }),
    field({ id: 'boundary', label: content.fields[4].label }),
    field({ id: 'check', label: content.fields[5].label }),
    field({ id: 'revision', label: content.fields[6].label, rows: 3 }),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm110-private-heading' },
      heading('Private practice', 'h3', 'm110-private-heading'),
      p(content.labels.private),
      missing ? h(Text, { as: 'p', id: 'm110-practice-missing', role: 'alert' }, content.labels.needAnswer) : null,
      h(Button, {
        variant: 'primary', fullWidth: true,
        work: practice.saving ? 'pending' : practice.status === content.feedback.saved ? 'done' : practice.locked ? 'error' : null,
        disabled: practice.loading || practice.saving || tooLong,
        pendingLabel: content.labels.busy,
        errorLabel: content.labels.retry,
        onClick: save,
      }, practice.locked ? content.labels.retry : practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? p(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
  sourceDisclosure);
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
