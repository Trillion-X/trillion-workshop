// tools/export-documents-to-files/do-work/render-template.mjs
//
// The template renderer: one program that writes every text format (Markdown, plain text, CSV, TSV, HTML, JSON, iCalendar,
// Mermaid, DOT, GraphML, OPML, FreeMind). What a format looks like is the format row's `options`, never code here:
//
//   escape        how values are written inside the file: none | xml | csv | tsv | ics | dot | mermaid | markdown-cell
//   document      the whole file, with {title} and {body}
//   joiner        what goes between blocks (default one line break)
//   title         one template with {text}                          (no title line when the row has none)
//   heading       {marks} {level} {text}
//   paragraph     {text}
//   list          { before, item, after, ordered_before, ordered_item, ordered_after, indent, joiner }   item {indent} {depth} {n} {text}
//   table         { title, header_row, header_rule, row, cell_separator, header_separator, rule_cell, cell_escape, joiner, after }   {cells} {rules} {text}
//   graph         { before, node, edge, edge_unlabeled, after }     node {key} {id} {label} {group} {color}; edge {from_key} {to_key} {from} {to} {label}
//   events        { before, event_timed, event_timed_ended, event_all_day, event_all_day_ended, after, fold_octets }
//                 {uid} {title} {description} {start_ics} {end_ics} {stamp_ics}
//   picture       { template }                                      {svg} {title}
//   outline       { node, leaf, root }                              {text} {children}   (a row with `outline` writes the document as a tree)
//
// A kind the document holds and the row has no template for is refused by name. A `{name}` a template uses that the
// renderer does not give is a mistake in the row and is refused when the row is used.
import { cellText, outlineOf } from './document.mjs';

const ESCAPES = {
  none: value => value,
  xml: value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  tsv: value => value.replace(/\t|\r?\n/g, ' '),
  ics: value => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'),
  dot: value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n'),
  mermaid: value => value.replace(/"/g, '#quot;').replace(/\r?\n/g, ' '),
  'markdown-cell': value => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'),
};

/** A CSV field: quoted only when it holds the separator, a quote or a line break. */
const csvField = separator => value => (value.includes(separator) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function escaper(name, separator) {
  if (name === 'csv') return csvField(separator ?? ',');
  if (!Object.hasOwn(ESCAPES, name)) throw new Error(`The escape ${JSON.stringify(name)} is not one of csv, ${Object.keys(ESCAPES).join(', ')}.`);
  return ESCAPES[name];
}

/** Puts values into a template's {names}; a name the template uses and `values` lacks is refused. */
function fill(template, values, where) {
  return template.replace(/\{([a-z_]+)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`The ${where} template uses {${name}}, which is not one of: ${Object.keys(values).map(key => `{${key}}`).join(' ')}.`);
    return values[name];
  });
}

const need = (template, where) => {
  if (typeof template !== 'string') throw new Error(`This format has no ${where} template, so it cannot draw that.`);
  return template;
};

/** An ISO date or time as iCalendar writes it: a date alone is all-day; a time with an offset is UTC; a time without is floating. */
export function icsWhen(iso) {
  const day = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return { allDay: true, text: `${day[1]}${day[2]}${day[3]}` };
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) throw new Error(`${JSON.stringify(iso)} is not an ISO date or time.`);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return { allDay: false, text: moment.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') };
  return { allDay: false, text: iso.replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) };
}

const foldLine = (line, limit) => {
  if (Buffer.byteLength(line) <= limit) return line;
  const parts = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (parts.length === 0 ? limit : limit - 1)) { parts.push(current); current = ''; }
    current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
};

function renderOutline(document, outline, esc) {
  const draw = node => {
    const children = node.children.map(draw).join('');
    return fill(node.children.length > 0 ? need(outline.node, 'outline node') : need(outline.leaf, 'outline leaf'), { text: esc(node.text), children }, 'outline');
  };
  const root = outlineOf(document);
  return fill(need(outline.root, 'outline root'), { text: esc(root.text), children: root.children.map(draw).join('') }, 'outline root');
}

