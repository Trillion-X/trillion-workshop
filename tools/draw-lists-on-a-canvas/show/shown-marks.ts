// parts/addressed-marks/show/shown-marks.ts
//
// PURPOSE
//   Marks shown on this page and never kept: a tour's pointers, doodles and shapes, an AI showing where to look. Any
//   owner shows rows under a key and hides them by the same key; every mark layer draws them with the person's own ink
//   (use-mark-data.ts `useMarkOperations`), each under its own target address.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Shown rows are never written to any record: nothing here saves, and the keeper (keep-marks.ts) only hears
//      strokes the person draws.
//   2. A key owns its rows: showing again under the same key replaces them, hiding the key removes them.
//   3. A row has the one mark-operation shape (read-data/addressed-marks.ts); this module never learns who shows it.
//   4. A stroke (`showStrokes`) names its tool and colour by the ids of the starting tools and colours
//      (starting-marks.json), and its shape is made by the same mapper the person's own drawing uses.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { useSyncExternalStore } from 'react';
import { mapPointsForTool, readMarkTools, toolEmitsClosedSet, type MarkTarget } from '../read-data/addressed-marks';
import starting from '../starting-marks.json';

type Row = Record<string, unknown>;

let shown = new Map<string, readonly Row[]>();
let all: readonly Row[] = [];
const listeners = new Set<() => void>();

function changed(next: Map<string, readonly Row[]>): void {
  shown = next;
  all = [...next.values()].flat();
  for (const listener of listeners) listener();
}

/** Show `rows` under `key` (replacing what that key showed before). */
export function showMarks(key: string, rows: readonly Row[]): void {
  const next = new Map(shown);
  next.set(key, rows);
  changed(next);
}

/** Hide what `key` showed. */
export function hideMarks(key: string): void {
  if (!shown.has(key)) return;
  const next = new Map(shown);
  next.delete(key);
  changed(next);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Every row shown now. */
export function useShownMarks(): readonly Row[] {
  return useSyncExternalStore(subscribe, () => all, () => all);
}

/** One stroke to show: a tool and a colour by id (starting-marks.json, such as 'tool:ellipse' and 'style:ink-danger'),
 *  and its points in the target's frame (the first and last point span a line or a shape). */
export type ShownStroke = { tool: string; style: string; points: readonly (readonly number[])[] };

const tools = readMarkTools(starting.tools);

/** Show `strokes` on `target` under `key`, made into rows as the person's own drawing makes them. */
export function showStrokes(key: string, target: MarkTarget, strokes: readonly ShownStroke[]): void {
  showMarks(key, strokes.map((stroke, at) => {
    const tool = tools.find(one => one.id === stroke.tool);
    const points = mapPointsForTool(tool, stroke.points.map(values => ({ values: [...values] })));
    return {
      id: `shown:${key}:${at}`,
      target,
      tool_ref: stroke.tool,
      style_ref: stroke.style,
      sequence: at,
      body: { coordinate_sets: [{ id: 'path:0', closed: toolEmitsClosedSet(tool), points: points.map(point => ({ values: [...point.values] })) }], effects: {} },
    };
  }));
}
