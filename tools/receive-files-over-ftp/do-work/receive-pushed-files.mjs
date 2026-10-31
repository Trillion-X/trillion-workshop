#!/usr/bin/env node
/**
 * tools/receive-files-over-ftp/do-work/receive-pushed-files.mjs
 *
 * Purpose
 *   A resident receiver that speaks the file transfer protocol (RFC 959, with the
 *   passive-mode and explicit-TLS extensions senders actually use) so that a device
 *   which can only push files this way can hand them to this computer over the
 *   network with nobody present. Cameras, scanners, drones, printers, industrial
 *   controllers, and older build systems all speak it; none of them can be taught
 *   anything else.
 *
 *     node receive-pushed-files.mjs --folder <place to keep files> --settings <settings file>
 *
 *   It runs until it is stopped (SIGINT or SIGTERM) and prints one line when it is listening.
 *
 * Non-negotiable invariants
 *   - This process knows nothing about what a file IS and nothing about who reacts to
 *     it. It writes bytes and one completion note per finished file into the folder it
 *     was handed, and that is all.
 *   - The completion note is written LAST, after the last byte is on disk and
 *     flushed. A reader that keys on the note therefore never sees a half file.
 *   - The transfer is acknowledged to the sender only after the note is on disk.
 *     A sender that does not get the acknowledgement retries, which is exactly
 *     the behaviour wanted when this computer could not take custody.
 *   - The content identity in the note is the identity of the bytes that are on disk:
 *     tools/content-identity's BLAKE3, read from the flushed file before the note is
 *     written.
 *   - Every path a sender names is resolved inside the folder, and a path that
 *     would leave it is refused with a protocol error. There is no other place this
 *     process can write.
 *   - Who may push is DATA (the senders in the settings file), and there is no sender
 *     built in: with none declared the receiver does not start. The value written into
 *     the note for a sender is the opaque string its row maps the login to, so nothing
 *     downstream ever sees a protocol login.
 *   - It spawns nothing and reads nothing outside its folder except the settings file and
 *     the certificate and key it was handed as inputs, when transport security is
 *     configured.
 *
 * Key concepts
 *   control connection   the command channel, one per sender session
 *   data connection      one per transfer, opened by the sender in passive mode
 *   completion note      `<name><suffix>`, JSON, the identity carrier
 *
 * Security
 *   Binds the declared host and port (loopback unless the settings say another address).
 *   Passwords are compared in constant time and are never printed. No command is ever
 *   passed to a shell. Active-mode (PORT) connections, where the receiver would dial
 *   out to an address the sender names, are refused, so this process never originates a
 *   connection. Listing and deletion are limited to the folder, and deletion only ever
 *   removes a file that is not finished, which is how a sender aborts a push.
 */

