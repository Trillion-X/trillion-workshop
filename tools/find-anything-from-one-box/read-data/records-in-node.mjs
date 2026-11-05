// tools/find-anything-from-one-box/read-data/records-in-node.mjs
//
// PURPOSE
//   What `#workspace-records` is when this folder's code runs in Node (package.json `imports`, condition `node`), the
//   way tools/tours-screen/read-data/rows-write-through-keep.mjs is for that tool. On the page it is the workspace's
//   label-addressed records (the host's src/workspace/records.ts), which sends the request; Node has no page, so the
//   sender throws, saying so, and the pure readers (readPaletteBulkActionDescriptorsFromReply) load and run.
//
export const sendRequestToBitfieldTarget = () => {
  throw new Error("sendRequestToBitfieldTarget needs the page's workspace records (src/workspace/records.ts); in Node, read a reply with readPaletteBulkActionDescriptorsFromReply instead.");
};
