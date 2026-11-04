// tools/tours-screen/read-data/rows-write-through-keep.mjs
//
// PURPOSE
//   What `#workspace-records` is when this tool's rows run in Node (package.json `imports`, condition `node`). On the
//   page it is the workspace's label-addressed records (the host's src/workspace/records.ts). A row has no page: it reads
//   through the records door and answers `keep`, the records to write, which the page's generic records write or a
//   grant the person gives keeps. So the pure parts of do-work/walkthrough-progress.ts (readProgressRecord,
//   applyProgressTransition) load here, and its page writers say plainly that they cannot run.
//
const noPage = name => () => {
  throw new Error(`${name} is the page's records writer; a row answers keep instead, and the page or a write the person grants keeps it.`);
};
export const buildEngineReadCurrentRequestFromLabels = noPage('buildEngineReadCurrentRequestFromLabels');
export const buildEngineWriteBatchRequestFromLabels = noPage('buildEngineWriteBatchRequestFromLabels');
export const decodeEngineReadCurrentReply = noPage('decodeEngineReadCurrentReply');
export const readSavedRecordFromOwner = noPage('readSavedRecordFromOwner');
export const savedRecordWritesAreReadOnly = () => true;
export const sendRequestToBitfieldTarget = noPage('sendRequestToBitfieldTarget');
export const trackSavedRecordAcceptance = noPage('trackSavedRecordAcceptance');
