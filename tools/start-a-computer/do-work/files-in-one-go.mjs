// tools/start-a-computer/do-work/files-in-one-go.mjs
//
// The files of a folder a unit owns whole (`owned_folders`: a site's pages) are read and written in one command each way, not one
// command per file. A front door with 1,300 pages took about 20 minutes an apply on Nov 20 2026, almost all of it two SSH
// round trips per page (a read, then an `install`), and the page writes alone ran for minutes while each was a new command.
//
// Reading: the computer answers the SHA-256 of each named file that exists (coreutils `sha256sum`, there on every computer this
// tool starts); a file whose hash is the rendered bytes' hash is the rendered text, any other is a differing text, a missing one
// is absent. The hash only compares two copies of one file in one apply; it is never kept or used as a name.
// Writing: one POSIX tar (ustar) of every file, each 0644 under folders the extract makes, unpacked at / by root with
// --no-same-owner (so root owns each file, as `install -o root` made it). An owned folder's files keep no copy beside them, so
// nothing else is done per file.
import { createHash } from 'node:crypto';

/** The bytes a rendered file is written as: its text, or the bytes its base64 names. */
export const bytesOf = ({ text, binary }) => (binary ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8'));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const DIFFERS = '\u0000differs from the computer row';

/** What the computer has at each of `files` ({ path, text, binary }): the rendered text when its bytes match, a text that differs
 *  when they do not, and nothing for a file that is absent. One command, the paths on standard input one per line. */
export async function readAll(machine, run, files) {
  if (!files.length) return {};
  const answer = await run(machine, 'while IFS= read -r p; do if [ -f "$p" ]; then sha256sum -- "$p"; fi; done', `${files.map(({ path }) => path).join('\n')}\n`);
  const hashes = new Map(answer.split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('  ');
    return [line.slice(at + 2), line.slice(0, at)];
  }));
  return Object.fromEntries(files.filter(({ path }) => hashes.has(path))
    .map(file => [file.path, hashes.get(file.path) === sha256(bytesOf(file)) ? file.text : DIFFERS]));
}

// One ustar header: a name over 100 bytes is split at a '/' into prefix (up to 155) and name (up to 100).
function header(path, size) {
  const name = path.replace(/^\/+/, '');
  let prefix = '', base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut < 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`${path} is too long a path for one archive entry.`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const block = Buffer.alloc(512);
  const put = (text, at, length) => block.write(text, at, length, 'utf8');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0');
  put(base, 0, 100);
  put(`${octal(0o644, 8)}\0`, 100, 8);
  put(`${octal(0, 8)}\0`, 108, 8);
  put(`${octal(0, 8)}\0`, 116, 8);
  put(`${octal(size, 12)}\0`, 124, 12);
  put(`${octal(Math.floor(Date.now() / 1000), 12)}\0`, 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** One ustar archive holding each of `files` at its path. */
export function tarOf(files) {
  const parts = [];
  for (const file of files) {
    const bytes = bytesOf(file);
    parts.push(header(file.path, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Write every one of `files` in one command: the archive on standard input, unpacked at / as root. */
export async function writeAll(machine, run, files) {
  if (!files.length) return;
  await run(machine, 'umask 022 && tar -x -f - -C / --no-same-owner --no-same-permissions', tarOf(files));
}
