// packages/whatsapp-web-connector/do-work/live-shell.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The LIVE shell that wires the tested `runConnector` orchestration (worker.mjs)
// to the REAL capabilities: a Baileys v7 WebSocket socket, the credentials-vault
// session round-trip, and the capture-dir snapshot store. This is the ONLY module
// that imports @whiskeysockets/baileys, so worker.mjs + its tests stay
// dependency-free; the orchestration is proven with fakes, and this shell only
// supplies the concrete socket/vault/store deps.
//
// Runs as a bounded compute.process job (argv below) so the platform's
// process-engine drives it; re-running refreshes the snapshot the file-glob
// observer watches. First run surfaces a QR (JSON line on stdout) for the connect
// surface; subsequent runs restore the vault session and reconnect without a QR.
//
// NO god package: the socket is Baileys (external lib), the session store is
// credentials-vault (injected blob I/O), the ledger is file-glob/observed-content,
// decoding is the decoder. This shell owns ONLY "wire real deps -> runConnector".
//
// CLI (compute.process):
//   node live-shell.mjs --account <id> --capture-dir <dir> --work-dir <dir> \
//                       [--session-blob <path>] [--idle-ms <n>] \
//                       [--pairing-phone <E164 digits>]
//   Emits JSON lines on stdout: {"type":"qr","qr":"..."} while pairing,
//   {"type":"pairing_code","code":"XXXXXXXX"} when --pairing-phone is given
//   (the user types it into WhatsApp → Settings → Linked Devices → Link with
//   phone number — no QR scan; maps onto the connect UI's existing device-code
//   display), then {"type":"summary", ...} on completion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConnector, snapshotFileStore } from './worker.mjs';

/**
 * A `vault` adapter (runConnector's session capability) backed by the Baileys
 * multi-file auth state on disk, packed to / restored from a single opaque blob.
 * The blob move is INJECTED (`readBlob`/`writeBlob`) — production supplies the
 * credentials-vault Envelope calls (address `target:credentials-vault.*`); the
 * default here is a local file so the shell is runnable/inspectable offline.
 *
 * Baileys owns the on-disk creds format (useMultiFileAuthState); we never parse
 * it — we move the whole session dir as an opaque blob, so a Baileys creds-format
 * change never touches this code (L090 — opaque payload).
 */
