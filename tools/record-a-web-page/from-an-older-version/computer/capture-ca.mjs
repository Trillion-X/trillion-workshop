// computer/capture-ca.mjs
//
// PURPOSE
//   A certificate authority made per install, with an expiry, for the capture proxy (computer/capture-proxy.mjs), and the short-lived
//   leaf certificates it signs for each site the proxy is asked to read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Made on this computer only: the private key is created here, kept in a 0600 file inside a 0700 folder, and never leaves it.
//   2. It expires (DATA `ca_days`) and is made again before it does (`renew_days`); a leaf lives `leaf_days`. A renewed authority is not
//      trusted until the person trusts it again.
//   3. Nothing here trusts the authority: `trust()` only runs the system's own add-trusted-cert, which asks the person.
//   4. A leaf is made only for a name or address that is plain host syntax (no wildcard, no control characters).
//   5. openssl is the system's own program, called with argv (never shell text); every number and name is DATA.
//
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const captureCaSettings = () => JSON.parse(readFileSync(join(HERE, 'capture-ca.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });

export function makeCaptureCa({ settings = captureCaSettings(), home = homedir(), now = () => Date.now() } = {}) {
  const folder = join(home, settings.folder);
  const keyFile = join(folder, 'ca.key');
  const pemFile = join(folder, 'ca.pem');
  const openssl = (args, options = {}) => {
    try { return execFileSync(settings.openssl, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
    catch (error) { throw Object.assign(new Error(fill(settings.words.openssl_failed, { error: String(error.stderr ?? error.message).split('\n')[0].slice(0, 160) })), { status: 500, retry: false }); }
  };
  const expiryOf = file => new Date(openssl(['x509', '-in', file, '-noout', '-enddate']).trim().replace('notAfter=', '')).getTime();
  const tempWith = (files, work) => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-ca-'));
    try { return work(dir, Object.fromEntries(Object.entries(files).map(([name, text]) => [name, (() => { const file = join(dir, name); writeFileSync(file, text, { mode: 0o600 }); return file; })()]))); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };

  function make() {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const config = `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${settings.common_name}\n[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n`;
    tempWith({ 'ca.cnf': config }, (dir, files) => {
      openssl(['ecparam', '-name', settings.curve, '-genkey', '-noout', '-out', keyFile]);
      chmodSync(keyFile, 0o600);
      openssl(['req', '-x509', '-new', '-key', keyFile, '-sha256', '-days', String(settings.ca_days), '-config', files['ca.cnf'], '-out', pemFile]);
    });
    chmodSync(pemFile, 0o644);
  }

  const leaves = new Map();
  return {
    pemFile,
    /** Makes the authority if there is none, or again when it is about to expire. */
    ensure() {
      if (!existsSync(keyFile) || !existsSync(pemFile)) { make(); leaves.clear(); return { state: 'made', expires_at: new Date(expiryOf(pemFile)).toISOString(), said: fill(settings.words.made, { expires: new Date(expiryOf(pemFile)).toISOString() }) }; }
      const expires = expiryOf(pemFile);
      if (expires - now() < settings.renew_days * 86_400_000) { make(); leaves.clear(); return { state: 'renewed', expires_at: new Date(expiryOf(pemFile)).toISOString(), said: settings.words.renewed }; }
      return { state: 'kept', expires_at: new Date(expires).toISOString(), said: fill(settings.words.kept, { expires: new Date(expires).toISOString() }) };
    },
    pem: () => readFileSync(pemFile, 'utf8'),
    /** { key, cert } PEM for `host`, signed by the authority and kept in memory for the leaf's life. */
    leafFor(host) {
      if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^[0-9A-Fa-f:]+$/.test(host)) throw refusal(fill(settings.words.bad_host, { host: String(host).slice(0, 80) }));
      const kept = leaves.get(host);
      if (kept && kept.until > now()) return kept.pair;
      this.ensure();
      const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
      const config = `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${host}\n[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIp ? 'IP' : 'DNS'}:${host}\n`;
      const pair = tempWith({ 'leaf.cnf': config }, (dir, files) => {
        const key = join(dir, 'leaf.key'), csr = join(dir, 'leaf.csr'), cert = join(dir, 'leaf.pem');
        openssl(['ecparam', '-name', settings.curve, '-genkey', '-noout', '-out', key]);
        openssl(['req', '-new', '-key', key, '-config', files['leaf.cnf'], '-out', csr]);
        openssl(['x509', '-req', '-in', csr, '-CA', pemFile, '-CAkey', keyFile, '-CAcreateserial', '-CAserial', join(dir, 'ca.srl'), '-sha256', '-days', String(settings.leaf_days), '-extfile', files['leaf.cnf'], '-extensions', 'v3', '-out', cert]);
        return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
      });
      leaves.set(host, { pair, until: now() + (settings.leaf_days - 1) * 86_400_000 });
      return pair;
    },
    /** The system's own command that asks the person to trust the authority. */
    trust() {
      const keychain = join(home, settings.trust.keychain);
      execFileSync(settings.trust.program, settings.trust.argv.map(arg => fill(arg, { keychain, pem: pemFile })), { stdio: 'inherit' });
    },
  };
}