/** @returns {string} the file's text. `now` is the time stamped on calendar events. */
export function renderTemplate(document, options, { now }) {
  const esc = escaper(options.escape ?? 'none', options.table?.cell_separator);
  const joiner = options.joiner ?? '\n';
  const wrap = body => fill(options.document ?? '{body}', { title: esc(document.title), body }, 'document');
  if (options.outline) return wrap(renderOutline(document, options.outline, esc));

  const lines = [];
  if (document.title && typeof options.title === 'string') lines.push(fill(options.title, { text: esc(document.title) }, 'title'));
  for (const block of document.blocks) {
    if (block.kind === 'heading') {
      lines.push(fill(need(options.heading, 'heading'), { marks: '#'.repeat(block.level), level: String(block.level), text: esc(block.text) }, 'heading'));
    } else if (block.kind === 'paragraph') {
      lines.push(fill(need(options.paragraph, 'paragraph'), { text: esc(block.text) }, 'paragraph'));
    } else if (block.kind === 'list') {
      const list = options.list ?? {};
      const [item, before, after] = block.ordered ? [list.ordered_item, list.ordered_before, list.ordered_after] : [list.item, list.before, list.after];
      const emit = (items, depth) => items.flatMap((entry, index) => [
        fill(need(item, block.ordered ? 'ordered list' : 'list'), { indent: (list.indent ?? '  ').repeat(depth), depth: String(depth), n: String(index + 1), text: esc(entry.text) }, 'list'),
        ...emit(entry.children, depth + 1),
      ]);
      lines.push([before, ...emit(block.items, 0), after].filter(part => typeof part === 'string').join(list.joiner ?? '\n'));
    } else if (block.kind === 'table') {
      const table = options.table ?? {};
      const cellEsc = table.cell_escape ? escaper(table.cell_escape, table.cell_separator) : esc;
      const row = (cells, separator = table.cell_separator) => cells.map(cell => cellEsc(cellText(cell))).join(need(separator, 'table cell separator'));
      const out = [];
      if (block.title && typeof table.title === 'string') out.push(fill(table.title, { text: esc(block.title) }, 'table title'));
      out.push(fill(need(table.header_row, 'table'), { cells: row(block.columns, table.header_separator ?? table.cell_separator) }, 'table header'));
      if (typeof table.header_rule === 'string') out.push(fill(table.header_rule, { rules: block.columns.map(() => table.rule_cell ?? '---').join(table.cell_separator) }, 'table rule'));
      for (const cells of block.rows) out.push(fill(need(table.row, 'table row'), { cells: row(cells) }, 'table row'));
      if (typeof table.after === 'string') out.push(table.after);
      lines.push(out.join(table.joiner ?? '\n'));
    } else if (block.kind === 'graph') {
      const graph = options.graph ?? {};
      const key = new Map(block.nodes.map((node, index) => [String(node.id), `n${index + 1}`]));
      const label = new Map(block.nodes.map(node => [String(node.id), String(node.label ?? node.id)]));
      const out = [];
      if (typeof graph.before === 'string') out.push(fill(graph.before, { title: esc(block.title ?? '') }, 'graph before'));
      for (const node of block.nodes) {
        out.push(fill(need(graph.node, 'graph node'), { key: key.get(String(node.id)), id: esc(String(node.id)), label: esc(label.get(String(node.id))), group: esc(String(node.group ?? '')), color: esc(String(node.color ?? '')) }, 'graph node'));
      }
      for (const edge of block.edges) {
        const text = edge.label ? String(edge.label) : '';
        const template = text || typeof graph.edge_unlabeled !== 'string' ? graph.edge : graph.edge_unlabeled;
        out.push(fill(need(template, 'graph edge'), { from_key: key.get(String(edge.from)), to_key: key.get(String(edge.to)), from: esc(label.get(String(edge.from))), to: esc(label.get(String(edge.to))), label: esc(text) }, 'graph edge'));
      }
      if (typeof graph.after === 'string') out.push(fill(graph.after, { title: esc(block.title ?? '') }, 'graph after'));
      lines.push(out.join(graph.joiner ?? '\n'));
    } else if (block.kind === 'events') {
      const events = options.events ?? {};
      const out = [];
      const stamp = icsWhen(now).text;
      block.events.forEach((event, index) => {
        const start = icsWhen(event.start);
        const end = event.end ? icsWhen(event.end) : null;
        const kind = `event_${start.allDay ? 'all_day' : 'timed'}${end ? '_ended' : ''}`;
        out.push(fill(need(events[kind], `calendar event (${kind})`), {
          uid: esc(event.id ? String(event.id) : `event-${index + 1}@export`), title: esc(event.title), description: esc(String(event.description ?? '')),
          start_ics: start.text, end_ics: end?.text ?? '', stamp_ics: stamp,
        }, 'event'));
      });
      const body = [events.before, ...out, events.after].filter(part => typeof part === 'string').join(events.joiner ?? '\r\n');
      lines.push(typeof events.fold_octets === 'number' ? body.split(/\r?\n/).map(line => foldLine(line, events.fold_octets)).join('\r\n') : body);
    } else if (block.kind === 'picture') {
      lines.push(fill(need(options.picture?.template, 'picture'), { svg: block.svg.replace(/^<\?xml[^>]*\?>\s*/, '').trim(), title: esc(block.title ?? '') }, 'picture'));
    } else throw new Error(`The template renderer cannot draw a ${block.kind} block.`);
  }
  return wrap(lines.join(joiner));
}
