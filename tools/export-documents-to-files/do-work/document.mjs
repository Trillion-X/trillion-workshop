// tools/export-documents-to-files/do-work/document.mjs
//
// The one document every export starts from, and the lowerings that let any block go to any format.
//
//   document = { title?: string, blocks: Block[] }
//   Block    = { kind: 'heading', level: 1..6, text }
//            | { kind: 'paragraph', text }
//            | { kind: 'list', ordered?: boolean, items: (string | { text, children?: item[] })[] }
//            | { kind: 'table', title?, columns: string[], rows: cell[][], currencies?: (string | null)[] }   cell = string | number | boolean | null;
//              `currencies` names, per column, the ISO currency code its numbers are money in (as a list field declares it)
//            | { kind: 'graph', title?, nodes: { id, label?, group?, color? }[], edges: { from, to, label? }[] }
//            | { kind: 'events', title?, events: { id?, title, start, end?, all_day?, description? }[] }
//            | { kind: 'picture', title?, svg }                                    svg = one complete <svg> element
//            | { kind: 'ink', operations, styles?, target?, reader_key?, default_stroke? }   read as a picture
//
// A format row names the kinds it draws (`draws`). A graph or events block a format does not draw is lowered to tables
// by `lowerBlocks`; format-takes.mjs says beforehand whether a format takes a document at all.
import { marksToSvg, materializeMarkRecords, readMarkTarget } from '../../draw-ink-marks/do-work/ink.mjs';

export const BLOCK_KINDS = ['heading', 'paragraph', 'list', 'table', 'graph', 'events', 'picture', 'ink'];

const fail = message => { throw new Error(message); };
const words = value => (value === null || value === undefined ? '' : String(value));
export const cellText = words;

function readItems(items, where) {
  if (!Array.isArray(items)) fail(`${where} must be a list of items.`);
  return items.map((item, index) => {
    if (typeof item === 'string') return { text: item, children: [] };
    if (item && typeof item === 'object' && typeof item.text === 'string') return { text: item.text, children: readItems(item.children ?? [], `${where}[${index}].children`) };
    return fail(`${where}[${index}] must be words or { text, children }.`);
  });
}

function readCell(cell, where) {
  if (cell === null || ['string', 'number', 'boolean'].includes(typeof cell)) return cell;
  return fail(`${where} must be words, a number, true/false or null.`);
}

/** Ink marks become the picture they draw, in the space's own coordinates. */
function inkPicture(raw, where) {
  if (!Array.isArray(raw.operations)) fail(`${where}.operations must be the list of mark operations.`);
  const { svg, bounds } = marksToSvg(materializeMarkRecords({
    operations: raw.operations, styles: raw.styles ?? [], target: raw.target === undefined ? undefined : readMarkTarget(raw.target), readerKey: raw.reader_key,
  }), { defaultStroke: raw.default_stroke });
  if (bounds === null) fail(`${where} has no ink showing, so there is no picture to export.`);
  const pad = 4;
  const [x, y] = [bounds.minX - pad, bounds.minY - pad];
  const [width, height] = [bounds.maxX - bounds.minX + 2 * pad, bounds.maxY - bounds.minY + 2 * pad];
  return { kind: 'picture', title: raw.title, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}">${svg}</svg>` };
}

function readBlock(raw, index) {
  const where = `blocks[${index}]`;
  if (!raw || typeof raw !== 'object') fail(`${where} must be an object with a kind.`);
  switch (raw.kind) {
    case 'heading': {
      if (!Number.isInteger(raw.level) || raw.level < 1 || raw.level > 6) fail(`${where}.level must be a whole number from 1 to 6.`);
      if (typeof raw.text !== 'string') fail(`${where}.text must be words.`);
      return { kind: 'heading', level: raw.level, text: raw.text };
    }
    case 'paragraph': {
      if (typeof raw.text !== 'string') fail(`${where}.text must be words.`);
      return { kind: 'paragraph', text: raw.text };
    }
    case 'list': return { kind: 'list', ordered: raw.ordered === true, items: readItems(raw.items, `${where}.items`) };
    case 'table': {
      if (!Array.isArray(raw.columns) || !raw.columns.every(column => typeof column === 'string')) fail(`${where}.columns must be a list of names.`);
      if (!Array.isArray(raw.rows) || !raw.rows.every(row => Array.isArray(row))) fail(`${where}.rows must be a list of rows, each a list of cells.`);
      if (raw.currencies !== undefined && (!Array.isArray(raw.currencies) || raw.currencies.length !== raw.columns.length || !raw.currencies.every(code => code === null || /^[A-Z]{3}$/.test(code)))) fail(`${where}.currencies must name, for each column, a three-letter currency code or null.`);
      return {
        kind: 'table', title: raw.title, columns: raw.columns, ...(raw.currencies ? { currencies: raw.currencies } : {}),
        rows: raw.rows.map((row, at) => raw.columns.map((_, column) => readCell(row[column] ?? null, `${where}.rows[${at}][${column}]`))),
      };
    }
    case 'graph': {
      if (!Array.isArray(raw.nodes) || !raw.nodes.every(node => node && node.id !== undefined)) fail(`${where}.nodes must be a list of { id, label }.`);
      if (!Array.isArray(raw.edges ?? [])) fail(`${where}.edges must be a list of { from, to, label? }.`);
      const ids = new Set(raw.nodes.map(node => String(node.id)));
      for (const edge of raw.edges ?? []) if (!ids.has(String(edge.from)) || !ids.has(String(edge.to))) fail(`${where} has a connection to a node that is not in nodes: ${words(edge.from)} to ${words(edge.to)}.`);
      return { kind: 'graph', title: raw.title, nodes: raw.nodes, edges: raw.edges ?? [] };
    }
    case 'events': {
      if (!Array.isArray(raw.events) || !raw.events.every(event => event && typeof event.title === 'string' && typeof event.start === 'string')) fail(`${where}.events must be a list of { title, start } with start as an ISO date or time.`);
      return { kind: 'events', title: raw.title, events: raw.events };
    }
    case 'picture': {
      if (typeof raw.svg !== 'string' || !/^\s*<svg[\s>]/.test(raw.svg)) fail(`${where}.svg must be one complete <svg> element.`);
      return { kind: 'picture', title: raw.title, svg: raw.svg };
    }
    case 'ink': return inkPicture(raw, where);
    default: return fail(`${where}.kind ${JSON.stringify(raw.kind)} is not one of ${BLOCK_KINDS.join(', ')}.`);
  }
}