export async function createVaultSession({ baileys, workDir, readBlob, writeBlob }) {
  const { useMultiFileAuthState } = baileys;
  return {
    // Restore the session dir from the vault blob, then hand Baileys its state.
    async readSession(accountId) {
      const dir = path.join(workDir, String(accountId).replace(/[^\w.-]+/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const blob = await readBlob(accountId);          // opaque bytes or null
      if (blob) restoreDir(dir, blob);
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      return { state, saveCreds, dir };
    },
    // Persist the (Baileys-written) session dir back to the vault as one blob.
    async writeSession(accountId, authSession) {
      const dir = authSession && authSession.dir;
      if (dir && fs.existsSync(dir)) await writeBlob(accountId, packDir(dir));
    },
  };
}

/** Baileys socket factory (runConnector's `createSocket`). authSession is the
 *  {state, saveCreds, dir} from createVaultSession.readSession. Wires saveCreds to
 *  creds.update so the on-disk session stays current; returns a socket whose
 *  `.ev`/`.sendMessage`/`.end` match the orchestration contract. */
export function createBaileysSocketFactory(baileys, waVersion) {
  const makeWASocket = baileys.default || baileys.makeWASocket;
  return async function createSocket(authSession) {
    const sock = makeWASocket({
      auth: authSession.state,
      version: waVersion,
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      // Each WhatsApp pairing REF (the server window the 8-char code is bound to)
      // lives exactly as long as Baileys' qr timer. The library default rotates
      // the ref every ~20s AFTER the first — far too short for a human to open
      // Linked Devices and type the code. Pinning qrTimeout to 60s makes EVERY
      // window the WhatsApp-native 60s, so the code the user sees is valid for
      // the full human-entry window (verified: socket.js:706,720 use qrTimeout
      // for the rotation delay). Pairs with withPairingCode's per-rotation
      // re-request so a run that outlives one window still never dead-ends.
      qrTimeout: 60_000,
    });
    sock.ev.on('creds.update', authSession.saveCreds);
    return sock;
  };
}

// --- opaque session-dir <-> blob (JSON manifest of relative path -> base64) ----
function packDir(dir) {
  const files = {};
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else files[r] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return Buffer.from(JSON.stringify({ v: 1, files }), 'utf8');
}
function restoreDir(dir, blob) {
  let manifest;
  try { manifest = JSON.parse(Buffer.from(blob).toString('utf8')); } catch { return; }
  for (const [rel, b64] of Object.entries(manifest.files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  }
}

/**
 * Non-destructively move an account's session dir + blob into `<workDir>/_discarded/…`
 * (renamed, NEVER deleted, so a mis-classification is fully recoverable). The ONE
 * mechanism both pairing sweeps below share — the sweeps differ only in the
 * predicate that decides WHEN a session is a wedge, never in HOW it is cleared.
 * Returns true when anything was moved. Deps injected for testability.
 */
function sweepSessionAside({ workDir, accountId, blobPath, stamp, fs: fsDep = fs, path: pathDep = path }) {
  const sanitized = String(accountId).replace(/[^\w.-]+/g, '_');
  const dir = pathDep.join(workDir, sanitized);
  const dirExists = fsDep.existsSync(dir);
  const blobExists = blobPath && fsDep.existsSync(blobPath);
  if (!dirExists && !blobExists) return false;

  const discardRoot = pathDep.join(workDir, '_discarded');
  fsDep.mkdirSync(discardRoot, { recursive: true });
  if (dirExists) fsDep.renameSync(dir, pathDep.join(discardRoot, `${sanitized}-${stamp}`));
  if (blobExists) fsDep.renameSync(blobPath, pathDep.join(discardRoot, `${sanitized}-${stamp}.session.json`));
  return true;
}

/**
 * A HALF-PAIRED session is the wedge that makes "Continue with WhatsApp" run
 * ~10s and reset with no code. Baileys writes creds.json with a bound `me`
 * identity the instant a pairing OFFER is accepted, but leaves `registered:false`
 * until the human finishes typing the 8-char code. If that never completes, the
 * next connect restores this stale half-state: Baileys sees a bound identity and
 * attempts a LOGIN (which WhatsApp rejects — "Connection Failure") instead of
 * emitting a fresh `qr` offer, so no pairing code is ever requested.
 *
 * When we are about to pair (a --pairing-phone is present), first move any
 * NOT-`registered:true` session dir + blob aside so Baileys starts clean and
 * mints a fresh offer. A truly `registered:true` session is left untouched here
 * (a paired account must survive) — but note this predicate CANNOT tell a
 * genuinely-linked `registered:true` session from one that registered then failed
 * to finalize (the "couldn't link device" 515 case); on disk both look
 * registered. That second wedge class is closed by `clearIncompletePairing`
 * below, which runs AFTER the pairing attempt where the runtime `paired` flag —
 * the only reliable success discriminant — is known.
 *
 * Returns true when a stale session was cleared. Deps injected for testability.
 */
export function clearUnregisteredSession({ workDir, accountId, blobPath, stamp, fs: fsDep = fs, path: pathDep = path }) {
  const sanitized = String(accountId).replace(/[^\w.-]+/g, '_');
  const credsPath = pathDep.join(pathDep.join(workDir, sanitized), 'creds.json');
  let registered = false;
  try {
    const creds = JSON.parse(fsDep.readFileSync(credsPath, 'utf8'));
    registered = creds && creds.registered === true;
  } catch { /* no creds on disk -> nothing to clear (already clean) */ }
  if (registered) return false;
  return sweepSessionAside({ workDir, accountId, blobPath, stamp, fs: fsDep, path: pathDep });
}

/**
 * The category fix for the wedge `clearUnregisteredSession` cannot see. A pairing
 * transaction only FINALIZES the device link when the socket reaches
 * `connection:'open'` — WhatsApp registers the device (creds `registered:true`)
 * then drops the socket with 515 restartRequired, and the link is only sealed if
 * the client reconnects and opens. If that never happens (515 budget exhausted,
 * terminal close, human never typed the code), the session left on disk is
 * `registered:true` yet DEAD — the next connect restores it, Baileys attempts a
 * LOGIN with a device WhatsApp already tore down, and the run wedges again.
 *
 * On disk this failed-registered session is INDISTINGUISHABLE from a real linked
 * account, so no disk predicate can clear it. The ONLY reliable discriminant is
 * the runtime `paired` flag (reached open) from THIS run's summary. So after any
 * pairing attempt that did NOT reach open, sweep whatever session it left aside —
 * the pairing that didn't finalize never gets to poison the next attempt. A run
 * that DID reach open (`paired === true`) keeps its session. Same non-destructive
 * `_discarded` rename; deps injected for testability.
 *
 * Returns true when an incomplete-pairing session was cleared.
 */
export function clearIncompletePairing({ workDir, accountId, blobPath, stamp, paired, fs: fsDep = fs, path: pathDep = path }) {
  if (paired) return false;   // reached connection:'open' -> the link finalized -> keep it
  return sweepSessionAside({ workDir, accountId, blobPath, stamp, fs: fsDep, path: pathDep });
}

/**
 * Wrap a socket factory so the FIRST pairing offer also requests Baileys'
 * 8-char PAIRING CODE for `phoneNumber` (the user types it into WhatsApp →
 * Settings → Linked Devices → Link with phone number) — the no-QR-scan connect
 * path. This maps onto the connect UI's EXISTING device-code display
 * (ServiceConnectionDialog renders `user_code` for oauth2_device_code flows),
 * so no new QR-image surface is needed.
 *
 * Mechanics: Baileys accepts `requestPairingCode` only while a pairing offer is
 * live (the socket emits `connection.update {qr}` when unregistered). The 8-char
 * code it returns is bound to WhatsApp's rotating pairing REF, NOT an independent
 * TTL — when the ref rotates (every qrTimeout ms), the old code goes stale and
 * WhatsApp rejects a late entry. So this wrapper does NOT latch one code to the
 * first qr and ignore the rest (the "only works if typed in ~20s" bug). Instead
 * it RE-REQUESTS a fresh code on EACH ref rotation (every `qr` event) and emits
 * it; the acquire feed's latest-wins rule always surfaces the newest still-valid
 * code, so the connect window never dead-ends. `requestPairingCode` is safe to
 * call repeatedly (no repeat-call guard in Baileys); the `inFlight` guard only
 * prevents overlapping requests within a single rotation. A registered session
 * never emits `qr`, and we also skip once `creds.registered` flips true, so a
 * paired account never re-requests. Pure decoration: the returned socket is the
 * real one; runConnector's own listeners are untouched (EventEmitter multicast).
 * Injected `emit` so tests observe codes without stdout.
 */
export function withPairingCode(createSocket, phoneNumber, emit) {
  if (!phoneNumber) return createSocket;
  const digits = String(phoneNumber).replace(/[^\d]/g, '');
  return async function createSocketWithPairing(authSession) {
    const sock = await createSocket(authSession);
    let inFlight = false;
    sock.ev.on('connection.update', (u) => {
      if (!u || !u.qr || inFlight) return;
      // Already paired mid-run (code accepted): stop re-requesting.
      if (sock.authState && sock.authState.creds && sock.authState.creds.registered) return;
      inFlight = true;
      Promise.resolve(sock.requestPairingCode(digits))
        .then((code) => emit({ type: 'pairing_code', code, phone: String(phoneNumber) }))
        .catch((e) => emit({ type: 'pairing_code_error', error: String(e && e.message || e) }))
        .finally(() => { inFlight = false; });
    });
    return sock;
  };
}

/**
 * Choose the qr-event sink for a run's connect MODALITY. A run is EITHER a
 * QR-scan connect (no phone) OR a phone-pairing connect (8-char code) — never
 * both. WhatsApp rotates the qr ~every 20s, so if a phone-pairing run surfaced
 * each rotation as a challenge line, the feed's latest-wins rule would clobber
 * the one-time `pairing_code` back to the raw wa.me link URL (the "it shows a
 * URL not a code" bug). So the producer surfaces ONLY the challenge its modality
 * operates in: qr-scan -> emit the qr challenge; phone-pairing -> the qr is an
 * internal Baileys detail, routed to `diag` (stderr provenance, length not the
 * linking token). The feed lens reads only stdout/display, so diag never
 * surfaces as a challenge.
 */
export function selectQrEmitter({ pairingMode, emit, diag }) {
  return pairingMode
    ? (qr) => diag({ type: 'qr_suppressed_pairing_mode', qr_len: String(qr).length })
    : (qr) => emit({ type: 'qr', qr });
}

// Default file-backed blob I/O (offline). Production injects the credentials-vault
// Envelope calls instead (target:credentials-vault.read/write, opaque payload).
function fileBlobIO(blobPath) {
  return {
    readBlob: async () => { try { return fs.readFileSync(blobPath); } catch { return null; } },
    writeBlob: async (_id, blob) => { fs.mkdirSync(path.dirname(blobPath), { recursive: true }); fs.writeFileSync(blobPath, blob); },
  };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const accountId = args.account || 'whatsapp:default';
  const captureDir = args['capture-dir'] || path.join(os.homedir(), '.bitfield', 'captures', 'whatsapp');
  const workDir = args['work-dir'] || path.join(os.homedir(), '.bitfield', 'whatsapp-sessions');
  const blobPath = args['session-blob'] || path.join(workDir, `${accountId.replace(/[^\w.-]+/g, '_')}.session.json`);
  const idleMs = args['idle-ms'] ? Number(args['idle-ms']) : 8000;

  const baileys = await import('@whiskeysockets/baileys');           // lazy: only the live path needs it
  const { version } = await baileys.fetchLatestBaileysVersion();
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  // About to pair by phone? Sweep any half-paired (registered:false) session
  // aside FIRST so Baileys mints a fresh offer instead of failing a login on a
  // stale bound identity (the ~10s "run then reset, no code" wedge). The discard
  // is diagnostic PROVENANCE, not a user challenge, so it goes to STDERR — the
  // acquire feed lens classifies only stdout/display, so this never surfaces as
  // a transient blank challenge in the connect dialog.
  if (args['pairing-phone']) {
    const cleared = clearUnregisteredSession({ workDir, accountId, blobPath, stamp: String(Date.now()) });
    if (cleared) process.stderr.write(JSON.stringify({ type: 'session_reset', reason: 'unregistered_session_cleared', account: accountId }) + '\n');
  }

  const vault = await createVaultSession({ baileys, workDir, ...fileBlobIO(blobPath) });
  // --pairing-phone converts the QR offer into Baileys' 8-char pairing code
  // (device-code-style connect, no QR scan); absent -> plain QR path unchanged.
  const createSocket = withPairingCode(
    createBaileysSocketFactory(baileys, version), args['pairing-phone'], emit);
  const store = snapshotFileStore(captureDir, fs, path);

  const summary = await runConnector({
    createSocket, vault, store, accountId,
    onQr: selectQrEmitter({
      pairingMode: !!args['pairing-phone'],
      emit,
      diag: (o) => process.stderr.write(JSON.stringify(o) + '\n'),
    }),
    now: () => Date.now(),
    idleMs,
    // Pairing by phone is interactive: hold the socket open past idle so the
    // human has time to type the 8-char code and the resulting `connection:open`
    // is received. Bounded by socket close + the process-job timeout.
    awaitPairing: !!args['pairing-phone'],
  });
  // A pairing attempt that did NOT reach connection:'open' left a session that
  // is `registered:true` yet DEAD (WhatsApp tore the half-linked device down).
  // Sweep it aside NOW — keyed on the runtime `paired` flag, the only reliable
  // success discriminant — so the NEXT connect starts clean and mints a fresh
  // code instead of failing a login on a corpse. A run that reached open keeps
  // its session. Diagnostic PROVENANCE -> stderr (never a user challenge line).
  if (args['pairing-phone'] && !summary.paired) {
    const swept = clearIncompletePairing({ workDir, accountId, blobPath, stamp: String(Date.now()), paired: summary.paired });
    if (swept) process.stderr.write(JSON.stringify({ type: 'session_reset', reason: 'incomplete_pairing_cleared', account: accountId }) + '\n');
  }

  // The blob path rides the completion line so the seal path can reference
  // WHERE the session credential lives (a ref, never the bytes — L090).
  emit({ type: 'summary', ...summary, session_blob: blobPath });
  return summary;
}

// Executed directly by the process-job (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((s) => process.exit(s.wroteSnapshot || s.paired ? 0 : 1))
    .catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}
