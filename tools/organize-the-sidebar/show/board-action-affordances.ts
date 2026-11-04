// packages/group/show/board-action-affordances.ts
//
// The board's translation boundary for action-affordance records: rows on the
// board's channels become ShelfEntry tools / palette rows / context-menu
// capabilities. The mapping derives the EXISTING ProducerSubmitDescriptor from
// the record's dispatch block, so the whole proven produce pipeline
// (submit → poll → applyProducerOutput) consumes records with zero panel change.
// This module never names a concrete action — every row is opaque DATA.

import { Sparkles } from 'lucide-react';
import type { CommandPaletteItem } from '../../ui';
import type { NodeActionCapability } from '../../ui/show/node-actions';
import { resolveNamedIcon } from '../../ui/show/icon/NamedIcon';
import {
  ACTION_AFFORDANCE_ICON,
  affordancesForChannel,
  resolveActionAffordanceWriteAddress,
  triggerForChannel,
  type ActionAffordance,
  type ActionAffordanceTrigger,
} from '../../ui/show/action-affordance';
import type { ProducerSubmitDescriptor } from '../do-work/submit-producer-request';
import type { ShelfEntry } from './item-renderers';
import type { AddressRef } from '../../ui/show/group/group-graph';

/** The board's render-context addresses (this surface's own vocabulary — DATA
 *  the board publishes to record authors, not an engine enum). */
export const BOARD_CHANNELS = {
  shelf: 'group.add-shelf',
  palette: 'group.palette',
  contextMenu: 'group.context-menu',
} as const;

/** The context-menu channel's placement scopes — the board's own vocabulary
 *  for WHERE within the channel a row appears (a record declares them in its
 *  trigger `contexts`). `selection` = right-click on selected items (the
 *  channel's default, so unscoped/legacy records land there unchanged);
 *  `board` = right-click on bare canvas. Open strings, never an engine enum. */
export const BOARD_MENU_PLACEMENTS = {
  selection: 'selection',
  board: 'board',
} as const;

/**
 * The owner-local selection envelope passed to a target binding.  Board member
 * ids are intentionally retained as local ids; the Group materializer owns the
 * later exact reads and must never receive browser-invented Engine references.
 */
