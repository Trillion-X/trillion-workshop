/** Logical history returned by the admitted record owner. It is never a credential, path or supply name. */
export type RecordScope = Readonly<{ id: string; incarnation: string; generation: number }>;
export type RecordContext = Readonly<{ generation: number }>;
/** Reject incomplete history rather than accidentally issuing the same id to the base namespace. */
export function recordScope(value: unknown): RecordScope {
  const scope = value as Partial<RecordScope> | null;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).some(key => !['id', 'incarnation', 'generation'].includes(key))
    || typeof scope.id !== 'string' || !scope.id.trim() || /[\u0000-\u001f\u007f]/.test(scope.id)
    || typeof scope.incarnation !== 'string' || !scope.incarnation.trim() || /[\u0000-\u001f\u007f]/.test(scope.incarnation)
    || !Number.isSafeInteger(scope.generation) || scope.generation! < 1) {
    throw new Error('The record history is incomplete. Read its current reference again.');
  }
  return { id: scope.id, incarnation: scope.incarnation, generation: scope.generation! };
}
export const sameRecordScope = (a: RecordScope, b: RecordScope) => a.id === b.id && a.incarnation === b.incarnation && a.generation === b.generation;
