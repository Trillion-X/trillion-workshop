// packages/background-runner-control/read-data/read-background-runner-cli-registry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure payload adapter for canonical cli_registry capability data.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure decode only — no React, no workflow writes, no local store
// 2. Feed identity comes from package data descriptors — no handwritten multihashes
// 3. Canonical ownership remains on cli_registry facts and workflow refresh
//
// =============================================================================

import type { BackgroundRunnerCliInfo } from '@/packages/background-runner-control/read-data/background-runner-cli-types';

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function convertRowToCliInfo(row: Record<string, unknown>): BackgroundRunnerCliInfo {
  return {
    cli: typeof row.cli === 'string' ? row.cli : '',
    displayName:
      typeof row.display_name === 'string'
        ? row.display_name
        : typeof row.displayName === 'string'
          ? row.displayName
          : '',
    version: typeof row.version === 'string' ? row.version : '',
    accounts: Array.isArray(row.accounts) ? row.accounts : [],
    models: Array.isArray(row.models) ? row.models : [],
    providerIds: asStringArray(row.provider_ids),
  };
}

function cliRegistryConverter(rows: Array<Record<string, unknown>>): BackgroundRunnerCliInfo[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(convertRowToCliInfo);
}

export function decodeBackgroundRunnerCliRegistryFeed(raw: unknown): BackgroundRunnerCliInfo[] {
  if (!Array.isArray(raw)) return [];

  const grouped = new Map<string, Record<string, unknown>>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const subjectId = typeof row.subject_id === 'string' ? row.subject_id : null;
    const propertyId = typeof row.property_id === 'string' ? row.property_id : null;
    if (!subjectId || !propertyId) continue;

    const current = grouped.get(subjectId) ?? {};
    const value = row.value;
    if (propertyId === 'prop:cli_registry:cli') {
      current.cli = value;
    } else if (propertyId === 'prop:cli_registry:display_name') {
      current.display_name = value;
    } else if (propertyId === 'prop:cli_registry:version') {
      current.version = value;
    } else if (propertyId === 'prop:cli_registry:accounts') {
      current.accounts = value;
    } else if (propertyId === 'prop:cli_registry:models') {
      current.models = value;
    } else if (propertyId === 'prop:cli_registry:provider_ids') {
      current.provider_ids = value;
    }
    grouped.set(subjectId, current);
  }

  return cliRegistryConverter(Array.from(grouped.values()));
}
