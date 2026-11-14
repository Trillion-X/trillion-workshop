import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);
const ownersById = new Map(content.owners.map(value => [value, value]));
const restoreTransfer = value => {
  try {
    const parsed = JSON.parse(value ?? '');
    const assignments = Object.fromEntries(content.operations.map(row => [row.id,
      ownersById.has(parsed.assignments?.[row.id]) ? parsed.assignments[row.id] : row.owner]));
    return {
      assignments,
      state: content.states.includes(parsed.state) ? parsed.state : content.states[0],
    };
  } catch {
    return { assignments: Object.fromEntries(content.operations.map(row => [row.id, row.owner])), state: content.states[0] };
  }
};

function Lesson({ surfaceInput, host }) {
  const [assignments, setAssignments] = useState(() => Object.fromEntries(content.operations.map(row => [row.id, row.owner])));
  const [evidenceState, setEvidenceState] = useState(content.states[0]);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields,
    messages: content.feedback,
    requestPrefix: 'm097-zero-person-business',
    onRestore: record => {
      const restored = restoreTransfer(record.transfer);
      setAssignments(restored.assignments);
      setEvidenceState(restored.state);
    },
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => words ? h(Text, { as: 'p', variant: 'body', ...props }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const updateAssignment = (operation, owner) => {
    if (disabled) return;
    practice.markEdited();
    setAssignments(previous => ({ ...previous, [operation]: owner }));
  };
  const transfer = () => JSON.stringify({ assignments, state: evidenceState });
  const save = () => practice.save({ transfer: transfer() });
  const error = practice.status === content.feedback.length;

  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' },
      heading(content.title, 'h1'),
      paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm097-example-heading' },
      heading(content.labels.example, 'h2', 'm097-example-heading'),
      paragraph(content.labels.exampleDisclaimer),
      paragraph(content.source.definition),
      h(Container, { as: 'section', gap: 'sm', border: 'all', padding: 'md', 'aria-labelledby': 'm097-model-heading' },
        heading(content.labels.model, 'h3', 'm097-model-heading'),
        paragraph(content.labels.modelPrompt),
        h(Container, { as: 'ul', gap: 'md' }, ...content.operations.map(row => h(Container, {
          key: row.id,
          as: 'li',
          gap: 'xs',
          border: 'all',
          padding: 'md',
          'aria-label': `${row.name}. Assigned to ${assignments[row.id]}. ${row.detail}`,
        },
          heading(row.name, 'h3'),
          paragraph(row.detail),
          h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'xs', role: 'group', 'aria-label': `Owner for ${row.name}` },
            ...content.owners.map(owner => h(Button, {
              key: owner,
              variant: assignments[row.id] === owner ? 'primary' : 'secondary',
              'aria-pressed': assignments[row.id] === owner,
              disabled,
              onClick: () => updateAssignment(row.id, owner),
            }, owner)),
          ),
        ))),
        paragraph(`Founder touchpoints in this illustration: ${content.operations.filter(row => assignments[row.id] === 'Founder').map(row => row.name.toLowerCase()).join(', ') || 'none assigned'}. This list does not prove that the other work runs.`, { role: 'status', 'aria-live': 'polite' }),
      ),
      h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
        h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
        paragraph(`“${content.source.manuscript}”`),
        paragraph(content.source.locator),
        paragraph(content.source.limits),
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm097-practice-heading' },
      heading(content.labels.activity, 'h2', 'm097-practice-heading'),
      paragraph('Apply the method to a real repeatable outcome you know. If you do not have a real case, use the illustration and label it hypothetical.'),
      ...fields.map(key => {
        const id = `m097-practice-${key}`;
        const tooLong = practice.values[key].length > 2000;
        const linkedError = tooLong && error;
        const errorId = `${id}-error`;
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id,
            rows: 3,
            autoGrow: true,
            maxHeight: 300,
            required: true,
            'aria-invalid': linkedError ? 'true' : undefined,
            'aria-describedby': linkedError ? errorId : undefined,
            value: practice.values[key],
            disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }),
          tooLong ? paragraph(linkedError ? content.feedback.length : `${practice.values[key].length} characters; the private practice limit is 2,000.`, { id: linkedError ? errorId : undefined, role: linkedError ? 'alert' : 'status' }) : null,
        );
      }),
      h(Container, { gap: 'xs', role: 'group', 'aria-label': 'Evidence state' },
        paragraph('Evidence state for the case you described:'),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
          ...content.states.map(state => h(Button, {
            key: state,
            variant: evidenceState === state ? 'primary' : 'secondary',
            'aria-pressed': evidenceState === state,
            disabled,
            onClick: () => {
              practice.markEdited();
              setEvidenceState(state);
            },
          }, state)),
        ),
        evidenceState === 'Actual operation observed'
          ? paragraph('Use this only when you observed the real business path. A local fixture, plan or classroom simulation does not qualify.')
          : null,
      ),
      practice.loading ? paragraph('Loading your saved notes.', { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary',
        work: null,
        disabled: practice.loading || practice.saving,
        onClick: save,
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status && !error ? paragraph(practice.status, { id: 'm097-practice-feedback', role: 'status', 'aria-live': 'polite' }) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
