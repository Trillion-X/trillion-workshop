// packages/notifications/read-data/setting-live-source.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The bridge between the live engine state (read reactively via useBitfieldData)
// and the descriptor-parsing SSOT (read-notifications-policy.ts). It does two
// generic, descriptor-driven jobs:
//
//   1. buildCurrentValueSelector(descriptor) → the data-layer selector that the
//      envelope hands to useBitfieldData to subscribe to the CURRENT value rows.
//      The feed label/address and source fall straight out of the descriptor's
//      `value` block — no domain literal is named here.
//
//   2. currentRecordsFromEntry(entry) → normalize whatever the data layer
//      returns (an array of property rows, a single row, or null) into the
//      `currentRecords: unknown[]` shape that readNotificationsPolicy already
//      knows how to resolve a current option id from.
//
// This file owns NO truth: the descriptor owns the routing data, and the policy
// reader owns the resolution logic. This is purely a generic adapter so the web
// and iOS envelopes stay thin and identical (SSOT preserved — L098 translation,
// not duplication).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary. The feed label, address, property ids, and keys are
//    all read from the descriptor at runtime; no mode key appears in source.
// 2. The selector input kinds are the generic runtime-kit data-read protocol
//    (the same kinds the shared settings list uses), not notification Society.
// 3. Pure data shaping only — no I/O, no DOM, no window. Safe in iOS JSCore.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

type JsonRecord = Record<string, unknown>;

/**
 * The data-layer subscription descriptor handed to useBitfieldData. Mirrors the
 * generic runtime-kit value-read protocol: a labelled feed or an addressed feed.
 */
export interface SettingValueSelector {
  input: 'control-value-by-label' | 'control-value-by-address';
  params: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function descriptorValueBlock(descriptor: unknown): JsonRecord {
  if (!isRecord(descriptor)) return {};
  return isRecord(descriptor.value) ? descriptor.value : {};
}

/**
 * Build the live-value selector from the descriptor's `value` block. Prefers an
 * explicit feed address, falling back to the feed label. Returns null when the
 * descriptor names no live feed (a default-only setting) — the envelope then
 * resolves the current option from the descriptor default alone.
 */
export function buildCurrentValueSelector(descriptor: unknown): SettingValueSelector | null {
  const value = descriptorValueBlock(descriptor);
  const feedAddress = text(value.feed_address ?? value.feedAddress);
  if (feedAddress) {
    return { input: 'control-value-by-address', params: { feed_address: feedAddress } };
  }
  const feedLabel = text(value.feed_label ?? value.feedLabel);
  if (feedLabel) {
    return { input: 'control-value-by-label', params: { feed_label: feedLabel } };
  }
  return null;
}

/**
 * Normalize a useBitfieldData entry into the `currentRecords` array the policy
 * reader resolves a current option id from. An array passes through; a single
 * row is wrapped; null/undefined becomes an empty list (reader falls back to the
 * descriptor default).
 */
export function currentRecordsFromEntry(entry: unknown): unknown[] {
  if (Array.isArray(entry)) return entry;
  if (entry == null) return [];
  return [entry];
}
