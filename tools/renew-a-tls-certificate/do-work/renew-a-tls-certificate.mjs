// Portable public TLS owner. DNS API credentials travel only through the vault and SSH stdin.
//
// Every fact about one server is the run's input: its name (hostname), address and pinned key (knownHost), the port
// its connection to the engine listens on (remotePort), the receptionist build it runs (receptionistBinary) and its
// layout (`host`: where the host owner lives, its state folder, its services and accounts, the receptionist's build
// pattern, address, paths and environment, the downloads folder and the site whose pages the host hands on). The
// engine hands the server's administration key as a file (credential_mounts mount_path) and the DNS key on descriptor
// 3; this file names no product, no vault and no schedule (renewal is a wake the person declares).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { administrationArguments, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// An absolute path with no quote, space or shell word in it, so it can sit inside the host's shell words.
const safePath = /^\/[A-Za-z0-9._/-]+$/;
const unitName = /^[a-z][a-z0-9-]{0,62}$/;
const urlPaths = list => Array.isArray(list) && list.every(path => typeof path === 'string' && /^\/[A-Za-z0-9._/-]*$/.test(path));
// The receptionist's release layout: the folder its releases and its feed file live in, the program's name, the feed it follows
// (https addresses, 64-hex public keys), the target it runs, a body bound, and optionally the build folders of the retired hand road.
const releasesOk = x => safePath.test(x?.folder ?? '') && unitName.test(x?.program ?? '') && Array.isArray(x?.feed?.urls) && x.feed.urls.length > 0
  && x.feed.urls.every(url => typeof url === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]*$/.test(url))
  && Array.isArray(x.feed.public_keys) && x.feed.public_keys.length > 0 && x.feed.public_keys.every(key => /^[0-9a-f]{64}$/.test(key))
  && /^[a-z0-9_]+(-[a-z0-9_.]+){1,4}$/.test(x.target ?? '') && Number.isInteger(x.body_max_bytes) && x.body_max_bytes > 0
  && (x.retire === undefined || (safePath.test(x.retire?.folder ?? '') && typeof x.retire?.name === 'string' && x.retire.name.length > 0 && x.retire.name.length < 100));
