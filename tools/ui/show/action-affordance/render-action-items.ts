// packages/ui/show/action-affordance/render-action-items.ts
//
// Pure view-model: action-affordance rows → the blind renderers ui already
// owns (CommandPalette rows, NodeActionCapability rows). The mapping carries
// no domain vocabulary and dispatches through a caller-injected invoke.

import type { CommandPaletteItem } from '../command-palette';
import type { NodeActionCapability, NodeRef } from '../node-actions';
import { ACTION_AFFORDANCE_ICON, type ActionAffordance, type ActionAffordanceTrigger } from './action-affordance-types';
import { triggerForChannel } from './read-action-affordances';

/** How a host runs a chosen affordance (it owns context minting + sending). */
export type AffordanceInvoke = (
  affordance: ActionAffordance,
  trigger: ActionAffordanceTrigger,
) => void | Promise<void>;

/** Palette rows for `channel`. Rows without a trigger on the channel are
 *  skipped (never rendered dead). */
export function affordancePaletteItems(
  rows: readonly ActionAffordance[],
  channel: string,
  invoke: AffordanceInvoke,
): CommandPaletteItem[] {
  const items: CommandPaletteItem[] = [];
  for (const row of rows) {
    const trigger = triggerForChannel(row, channel);
    if (!trigger) continue;
    items.push({
      id: row.id,
      label: row.label,
      ...(row.icon ? { icon: row.icon } : {}),
      ...(row.hint ? { hint: row.hint } : {}),
      ...(row.section ? { section: row.section } : {}),
      run: () => { void invoke(row, trigger); },
    });
  }
  return items;
}

/** Context-menu capabilities for `channel`. `accepts` is caller-supplied so the
 *  host decides what a nodeRef means for its own conditions (translation
 *  boundary) — absent, every node is accepted. */
export function affordanceNodeActions(
  rows: readonly ActionAffordance[],
  channel: string,
  invoke: AffordanceInvoke,
  accepts?: (affordance: ActionAffordance, nodeRef: NodeRef) => boolean,
): NodeActionCapability[] {
  const actions: NodeActionCapability[] = [];
  for (const row of rows) {
    const trigger = triggerForChannel(row, channel);
    if (!trigger) continue;
    actions.push({
      id: row.id,
      label: row.label,
      icon: row.icon ?? ACTION_AFFORDANCE_ICON,
      ...(typeof row.priority === 'number' ? { priority: row.priority } : {}),
      accepts: (nodeRef) => (accepts ? accepts(row, nodeRef) : true),
      run: () => { void invoke(row, trigger); },
    });
  }
  return actions;
}
