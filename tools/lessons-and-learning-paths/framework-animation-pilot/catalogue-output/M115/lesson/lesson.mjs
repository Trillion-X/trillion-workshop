import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

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
  const [size, setSize] = useState('four');
  const [arrangement, setArrangement] = useState('scaffold');
  const [time, setTime] = useState('long');
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm115-engagement-scaffolding',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (!restored) return;
      setDraft(restored);
    },
  });
  const unavailable = practice.loading || practice.locked;
  const serialize = value => JSON.stringify(value);
  const tooLong = serialize(draft).length > 2000;
  const buttonWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const tooLongMessageId = 'm115-practice-length-error';
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
      id: `m115-${id}`,
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
  const choice = (label, selected, onClick) => h(Button, {
    variant: 'secondary',
    active: selected,
    'aria-pressed': selected,
    onClick,
  }, label);
  const result = arrangement === 'lecture'
    ? size === 'four' ? content.labels.lectureResultFour : content.labels.lectureResultTwentyFour
    : size === 'four'
      ? content.labels.scaffoldResultFour
      : time === 'long' ? content.labels.longResult : content.labels.shortResult;
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
    as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg',
  },
  h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm115-session-heading' },
    heading(content.labels.comparisonTitle, 'h2', 'm115-session-heading'),
    p(content.labels.comparisonIntro),
    h(Container, { border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'p', variant: 'heading-md' }, content.labels.scale),
      h(Container, { role: 'group', 'aria-label': content.labels.scale, layout: 'responsive-split', gap: 'sm' },
        choice(content.labels.scaleFour, size === 'four', () => setSize('four')),
        choice(content.labels.scaleTwentyFour, size === 'twentyFour', () => setSize('twentyFour'))),
      h(Text, { as: 'p', variant: 'heading-md' }, content.labels.arrangement),
      h(Container, { role: 'group', 'aria-label': content.labels.arrangement, layout: 'responsive-split', gap: 'sm' },
        choice(content.labels.lectureOption, arrangement === 'lecture', () => setArrangement('lecture')),
        choice(content.labels.scaffoldOption, arrangement === 'scaffold', () => setArrangement('scaffold'))),
      arrangement === 'scaffold' && size === 'twentyFour' ? h(Container, { gap: 'sm' },
        p(content.labels.adjustPrompt),
        h(Container, { role: 'group', 'aria-label': content.labels.meetingLength, layout: 'responsive-split', gap: 'sm' },
          choice(content.labels.lengthShort, time === 'short', () => setTime('short')),
          choice(content.labels.lengthLong, time === 'long', () => setTime('long')))) : null,
      p(result, { role: 'status', 'aria-live': 'polite' }))),
  h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm115-practice-heading' },
    heading(content.labels.practiceTitle, 'h2', 'm115-practice-heading'),
    p(content.labels.practiceIntro),
    field({ id: 'feature', label: content.fields[0].label }),
    field({ id: 'growth', label: content.fields[1].label }),
    field({ id: 'time', label: content.fields[2].label }),
    field({ id: 'support', label: content.fields[3].label }),
    field({ id: 'check', label: content.fields[4].label }),
    field({ id: 'revision', label: content.fields[5].label, rows: 3 }),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm115-private-heading' },
      heading('Private practice', 'h3', 'm115-private-heading'),
      p(content.labels.private),
      missing ? h(Text, { as: 'p', id: 'm115-practice-missing', role: 'alert' }, content.labels.needAnswer) : null,
      h(Button, {
        variant: 'primary', fullWidth: true,
        work: buttonWork,
        disabled: practice.loading || practice.saving || tooLong,
        pendingLabel: content.labels.busy,
        errorLabel: practice.locked ? content.labels.retry : content.labels.save,
        onClick: save,
      }, practice.locked ? content.labels.retry : practice.saving ? content.labels.busy : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? p(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)),
  sourceDisclosure);
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
