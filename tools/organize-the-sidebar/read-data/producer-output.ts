// packages/group/read-data/producer-output.ts
//
// THE producer envelope (convergence 2026-06-27:
// GPT-5.5 independent → identical verdict). Remote producers, multi-source pulls,
// and daily-auto boards are ALL the SAME thing — a PRODUCER that materializes
// addressed members into a target group. The producer is blind to group storage;
// the group is blind to the producer. The bridge (`do-work/apply-producer-output`)
// is the ONLY translator.
//
// This is the L069 keystone: "many executors need to materialize addressed group
// members." Solve it ONCE. A new producer (a source pull, a scheduled run, a
// local process) is a DATA config that emits this envelope — ZERO new bridge code.
// The substrate that RUNS a producer already exists (slot::workflow +
// compute.process + notice-when-something-shows-up + observed-content); this envelope is only
// the output contract + the group-owned apply seam.
//
// NON-NEGOTIABLE: `presentation` is OPAQUE. The bridge writes it verbatim and
// never reads kind/x/y/src — exactly like the group leaf (L090). A producer that
// invents a new item kind needs only a renderer DATA row, never a bridge edit.

import type { AddressRef } from '../../ui/show/group/group-graph';

/**
 * One member a producer wants to materialize into the target group. An existing
 * `memberId` MERGES (a result fills `src` on its pending item); a new
 * `memberId` is INSERTED (a remote producer places a fresh item). The bridge
 * decides merge-vs-insert by identity alone — never by the producer's name.
 */
export interface ProducerItem {
  /** Stable id within the target group (the producer's correlation handle). */
  readonly memberId: string;
  /** The addressed node this member points at (the item's own address). */
  readonly nodeRef: AddressRef;
  /**
   * Opaque FLAT presentation written verbatim — core geometry keys (kind/x/y/w/h/
   * text/src) plus owner keys (groupKey/status/placeableSurface/…) SIDE BY SIDE,
   * exactly the shape `placeItem` stores and `readItems` copies into
   * `BoardItem.extra`. There is exactly ONE stored presentation encoding; the
   * bridge normalizes every emitted presentation through
   * {@link normalizeProducerPresentation}, so a producer CANNOT store the one
   * historical divergence (owner keys nested under a `presentation.extra`
   * sub-object — members the canonical readers could not see; every card rendered
   * as a FallbackItem, incident 2026-07-11).
   */
  readonly presentation: Readonly<Record<string, unknown>>;
}

/**
 * THE canonical-presentation codec (L063 — the category fix for divergent
 * presentation encodings). Stored presentations are FLAT; this normalizes ANY
 * emitted presentation to that one shape:
 *   - a legacy NESTED `extra` sub-object is FLATTENED (its keys join the top
 *     level; explicit top-level keys win — geometry/kind stay authoritative);
 *   - the `extra` key itself is tombstoned to `undefined`, so the prune-on-write
 *     paths (`patchItems`/`addMembersVerbatim`) DELETE a stale stored `extra`
 *     blob on the first merge (self-healing for members written pre-fix).
 * Applied INSIDE `applyProducerOutput` — the ONE bridge every producer path
 * (local fill, remote result, live-feed reconcile) flows through — so no
 * construction site, including an untrusted remote producer, can reintroduce a
 * second encoding. Pure; a flat input passes through byte-equivalent (+tombstone).
 */
export function normalizeProducerPresentation(
  presentation: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { extra, ...rest } = presentation;
  const nested =
    extra && typeof extra === 'object' && !Array.isArray(extra) ? (extra as Record<string, unknown>) : undefined;
  return nested ? { ...nested, ...rest, extra: undefined } : { ...rest, extra: undefined };
}

/**
 * What a producer emits to fill a board group. The same shape covers one item
 * (a single result landing) or many (a producer placing a set of items).
 * `sources`/`layout` are opaque hints the owner may carry; the
 * bridge ignores them today (forward-compatible, never a parse).
 */
export interface ProducerOutput {
  /** Correlation handle for the run that emitted this (optional, opaque). */
  readonly runRef?: string;
  /** The group these items belong to (a board, a section, any nested group). */
  readonly targetGroupRef: AddressRef;
  /** The members to materialize. Empty = a no-op run (still legal). */
  readonly items: readonly ProducerItem[];
  /** Opaque provenance hints (which sources fed this run). Bridge ignores. */
  readonly sources?: readonly unknown[];
  /** Opaque layout hints (a producer-suggested arrangement). Bridge ignores. */
  readonly layout?: Readonly<Record<string, unknown>>;
}

/** True when an envelope carries no members (a producer that found nothing). */
export function isEmptyProducerOutput(output: ProducerOutput): boolean {
  return output.items.length === 0;
}
