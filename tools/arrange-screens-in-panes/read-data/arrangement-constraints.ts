/** Presentation limits supplied by the shared `arrangement` show-rule subject. */
export type ArrangementConstraints = {
  max_containers?: number;
  max_tabs?: number;
  allowed_surfaces?: string[];
};

export const UNRESTRICTED_ARRANGEMENT_CONSTRAINTS: ArrangementConstraints = {};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read only the generic cardinality/geometry fields owned by screen arrangement. */
export function readArrangementConstraints(value: unknown): ArrangementConstraints {
  if (value === undefined || value === null) return UNRESTRICTED_ARRANGEMENT_CONSTRAINTS;
  if (!record(value)) throw new Error('Arrangement limits could not be read.');
  const output: ArrangementConstraints = {};
  const maxContainers = value.max_containers;
  const maxTabs = value.max_tabs;
  if (maxContainers !== undefined) {
    if (!Number.isSafeInteger(maxContainers) || (maxContainers as number) < 1) throw new Error('Arrangement limits could not be read.');
    output.max_containers = maxContainers as number;
  }
  if (maxTabs !== undefined) {
    if (!Number.isSafeInteger(maxTabs) || (maxTabs as number) < 1) throw new Error('Arrangement limits could not be read.');
    output.max_tabs = maxTabs as number;
  }
  if (value.allowed_surfaces !== undefined) {
    if (!Array.isArray(value.allowed_surfaces) || value.allowed_surfaces.length === 0
      || value.allowed_surfaces.some(row => row !== 'tiled' && row !== 'floating' && row !== 'overlay')) {
      throw new Error('Arrangement limits could not be read.');
    }
    output.allowed_surfaces = [...new Set(value.allowed_surfaces as string[])];
  }
  if (Object.keys(output).length === 0 && Object.keys(value).length > 0) throw new Error('Arrangement limits could not be read.');
  return Object.keys(output).length ? output : UNRESTRICTED_ARRANGEMENT_CONSTRAINTS;
}

export function hasArrangementConstraints(value: ArrangementConstraints): boolean {
  return value.max_containers !== undefined
    || value.max_tabs !== undefined
    || value.allowed_surfaces !== undefined;
}
