import type { JsonValue } from '../do-work/session-lifecycle-operations';

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
  visual_projection_ref: string;
}

export const CATALOG_OWNER_REFS = {
  access_rule_owner_ref: 'package::access-rule::subject-action-resource-evaluation',
  group_owner_ref: 'package::group::group-membership-operations',
  subject_participant_owner_ref: 'package::subject-participant::participant-relations',
  visual_projection_owner_ref: 'package::visual-database::projection',
  recommendation_owner_ref: 'package::choose-per-observer::selection',
  cross_offer_owner_ref: 'package::funnel-offer-graph::typed-relations',
} as const;

export interface CatalogAccessRequest {
  subject_ref: string;
  action_ref: string;
  access_rule_owner_ref: string;
}

export interface AccessRuleDelegate {
  owner_ref: string;
  evaluate(input: {
    subject_ref: string;
    action_ref: string;
    resource_ref: string;
    predicate_ref: string;
  }): boolean;
}

export interface RecommendationDelegate {
  owner_ref: string;
  rank(entries: SessionCatalogEntry[], observerRef: string, policyRefs: string[]): SessionCatalogEntry[];
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
  requireText(entry.visual_projection_ref, 'visual_projection_ref');
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

/**
 * Runtime Kit invokes a package target as `(input, context)`, so argument two belongs to the
 * runtime and dependency injection starts at argument three. This export previously took
 * `options` in position two, which meant a live invocation would have handed the runtime's
 * context object in as the filter options: no type error, no crash, just a filter reading
 * fields that are not there. `assertPackageTargetSourceUsesRuntimeContextSecond` in
 * `scripts/package-entry-byte-build-lib.mjs` refuses to materialize entry bytes for that shape,
 * which is why this package could not build.
 */
export function readSessionCatalog(
  entries: readonly SessionCatalogEntry[],
  _context?: unknown,
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

export function filterSessionCatalogByAccess(entries: readonly SessionCatalogEntry[], request: CatalogAccessRequest, delegate: AccessRuleDelegate): SessionCatalogEntry[] {
  requireText(request.subject_ref, 'subject_ref');
  requireText(request.action_ref, 'action_ref');
  if (delegate.owner_ref !== request.access_rule_owner_ref) throw new Error('access filtering must use the requested access-rule owner reference');
  return currentSessionCatalogEntries(entries).filter((entry) => delegate.evaluate({
    subject_ref: request.subject_ref,
    action_ref: request.action_ref,
    resource_ref: entry.catalog_entry_id,
    predicate_ref: entry.catalog_visibility_predicate.policy_ref,
  }));
}

export function recommendSessionCatalogEntries(entries: readonly SessionCatalogEntry[], observerRef: string, delegate: RecommendationDelegate): SessionCatalogEntry[] {
  requireText(observerRef, 'observer_ref');
  requireText(delegate.owner_ref, 'recommendation_owner_ref');
  const current = currentSessionCatalogEntries(entries);
  return delegate.rank(current, observerRef, current.map((entry) => entry.recommendation_policy_ref));
}