export function ownerSelectionContext(rootRef: AddressRef, selectedIds: Iterable<string>): {
  root_ref: AddressRef;
  member_ids: string[];
} {
  return { root_ref: rootRef, member_ids: [...selectedIds] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A template row is dispatch-time-bound iff it is a `$kind:binding` object;
 *  everything else is a literal the descriptor can carry as baseInput. */
function literalRows(template: Record<string, unknown>): Record<string, unknown> {
  // Object.create(null): `template` is UNTRUSTED DATA (an action-affordance record). A JSON-parsed
  // template can carry an OWN `__proto__` key, and `literals['__proto__'] = value` on a plain object
  // hits the prototype SETTER and corrupts the bag. Null-proto stores every key as a plain own prop.
  const literals: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(template)) {
    if (isRecord(value) && value.$kind === 'binding') continue;
    literals[key] = value;
  }
  return literals;
}

/**
 * Derive the board's existing producer descriptor from an affordance whose
 * dispatch targets the workflow slot with a status block. Returns null when the
 * record doesn't carry what the produce pipeline needs (no status → the board
 * cannot poll → not a shelf tool; it can still be a palette/menu action).
 */
export function producerDescriptorOf(
  affordance: ActionAffordance,
  channel: string,
): ProducerSubmitDescriptor | null {
  const trigger = triggerForChannel(affordance, channel);
  return trigger ? producerDescriptorOfTrigger(affordance, trigger) : null;
}

/** Same derivation from an already-chosen trigger (the per-trigger SSOT). */
export function producerDescriptorOfTrigger(
  affordance: ActionAffordance,
  trigger: ActionAffordanceTrigger,
): ProducerSubmitDescriptor | null {
  const status = affordance.dispatch.status;
  const definitionId = isRecord(affordance.dispatch.payload_template)
    ? affordance.dispatch.payload_template.definition_id
    : undefined;
  if (!status || typeof definitionId !== 'string' || definitionId.length === 0) return null;
  const baseInput = literalRows(trigger.input_template);
  return {
    definitionId,
    resultAddressTemplate: status.result_address_template,
    errorAddressTemplate: status.error_address_template,
    ...(status.address_mode ? { addressMode: status.address_mode } : {}),
    ...(status.result_partition_label ? { resultPartitionLabel: status.result_partition_label } : {}),
    ...(Object.keys(baseInput).length > 0 ? { baseInput } : {}),
    // Carry the RAW template (bindings + compose) so the invoking surface can resolve
    // it against a live subject (the selected items' text) — this is what makes the
    // action act on the selection instead of an empty prompt (literalRows drops the
    // `typed.text` binding, so the board must re-resolve the full template at run time).
    ...(isRecord(trigger.input_template) ? { inputTemplate: trigger.input_template } : {}),
  };
}

/** True when a template binds the run CONTENT from `typed.text` — i.e. the action
 *  runs on a subject the board fills with the selection (a "content action" like
 *  Translate/Summarize). When such an action fires WITH a live selection, the board
 *  already resolves that binding to the selected cards' text and DISCARDS the ask's
 *  answer, so prompting for content is a redundant step — the panel uses this to skip
 *  the ask. Walks the template generically (never enumerates an action / a field). */
/** Depth cap for the template walk — `input_template` is UNTRUSTED DATA, so a deeply-nested hostile
 *  record must not stack-overflow this recursion. Any real binding template nests only a few levels;
 *  past the cap we fail closed to `false` (the board just doesn't skip the ask — a safe redundant prompt). */
const MAX_TEMPLATE_DEPTH = 100;

export function templateBindsTypedText(node: unknown, depth = 0): boolean {
  if (depth > MAX_TEMPLATE_DEPTH) return false;
  if (Array.isArray(node)) return node.some((n) => templateBindsTypedText(n, depth + 1));
  if (isRecord(node)) {
    if (node.$kind === 'binding' && isRecord(node.select)
      && node.select.from === 'typed' && node.select.path === 'text') return true;
    return Object.values(node).some((v) => templateBindsTypedText(v, depth + 1));
  }
  return false;
}

/** True when a ONE-CLICK action (no declared ask, no form) whose template binds the
 *  board subject (`typed.text`) has NO subject to act on — the fail-closed gate for
 *  firing a doomed producer run over nothing (L117: never a fake "Working…" card on
 *  an empty board; the "nothing to summarize" class). Purely derived from the tool's
 *  own DATA (declared ask/form + template bindings) + the live subject — the board
 *  never names an action. An action that ASKS is exempt: its typed answer/answers
 *  bag is the content. */
export function actionNeedsMissingSubject(
  tool: { readonly defaultText?: string; readonly formFields?: readonly unknown[]; readonly producer?: { readonly inputTemplate?: unknown } },
  subject: string,
): boolean {
  if (tool.defaultText) return false; // declared single-text ask → the answer is the content
  if (tool.formFields && tool.formFields.length > 0) return false; // form answers are the content
  if (!templateBindsTypedText(tool.producer?.inputTemplate)) return false; // subject not bound → self-sufficient
  return subject.trim().length === 0;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * ONE affordance trigger → the board ShelfEntry that runs it through the
 * proven `produce` add-strategy (ask → fire descriptor → pending item → poll).
 * Null when the dispatch isn't pollable (honest — a tool that could never
 * complete is not offered). This is the SINGLE translation the shelf, palette,
 * and context-menu all reuse — every board entry point runs an action the
 * exact same way (L069).
 */
export function shelfToolOf(
  affordance: ActionAffordance,
  trigger: ActionAffordanceTrigger,
): ShelfEntry {
  const producer = producerDescriptorOfTrigger(affordance, trigger);
  const presentation = trigger.presentation ?? {};
  // A trigger with `ask.fields` is a MULTI-FIELD action: carry the field descriptors +
  // the raw record so the panel opens the blind ActionForm (and can Save-as-preset)
  // instead of the single-text produce ask. A trigger with only `ask.prompt` keeps the
  // single-text path (back-compat). The board never enumerates a field (L090).
  const fields = trigger.ask?.fields;
  const hasForm = Array.isArray(fields) && fields.length > 0;

  return {
    kind: stringOf(presentation.item_kind) ?? 'pending',
    label: affordance.label,
    icon: resolveNamedIcon(affordance.icon) ?? Sparkles,
    addStrategy: producer ? 'produce' : 'empty',
    // The trigger's OWN channel rides along so the run path can report the real
    // door in the invoke context (`surface.channel`) — a palette-derived tool must
    // not claim it was invoked from the shelf (Codex 2026-07-10, finding 4).
    invokeChannel: trigger.channel,
    // The record's DATA `section` rides along so sectioned surfaces (the Custom-actions
    // popover) can group rows under it — an open string, never enumerated here (L090).
    ...(stringOf(affordance.section) ? { section: affordance.section } : {}),
    // The record's DATA `effect` rides along OPAQUELY so the board's producer-result
    // poll routes this action's output (append vs authoritative reconcile — edit/
    // reorganize existing notes). Never enumerated here (L090).
    ...(stringOf(affordance.effect) ? { effect: affordance.effect } : {}),
    // The affordance's log identity rides along OPAQUELY so the panel can archive
    // (soft-delete) the action through the owning write path. Only rows with a
    // resolvable write address are removable — the popover gates its Remove control
    // on this (a built-in fixture without one simply shows no Remove).
    ...(resolveActionAffordanceWriteAddress(affordance) ? {
      removalRef: {
        ...(affordance.id ? { id: affordance.id } : {}),
        ...(affordance.source_address ? { source_address: affordance.source_address } : {}),
        payload: affordance.payload,
      },
    } : {}),
    ...(trigger.ask?.prompt ? { defaultText: trigger.ask.prompt } : {}),
    ...(hasForm ? {
      formFields: fields,
      formTitle: trigger.ask?.title ?? affordance.label,
      ...(trigger.ask?.submit_label ? { formSubmitLabel: trigger.ask.submit_label } : {}),
      affordanceRecord: affordance.payload,
    } : {}),
    ...(producer ? { producer } : { directAffordance: { affordance, trigger } }),
    ...(numberOf(presentation.total_hint) !== undefined ? { totalHint: numberOf(presentation.total_hint) } : {}),
    ...(stringOf(presentation.working_label) ? { workingLabel: stringOf(presentation.working_label) } : {}),
    ...(numberOf(presentation.timeout_ms) !== undefined ? { timeoutMs: numberOf(presentation.timeout_ms) } : {}),
  };
}

/**
 * Affordance rows on a board channel → ShelfEntry tools. The shelf channel
 * feeds the board's existing `extraTools` seam; the palette/menu channels
 * derive the SAME tools and hand them to `addItem` (one run path, N doors).
 */
export function affordanceShelfTools(
  rows: readonly ActionAffordance[],
  context: Record<string, unknown> = {},
  channel: string = BOARD_CHANNELS.shelf,
): ShelfEntry[] {
  const tools: ShelfEntry[] = [];
  for (const affordance of affordancesForChannel(rows, channel, context)) {
    const trigger = triggerForChannel(affordance, channel);
    if (!trigger) continue;
    const tool = shelfToolOf(affordance, trigger);
    if (tool) tools.push(tool);
  }
  return tools;
}

/** Palette rows on the board's palette channel. Each row derives the SAME
 *  ShelfEntry the shelf would and hands it to the panel's one run path
 *  (`runTool` = the panel's addItem) — ask → fire → pending item → poll. */
export function boardAffordancePaletteItems(
  rows: readonly ActionAffordance[],
  runTool: (tool: ShelfEntry) => void,
  context: Record<string, unknown> = {},
): CommandPaletteItem[] {
  const items: CommandPaletteItem[] = [];
  for (const affordance of affordancesForChannel(rows, BOARD_CHANNELS.palette, context)) {
    const trigger = triggerForChannel(affordance, BOARD_CHANNELS.palette);
    if (!trigger) continue;
    const tool = shelfToolOf(affordance, trigger);
    if (!tool) continue;
    items.push({
      id: `cmd-act-${affordance.id}`,
      label: affordance.label,
      ...(affordance.icon ? { icon: affordance.icon } : {}),
      ...(affordance.hint ? { hint: affordance.hint } : {}),
      // The record's own DATA `section` sections the palette (same fold the popover
      // uses — b249); records without one collect under the generic "Actions" bucket.
      // Palette search already matches section text, so "translate" surfaces the set.
      section: stringOf(affordance.section) ?? 'Actions',
      run: () => runTool(tool),
    });
  }
  return items;
}

/** Context-menu capabilities on the board's menu channel — same one run path.
 *  `placement` names WHERE within the channel this menu is (selection menu vs
 *  bare-board menu); unscoped records keep their historical selection-menu
 *  placement because `selection` is the channel's default context. */
export function boardAffordanceContextActions(
  rows: readonly ActionAffordance[],
  runTool: (tool: ShelfEntry) => void,
  context: Record<string, unknown> = {},
  placement: string = BOARD_MENU_PLACEMENTS.selection,
): NodeActionCapability[] {
  const scope = { context: placement, defaultContext: BOARD_MENU_PLACEMENTS.selection };
  const actions: NodeActionCapability[] = [];
  for (const affordance of affordancesForChannel(rows, BOARD_CHANNELS.contextMenu, context, scope)) {
    const trigger = triggerForChannel(affordance, BOARD_CHANNELS.contextMenu, scope);
    if (!trigger) continue;
    const tool = shelfToolOf(affordance, trigger);
    if (!tool) continue;
    actions.push({
      id: `menu-act-${affordance.id}`,
      label: affordance.label,
      icon: affordance.icon ?? ACTION_AFFORDANCE_ICON,
      ...(affordance.hint ? { hint: affordance.hint } : {}),
      ...(typeof affordance.priority === 'number' ? { priority: affordance.priority } : {}),
      accepts: () => true,
      run: () => runTool(tool),
    });
  }
  return actions;
}
