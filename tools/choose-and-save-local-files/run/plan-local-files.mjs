// tools/choose-and-save-local-files/run/plan-local-files.mjs
//
// Choosing files on a person's computer and saving copies back, as the requests the Mac's local.files target gets:
// do-work/choose-local-files.ts's chooseLocalFiles and do-work/save-local-file-copy.ts's saveLocalFileCopy, run with the
// workspace's sender stood in by requests-kept-here.mjs. Every request is kept, unsent, and answered as the Mac answers
// it: for choose, with the picker's reply handed in; for save, as a Mac that wrote and read back the new file would,
// so the save's own checks (a new name that never replaces a file, the bytes read back the same) run. Nothing on any
// computer is opened, picked, written or read. The row lays do-work/ and read-data/ under run/, so their
// #workspace-records import (run/package.json) resolves in the run.
//
// Input, one of:
//   { operation: "choose", picker_reply: { cancelled?, files: [{ path, name, byte_length, content_type, bytes_base64? }] },
//     prompt?, multiple?, include_bytes?, allowed_extensions?, allowed_content_prefixes? }
//   { operation: "save", file_name, content_base64, copy_id, directory?, home? }   directory: the folder to save into
//     (the home folder's Downloads when left out, with home standing in for the Mac's own answer to where home is)
// Answer: { operation, requests: [{ target, payload }], files? (choose: [{ path, name, byte_length, content_type,
//   has_bytes }]), path? (save: where the copy goes) }.
// Refuses an operation it does not know, a picker reply that is not an object, and whatever the part refuses (a file
// not of an accepted type, a name with a slash, a folder that is not a full path, more than 16 MB to save).
import { chooseLocalFiles } from './do-work/choose-local-files.ts';
import { saveLocalFileCopy } from './do-work/save-local-file-copy.ts';
import { answerWith, kept } from './requests-kept-here.mjs';

// The local.files reply envelope: { payload: bytes of the JSON reply }.
const envelope = reply => ({ payload: new TextEncoder().encode(JSON.stringify(reply)) });
const shown = request => ({ target: request.target, payload: request.payload });

async function choose(input) {
  const reply = input.picker_reply;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Give picker_reply: what the picker answered, { cancelled?, files: [{ path, name, byte_length, content_type, bytes_base64? }] }.');
  answerWith(request => envelope({ success: true, operation: request.payload.operation, ...reply }));
  const files = await chooseLocalFiles({
    prompt: input.prompt, multiple: input.multiple, includeBytes: input.include_bytes,
    allowedExtensions: input.allowed_extensions, allowedContentPrefixes: input.allowed_content_prefixes,
  });
  return { files: files.map(file => ({ path: file.path, name: file.name, byte_length: file.byteLength, content_type: file.contentType, has_bytes: Boolean(file.bytes) })) };
}

async function save(input) {
  if (typeof input.content_base64 !== 'string') throw new Error('Give content_base64: the bytes of the copy, as base64.');
  const bytes = Uint8Array.from(atob(input.content_base64), char => char.charCodeAt(0));
  const written = new Map();
  answerWith(({ payload }) => {
    if (payload.operation === 'roots') {
      if (typeof input.home !== 'string') throw new Error('Give directory (a full folder path), or home for the Downloads folder in it.');
      return envelope({ success: true, operation: 'roots', home: input.home });
    }
    if (payload.operation === 'write_new_file') {
      if (written.has(payload.path)) return envelope({ success: false, operation: 'write_new_file', error: 'A file already has that name.' });
      written.set(payload.path, payload.content_base64);
      return envelope({ success: true, operation: 'write_new_file', path: payload.path });
    }
    const content = written.get(payload.path) ?? '';
    return envelope({ success: true, operation: 'read_file', files: [{ path: payload.path, name: payload.path.split('/').pop(), byte_length: atob(content).length, content_type: 'application/octet-stream', bytes_base64: content }] });
  });
  const path = await saveLocalFileCopy({ fileName: input.file_name, bytes, directory: input.directory, copyId: input.copy_id });
  return { path };
}

const OPERATIONS = { choose, save };

export async function planLocalFiles(input = {}) {
  const run = OPERATIONS[input.operation];
  if (!run) throw new Error(`Give operation: one of ${Object.keys(OPERATIONS).join(', ')}.`);
  kept.length = 0;
  const answer = await run(input);
  // A save's own request carries the copy's bytes; the answer names them by length, not again in full.
  const requests = kept.map(shown).map(({ target, payload }) => ({ target, payload: payload.content_base64 ? { ...payload, content_base64: `${atob(payload.content_base64).length} bytes` } : payload }));
  return { operation: input.operation, requests, ...answer };
}