export function checkedHost(h, { diagnostics = false } = {}) {
  const i = h?.ingress, r = h?.receptionist;
  const ok = h && [h.owner, h.state, h.downloads, i?.pid_file, i?.error_log].every(path => safePath.test(path ?? '')) && h.owner.endsWith('.py')
    && unitName.test(i?.service ?? '') && unitName.test(r?.service ?? '') && unitName.test(r?.account ?? '')
    && typeof r?.binary_pattern === 'string' && r.binary_pattern.length > 0 && /^127\.0\.0\.1:[0-9]{1,5}$/.test(r?.listen ?? '') && urlPaths(r?.paths)
    && r?.environment !== null && typeof r?.environment === 'object' && Object.entries(r.environment).every(([name, value]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && typeof value === 'string' && !/[\n\0]/.test(value))
    && (!diagnostics || (safePath.test(i?.diagnostics_log ?? '') && urlPaths(i?.diagnostics_paths)))
    && (h.site === undefined || (hostnamePattern.test(h.site?.hostname ?? '') && urlPaths(h.site?.paths)))
    && (r.releases === undefined || releasesOk(r.releases));
  if (!ok) throw new Error('The server layout (host) was refused: owner (a .py path), state, downloads, ingress {service, pid_file, error_log}, receptionist {service, account, binary_pattern, listen 127.0.0.1:<port>, paths, environment, releases?: {folder, program, feed: {urls, public_keys}, target, body_max_bytes, retire?}} and, optionally, site {hostname, paths}; diagnostics need ingress.diagnostics_log and diagnostics_paths.');
  return h;
}
export function checkedTLS(c) {
  administrationArguments(c);
  if (typeof c.hostname !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname)) throw new Error('The TLS hostname was refused.');
  checkedHost(c.host, { diagnostics: c.connectionDiagnostics === true });
  if (c.receptionistBinary && !new RegExp(`^(?:${c.host.receptionist.binary_pattern})$`).test(c.receptionistBinary)) throw new Error('The retained receptionist artifact was refused.');
  return c;
}
// The server's administration key (the file the engine mounts) and its pinned key, written as the one known host in a
// private folder of this run, so ssh trusts that key and no other.
export function pinnedHost(request, adminKeyFile, folder) {
  if (typeof request?.knownHost !== 'string' || !new RegExp(`^${String(request.address).replaceAll('.', '\\.')} ssh-ed25519 [A-Za-z0-9+/=]+$`).test(request.knownHost.trim())) throw new Error('The server\'s pinned key (knownHost: "<address> ssh-ed25519 <key>") was refused.');
  const knownHostsFile = join(folder, 'known_hosts');
  // Written the way ssh looks the host up at its port (knownHostsLine), from the key the request pins.
  writeFileSync(knownHostsFile, knownHostsLine({ ...request, host_key: request.knownHost.trim().split(' ').slice(1).join(' ') }), { mode: 0o600 });
  return { ...request, knownHostsFile, adminKeyFile: heldKeyFile(adminKeyFile), proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null };
}
// Downloads too big for an app's own files are kept on the host under their
// own file name and never changed; <name> is a pointer moved to one kept file. Configure serves the folder by GET/HEAD;
// publish keeps a file and moves its pointer. /download and
// /download/ send people to the last published name through a one-line include publish writes beside the files.
const downloadName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function publishDownload(c, file, name, { run = execFileSync } = {}) {
  checkedTLS(c);
  const kept = file.split('/').pop();
  if (!downloadName.test(kept) || !downloadName.test(name) || kept === name) throw new Error('The download name was refused.');
  const body = readFileSync(file);
  const blake3 = run('b3sum', ['--no-names', file], { encoding: 'utf8' }).trim();
  const downloadDirectory = c.host.downloads;
  const downloadDefault = `${downloadDirectory}/.default-download.conf`;
  const d = downloadDirectory;
  const script = `set -eu; install -d -m 0755 '${d}'; if [ ! -f '${d}/${kept}' ]; then cat > '${d}/.${kept}.part'; [ "$(stat -c %s '${d}/.${kept}.part')" = '${body.length}' ]; chmod 0644 '${d}/.${kept}.part'; mv '${d}/.${kept}.part' '${d}/${kept}'; else cat > /dev/null; fi; [ "$(stat -c %s '${d}/${kept}')" = '${body.length}' ]; ln -sfn '${kept}' '${d}/.${name}.next'; mv -T '${d}/.${name}.next' '${d}/${name}'; printf 'return 302 /download/%s;\\n' '${name}' > '${downloadDefault}.next'; mv '${downloadDefault}.next' '${downloadDefault}'; stat -L -c %s '${d}/${name}'`;
  const held = Number(run('/usr/bin/ssh', [...administrationArguments(c), script], { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000 }).trim());
  if (held !== body.length) throw new Error(`The host serves ${name} at a different size.`);
  return { name, kept, bytes: held, blake3 };
}
export function hostCommand(c, action, input, { run = execFileSync } = {}) {
  checkedTLS(c);
  if (!['setup', 'issue', 'renew', 'configure', 'activate', 'status', 'seed', 'roll-back', 'retire'].includes(action)) throw new Error('The TLS action was refused.');
  const remoteOwner = c.host.owner;
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
// What the host owner reads beside itself (tls-host-owner.py layout()): the facts it acts on, and nothing else.
export const layoutFile = owner => owner.replace(/\.py$/, '.json');
export function hostLayout({ state, ingress, receptionist }) {
  return { state, ingress: { service: ingress.service }, receptionist: { service: receptionist.service, account: receptionist.account, binary_pattern: receptionist.binary_pattern, listen: receptionist.listen, environment: receptionist.environment, ...(receptionist.releases ? { releases: receptionist.releases } : {}) } };
}
export function installHostOwner(c, { run = execFileSync, prepare = true } = {}) {
  checkedTLS(c);
  const { owner } = c.host, layout = layoutFile(owner);
  // The layout first, so an owner never runs without the facts it reads.
  run('/usr/bin/ssh', [...administrationArguments(c), `install -d -m 0755 '${dirname(owner)}' && cat > '${layout}.next' && chmod 0644 '${layout}.next' && mv '${layout}.next' '${layout}'`], { input: JSON.stringify(hostLayout(c.host)), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  run('/usr/bin/ssh', [...administrationArguments(c), `cat > '${owner}.next' && chmod 0755 '${owner}.next' && mv '${owner}.next' '${owner}'`], { input: readFileSync(new URL('./tls-host-owner.py', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  return prepare ? hostCommand(c, 'setup', undefined, { run }) : { tls_owner_installed: true };
}
// The public host keeps only its own paths: /healthz, the downloads folder, the Rust receptionist's MCP paths (both forms of its protected-resource metadata)
// (host.receptionist.paths) and the site's pages (host.site.paths), which it hands to the site that owns their words, by GET and HEAD.
// Every other path goes to the engine through the service connection, and the engine alone decides what exists.
export function publicProxy(c) {
  checkedTLS(c);
  const { downloads: downloadDirectory, ingress, receptionist } = c.host;
  const { hostname: siteHostname, paths: sitePaths = [] } = c.host.site ?? {};
  const diagnostics = c.connectionDiagnostics === true ? `log_format connection_status '$msec $uri $status $upstream_status $request_time';\n map $uri $connection_status_log { default 0; ${ingress.diagnostics_paths.map(path => `${path} 1;`).join(' ')} }\n access_log ${ingress.diagnostics_log} connection_status if=$connection_status_log;` : 'access_log off;';
  const locations = [];
  for (const path of ['/download', '/download/']) locations.push(`location = ${path} { include ${downloadDirectory}/.default-download*.conf; return 404; }`);
  locations.push(`location ^~ /download/ { limit_except GET HEAD { deny all; } types { } default_type application/octet-stream; add_header Cache-Control "public, max-age=300" always; alias ${downloadDirectory}/; location ~ ^/download/\\. { return 404; } }`);
  for (const path of receptionist.paths) locations.push(`location = ${path} { proxy_pass https://${receptionist.listen}; proxy_ssl_server_name on; proxy_ssl_name ${c.hostname}; proxy_ssl_verify on; proxy_ssl_verify_depth 4; proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt; }`);
  // GET and HEAD only; any other method is refused here, never sent to the engine or the site.
  // Not when this host is the site itself, which would send the address to itself.
  if (c.hostname !== siteHostname) for (const path of sitePaths) locations.push(`location = ${path} { limit_except GET HEAD { deny all; } proxy_pass https://${siteHostname}; proxy_set_header Host ${siteHostname}; proxy_set_header Cookie ""; proxy_ssl_server_name on; proxy_ssl_name ${siteHostname}; proxy_ssl_verify on; proxy_ssl_verify_depth 4; proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt; }`);
  return `user www-data;\nworker_processes auto;\npid ${ingress.pid_file};\nerror_log ${ingress.error_log} warn;\nevents { worker_connections 1024; }\nhttp {\n ${diagnostics}\n map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n server {\n listen 443 ssl;\n server_name ${c.hostname};\n ssl_certificate /etc/letsencrypt/live/${c.hostname}/fullchain.pem;\n ssl_certificate_key /etc/letsencrypt/live/${c.hostname}/privkey.pem;\n ssl_protocols TLSv1.2 TLSv1.3;\n if ($host != ${c.hostname}) { return 421; }\n client_max_body_size 4m;\n proxy_http_version 1.1;\n proxy_set_header Host ${c.hostname};\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection $connection_upgrade;\n proxy_set_header CF-Connecting-IP $remote_addr;\n proxy_buffering off;\n proxy_read_timeout 3600s;\n proxy_send_timeout 3600s;\n location = /healthz { default_type text/plain; return 200 'tls-ready\\n'; }\n ${locations.join('\n ')}\n location / { proxy_pass http://127.0.0.1:${c.remotePort}; }\n }\n}\n`;
}
// The DNS key as the vault holds it: text, or a JSON object of fields (tokenField names the one to use).
export function heldValue(text) {
  try { const held = JSON.parse(text); if (held !== null && typeof held === 'object') return held; } catch {}
  return text.trim();
}

// One Workshop run (tool-rows.json): the action is the row's first argument, the file the engine mounts with the
// server's administration key the second, the request standard input, and the DNS key, for issue and renew,
// descriptor 3. The answer is the last line of standard output.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = mkdtempSync(join(tmpdir(), 'known-host-'));
  try {
    const [action, adminKeyFile] = process.argv.slice(2);
    const request = JSON.parse(readFileSync(0, 'utf8'));
    const configureHost = c => hostCommand(c, 'configure', { hostname: c.hostname, nginx: publicProxy(c), receptionistBinary: c.receptionistBinary });
    const c = checkedTLS(pinnedHost(request, adminKeyFile, folder));
    let result;
    if (action === 'publish') {
      // Configure after the pointer moves, so the host checks and reloads its config with the new default download.
      result = { ...publishDownload(c, request.file, request.name), configured: configureHost(c).public_tls_configured };
    }
    else if (action === 'setup' || action === 'update-owner') result = installHostOwner(c, { prepare: action === 'setup' });
    else if (action === 'host-test') {
      const tests = c.host.owner.replace(/\.py$/, '.test.py');
      execFileSync('/usr/bin/ssh', [...administrationArguments(c), `cat > '${tests}'`], { input: readFileSync(new URL('../test/tls-host-owner.test.py', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      result = { host_tests: execFileSync('/usr/bin/ssh', [...administrationArguments(c), '/usr/bin/python3', tests], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString() || 'passed' };
    }
    else if (action === 'issue' || action === 'renew') {
      const held = heldValue(readFileSync(3, 'utf8'));
      const token = typeof held === 'string' ? held : held?.[c.tokenField ?? 'token'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('The DNS API token shape was refused; name its existing field in tokenField.');
      result = hostCommand(c, action, { hostname: c.hostname, token, dryRun: action === 'renew' && c.dryRun === true });
    } else if (action === 'configure') result = configureHost(c);
    else if (action === 'roll-back') result = hostCommand(c, action, { hostname: c.hostname, commit: request.commit });
    else result = hostCommand(c, action);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  finally { rmSync(folder, { recursive: true, force: true }); }
}
