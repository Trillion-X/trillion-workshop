// packages/whatsapp-web-connector/do-work/worker.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The WhatsApp (Baileys v7) connector WORKER orchestration. One bounded run:
//   restore session creds  ->  open socket  ->  (first time) surface a QR for the
//   user to scan  ->  collect history-sync + live message batches  ->  fold each
//   batch through the pure wa-snapshot-store  ->  write the durable snapshot to
//   the capture dir  ->  persist updated creds  ->  close.
//
// The file-glob observer then discovers the snapshot; the whatsapp-web-decoder +
// transcript-mapper turn it into sidebar conversations. Re-running the worker
// (periodically, or on demand) refreshes the snapshot — exactly the iMessage
// model (re-read the store each materialize), so a one-shot compute.process job
// fits; no long-lived process required.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. DEPENDENCY-INJECTED: every side effect — socket creation, the vault
//    session round-trip, the QR surface, the clock, and snapshot file I/O — is a
//    passed-in capability. So the orchestration is fully unit-testable with fakes
//    (no Baileys, no network, no real vault). `defaultDeps()` wires the REAL
//    capabilities and lazily imports Baileys ONLY there, so this module + its
//    test never need the dependency installed.
// 2. NO god package: the worker owns ONLY "drive the socket -> snapshot + send".
//    Session persistence is credentials-vault (injected `vault`); decoding is the
//    decoder; the ledger is file-glob + observed-content; the connect UI/state is
//    service-connections. The worker never decodes, never writes AI logs, never
//    stores creds anywhere but the injected vault.
// 3. SNAPSHOT MERGE, never overwrite: the worker reads any existing snapshot for
//    this account and folds new batches onto it (mergeMessages dedups), so a
//    refresh never loses earlier history and never double-counts.
// 4. Creds persisted on every `creds.update` AND at close — a dropped run must
//    never require re-pairing.
import { emptySnapshot, mergeMessages, mergeContacts } from './wa-snapshot-store.mjs';

/**
 * Run one bounded connector session. Resolves with a summary once the socket
 * reports it has synced (or the idle/max-run deadline hits).
 *
 * @param {object} deps
 * @param {(authState:object)=>Promise<object>} deps.createSocket  opens a socket
 *        (EventEmitter with .ev.on / .sendMessage / .end). Real = Baileys.
 * @param {{readSession:Function, writeSession:Function}} deps.vault
 * @param {(qr:string)=>void} deps.onQr  surface the pairing QR to the connect UI
 * @param {{readSnapshot:Function, writeSnapshot:Function}} deps.store  snapshot I/O
 * @param {string} deps.accountId  the connection/account id (vault + snapshot key)
 * @param {()=>number} [deps.now]  injected clock (ms) — default forbidden here so
 *        callers stay deterministic; the real factory supplies Date.now
 * @param {number} [deps.idleMs]  resolve after this much quiet post-sync
 * @param {boolean} [deps.awaitPairing]  INTERACTIVE PAIRING HOLD. When true, a
 *        quiet idle gap does NOT end the run until the socket has opened
 *        (registered) — the user is being shown a pairing code and needs time
 *        (tens of seconds) to type it into WhatsApp. Without the hold the socket
 *        dies ~idleMs after launch and the code pairs into a dead socket. The
 *        run is still bounded: a terminal `connection:'close'` ends it, and the
 *        process-job timeout kills a never-completed pairing.
 * @param {number} [deps.maxReconnects]  bound on post-pairing/transient reconnect
 *        attempts (default 5). Each restartRequired/transient close consumes one;
 *        a clean `connection:'open'` refunds the budget.
 * @param {number} [deps.reconnectDelayMs]  quiet gap between a reconnectable close
 *        and re-opening the socket (default 250) so the old socket fully tears
 *        down before the new one offers.
 */
