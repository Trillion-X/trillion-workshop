// computer/connections/whatsapp.mjs
//
// Purpose
//   WhatsApp as a connection this computer carries (a client program on the person's own computer, loaded by
//   computer/carry-connections.mjs, never part of the hosted service): a WhatsApp linked device held open with Baileys,
//   which sends from the person's own number and keeps their recent messages. Linking is once, with the 8-character
//   code WhatsApp asks for on the phone (Link with phone number instead). Ported from bitfield-packages
//   whatsapp-web-connector (socket, pairing code per rotation, reconnect on restart codes, half-paired session sweep)
//   and whatsapp-web-decoder (the words of a message), with no Bitfield runtime.
//
// Non-negotiable invariants
//   1. The session stays in this computer's own folder (settings.session_folder); nothing of it is sent anywhere.
//   2. A session that never finished linking is moved aside (never deleted) before linking again, so a stale half-link
//      cannot wedge the next attempt.
//   3. Logged out (401) means not carried: the helper stops announcing WhatsApp until it is linked again.
//   4. Recent messages are bounded per verified account (settings.keep) and kept only on this computer.
//      Unattributed legacy entries are preserved but omitted from reads with incomplete-coverage metadata.
//      New incoming text is also
//      kept in the configured durable journal until the shared Mac reader confirms /inbound receipt; a restart
//      or 500 newer messages cannot evict it. Offline upserts after this account first began receiving are kept
//      too; initial history sync and our own sends never enter that journal.
//   5. Explicit pause is durable and cancels reconnects; resume or connect reopens it. Shutdown stop is only
//      cleanup and never pauses future starts. Logout and account changes
//      cannot deliver pending words from another linked account. Session material never enters the journal.
//   6. Disconnect archives the active session only after outstanding credential saves finish. Remote revocation
//      is reported only for a matched provider acknowledgement. Rebinding is a separate explicit connect.
//   7. Explicit local-copy erasure is account/source scoped, keeps replay tombstones and cannot implicitly erase
//      pending work. Provider messages, recent-message cache and shared receipts/history are separate resources.
//
// Key concepts
//   jid        a WhatsApp address: <digits>@s.whatsapp.net for a person, <id>@g.us for a group
//   "me"       the linked account's own jid (a message to yourself)
//   reconnect  close codes that mean "connect again" (settings.reconnect_codes), everything else ends the socket
//
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { incomingItems } from './incoming-items.mjs';

