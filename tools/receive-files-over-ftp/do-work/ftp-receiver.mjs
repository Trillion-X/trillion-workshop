// parts/receive-files-over-ftp/do-work/ftp-receiver.mjs
//
// Purpose: accept files a device pushes over FTP (a camera's automatic transfer, a scanner, a recorder) into one
// folder on this computer, and tell the caller about each file the moment the device starts sending it (so it can be
// sent on while it arrives) and again once the device has finished. The receiver keeps nothing else: what happens to
// a file afterwards (sending it on, deleting it) is the caller's.
//
// What a device can do here, the commands passive-mode FTP clients use to deliver files:
//   sign in (USER/PASS), secure the session (AUTH TLS, PBSZ, PROT P: FTPES), move between folders (CWD, CDUP, PWD,
//   MKD), open a passive data connection (PASV, EPSV), send a file (STOR, APPE, REST to resume), ask whether a name
//   is taken (SIZE, LIST, NLST), rename or delete what it sent (RNFR/RNTO, DELE), and the usual courtesies (FEAT,
//   SYST, TYPE, OPTS, NOOP, STAT, QUIT). Active mode (PORT/EPRT) and reading files back (RETR) are refused.
//
// Non-Negotiable Invariants:
//   1. A file is reported (`onFile`) only after its data connection ended normally, never a part of an interrupted
//      send. A part stays in the folder so a device that resumes (REST + STOR) continues it.
//   2. Every path a device names stays inside `folder`: `..` cannot climb out of it.
//   3. Nothing but sign-in, securing and courtesies is answered before sign-in succeeds; when `requireSecure` is set,
//      the password is refused until the session is secured, so it never crosses the network in the clear.
//   4. A file renamed right after it arrived (RNFR/RNTO within `settleMs`) is reported once, under its final name;
//      every rename is also told to `onRename`, so a file already being sent on can follow its new name.
//   5. `taken` answers "is this name taken" for files the caller already moved away, so a device set not to overwrite
//      keeps choosing new names after the caller deleted the local copy.
//   6. A data port answers only the address that opened the session.
//   7. `onArriving` hears a file the moment its bytes start landing, with `finished`: a promise that resolves with the
//      file's size once the data connection ended normally and rejects when it broke off (the part stays for a resume).
//   8. `onTransferred` hears a whole transfer, and what it keeps is kept, before the device is told the file arrived: a
//      restart after that tells a whole file from a part, and one before it leaves the device sending it again.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createWriteStream, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const posix = path.posix;
const plainAddress = address => (address ?? '').replace(/^::ffff:/, '');
const refusal = (code, message) => Object.assign(new Error(message), { code });

/** Where `name` (absolute or relative to `cwd`) points inside the folder, as a clean path like `/A/C0001.MP4`. */
export function insidePath(cwd, name) {
  return posix.normalize(posix.join('/', posix.isAbsolute(name) ? name : posix.join(cwd, name))).replace(/(.)\/+$/, '$1');
}

/**
 * Start a receiver.
 *   folder         where files land (created when missing)
 *   port, host     where devices connect ('0.0.0.0' by default: every network this computer is on)
 *   passivePorts   [first, last] for data connections; [0, 0] takes any free port
 *   secure         { key, cert } in PEM for FTPES, or null
 *   requireSecure  refuse a password before AUTH TLS (default: true when `secure` is given)
 *   signIn(user, password) → boolean
 *   onArriving({ path, file, finished })   a file whose bytes started landing; `finished` settles as described above
 *   onTransferred({ path, file, size })   a file whose bytes all arrived, awaited before the device is told so
 *   onFile({ path, file, size, from })   a file the device finished sending (`path` inside the folder, `file` on disk,
 *                                        `from` the address the device sent it from)
 *   onRename({ from, to })   a file the device renamed (paths inside the folder)
 *   taken          { size(path) → bytes | null, names(folderPath) → [name] } for files already moved away
 *   settleMs       how long a finished file waits for a rename before it is reported (1500)
 *   say(line)      one plain line per event
 * Returns { port, close(), setSecure({ key, cert }) }: setSecure changes the certificate for sessions that start after it
 * (a new one made for this computer's new address).
 */
