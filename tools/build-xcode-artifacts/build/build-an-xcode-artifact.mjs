import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { requireHeavyWorkClaim, runHeavyProcess } from '../../process-session/do-work/heavy-work.mjs';

const explicit = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/^[ -]|[\r\n\0]/.test(value) && value.trim() === value;

const bundleFileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const machO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca]);

async function readBundleFile(path, limit, executable = false) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || await realpath(path) !== path || (executable && !(before.mode & 0o111n))) {
    throw new Error('Xcode bundle needs a physical regular file with the expected mode.');
  }
  if (!executable && before.size > BigInt(limit)) throw new Error('Xcode bundle Info.plist exceeds its read bound.');
  const file = await open(path, bundleFileFlags);
  try {
    if (!sameFile(before, await file.stat({ bigint: true }))) throw new Error('Xcode bundle file changed before readback.');
    const buffer = Buffer.alloc(limit);
    let size = 0;
    while (size < limit) {
      const { bytesRead } = await file.read(buffer, size, limit - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!sameFile(before, await file.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true })) ||
        (!executable && BigInt(size) !== before.size)) throw new Error('Xcode bundle file changed during readback.');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

/** Observe the bundle's own declared executable, without opening the app or checking a signing authority. */
export async function requireXcodeBundleExecutable(path) {
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error('Xcode did not produce the expected physical app bundle.');
  }
  const contents = join(path, 'Contents');
  const nested = await lstat(contents).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (nested && (!nested.isDirectory() || await realpath(contents) !== contents)) throw new Error('Xcode bundle Contents is not a physical directory.');
  const plist = await readBundleFile(join(nested ? contents : path, 'Info.plist'), 256 * 1024);
  const name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-expect', 'string', '-o', '-', '-'],
    { input: plist, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 }).replace(/\n$/, '');
  if (!name || name === '.' || name === '..' || /[\/\\\u0000-\u001f\u007f]/.test(name)) throw new Error('Xcode bundle executable must be a file name.');
  const executable = join(nested ? join(contents, 'MacOS') : path, name);
  const magic = await readBundleFile(executable, 4, true);
  if (magic.length !== 4 || !machO.has(magic.readUInt32BE())) throw new Error('Xcode bundle executable is not Mach-O.');
  return executable;
}

/** Run an approved, already materialized Xcode project. The caller owns and bounds a fresh work path. */
async function runXcodeArtifact({ project, scheme, configuration, destination, work, bundle, jobs, timeoutMs }, outputOf) {
  if (process.platform !== 'darwin') throw new Error('An Xcode build needs a macOS worker.');
  if (typeof project !== 'string' || !isAbsolute(project) || !project.endsWith('.xcodeproj')) throw new TypeError('project must name an absolute .xcodeproj');
  for (const [name, value] of Object.entries({ scheme, configuration, destination })) {
    if (!explicit(value)) throw new TypeError(`${name} must be an explicit Xcode build input`);
  }
  if (typeof bundle !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.app$/.test(bundle) || bundle.includes('..')) throw new TypeError('bundle must be the expected .app name');
  if (typeof work !== 'string' || !isAbsolute(work) || resolve(work) !== work || !Number.isSafeInteger(jobs) || jobs < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    throw new TypeError('work, jobs and timeoutMs must name a fresh output folder and bound the build');
  }
  if (await realpath(project) !== project || !(await lstat(project)).isDirectory()) throw new Error('The Xcode project must be a physical directory.');
  if (await realpath(dirname(work)) !== dirname(work)) throw new Error('The build output parent must be a physical directory.');
  requireHeavyWorkClaim();
  await mkdir(work, { mode: 0o700 });
  const { args, ...artifact } = outputOf(work, bundle);
  await runHeavyProcess('/usr/bin/xcodebuild', ['-project', project, '-scheme', scheme, '-configuration', configuration,
    '-destination', destination, '-derivedDataPath', join(work, 'derived'), '-jobs', String(jobs),
    '-disableAutomaticPackageResolution', '-skipPackageUpdates', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', ...args,
  ], { timeoutMs, maxBytes: 8 * 1024 * 1024, requireInherited: true });
  await requireXcodeBundleExecutable(artifact.path);
  return { ...artifact, signed: false, scheme, configuration, destination };
}

export function buildAnXcodeArtifact(request) {
  return runXcodeArtifact(request, (work, bundle) => {
    const products = join(work, 'products');
    return { args: [`CONFIGURATION_BUILD_DIR=${products}`, 'build'], state: 'built', path: join(products, bundle) };
  });
}

/** Build a private archive without distribution signing or export. The project declares any embedded products. */
export function archiveAnXcodeArtifact(request) {
  return runXcodeArtifact(request, (work, bundle) => {
    const archivePath = join(work, 'output.xcarchive');
    return { args: ['-archivePath', archivePath, 'archive'], state: 'archived', archivePath,
      path: join(archivePath, 'Products', 'Applications', bundle) };
  });
}

async function buildFromInput(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error('The Xcode build request exceeds its input bound.');
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('The Xcode build request must be UTF-8 JSON.'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('The Xcode build request must be an object.');
  const { operation, ...inputs } = request;
  if (operation === 'build') return buildAnXcodeArtifact(inputs);
  if (operation === 'archive') return archiveAnXcodeArtifact(inputs);
  throw new Error('The Xcode build request must name build or archive.');
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('Pass the Xcode build request on standard input, not as arguments.');
    process.stdout.write(`${JSON.stringify(await buildFromInput(process.stdin))}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' ? `${error.code}: ` : '';
    process.stderr.write(`${code}${error?.message ?? 'The Xcode build failed.'}\n`);
    process.exitCode = 1;
  }
}
