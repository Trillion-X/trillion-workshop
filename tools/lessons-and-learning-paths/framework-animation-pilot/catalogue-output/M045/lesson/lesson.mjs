import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const phaseFor = value => value === 'connection-fails' ? value : 'connection-holds';

function Lesson({ surfaceInput, host }) {
  const [extras, setExtras] = useState({ opportunity: '', valueGoal: '', difficulty: '' });
  const [connection, setConnection] = useState('connection-holds');
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['step'],
    messages: content.feedback,
    requestPrefix: 'm045-pre-focus-alignment-ritual',
    onRestore: record => {
      try {
        const saved = typeof record.transfer === 'string' ? JSON.parse(record.transfer) : record.transfer;
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          setExtras({
            opportunity: typeof saved.opportunity === 'string' ? saved.opportunity : '',
            valueGoal: typeof saved.valueGoal === 'string' ? saved.valueGoal : '',
            difficulty: typeof saved.difficulty === 'string' ? saved.difficulty : '',
          });
          setConnection(phaseFor(saved.connection));
        }
      } catch { /* Keep an editable draft if optional context cannot be restored. */ }
    },
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const field = (key, required = false) => {
    const id = `m045-practice-${key}`;
    const value = key === 'step' ? practice.values.step : extras[key];
    return h(Container, { key, gap: 'xs' },
      h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
      h(Textarea, {
        id, rows: 5, autoGrow: true, maxHeight: 220, maxLength: 2000,
        value, disabled,
        'aria-required': required ? 'true' : undefined,
        onChange: event => {
          if (key === 'step') practice.setValue('step', event.target.value);
          else {
            practice.markEdited();
            setExtras(current => ({ ...current, [key]: event.target.value }));
          }
        },
      }));
  };
  const updateConnection = next => {
    if (disabled) return;
    practice.markEdited();
    setConnection(phaseFor(next));
  };
  const example = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm045-example-heading' },
    heading(content.labels.example, 'h2', 'm045-example-heading'),
    h(Container, { gap: 'sm' }, paragraph(content.examples.context.description)),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md', alignItems: 'stretch' },
      ...[content.examples.make, content.examples.reuse].map((option, index) => h(Container, {
        key: option.title, as: 'article', border: 'all', padding: 'md', gap: 'sm', flex: '1', minWidth: '280px',
        'aria-label': option.title,
      },
        heading(option.title, 'h3'),
        paragraph(option.description),
        index === 1 ? paragraph('Check the current source first; reuse it if it already does the job.') : null,
      ))),
    paragraph(content.examples.summary));
  const work = h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm045-work-heading' },
    heading('Your work period', 'h2', 'm045-work-heading'),
    paragraph('Fill only what helps you choose the next action. The work field alone can be saved as a draft.'),
    ...content.actions.map((action, index) => h(Container, { key: action.id, gap: 'xs' },
      heading(action.title, 'h3'),
      paragraph(action.description),
      field(action.id === 'work' ? 'step' : action.id, index === 3),
    )),
    h(Container, { gap: 'sm' },
      heading('Does the connection hold?', 'h3'),
      paragraph('If the task serves the stated goal, begin the specific work. If it does not, revise the task or leave it undone. When the connection was already clear, start directly without doing this ritual.'),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': 'Purpose connection' },
        h(Button, {
          variant: connection === 'connection-holds' ? 'primary' : 'secondary',
          'aria-pressed': connection === 'connection-holds', disabled,
          onClick: () => updateConnection('connection-holds'),
        }, 'Connection holds'),
        h(Button, {
          variant: connection === 'connection-fails' ? 'primary' : 'secondary',
          'aria-pressed': connection === 'connection-fails', disabled,
          onClick: () => updateConnection('connection-fails'),
        }, 'Revise the task'),
      ),
    ),
    practice.locked ? paragraph(content.feedback.retryPending) : null,
    h(Button, {
      variant: 'primary', work: null, disabled: practice.loading || practice.saving,
      onClick: () => practice.save({ transfer: JSON.stringify({ ...extras, connection }) }),
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, { as: 'p', id: 'm045-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),
    example,
    work,
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
