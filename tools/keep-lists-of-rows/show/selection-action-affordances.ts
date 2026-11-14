//
// Visual Database's translation boundary for shared action-affordance DATA.
// It owns one channel and one selection vocabulary. Action meaning, workflow
// identity, destinations, and output behavior remain entirely in records.

import type {
  ActionAffordance,
  ActionAffordanceTrigger,
  AffordanceInvokeContext,
  AskField,
} from '@/packages/ui/show/action-affordance';
import {
  affordancesForChannel,
  buildDispatchPayload,
  readActionAffordances,
  triggerForChannel,
} from '@/packages/ui/show/action-affordance';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent';
import {
  visualDatabaseSelectedRecordRefs,
} from '@/packages/visual-database/do-work/visual-database-actions';
import type { VisualDatabaseRecord } from '@/packages/visual-database/read-data/visual-database';

export const VISUAL_DATABASE_SELECTION_CHANNEL = 'visual-database.selection-actions';

export interface VisualDatabaseSelectionAffordance {
  readonly id: string;
  readonly label: string;
  readonly affordance: ActionAffordance;
  readonly trigger: ActionAffordanceTrigger;
}

/** Decode only active affordances that actually target this owner channel. */
export function visualDatabaseSelectionAffordances(raw: unknown): VisualDatabaseSelectionAffordance[] {
  // Acceptance conditions may depend on the current selection. Decode the
  // whole channel here; evaluate the same generic conditions at render time.
  return readActionAffordances(readPublishedRecords(raw)).flatMap((affordance) => {
    const trigger = triggerForChannel(affordance, VISUAL_DATABASE_SELECTION_CHANNEL);
    return trigger ? [{ id: affordance.id, label: affordance.label, affordance, trigger }] : [];
  }).sort((a, b) => (a.affordance.priority ?? 0) - (b.affordance.priority ?? 0)
    || a.label.localeCompare(b.label));
}

/** The blind form fields for this placement. The contract's shorthand prompt
 *  is projected into the same ActionForm vocabulary as an explicit field. */
export function visualDatabaseSelectionAskFields(
  action: VisualDatabaseSelectionAffordance,
): readonly AskField[] {
  const fields = action.trigger.ask?.fields ?? [];
  if (fields.length > 0) return fields;
  const prompt = action.trigger.ask?.prompt;
  return prompt
    ? [{ id: 'text', control: 'text', label: prompt, placeholder: prompt, required: true }]
    : [];
}

/** Mint the owner context once. The binding resolver remains generic and the
 *  selected addresses come from Visual Database's existing canonical translator. */
export function visualDatabaseSelectionInvokeContext(
  action: VisualDatabaseSelectionAffordance,
  selectedRecords: readonly VisualDatabaseRecord[],
  runId: string,
  answers: Record<string, unknown> = {},
): AffordanceInvokeContext {
  const anchor = selectedRecords[0];
  if (!anchor) throw new Error('Visual Database selection action requires at least one selected record');
  const items = visualDatabaseSelectedRecordRefs({ record: anchor, selectedRecords })
    .map(({ address }) => ({ address }));
  if (items.length !== selectedRecords.length) {
    throw new Error('Every selected Visual Database row must carry an exact Engine address');
  }
  // A single current record can supply DATA bindings for its owner action.
  // Keep the multi-select address vocabulary unchanged and never guess which
  // record's payload should represent a multi-selection. The receiving owner
  // must still re-read and verify these coordinates before writing.
  const raw = selectedRecords.length === 1 && anchor.raw && typeof anchor.raw === 'object'
    && !Array.isArray(anchor.raw) ? anchor.raw as Record<string, unknown> : null;
  const current = raw?.address === items[0]?.address && raw.payload
    && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    ? { address: items[0].address, payload: raw.payload }
    : undefined;
  return {
    run: { id: runId },
    surface: { channel: VISUAL_DATABASE_SELECTION_CHANNEL },
    selection: { items, ...(current ? { current } : {}) },
    ...(Object.keys(answers).length > 0 ? { answers } : {}),
    ...(typeof answers.text === 'string' ? { typed: { text: answers.text } } : {}),
  };
}

/** Apply the shared DATA acceptance predicate to one real selection. */
export function visualDatabaseSelectionActionApplies(
  action: VisualDatabaseSelectionAffordance,
  selectedRecords: readonly VisualDatabaseRecord[],
): boolean {
  if (selectedRecords.length === 0) return false;
  try {
    const context = visualDatabaseSelectionInvokeContext(action, selectedRecords, 'selection-check');
    return affordancesForChannel([action.affordance], VISUAL_DATABASE_SELECTION_CHANNEL,
      { selection: context.selection }).length === 1;
  } catch {
    return false;
  }
}

export interface VisualDatabaseAffordanceSender {
  (request: { target: string; payload: unknown }): Promise<unknown>;
}

/** Resolve DATA bindings, then hand the resulting envelope to the entry's
 *  scoped sender. Workflow—not this surface—owns execution and durability. */
export async function dispatchVisualDatabaseSelectionAffordance(args: {
  readonly action: VisualDatabaseSelectionAffordance;
  readonly selectedRecords: readonly VisualDatabaseRecord[];
  readonly runId: string;
  readonly answers?: Record<string, unknown>;
  readonly sender: VisualDatabaseAffordanceSender;
}): Promise<unknown> {
  const context = visualDatabaseSelectionInvokeContext(
    args.action,
    args.selectedRecords,
    args.runId,
    args.answers,
  );
  return args.sender(buildDispatchPayload(
    args.action.affordance,
    args.action.trigger.id,
    context,
  ));
}
