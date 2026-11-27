// tools/run-sql-in-my-database/do-work/through-the-run-proxy.mjs
//
// A database reached by its address from a sandboxed run. The engine starts this tool's process with may_reach, and the
// process reaches the network only through the run's own loopback proxy, which the engine names in HTTPS_PROXY. Each database
// connection is one CONNECT tunnel through that proxy to the host and port the connection string names. The engine opens it only
// to a host every value the run holds may go to (the vault entry's `hosts`), so a login never reaches another host. The
// database's own TLS runs inside the tunnel, checked against the database's name. pg is handed the tunnel as its `stream`: pg
// calls `connect(port, host)` on it as on a socket, then writes and reads through it.
import net from 'node:net';
import { Duplex } from 'node:stream';

// Opening the tunnel is asked again only while it has not opened: a proxy that answers 502, 503 or 504 (right after a reboot or an
// engine restart the proxy's own way out is not ready yet), or a proxy port that refuses or resets the connection, has carried no
// byte of the database's protocol, so no statement was sent and asking again cannot repeat one. The waits between the tries are
// DATA: five tries over about a minute. A 200 ends the asking for good; a refusal (403) and every failure after the tunnel opened
// are the connection's failure as before.
export const OPEN_WAITS_MS = [4000, 8000, 16000, 32000];
const NOT_READY_STATUSES = new Set(['502', '503', '504']);
const NOT_READY_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);

/** pg's `stream` option for the proxy at `proxy` (an http:// address): a new tunnel for each connection. */
export const throughProxy = (proxy, { waits = OPEN_WAITS_MS } = {}) => {
  const { hostname, port } = new URL(proxy);
  return () => new Tunnel(hostname, Number(port), waits);
};

class Tunnel extends Duplex {
  constructor(proxyHost, proxyPort, waits) {
    super();
    this.proxy = { host: proxyHost, port: proxyPort };
    this.waits = waits;
    this.noDelay = false;
  }

  connect(port, host, tried = 0) {
    const socket = net.connect(this.proxy.port, this.proxy.host);
    this.socket = socket;
    let opened = false;
    // The try failed before the tunnel opened: ask again after the next wait, or fail with the try's own error when none is left.
    const notReady = error => {
      if (opened || tried >= this.waits.length) return this.destroy(error);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      setTimeout(() => { if (!this.destroyed) this.connect(port, host, tried + 1); }, this.waits[tried]);
    };
    socket.setNoDelay(this.noDelay);
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = Buffer.alloc(0);
    const answer = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', answer);
      const status = head.subarray(0, end).toString('latin1').split(' ')[1];
      if (status !== '200') {
        const error = new Error(`the run's proxy did not open ${host}:${port} (answered ${status})`);
        return NOT_READY_STATUSES.has(status) ? notReady(error) : this.destroy(error);
      }
      opened = true;
      socket.on('data', data => { if (!this.push(data)) socket.pause(); });
      socket.on('end', () => this.push(null));
      const rest = head.subarray(end + 4);
      this.emit('connect');
      if (rest.length) this.push(rest);
    };
    socket.on('data', answer);
    socket.on('error', error => (NOT_READY_CODES.has(error.code) ? notReady(error) : this.destroy(error)));
    socket.on('close', () => this.destroy());
    return this;
  }

  _read() { this.socket?.resume(); }
  _write(chunk, encoding, done) { this.socket.write(chunk, encoding, done); }
  _final(done) { this.socket?.end(); done(); }
  _destroy(error, done) { this.socket?.destroy(); done(error); }
  setNoDelay(noDelay = true) { this.noDelay = noDelay; this.socket?.setNoDelay(noDelay); return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
