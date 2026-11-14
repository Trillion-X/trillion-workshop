// packages/ui/show/reorder-control/reorder-operation.ts
//
// One input-independent order operation. Drag, touch, keyboard, and explicit
// move buttons all produce the same complete ordered-ID result.

export function reorderIds(
  ids: readonly string[],
  movedId: string,
  targetIndex: number,
): string[] {
  const from = ids.indexOf(movedId);
  if (from === -1) return [...ids];
  const without = ids.filter((id) => id !== movedId);
  const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex;
  without.splice(Math.max(0, Math.min(insertAt, without.length)), 0, movedId);
  return without;
}

export function reorderBeforeId(
  ids: readonly string[],
  movedId: string,
  beforeId: string | null,
): string[] {
  const targetIndex = beforeId === null ? ids.length : ids.indexOf(beforeId);
  if (targetIndex < 0 || beforeId === movedId) return [...ids];
  return reorderIds(ids, movedId, targetIndex);
}

export function orderChanged(
  current: readonly string[],
  next: readonly string[],
): boolean {
  return current.length !== next.length
    || next.some((value, index) => value !== current[index]);
}

export function beforeIdForTarget(
  ids: readonly string[],
  targetId: string,
  afterTarget: boolean,
): string | null {
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex < 0) return null;
  return afterTarget ? ids[targetIndex + 1] ?? null : targetId;
}
