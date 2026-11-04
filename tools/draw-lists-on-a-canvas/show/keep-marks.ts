// parts/addressed-marks/show/keep-marks.ts
//
// PURPOSE
//   The one keeper of ink, colours and tools, wherever they are drawn: over one pane, the whole screen, a board or
//   anything else that mounts the mark layers. A drawing tool saves through the package actions
//   (`action:record-addressed-mark-operation`, `-style`, `-tool` on `slot::workflow`); this module answers them on the
//   page as soon as any mark surface loads, so a stroke made before any board has opened is kept too.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Ink goes to the first ink place that holds its target (`addInkPlace`: a space's board keeps its ink in the
//      space, where every member sees it); any other ink is appended to the person's own records
//      (`addressed-marks.operations`). This module never learns what a board, a space or a pane is.
//   2. A saved colour or tool is appended to the person's own records (`addressed-marks.styles` / `.tools`) under the
//      id it was saved with; one saved again with the same id replaces the earlier one.
//   3. Everything is append or replace-by-id: earlier ink is hidden by later operations (`effects.hide_refs`), never
//      edited here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { answerTarget, readInputValue, writeInputValue } from '#workspace-records';
import { RECORD_MARK_OPERATION_ACTION } from '../do-work/record-mark-operation';
import { RECORD_MARK_STYLE_ACTION } from '../do-work/record-mark-style';
import { RECORD_MARK_TOOL_ACTION } from '../do-work/record-mark-tool';

type Row = Record<string, unknown>;
/** A place that keeps the ink of some targets itself (a space's board keeps its ink in the space): `holds` says
 *  which ink it keeps now, `shows` which ink it has shown on this page (never to be saved into the person's own
 *  records, even after the place has closed). */
export type InkPlace = { holds: (targetAddress: string) => boolean; shows?: (targetAddress: string) => boolean; keep: (row: Row) => Promise<void> };

const places = new Set<InkPlace>();
const isObject = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listAt = (input: string): Row[] => {
  const value = readInputValue<unknown>(input);
  return Array.isArray(value) ? value.filter(isObject) : [];
};

/** Let one place keep the ink of the targets it holds; returns the call that lets it go. */
export function addInkPlace(place: InkPlace): () => void {
  places.add(place);
  return () => { places.delete(place); };
}

/** Whether some place other than the person's own records keeps or has shown the ink of this target. */
export const inkKeptElsewhere = (targetAddress: string) => [...places].some(place => place.holds(targetAddress) || Boolean(place.shows?.(targetAddress)));

/** The input each saved kind lives in, and the input field naming its id. */
const KINDS: Record<string, { input: string; idField?: string }> = {
  [RECORD_MARK_OPERATION_ACTION]: { input: 'mark-operations', idField: 'operation_id' },
  [RECORD_MARK_STYLE_ACTION]: { input: 'mark-styles', idField: 'style_id' },
  [RECORD_MARK_TOOL_ACTION]: { input: 'mark-tools', idField: 'tool_id' },
};

const kindOf = (payload: unknown) => (isObject(payload) && typeof payload.definition_id === 'string' ? KINDS[payload.definition_id] : undefined);

answerTarget('slot::workflow', async payload => {
  const kind = kindOf(payload)!;
  const input = isObject(payload) && isObject(payload.input) ? payload.input : {};
  const { [kind.idField ?? 'id']: id, ...rest } = input;
  const row: Row = { id, ...rest };
  const target = isObject(row.target) && typeof row.target.address === 'string' ? row.target.address : '';
  const place = [...places].find(one => target && one.holds(target));
  if (place) {
    await place.keep(row);
    return { kept: true };
  }
  const kept = listAt(kind.input).filter(one => one.id !== id && !(isObject(one.target) && typeof one.target.address === 'string' && inkKeptElsewhere(one.target.address)));
  await writeInputValue(kind.input, [...kept, row]);
  return { kept: true };
}, { handles: payload => kindOf(payload) !== undefined });
