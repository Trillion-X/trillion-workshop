// src/workspace/automation-preview-source.tsx
//
// PURPOSE
//   The workspace's one source for the shared automation hover card (parts/ui/show/automation-preview): an id's small
//   steps are read from /work/api/workflows/preview/<id> (src/work-workflows.mjs) as a board source and drawn as a still
//   picture of the board they live on (board-of.tsx BoardStill), and pressing it opens the automation in its own tab (surface
//   trillion.workflow: a trigger or schedule as `automation:<id>` in its editor, a workflow as its graph).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Set once when a screen that shows automations is imported; setting it again changes nothing that was drawn.
//   2. Every element is a shared component; this file writes no markup.
//   3. What a workspace screen's field or card stands on comes from each automation's own `backs` DATA
//      ([{ screen: <surface id>, item: <field or card id> }]) in the /work/api/workflows listing, read each time
//      such a screen reads its own rows, so an automation turned off shows as off (backingOn, withBacking); no screen names an automation.

import React from 'react';
import { setAutomationPreviewSource, type AutomationPreviewGraph, type BackingAutomation } from '../../parts/ui/show/automation-preview';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import type { BoardSource } from '../../parts/group/do-work/board-source';
import { BoardStill } from './board-of';
import { readJson } from './api';

/** Opens one automation (`automation:<id>` for a trigger or schedule, a workflow id or a run id) in its own tab. */
export const openAutomation = (id: string, title: string) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.workflow', title, surfaceInput: { id } } }));

setAutomationPreviewSource({
  read: id => readJson<AutomationPreviewGraph>(`/work/api/workflows/preview/${encodeURIComponent(id)}`),
  drawGraph: graph => <BoardStill source={graph.source as BoardSource} label={graph.title} />,
  open: openAutomation,
});

type Listed = { id: string; open_id: string; kind: string; name: string; enabled: boolean | null; backs?: { screen?: string; item?: string }[] };
const listed = () => readJson<{ automations: Listed[] }>('/work/api/workflows').then(answer => answer.automations);

/** How long a screen waits for the automations behind it before drawing without them. */
const BACKING_WAIT_MS = 3000;
/** For one workspace screen (its surface id): each field or card id and the automations that stand behind it. A
 *  listing that cannot be read, or has not come within BACKING_WAIT_MS, backs nothing, so the screen still draws (it is
 *  read with the screen, so a copy this device kept answers at once). */
export async function backingOn(surfaceId: string): Promise<Map<string, BackingAutomation[]>> {
  const behind = new Map<string, BackingAutomation[]>();
  const waited = new Promise<Listed[]>(done => setTimeout(() => done([]), BACKING_WAIT_MS));
  for (const item of await Promise.race([listed().catch(() => [] as Listed[]), waited])) for (const back of item.backs ?? []) {
    if (back.screen !== surfaceId || typeof back.item !== 'string') continue;
    const id = item.open_id;
    behind.set(back.item, [...(behind.get(back.item) ?? []), { id, label: item.name, on: item.enabled !== false }]);
  }
  return behind;
}

/** A screen's fields or cards, each carrying the automations `behind` it (by its id). */
export const withBacking = <T extends { id: string; automations?: BackingAutomation[] }>(parts: T[], behind: Map<string, BackingAutomation[]>): T[] =>
  parts.map(part => (behind.has(part.id) ? { ...part, automations: behind.get(part.id) } : part));
