type UnknownRow = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRow | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRow
    : null;
}

function selectedIdFromRow(value: unknown): string | null {
  const row = record(value);
  if (!row) return null;
  const direct = row.selectedAgentId ?? row.selected_agent_id;
  if (typeof direct === 'string') return direct.trim();
  return selectedIdFromRow(row.data) ?? selectedIdFromRow(row.row) ?? selectedIdFromRow(row.payload);
}

/** Decode the selected-agent input projection without assuming a transport wrapper. */
export function readSelectedAgentId(value: unknown): string {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const selected = selectedIdFromRow(value[index]);
      if (selected !== null) return selected;
    }
    return '';
  }
  return selectedIdFromRow(value) ?? '';
}

/** Only owner-addressed workflow actions may be supplied by the surface DATA. */
export function readSelectedAgentAction(value: unknown, fallback: string): string {
  const input = record(value);
  const candidate = input?.selection_action_ref;
  return typeof candidate === 'string' && candidate.startsWith('action:')
    ? candidate
    : fallback;
}
