// tools/coordination-sessions/read-data/session-catalog.ts
//
// The catalog of what a person offers: one entry names the groups that own it, the sessions it offers, who may see it
// (a reference to the person's own visibility rule), how it is recommended, what it crosses over to, and where it is
// shown. An entry is current until it is superseded or retracted. Every function takes entries and returns the next.
// Who may see an entry, and in what order entries are recommended, are the person's own rules and are not decided here.
import type { JsonValue } from '../do-work/session-lifecycle.ts';

export interface CatalogPolicyDescriptor {
  policy_ref: string;
  data?: Record<string, JsonValue>;
}

export interface CrossOfferRelation {
  target_catalog_entry_ref: string;
  relation_descriptor_ref: string;
  rule_data?: Record<string, JsonValue>;
}

export interface SessionCatalogEntry {
  catalog_entry_id: string;
  owning_group_refs: string[];
  session_refs: string[];
  catalog_visibility_predicate: CatalogPolicyDescriptor;
  recommendation_policy_ref: string;
  cross_offer_policy: CrossOfferRelation[];
  presentation_surface_refs: string[];
  superseded_by?: string;
  retracted_at?: string;
  retraction_reason_ref?: string;
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function validateSessionCatalogEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
  requireText(entry.catalog_entry_id, 'catalog_entry_id');
  if (entry.owning_group_refs.length === 0) throw new Error('owning_group_refs must contain at least one group reference');
  if (entry.session_refs.length === 0) throw new Error('session_refs must contain at least one session reference');
  entry.owning_group_refs.forEach((value, index) => requireText(value, `owning_group_refs[${index}]`));
  entry.session_refs.forEach((value, index) => requireText(value, `session_refs[${index}]`));
  requireText(entry.catalog_visibility_predicate.policy_ref, 'catalog_visibility_predicate.policy_ref');
  requireText(entry.recommendation_policy_ref, 'recommendation_policy_ref');
  return entry;
}

export function publishSessionCatalogEntry(input: SessionCatalogEntry): SessionCatalogEntry {
  return validateSessionCatalogEntry({
    ...input,
    owning_group_refs: unique(input.owning_group_refs),
    session_refs: unique(input.session_refs),
    cross_offer_policy: [...input.cross_offer_policy],
    presentation_surface_refs: unique(input.presentation_surface_refs),
  });
}

export function currentSessionCatalogEntries(entries: readonly SessionCatalogEntry[]): SessionCatalogEntry[] {
  return entries.filter((entry) => !entry.superseded_by && !entry.retracted_at);
}

export interface ReadCatalogOptions {
  catalog_entry_refs?: string[];
  session_refs?: string[];
}

export function readSessionCatalog(
  entries: readonly SessionCatalogEntry[],
  options: ReadCatalogOptions = {},
): SessionCatalogEntry[] {
  const requestedEntries = new Set(options.catalog_entry_refs ?? []);
  const requestedSessions = new Set(options.session_refs ?? []);
  return currentSessionCatalogEntries(entries).filter((entry) => {
    if (requestedEntries.size > 0 && !requestedEntries.has(entry.catalog_entry_id)) return false;
    if (requestedSessions.size > 0 && !entry.session_refs.some((sessionRef) => requestedSessions.has(sessionRef))) return false;
    return true;
  });
}

export function updateSessionCatalogEntry(entry: SessionCatalogEntry, patch: Partial<Omit<SessionCatalogEntry, 'catalog_entry_id'>>): SessionCatalogEntry {
  return publishSessionCatalogEntry({
    ...entry,
    ...patch,
    catalog_entry_id: entry.catalog_entry_id,
  });
}

export function retractSessionCatalogEntry(entry: SessionCatalogEntry, retractedAt: string, reasonRef: string): SessionCatalogEntry {
  requireText(retractedAt, 'retracted_at');
  requireText(reasonRef, 'retraction_reason_ref');
  return validateSessionCatalogEntry({ ...entry, retracted_at: retractedAt, retraction_reason_ref: reasonRef });
}

export function supersedeSessionCatalogEntry(predecessor: SessionCatalogEntry, successor: SessionCatalogEntry): { predecessor: SessionCatalogEntry; successor: SessionCatalogEntry } {
  if (predecessor.catalog_entry_id === successor.catalog_entry_id) throw new Error('successor must have a distinct catalog_entry_id');
  return {
    predecessor: validateSessionCatalogEntry({ ...predecessor, superseded_by: successor.catalog_entry_id }),
    successor: publishSessionCatalogEntry(successor),
  };
}

export function crossOfferSessionCatalogEntry(entry: SessionCatalogEntry, relation: CrossOfferRelation): SessionCatalogEntry {
  requireText(relation.target_catalog_entry_ref, 'cross_offer_policy.target_catalog_entry_ref');
  requireText(relation.relation_descriptor_ref, 'cross_offer_policy.relation_descriptor_ref');
  const remaining = entry.cross_offer_policy.filter((candidate) => candidate.target_catalog_entry_ref !== relation.target_catalog_entry_ref);
  return updateSessionCatalogEntry(entry, { cross_offer_policy: [...remaining, relation] });
}
