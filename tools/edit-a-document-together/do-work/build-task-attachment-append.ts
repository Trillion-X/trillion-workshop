// packages/documents/do-work/build-task-attachment-append.ts
//
// Pure builder for the visual-database-native "attach a note to a task": append the
// note as an entry on the TASK record's `payload.attachments` array. visual-database
// already renders that field (its `record-attachments` descriptor, role:'attachment',
// writePath payload.attachments) — so the note shows on the task in the live board
// with ZERO new display code.
//
// The entry is an OBJECT, not a bare string. visual-database's `readAttachmentRef`
// coerces a bare string into a chip whose visible label IS the string — for a
// note that means the raw `package::documents::…::note::…` address
// leaks into product UI (L114/L118 violation). An object lets visual-database read a
// human `label` (the note's title) for the chip while keeping the openable
// `address` (inline-loads the live note) and the exported `filePath` (reveal the
// MD in Finder) as the click targets — internal addressing stays in storage.
//
// This is a pure read-modify-write shape: given the task's current published
// record and the note, produce the next `attachments` array (idempotent — the
// same note is never appended twice) and the addressed write the live path will
// apply under a CAS guard. No I/O here; the engine write happens in the composer
// that consumes this.

export type TaskRecord = {
  readonly address: string;
  readonly payload: Record<string, unknown>;
};

// A visual-database attachment entry for an authored note. `label` is what the user
// reads on the chip; `address`/`filePath` are what visual-database opens/reveals.
export type NoteAttachment = {
  readonly label: string;
  readonly address: string;
  readonly kind: 'log-ref';
  readonly source: 'documents';
  readonly filePath?: string;
};

export type TaskAttachmentWrite = {
  readonly address: string;
  readonly payload: Record<string, unknown>;
  readonly attachments: readonly unknown[];
  readonly changed: boolean;
};

// Existing attachments can be any shape visual-database tolerates (legacy bare
// strings from earlier writes, or objects) — preserve every entry verbatim.
function existingAttachments(payload: Record<string, unknown>): unknown[] {
  const raw = payload.attachments;
  return Array.isArray(raw) ? [...raw] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Stable identity for de-duplication: an attachment is "the same" when it points
// at the same note. Mirror the fields visual-database keys an attachment on so a
// legacy bare-string ref and the new object for the same note collapse to one.
function attachmentKey(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (isRecord(entry)) {
    for (const k of ['address', 'ref', 'log_address', 'filePath', 'file_path', 'path', 'url', 'id']) {
      const v = entry[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

// Build the note's attachment entry: a human `label` (the note title) over the
// openable surface `address`, with the exported MD `filePath` when one exists.
export function noteAttachmentRefs(input: {
  surfaceAddress: string;
  title: string;
  filePath?: string;
}): NoteAttachment[] {
  const label = input.title.replace(/\s+/g, ' ').trim() || 'Authored note';
  const filePath = input.filePath && input.filePath.trim() ? input.filePath.trim() : undefined;
  return [{
    label,
    address: input.surfaceAddress,
    kind: 'log-ref',
    source: 'documents',
    ...(filePath ? { filePath } : {}),
  }];
}

export function buildTaskAttachmentAppend(
  task: TaskRecord,
  refs: readonly unknown[],
): TaskAttachmentWrite {
  const current = existingAttachments(task.payload);
  const seen = new Set(current.map(attachmentKey).filter(Boolean));
  const additions = refs.filter((ref) => {
    const key = attachmentKey(ref);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const attachments = additions.length ? [...current, ...additions] : current;
  return {
    address: task.address,
    // Copy the whole payload and overwrite ONLY attachments — never drop the
    // task's other fields (title, status, parent, …). visual-database reads the
    // full record back; a partial payload would erase the task.
    payload: { ...task.payload, attachments },
    attachments,
    changed: additions.length > 0,
  };
}
