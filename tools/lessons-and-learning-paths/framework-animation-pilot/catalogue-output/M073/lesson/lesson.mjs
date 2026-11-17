import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['value', 'behavior', 'posture', 'environment', 'speaking', 'actual', 'decision'];
const blank = () => Object.fromEntries(fields.map(key => [key, '']));
const restore = result => {
  if (typeof result !== 'string') return blank();
  try {
    const parsed = JSON.parse(result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return blank();
    return Object.fromEntries(fields.map(key => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
  } catch { return blank(); }
};

function Lesson({ surfaceInput, host }) {
  const [draft, setDraft] = useState(blank);
  const [overLimit, setOverLimit] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm073-value-embodiment',
    onRestore: record => setDraft(restore(record.result)),
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const field = (key, label, rows = 2) => {
    const id = `m073-${key}`;
    const errorId = 'm073-practice-length-error';
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
      h(Textarea, {
        id, rows, autoGrow: true, maxHeight: rows > 2 ? 220 : 160,
        value: draft[key], disabled,
        'aria-invalid': overLimit ? 'true' : undefined,
        'aria-describedby': overLimit ? errorId : undefined,
        onChange: event => {
          const next = { ...draft, [key]: event.target.value };
          const result = JSON.stringify(next);
          setDraft(next);
          setOverLimit(result.length > 2000);
          practice.markEdited();
          if (result.length <= 2000) practice.setValue('result', result);
        },
      }));
  };
  const encoded = JSON.stringify(draft);
  const complete = draft.value.trim() && draft.behavior.trim() && draft.actual.trim() && draft.decision.trim();
  const canSave = Boolean(complete) && encoded.length <= 2000 && !practice.loading && !practice.saving;
  const example = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm073-example-heading' },
    heading(content.example.title, 'h2', 'm073-example-heading'),
    paragraph(content.example.context),
    h(Container, { as: 'ul', gap: 'sm' },
      h(Container, { as: 'li', gap: 'xs' }, paragraph(content.example.posture)),
      h(Container, { as: 'li', gap: 'xs' }, paragraph(content.example.environment)),
      h(Container, { as: 'li', gap: 'xs' }, paragraph(content.example.speaking))),
    paragraph(content.example.distinction),
    paragraph(content.example.lesson));
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    paragraph(content.labels.sourceExcerpt));
  const save = h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm073-save-heading' },
    heading('Private practice', 'h2', 'm073-save-heading'),
    paragraph(content.labels.private),
    overLimit ? paragraph(content.labels.oversize, { id: 'm073-practice-length-error', role: 'alert' }) : null,
    practice.loading ? paragraph('Loading saved practice.', { role: 'status', 'aria-live': 'polite' }) : null,
    disabled && !practice.loading ? paragraph(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', disabled: !canSave,
      onClick: () => practice.save(),
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? paragraph(practice.status, { role: 'status', 'aria-live': 'polite' }) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    example,
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm073-practice-heading' },
      heading(content.labels.practiceTitle, 'h2', 'm073-practice-heading'),
      paragraph(content.labels.comparison + '. Hold the intended action steady; compare one possible cue of each type, then test only a relevant cue.'),
      field('value', content.labels.value),
      field('behavior', content.labels.behavior),
      field('posture', content.labels.postureTest),
      field('environment', content.labels.environmentTest),
      field('speaking', content.labels.speakingTest),
      field('actual', content.labels.actual, 3),
      field('decision', content.labels.decision, 3)),
    save,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