import { createServer as createTcpServer, isIP } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { closeSync, createWriteStream, openSync, promises as fsp, readSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { makeHashCodeHexFromChunks } from "../../content-identity/read-data/identity.mjs";

/** Read the settings from a parsed settings file, with declared fallbacks. Nothing here is a person's: the senders,
 *  addresses and media types all come from the file. Throws, saying what to give, when no sender is declared.
 *
 *  { listen_host, listen_port, advertised_host, passive_port_first, passive_port_last, completion_note_suffix,
 *    senders: [{ login, password, handed_over_by }], media_types_by_extension: { mp4: "video/mp4" },
 *    tls_certificate_file, tls_private_key_file } */
export function readSettings(file = {}) {
  const wholePort = (value, fallback, least) => (Number.isInteger(value) && value >= least && value < 65536 ? value : fallback);
  const senders = (Array.isArray(file.senders) ? file.senders : [])
    .filter((row) => row && typeof row === "object" && nonEmpty(row.login) && nonEmpty(row.handed_over_by) && nonEmpty(row.password))
    .map((row) => ({ login: String(row.login), password: String(row.password), handed_over_by: String(row.handed_over_by) }));
  if (senders.length === 0) {
    throw new Error("settings need at least one sender: { \"login\": ..., \"password\": ..., \"handed_over_by\": ... } with all three words filled in. There is no built-in sender.");
  }
  const mediaTypes = file.media_types_by_extension && typeof file.media_types_by_extension === "object" && !Array.isArray(file.media_types_by_extension) ? file.media_types_by_extension : {};
  return {
    listen_host: nonEmpty(file.listen_host) ?? "127.0.0.1",
    listen_port: wholePort(file.listen_port, 2121, 0),
    passive_port_first: wholePort(file.passive_port_first, 0, 1),
    passive_port_last: wholePort(file.passive_port_last, 0, 1),
    /** The address advertised to a sender in the passive reply. Empty means "the
     *  address this control connection arrived on", which is right on one LAN. */
    advertised_host: nonEmpty(file.advertised_host) ?? "",
    completion_note_suffix: nonEmpty(file.completion_note_suffix) ?? ".finished.json",
    senders,
    media_types_by_extension: Object.fromEntries(
      Object.entries(mediaTypes)
        .filter(([ext, type]) => nonEmpty(ext) && nonEmpty(type))
        .map(([ext, type]) => [ext.toLowerCase().replace(/^\./, ""), String(type)]),
    ),
    tls_certificate_file: nonEmpty(file.tls_certificate_file) ?? "",
    tls_private_key_file: nonEmpty(file.tls_private_key_file) ?? "",
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Resolve a sender-named path inside the working directory, or return null.
 *
 *  Pure. The protocol lets a sender name any path; this is the one place that
 *  decides whether it is inside the only place this process may write. */
export function resolveInsideRoot(root, currentDir, named) {
  // A parent segment anywhere in what the sender named is refused outright. POSIX
  // normalisation clamps `..` at the root, which would turn an escape attempt into a
  // quiet write inside the root; a sender that means to escape gets an error instead.
  if (named.split("/").some((segment) => segment === "..")) return null;
  const base = named.startsWith("/") ? "/" : currentDir;
  const virtual = path.posix.normalize(path.posix.join(base, named));
  const relative = virtual.replace(/^\/+/, "");
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (relation.startsWith("..") || path.isAbsolute(relation)) return null;
  return { virtual, relative, absolute };
}

const COMPARE_KEY = randomBytes(32);
const sealed = (text) => createHmac("sha256", COMPARE_KEY).update(String(text ?? "")).digest();

/** Which opaque identity a login maps to, or null. The passwords are compared as fixed-length seals, in constant time. */
export function identifySender(senders, login, password) {
  for (const row of senders) {
    if (row.login !== login) continue;
    return timingSafeEqual(sealed(row.password), sealed(password)) ? row.handed_over_by : null;
  }
  return null;
}

/** Media type for a finished unit, from the DATA table, or the generic type. */
export function mediaTypeForName(name, table) {
  const ext = path.posix.extname(name).replace(/^\./, "").toLowerCase();
  return (ext && table[ext]) || "application/octet-stream";
}

/** The completion note for one finished unit. Pure. */
export function completionNote({ contentIdentity, byteLength, mediaType, finishedAtMs, handedOverBy }) {
  return {
    content_identity: contentIdentity,
    byte_length: byteLength,
    media_type: mediaType,
    finished_at_ms: finishedAtMs,
    handed_over_by: handedOverBy,
  };
}

/** The identity of a flushed file's bytes, read in bounded chunks so a file larger than memory costs no memory. */
export function identityOfFile(file) {
  function* chunks() {
    const handle = openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      for (let read = readSync(handle, buffer, 0, buffer.length, null); read > 0; read = readSync(handle, buffer, 0, buffer.length, null)) {
        yield buffer.subarray(0, read);
      }
    } finally {
      closeSync(handle);
    }
  }
  return makeHashCodeHexFromChunks(chunks());
}

/** Format a passive-mode reply: host octets and the port split into two bytes. */
export function passiveReply(host, port) {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`passive reply needs a dotted IPv4 host, got ${host}`);
  }
  return `227 Entering Passive Mode (${octets.join(",")},${Math.floor(port / 256)},${port % 256})`;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

/** One session on one control connection. */
class Session {
  constructor({ socket, settings, root, secureContext, nowMs, onFinished, log }) {
    this.socket = socket;
    this.settings = settings;
    this.root = root;
    this.secureContext = secureContext;
    this.nowMs = nowMs;
    this.onFinished = onFinished;
    this.log = log;
    this.currentDir = "/";
    this.pendingLogin = null;
    this.handedOverBy = null;
    this.passive = null;
    this.protectData = false;
    this.renameFrom = null;
    this.buffer = "";
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        void this.handle(line);
      }
    });
    socket.on("error", () => { /* the sender went away; nothing to do */ });
    socket.on("close", () => this.closePassive());
  }

  reply(text) {
    if (!this.socket.destroyed) this.socket.write(`${text}\r\n`, "latin1");
  }

  closePassive() {
    const passive = this.passive;
    if (!passive) return;
    this.passive = null;
    try { passive.server.close(); } catch { /* already closed */ }
    if (passive.socket) {
      try { passive.socket.destroy(); } catch { /* gone */ }
    }
  }

  async handle(line) {
    const space = line.indexOf(" ");
    const command = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const argument = space < 0 ? "" : line.slice(space + 1);
    try {
      await this.dispatch(command, argument);
    } catch (error) {
      this.log(`session error on ${command}: ${error?.message ?? error}`);
      this.reply("451 Requested action aborted: local error in processing");
    }
  }

  requireSender() {
    if (this.handedOverBy) return true;
    this.reply("530 Please login with USER and PASS");
    return false;
  }

  async dispatch(command, argument) {
    switch (command) {
      case "USER":
        this.pendingLogin = argument;
        this.reply("331 Password required");
        return;
      case "PASS": {
        const identity = identifySender(this.settings.senders, this.pendingLogin ?? "", argument);
        if (!identity) {
          this.reply("530 Login incorrect");
          return;
        }
        this.handedOverBy = identity;
        this.reply("230 Login successful");
        return;
      }
      case "AUTH":
        if (argument.toUpperCase() !== "TLS" && argument.toUpperCase() !== "SSL") {
          this.reply("504 Command not implemented for that parameter");
          return;
        }
        if (!this.secureContext) {
          this.reply("534 Transport security is not configured on this receiver");
          return;
        }
        this.reply("234 Proceed with negotiation");
        this.upgradeControlToTls();
        return;
      case "PBSZ":
        this.reply("200 PBSZ=0");
        return;
      case "PROT":
        this.protectData = argument.toUpperCase() === "P";
        this.reply(this.protectData || argument.toUpperCase() === "C" ? "200 Protection level set" : "504 Command not implemented for that parameter");
        return;
      case "SYST":
        this.reply("215 UNIX Type: L8");
        return;
      case "FEAT":
        this.reply("211-Features:\r\n PASV\r\n EPSV\r\n SIZE\r\n MLST\r\n UTF8\r\n AUTH TLS\r\n PBSZ\r\n PROT\r\n211 End");
        return;
      case "OPTS":
        this.reply("200 OK");
        return;
      case "NOOP":
        this.reply("200 OK");
        return;
      case "TYPE":
        this.reply("200 Type set");
        return;
      case "PWD":
      case "XPWD":
        if (!this.requireSender()) return;
        this.reply(`257 "${this.currentDir}" is the current directory`);
        return;
      case "CWD":
      case "XCWD": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument || "/");
        if (!target) { this.reply("550 Path is outside the receiving folder"); return; }
        try {
          const info = await fsp.stat(target.absolute);
          if (!info.isDirectory()) { this.reply("550 Not a directory"); return; }
        } catch {
          this.reply("550 No such directory");
          return;
        }
        this.currentDir = target.virtual;
        this.reply("250 Directory changed");
        return;
      }
      case "CDUP":
        return this.dispatch("CWD", "..");
      case "MKD":
      case "XMKD": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument);
        if (!target || target.relative === "") { this.reply("550 Path is outside the receiving folder"); return; }
        await fsp.mkdir(target.absolute, { recursive: true });
        this.reply(`257 "${target.virtual}" created`);
        return;
      }
      case "SIZE": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument);
        if (!target) { this.reply("550 Path is outside the receiving folder"); return; }
        try {
          const info = await fsp.stat(target.absolute);
          this.reply(`213 ${info.size}`);
        } catch {
          this.reply("550 No such file");
        }
        return;
      }
      case "DELE": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument);
        if (!target) { this.reply("550 Path is outside the receiving folder"); return; }
        // A sender may withdraw only a unit it has not finished: once the note
        // exists the unit belongs to this computer and deletion is somebody
        // else's decision, made from the log.
        try {
          await fsp.access(`${target.absolute}${this.settings.completion_note_suffix}`);
          this.reply("550 Finished units are not deleted over this protocol");
          return;
        } catch { /* no note, so still the sender's */ }
        try {
          await fsp.unlink(target.absolute);
          this.reply("250 Deleted");
        } catch {
          this.reply("550 No such file");
        }
        return;
      }
      case "PASV":
      case "EPSV": {
        if (!this.requireSender()) return;
        await this.openPassive(command === "EPSV");
        return;
      }
      case "PORT":
      case "EPRT":
        this.reply("502 Active mode is refused; use passive mode");
        return;
      case "LIST":
      case "NLST":
      case "MLSD": {
        if (!this.requireSender()) return;
        await this.sendListing(command, argument);
        return;
      }
      case "STOR": {
        if (!this.requireSender()) return;
        await this.receiveFile(argument);
        return;
      }
      case "RNFR": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument);
        if (!target) { this.reply("550 Path is outside the receiving folder"); return; }
        this.renameFrom = target;
        this.reply("350 Ready for destination name");
        return;
      }
      case "RNTO": {
        if (!this.requireSender()) return;
        const target = resolveInsideRoot(this.root, this.currentDir, argument);
        if (!target || !this.renameFrom) { this.reply("550 Path is outside the receiving folder"); return; }
        try {
          await fsp.access(`${this.renameFrom.absolute}${this.settings.completion_note_suffix}`);
          this.reply("550 Finished units are not renamed over this protocol");
          return;
        } catch { /* not finished */ }
        await fsp.rename(this.renameFrom.absolute, target.absolute);
        this.renameFrom = null;
        this.reply("250 Renamed");
        return;
      }
      case "QUIT":
        this.reply("221 Goodbye");
        this.socket.end();
        return;
      default:
        this.reply("502 Command not implemented");
    }
  }

  upgradeControlToTls() {
    const plain = this.socket;
    plain.removeAllListeners("data");
    const secure = new TLSSocket(plain, { isServer: true, secureContext: this.secureContext });
    this.buffer = "";
    this.attach(secure);
  }

  async openPassive(extended) {
    this.closePassive();
    const server = createTcpServer({ pauseOnConnect: true });
    // A sender may open the data connection the instant it reads the passive
    // reply, before the command that uses it has been processed. The socket is
    // held here until that command asks for it; a listener attached only at that
    // moment would drop an early connection on the floor and the transfer would
    // wait out its timeout for a connection that had already happened.
    const passive = { server, socket: null, waiter: null };
    server.on("connection", (socket) => {
      if (passive.waiter) {
        const waiter = passive.waiter;
        passive.waiter = null;
        waiter(socket);
      } else if (!passive.socket) {
        passive.socket = socket;
      } else {
        socket.destroy();
      }
    });
    let address = null;
    const first = this.settings.passive_port_first;
    const last = this.settings.passive_port_last;
    if (first > 0 && last >= first) {
      for (let port = first; port <= last && !address; port += 1) {
        try {
          address = await listen(server, port, this.settings.listen_host);
        } catch (error) {
          if (error?.code !== "EADDRINUSE") throw error;
        }
      }
      if (!address) { this.reply("425 No passive port free"); return; }
    } else {
      address = await listen(server, 0, this.settings.listen_host);
    }
    this.passive = passive;
    const host = this.settings.advertised_host || this.socket.localAddress?.replace(/^::ffff:/, "") || "127.0.0.1";
    if (extended) this.reply(`229 Entering Extended Passive Mode (|||${address.port}|)`);
    else if (isIP(host) === 4) this.reply(passiveReply(host, address.port));
    else this.reply(`229 Entering Extended Passive Mode (|||${address.port}|)`);
  }

  /** Wait for the sender to open the data connection on the passive port. */
  dataConnection() {
    return new Promise((resolve, reject) => {
      const passive = this.passive;
      if (!passive) { reject(new Error("no passive connection open")); return; }
      let timer = null;
      const finish = (socket) => {
        if (timer) clearTimeout(timer);
        passive.socket = null;
        this.closePassive();
        if (this.protectData && this.secureContext) {
          const secure = new TLSSocket(socket, { isServer: true, secureContext: this.secureContext });
          secure.resume();
          resolve(secure);
        } else {
          socket.resume();
          resolve(socket);
        }
      };
      if (passive.socket) {
        finish(passive.socket);
        return;
      }
      timer = setTimeout(() => {
        passive.waiter = null;
        this.closePassive();
        reject(new Error("data connection timed out"));
      }, 30000);
      passive.waiter = finish;
    });
  }

  async sendListing(command, argument) {
    const target = resolveInsideRoot(this.root, this.currentDir, argument || ".");
    if (!target) { this.reply("550 Path is outside the receiving folder"); return; }
    let entries;
    try {
      entries = await fsp.readdir(target.absolute, { withFileTypes: true });
    } catch {
      this.reply("550 No such directory");
      return;
    }
    const lines = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (command === "NLST") { lines.push(entry.name); continue; }
      let size = 0;
      try { size = (await fsp.stat(path.join(target.absolute, entry.name))).size; } catch { size = 0; }
      if (command === "MLSD") lines.push(`type=${entry.isDirectory() ? "dir" : "file"};size=${size}; ${entry.name}`);
      else lines.push(`${entry.isDirectory() ? "d" : "-"}rw-r--r-- 1 owner owner ${size} Jan 01 00:00 ${entry.name}`);
    }
    this.reply("150 Opening data connection for listing");
    const data = await this.dataConnection();
    data.end(`${lines.join("\r\n")}${lines.length ? "\r\n" : ""}`, "latin1");
    await new Promise((resolve) => data.on("close", resolve));
    data.destroy();
    this.reply("226 Listing complete");
  }

  async receiveFile(argument) {
    const target = resolveInsideRoot(this.root, this.currentDir, argument);
    if (!target || target.relative === "") { this.reply("553 Path is outside the receiving folder"); return; }
    try {
      await fsp.access(`${target.absolute}${this.settings.completion_note_suffix}`);
      this.reply("553 A finished unit with that name already exists");
      return;
    } catch { /* fresh */ }
    await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
    this.reply("150 Ready to receive");
    let data;
    try {
      data = await this.dataConnection();
    } catch (error) {
      this.reply(`425 ${error?.message ?? "cannot open data connection"}`);
      return;
    }
    let byteLength = 0;
    const out = createWriteStream(target.absolute, { flags: "w" });
    let failed = null;
    await new Promise((resolve) => {
      data.on("data", (chunk) => {
        byteLength += chunk.length;
        if (!out.write(chunk)) {
          data.pause();
          out.once("drain", () => data.resume());
        }
      });
      data.on("error", (error) => { failed = error; resolve(); });
      data.on("end", () => resolve());
      data.on("close", () => resolve());
    });
    await new Promise((resolve) => out.end(resolve));
    data.destroy();
    if (failed) {
      this.reply("426 Connection closed; transfer aborted");
      return;
    }
    // Durability before acknowledgement: flush the bytes, take their identity, write the note, then
    // and only then tell the sender it is done.
    const handle = await fsp.open(target.absolute, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    const note = completionNote({
      contentIdentity: identityOfFile(target.absolute),
      byteLength,
      mediaType: mediaTypeForName(target.relative, this.settings.media_types_by_extension),
      finishedAtMs: this.nowMs(),
      handedOverBy: this.handedOverBy,
    });
    const notePath = `${target.absolute}${this.settings.completion_note_suffix}`;
    const tempNote = `${notePath}.writing`;
    try {
      await fsp.writeFile(tempNote, `${JSON.stringify(note)}\n`);
      await fsp.rename(tempNote, notePath);
    } catch (error) {
      this.log(`could not write completion note for ${target.relative}: ${error?.message ?? error}`);
      this.reply("451 Received but could not record completion; please send again");
      return;
    }
    this.onFinished?.({ relative_name: target.relative, ...note });
    this.reply("226 Transfer complete");
  }
}

