// tools/keep-my-records-on-this-device/do-work/pack-a-settle-upload.mjs
//
// The part of keeping a copy on a device that runs without a browser: where one account's copy is kept, and the exact
// upload its copy would post when it settles a batch with the account. Given `account` (the signed-in account name)
// and `request` (one settle batch, the JSON record-sync.mjs sends), it answers the copy's place (account-copy.mjs
// accountCopyLocation: the private-file-system directory and file name), the headers the post carries (the account
// header, and for a frame the frame's content type, dictionary and size), whether the batch goes as a compressed frame
// (frame-compression.mjs, against the sample of settle JSON in frame-dictionaries.json) or as plain JSON, the sizes
// both ways, the body (base64 for a frame, the text for plain) and whether the frame expands back to exactly the batch.
//
// Refuses an account that is empty, not text or longer than 256 characters, and a request that is not a JSON object.
// It opens no database, sends nothing and keeps nothing.
import { DEVICE_ACCOUNT_HEADER, accountCopyLocation } from './account-copy.mjs';
import { compressFrame, expandFrame } from './frame-compression.mjs';

export function packSettleUpload({ account, request } = {}) {
  if (typeof account !== 'string' || !account || account.length > 256) {
    throw new Error('Give account: the signed-in account name as text, 1 to 256 characters.');
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Give request: one settle batch as a JSON object (for example { copy, root, took_through, rows }).');
  }
  const location = accountCopyLocation(account);
  const text = JSON.stringify(request);
  const plain_bytes = new TextEncoder().encode(text).length;
  const frame = compressFrame(text);
  const headers = { 'content-type': 'application/json', [DEVICE_ACCOUNT_HEADER]: account, ...frame?.headers };
  if (!frame) return { location, sends: 'plain', headers, plain_bytes, sent_bytes: plain_bytes, body: text, expands_back: true };
  const expanded = expandFrame(frame.body, new Headers(frame.headers), { max_expanded_bytes: plain_bytes });
  return {
    location, sends: 'frame', headers, plain_bytes, sent_bytes: frame.body.length,
    body_base64: Buffer.from(frame.body).toString('base64'), expands_back: expanded === text,
  };
}
