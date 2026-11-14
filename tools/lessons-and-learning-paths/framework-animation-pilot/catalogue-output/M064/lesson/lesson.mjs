import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
let nextId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `m064-chapter-${++nextId}`;
const blankChapter = () => ({ id: newId(), name: '', period: '', mattered: '', change: '', pattern: '' });
const cleanChapters = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => ({
  id: typeof row.id === 'string' && row.id ? row.id : newId(),
  name: typeof row.name === 'string' ? row.name : '',
  period: typeof row.period === 'string' ? row.period : '',
  mattered: typeof row.mattered === 'string' ? row.mattered : '',
  change: typeof row.change === 'string' ? row.change : '',
  pattern: typeof row.pattern === 'string' ? row.pattern : '',
})) : [];
const title = (words, level = 'h2', id) => h(Text, {
  as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
}, words);
const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);
const field = (id, label, value, disabled, onChange) => h(Container, { key: id, gap: 'xs' },
  h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
  h(Textarea, { id, rows: 2, autoGrow: true, maxHeight: 180, value, disabled, onChange }));

function Lesson({ surfaceInput, host }) {
  const [chapters, setChapters] = useState(() => [blankChapter()]);
  const [capacity, setCapacity] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm064-life-journey-documentation',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.result ?? '');
        if (saved?.version === 1 && Array.isArray(saved.chapters)) setChapters(cleanChapters(saved.chapters));
      } catch { /* Keep the editable opening chapter when no M064 record has been saved. */ }
    },
  });
  const disabled = practice.loading || practice.locked;
  const edit = (id, key, value) => {
    practice.markEdited();
    setCapacity(false);
    setChapters(current => current.map(chapter => chapter.id === id ? { ...chapter, [key]: value } : chapter));
  };
  const add = () => { practice.markEdited(); setCapacity(false); setChapters(current => [...current, blankChapter()]); };
  const remove = id => { practice.markEdited(); setCapacity(false); setChapters(current => current.filter(chapter => chapter.id !== id)); };
  const move = (index, offset) => {
    practice.markEdited();
    setCapacity(false);
    setChapters(current => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };
  const serialized = () => JSON.stringify({ version: 1, chapters: chapters.map(({ name, period, mattered, change, pattern }) => ({ name, period, mattered, change, pattern })) });
  const save = () => {
    const result = serialized();
    if (result.length > 2000) { setCapacity(true); return; }
    setCapacity(false);
    practice.setValue('result', result);
    void practice.save();
  };
  const renderChapter = (chapter, index) => {
    const base = `m064-${chapter.id}`;
    const changeField = (key, value) => event => edit(chapter.id, key, event.target.value);
    return h(Container, { key: chapter.id, as: 'article', gap: 'sm', padding: 'md', border: 'all', 'aria-label': `${content.labels.chapterNumber} ${index + 1}` },
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
        title(`${content.labels.chapterNumber} ${index + 1}`, 'h3'),
        h(Button, { variant: 'secondary', disabled: disabled || index === 0, onClick: () => move(index, -1) }, content.labels.moveEarlier),
        h(Button, { variant: 'secondary', disabled: disabled || index === chapters.length - 1, onClick: () => move(index, 1) }, content.labels.moveLater),
        h(Button, { variant: 'secondary', disabled, onClick: () => remove(chapter.id) }, content.labels.removeChapter)),
      field(`${base}-name`, content.labels.chapterName, chapter.name, disabled, changeField('name')),
      field(`${base}-period`, content.labels.chapterWhen, chapter.period, disabled, changeField('period')),
      field(`${base}-mattered`, content.labels.chapterMattered, chapter.mattered, disabled, changeField('mattered')),
      field(`${base}-change`, content.labels.chapterChange, chapter.change, disabled, changeField('change')),
      field(`${base}-pattern`, content.labels.chapterPattern, chapter.pattern, disabled, changeField('pattern')));
  };
  const status = capacity ? content.labels.capacity : practice.status;
  const retryable = [content.feedback.saveFailure, content.feedback.readbackFailure, content.feedback.retryPending].includes(practice.status);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg', 'aria-labelledby': 'm064-title' },
    h(Container, { as: 'header', gap: 'sm' }, title(content.title, 'h1', 'm064-title'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm064-example-heading' },
      title(content.labels.exampleHeading, 'h2', 'm064-example-heading'), paragraph(content.labels.exampleIntro),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
        h(Container, { as: 'article', gap: 'xs', padding: 'md', border: 'all' },
          title(content.labels.exampleFirstTitle, 'h3'), paragraph(content.labels.exampleFirstWhen), paragraph(content.labels.exampleFirstDetails)),
        h(Container, { as: 'article', gap: 'xs', padding: 'md', border: 'all' },
          title(content.labels.exampleLaterTitle, 'h3'), paragraph(content.labels.exampleLaterWhen), paragraph(content.labels.exampleLaterDetails))),
      paragraph(content.labels.exampleCompare)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm064-chapters-heading' },
      title(content.labels.chaptersHeading, 'h2', 'm064-chapters-heading'),
      chapters.length ? chapters.map(renderChapter) : paragraph(content.labels.empty),
      h(Button, { variant: 'secondary', disabled, onClick: add }, content.labels.addChapter),
      paragraph(content.labels.privacy),
      paragraph(content.labels.capacityNote),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
        h(Button, { variant: 'primary', disabled: disabled || practice.saving, onClick: save }, content.labels.save),
        retryable ? h(Button, { variant: 'secondary', disabled: practice.loading || practice.saving, onClick: () => void practice.save() }, content.labels.retry) : null,
        status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, status) : null)),
    paragraph(content.labels.stopBoundary));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
