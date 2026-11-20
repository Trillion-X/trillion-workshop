/**
 * notice-when-something-shows-up/do-work/mechanisms/whatsapp-linked-device.mjs
 *
 * Purpose
 *   One waiting mechanism: hold a WhatsApp account open as one of its linked
 *   devices and report each message the moment WhatsApp delivers it: a new
 *   message (added), an edit (changed) and a delete (removed), in a chat with one
 *   person or in a group, whatever it carries (words, a voice note, a photo, a
 *   video, a document, a sticker). Nothing is read on a timer: WhatsApp pushes
 *   each message down the open socket and it is told at once.
 *
 * Non-negotiable invariants
 *   - One socket owner. The socket, its pairing, its reconnects and its logged-out
 *     stop are tools/bring-in-new-items-from-this-computer/computer/connections/
 *     whatsapp.mjs, used here with its `observe` hook; this leaf opens no socket
 *     of its own and keeps no second copy of that logic.
 *   - The linked session lives only in this waiter's own folder (`handlers.folder`,
 *     under the run's kept folder, so it outlasts a restart). Without a folder the
 *     leaf refuses to start: a session kept in memory would ask for a new phone
 *     code at every restart.
 *   - A fact carries the change itself, each field within the engine's 1,024 bytes
 *     (CARRIED_BYTES): where, place ("message"), change, at (the message's own
 *     time), key (<chat>/<message id>, the same for its edit and its delete), by
 *     (who sent it), after (JSON text {chat, chat_name, group, words, media,
 *     reply_to, from}, from repeating by, since a chosen workflow is
 *     given the fact as the router passes it), kinds (JSON text of the row's kinds). Words too long for after
 *     are cut and marked `words_cut` with their full length; media is told by
 *     WhatsApp's own identity of its bytes (`identity`, the file's SHA-256 as
 *     WhatsApp names it), never its bytes.
 *   - Each change is told under its own event key (<key>:added, <key>:removed,
 *     <key>:changed:<identity of the new words>), so a message WhatsApp delivers
 *     twice (live and again in a history sync, or again after a reconnect) is one
 *     fact; the last told keys are also kept in the waiter's state, so a restart
 *     does not tell them again.
 *   - Older messages are told only from `history_since` on (an ISO time; absent,
 *     none): a history sync or a delivery of messages queued while the device was
 *     away is told for messages at or after it, each with its own time and the
 *     same key a live copy has. Without it, only messages from the moment this
 *     waiter first linked are told.
 *   - The person's own sends are told only when `include_own` is true.
 *   - Linking is a fact too: each 8-character phone code is told at place "link"
 *     (kinds ["whatsapp-link-code"]) for as long as WhatsApp keeps it, then a new
 *     one, until the person enters one; linked and logged out are told the same
 *     way: linked the first time the socket opens registered after a code, however long after the code's window that is
 *     (WhatsApp restarts the socket with 515 once a code is entered). A waiter that is not linked and names no `phone`
 *     cannot wait and says so.
 *
 * Settings (mechanism_settings)
 *   where            the name of this connection, told as each fact's where (default "whatsapp")
 *   phone            the account's number, country code first, used only to ask WhatsApp for a phone code
 *   history_since    ISO time: tell older messages at or after it (history sync, messages queued while away)
 *   include_own      true to tell the account's own sends too (default false)
 *   kinds            the kinds each message fact carries (default ["seed"])
 *   connection       settings over the WhatsApp connection row's own (tools/run-on-a-persons-computer/carry-connections.json)
 *   remember         how many told keys the state keeps (default 500)
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { whatsapp } from "../../../bring-in-new-items-from-this-computer/computer/connections/whatsapp.mjs";
import carryConnections from "../../../run-on-a-persons-computer/carry-connections.json" with { type: "json" };

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::whatsapp-linked-device";
// A told fact holds at most 1,024 bytes a field (the engine's fact inbox, src/wake/host-events.json).
export const CARRIED_BYTES = 1000;
// The kind WhatsApp gives a message update that deletes it for everyone (WAMessageStubType.REVOKE).
const REVOKED = 1;
// The wrappers a message's content can sit inside; each is opened to reach the content.
const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage"];
// Each kind of media message and the word it is told as.
const MEDIA = { audioMessage: "audio", imageMessage: "photo", videoMessage: "video", documentMessage: "document", stickerMessage: "sticker" };

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "by", "after", "kinds"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const since = typeof settings.history_since === "string" && Number.isFinite(Date.parse(settings.history_since)) ? new Date(settings.history_since).toISOString() : null;
  const remember = Number(settings.remember);
  return {
    where: typeof settings.where === "string" && settings.where ? settings.where : "whatsapp",
    phone: settings.phone ? String(settings.phone).replace(/\D/g, "") || null : null,
    history_since: since,
    include_own: settings.include_own === true,
    kinds: Array.isArray(settings.kinds) && settings.kinds.every((kind) => typeof kind === "string") ? settings.kinds : ["seed"],
    connection: settings.connection && typeof settings.connection === "object" ? settings.connection : {},
    remember: Number.isInteger(remember) && remember > 0 ? remember : 500,
  };
}

/** The content of a message, out of every wrapper it sits in. */
export function contentOf(message) {
  let body = message ?? null;
  for (let depth = 0; depth < 6 && body; depth += 1) {
    const wrapper = WRAPPERS.find((name) => body[name]?.message);
    if (!wrapper) break;
    body = body[wrapper].message;
  }
  return body;
}

