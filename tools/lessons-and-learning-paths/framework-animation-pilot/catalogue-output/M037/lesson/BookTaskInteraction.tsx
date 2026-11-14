import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Text } from '@trillion/ui';
import { useEased } from '../../../../parts/ui/show/anatomy/use-eased.ts';
import { createBookTask } from './book-task-model.mjs';
import { renderBookTaskFigure } from './book-task-figure.mjs';

const h = React.createElement;
const fill = (template, values) => Object.entries(values)
  .reduce((text, [key, value]) => text.replaceAll('{'+key+'}', String(value)), template);

function BookOption({ task, book, selected, open, onChoose }) {
  const pose = useEased(selected && open ? 0.68 : 0);
  const figure = useMemo(() => renderBookTaskFigure({
    ...task.inspect(book.id, pose),
    accessibleLabel: fill(task.words.figure, {
      state: selected && open ? task.words.openState : task.words.closedState,
      id: book.id, cover: book.cover, pages: book.pages,
    }),
  }), [task, book, pose, selected, open]);
  return h(Button, {
    variant: 'outline', size: 'option-row', active: selected,
    className: 'flex-col gap-2', fullWidth: true,
    'aria-pressed': selected,
    'aria-label': fill(task.words.inspect, { id: book.id }),
    onClick: onChoose,
  },
    h(AnatomyFigure, {
      figure, label: figure.label, appearanceCss: figure.appearanceCss,
      className: figure.className, viewport: [0, 0, 800, 600],
    }),
    h(Text, { as: 'span', variant: 'body' }, book.detail));
}

/** A learner's selection stays separate from the authored before/after example. */
export function BookTaskInteraction({ taskExample }: { taskExample: unknown }) {
  const task = useMemo(() => createBookTask(taskExample as Parameters<typeof createBookTask>[0]), [taskExample]);
  const [bookId, setBookId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const selected = bookId ? task.inspect(bookId, 0) : null;
  const words = task.words;
  const observation = selected ? fill(words.status, {
    state: open ? words.openState : words.closedState, id: bookId,
    cover: selected.book.cover, pages: selected.book.pages, result: selected.result,
  }) : null;

  return h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm037-book-task-heading' },
    h(Text, { as: 'h3', id: 'm037-book-task-heading', variant: 'heading-md' }, task.prompt),
    h(Container, { layout: 'grid', gridCols: 'auto-fill-xs', gap: 'sm', role: 'group', 'aria-label': words.groupLabel },
      ...task.books.map(book => h(BookOption, {
        key: book.id, task, book, selected: bookId === book.id, open,
        onChoose: () => { setBookId(book.id); setOpen(false); },
      }))),
    selected ? h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', alignItems: 'center' },
      h(Button, { variant: 'secondary', 'aria-pressed': open, onClick: () => setOpen(value => !value) }, open ? words.close : words.open),
      h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, observation))
      : null);
}
