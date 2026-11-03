// Build the existing receptionist on its actual Linux host from one immutable committed source tree.
// Git archive transfers declared source only; no home, Git configuration, credentials, local state or account DB travels.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { administrationArguments } from './portable-service-connection.mjs';

export function prepareReceptionistArtifact(config, readback, { run = execFileSync } = {}) {
  if (readback.state !== 'built' || !/^[a-f0-9]{40}$/.test(readback.commit) || readback.executable !== `/opt/trillion/source/${readback.commit}/target/release/trillion-mcp-receptionist`) throw new Error('The qualified Linux artifact was refused.');
  return run('/usr/bin/ssh', [...administrationArguments(config), `set -eu; test -f '${readback.executable}'; chmod 0755 '${readback.executable}'; ls -l '${readback.executable}'`], { encoding: 'utf8', timeout: 10000, maxBuffer: 64000 });
}

export function inspectReceptionistHost(config, { run = execFileSync } = {}) {
  return run('/usr/bin/ssh', [...administrationArguments(config), "uname -a; /root/.cargo/bin/rustc --version; free -h; ps -eo pid,ppid,etime,comm | grep -E '(cargo|rustc|rustup|cc1|ld)' || true; find /opt/trillion/source -maxdepth 2 -name Cargo.toml -printf '%h\\n' 2>/dev/null; find /opt/trillion/source -type f -name trillion-mcp-receptionist -exec readelf -h '{}' \\; 2>/dev/null | head -20; ss -ltnp | grep -E '(:18789|:9443|:443)' || true; passwd -S trillion-identity; journalctl -u ssh --since '-5 minutes' --no-pager | grep trillion-identity | tail -6"], { encoding: 'utf8', timeout: 15000, maxBuffer: 64000 });
}
export function buildReceptionist(config, { repository, revision = 'HEAD', receiptFile, run = execFileSync } = {}) {
  if (!repository) throw new Error('The source repository was refused.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(revision)) throw new Error('The source revision was refused.');
  const commit = run('/usr/bin/git', ['-C', repository, 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8', timeout: 10000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The source commit was refused.');
  const archive = run('/usr/bin/git', ['-C', repository, 'archive', '--format=tar', commit], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
  const directory = `/opt/trillion/source/${commit}`;
  const cache = config.buildCacheDirectory ?? `${directory}/target`;
  if (!/^\/opt\/trillion\/source\/[a-f0-9]{40}\/target$/.test(cache)) throw new Error('The owned Linux build cache was refused.');
  if (receiptFile) writeFileSync(receiptFile, `${JSON.stringify({ state: 'building', commit, directory })}\n`, { mode: 0o600 });
  const keep = cache === `${directory}/target` ? '' : `install -d target/release; cp '${cache}/release/trillion-mcp-receptionist' target/release/trillion-mcp-receptionist;`;
  const command = `set -eu; umask 077; install -d '${directory}'; tar -xf - -C '${directory}'; cd '${directory}'; /root/.cargo/bin/cargo build --locked --bin trillion-mcp-receptionist --release --target-dir '${cache}' >build.log 2>&1 || { tail -120 build.log; exit 1; }; /root/.cargo/bin/cargo test --locked --release --bin trillion-mcp-receptionist bootstrap_consumes_and_closes_the_original_credential_descriptor --target-dir '${cache}' >>build.log 2>&1 || { tail -120 build.log; exit 1; }; tail -8 build.log; ${keep} printf '\\nsource-commit: ${commit}\\n'; readelf -h target/release/trillion-mcp-receptionist | sed -n '1,18p'; ls -l target/release/trillion-mcp-receptionist`;
  try {
    const output = run('/usr/bin/ssh', [...administrationArguments(config), command], { input: archive, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    return { state: 'built', commit, directory, executable: `${directory}/target/release/trillion-mcp-receptionist`, output };
  } catch (error) {
    if (receiptFile) writeFileSync(receiptFile, `${JSON.stringify({ state: 'failed', commit, directory, exitCode: error.status ?? null, output: String(error.stdout ?? '').slice(-16000) })}\n`, { mode: 0o600 });
    throw error;
  }