const base64 = (value) => (value == null ? null : typeof value === "string" ? value : Buffer.from(value).toString("base64"));
const seconds = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
const timeOf = (value) => {
  const number = Number(value?.low ?? value);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
};

/** The words and media of a message's content; null when it carries neither (a reaction, a receipt, a protocol message). */
export function partsOf(body) {
  if (!body || body.protocolMessage || body.reactionMessage) return null;
  const words = body.conversation ?? body.extendedTextMessage?.text ?? body.imageMessage?.caption ?? body.videoMessage?.caption ?? body.documentMessage?.caption ?? null;
  const media = [];
  for (const [field, kind] of Object.entries(MEDIA)) {
    const item = body[field];
    if (!item) continue;
    media.push(Object.fromEntries(Object.entries({
      kind: field === "audioMessage" && item.ptt ? "voice_note" : kind,
      identity: base64(item.fileSha256),
      seconds: seconds(item.seconds),
      media_type: item.mimetype ?? null,
      bytes: seconds(item.fileLength?.low ?? item.fileLength),
      name: item.fileName ?? null,
    }).filter(([, value]) => value !== null)));
  }
  if (!words && !media.length) return null;
  const context = Object.values(body).find((value) => value && typeof value === "object" && value.contextInfo)?.contextInfo;
  return { words: words ?? null, media, reply_to: context?.stanzaId ?? null };
}

/** `after` as JSON text within CARRIED_BYTES. Over it, media keeps only its kind, identity and length, then the words are cut
 *  to fit and marked `words_cut` (their whole length in bytes), then media past what fits is left out and counted. */
export function afterOf({ chat, chat_name, group, from = null, words, media, reply_to }) {
  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= CARRIED_BYTES;
  const whole = { chat, chat_name: chat_name ?? null, group, from, words, media, reply_to: reply_to ? `${chat}/${reply_to}` : null };
  if (fits(whole)) return JSON.stringify(whole);
  let lean = { ...whole, media: media.map(({ kind, identity, seconds }) => Object.fromEntries(Object.entries({ kind, identity, seconds }).filter(([, value]) => value !== undefined))) };
  if (fits(lean)) return JSON.stringify(lean);
  if (words) {
    const letters = Array.from(words);
    const cut = (count) => ({ ...lean, words: letters.slice(0, count).join(""), words_cut: Buffer.byteLength(words) });
    let low = 0;
    let high = letters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(cut(middle))) low = middle; else high = middle - 1;
    }
    lean = cut(low);
    if (fits(lean)) return JSON.stringify(lean);
  }
  const kept = [...lean.media];
  while (kept.length && !fits({ ...lean, media: kept, media_cut: media.length - kept.length })) kept.pop();
  return JSON.stringify({ ...lean, media: kept, media_cut: media.length - kept.length });
}

const wordsIdentity = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

/**
 * The changes one socket event holds, each {event_key, at, detail}, in the order WhatsApp sent them.
 * `context`: { own (settings), account (the linked account's jid), since (ISO or null: the oldest time an older message is
 * told from), names (chat jid → name) }.
 */
