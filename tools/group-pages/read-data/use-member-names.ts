import { useMemo } from 'react';
import { isAdmittedProjectionScope, type AdmittedProjectionScope } from './read-group-page.ts';

export function foldMemberNames(items: Array<Record<string, unknown>>, scope: AdmittedProjectionScope) {
  if (!isAdmittedProjectionScope(scope)) return new Map<string, string>();
  const values = new Map<string, string>();
  for (const item of items) {
    if (item.scope_ref !== scope.subject_ref) continue;
    try {
      let request: unknown = item.value_json;
      while (typeof request === 'string') request = JSON.parse(request);
      if (request && typeof request === 'object' && (request as Record<string, unknown>).field === 'name') {
        const row = request as Record<string, unknown>;
        if (typeof row.actor_ref === 'string' && typeof row.value === 'string' && row.value.trim()) values.set(row.actor_ref, row.value.trim());
      }
    } catch { /* malformed owner-projected profile record */ }
  }
  return values;
}

/** The server supplies this already-admitted, subject-scoped projection. */
export function useMemberNames(projection: unknown, scope: AdmittedProjectionScope | null) {
  return useMemo(
    () => Array.isArray(projection) && scope ? foldMemberNames(projection.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)), scope) : new Map<string, string>(),
    [projection, scope],
  );
}
