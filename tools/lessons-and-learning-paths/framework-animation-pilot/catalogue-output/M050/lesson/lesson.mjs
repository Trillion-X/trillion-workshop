import React, { useState } from 'react';
import { AnatomyFigure, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { renderProjectComparison } from './lesson-model.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
let nextId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `m050-reason-${++nextId}`;
const blankRow = () => ({ id: newId(), reason: '', kind: 'unmarked', remains: '' });
const validKind = new Set(Object.keys(content.labels.kindOptions));
const cleanRows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => ({
  id: typeof row.id === 'string' && row.id ? row.id : newId(),
  reason: typeof row.reason === 'string' ? row.reason : '',
  kind: validKind.has(row.kind) ? row.kind : 'unmarked',
  remains: typeof row.remains === 'string' ? row.remains : '',
})) : [];
const title = (words, level = 'h2', id) => h(Text, {
  as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
}, words);
const paragraph = words => h(Text, { as: 'p', variant: 'body' }, words);

function Lesson({ surfaceInput, host }) {
  const [rows, setRows] = useState(() => [blankRow()]);
  const [reflection, setReflection] = useState('');
  const [capacity, setCapacity] = useState(false);
  const [outcome, setOutcome] = useState('repair');
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm050-because-of-audit',
    onRestore: record => {
      try {
        const saved = JSON.parse(record.result ?? '');
        if (saved?.version === 1 && Array.isArray(saved.rows)) {
          setRows(cleanRows(saved.rows));
          setReflection(typeof saved.reflection === 'string' ? saved.reflection : '');
        }
      } catch { /* Keep the editable default when an older private record has no audit format. */ }
    },
  });
  const disabled = practice.loading || practice.locked;
  const figure = renderProjectComparison(outcome, content.labels);
  const changeRow = (id, key, value) => {
    practice.markEdited();
    setCapacity(false);
    setRows(current => current.map(row => row.id === id ? { ...row, [key]: value } : row));
  };
  const addRow = () => {
    practice.markEdited();
    setCapacity(false);
    setRows(current => [...current, blankRow()]);
  };
  const removeRow = id => {
    practice.markEdited();
    setCapacity(false);
    setRows(current => current.filter(row => row.id !== id));
  };
  const serialized = () => JSON.stringify({ version: 1, rows: rows.map(({ reason, kind, remains }) => ({ reason, kind, remains })), reflection });
  const save = () => {
    const result = serialized();
    if (result.length > 2000) {
      setCapacity(true);
      return;
    }
    setCapacity(false);
    practice.setValue('result', result);
    void practice.save();
  };
  const renderRow = (row, index) => {
    const base = `m050-${row.id}`;
    const rowName = `${content.labels.reasonNumber} ${index + 1}`;
    return h(Container, { key: row.id, as: 'article', gap: 'sm', padding: 'md', border: 'all', 'aria-label': rowName },
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
        title(rowName, 'h3'),
        h(Button, { variant: 'secondary', disabled, onClick: () => removeRow(row.id) }, content.labels.removeRow)),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: `${base}-reason` }, content.labels.columnReason),
        h(Textarea, { id: `${base}-reason`, rows: 2, autoGrow: true, maxHeight: 180, value: row.reason, disabled,
          onChange: event => changeRow(row.id, 'reason', event.target.value) })),
      h(Container, { as: 'fieldset', gap: 'xs', 'aria-label': content.labels.columnKind },
        h(Text, { as: 'legend', variant: 'body' }, content.labels.columnKind),
        paragraph(content.labels.kindHelp),
        h(Container, { layout: 'vertical', gap: 'xs' },
          ...Object.entries(content.labels.kindOptions).map(([value, label]) => h(Button, {
            key: value, variant: row.kind === value ? 'primary' : 'secondary', 'aria-pressed': row.kind === value,
            disabled, onClick: () => changeRow(row.id, 'kind', value),
          }, label)))),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: `${base}-remains` }, content.labels.columnRemains),
        h(Textarea, { id: `${base}-remains`, rows: 2, autoGrow: true, maxHeight: 180, value: row.remains, disabled,
          onChange: event => changeRow(row.id, 'remains', event.target.value) })));
  };
  const status = capacity ? content.labels.capacity : practice.status;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg', 'aria-labelledby': 'm050-title' },
    h(Container, { as: 'header', gap: 'sm' }, title(content.title, 'h1', 'm050-title'), paragraph(content.opening)),
    h(Container, { as: 'section', gap: 'sm', 'aria-labelledby': 'm050-example-heading' },
      title(content.labels.exampleHeading, 'h2', 'm050-example-heading'), paragraph(content.labels.example),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.outcomeGroup },
        ...[['ready', content.labels.outcomeReady], ['repair', content.labels.outcomeRepair]].map(([key, label]) => h(Button, {
          key, variant: outcome === key ? 'primary' : 'secondary', 'aria-pressed': outcome === key,
          onClick: () => setOutcome(key),
        }, label))),
      h(AnatomyFigure, { figure, label: figure.label, className: 'anatomy-figure--contained' }),
      paragraph(content.labels.outcomeCaptions[outcome]),
      h(Container, { as: 'section', gap: 'xs', 'aria-labelledby': 'm050-proposition-heading' },
        title(content.labels.propositionHeading, 'h3', 'm050-proposition-heading'),
        paragraph(content.labels.proposition),
        paragraph(content.labels.propositionQuestion))),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm050-audit-heading' },
      title(content.labels.tableHeading, 'h2', 'm050-audit-heading'),
      rows.length ? rows.map(renderRow) : paragraph(content.labels.empty),
      h(Button, { variant: 'secondary', disabled, onClick: addRow }, content.labels.addRow),
      h(Container, { gap: 'xs' },
        title(content.labels.noticeHeading, 'h3'), paragraph(content.labels.notice),
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm050-reflection' }, content.labels.reflectionLabel),
        h(Textarea, { id: 'm050-reflection', rows: 2, autoGrow: true, maxHeight: 180, value: reflection, disabled,
          onChange: event => { practice.markEdited(); setCapacity(false); setReflection(event.target.value); } })),
      paragraph(content.labels.capacityNote),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
        h(Button, { variant: 'primary', disabled: disabled || practice.saving, onClick: save }, content.labels.save),
        [content.feedback.saveFailure, content.feedback.readbackFailure, content.feedback.retryPending].includes(practice.status)
          ? h(Button, { variant: 'secondary', disabled: practice.loading || practice.saving, onClick: () => void practice.save() }, content.labels.retry) : null,
        status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, status) : null)),
    paragraph(content.labels.stopBoundary));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
