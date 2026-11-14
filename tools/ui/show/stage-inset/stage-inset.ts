// parts/ui/show/stage-inset/stage-inset.ts
//
// PURPOSE
//   The one owner of the space docked chrome reserves at the page's edges. Anything docked to an edge (the
//   sidebar, the message box) adds its size to that edge's `--stage-inset-<edge>` CSS value on one owner element,
//   and the arrangement stage lays itself out inside those insets. Extracted from the sidebar, which proved it, so
//   every dockable thing shares one sum instead of overwriting each other.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each docked thing contributes only its own edge and size; the owner sums them, over whatever another
//      layout owner had already set before the first one joined (its baseline), and restores that baseline when
//      the last one leaves.
//   2. A thing that asks is told where to sit: the insets of the baseline and of every contribution registered
//      before it, per edge, so a message box docked after the sidebar starts beside the sidebar, not under it.
//   3. The stage moves to its new edge in one step (`--stage-inset-transition: none`): animating its edges lays out
//      every pane on every frame.

import type { DockPosition } from '../dockable-placement/dockable-placement';

export type StageInsetContribution = { position: DockPosition; size: number; dragging: boolean };
export type StageInsets = Record<DockPosition, number>;

const EDGES: readonly DockPosition[] = ['left', 'right', 'top', 'bottom'];
const KEYS = EDGES.map(edge => `--stage-inset-${edge}`);

type Owner = {
  contributions: Map<symbol, StageInsetContribution>;
  listeners: Map<symbol, (before: StageInsets) => void>;
  baseline: Map<string, { value: string; priority: string }>;
};

const owners = new WeakMap<HTMLElement, Owner>();

function write(owner: HTMLElement, state: Owner) {
  const style = owner.style;
  const sums = Object.fromEntries(EDGES.map(edge => [edge, Number.parseFloat(state.baseline.get(`--stage-inset-${edge}`)?.value ?? '') || 0])) as StageInsets;
  for (const key of KEYS) {
    const baseline = state.baseline.get(key);
    style.setProperty(key, baseline?.value || '0px', baseline?.priority || '');
  }
  for (const [id, contribution] of state.contributions) {
    state.listeners.get(id)?.({ ...sums });
    if (contribution.size > 0) {
      sums[contribution.position] += contribution.size;
      style.setProperty(`--stage-inset-${contribution.position}`, `${sums[contribution.position]}px`);
    }
  }
  style.setProperty('--stage-inset-transition', 'none');
}

/** Joins the owner's sum with nothing reserved yet; `onPlace` hears the insets before this one whenever they move. */
export function registerStageInset(owner: HTMLElement, id: symbol, onPlace?: (before: StageInsets) => void) {
  let state = owners.get(owner);
  if (!state) {
    state = {
      contributions: new Map(),
      listeners: new Map(),
      baseline: new Map([...KEYS, '--stage-inset-transition'].map(key => [key, { value: owner.style.getPropertyValue(key), priority: owner.style.getPropertyPriority(key) }])),
    };
    owners.set(owner, state);
  }
  state.contributions.set(id, { position: 'left', size: 0, dragging: false });
  if (onPlace) state.listeners.set(id, onPlace);
  write(owner, state);
}

export function updateStageInset(owner: HTMLElement, id: symbol, contribution: StageInsetContribution) {
  const state = owners.get(owner);
  if (!state || !state.contributions.has(id)) return;
  state.contributions.set(id, contribution);
  write(owner, state);
}

export function unregisterStageInset(owner: HTMLElement, id: symbol) {
  const state = owners.get(owner);
  if (!state) return;
  state.contributions.delete(id);
  state.listeners.delete(id);
  if (state.contributions.size > 0) { write(owner, state); return; }
  for (const [key, baseline] of state.baseline) {
    if (baseline.value) owner.style.setProperty(key, baseline.value, baseline.priority);
    else owner.style.removeProperty(key);
  }
  owners.delete(owner);
}