export async function runConnector(deps) {
  const { createSocket, vault, onQr, store, accountId } = deps;
  const now = deps.now;
  const idleMs = deps.idleMs ?? 4000;
  const awaitPairing = deps.awaitPairing === true;
  const maxReconnects = deps.maxReconnects ?? 5;
  const reconnectDelayMs = deps.reconnectDelayMs ?? 250;
  if (typeof now !== 'function') throw new Error('runConnector: deps.now (clock) is required');

  let snapshot = (await store.readSnapshot(accountId)) || emptySnapshot();
  let selfJid = snapshot.self_jid || null;

  // self_jid rides the summary so the completion consumer (the connect seal
  // path) can label the connection with the REAL account identity — the
  // process self-describes its outcome (L090), no re-parse downstream.
  const summary = { accountId, batches: 0, messages: 0, paired: false, wroteSnapshot: false,
    historySeen: false, historyComplete: false, self_jid: selfJid, reconnects: 0 };

  // WhatsApp close codes whose disposition is "reconnect to continue", NOT "give
  // up". These are fixed Baileys DisconnectReason protocol bits (a CLOSED set
  // defined by WhatsApp, not user-extensible — so enumerating them is Physics,
  // not a Society enum). The canonical case is restartRequired(515): after a
  // phone-pairing code is accepted, WhatsApp REGISTERS the device, immediately
  // drops the socket with 515, and the device link only FINALIZES on the
  // reconnect that follows. Exiting on that close leaves the phone stuck on
  // "Logging in..." until WhatsApp tears the half-linked device down ("couldn't
  // link device"). Transient network drops share the same reconnect disposition.
  // Every OTHER close — loggedOut(401), badSession(500), connectionReplaced(440),
  // or a deliberate no-code end — is terminal and finishes the run.
  const RECONNECT_CLOSE_CODES = new Set([
    515, // restartRequired    — POST-PAIRING device-link finalize (the fix)
    428, // connectionClosed   — transient
    408, // connectionLost / timedOut — transient
    503, // unavailableService — transient
  ]);
  const LOGGED_OUT = 401; // DisconnectReason.loggedOut — creds are dead, terminal
  const statusOf = (u) => {
    const err = u && u.lastDisconnect && u.lastDisconnect.error;
    const code = err && err.output && err.output.statusCode;
    return typeof code === 'number' ? code : undefined;
  };

  async function persistCreds(creds) {
    if (creds) await vault.writeSession(accountId, creds);
  }
  async function foldBatch(waMessages) {
    const before = snapshot.messages.length;
    snapshot = mergeMessages(snapshot, waMessages, selfJid ? { selfJid } : {});
    summary.batches += 1;
    summary.messages += snapshot.messages.length - before;
    await store.writeSnapshot(accountId, snapshot);
    summary.wroteSnapshot = true;
  }
  // Fold the {contacts, chats} DIRECTORY that rides each history-sync chunk into
  // the snapshot's contacts map (jid -> display name / group subject), so the
  // decoder can title threads by NAME instead of a bare phone-number/group jid.
  // Kept separate from foldBatch: a directory can arrive with zero new messages,
  // and message folding must not depend on directory presence (or vice versa).
  async function foldContacts(directory) {
    const before = Object.keys(snapshot.contacts || {}).length;
    snapshot = mergeContacts(snapshot, directory);
    const after = Object.keys(snapshot.contacts || {}).length;
    if (after !== before) { await store.writeSnapshot(accountId, snapshot); summary.wroteSnapshot = true; }
    summary.contacts = after;
  }

  return await new Promise((resolve) => {
    let idleTimer = null;
    let done = false;
    let sock = null;           // the CURRENT live socket (swapped on reconnect)
    let reconnects = 0;
    let reconnecting = false;  // a reconnect is mid-flight — do not idle-finish

    const finish = async (reason) => {
      if (done) return; done = true;
      if (idleTimer) clearTimeout(idleTimer);
      // Creds are already persisted on every `creds.update` (the idiomatic Baileys
      // save signal) — no redundant final save that could overwrite the latest.
      try { if (sock && typeof sock.end === 'function') sock.end(); } catch { /* best effort */ }
      summary.reason = reason;
      resolve(summary);
    };
    // An initial history sync is chunked; mid-sync quiet gaps (server-side
    // download/decrypt between chunks) can exceed idleMs. Cap the extra waiting
    // at MAX_HISTORY_WAIT_BUMPS so a server that never sends isLatest still
    // terminates (bounded run), with summary.historyComplete=false telling the
    // caller the capture may be partial.
    const MAX_HISTORY_WAIT_BUMPS = 15;
    let historyWaitBumps = 0;
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // A reconnect (post-pairing 515 restart, or a transient drop) is in
        // flight — the socket is being re-opened to FINALIZE the link. Never
        // finish during that window; re-arm until it opens or the reconnect
        // budget is spent (then a terminal close finishes it).
        if (reconnecting) { bumpIdle(); return; }
        // INTERACTIVE PAIRING HOLD: the user has (or is about to receive) an
        // 8-char pairing code to type into WhatsApp -> Linked Devices. That
        // takes far longer than idleMs, and the socket must stay alive to
        // receive the resulting `connection:'open'`. Until it opens (paired),
        // re-arm instead of finishing. Bounded by a terminal `connection:'close'`
        // and the process-job timeout, so a never-completed pairing still ends.
        if (awaitPairing && !summary.paired) { bumpIdle(); return; }
        if (summary.historySeen && !summary.historyComplete
            && historyWaitBumps < MAX_HISTORY_WAIT_BUMPS) {
          historyWaitBumps += 1;
          bumpIdle(); // mid-first-sync quiet gap — keep waiting for isLatest
          return;
        }
        finish('idle');
      }, idleMs);
    };

    // history-sync (bulk) and live upserts both carry {messages:[WAMessage]}.
    // First-pairing history arrives as MULTIPLE messaging-history.set chunks;
    // Baileys stamps the final initial-sync chunk `isLatest: true` (undefined on
    // ON_DEMAND pages). Exiting on idle alone can truncate a slow multi-chunk
    // first sync — so once a history chunk is seen, completion requires the
    // isLatest chunk (tracked in summary.historyComplete); until it arrives the
    // idle window keeps extending on every fold. Post-sync live runs (no history
    // chunks) keep the pure idle exit.
    const onMessages = async (payload) => {
      const msgs = (payload && payload.messages) || (Array.isArray(payload) ? payload : []);
      if (msgs && msgs.length) {
        historyWaitBumps = 0; // real activity restores the mid-sync wait budget
        await foldBatch(msgs);
        bumpIdle();
      }
    };

    // Bind the four Baileys event streams to ONE socket instance. Every handler
    // ignores a socket that is no longer current (`s !== sock`) so a torn-down
    // socket from a prior connect can never double-fold or resolve the run.
    const bindSocket = (s) => {
      s.ev.on('connection.update', (u) => {
        if (done || s !== sock) return;
        if (u.qr) { summary.paired = false; onQr(u.qr); }
        if (u.connection === 'open') {
          summary.paired = true;
          reconnecting = false;
          reconnects = 0;               // a clean open refunds the reconnect budget
          if (u.jid) { selfJid = u.jid; summary.self_jid = selfJid; }
          bumpIdle();
        }
        if (u.connection === 'close') {
          const code = statusOf(u);
          if (code !== undefined && RECONNECT_CLOSE_CODES.has(code)
              && reconnects < maxReconnects) {
            reconnects += 1;
            summary.reconnects = reconnects;
            reconnect();                // finalize the link / recover — do NOT end
          } else {
            finish(code === LOGGED_OUT ? 'logged_out' : 'closed');
          }
        }
      });
      s.ev.on('creds.update', (creds) => { if (!done && s === sock) persistCreds(creds); });
      s.ev.on('messages.upsert', (p) => { if (!done && s === sock) onMessages(p); });
      s.ev.on('messaging-history.set', async (payload) => {
        if (done || s !== sock) return;
        summary.historySeen = true;
        if (payload && payload.isLatest === true) summary.historyComplete = true;
        // The directory (contacts + chats) rides this event alongside the message
        // chunk — capture it FIRST so names are present the moment the messages
        // land, then fold the messages (which also re-arms the idle window).
        await foldContacts(payload);
        await onMessages(payload);
      });
    };

    // Open a socket with the LATEST vault session (re-read every connect so a
    // reconnect picks up the creds WhatsApp wrote during registration), and bind
    // its events. `sock` is set BEFORE binding so the current-socket guard passes.
    const connect = async () => {
      const authState = await vault.readSession(accountId); // {} first pair; registered on reconnect
      const s = await createSocket(authState);
      sock = s;
      bindSocket(s);
    };

    // Tear down the old socket and re-open after a short quiet gap. Marked
    // `reconnecting` so the idle timer holds the run alive across the swap.
    const reconnect = () => {
      reconnecting = true;
      const old = sock;
      try { if (old && typeof old.end === 'function') old.end(); } catch { /* best effort */ }
      bumpIdle(); // fresh window covering the reconnect handshake
      setTimeout(() => {
        if (done) return;
        connect().catch(() => finish('closed'));
      }, reconnectDelayMs);
    };

    connect().then(() => bumpIdle()).catch(() => finish('closed'));
  });
}

/** Send a text reply through an already-open socket (used by the auto-reply gate). */
export async function sendText(sock, jid, text) {
  return await sock.sendMessage(jid, { text });
}

/**
 * The default `store` capability: reads/writes the durable snapshot as a JSON
 * file in the capture dir the file-glob observer watches
 * (`~/.bitfield/captures/whatsapp/<accountId>.json`). One file per account, so a
 * multi-account user's threads never collide, and the glob (`*.json`) discovers
 * them all. Pure fs — injected into runConnector so the orchestration stays
 * testable with an in-memory store. (The vault + socket capabilities are the
 * live shell, supplied by the W3 process-job.)
 */
export function snapshotFileStore(captureDir, fs, path) {
  const fileFor = (accountId) => path.join(captureDir, `${String(accountId).replace(/[^\w.-]+/g, '_')}.json`);
  return {
    async readSnapshot(accountId) {
      try { return JSON.parse(fs.readFileSync(fileFor(accountId), 'utf8')); }
      catch { return null; }
    },
    async writeSnapshot(accountId, snapshot) {
      fs.mkdirSync(captureDir, { recursive: true });
      fs.writeFileSync(fileFor(accountId), JSON.stringify(snapshot));
    },
  };
}