export function changesOf(event, data, context) {
  const { own, account } = context;
  const changes = [];
  const fact = (change, item, { at, by, parts = null }) => {
    const chat = item.key.remoteJid;
    const key = `${chat}/${item.key.id}`;
    const group = chat.endsWith("@g.us");
    // The sender rides in after as well as by: a chosen workflow is given only the fact's own fields as the router passes
    // them, and readers such as the history keeper find who a message is from at $.after.from.
    const after = parts ? afterOf({ chat, chat_name: context.names?.get(chat) ?? (group ? null : item.pushName ?? null), group, from: by ?? null, ...parts }) : JSON.stringify({ chat, group, from: by ?? null });
    const event_key = change === "changed" ? `${key}:changed:${wordsIdentity(parts)}` : `${key}:${change}`;
    changes.push({ event_key, at, detail: { where: own.where, place: "message", change, at, key, by: by ?? null, after, kinds: JSON.stringify(own.kinds) } });
  };
  const senderOf = (item) => (item.key.fromMe ? account : item.key.participant ?? item.participant ?? item.key.remoteJid);
  const wanted = (item) => item?.key?.id && item.key.remoteJid && item.key.remoteJid !== "status@broadcast" && (own.include_own || !item.key.fromMe);
  if (event === "messages.upsert" || event === "messaging-history.set") {
    const live = event === "messages.upsert" && data.type === "notify";
    for (const item of data.messages ?? []) {
      if (!wanted(item)) continue;
      const at = timeOf(item.messageTimestamp);
      if (!at) continue;
      if (!live && (!context.since || at < context.since)) continue;
      const parts = partsOf(contentOf(item.message));
      if (!parts) continue;
      fact("added", item, { at, by: senderOf(item), parts });
    }
  }
  if (event === "messages.update") {
    for (const { key, update } of Array.isArray(data) ? data : []) {
      const item = { key, pushName: null };
      if (!wanted(item) || !update) continue;
      if (update.messageStubType === REVOKED && update.message === null) {
        fact("removed", item, { at: new Date(context.now()).toISOString(), by: senderOf(item) });
        continue;
      }
      const edited = update.message?.editedMessage?.message;
      if (!edited) continue;
      const parts = partsOf(contentOf(edited));
      if (!parts) continue;
      fact("changed", item, { at: timeOf(update.messageTimestamp) ?? new Date(context.now()).toISOString(), by: senderOf(item), parts });
    }
  }
  return changes;
}

/** The fact a linking step is told as: a phone code while one is open, then linked or logged out. */
export function linkChange(own, step, at) {
  const kinds = { pairing_required: ["whatsapp-link-code"], connected: ["whatsapp-linked"], logged_out: ["whatsapp-logged-out"] }[step.state];
  const after = step.state === "pairing_required"
    ? { state: step.state, code: step.code, expires_after_seconds: step.expires_after_seconds, how: "On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then type this code." }
    : { state: step.state, account: step.account ?? null };
  const change = step.state === "pairing_required" ? "added" : step.state === "connected" ? "changed" : "removed";
  return { event_key: `link:${step.state}:${step.code ?? at}`, at, detail: { where: own.where, place: "link", change, at, key: `link:${own.where}`, by: null, after: JSON.stringify(after), kinds: JSON.stringify(kinds) } };
}

/**
 * An agent that opens each https connection as a CONNECT tunnel through the run's proxy (the engine names it in HTTPS_PROXY:
 * a sandboxed run reaches the internet only through it), then speaks TLS to the named host inside the tunnel.
 */
