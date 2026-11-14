export type SurfaceOutput = {
  name: string;
  value: unknown;
  revision?: string;
  sequence?: number;
};

export type SurfaceOutputEventDetail = SurfaceOutput & {
  source_surface_id: string;
  generation: number;
};

function metadata(surfaceInput: unknown): { sourceSurfaceId: string; generation: number } | null {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return null;
  const candidate = (surfaceInput as Record<string, unknown>).__surface_output;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (typeof value.source_surface_id !== 'string' || !value.source_surface_id.trim()) return null;
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0) return null;
  return { sourceSurfaceId: value.source_surface_id, generation: Number(value.generation) };
}

export function buildSurfaceOutputDispatcher<Output extends SurfaceOutput = SurfaceOutput>(
  element: HTMLElement,
  surfaceInput: unknown,
): ((output: Output) => void) | undefined {
  const meta = metadata(surfaceInput);
  if (!meta) return undefined;
  return (output: Output) => {
    if (!output || typeof output.name !== 'string' || !output.name.trim()) return;
    element.dispatchEvent(new CustomEvent<SurfaceOutputEventDetail>('bitfield:surface-output', {
      bubbles: true,
      composed: true,
      detail: {
        source_surface_id: meta.sourceSurfaceId,
        generation: meta.generation,
        ...output,
      },
    }));
  };
}
