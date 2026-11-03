// tools/draw-a-change-as-a-diagram/do-work/markup-tree.mjs
//
// Purpose: markup built as a tree of plain elements and written out once, so escaping has one owner and no markup is put
// together by hand from strings. Used wherever a server or a pure module writes a document that is not a page (a standalone
// SVG file, the HTML half of a copied answer).
//
// Invariants:
//   1. Every attribute value and every text goes through the one escape (./escape-html.mjs); a name is never escaped, so a
//      caller names only elements and attributes it wrote.
//   2. An attribute whose value is undefined or null is left out; a number is written rounded to one decimal.
//   3. An element with no children is self-closing; the same tree always gives the same bytes.
import { escapeHtml } from './escape-html.mjs';

const rounded = (value) => String(Math.round(value * 10) / 10);

/** An element: its name, its attributes (in the order given) and its children (elements or text). */
export const element = (name, attributes = {}, children = []) => ({ name, attributes, children });
/** A piece of text. */
export const textOf = (value) => ({ text: value });

/** The tree as text. */
export function serialise(node) {
  if (typeof node.text === 'string') return escapeHtml(node.text);
  const attributes = Object.entries(node.attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ` ${name}="${escapeHtml(typeof value === 'number' ? rounded(value) : String(value))}"`).join('');
  const inner = node.children.map(serialise).join('');
  return inner ? `<${node.name}${attributes}>${inner}</${node.name}>` : `<${node.name}${attributes}/>`;
}
