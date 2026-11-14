// src/workspace/tool-inputs.ts
//
// PURPOSE
//   What a person sees of a tool's inputs on its screen (src/workspace/tool-screen.tsx) and how what they give becomes
//   the tool's input. The tool's input_schema is its contract with AIs; the screen's `inputs` (DATA on the same tool
//   record) name each input for people. Pure: no page, no markup.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An input whose answer names a thing (a person, a place, a company) carries `x-record` on its own schema property
//      ({ from, new?, part?, fills? }, the same `from` and `new` as a form's `record` field): it is drawn as the shared
//      record picker (parts/ui/show/record-picker), never a box of free words, and the tool is handed the part of the
//      chosen row it takes (`part`: its title by default, or its `id` or `list_id`), so an AI calling the tool directly
//      still gives plain words. test/naming-fields-are-record-picks.test.mjs refuses such an input left as free words.
//   2. `fills` names other inputs the same chosen row fills (`{ same_as: "id" }`): those inputs are never drawn as boxes,
//      and a value the screen's place already gives is never overwritten.
//   3. A schema-declared `x-file` list uses the shared multiple-file picker only when its item contract declares
//      identity/key and both space_id/item_id. Structured references retain both ids; scalar file tools stay private.
//   4. A value the screen was opened with under FILLED_INPUTS (the words a person typed filled it, instant-screen.tsx)
//      starts in its box and stays the person's to change; a given input (givenInputs) is never drawn at all.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { GuideField } from '../../parts/ui/show/coss/guide';
import { boundToolInput, referenceFileValues, toolInputBindings } from './file-input-bindings.mjs';
import { recordPart, validRecordField, type RecordFrom, type RecordNew } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';

type RecordPart = 'id' | 'title' | 'list_id';
/** An input that names a thing: where its rows come from, where a new one is made, the part of the chosen row the tool
 *  takes, and the other inputs the same row fills (invariant 1, 2). */
type RecordInput = { from: RecordFrom; new?: RecordNew; part?: RecordPart; fills?: Record<string, RecordPart> };
type Property = { type?: string | string[]; enum?: unknown[]; title?: string; description?: string; properties?: Record<string, Property>; items?: Property; required?: string[]; 'x-file'?: { takes: string }; 'x-record'?: RecordInput };
export type ToolInputSchema = { properties?: Record<string, Property>; required?: string[] };

/** How a person sees one input: its name and hint, its choices by value, the kind of file it takes (`file.takes`, an id
 *  of parts/ui/show/file-field/file-takes.json: the input is then the chosen file's id), that what is typed is kept
 *  out of sight (`secret`, such as a key), that it takes several lines of words (`multiline`), when it shows, or that it
 *  stays for AIs only. */
export type ToolInput = { label?: string; placeholder?: string; choices?: { value: string; label: string }[]; file?: { takes: string }; secret?: boolean; multiline?: boolean; shows_when?: { name: string; values: string[] }; hidden?: boolean };

const words = (key: string) => key.replace(/[_-]+/g, ' ').replace(/^./, first => first.toUpperCase());
const PARTS: readonly string[] = ['id', 'title', 'list_id'];

/** The input's `x-record` when it is well formed (invariant 1), else null and the input is drawn as before. */
function recordOf(field: Property | undefined): RecordInput | null {
  const record = field?.['x-record'];
  if (!record || typeof record !== 'object' || !validRecordField(record)) return null;
  if (record.part !== undefined && !PARTS.includes(record.part)) return null;
  if (record.fills !== undefined && (typeof record.fills !== 'object' || !Object.values(record.fills).every(part => PARTS.includes(part)))) return null;
  return record;
}

/** The inputs a chosen row fills for another input (invariant 2): never drawn as boxes of their own. */
const filledByRecords = (schema: ToolInputSchema | undefined) =>
  new Set(Object.values(schema?.properties ?? {}).flatMap(field => Object.keys(recordOf(field)?.fills ?? {})));

/** One box per input a person gives the tool, as the screen's `inputs` says: one of their files for an input that
 *  names the kind of file it takes (`file`), a choice for a fixed list of values (named by `choices`, the first
 *  standing for leaving it out), yes or no for true/false, a row of their lists for an input that names a thing
 *  (`x-record`, invariant 1), a text box for anything else. The
 *  schema's description is written for AIs and is never shown; an input a person cannot type (an object or a list)
 *  stays off the screen unless `inputs` names it, and `hidden` keeps any input for AIs only. */
