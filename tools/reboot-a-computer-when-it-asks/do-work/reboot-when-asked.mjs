// tools/reboot-a-computer-when-it-asks/do-work/reboot-when-asked.mjs  (stdin: the input; argv[2]: the held administrator key file)
//
// Reboots one computer when its own updates ask for it, and only then: the reboot an update asks for is a step the owner takes
// at a quiet hour, never the update's own (Nov 25 2026: the Elestio computers rebooted themselves each Sunday after
// unattended-upgrades; their rows now say Automatic-Reboot "false").
//
// mode "read" (the default) only reads, over SSH as the computer's administrator: whether /var/run/reboot-required is there and
// the packages /var/run/reboot-required.pkgs names, the boot id and uptime, the containers that run, and whatever makes a reboot
// unsafe now (settings.json busy: a package manager at work, a container build or a compose run that changes containers).
// Whether an apply holds the computer's row is the caller's to read (the row lock is in the row's own database).
// mode "reboot" reads the same, and reboots only when the computer asks (or `even_if_not_asked` is true, for a proof run) and
// nothing is busy; otherwise it answers rebooted: false and why. It asks systemd to reboot a few seconds after the SSH session
// ends, so the session returns, then waits (wait_seconds) until the computer answers with a new boot id, and reads it again:
// reboot-required is gone, systemd's state, and each container that ran before runs again (a container the reboot did not bring
// back is a finding). Each running program is stopped by systemd's own shutdown (SIGTERM, then its stop timeout), as any reboot
// stops it; this program stops nothing itself (a container stopped by `docker stop` would stay stopped after the reboot under
// restart: unless-stopped).
//
// The administrator key is the file named by the first argument (the run's mount of the held key), the host key is pinned from
// the input, and the connection goes through the run's own proxy (HTTPS_PROXY), as tools/administer-a-rented-host makes it.
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { administrationArguments, checkedHost, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const MARK = '@@reboot-when-asked ';

/** The one script that reads what a reboot decision needs, each part after its own mark line. */
export function readScript() {
  return [
    `echo '${MARK}asks'`, 'if [ -e /var/run/reboot-required ]; then echo yes; else echo no; fi',
    `echo '${MARK}packages'`, 'cat /var/run/reboot-required.pkgs 2>/dev/null || true',
    `echo '${MARK}boot'`, 'cat /proc/sys/kernel/random/boot_id', "cut -d' ' -f1 /proc/uptime",
    `echo '${MARK}system'`, 'systemctl is-system-running 2>/dev/null || true',
    `echo '${MARK}failed'`, "systemctl list-units --failed --plain --no-legend 2>/dev/null | cut -d' ' -f1",
    `echo '${MARK}containers'`, "command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null || true",
    ...SETTINGS.busy.map(({ id, test }) => `if ${test}; then echo '${MARK}busy ${id}'; fi`),
    `echo '${MARK}end'`,
  ].join('\n') + '\n';
}

/** What readScript printed: { asks, packages, boot_id, uptime_seconds, system, failed, containers, busy }. */
export function parseRead(stdout) {
  const parts = {}, busy = [];
  let at = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(MARK)) {
      const word = line.slice(MARK.length).trim();
      if (word.startsWith('busy ')) { busy.push(word.slice(5)); at = null; continue; }
      at = word; parts[at] = [];
      continue;
    }
    if (at && line.trim()) parts[at].push(line.trim());
  }
  const [bootId = null, uptime = null] = parts.boot ?? [];
  return {
    asks: (parts.asks ?? [])[0] === 'yes',
    packages: parts.packages ?? [],
    boot_id: bootId,
    uptime_seconds: uptime === null ? null : Math.round(Number(uptime)),
    system: (parts.system ?? [])[0] ?? null,
    failed: parts.failed ?? [],
    containers: parts.containers ?? [],
    busy: busy.map(id => SETTINGS.busy.find(item => item.id === id)?.said ?? id),
  };
}

