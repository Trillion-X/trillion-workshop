import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const initialCase = content.cases[0].id;
const cellSize = 44;

function Lesson({ surfaceInput, host }) {
  const [selectedCase, setSelectedCase] = useState(initialCase);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm026-deliberate-practice' });
  const example = content.cases.find(item => item.id === selectedCase);
  const paragraph = words => words ? h(Text, { as: 'p' }, words) : null;
  const tileCount = example.rows * example.columns;
  const rectangle = h(Container, {
    as: 'ol', layout: 'grid', gridColumns: example.columns, width: `${example.columns * cellSize}px`, gap: 'none', role: 'list',
    'aria-label': `${example.rows} rows by ${example.columns} columns. ${example.countedUnits} square units counted in this attempt out of ${tileCount}.`,
  }, ...Array.from({ length: tileCount }, (_, index) => {
    const row = Math.floor(index / example.columns);
    const column = index % example.columns;
    const counted = selectedCase === 'repeat-error' ? row < 3 && column < 3 : index < example.countedUnits;
    const itemName = selectedCase === 'repeat-error'
      ? counted ? 'Square unit included in the mistaken 3 by 3 count' : 'Square unit left out of the mistaken 3 by 3 count'
      : 'Square unit included in the area calculation';
    return h(Container, {
      as: 'li', key: index, border: 'all', background: counted ? 'secondary' : 'tertiary',
      width: `${cellSize}px`, heightPx: `${cellSize}px`, padding: 'none', alignItems: 'center', justifyContent: 'center',
      'aria-label': itemName,
    }, counted ? h(Text, { as: 'span', variant: 'body' }, '1') : null);
  }));
  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, h(Text, { as: 'h1', variant: 'heading-xl' }, content.title), paragraph(content.opening)),
    h(Container, { gap: 'md' },
      h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.cases), paragraph(content.labels.casePrompt),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.cases },
        ...content.cases.map(item => h(Button, { key: item.id, variant: item.id === selectedCase ? 'primary' : 'secondary', 'aria-pressed': item.id === selectedCase, disabled: practice.loading || practice.locked, onClick: () => { if (!practice.locked) { practice.markEdited(); setSelectedCase(item.id); } } }, item.title))),
      h(Text, { as: 'h3', variant: 'heading-md' }, example.title), paragraph(example.description), paragraph(example.result),
      h(Text, { as: 'h3', variant: 'heading-md' }, content.labels.workedExample), paragraph(content.labels.gridLegend), rectangle, paragraph(example.worked),
      ),
    h(Container, { gap: 'md' }, h(Text, { as: 'h2', variant: 'heading-lg' }, content.labels.plan),
      ...fields.map(key => {
        const id = `m026-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' }, h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, { id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true, 'aria-invalid': missing ? 'true' : undefined, 'aria-describedby': missing ? 'm026-practice-feedback' : undefined, value: practice.values[key], disabled: practice.loading || practice.locked, onChange: event => practice.setValue(key, event.target.value) }));
      }),
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, { variant: 'primary', work: null, disabled: practice.loading || practice.saving, onClick: () => { setAttemptedSave(true); return practice.save(); } }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm026-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      paragraph(content.feedback.directAction)));
}

export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
