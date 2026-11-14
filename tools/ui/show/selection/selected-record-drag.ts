// A browser drag can carry the whole selected set of shareable records. The source decides which records have a
// share reference; the destination decides what adding those references means. This stays independent of tabs and
// file bytes, so the same selection works across every record view that supplies shareRecord.

export const SELECTED_RECORDS_MIME = 'application/x-selected-records+json';

export type SelectedRecordDrag = {
  records: { id: string; record: string; title: string }[];
  screen?: string;
  context?: { kind: string; id: string };
};

export function setSelectedRecordDragData(transfer: DataTransfer, picked: SelectedRecordDrag): void {
  if (!picked.records.length) return;
  transfer.setData(SELECTED_RECORDS_MIME, JSON.stringify(picked));
  transfer.effectAllowed = 'copyMove';
}

export function hasSelectedRecordDragData(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(SELECTED_RECORDS_MIME);
}

/** A screen accepting selected records owns its visible bounds, even when this drag also opens a file tab. */
export function isOverSelectedRecordDropOwner(transfer: DataTransfer, clientX: number, clientY: number): boolean {
  if (!hasSelectedRecordDragData(transfer)) return false;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-accepts-selected-records]')).some((owner) => {
    const box = owner.getBoundingClientRect();
    return box.width > 0 && box.height > 0
      && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
  });
}

export function readSelectedRecordDragData(transfer: DataTransfer): SelectedRecordDrag | null {
  if (!hasSelectedRecordDragData(transfer)) return null;
  try {
    const value: unknown = JSON.parse(transfer.getData(SELECTED_RECORDS_MIME));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    if (!Array.isArray(source.records) || !source.records.length) return null;
    const valid = source.records.every((item): item is { id: string; record: string; title: string } =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.id === 'string' && item.id
        && typeof item.record === 'string' && item.record
        && typeof item.title === 'string' && item.title));
    if (!valid) return null;
    const records = source.records as SelectedRecordDrag['records'];
    const context = source.context && typeof source.context === 'object' && !Array.isArray(source.context)
      ? source.context as Record<string, unknown> : null;
    return {
      records,
      ...(typeof source.screen === 'string' && source.screen ? { screen: source.screen } : {}),
      ...(context && typeof context.kind === 'string' && context.kind && typeof context.id === 'string' && context.id
        ? { context: { kind: context.kind, id: context.id } } : {}),
    };
  } catch { return null; }
}