/** One remote script run over SSH: { status, stdout, stderr }. */
function sshRunner(host, keyFile) {
  return (script, seconds = Number(SETTINGS.ssh.run_seconds)) => {
    const folder = mkdtempSync(join(tmpdir(), 'reboot-'));
    try {
      const knownHostsFile = join(folder, 'known_hosts');
      writeFileSync(knownHostsFile, knownHostsLine(host), { mode: 0o600 });
      const args = administrationArguments({ ...host, adminKeyFile: heldKeyFile(keyFile), knownHostsFile, proxy: process.env.HTTPS_PROXY || null });
      const run = spawnSync('ssh', [...args, '-o', `ConnectTimeout=${SETTINGS.ssh.connect_seconds}`, 'sh -s'], { input: script, encoding: 'utf8', timeout: seconds * 1000 });
      return { status: run.status, stdout: run.stdout ?? '', stderr: (run.stderr ?? '') + (run.error ? String(run.error.message) : '') };
    } finally { rmSync(folder, { recursive: true, force: true }); }
  };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const lastLine = run => (run.stderr || `exit ${run.status}`).trim().split('\n').at(-1);

/** Read one computer, or reboot it when it asks. `options.run` stands in for SSH and `options.wait` for the pause (tests). */
export async function rebootWhenAsked(input, options = {}) {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? pause;
  const name = input?.name ?? input?.address ?? null;
  const mode = input?.mode ?? 'read';
  const base = { name, address: input?.address ?? null, mode, at: new Date(now()).toISOString() };
  if (!['read', 'reboot'].includes(mode)) return { ...base, read: false, rebooted: false, why: 'mode is "read" or "reboot".' };
  let host;
  try {
    host = checkedHost({ address: input?.address, ssh_port: input?.ssh_port ?? SETTINGS.ssh.port, admin_user: input?.admin_user ?? SETTINGS.ssh.admin_user, host_key: input?.host_key });
    knownHostsLine(host);
  } catch (error) {
    return { ...base, read: false, rebooted: false, why: error.message };
  }
  const run = options.run ?? sshRunner(host, options.keyFile);
  const first = run(readScript());
  if (first.status !== 0 || !first.stdout.includes(`${MARK}end`)) return { ...base, read: false, rebooted: false, why: `${name} could not be read over SSH: ${lastLine(first)}.` };
  const before = parseRead(first.stdout);
  const answer = { ...base, read: true, before };
  if (mode === 'read') return { ...answer, rebooted: false };
  if (!before.asks && input.even_if_not_asked !== true) return { ...answer, rebooted: false, why: `${name} does not ask for a reboot (no /var/run/reboot-required).` };
  if (before.busy.length) return { ...answer, rebooted: false, why: `${name} is busy, so it is not rebooted now: ${before.busy.join('; ')}.` };
  // systemd reboots a few seconds after this session ends (a transient timer of its own), so the session returns its answer.
  const asked = run(`systemd-run --quiet --unit=reboot-when-asked --on-active=${Number(SETTINGS.reboot.after_seconds)} /bin/systemctl reboot\n`);
  if (asked.status !== 0) return { ...answer, rebooted: false, why: `${name} refused the reboot: ${lastLine(asked)}.` };
  const askedAt = now();
  const waitSeconds = Number(input.wait_seconds ?? SETTINGS.reboot.wait_seconds);
  let after = null, tries = 0;
  await wait(Number(SETTINGS.reboot.after_seconds) * 1000 + Number(SETTINGS.reboot.first_wait_seconds) * 1000);
  while (now() - askedAt < waitSeconds * 1000) {
    tries++;
    const again = run(readScript());
    if (again.status === 0 && again.stdout.includes(`${MARK}end`)) {
      const read = parseRead(again.stdout);
      // Back once it answers with a new boot id and systemd has finished starting (running, or degraded: a unit failed).
      if (read.boot_id && read.boot_id !== before.boot_id && ['running', 'degraded'].includes(read.system)) { after = read; break; }
    }
    await wait(Number(SETTINGS.reboot.poll_seconds) * 1000);
  }
  const backSeconds = Math.round((now() - askedAt) / 1000);
  if (!after) return { ...answer, rebooted: false, why: `${name} did not answer with a new boot and a started system within ${waitSeconds} s of the reboot (${tries} reads).`, findings: [{ kind: 'not-back-after-reboot', level: 'alert', about: name, said: `${name} was asked to reboot and did not come back within ${waitSeconds} s.` }] };
  const missing = before.containers.filter(container => !after.containers.includes(container));
  const findings = [
    ...(after.asks ? [{ kind: 'still-asks-for-a-reboot', level: 'warn', about: name, said: `${name} rebooted and still has /var/run/reboot-required.` }] : []),
    ...(after.system === 'degraded' ? [{ kind: 'degraded-after-reboot', level: 'alert', about: name, said: `${name} came back with ${after.failed.length === 1 ? 'a failed systemd unit' : 'failed systemd units'}: ${after.failed.join(', ') || 'systemctl is-system-running says degraded'}.` }] : []),
    ...missing.map(container => ({ kind: 'container-not-back', level: 'alert', about: container, said: `${container} ran on ${name} before the reboot and does not run after it.` })),
  ];
  return { ...answer, rebooted: true, back_after_seconds: backSeconds, after, findings };
}

const startedAsProgram = (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]));
if (startedAsProgram) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: await rebootWhenAsked(input, { keyFile: process.argv[2] }) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