export function inputFields(schema: ToolInputSchema | undefined, inputs: Record<string, ToolInput> = {}, { includeComplex = false, given = {}, prefilled = {} }: { includeComplex?: boolean; given?: Record<string, unknown>; prefilled?: Record<string, unknown> } = {}): GuideField[] {
  const filled = filledByRecords(schema);
  return toolInputBindings(schema).flatMap(({ name, path, field, file }) => {
    const shown = inputs[path.join('.')] ?? inputs[name];
    if (filled.has(name) || path[0] in given || path.some((_key, index) => inputs[path.slice(0, index + 1).join('.')]?.hidden)) return [];
    const types = ([] as unknown[]).concat(field.type ?? 'string');
    const complex = types.some(type => type === 'object' || type === 'array');
    if (shown?.hidden || (!shown && complex && !file && !includeComplex)) return [];
    const values = Array.isArray(field.enum) ? field.enum.map(String) : types.includes('boolean') ? ['true', 'false'] : null;
    const named = new Map((shown?.choices ?? []).map(choice => [choice.value, choice.label]));
    const choices = values ? [{ value: '', label: named.get('') ?? 'None' }, ...values.filter(value => !shown?.choices || named.has(value)).map(value => ({ value, label: named.get(value) ?? words(value) }))] : null;
    const label = shown?.label ?? field.title ?? words(path.at(-1)!);
    if (file) return [{ name, label, kind: 'file' as const, multiple: true, file_source: 'references', takes: file.takes, values: [], ...(shown?.shows_when ? { shows_when: shown.shows_when } : {}) }];
    if (shown?.file) return [{ name, label, kind: 'file' as const, takes: shown.file.takes, value: '', ...(shown.shows_when ? { shows_when: shown.shows_when } : {}) }];
    const record = shown?.choices ? null : recordOf(field);
    if (record) return [{ name, label, kind: 'record' as const, from: record.from, ...(record.new ? { new: record.new } : {}), value: '', ...(shown?.placeholder ? { placeholder: shown.placeholder } : {}), ...(shown?.shows_when ? { shows_when: shown.shows_when } : {}) }];
    return [{
      name,
      label,
      ...(shown?.placeholder ? { placeholder: shown.placeholder } : complex ? { placeholder: types.includes('array') ? 'Enter a list, such as ["first", "second"]' : 'Enter details, such as {"name": "Example"}' } : {}),
      // What a person types shows as typed; only an input the screen marks secret is hidden as it is typed.
      secret: shown?.secret === true,
      ...(choices ? { kind: 'choice' as const, value: startOf(prefilled[name]), options: choices } : shown?.multiline || complex ? { kind: 'text' as const, value: startOf(prefilled[name]) } : prefilled[name] !== undefined ? { value: startOf(prefilled[name]) } : {}),
      ...(shown?.shows_when ? { shows_when: shown.shows_when } : {}),
    }];
  });
}

/** The key a screen's input carries the values its opener filled under (invariant 4). */
export const FILLED_INPUTS = 'filled_inputs';

/** The values a screen was opened with to start its boxes at (invariant 4), or none. */
export function filledInputs(opened: Record<string, unknown> = {}): Record<string, unknown> {
  const filled = opened[FILLED_INPUTS];
  return filled && typeof filled === 'object' && !Array.isArray(filled) ? filled as Record<string, unknown> : {};
}

// A box starts with a filled value as words: a list or details as JSON, anything else as it reads.
const startOf = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** What the boxes hold, as the tool's input: empty boxes are left out; numbers and true/false read as such; a chosen
 *  row is the part its input takes, and fills the inputs its `fills` names (invariants 1, 2). */
export function inputOf(schema: ToolInputSchema | undefined, values: Record<string, string | string[]>): Record<string, unknown> {
  const bindings = toolInputBindings(schema);
  const properties: Record<string, Property> = Object.fromEntries(bindings.map(binding => [binding.name, binding.field]));
  const given = Object.entries(values).filter(([, value]) => value !== '' && !(Array.isArray(value) && !value.length));
  const fills = given.flatMap(([name, value]) => Object.entries(recordOf(properties[name])?.fills ?? {})
    .map(([input, part]) => [input, recordPart(value, part)] as const)
    .filter(([input, part]) => part !== undefined && input in properties && !given.some(([other]) => other === input)));
  return boundToolInput([...fills, ...given.map(([name, value]) => {
    const binding = bindings.find(item => item.name === name);
    if (binding?.file) return [name, referenceFileValues(binding.field, value)];
    const record = recordOf(properties[name]);
    if (record) return [name, recordPart(value, record.part ?? 'title')];
    const types = ([] as unknown[]).concat(properties[name]?.type ?? 'string');
    if (types.includes('number') || types.includes('integer')) return [name, Number(value)];
    if (types.includes('boolean')) return [name, value === 'true'];
    if (types.includes('array') || types.includes('object')) {
      try { return [name, JSON.parse(String(value))]; }
      catch { throw new Error(`${words(name)} needs a valid ${types.includes('array') ? 'list' : 'set of details'}.`); }
    }
    return [name, value];
  })].filter(([, value]) => value !== undefined), bindings);
}

/** The inputs the place a screen is opened in already gives (a space's own tool opens with `space_id`): every value of
 *  the screen's input whose name is one of the tool's inputs, so the person is not asked for it again and every run
 *  carries it. The tool's own id is never one. */
export function givenInputs(schema: ToolInputSchema | undefined, opened: Record<string, unknown> = {}): Record<string, unknown> {
  const properties = schema?.properties ?? {};
  return Object.fromEntries(Object.entries(opened).filter(([name, value]) => name !== 'tool_id' && name in properties && value !== undefined && value !== null && value !== ''));
}
