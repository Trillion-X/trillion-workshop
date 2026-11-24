// Stand-ins for the modules upload.ts imports besides files-door.mjs and documents-words.json. The test sets `door`:
// `listing` (the folder list_files answers), `listingAnswers` and `lookupAnswers` (successive replies; an Error throws),
// `refuseStart`, `refuseFinish` and `refuseCancel` (an Error or message), and reads back `reads`, `changes` and `finished`.
const emptyDoor = () => ({ listing: { names: [], next_after: null }, listingAnswers: [], lookupAnswers: [], refuseStart: null, refuseFinish: null, refuseCancel: null, reads: [], changes: [], finished: [], lookups: [] });
export const door = emptyDoor();
export const reset = () => Object.assign(door, emptyDoor());
const refusal = error => error instanceof Error ? error : new Error(error);

export const files = {
  read: async (op, args) => {
    door.reads.push({ op, args });
    if (op !== 'list_files') return {};
    const next = door.listingAnswers.length ? door.listingAnswers.shift() : door.listing;
    if (next instanceof Error) throw next;
    return next;
  },
  change: async (op, input) => {
    door.changes.push({ op, input });
    if (op === 'write_file_start' && door.refuseStart) throw refusal(door.refuseStart);
    if (op === 'write_file_cancel' && door.refuseCancel) throw refusal(door.refuseCancel);
    if (op === 'write_file_finish') {
      if (door.refuseFinish) throw refusal(door.refuseFinish);
      const kept = { identity: 'id-new', name: input.name };
      door.finished.push(kept);
      return kept;
    }
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
