// packages/ui/show/action-affordance/editor-catalog.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Fold the action-affordance EDITOR's catalogs from the live feed: what an
// authored action can RUN (`kind:"affordance-definition-option"`) and where it
// can SHOW (`kind:"affordance-channel"`). Before this, every host hardcoded
// both arrays — the SAME `action:run-ai-records-production` block duplicated in
// the board panel and the composition surface, and each host cross-naming the
// OTHER host's channels ('composition.slash-menu' inside group source; group
// channels inside composition source). That was F7's second half: runnable
// definitions belong to the packages that OWN them (ai-records-producer
// publishes "actions can run me" with ITS result/error contract), and channels
// belong to the surfaces that OWN them (each host publishes its own places).
// A new producer or a new surface = its package ships a record; every editor
// lists it with zero code change anywhere (L090/L093/no-god-package).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This fold names NO definition id, NO channel, NO package — the catalog is
//    entirely the records' content.
// 2. Rows sort by DATA `order` (then feed order) so owners control placement.
// 3. Fail-closed: no records ⇒ empty catalogs — the editor renders honestly
//    empty rather than inventing a runnable definition.
// =============================================================================

import type { AffordanceChannelOption, AffordanceDefinitionOption } from './ActionAffordanceEditor';

const DEFINITION_KIND = 'affordance-definition-option';
const CHANNEL_KIND = 'affordance-channel';

type FeedRecord = { readonly payload?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function orderOf(p: Record<string, unknown>): number {
  return typeof p.order === 'number' ? p.order : Number.MAX_SAFE_INTEGER;
}

/** Every `affordance-definition-option` record → what authored actions can run.
 *  The record carries the owning package's OWN run contract verbatim:
 *  `{ id, label, literal_input?, status?, order? }`. */
export function foldAffordanceDefinitionOptions(records: readonly FeedRecord[]): AffordanceDefinitionOption[] {
  const rows: Array<{ option: AffordanceDefinitionOption; order: number; index: number }> = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== DEFINITION_KIND) continue;
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    const label = typeof p.label === 'string' && p.label ? p.label : null;
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      order: orderOf(p),
      index,
      option: {
        id,
        label,
        ...(isRecord(p.literal_input) ? { literalInput: p.literal_input } : {}),
        ...(isRecord(p.status) ? { status: p.status as AffordanceDefinitionOption['status'] } : {}),
      },
    });
  }
  rows.sort((a, b) => a.order - b.order || a.index - b.index);
  return rows.map((r) => r.option);
}

/** Every `affordance-channel` record → where an authored action can show.
 *  Each SURFACE publishes its own places: `{ channel, label, order? }`. */
export function foldAffordanceChannelOptions(records: readonly FeedRecord[]): AffordanceChannelOption[] {
  const rows: Array<{ option: AffordanceChannelOption; order: number; index: number }> = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== CHANNEL_KIND) continue;
    const channel = typeof p.channel === 'string' && p.channel ? p.channel : null;
    const label = typeof p.label === 'string' && p.label ? p.label : null;
    if (!channel || !label || seen.has(channel)) continue;
    seen.add(channel);
    rows.push({ order: orderOf(p), index, option: { channel, label } });
  }
  rows.sort((a, b) => a.order - b.order || a.index - b.index);
  return rows.map((r) => r.option);
}