/**
 * Run the receiver until the signal fires.
 *
 * @param {object} options
 * @param {object} options.settings from readSettings
 * @param {string} options.root the folder files are kept in; there is no default
 * @param {AbortSignal} [options.signal]
 * @param {()=>number} [options.nowMs]
 * @param {(note:object)=>void} [options.onFinished] observer for tests
 * @param {(line:string)=>void} [options.log]
 * @returns {Promise<{address: {port:number, address:string}, close: () => Promise<void>}>}
 */
export async function runReceiver({
  settings,
  root,
  signal,
  nowMs = () => Date.now(),
  onFinished,
  log = (line) => console.error(`receive-files-over-ftp: ${line}`),
} = {}) {
  if (!settings || typeof root !== "string" || !root) throw new Error("runReceiver needs settings (from readSettings) and root, the folder to keep files in.");
  const resolvedRoot = path.resolve(root);
  let secureContext = null;
  if (settings.tls_certificate_file && settings.tls_private_key_file) {
    secureContext = createSecureContext({
      cert: await fsp.readFile(path.resolve(resolvedRoot, settings.tls_certificate_file)),
      key: await fsp.readFile(path.resolve(resolvedRoot, settings.tls_private_key_file)),
    });
  }
  const sessions = new Set();
  const server = createTcpServer((socket) => {
    const session = new Session({ socket, settings, root: resolvedRoot, secureContext, nowMs, onFinished, log });
    sessions.add(session);
    socket.on("close", () => sessions.delete(session));
    session.reply("220 Ready to receive files");
  });
  const address = await listen(server, settings.listen_port, settings.listen_host);
  log(`listening on ${address.address}:${address.port}, ${settings.senders.length} sender identities declared`);
  const close = () => new Promise((resolve) => {
    for (const session of sessions) {
      session.closePassive();
      try { session.socket.destroy(); } catch { /* gone */ }
    }
    server.close(() => resolve());
  });
  if (signal?.aborted) await close();
  else signal?.addEventListener("abort", () => { void close(); }, { once: true });
  return { address, close };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const named = (flag) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };
  const folder = named("--folder");
  const settingsFile = named("--settings");
  try {
    if (!folder || !settingsFile) throw new Error("usage: receive-pushed-files.mjs --folder <folder to keep files in> --settings <settings file>");
    const settings = readSettings(JSON.parse(await fsp.readFile(settingsFile, "utf8")));
    const controller = new AbortController();
    process.on("SIGTERM", () => controller.abort());
    process.on("SIGINT", () => controller.abort());
    const receiver = await runReceiver({ settings, root: folder, signal: controller.signal });
    console.log(JSON.stringify({ listening: { host: receiver.address.address, port: receiver.address.port }, folder: path.resolve(folder) }));
  } catch (error) {
    console.error(`receive-files-over-ftp: cannot start: ${error?.message ?? error}`);
    process.exit(1);
  }
}
