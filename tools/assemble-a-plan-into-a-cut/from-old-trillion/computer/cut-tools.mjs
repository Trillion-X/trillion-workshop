// computer/cut-tools.mjs
//
// The Mac host loads a tool's module only from this folder (src/manifest-permissions.mjs confinedEntry), so the media cut
// (parts/media-composition/do-work/cut-the-action.mjs) is offered to it through this one line.
export { cutTools } from '../parts/media-composition/do-work/cut-the-action.mjs';
