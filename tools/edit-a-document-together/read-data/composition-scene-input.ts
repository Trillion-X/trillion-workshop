export type CompositionSceneInput = {
  schema: 'composition-scene-input/v1';
  scene_address: string;
  partition_label: string;
  bound_feed_address_label?: string;
  required_view_access_ref?: string;
  loading_label: string;
  empty_label: string;
  error_label: string;
  floating_frame?: Record<string, unknown>;
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export function parseCompositionSceneInput(raw: unknown): CompositionSceneInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const sceneAddress = text(value.scene_address);
  const partitionLabel = text(value.partition_label);
  if (value.schema !== 'composition-scene-input/v1' || !sceneAddress || !partitionLabel) return null;
  const boundFeedAddress = text(value.bound_feed_address_label);
  const requiredViewAccessRef = text(value.required_view_access_ref);
  return {
    schema: 'composition-scene-input/v1',
    scene_address: sceneAddress,
    partition_label: partitionLabel,
    ...(boundFeedAddress ? { bound_feed_address_label: boundFeedAddress } : {}),
    ...(requiredViewAccessRef ? { required_view_access_ref: requiredViewAccessRef } : {}),
    loading_label: text(value.loading_label) ?? 'Loading…',
    empty_label: text(value.empty_label) ?? 'Nothing has been added yet.',
    error_label: text(value.error_label) ?? 'This view could not load.',
    ...(value.floating_frame && typeof value.floating_frame === 'object' && !Array.isArray(value.floating_frame)
      ? { floating_frame: value.floating_frame as Record<string, unknown> }
      : {}),
  };
}

export function readAccessRefs(raw: unknown): Set<string> {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) { refs.add(value.trim()); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    for (const key of ['access_ref', 'ref', 'value', 'refs', 'access_refs', 'payload']) {
      if (key in row) visit(row[key]);
    }
  };
  visit(raw);
  return refs;
}
