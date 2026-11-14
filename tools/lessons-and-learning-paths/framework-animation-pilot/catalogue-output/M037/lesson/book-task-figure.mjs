import { BOOK_MATERIAL_CSS, bookCoverClass } from '../../../../parts/screen-look/show/anatomy/book-materials.mjs';
import { renderBook } from '../../../anatomy-contact-replacement/book-model.mjs';

/** Build one inspectable book from the shared hinged-book anatomy renderer. */
export function renderBookTaskFigure(selection) {
  if (!selection?.book || !Number.isFinite(selection.open) || selection.open < 0 || selection.open > 1 || !selection.accessibleLabel) throw new TypeError('A selected book pose and accessible copy are required');
  const { book, open, result } = selection;
  const rendered = renderBook({
    id: `m037-task-book-${book.id}`,
    open,
    ink: 0,
    label: selection.accessibleLabel,
  });
  return Object.freeze({
    ...rendered,
    appearanceCss: BOOK_MATERIAL_CSS,
    className: bookCoverClass(book.cover),
    label: selection.accessibleLabel,
    facts: Object.freeze({ cover: book.cover, pages: book.pages, open }),
  });
}
