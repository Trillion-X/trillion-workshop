/** Explicit instance board data must not be replaced by global descriptors. */
export function hasVisualDatabaseBoardInputOverride(surfaceInput: unknown): boolean {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return false;
  return ['records', 'fields', 'views', 'actions', 'gridProperties']
    .some((key) => Object.prototype.hasOwnProperty.call(surfaceInput, key));
}
