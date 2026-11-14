// parts/ui/show/seam-slots/seam-slots.ts
//
// PURPOSE
// The room a thing takes on a seam of the window's arrangement: the line between two panes. A thing that sits on a
// seam (the sidebar, as a thin bar between two panes) claims it with its thickness; the arrangement that owns the
// window's panes lays a slot of that thickness on the seam, so the panes beside it give up exactly that room, and hands
// the slot's element back; the thing draws itself into the slot. One seam, one slot, one thing in it.
//
// NON-NEGOTIABLE INVARIANTS
// 1. A claim names the seam by its split's path and the child it follows (DockSeam), never a pane or a screen, so
//    any split tree, nested or stacked on a phone, offers the same seams to any thing.
// 2. The newest claim on a seam wins it; an older claim on the same seam is held until the newer one leaves.
// 3. Only the arrangement that holds the window's panes lays slots (`window` scope); an arrangement drawn inside a
//    screen lays none, so a window thing never lands inside a screen.
// 4. The slot tells which way it lies (`axis`): `vertical` between panes side by side, `horizontal` between panes
//    stacked. The thing reads it, never the device or the window's width.
// 5. A change notifies once per change; reading the same claims twice returns the same array.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { decodeDockSeam, dockSeamKey, type DockSeam } from '../dockable-placement/dockable-placement';

/** One thing's hold on one seam. */
export interface SeamClaim {
  readonly seam: DockSeam;
  /** The room it takes across the seam, in pixels. */
  readonly thickness: number;
}

/** A slot the arrangement laid on a claimed seam. */
export interface SeamSlot {
  readonly element: HTMLElement;
  /** `vertical`: the slot runs down between panes side by side. `horizontal`: across between panes stacked. */
  readonly axis: 'vertical' | 'horizontal';
}

const claims = new Map<symbol, SeamClaim>();
const slots = new Map<string, SeamSlot>();
const listeners = new Set<() => void>();
let claimList: readonly SeamClaim[] = [];

function changed(): void {
  // The newest claim on each seam wins it (invariant 2).
  const bySeam = new Map<string, SeamClaim>();
  for (const claim of claims.values()) bySeam.set(dockSeamKey(claim.seam), claim);
  claimList = [...bySeam.values()];
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hold a seam with this thickness, or let go of it (undefined). */
export function claimSeam(owner: symbol, claim: SeamClaim | undefined): void {
  const current = claims.get(owner);
  if (!claim) {
    if (!current) return;
    claims.delete(owner);
    changed();
    return;
  }
  if (current && dockSeamKey(current.seam) === dockSeamKey(claim.seam) && current.thickness === claim.thickness) return;
  claims.delete(owner);
  claims.set(owner, claim);
  changed();
}

/** Every claimed seam, the winning claim of each (for the arrangement that lays slots). */
export function useSeamClaims(): readonly SeamClaim[] {
  return React.useSyncExternalStore(subscribe, () => claimList, () => claimList);
}

/** The arrangement lays (or takes away, null) the slot of one seam. */
export function placeSeamSlot(seam: DockSeam, slot: SeamSlot | null): void {
  const key = dockSeamKey(seam);
  const current = slots.get(key);
  if (!slot) {
    if (!current) return;
    slots.delete(key);
  } else {
    if (current && current.element === slot.element && current.axis === slot.axis) return;
    slots.set(key, slot);
  }
  listeners.forEach((listener) => listener());
}

/** The slot laid for this seam, once the arrangement has laid it. */
export function useSeamSlot(seam: DockSeam | undefined): SeamSlot | null {
  const key = seam ? dockSeamKey(seam) : null;
  const read = () => (key ? slots.get(key) ?? null : null);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** Every seam the window's arrangement shows now, read from the page: a split's panes in order, with their rectangles. */
export interface ShownSeam {
  readonly seam: DockSeam;
  readonly axis: 'vertical' | 'horizontal';
  /** The band between the two panes, in window pixels. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** The attribute the arrangement stamps on the edge after each pane, naming its seam. */
export const SEAM_MARK = 'data-seam-of';

/** Read the seams the window's arrangement draws now (each marked edge with a pane after it). */
export function readShownSeams(root: ParentNode = document): ShownSeam[] {
  const seams: ShownSeam[] = [];
  for (const mark of root.querySelectorAll<HTMLElement>(`[${SEAM_MARK}]`)) {
    const seam = decodeSeamMark(mark.getAttribute(SEAM_MARK));
    if (!seam) continue;
    const before = mark.previousElementSibling as HTMLElement | null;
    let after = mark.nextElementSibling as HTMLElement | null;
    while (after && !after.hasAttribute('data-split-child')) after = after.nextElementSibling as HTMLElement | null;
    if (!before || !after) continue;
    const a = before.getBoundingClientRect();
    const b = after.getBoundingClientRect();
    if (a.width === 0 && a.height === 0) continue;
    const vertical = b.left >= a.right - 1;
    seams.push({
      seam,
      axis: vertical ? 'vertical' : 'horizontal',
      rect: vertical
        ? { x: a.right, y: Math.min(a.top, b.top), w: Math.max(0, b.left - a.right), h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) }
        : { x: Math.min(a.left, b.left), y: a.bottom, w: Math.max(a.right, b.right) - Math.min(a.left, b.left), h: Math.max(0, b.top - a.bottom) },
    });
  }
  return seams;
}

/** The mark value for a seam: the seam itself as JSON. */
export function seamMark(seam: DockSeam): string {
  return JSON.stringify({ split: seam.split, after: seam.after });
}

function decodeSeamMark(value: string | null): DockSeam | undefined {
  if (!value) return undefined;
  try { return decodeDockSeam(JSON.parse(value)); } catch { return undefined; }
}
