// Resolve Write's document address from its existing place. Company pages use the same
// live room owner as board documents; personal pages retain their personal address.
export function writeScreenInput(input = {}, { sharedPlace, sharedScene }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The document could not open.');
  if (input.space_id === undefined || input.space_id === null) return { ...input };
  const space = typeof input.space_id === 'string' ? input.space_id.trim() : '';
  if (!space || space.includes('/') || !sharedPlace || !sharedScene) throw new Error('This pursuit could not open its documents.');
  const prefix = sharedPlace + space + '/';
  const scene = input.scene_address;
  if (scene !== undefined && (typeof scene !== 'string' || !scene.startsWith(prefix) || scene.length <= prefix.length)) {
    throw new Error('Open this document from the place it belongs to.');
  }
  return { ...input, scene_address: scene ?? prefix + sharedScene };
}
