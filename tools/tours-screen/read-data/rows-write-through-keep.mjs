// tools/tours-screen/read-data/rows-write-through-keep.mjs
//
// PURPOSE
//   What `#workspace-records` is when this tool's rows run in Node (package.json `imports`, condition `node`). On the
//   page it is the workspace's label-addressed records (the host's src/workspace/records.ts). A row has no page and no records
//   door: it works over the records handed in its request and answers `keep`, the records it would write, for the
//   caller to keep. So the pure parts of do-work/walkthrough-progress.ts (readProgressRecord,
//   applyProgressTransition) load here, and its page writers say plainly that they cannot run.
//
const noPage = name => () => {
  throw new Error(`${name} is the page's records writer; a row answers keep instead, and the caller keeps it.`);
};
export const buildEngineReadCurrentRequestFromLabels = noPage('buildEngineReadCurrentRequestFromLabels');
export const buildEngineWriteBatchRequestFromLabels = noPage('buildEngineWriteBatchRequestFromLabels');
export const decodeEngineReadCurrentReply = noPage('decodeEngineReadCurrentReply');
export const readSavedRecordFromOwner = noPage('readSavedRecordFromOwner');
export const savedRecordWritesAreReadOnly = () => true;
export const sendRequestToBitfieldTarget = noPage('sendRequestToBitfieldTarget');
export const trackSavedRecordAcceptance = noPage('trackSavedRecordAcceptance');
