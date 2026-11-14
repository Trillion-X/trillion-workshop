// parts/ui/show/schema-value-view/value-shape.ts
//
// PURPOSE
//   Turns any JSON value, and the JSON Schema that describes it when there is one, into a small tree of readable
//   pieces the SchemaValueView draws: a short text, a long text, a list of short items, a table, a set of cards, or a
//   labelled section holding more pieces. It is what makes a step's or a tool's output readable by a person without
//   any screen knowing what the output is about.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a workflow, a tool or a field. Labels come from the schema's `title`, else the field
//      name turned into plain words ("why_not_a_mechanism" reads "Why not a mechanism").
//   2. Every value is shown, in schema order first and then any field the schema does not name; nothing is dropped or
//      summarised, and nothing is invented. This is the plain field list; result-view.ts picks the designed view by
//      shape and leaves machine fields out before it falls back to these pieces. There is no raw-JSON toggle.
//   3. Pure and deterministic: the same value and schema give the same pieces, so it is tested without a browser.
//
// KEY CONCEPTS
//   A list of objects whose fields are all short (text, numbers, yes/no, or lists of short text) and that has at most
//   TABLE_MAX_COLUMNS fields is a table; any other list of objects is cards. Text over LONG_TEXT_CHARS characters, or
//   holding a line break, is long text and wraps.

export type JsonSchema = {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

export type ValuePiece =
  | { kind: 'text'; label: string | null; text: string; long: boolean }
  | { kind: 'list'; label: string | null; items: string[] }
  | { kind: 'table'; label: string | null; columns: string[]; rows: string[][] }
  | { kind: 'cards'; label: string | null; cards: ValuePiece[][] }
  | { kind: 'section'; label: string | null; pieces: ValuePiece[] };

export const LONG_TEXT_CHARS = 120;
export const TABLE_MAX_COLUMNS = 5;
const TABLE_CELL_CHARS = 80;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** A field name in plain words: separators become spaces, camel case splits, and only the first letter is capital. */
export function plainLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/** A short value as text: yes and no for booleans, "none" for null, a list of short items joined by commas. */
export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(scalarText).join(', ');
  return String(value);
}

const labelOf = (key: string, schema?: JsonSchema) => schema?.title?.trim() || plainLabel(key);

/** The object's fields in schema order, then any field the schema does not name, in the value's own order. */
function orderedKeys(value: Record<string, unknown>, schema?: JsonSchema): string[] {
  const named = Object.keys(schema?.properties ?? {}).filter(key => key in value);
  return [...named, ...Object.keys(value).filter(key => !named.includes(key))];
}

const shortCell = (value: unknown) => (isScalar(value) && String(value ?? '').length <= TABLE_CELL_CHARS && !String(value ?? '').includes('\n'))
  || (Array.isArray(value) && value.every(isScalar) && scalarText(value).length <= TABLE_CELL_CHARS);

function tableOf(items: Record<string, unknown>[], schema?: JsonSchema): { columns: string[]; keys: string[] } | null {
  const keys: string[] = [];
  for (const key of [...Object.keys(schema?.properties ?? {}), ...items.flatMap(item => Object.keys(item))]) if (!keys.includes(key) && items.some(item => key in item)) keys.push(key);
  if (keys.length === 0 || keys.length > TABLE_MAX_COLUMNS) return null;
  if (!items.every(item => keys.every(key => !(key in item) || shortCell(item[key])))) return null;
  return { keys, columns: keys.map(key => labelOf(key, schema?.properties?.[key])) };
}

/** One value as readable pieces. `label` names it when it sits under a field; the top value has none. */
export function valuePieces(value: unknown, schema?: JsonSchema, label: string | null = null): ValuePiece[] {
  if (value === undefined) return [];
  if (isScalar(value)) {
    const text = scalarText(value);
    return [{ kind: 'text', label, text, long: text.length > LONG_TEXT_CHARS || text.includes('\n') }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ kind: 'text', label, text: 'none', long: false }];
    if (value.every(isScalar)) return [{ kind: 'list', label, items: value.map(scalarText) }];
    if (value.every(isObject)) {
      const table = tableOf(value, schema?.items);
      if (table) return [{ kind: 'table', label, columns: table.columns, rows: value.map(item => table.keys.map(key => (key in item ? scalarText(item[key]) : ''))) }];
      return [{ kind: 'cards', label, cards: value.map(item => fieldPieces(item, schema?.items)) }];
    }
    return [{ kind: 'cards', label, cards: value.map(item => valuePieces(item, schema?.items)) }];
  }
  const fields = fieldPieces(value as Record<string, unknown>, schema);
  return label === null ? fields : [{ kind: 'section', label, pieces: fields }];
}

function fieldPieces(value: Record<string, unknown>, schema?: JsonSchema): ValuePiece[] {
  return orderedKeys(value, schema).flatMap(key => valuePieces(value[key], schema?.properties?.[key], labelOf(key, schema?.properties?.[key])));
}