/** Reads and checks a whole document; the error names the first thing wrong. */
export function readDocument(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) fail('document must be { title?, blocks: [...] }.');
  if (raw.title !== undefined && typeof raw.title !== 'string') fail('document.title must be words.');
  return { title: raw.title ?? '', blocks: raw.blocks.map(readBlock) };
}

const NODE_COLUMNS = ['id', 'label'];
const EDGE_COLUMNS = ['from', 'to', 'label'];
const EVENT_COLUMNS = ['title', 'start', 'end', 'all_day', 'description'];
const nodeLabel = node => words(node.label ?? node.id);

/** A graph as two tables (its nodes, then its connections), so any format that draws tables draws it. */
export function graphTables(block) {
  const named = new Map(block.nodes.map(node => [String(node.id), nodeLabel(node)]));
  return [
    { kind: 'table', title: block.title ? `${block.title}: nodes` : 'Nodes', columns: NODE_COLUMNS, rows: block.nodes.map(node => [words(node.id), nodeLabel(node)]) },
    { kind: 'table', title: block.title ? `${block.title}: connections` : 'Connections', columns: EDGE_COLUMNS, rows: block.edges.map(edge => [named.get(String(edge.from)), named.get(String(edge.to)), words(edge.label)]) },
  ];
}

/** Events as one table. */
export function eventsTable(block) {
  return { kind: 'table', title: block.title, columns: EVENT_COLUMNS, rows: block.events.map(event => EVENT_COLUMNS.map(column => event[column] ?? null)) };
}

/** The blocks as a format writes them (format-takes.mjs has said it takes them): graph and events it does not draw become tables. */
export function lowerBlocks(blocks, draws) {
  return blocks.flatMap(block => {
    if (draws.includes(block.kind)) return [block];
    if (block.kind === 'graph') return graphTables(block);
    if (block.kind === 'events') return [eventsTable(block)];
    return [block];
  });
}

/**
 * The document as nested outline nodes { text, children }: a heading opens a node that holds what follows until a
 * heading of the same or a higher level; list items nest as given; a table row becomes a node of its cells.
 */
export function outlineOf(document) {
  const root = { text: document.title, children: [] };
  const stack = [{ level: 0, node: root }];
  const attach = node => stack.at(-1).node.children.push(node);
  const nest = items => items.map(item => ({ text: item.text, children: nest(item.children) }));
  const leaf = text => ({ text, children: [] });
  for (const block of document.blocks) {
    if (block.kind === 'heading') {
      while (stack.at(-1).level >= block.level) stack.pop();
      const node = leaf(block.text);
      attach(node);
      stack.push({ level: block.level, node });
    } else if (block.kind === 'paragraph') attach(leaf(block.text));
    else if (block.kind === 'list') nest(block.items).forEach(attach);
    else if (block.kind === 'table') for (const row of block.rows) attach(leaf(row.map(cellText).join(' | ')));
    else if (block.kind === 'graph') {
      const label = new Map(block.nodes.map(node => [String(node.id), nodeLabel(node)]));
      for (const node of block.nodes) {
        attach({ text: nodeLabel(node), children: block.edges.filter(edge => String(edge.from) === String(node.id)).map(edge => leaf(`${edge.label ? `${edge.label}: ` : ''}${label.get(String(edge.to))}`)) });
      }
    } else if (block.kind === 'events') for (const event of block.events) attach(leaf(`${event.start} ${event.title}`));
    else if (block.kind === 'picture') attach(leaf(block.title ?? 'Picture'));
  }
  return root;
}

/** The largest of the numbers (a loop, so a long list never overruns the call stack); `floor` when there are none. */
export const largest = (numbers, floor = 0) => { let most = floor; for (const value of numbers) if (value > most) most = value; return most; };

/** Per column: true when every filled cell is a number, so the column is written against its right edge. */
export function numericColumns(block) {
  if (block.right) return block.right;
  return block.columns.map((_, index) => block.rows.some(row => row[index] !== null) && block.rows.every(row => row[index] === null || typeof row[index] === 'number'));
}

/** A currency column's number as money in the locale (1234.5 in USD as en-US is $1,234.50). */
export function moneyText(value, currency, locale) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

/**
 * The tables as a reader sees them: a number in a column that declares a currency becomes its money words, and the
 * column keeps its right alignment. Used for the formats that write words (PDF, Word, Markdown, text, web page ...);
 * the formats that keep numbers (CSV, Excel) are given the tables as they are.
 */
export function formatTables(blocks, locale) {
  return blocks.map(block => {
    if (block.kind !== 'table' || !block.currencies?.some(Boolean)) return block;
    const right = numericColumns(block);
    return { ...block, right, rows: block.rows.map(row => row.map((cell, index) => (typeof cell === 'number' && block.currencies[index] ? moneyText(cell, block.currencies[index], locale) : cell))) };
  });
}
