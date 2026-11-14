type SelectedFileFeedRow = {
  property_id?: unknown;
  value?: unknown;
};

function readPathValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readSelectedFilePath(raw: unknown): string | null {
  const direct = readPathValue(raw);
  if (direct) return direct;

  const rows = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is SelectedFileFeedRow =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
  const row = rows.find((entry) => entry.property_id === 'prop:files_selected_file:path');
  return readPathValue(row?.value);
}