export async function startFtpReceiver({ folder, port = 0, host = '0.0.0.0', passivePorts = [0, 0], secure = null, requireSecure = Boolean(secure), signIn, onArriving = () => {}, onTransferred = async () => {}, onFile, onRename = () => {}, taken = {}, settleMs = 1500, say = () => {} }) {
  if (typeof signIn !== 'function' || typeof onFile !== 'function') throw new Error('A receiver needs signIn and onFile.');
  await fs.mkdir(folder, { recursive: true });
  let context = secure ? tls.createSecureContext({ key: secure.key, cert: secure.cert }) : null;
  // One set of session tickets for the control and every data connection, so a client that resumes its control
  // session on the data connection (many FTPES clients insist on it) finds it.
  const ticketKeys = randomBytes(48);
  const secureSocket = async raw => {
    const socket = new tls.TLSSocket(raw, { isServer: true, secureContext: context, ticketKeys });
    await new Promise((resolve, reject) => { socket.once('secure', resolve); socket.once('error', reject); });
    socket.on('error', () => {});
    return socket;
  };
  // A data connection is secured the moment it arrives, without waiting for its handshake: many devices (cameras
  // among them) wait for the 150 reply before they start the handshake, so waiting for it first stalls both sides.
  // One that never completes its handshake is let go after 30 seconds.
  const secureAtOnce = raw => {
    const socket = new tls.TLSSocket(raw, { isServer: true, secureContext: context, ticketKeys });
    socket.on('error', () => {});
    const giveUp = setTimeout(() => socket.destroy(), 30 * 1000);
    giveUp.unref();
    socket.once('secure', () => clearTimeout(giveUp));
    socket.once('close', () => clearTimeout(giveUp));
    return socket;
  };
  const localFile = inside => path.join(folder, ...inside.split('/').filter(Boolean));
  const pending = new Map(); // path inside → timer of a finished file waiting for a possible rename
  const report = (inside, size, from) => {
    clearTimeout(pending.get(inside));
    pending.set(inside, setTimeout(() => { pending.delete(inside); onFile({ path: inside, file: localFile(inside), size, from }); }, settleMs));
  };
  const hold = inside => { clearTimeout(pending.get(inside)); return pending.delete(inside); };

  // A passive listener on the first free port of the range, on the address the device reached this computer at.
  async function listenPassive(address) {
    const [first, last] = passivePorts;
    for (let candidate = first; candidate <= Math.max(first, last); candidate += 1) {
      const server = net.createServer();
      if (await new Promise(resolve => { server.once('error', () => resolve(false)); server.listen(candidate, address, () => resolve(true)); })) return server;
    }
    throw refusal(425, 'No data port is free right now.');
  }

  function session(raw) {
    const remote = plainAddress(raw.remoteAddress);
    let socket = raw, buffered = '', user = null, signedIn = false, secured = false, protectData = false;
    let cwd = '/', restAt = 0, renameFrom = null, passive = null, queue = Promise.resolve();
    const reply = (code, text) => { if (!socket.destroyed) socket.write(`${code} ${text}\r\n`); };
    const closePassive = () => { passive?.close(); passive = null; };
    raw.on('error', () => {});
    raw.on('close', closePassive);

    const listen = () => {
      socket.setEncoding('utf8');
      socket.on('data', text => {
        buffered += text;
        for (let at; (at = buffered.indexOf('\n')) >= 0;) {
          const line = buffered.slice(0, at).replace(/\r$/, '');
          buffered = buffered.slice(at + 1);
          queue = queue.then(() => answer(line)).catch(error => {
            if (error.code >= 400 && error.code < 600) return reply(error.code, error.message);
            say(`${remote}: ${error.message}`);
            reply(451, 'That failed on this computer.');
          });
        }
      });
    };

    // The connection a device makes to the data port it was just given, secured on arrival when it asked for PROT P.
    // A device may connect as soon as it hears the port, before it names what it sends, so the port starts listening
    // for it at once (openPassive) and this only waits for that connection, never for its handshake.
    async function dataConnection() {
      if (!passive) throw refusal(425, 'Open a data port first (PASV or EPSV).');
      const { server, arrived } = passive;
      passive = null;
      try {
        const accepted = await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(refusal(425, 'No data connection arrived.')), 30 * 1000).unref())]);
        return accepted;
      } finally { server.close(); }
    }
    async function openPassive(address) {
      const server = await listenPassive(address);
      const arrived = new Promise(resolve => server.on('connection', connection => {
        // Only the device that opened this session may use its data port.
        if (plainAddress(connection.remoteAddress) !== remote) return connection.destroy();
        connection.on('error', () => {});
        resolve(protectData ? secureAtOnce(connection) : connection);
      }));
      arrived.catch(() => {});
      return { server, arrived, close: () => server.close() };
    }

    async function list(lines) {
      const data = await dataConnection();
      reply(150, 'Here is the list.');
      await new Promise(resolve => data.end(lines.map(line => `${line}\r\n`).join(''), resolve));
      reply(226, 'Done.');
    }

    async function receive(inside, append) {
      const file = localFile(inside);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const existing = (await fs.stat(file).catch(() => null))?.size ?? 0;
      // A resume from a byte this computer does not hold (the earlier part already went on and was let go) would leave
      // a file of only its tail, so it is refused and the device sends the file from the start.
      const letGo = existing === 0 && Number.isSafeInteger(await taken.size?.(inside));
      if ((append && letGo) || (!append && restAt > existing)) { restAt = 0; throw refusal(554, `This computer holds ${existing} bytes of that file; send it from the start.`); }
      const start = append ? existing : restAt;
      restAt = 0;
      const data = await dataConnection();
      hold(inside);
      reply(150, 'Ready for the file.');
      const writing = createWriteStream(file, { flags: start > 0 ? 'r+' : 'w', start });
      let ended, broke;
      const finished = new Promise((resolve, reject) => { ended = resolve; broke = reject; });
      finished.catch(() => {});
      writing.once('open', () => onArriving({ path: inside, file, finished }));
      const complete = await new Promise(resolve => {
        let ended = false;
        data.once('end', () => { ended = true; });
        data.once('close', () => { if (!ended) writing.end(); });
        writing.once('finish', () => resolve(ended));
        writing.once('error', () => { data.destroy(); resolve(false); });
        data.pipe(writing);
      });
      if (!complete) { broke(new Error(`the device stopped sending ${inside} part way; the part received is kept`)); reply(426, 'The connection closed before the file ended; the part received is kept.'); return; }
      const size = (await fs.stat(file)).size;
      ended(size);
      await onTransferred({ path: inside, file, size }).catch(error => say(`could not keep that ${inside} arrived whole: ${error.message}`));
      reply(226, 'File received.');
      say(`received ${inside} (${size} bytes) from ${remote}`);
      report(inside, size, remote);
    }

    async function answer(line) {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const argument = space < 0 ? '' : line.slice(space + 1);
      if (!signedIn && !['USER', 'PASS', 'AUTH', 'PBSZ', 'PROT', 'FEAT', 'SYST', 'QUIT', 'NOOP', 'OPTS'].includes(verb)) return reply(530, 'Sign in first.');
      switch (verb) {
        case 'AUTH':
          if (!context || !/^(TLS|SSL)$/i.test(argument)) return reply(504, 'Secure sessions are not offered here.');
          if (secured) return reply(503, 'The session is already secure.');
          reply(234, 'Securing the session.');
          socket.removeAllListeners('data');
          socket = await secureSocket(raw);
          secured = true;
          return listen();
        case 'PBSZ': return reply(200, 'PBSZ=0');
        case 'PROT':
          if (!secured) return reply(503, 'Secure the session first (AUTH TLS).');
          protectData = /^P$/i.test(argument);
          return reply(200, protectData ? 'Data connections are secured.' : 'Data connections are in the clear.');
        case 'USER': user = argument; signedIn = false; return reply(331, 'Send the password.');
        case 'PASS':
          if (requireSecure && !secured) return reply(530, 'Secure the session first (AUTH TLS).');
          if (user === null) return reply(503, 'Send USER first.');
          signedIn = Boolean(await signIn(user, argument));
          if (!signedIn) { say(`refused a sign-in as "${user}" from ${remote}`); return reply(530, 'Wrong user name or password.'); }
          say(`${remote} signed in as "${user}"`);
          return reply(230, 'Signed in.');
        case 'FEAT': return socket.write(`211-Features:\r\n${[...(context ? ['AUTH TLS', 'PBSZ', 'PROT'] : []), 'PASV', 'EPSV', 'SIZE', 'REST STREAM', 'UTF8'].map(item => ` ${item}\r\n`).join('')}211 End\r\n`);
        case 'SYST': return reply(215, 'UNIX Type: L8');
        case 'OPTS': case 'TYPE': case 'MODE': case 'STRU': case 'ALLO': case 'NOOP': return reply(200, 'OK.');
        case 'QUIT': reply(221, 'Goodbye.'); return socket.end();
        case 'PWD': case 'XPWD': return reply(257, `"${cwd}" is the current folder.`);
        case 'CWD': case 'XCWD': cwd = insidePath(cwd, argument); return reply(250, `Now in ${cwd}.`);
        case 'CDUP': case 'XCUP': cwd = insidePath(cwd, '..'); return reply(250, `Now in ${cwd}.`);
        case 'MKD': case 'XMKD': { const made = insidePath(cwd, argument); await fs.mkdir(localFile(made), { recursive: true }); return reply(257, `"${made}" is ready.`); }
        case 'RMD': case 'XRMD': return reply(250, 'OK.');
        case 'PASV': case 'EPSV': {
          closePassive();
          const address = plainAddress(raw.localAddress);
          passive = await openPassive(address);
          const dataPort = passive.server.address().port;
          if (verb === 'EPSV') return reply(229, `Entering extended passive mode (|||${dataPort}|).`);
          return reply(227, `Entering passive mode (${address.split('.').join(',')},${dataPort >> 8},${dataPort & 255}).`);
        }
        case 'PORT': case 'EPRT': return reply(502, 'Only passive mode is offered here.');
        case 'REST': restAt = Math.max(0, Number.parseInt(argument, 10) || 0); return reply(350, `Continuing from byte ${restAt}.`);
        case 'STOR': return receive(insidePath(cwd, argument), false);
        case 'APPE': return receive(insidePath(cwd, argument), true);
        case 'SIZE': {
          const inside = insidePath(cwd, argument);
          const here = await fs.stat(localFile(inside)).catch(() => null);
          const size = here?.isFile() ? here.size : await taken.size?.(inside);
          return Number.isSafeInteger(size) ? reply(213, String(size)) : reply(550, 'No such file.');
        }
        case 'LIST': case 'NLST': {
          const inside = insidePath(cwd, argument.replace(/^-\S*\s*/, '') || '.');
          const entries = await fs.readdir(localFile(inside), { withFileTypes: true }).catch(() => []);
          const names = new Map(entries.filter(entry => entry.isFile() || entry.isDirectory()).map(entry => [entry.name, entry.isDirectory()]));
          for (const name of (await taken.names?.(inside)) ?? []) if (!names.has(name)) names.set(name, false);
          return list([...names].map(([name, isFolder]) => verb === 'NLST' ? name : `${isFolder ? 'drwxr-xr-x' : '-rw-r--r--'} 1 owner group 0 Jan  1 00:00 ${name}`));
        }
        case 'DELE': {
          const inside = insidePath(cwd, argument);
          hold(inside);
          return (await fs.rm(localFile(inside)).then(() => true, () => false)) ? reply(250, 'Deleted.') : reply(550, 'No such file.');
        }
        case 'RNFR': {
          const from = insidePath(cwd, argument);
          if (!(await fs.stat(localFile(from)).catch(() => null))) return reply(550, 'No such file.');
          renameFrom = { from, waiting: hold(from) };
          return reply(350, 'Send the new name.');
        }
        case 'RNTO': {
          if (!renameFrom) return reply(503, 'Send RNFR first.');
          const { from, waiting } = renameFrom;
          const to = insidePath(cwd, argument);
          renameFrom = null;
          await fs.mkdir(path.dirname(localFile(to)), { recursive: true });
          await fs.rename(localFile(from), localFile(to));
          onRename({ from, to });
          if (waiting) report(to, (await fs.stat(localFile(to))).size, remote);
          return reply(250, 'Renamed.');
        }
        case 'ABOR': closePassive(); return reply(226, 'Nothing is being sent.');
        case 'STAT': return reply(211, 'Receiving files.');
        case 'RETR': return reply(550, 'Files sent here cannot be read back from here.');
        default: return reply(502, `${verb} is not offered here.`);
      }
    }

    listen();
    reply(220, 'Ready to receive files.');
  }

  const server = net.createServer(session);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => { for (const timer of pending.values()) clearTimeout(timer); server.close(() => resolve()); }),
    setSecure: next => { context = tls.createSecureContext({ key: next.key, cert: next.cert }); },
  };
}