export function proxyAgent(proxy, { request = http.request, connect = tls.connect } = {}) {
  const { hostname, port } = new URL(proxy);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, done) => {
    const host = options.host ?? options.hostname;
    const target = `${host}:${options.port ?? 443}`;
    const asked = request({ host: hostname, port: Number(port), method: "CONNECT", path: target, headers: { host: target } });
    asked.once("connect", (answer, socket) => {
      if (answer.statusCode !== 200) { socket.destroy(); done(new Error(`the run's proxy did not open ${target} (answered ${answer.statusCode})`)); return; }
      done(null, connect({ socket, servername: options.servername ?? host }));
    });
    asked.once("error", (error) => done(error));
    asked.end();
  };
  return agent;
}

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Hold the account open and report each message change as it arrives.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, state ({told, linked_at}), keepState, folder (this waiter's own folder),
 *   and for tests: load (the Baileys module), connectionOf (makes the connection), now, proxy, look_ms
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const now = handlers.now ?? (() => Date.now());
  if (!handlers.folder) throw Object.assign(new Error("A WhatsApp waiter needs a folder of its own to keep its linked session in; this run has no kept folder."), { reason: "no-folder-to-keep-the-session" });
  const row = carryConnections.connections.find((connection) => connection.vendor === "whatsapp");
  const proxy = handlers.proxy !== undefined ? handlers.proxy : process.env.HTTPS_PROXY;
  const look = handlers.look_ms ?? 2000;

  let state = { told: [], linked_at: null, ...(handlers.state ?? {}) };
  let told = new Set(state.told);
  const names = new Map();
  let queue = Promise.resolve();

  // Facts are told one at a time, in the order WhatsApp sent them; a refused one is kept to try with the next.
  const tell = (change) => {
    queue = queue.then(async () => {
      if (signal?.aborted || told.has(change.event_key)) return;
      const nextTold = [...state.told.filter((key) => key !== change.event_key), change.event_key].slice(-own.remember);
      const nextState = { ...state, told: nextTold };
      const accepted = await handlers.onTransition({ condition: "became-reachable", observed_identity: { where: own.where, place: change.detail.place }, event_key: change.event_key, state: nextState, detail: change.detail });
      if (accepted === false) return;
      state = nextState;
      told = new Set(nextTold);
    }).catch(() => {});
    return queue;
  };

  const observe = ({ event, data, account, socket }) => {
    // A group's name is asked once per group and kept for this run; a failed ask leaves it unnamed.
    const groups = new Set();
    for (const item of event === "messages.update" ? [] : data.messages ?? []) if (item?.key?.remoteJid?.endsWith("@g.us") && !names.has(item.key.remoteJid)) groups.add(item.key.remoteJid);
    for (const chat of data.chats ?? []) if (chat?.id && chat.name) names.set(chat.id, chat.name);
    for (const contact of data.contacts ?? []) if (contact?.id && (contact.name || contact.notify)) names.set(contact.id, contact.name ?? contact.notify);
    const named = Promise.all([...groups].map((chat) => Promise.resolve(socket?.groupMetadata?.(chat)).then((meta) => { if (meta?.subject) names.set(chat, meta.subject); }).catch(() => {})));
    const since = own.history_since ?? state.linked_at;
    queue = queue.then(() => named).then(() => {
      for (const change of changesOf(event, data, { own, account, since, names, now })) void tell(change);
    });
  };

  const connection = (handlers.connectionOf ?? whatsapp)({ ...row, incoming: null, ...own.connection }, {
    folder: handlers.folder,
    ...(handlers.load ? { load: handlers.load } : {}),
    now,
    observe,
    socketOptions: proxy ? { agent: proxyAgent(proxy) } : {},
    log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  });

  // A pairing told a code: the first time the socket then opens registered, however long after the code's window (WhatsApp
  // restarts the socket with 515 once the code is entered), linking is told, once.
  let pairing = false;
  const linked = async () => {
    state = { ...state, linked_at: state.linked_at ?? new Date(now()).toISOString() };
    if (!pairing) return;
    pairing = false;
    await tell(linkChange(own, { state: "connected", account: connection.status().account }, new Date(now()).toISOString()));
  };

  try {
    while (!signal?.aborted) {
      const status = connection.status();
      if (status.state === "connected") { await linked(); await wait(look, signal); continue; }
      // Logged out: WhatsApp no longer takes this session; it is told, and linking starts again with a new code.
      if (status.logged_out) await tell(linkChange(own, { state: "logged_out", account: status.account }, new Date(now()).toISOString()));
      else if (status.linked) {
        const started = await connection.start();
        if (started.carried) {
          const first = !state.linked_at;
          await linked();
          if (first) await handlers.keepState?.(state);
        }
        if (!started.carried) await wait(look, signal);
        continue;
      }
      if (!own.phone) throw Object.assign(new Error("WhatsApp is not linked for this waiter and it names no phone to ask a code for."), { reason: "not-linked-and-no-phone" });
      // One pairing window: tell its code, then wait for the person to enter it or for it to run out.
      const step = await connection.connect({ phone: own.phone });
      const at = new Date(now()).toISOString();
      if (step.state === "pairing_required") {
        await tell(linkChange(own, step, at));
        pairing = true;
        const until = now() + Math.max(1, Number(step.expires_after_seconds) || 60) * 1000;
        // Wait out the code's window, or until WhatsApp takes it: registered (the 515 restart that follows) or open.
        while (!signal?.aborted && now() < until && connection.status().state !== "connected" && !connection.status().linked) await wait(Math.min(look, 1000), signal);
        continue;
      }
      if (step.state === "connected") {
        pairing = true;
        await linked();
        continue;
      }
      await wait(look, signal);
    }
  } finally {
    connection.stop();
    await queue;
  }
}
