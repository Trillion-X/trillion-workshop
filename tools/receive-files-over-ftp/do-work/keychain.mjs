// parts/receive-files-over-ftp/do-work/keychain.mjs
//
// Purpose: read and keep a value held under a name in this computer's keychain (macOS `security`), for the receiver's
// password, its certificate and the account key it sends with.
//
// Non-Negotiable Invariants:
//   1. A value never enters an argument list, a file, an environment variable or a log: it is written to `security`
//      through its standard input and read back from its standard output.
//   2. A name that holds nothing reads as null; any other failure is thrown with the tool's own words.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile, spawn } from 'node:child_process';

const SECURITY = '/usr/bin/security';
const NOTHING_HELD = 44; // `security find-generic-password` exits 44 when no item has that name

/** The value held under `service`, or null when none is. */
export const readHeld = service => new Promise((resolve, reject) => execFile(SECURITY, ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' }, (error, stdout, stderr) => {
  if (error) return error.code === NOTHING_HELD ? resolve(null) : reject(new Error(`The keychain did not answer for ${service}: ${stderr.trim() || error.message}`));
  resolve(stdout.replace(/\n$/, '') || null);
}));

/** Keep `value` under `service` (replacing what was there). The value may not contain a quote or a line break. */
export function keepHeld(service, value, account = 'trillion') {
  if (/["\n\r\\]/.test(value)) return Promise.reject(new Error('A kept value may not contain a quote, a backslash or a line break.'));
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let problem = '';
    child.stderr.on('data', chunk => { problem += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 && !problem.trim() ? resolve() : reject(new Error(`The keychain did not keep ${service}: ${problem.trim() || `exit ${code}`}`))));
    child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -w "${value}"\n`);
  });
}
