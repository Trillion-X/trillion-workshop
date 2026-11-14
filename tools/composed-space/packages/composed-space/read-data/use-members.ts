import { useEffect, useState } from 'react';
import { isAdmittedSpaceScope, type AdmittedSpaceScope, type ScopedParticipantRow } from './read-composed-spaces';

export type MemberName = { actor: string; name: string; revision: number; stateRef: string; roleRef: string };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** Participation is an independent owner projection; no space descriptor carries a roster. */
export function foldMembers(rows: readonly ScopedParticipantRow[], scope: unknown): MemberName[] {
  if (!isAdmittedSpaceScope(scope)) return [];
  return rows
    .filter((row) => row.subject_ref === scope.subject_ref && text(row.actor_ref))
    .map((row) => ({
      actor: row.actor_ref,
      name: text(row.display_name) || row.actor_ref,
      revision: revision(row.revision),
      stateRef: text(row.state_ref),
      roleRef: text(row.role_ref),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.actor.localeCompare(right.actor));
}

export function useMembers(projection: unknown, scope: AdmittedSpaceScope | null, enabled = true) {
  const [members, setMembers] = useState<MemberName[] | null>(null);
  useEffect(() => {
    if (!enabled) { setMembers([]); return; }
    const source = projection && typeof projection === 'object' && !Array.isArray(projection)
      ? (projection as { participant_rows?: unknown }).participant_rows
      : projection;
    setMembers(Array.isArray(source) && scope ? foldMembers(source as ScopedParticipantRow[], scope) : []);
  }, [enabled, projection, scope]);
  return members;
}
