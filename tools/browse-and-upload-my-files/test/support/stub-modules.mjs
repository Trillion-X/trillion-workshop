// Stand-ins for the modules upload.ts imports besides files-door.mjs and documents-words.json. The test sets `door`:
// `listing` (the folder list_files answers), `lookupAnswers` (what readFileLookup answers, in order; an Error throws),
// `refuseStart` (a message write_file_start throws) and it reads back `reads` and `changes`.
export const door = { listing: { names: [], next_after: null }, lookupAnswers: [], refuseStart: null, reads: [], changes: [], lookups: [] };
export const reset = () => Object.assign(door, { listing: { names: [], next_after: null }, lookupAnswers: [], refuseStart: null, reads: [], changes: [], lookups: [] });

export const files = {
  read: async (op, args) => {
    door.reads.push({ op, args });
    return op === 'list_files' ? door.listing : {};
  },
  change: async (op, input) => {
    door.changes.push({ op, input });
    if (op === 'write_file_start' && door.refuseStart) throw new Error(door.refuseStart);
    if (op === 'write_file_finish') return { identity: 'id-new', name: input.name };
    return {};
  },
};
export const readFileLookup = async name => {
  door.lookups.push(name);
  const next = door.lookupAnswers.shift();
  if (next instanceof Error) throw next;
  return next ?? null;
};
export const postJson = async () => ({});
export const readJson = async () => ({});
export class PlanNeeded extends Error {}
export class SendProblem extends Error {}
export const loadChunking = async () => ({});
export const needsPlanTitle = () => false;
export const readOrMakePreview = async () => null;
export const previewStore = {};
export const partsProgress = () => ({});
export const errorWords = error => String(error?.message ?? error);
export const sendProblemKind = () => null;
export default '';
