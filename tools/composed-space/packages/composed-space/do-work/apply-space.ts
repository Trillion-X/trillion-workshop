import { saveSpace, type SaveSpaceRequest } from './save-space';

/** Kept as a caller-language convenience; descriptor fields are revisioned, never an aggregate config object. */
export function applySpaceDescriptor(request: SaveSpaceRequest, mintSpaceRef: () => string) { return saveSpace(request, mintSpaceRef); }
