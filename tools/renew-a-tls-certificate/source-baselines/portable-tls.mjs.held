export function checkedTLS(c) {
  administrationArguments(c);
  if (typeof c.hostname !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname)) throw new Error('The TLS hostname was refused.');
  if (c.receptionistBinary && !/^\/opt\/trillion\/source\/[a-f0-9]{40}\/target\/release\/trillion-mcp-receptionist$/.test(c.receptionistBinary)) throw new Error('The retained receptionist artifact was refused.');
  return c;
}
// Downloads too big for the app (src/devices.json links {origin}/download/<name>) are kept on the host under their
// own file name and never changed; <name> is a pointer moved to one kept file, as scripts/mac-download.mjs does for the
// bucket. Configure serves the folder by GET/HEAD; publish keeps a file and moves its pointer. /download and
// /download/ send people to the last published name through a one-line include publish writes beside the files.
export const downloadDirectory = '/var/lib/public-downloads';
const downloadDefault = `${downloadDirectory}/.default-download.conf`;
const downloadName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function publishDownload(c, file, name, { run = execFileSync } = {}) {
  checkedTLS(c);
  const kept = file.split('/').pop();
  if (!downloadName.test(kept) || !downloadName.test(name) || kept === name) throw new Error('The download name was refused.');
  const body = readFileSync(file);
  const blake3 = run('b3sum', ['--no-names', file], { encoding: 'utf8' }).trim();
  const d = downloadDirectory;
  const script = `set -eu; install -d -m 0755 '${d}'; if [ ! -f '${d}/${kept}' ]; then cat > '${d}/.${kept}.part'; [ "$(stat -c %s '${d}/.${kept}.part')" = '${body.length}' ]; chmod 0644 '${d}/.${kept}.part'; mv '${d}/.${kept}.part' '${d}/${kept}'; else cat > /dev/null; fi; [ "$(stat -c %s '${d}/${kept}')" = '${body.length}' ]; ln -sfn '${kept}' '${d}/.${name}.next'; mv -T '${d}/.${name}.next' '${d}/${name}'; printf 'return 302 /download/%s;\\n' '${name}' > '${downloadDefault}.next'; mv '${downloadDefault}.next' '${downloadDefault}'; stat -L -c %s '${d}/${name}'`;
  const held = Number(run('/usr/bin/ssh', [...administrationArguments(c), script], { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000 }).trim());
  if (held !== body.length) throw new Error(`The host serves ${name} at a different size.`);
  return { name, kept, bytes: held, blake3 };
}
export function hostCommand(c, action, input, { run = execFileSync } = {}) {
  checkedTLS(c);
  if (!['setup', 'issue', 'renew', 'configure', 'activate', 'status'].includes(action)) throw new Error('The TLS action was refused.');
  try {
    const answer = JSON.parse(run('/usr/bin/ssh', [...administrationArguments(c), '/usr/bin/python3', remoteOwner, action], { input: JSON.stringify(input ?? { hostname: c.hostname }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 1024 * 1024 }));
    for (const part of ['before', 'after']) {
      const field = `not_${part}_epoch_seconds`;
      if (answer[field]) { answer[`not_${part}_local`] = new Date(answer[field] * 1000).toLocaleString('en-US', { timeZoneName: 'short' }); delete answer[field]; }
    }
    return answer;
  } catch (error) {
    // Never attach raw process buffers: the credential was on the private input pipe.
    let detail = '';
    try { detail = JSON.parse(String(error.stdout)).error ?? ''; } catch {}
    throw new Error(`The portable TLS ${action} did not complete${detail ? `: ${detail}` : ` (process ${error.status ?? error.code ?? 'unavailable'})`}.`);
  }
}
export function installHostOwner(c, { run = execFileSync, prepare = true } = {}) {
  checkedTLS(c);
  run('/usr/bin/ssh', [...administrationArguments(c), 'install -d -m 0755 /usr/local/lib/trillion && cat > /usr/local/lib/trillion/portable-tls-host.py && chmod 0755 /usr/local/lib/trillion/portable-tls-host.py'], { input: readFileSync(new URL('./portable-tls-host.py', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  return prepare ? hostCommand(c, 'setup', undefined, { run }) : { tls_owner_installed: true };
}
// The public host keeps only its own paths: /healthz, the downloads folder, the Rust receptionist's MCP paths (both forms of its protected-resource metadata)
// and the two legal pages, which it hands to the site (gettrillion.ai, the Worker trillion-site) that owns their words
// (old src/pages.mjs privacyPage :23 and termsPage :149, served at src/worker.mjs:4100 and :4163, now trillion-site worker/legal-pages.js).
// Every other path goes to the engine through the service connection, and the engine alone decides what exists.
export const siteHostname = 'gettrillion.ai';
export const sitePaths = ['/privacy', '/terms'];
export function publicProxy(c) {
  checkedTLS(c);
  const diagnostics = c.connectionDiagnostics === true ? `log_format trillion_connection '$msec $uri $status $upstream_status $request_time';\n map $uri $trillion_connection_log { default 0; /devices/resource-connections/current 1; /devices/resource-connections/admit 1; /mcp/resource-connection 1; }\n access_log /var/log/nginx/trillion-connection-status.log trillion_connection if=$trillion_connection_log;` : 'access_log off;';
  const locations = [];
  for (const path of ['/download', '/download/']) locations.push(`location = ${path} { include ${downloadDirectory}/.default-download*.conf; return 404; }`);
  locations.push(`location ^~ /download/ { limit_except GET HEAD { deny all; } types { } default_type application/octet-stream; add_header Cache-Control "public, max-age=300" always; alias ${downloadDirectory}/; location ~ ^/download/\\. { return 404; } }`);
  for (const path of ['/mcp', '/mcp/resource-connection', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) locations.push(`location = ${path} { proxy_pass https://127.0.0.1:9443; proxy_ssl_server_name on; proxy_ssl_name ${c.hostname}; proxy_ssl_verify on; proxy_ssl_verify_depth 4; proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt; }`);
  // GET and HEAD only, as the old routes were (src/worker.mjs:4100, :4163); any other method is refused here, never sent to the engine or the site.
  // Not when this host is the site itself, which would send the address to itself.
  if (c.hostname !== siteHostname) for (const path of sitePaths) locations.push(`location = ${path} { limit_except GET HEAD { deny all; } proxy_pass https://${siteHostname}; proxy_set_header Host ${siteHostname}; proxy_set_header Cookie ""; proxy_ssl_server_name on; proxy_ssl_name ${siteHostname}; proxy_ssl_verify on; proxy_ssl_verify_depth 4; proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt; }`);
  return `user www-data;\nworker_processes auto;\npid /run/trillion-public-tls.pid;\nerror_log /var/log/nginx/trillion-error.log warn;\nevents { worker_connections 1024; }\nhttp {\n ${diagnostics}\n map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n server {\n listen 443 ssl;\n server_name ${c.hostname};\n ssl_certificate /etc/letsencrypt/live/${c.hostname}/fullchain.pem;\n ssl_certificate_key /etc/letsencrypt/live/${c.hostname}/privkey.pem;\n ssl_protocols TLSv1.2 TLSv1.3;\n if ($host != ${c.hostname}) { return 421; }\n client_max_body_size 4m;\n proxy_http_version 1.1;\n proxy_set_header Host ${c.hostname};\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection $connection_upgrade;\n proxy_set_header CF-Connecting-IP $remote_addr;\n proxy_buffering off;\n proxy_read_timeout 3600s;\n proxy_send_timeout 3600s;\n location = /healthz { default_type text/plain; return 200 'tls-ready\\n'; }\n ${locations.join('\n ')}\n location / { proxy_pass http://127.0.0.1:${c.remotePort}; }\n }\n}\n`;
}
