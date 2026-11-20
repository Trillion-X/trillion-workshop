// computer/diagnostics.mjs
//
// PURPOSE
//   Lets a hosted page cause a diagnostics upload without ever seeing or redirecting the data: `prepare` holds this Mac's sealed
//   host log (computer/host-log.mjs writes it, computer/sealed-log.mjs seals it, so these bytes are unreadable here and open only for
//   the holder of the reader's private key) and tells the page its id and size; `send` uploads that held file to a signed storage slot
//   the page hands over, after computer/guarded-upload.mjs has checked the slot against its destination rows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which file is the diagnostics file is mac-tools.json host_log.sealed.file; where it may go is guarded-upload.json.
//   2. Only the sealed file is ever offered: nothing is decrypted, and a Mac whose host log is off (no reader key) has nothing to send.
//   3. The page learns an id and a size, never the bytes; a refused slot does not use the held file up.
//
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeGuardedUploads } from './guarded-upload.mjs';
import { settingsOf } from './mac-tools.mjs';

export function makeDiagnostics({ settings = settingsOf(), home = homedir(), uploads = makeGuardedUploads() } = {}) {
  return {
    prepare() {
      const file = join(home, settings.host_log.sealed.file);
      let bytes;
      try { bytes = readFileSync(file); } catch { throw Object.assign(new Error(settings.words.no_diagnostics), { status: 404, retry: false }); }
      return uploads.prepare({ bytes, contentType: settings.host_log.sealed.content_type, name: 'host.sealed.log' });
    },
    send: input => uploads.send(input ?? {}),
  };
}

let shared = null;
const diagnosticsHere = () => (shared ??= makeDiagnostics());
export const diagnosticsTools = { prepare: () => diagnosticsHere().prepare(), send: input => diagnosticsHere().send(input) };
