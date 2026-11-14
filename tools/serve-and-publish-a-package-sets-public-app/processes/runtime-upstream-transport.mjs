import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// The front door selects one verified customer's upstream before reaching this
// module. A Unix socket is a separate transport, not an HTTP URL to guess.
export async function proxyRuntimeHttp(req, res, upstream, fallbackUrl) {
  const socketPath = typeof upstream === 'object' ? upstream?.socketPath : null;
  const url = new URL(req.url || '/', socketPath ? 'http://localhost' : upstream || fallbackUrl);
  const client = url.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  if (!headers.host) headers.host = url.host;
  await new Promise((resolve) => {
    const upstreamRequest = client.request({
      ...(socketPath ? { socketPath } : {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
      }),
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
    }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      if (req.method === 'HEAD') {
        response.resume();
        res.end();
        response.on('end', resolve);
        return;
      }
      response.pipe(res);
      response.on('end', resolve);
      response.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('public entry proxy unavailable');
        resolve();
      });
    });
    upstreamRequest.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('public entry proxy unavailable');
      resolve();
    });
    req.on('error', () => { upstreamRequest.destroy(); resolve(); });
    res.on('error', () => { upstreamRequest.destroy(); resolve(); });
    req.pipe(upstreamRequest);
  });
}

export function proxyRuntimeUpgradeTo(upstreamUrl, req, socket, head, socketPath = null) {
  const shell = socketPath ? null : new URL(upstreamUrl);
  const port = shell ? Number(shell.port || (shell.protocol === 'https:' ? 443 : 80)) : null;
  const upstream = socketPath
    ? net.connect(socketPath, forwardUpgrade)
    : net.connect(port, shell.hostname, forwardUpgrade);
  function forwardUpgrade() {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  }
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
}