const home = path => String(path).replace(/^~(?=\/|$)/, homedir());
const silent = { level: 'silent', child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

/** The words of one WhatsApp message, whichever kind of message carries them. */
export function wordsOf(message) {
  const body = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message;
  return body?.conversation ?? body?.extendedTextMessage?.text ?? body?.imageMessage?.caption ?? body?.videoMessage?.caption ?? body?.documentMessage?.caption ?? null;
}

/** The kind and length of audio in a message, kept as source facts without moving its bytes off this computer. */
export function audioOf(message) {
  const body = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message;
  const audio = body?.audioMessage;
  if (!audio) return null;
  const duration = Number(audio.seconds);
  return {
    kind: audio.ptt ? 'voice_note' : 'audio',
    ...(Number.isFinite(duration) && duration > 0 ? { duration_seconds: duration } : {}),
    ...(typeof audio.mimetype === 'string' ? { media_type: audio.mimetype } : {}),
  };
}

export function voiceNoteName(item, audio = audioOf(item?.message), account = null) {
  const at = new Date(Number(item?.messageTimestamp ?? 0) * 1000).toISOString();
  const id = String(item?.key?.id ?? 'voice-note').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'voice-note';
  const ending = audio?.media_type?.toLowerCase().includes('ogg') ? 'ogg'
    : audio?.media_type?.toLowerCase().includes('mpeg') ? 'mp3'
      : audio?.media_type?.toLowerCase().includes('mp4') ? 'm4a' : 'audio';
  const scope = account ? `${createHash('sha256').update(account).digest('hex')}-` : '';
  return `voice-note-${scope}${at.replace(/[:.]/g, '-')}-${id}.${ending}`;
}

/** Downloads a voice note from the linked device and keeps its original audio in the person's Trillion files. */
export async function importVoiceNote(item, { download, keepFile, readCached = null, account = null, isCurrent = () => true }) {
  const audio = audioOf(item?.message);
  if (audio?.kind !== 'voice_note') return null;
  if (typeof download !== 'function' || typeof keepFile !== 'function') throw new Error('The computer cannot move this voice note into the person\'s files.');
  let bytes;
  try { bytes = await download(item); }
  catch (error) {
    if (!isCurrent()) throw new Error('The linked account changed before this voice note could be kept.');
    bytes = await readCached?.(item);
    if (!bytes?.byteLength) throw error;
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('WhatsApp did not provide the voice note audio.');
  if (!isCurrent()) throw new Error('The linked account changed before this voice note could be kept.');
  const name = voiceNoteName(item, audio, account);
  const file = await keepFile({ name, bytes, media_type: audio.media_type ?? 'application/octet-stream' });
  if (!file?.id || !file?.name) throw new Error('Trillion did not confirm that the voice note was saved.');
  return { ...audio, file_identity: file.id, file_name: file.name };
}

/** A WhatsApp address from what an AI gave: "me", a phone number (country code first), or a jid already. */
export function jidFor(to, self) {
  if (to === 'me') return self ? `${self.split('@')[0].split(':')[0]}@s.whatsapp.net` : null;
  if (String(to).includes('@')) return String(to);
  const digits = String(to).replace(/\D/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : null;
}

// A session folder's own word on whether it finished linking.
const registered = folder => {
  try { return JSON.parse(readFileSync(join(folder, 'creds.json'), 'utf8')).registered === true; } catch { return false; }
};

/**
 * settings: this connection's row in computer/carry-connections.json
 * load:     () → the Baileys module (imported only when WhatsApp is used)
 * log:      entry → void (one JSON line)
 * changed:  () → void, when whether WhatsApp is carried changes (the helper publishes its card again)
 */
export function whatsapp(settings, { load = () => import('@whiskeysockets/baileys'), log = () => {}, changed = () => {}, keepFile = null, folder: folderOverride = null, now = () => Date.now() } = {}) {
  const words = settings.words;
  const folder = folderOverride ?? home(settings.session_folder);
  const session = join(folder, 'session');
  const recentFile = join(folder, 'recent.json');
  const incoming = settings.incoming?.file ? incomingItems(join(folder, settings.incoming.file), { now: () => new Date(now()).toISOString() }) : null;
  let stopped = ['stopped', 'disconnected', 'revoked', 'revoking'].includes(incoming?.state()?.status);
  let reconnectTimer = null;
  let generation = 0;
  let closeAttempt = null;
  let socket = null;
  let open = false;
  let loggedOut = false;
  let pairingAttempt = null;
  let recent = [];
  let credentialWrites = Promise.resolve();
  let detaching = null;
  const processing = new Set();
  try { recent = JSON.parse(readFileSync(recentFile, 'utf8')); } catch { recent = []; }

  // Baileys persists both creds.update and auth.keys.set. They share the active session directory, so
  // disconnect must drain both kinds of write before archiving it; a retired socket may start neither.
  function writeCredentials(wanted, work) {
    const pending = credentialWrites.then(() => wanted() ? work() : undefined);
    credentialWrites = pending.catch(error => log({ whatsapp: 'session_save_failed', error: String(error.message ?? error) }));
    return pending;
  }

  function persistRecent() {
    // Legacy entries have no proven account. Preserve them unchanged and never assign them to whichever
    // account happens to connect next. The existing bounded cache limit applies separately to each known account.
    const unknown = recent.filter(item => !item.account);
    const accounts = new Map();
    for (const item of recent.filter(item => item.account)) {
      const entries = accounts.get(item.account) ?? [];
      entries.push(item); accounts.set(item.account, entries);
    }
    recent = [...unknown, ...[...accounts.values()].flatMap(entries => entries.sort((left, right) => left.at.localeCompare(right.at)).slice(-settings.keep))];
    mkdirSync(folder, { recursive: true });
    writeFileSync(recentFile, JSON.stringify(recent));
  }

  // Cache attribution comes only from an open verified socket. The generation also distinguishes two
  // sessions of the same account, so a delayed old callback cannot update a replacement session's cache.
  function activeRecentContext() {
    const sock = socket, mine = generation, account = jidFor('me', sock?.user?.id);
    if (!sock || !open || stopped || loggedOut || !account) return null;
    return { account, sock, generation: mine, current: () => socket === sock && generation === mine && open && !stopped && !loggedOut && jidFor('me', sock.user?.id) === account };
  }
  const recentKey = (context, id) => JSON.stringify([context.account, context.generation, id]);

  async function keep(items, baileys, sock) {
    const context = activeRecentContext();
    if (!context || context.sock !== sock) return;
    const { account, current } = context;
    const seen = new Set(recent.filter(item => item.account === account && (item.audio?.kind !== 'voice_note' || item.audio.file_identity)).map(item => item.id));
    let dirty = false;
    for (const item of items) {
      if (!current()) return;
      const text = wordsOf(item.message);
      const audio = audioOf(item.message);
      const id = item.key?.id;
      const key = recentKey(context, id);
      if ((!text && !audio) || !id || seen.has(id) || processing.has(key)) continue;
      processing.add(key);
      try {
        const at = new Date(Number(item.messageTimestamp ?? 0) * 1000).toISOString();
        let keptAudio = audio;
        if (audio?.kind === 'voice_note') {
          // Commit earlier synchronous captures before awaiting media; they were observed under this account.
          if (dirty) { persistRecent(); dirty = false; }
          try {
            keptAudio = await importVoiceNote(item, {
              account, isCurrent: current,
              download: message => baileys.downloadMediaMessage(message, 'buffer', { logger: silent, reuploadRequest: sock.updateMediaMessage }),
              keepFile,
              readCached: message => {
                if (typeof keepFile?.readCached !== 'function') return null;
                return keepFile.readCached(voiceNoteName(message, audio, account));
              },
            });
          } catch (error) {
            if (!current()) return;
            keptAudio = { ...audio, file_name: voiceNoteName(item, audio, account), import_error: String(error.message ?? error) };
            log({ whatsapp: 'voice_note_import_failed', message_id: id, error: keptAudio.import_error });
          }
        }
        if (!current()) return;
        recent = recent.filter(previous => previous.account !== account || previous.id !== id);
        recent.push({
          id, account,
          from: item.key.fromMe ? 'me' : (item.key.participant ?? item.key.remoteJid ?? '').split('@')[0],
          name: item.key.fromMe ? null : item.pushName ?? null,
          chat: (item.key.remoteJid ?? '').split('@')[0],
          at,
          text: text ?? (audio.kind === 'voice_note' ? 'Voice note' : 'Audio message'),
          ...(keptAudio ? { audio: keptAudio } : {}),
        });
        dirty = true;
        if (keptAudio?.kind !== 'voice_note' || keptAudio.file_identity) seen.add(id);
      } finally { processing.delete(key); }
    }
    if (dirty && current()) persistRecent();
  }

  async function retryCachedVoiceNotes(context = activeRecentContext()) {
    if (!context || typeof keepFile?.readCached !== 'function') return;
    const { account, current } = context;
    for (const message of recent.filter(item => item.account === account && item.audio?.kind === 'voice_note' && !item.audio.file_identity && item.audio.file_name)) {
      if (!current()) return;
      const key = recentKey(context, message.id);
      if (processing.has(key)) continue;
      processing.add(key);
      try {
        const bytes = await keepFile.readCached(message.audio.file_name);
        if (!current()) return;
        if (!bytes?.byteLength) continue;
        const file = await keepFile({ name: message.audio.file_name, bytes, media_type: message.audio.media_type ?? 'application/octet-stream' });
        if (!current()) return;
        if (!file?.id || !file?.name) throw new Error('Trillion did not confirm that the voice note was saved.');
        recent = recent.map(item => item.account === account && item.id === message.id ? { ...item, audio: { ...item.audio, file_identity: file.id, file_name: file.name, import_error: undefined } } : item);
        log({ whatsapp: 'voice_note_imported', message_id: message.id, file_identity: file.id });
      } catch (error) {
        if (!current()) return;
        recent = recent.map(item => item.account === account && item.id === message.id ? { ...item, audio: { ...item.audio, import_error: String(error.message ?? error) } } : item);
        log({ whatsapp: 'voice_note_import_failed', message_id: message.id, error: String(error.message ?? error) });
      } finally {
        processing.delete(key);
        if (current()) persistRecent();
      }
    }
  }

  // This is capture, not a second delivery loop. The data-declared Mac reader owns retries and /inbound.
  function keepIncoming(items, sock, type) {
    if (!incoming || stopped || !open || socket !== sock || loggedOut) return;
    const account = jidFor('me', sock.user?.id);
    if (!account) return;
    for (const item of items) {
      const text = wordsOf(item.message);
      const at = new Date(Number(item.messageTimestamp) * 1000);
      if (item.key?.fromMe || !item.key?.id || !item.key?.remoteJid || !text?.trim() || !Number.isFinite(at.getTime())) continue;
      // Baileys uses append for messages queued while the linked device was offline, as well as older messages.
      // The durable account boundary admits those missed while away without importing a pre-link history.
      const boundary = Date.parse(incoming.state()?.started_at ?? '');
      // Provider timestamps are whole seconds; a millisecond boundary would drop a new message from that
      // same second after reconnect. Admit the ambiguous boundary second, then deduplicate by source identity.
      if (type === 'append' && (!Number.isFinite(boundary) || at.getTime() < Math.floor(boundary / 1000) * 1000)) continue;
      const from = item.key.participant ?? item.key.remoteJid;
      incoming.put({
        source_id: JSON.stringify([account, item.key.remoteJid, from, item.key.id]),
        account, source_ref: item.key.id, conversation_id: JSON.stringify([account, item.key.remoteJid]), from,
        title: item.pushName ? `WhatsApp from ${item.pushName}` : `WhatsApp from ${from}`,
        text, at: at.toISOString(),
      });
    }
  }

  // One socket over the session folder; resolves once it is open, or with why it closed.
  async function connect({ phone = null, onCode = () => {}, onPairing = () => {} } = {}) {
    if (stopped) return { open: false, why: words.stopped };
    // The carrier constructs modules before taking its process lock. Only its owning start/connect may
    // change liveness; a duplicate helper that is about to exit must not disable the live owner's journal.
    if (incoming?.state()) incoming.setState('offline');
    const mine = ++generation;
    const baileys = await load();
    const makeSocket = baileys.default ?? baileys.makeWASocket;
    const { version } = await baileys.fetchLatestBaileysVersion();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(session);
    const digits = phone ? String(phone).replace(/\D/g, '') : null;
    if (stopped || mine !== generation) return { open: false, why: words.stopped };
    return new Promise(resolve => {
      closeAttempt = resolve;
      let sock = null;
      const wanted = () => !stopped && mine === generation && (!sock || socket === sock);
      if (typeof state.keys?.set === 'function') {
        const setKeys = state.keys.set.bind(state.keys);
        state.keys = { ...state.keys, set: data => writeCredentials(wanted, () => setKeys(data)) };
      }
      sock = makeSocket({ auth: state, version, logger: silent, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false, qrTimeout: settings.code_seconds * 1000 });
      socket = sock;
      let asking = false;
      sock.ev.on('creds.update', () => {
        if (stopped || mine !== generation || socket !== sock) return;
        void writeCredentials(wanted, saveCreds);
        return credentialWrites;
      });
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (stopped || mine !== generation || socket !== sock) return;
        try { if (type === 'notify' || type === 'append') keepIncoming(messages ?? [], sock, type); }
        catch (error) { log({ whatsapp: 'incoming_failed', error: String(error.message ?? error) }); }
        void keep(messages ?? [], baileys, sock).catch(error => log({ whatsapp: 'messages_failed', error: String(error.message ?? error) }));
      });
      sock.ev.on('messaging-history.set', ({ messages }) => { if (!stopped && mine === generation && socket === sock) void keep(messages ?? [], baileys, sock).catch(error => log({ whatsapp: 'history_failed', error: String(error.message ?? error) })); });
      sock.ev.on('connection.update', update => {
        if (stopped || mine !== generation || socket !== sock) return;
        // A code for "Link with phone number instead", asked for again on every pairing window.
        if (update.qr && digits && !asking && !sock.authState?.creds?.registered) {
          asking = true;
          Promise.resolve(sock.requestPairingCode(digits)).then(code => {
            onCode(code);
            onPairing({ state: 'pairing_required', code, expires_after_seconds: settings.code_seconds });
          }).catch(error => {
            log({ whatsapp: 'code_refused', error: String(error.message ?? error) });
            onPairing({ state: 'failed', error: String(error.message ?? error) });
          }).finally(() => { asking = false; });
        }
        if (update.qr && !digits) { sock.end?.(undefined); resolve({ open: false, why: words.not_linked }); }
        if (update.connection === 'open') {
          const was = open;
          open = true;
          loggedOut = false;
          incoming?.setState('active', jidFor('me', sock.user?.id));
          onPairing({ state: 'connected', account: sock.user?.id?.split(':')[0] ?? null });
          if (!was) changed();
          resolve({ open: true, account: sock.user?.id ?? null });
        }
        if (update.connection === 'close') {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          const was = open;
          open = false;
          if (socket === sock) socket = null;
          incoming?.setState(code === settings.logged_out_code ? 'logged out' : 'offline');
          if (settings.reconnect_codes.includes(code)) {
            log({ whatsapp: 'reconnecting', code });
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              if (!stopped && mine === generation) connect({ phone, onCode, onPairing }).then(resolve);
            }, settings.reconnect_after_ms);
            return;
          }
          if (code === settings.logged_out_code) loggedOut = true;
          if (was) changed();
          const why = code === settings.logged_out_code ? words.logged_out : `${words.closed} (${code ?? 'no code'})`;
          onPairing({ state: 'failed', error: why });
          resolve({ open: false, why });
        }
      });
    });
  }

  // Carried when this computer holds a linked session that opens.
  async function start() {
    if (stopped) return { carried: false, why: words.stopped };
    // A socket already trying (or open) is never doubled; its open or close tells the helper through changed().
    if (socket) {
      if (open) await retryCachedVoiceNotes();
      return open ? { carried: true, account: socket.user?.id?.split(':')[0] ?? null } : { carried: false, why: words.not_open };
    }
    if (!registered(session)) {
      if (incoming?.state()) incoming.setState('offline');
      return { carried: false, why: words.not_linked };
    }
    // A socket slower than open_within_ms keeps trying; when it opens, changed() tells the helper.
    const answer = await Promise.race([connect(), new Promise(resolve => setTimeout(() => resolve({ open: false, why: words.not_open }), settings.open_within_ms))]);
    return answer.open ? { carried: true, account: answer.account?.split(':')[0] ?? null } : { carried: false, why: answer.why };
  }

  // Cleanup and a person's pause share socket teardown, but only pause changes durable intent.
  function close(status, notify = true) {
    generation += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    incoming?.setState(status);
    const previous = socket;
    socket = null;
    const was = open;
    open = false;
    previous?.end?.(undefined);
    closeAttempt?.({ open: false, why: stopped ? words.stopped : words.not_open });
    if (was && notify) changed();
  }

  const currentAccount = () => incoming?.state()?.account ?? jidFor('me', socket?.user?.id);
  function requireAccount(account) {
    const named = typeof account === 'string' && account.trim() ? jidFor('me', account.trim()) : null;
    if (!named || named !== currentAccount()) throw new Error('Name the exact currently bound account; nothing was disconnected or revoked.');
    return named;
  }
  const detached = () => ['disconnected', 'revoked', 'revoking'].includes(incoming?.state()?.status);
  async function detach(account, status) {
    if (detaching) return detaching;
    stopped = true;
    close(status);
    // Drain already-running credential writes before archiving. Old socket callbacks are fenced above;
    // detached durable intent also prevents resume from accepting any late provider-created session path.
    detaching = (async () => {
      await credentialWrites;
      // Keep the detached session on this Mac, never export or silently delete it. Only the active path
      // is used by startup. Pending source items remain bound to their original account.
      if (existsSync(session)) renameSync(session, `${session}-detached-${now()}-${randomUUID()}`);
      return { state: status, account, local_disconnected: true, remote_revoked: status === 'revoked', pending_preserved: true };
    })();
    try { return await detaching; } finally { detaching = null; }
  }

  return {
    start,
    status() {
      const state = incoming?.state();
      const account = currentAccount();
      return { state: open && !stopped ? 'connected' : state?.status ?? 'not_linked', account, linked: registered(session) && !detached(), remote_revoked: state?.status === 'revoked', incoming_accounts: incoming?.accounts() ?? [], incoming: incoming?.summary(account) ?? { pending: 0, delivered: 0, erased: 0 } };
    },
    disconnect({ account } = {}) {
      const named = requireAccount(account);
      const status = incoming?.state()?.status;
      if (['disconnected', 'revoked'].includes(status) && !existsSync(session)) return { state: status, account: named, local_disconnected: true, remote_revoked: status === 'revoked', pending_preserved: true };
      return detach(named, status === 'revoked' ? 'revoked' : 'disconnected');
    },
    async revoke({ account } = {}) {
      const named = requireAccount(account);
      if (incoming?.state()?.status === 'revoked') return detach(named, 'revoked');
      if (!socket || !open || typeof socket.query !== 'function' || !socket.user?.id) return { state: 'revocation_unconfirmed', account: named, remote_revoked: false, error: 'The linked connection must be open to request and confirm revocation. Resume it first; no remote revocation was confirmed.' };
      const sock = socket;
      const mine = ++generation;
      stopped = true;
      incoming?.setState('revoking');
      const stillCurrent = () => mine === generation && socket === sock && currentAccount() === named && incoming?.state()?.status === 'revoking';
      // Baileys logout() sends this request but does not await its provider reply. Use the same protocol
      // operation through query(), and require a matching successful IQ before claiming remote revocation.
      const request = { tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'md' }, content: [{ tag: 'remove-companion-device', attrs: { jid: sock.user.id, reason: 'user_initiated' } }] };
      try {
        const reply = await sock.query(request, settings.revoke_within_ms ?? 20_000);
        if (reply?.tag !== 'iq' || reply.attrs?.type !== 'result' || !request.attrs.id || reply.attrs.id !== request.attrs.id) throw new Error('The provider did not confirm device revocation.');
      } catch (error) {
        // A newer pause, disconnect or connect owns the connection now. An old provider outcome cannot
        // overwrite that intent or close a replacement account, even when the account label is unchanged.
        const superseded = !stillCurrent();
        if (!superseded) close('stopped');
        return { state: 'revocation_unconfirmed', account: named, remote_revoked: false, ...(superseded ? { superseded: true, current_connection_changed: false } : { local_disconnected: !existsSync(session) }), pending_preserved: true, error: String(error.message ?? error) };
      }
      if (!stillCurrent()) return { state: 'revoked_superseded', account: named, remote_revoked: true, superseded: true, current_connection_changed: false, pending_preserved: true };
      try {
        return await detach(named, 'revoked');
      } catch (error) {
        // detach already persisted the verified status before cleanup. Do not write a second status after
        // its await: another explicit control may have taken ownership in the meantime.
        return { state: 'revoked_local_cleanup_failed', account: named, remote_revoked: true, local_disconnected: !existsSync(session), pending_preserved: true, error: String(error.message ?? error) };
      }
    },
    read_incoming({ account, after, limit } = {}) {
      if (!incoming) throw new Error('This connection has no local incoming journal.');
      const named = typeof account === 'string' && account.trim() ? jidFor('me', account.trim()) : null;
      return incoming.list({ account: named, after, limit });
    },
    erase_incoming({ account, source_ids, include_pending = false } = {}) {
      if (!incoming) throw new Error('This connection has no local incoming journal.');
      const named = typeof account === 'string' && account.trim() ? jidFor('me', account.trim()) : null;
      if (!named) throw new Error('Name the exact account whose incoming journal copy may be erased.');
      return incoming.erase({ account: named, source_ids, include_pending });
    },
    pause() {
      stopped = true;
      close(['disconnected', 'revoked'].includes(incoming?.state()?.status) ? incoming.state().status : 'stopped');
      return { state: 'paused' };
    },
    async resume() {
      if (detaching) return { state: 'failed', error: 'The previous session is still disconnecting. Try again after it finishes.' };
      if (detached() || !registered(session)) return { state: 'needs_connection', error: words.not_linked };
      stopped = false;
      const answer = await start();
      return answer.carried ? { state: 'connected', account: answer.account } : { state: 'failed', error: answer.why };
    },
    carried: () => open && !stopped && !loggedOut,
    // Link this computer once: a half-linked session is moved aside first, then each pairing window's code is shown.
    async link({ phone, onCode }) {
      stopped = false;
      if (existsSync(session) && !registered(session)) renameSync(session, `${session}-unfinished-${Date.now()}`);
      const answer = await connect({ phone, onCode });
      if (!answer.open && existsSync(session)) renameSync(session, `${session}-unfinished-${Date.now()}`);
      return answer;
    },
    // Start one pairing window for the hosted connect_source request and return its one-time phone code.
    async connect({ phone } = {}) {
      if (detaching) return { state: 'failed', error: 'The previous session is still disconnecting. Try again after it finishes.' };
      if (detached()) {
        if (!phone) return { state: 'needs_phone', error: words.phone_needed };
        // A detached path recreated by a late provider write is never an implicit resume of that account.
        await detach(currentAccount(), incoming.state().status);
        stopped = false;
      }
      if (stopped && registered(session)) {
        stopped = false;
        const answer = await connect();
        return answer.open ? { state: 'connected', account: answer.account } : { state: 'failed', error: answer.why };
      }
      if (open) return { state: 'connected', account: socket?.user?.id?.split(':')[0] ?? null };
      if (!phone) return { state: 'needs_phone', error: words.phone_needed };
      stopped = false;
      if (pairingAttempt?.result?.state === 'pairing_required' && pairingAttempt.expires_at <= now()) {
        const previousSocket = socket;
        pairingAttempt = null;
        socket = null;
        previousSocket?.end?.();
        if (existsSync(session) && !registered(session)) renameSync(session, `${session}-unfinished-${now()}`);
      }
      if (pairingAttempt?.result) return pairingAttempt.result;
      if (pairingAttempt?.promise) return pairingAttempt.promise;
      if (socket) return { state: 'failed', error: words.not_open };
      if (existsSync(session) && !registered(session)) renameSync(session, `${session}-unfinished-${Date.now()}`);
      let offer;
      const promise = new Promise(resolve => { offer = resolve; });
      const attempt = {
        promise,
        result: null,
        offer(result) {
          this.result = result;
          this.expires_at = result.state === 'pairing_required'
            ? now() + Math.max(1, Number(result.expires_after_seconds) || settings.code_seconds) * 1000
            : 0;
          offer(result);
          if (result.state === 'failed' || result.state === 'connected') pairingAttempt = null;
        },
      };
      pairingAttempt = attempt;
      void connect({ phone, onPairing: result => attempt.offer(result) }).then(answer => {
        if (pairingAttempt !== attempt) return;
        attempt.offer(answer.open
          ? { state: 'connected', account: answer.account?.split(':')[0] ?? null }
          : { state: 'failed', error: answer.why });
      }).catch(error => attempt.offer({ state: 'failed', error: String(error.message ?? error) }));
      return promise;
    },
    // Take over a session this computer already linked elsewhere (copied once, never moved).
    adopt(from) {
      if (registered(session)) return { adopted: false, why: words.already_linked };
      if (!registered(home(from))) return { adopted: false, why: words.not_linked };
      mkdirSync(folder, { recursive: true });
      cpSync(home(from), session, { recursive: true });
      return { adopted: true };
    },
    async send({ to, text, link }) {
      if (!socket || !open || stopped) return { sent: false, error: loggedOut ? words.logged_out : words.not_open };
      const jid = jidFor(to, socket.user?.id);
      if (!jid) return { sent: false, error: words.unknown_recipient };
      const answer = await socket.sendMessage(jid, { text: [text, link].filter(Boolean).join('\n') });
      return { sent: true, to: jid.split('@')[0], at: new Date().toISOString(), message_id: answer?.key?.id ?? null };
    },
    async read({ with: who, limit } = {}) {
      const context = activeRecentContext();
      const coverage = () => ({ history_complete: false, omitted_legacy_count: recent.filter(item => !item.account).length });
      if (!context) return { account: null, messages: [], cache_status: 'not_connected', ...coverage() };
      await retryCachedVoiceNotes(context);
      if (!context.current()) return { account: null, messages: [], cache_status: 'connection_changed', ...coverage() };
      const wanted = who ? String(who).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() : null;
      const matches = item => !wanted || [item.chat, item.from, item.name].some(value => String(value ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase().includes(wanted));
      const known = recent.filter(item => item.account === context.account).sort((left, right) => left.at.localeCompare(right.at));
      const status = coverage();
      return { account: context.account, messages: known.filter(matches).slice(-(limit ?? settings.read_limit)).reverse(), cache_status: status.omitted_legacy_count ? 'legacy_unattributed' : 'recent_only', ...status };
    },
    stop() { close(stopped ? incoming?.state()?.status ?? 'stopped' : 'offline', false); },
  };
}
